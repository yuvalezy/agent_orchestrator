import { existsSync } from 'node:fs';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import { env } from '../../config/env';
import { logger } from '../../logger';
import { query } from '../../db';
import { getAppState, setAppState } from '../../db/app-state';
import { tryResolveCredential } from '../../config/credentials';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { buildWhatsAppDirectoryClient } from '../whatsapp-manager/factory';
import { buildTelegramNotifier } from '../telegram/factory';
import { DEFAULT_REPO_ROOTS } from '../knowledge/fs-doc-source';
import { runLiveSweep } from '../knowledge/backfill-run.factory';
import { resolveDocsRoot, dbContactResolutionQueries } from '../../customers';
import { onboardCustomerCore, WorkItemTypeError, type OnboardCoreInput } from './onboard-core';
import { seedBackfillDry } from './backfill-seed';

// The console-facing onboarding service (ADAPTER composition). Bundles the EZY reads the
// Onboarding screen needs (customer + project search, work-item-type resolution, contact preview),
// the core onboard write, and the backfill background jobs — behind one injectable interface so
// the console router stays thin and its test can pass a fake. Persistence lives here (this module
// already owns the agent_customers/app_state reads): a separate console repo would be an empty
// pass-through, so the router owns no SQL.

export type BackfillMode = 'dry' | 'live';

export interface CustomerSearchResult {
  ref: string;
  name: string;
  code: string;
  /** True → already in agent_customers; the UI flags + disables it, and onboard() 409s. */
  alreadyOnboarded: boolean;
}

export interface ProjectSearchResult {
  ref: string;
  code: string;
  name: string;
  status: string;
}

export interface ContactPreview {
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  telegram: string | null;
  isPrimary: boolean;
}

export interface CustomerPreview {
  ref: string;
  name: string;
  website: string | null;
  email: string | null;
  contacts: ContactPreview[];
  alreadyOnboarded: boolean;
}

export type OnboardResult =
  | { ok: true; customerId: string; created: boolean; waBlocked: boolean; workItemTypeRef: string }
  | { ok: false; error: 'already_onboarded' | 'work_item_type'; message: string };

/** A compact, serializable snapshot of a dry sweep for the UI (persisted in app_state). */
export interface DrySummary {
  at: string;
  threads: number;
  linkedOpen: number;
  linkedResolved: number;
  memories: number;
  proposed: number;
  proposalsConsidered: number;
  skipped: number;
  retryable: number;
  /** Present when the seed stopped before a full dry report (e.g. inventory sync failed). */
  skippedReason?: string;
}

export interface BackfillState {
  /** BACKFILL_ENABLED + a resolvable OPENAI_API_KEY. When false, `reason` explains why. */
  enabled: boolean;
  reason: string | null;
  /** agent_customers.backfill_status (pending|in_progress|done|failed) or null. */
  status: string | null;
  /** A dry or live job is running for this customer in THIS process right now. */
  running: boolean;
  dry: DrySummary | null;
}

export interface OnboardingService {
  searchCustomers(q: string): Promise<CustomerSearchResult[]>;
  searchProjects(q: string): Promise<ProjectSearchResult[]>;
  listWorkItemTypes(projectRef: string): Promise<Array<{ ref: string; name: string }>>;
  previewCustomer(bpRef: string): Promise<CustomerPreview>;
  onboard(input: OnboardCoreInput): Promise<OnboardResult>;
  startBackfill(customerId: string, mode: BackfillMode): Promise<{ started: boolean; reason?: string }>;
  backfillStatus(customerId: string): Promise<BackfillState>;
}

const dryKey = (customerId: string): string => `onboarding:dry:${customerId}`;

async function onboardedRefs(refs: string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const { rows } = await query<{ bp_ref: string }>(
    'SELECT bp_ref FROM agent_customers WHERE bp_ref = ANY($1)',
    [refs],
  );
  return new Set(rows.map((r) => r.bp_ref));
}

async function displayNameFor(customerId: string): Promise<string | null> {
  const { rows } = await query<{ display_name: string }>(
    'SELECT display_name FROM agent_customers WHERE id = $1',
    [customerId],
  );
  return rows[0]?.display_name ?? null;
}

function summarize(result: Awaited<ReturnType<typeof seedBackfillDry>>): DrySummary {
  const r = result.report;
  return {
    at: new Date().toISOString(),
    threads: r?.threads ?? 0,
    linkedOpen: r?.linkedOpen ?? 0,
    linkedResolved: r?.linkedResolved ?? 0,
    memories: r?.memories ?? 0,
    proposed: r?.proposed ?? 0,
    proposalsConsidered: r?.proposalsConsidered ?? 0,
    skipped: r?.skipped ?? 0,
    retryable: r?.retryable ?? 0,
    skippedReason: result.skippedReason,
  };
}

export interface OnboardingServiceDeps {
  ezy?: ReturnType<typeof buildEzyPortalGateway>;
  /**
   * The founder notifier onboarding posts through (customer topic + welcome/backfill cards) — a
   * GETTER, resolved at ACTION time (an onboarding request runs long after boot). This is what
   * lets the money-loop's fanout notifier be used even though it is built after this service, and
   * it is why onboarding no longer HARD-REQUIRES Telegram: an app-only boot passes a getter that
   * returns a headless-primary-backed fanout (customer topics become synthetic refs; cards fan out
   * to the app). Absent → the Telegram notifier (throws only if actually used with Telegram unset).
   */
  notifier?: () => Pick<FounderNotifierPort, 'ensureCustomerTopic' | 'notifyCustomerEvent'>;
}

export function buildOnboardingService(deps: OnboardingServiceDeps = {}): OnboardingService {
  const ezy = deps.ezy ?? buildEzyPortalGateway();
  const resolveNotifier = deps.notifier ?? ((): ReturnType<typeof buildTelegramNotifier> => buildTelegramNotifier());
  // In-process guard so a second dry/live for the same customer 409s instead of racing. A server
  // restart clears it; a live sweep left 'in_progress' by a crash is recoverable by re-running
  // (processed threads are skipped by their app_state markers) — same semantics as the CLI.
  const running = new Set<string>();

  function backfillGate(): { enabled: boolean; reason: string | null } {
    if (!env.BACKFILL_ENABLED) return { enabled: false, reason: 'Backfill is disabled (BACKFILL_ENABLED is not set).' };
    if (!tryResolveCredential('OPENAI_API_KEY')) return { enabled: false, reason: 'OPENAI_API_KEY is not configured — history cannot be embedded.' };
    return { enabled: true, reason: null };
  }

  async function runJob(customerId: string, mode: BackfillMode): Promise<void> {
    try {
      if (mode === 'dry') {
        const displayName = (await displayNameFor(customerId)) ?? 'customer';
        // Console has no --docs-root input: resolve by CONVENTION only (a missing path → 'skip').
        const docs = resolveDocsRoot({
          argRoot: undefined,
          displayName,
          repoBase: DEFAULT_REPO_ROOTS.portal,
          exists: existsSync,
        });
        const result = await seedBackfillDry(customerId, docs);
        await setAppState(dryKey(customerId), JSON.stringify(summarize(result)));
        logger.info({ customerId, ...summarize(result) }, 'console dry backfill complete');
      } else {
        // The live sweep drives backfill_status in_progress→done itself. It assumes the inventory
        // was already synced (the dry preview does that) — the UI runs dry first.
        const { cardsPosted } = await runLiveSweep(customerId, resolveNotifier());
        logger.info({ customerId, cardsPosted }, 'console live backfill complete');
      }
    } catch (err) {
      logger.error({ customerId, mode, err: { message: (err as Error)?.message } }, 'console backfill job failed');
    }
  }

  return {
    async searchCustomers(q) {
      const results = await ezy.searchCustomers(q);
      const seen = await onboardedRefs(results.map((r) => r.ref));
      return results.map((r) => ({ ...r, alreadyOnboarded: seen.has(r.ref) }));
    },

    async searchProjects(q) {
      return ezy.searchProjects(q);
    },

    async listWorkItemTypes(projectRef) {
      return ezy.listWorkItemTypes(projectRef);
    },

    async previewCustomer(bpRef) {
      const [customer, contacts, existing] = await Promise.all([
        ezy.getCustomer(bpRef),
        ezy.listContacts(bpRef),
        dbContactResolutionQueries.findCustomerByBpRef(bpRef),
      ]);
      return {
        ref: customer.ref,
        name: customer.name,
        website: customer.website ?? null,
        email: customer.email ?? null,
        contacts: contacts.map((c) => ({
          name: c.name,
          email: c.email ?? null,
          phone: c.phone ?? null,
          whatsapp: c.whatsapp ?? null,
          telegram: c.telegram ?? null,
          isPrimary: c.isPrimary,
        })),
        alreadyOnboarded: Boolean(existing),
      };
    },

    async onboard(input) {
      // Block re-onboard (the user's requirement): the upsert is idempotent, but the console
      // treats an existing bp_ref as a conflict rather than silently refreshing.
      const existing = await dbContactResolutionQueries.findCustomerByBpRef(input.bpRef);
      if (existing) return { ok: false, error: 'already_onboarded', message: 'This customer is already onboarded.' };
      try {
        const r = await onboardCustomerCore(input, {
          ezy,
          wa: buildWhatsAppDirectoryClient(),
          notifier: resolveNotifier(),
        });
        return { ok: true, customerId: r.customerId, created: r.created, waBlocked: r.waBlocked, workItemTypeRef: r.workItemTypeRef };
      } catch (err) {
        if (err instanceof WorkItemTypeError) return { ok: false, error: 'work_item_type', message: err.message };
        throw err;
      }
    },

    async startBackfill(customerId, mode) {
      const gate = backfillGate();
      if (!gate.enabled) return { started: false, reason: gate.reason ?? 'Backfill is unavailable.' };
      if (running.has(customerId)) return { started: false, reason: 'A backfill is already running for this customer.' };
      running.add(customerId);
      void runJob(customerId, mode).finally(() => running.delete(customerId));
      return { started: true };
    },

    async backfillStatus(customerId) {
      const gate = backfillGate();
      const [{ rows }, dryRaw] = await Promise.all([
        query<{ backfill_status: string | null }>('SELECT backfill_status FROM agent_customers WHERE id = $1', [customerId]),
        getAppState(dryKey(customerId)),
      ]);
      let dry: DrySummary | null = null;
      if (dryRaw) {
        try { dry = JSON.parse(dryRaw) as DrySummary; } catch { dry = null; }
      }
      return {
        enabled: gate.enabled,
        reason: gate.reason,
        status: rows[0]?.backfill_status ?? null,
        running: running.has(customerId),
        dry,
      };
    },
  };
}
