import { query } from '../db';

// Onboarding's BACKFILL-SEEDING step (plan Part 6). Core: DB upserts + pure decisions,
// ports injected — no adapter imports (D1 boundary). The composition root is
// scripts/onboard-customer.ts, which pairs these with the WA history client, the portal
// task source, and the backfill sweep.
//
// Everything here exists to make ONE property true: re-running `npm run onboard` for an
// already-onboarded customer must be a NO-OP. Three things here could violate that, and each
// is defended differently:
//
//   • backfill_cutoff — idempotency lives in the DB's conditional UPDATE (`WHERE
//     backfill_cutoff IS NULL`), exactly like claimTelegramTopic's topic claim. NOT in an
//     `if (created)` branch in the caller: `created` is false for a customer whose row exists
//     but whose cutoff is still NULL (every customer onboarded before the watermark had a
//     job), and those DO need a first stamp. The column's own NULL-ness is the only honest
//     "has this been stamped" signal, and it's race-safe for free.
//
//   • docs_root — a plain UPDATE. Idempotent by nature (same value written twice = same row),
//     so it needs no guard; it needs a DIFFERENT defense, see resolveDocsRoot.
//
//   • the WA history pull — no DB column to key on, so it uses the app_state marker pattern
//     (the established one; scripts/backfill-run.ts's markerKey does the same for threads).
//
// ⚠︎ The cutoff is a GO-LIVE WATERMARK, not a timestamp to refresh. triage.service.ts skips
// every inbox row with received_at < cutoff. Re-stamping it on a re-run would retroactively
// mute everything the customer sent since they went live — silent, unrecoverable data loss
// (those rows are never triaged again). That is why the guard is a DB predicate and not a
// caller-side convention someone can forget.

/** Repo-relative docs corpus convention: customers/<slug>/backend/config/registration/docs. */
const DOCS_ROOT_SUFFIX = 'backend/config/registration/docs';

export interface BackfillCutoffResult {
  /** true = we stamped it now (first onboard). false = it was already stamped; we left it alone. */
  stamped: boolean;
  /** The EFFECTIVE cutoff — ours if we stamped, the pre-existing one if we didn't. */
  cutoff: Date;
}

/**
 * Stamp `backfill_cutoff = now()` ONLY if it is still NULL, and move backfill_status
 * 'pending' → 'in_progress' with it (the seed has begun; the live sweep sets 'done').
 *
 * rowCount=1 → we won the stamp. rowCount=0 → already stamped, so we read the existing value
 * back and report `stamped:false`. Both arms return the effective cutoff so the caller can log
 * what is actually in force rather than what it hoped to write.
 */
export async function stampBackfillCutoff(customerId: string): Promise<BackfillCutoffResult | null> {
  const claim = await query<{ backfill_cutoff: Date }>(
    `UPDATE agent_customers
        SET backfill_cutoff = now(),
            backfill_status = 'in_progress'
      WHERE id = $1 AND backfill_cutoff IS NULL
      RETURNING backfill_cutoff`,
    [customerId],
  );
  if ((claim.rowCount ?? 0) > 0) return { stamped: true, cutoff: claim.rows[0].backfill_cutoff };

  const existing = await query<{ backfill_cutoff: Date | null }>(
    'SELECT backfill_cutoff FROM agent_customers WHERE id = $1',
    [customerId],
  );
  const cutoff = existing.rows[0]?.backfill_cutoff;
  return cutoff ? { stamped: false, cutoff } : null; // null = unknown customer
}

/** Mark the seed complete — the LIVE sweep's terminal transition ('in_progress' → 'done'). */
export async function markBackfillDone(customerId: string): Promise<void> {
  await query(`UPDATE agent_customers SET backfill_status = 'done' WHERE id = $1`, [customerId]);
}

/**
 * Customers whose backfill_cutoff is still NULL — i.e. whose live triage is UNGATED, so any
 * back-dated message of theirs landing in agent_inbox would be triaged as brand-new work.
 *
 * Reads the column's own NULL-ness for the same reason stampBackfillCutoff writes on it: it is the
 * only honest "has this customer been given a watermark" signal. Feeds ensureWaHistoryPull's
 * fail-closed gate; migration 033 is what makes that gate pass for the customers onboarded before
 * the watermark existed.
 */
export async function listCustomersWithoutBackfillCutoff(): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM agent_customers WHERE backfill_cutoff IS NULL ORDER BY id',
  );
  return rows.map((r) => r.id);
}

// ── docs_root registration ───────────────────────────────────────────────────────────────

export interface DocsRootRegistration {
  /** Checkout the root is relative to. NULL is stored as "portal" (customer corpora live there). */
  repo: string | null;
  /** Repo-relative, no leading slash (fs-doc-source joins it onto the checkout base). */
  root: string;
}

/** Persist the customer's docs corpus location (migration 032's columns). Plain UPDATE —
 *  writing the same value twice is the same row, so no conditional guard is needed. */
export async function registerCustomerDocsRoot(
  customerId: string,
  reg: DocsRootRegistration,
): Promise<void> {
  await query(`UPDATE agent_customers SET docs_repo = $2, docs_root = $3 WHERE id = $1`, [
    customerId,
    reg.repo,
    reg.root,
  ]);
}

/**
 * Kebab-case a display name for the corpus path, or null when it reduces to nothing.
 *
 * Deliberately NOT adapters/connectors/account-slug.ts's `slugify`: that one falls back to the
 * literal 'account' when a label reduces to empty, which is right for minting a credential ref
 * and WRONG here — it would resolve to `customers/account/...`, a real directory some other
 * customer could own. This returns null so the caller registers nothing. (It also can't be
 * imported: account-slug is an adapter and src/customers is a boundary zone.)
 */
export function kebabName(displayName: string): string | null {
  const s = displayName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || null;
}

/** The convention path for a customer, or null when the name yields no usable slug. */
export function defaultDocsRoot(displayName: string): string | null {
  const slug = kebabName(displayName);
  return slug ? `customers/${slug}/${DOCS_ROOT_SUFFIX}` : null;
}

export type DocsRootResolution =
  | { kind: 'register'; repo: null; root: string; origin: 'explicit' | 'convention' }
  | { kind: 'skip'; reason: string };

export interface ResolveDocsRootInput {
  /** --docs-root=<repo-relative path>, when the founder passed one. */
  argRoot?: string;
  displayName: string;
  /** Absolute checkout base for the portal repo (adapters' DEFAULT_REPO_ROOTS.portal). */
  repoBase: string;
  /** Existence seam (fs.existsSync in the composition root). */
  exists: (absPath: string) => boolean;
}

/**
 * Decide what docs_root to persist, if anything.
 *
 * The rule the plan is emphatic about: **never guess a path into the DB**. A registered root
 * that isn't there is not inert — it's a per-tick failure for that customer, and the row
 * outlives the run that wrote it. So a path is only ever persisted after being seen on disk.
 *
 * The two origins fail differently, on purpose:
 *   • explicit (--docs-root) → THROW. The founder asserted this path exists; if it doesn't,
 *     that's a typo, and quietly storing NULL would leave them believing docs are registered
 *     when nothing is. Loud beats silent for direct input. Onboarding is idempotent, so the
 *     fix is re-running with the right path.
 *   • convention (derived from the name) → skip + warn. Nothing was asserted, and most
 *     customers have no corpus at all — a missing directory is the normal case, not an error.
 *
 * `repo` is always null (= portal) because the convention only exists in the portal checkout.
 * A non-portal corpus needs --docs-root plus a repo, which nothing asks for yet; migration
 * 032's CHECK constraint rejects an invalid value at the insert either way.
 */
export function resolveDocsRoot(input: ResolveDocsRootInput): DocsRootResolution {
  const join = (root: string): string => `${input.repoBase}/${root.replace(/^\/+/, '')}`;

  if (input.argRoot !== undefined) {
    const root = input.argRoot.trim().replace(/^\/+|\/+$/g, '');
    if (!root) throw new Error('--docs-root was passed but is empty (omit it to use the convention path)');
    if (!input.exists(join(root))) {
      throw new Error(`--docs-root=${root} does not exist under ${input.repoBase} — check the path (nothing was registered)`);
    }
    return { kind: 'register', repo: null, root, origin: 'explicit' };
  }

  const root = defaultDocsRoot(input.displayName);
  if (!root) return { kind: 'skip', reason: 'display name yields no slug — cannot derive a corpus path' };
  if (!input.exists(join(root))) return { kind: 'skip', reason: `no corpus at ${root}` };
  return { kind: 'register', repo: null, root, origin: 'convention' };
}

// ── WhatsApp history pull ────────────────────────────────────────────────────────────────

/**
 * The slice of the WA history client this step needs (structural — no adapter import, the same
 * device task-inventory-customers.ts uses). Only `kind` is branched on, so the port declares
 * only `kind`; the client's richer returns are assignable to it.
 */
export interface WaHistoryPullPort {
  triggerBackfill(opts?: { since?: Date }): Promise<{ kind: 'accepted' | 'already-running' | 'not-ready' }>;
  waitForBackfill(): Promise<{ kind: 'finished' | 'timeout' | 'failed' }>;
  getHistoryHorizon(): Promise<{ total: number; oldest: Date | null; newest: Date | null }>;
}

export interface WaHistoryPullLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface WaHistoryPullDeps {
  customerId: string;
  client: WaHistoryPullPort;
  /** app_state marker seam: has THIS customer's pull already completed? */
  isPulled: (customerId: string) => Promise<boolean>;
  markPulled: (customerId: string) => Promise<void>;
  /** Ids of customers with NO backfill_cutoff (listCustomersWithoutBackfillCutoff). Feeds the
   *  fail-closed gate below — the pull is GLOBAL, the cutoff is PER-CUSTOMER. */
  unstampedCustomers: () => Promise<string[]>;
  log: WaHistoryPullLogger;
}

export type WaHistoryPullResult =
  | { kind: 'already-pulled' }
  | { kind: 'pulled'; total: number; oldest: Date | null }
  | { kind: 'in-flight' }
  | { kind: 'not-ready' }
  | { kind: 'timeout' }
  | { kind: 'failed' }
  /** Refused: other customers have no cutoff, so a whole-archive pull would flood the portal. */
  | { kind: 'ungated-customers'; customerIds: string[] }
  | { kind: 'unavailable'; reason: string };

/** app_state key for the completed-pull marker. Per-CUSTOMER, not global: `POST /backfill`
 *  enumerates the whitelist when it starts, so a pull that ran before this customer's contacts
 *  were imported never saw them. Each newly onboarded customer genuinely needs its own pull. */
export const waPullMarkerKey = (customerId: string): string => `onboard:wa-backfill:${customerId}`;

/**
 * Trigger the whatsapp_manager history pull once per customer and wait for it.
 *
 * TOLERANT: every failure is caught and returned as a value. Onboarding must complete even if
 * WhatsApp is unreachable/403/503 — the same contract as the existing WA directory-import step,
 * whose warning already tells the founder to re-run once WA is configured. Re-running is the
 * recovery path for every non-'pulled' outcome here, which is exactly why the marker is written
 * ONLY on an observed completion:
 *
 *   • 'accepted' → 'finished'  → MARK. We saw it end, cleanly. A re-run skips.
 *   • 'failed'                 → no mark. The run ENDED but reported an error, so it fetched
 *     little or nothing. `running:false` alone is not completion — whatsapp_manager clears that
 *     flag in a `finally`, so a rejected run looks identical to a successful one except for
 *     status.error. Marking it would tell the founder the pull succeeded AND permanently skip the
 *     retry, leaving the customer with no history and no way back.
 *   • 'timeout'                → no mark. The pull may or may not have finished; we didn't see
 *     it. Re-triggering a whole-archive pull is idempotent on whatsapp_manager's side (rows
 *     upsert on message_id) and merely wasteful — whereas marking on an unobserved outcome
 *     could permanently skip a pull that never completed, leaving the customer with no history
 *     and no retry path. Wasted work beats missing history.
 *   • 'already-running'        → no mark. A pull started BEFORE this customer's contacts were
 *     imported cannot be assumed to cover them (see waPullMarkerKey).
 *   • 'not-ready' / throw      → no mark. Nothing ran.
 */
export async function ensureWaHistoryPull(deps: WaHistoryPullDeps): Promise<WaHistoryPullResult> {
  try {
    if (await deps.isPulled(deps.customerId)) {
      deps.log.info({ customerId: deps.customerId }, 'WhatsApp history pull already done for this customer — skipping (idempotent)');
      return { kind: 'already-pulled' };
    }

    // ── FAIL-CLOSED: the pull is GLOBAL, the cutoff is PER-CUSTOMER ────────────────────────────
    // `POST /backfill` sweeps EVERY whitelisted number and monitored group — every customer's
    // chats, not just ours. whatsapp_manager stamps updated_at=now() on each row it stores, and the
    // AO's reconcile worker polls `GET /messages?updated_since=<cursor>` with no customer filter,
    // so that months-old history arrives looking brand-new: agent_inbox 'pending' → triage →
    // createTask, with NO approval gate. backfill_cutoff is the only thing that stops it, and a
    // NULL cutoff correctly means "triage everything" (so the watermark can't silently mute a live
    // customer). Those two facts compose badly: ONE un-stamped customer anywhere turns this trigger
    // into a flood of auto-created portal tasks out of their old chats — the exact junk this whole
    // change exists to prevent, on the live loop, where the starred gate cannot reach.
    //
    // So refuse, and name them. Nothing is lost: onboarding them stamps their cutoff, migration 033
    // stamped the ones that predate the watermark, and re-running is the recovery path. This is the
    // durable half of that pair — a customer added tomorrow re-opens the hole, and only this catches it.
    const ungated = (await deps.unstampedCustomers()).filter((id) => id !== deps.customerId);
    if (ungated.length > 0) {
      deps.log.warn(
        { customerId: deps.customerId, ungatedCustomerIds: ungated },
        'WhatsApp history pull REFUSED: the pull is whole-archive, but these customers have no backfill_cutoff — their months-old history would arrive as live traffic and auto-create portal tasks. Onboard them (or stamp their cutoff) first, then re-run.',
      );
      return { kind: 'ungated-customers', customerIds: ungated };
    }

    const trigger = await deps.client.triggerBackfill();
    if (trigger.kind === 'not-ready') {
      deps.log.warn({ customerId: deps.customerId }, 'WhatsApp is not READY — history pull SKIPPED; re-run onboarding once the device is linked');
      return { kind: 'not-ready' };
    }
    if (trigger.kind === 'already-running') {
      deps.log.warn(
        { customerId: deps.customerId },
        'a WhatsApp history pull is already in flight — it may predate this customer\'s contacts; re-run onboarding once it finishes',
      );
      return { kind: 'in-flight' };
    }

    const waited = await deps.client.waitForBackfill();
    if (waited.kind === 'timeout') {
      deps.log.warn({ customerId: deps.customerId }, 'WhatsApp history pull still running at timeout — not marked done; re-run onboarding to confirm');
      return { kind: 'timeout' };
    }
    if (waited.kind === 'failed') {
      // The run ended in an error, so the archive is unchanged or half-filled. getHistoryHorizon
      // would still report a plausible total (it counts pre-existing LIVE traffic), which is exactly
      // how this outcome used to pass for success — so we must never reach it. The client already
      // logged whatsapp_manager's own error string.
      deps.log.warn(
        { customerId: deps.customerId },
        'WhatsApp history pull ENDED IN ERROR — not marked done; check the whatsapp_manager logs, then re-run onboarding',
      );
      return { kind: 'failed' };
    }

    // Horizon is WHOLE-ARCHIVE (GET /messages has no bpRef filter) — report it as how far back
    // the archive now reaches, never as this customer's message count.
    const horizon = await deps.client.getHistoryHorizon();
    await deps.markPulled(deps.customerId);
    deps.log.info(
      { customerId: deps.customerId, archiveTotal: horizon.total, archiveOldest: horizon.oldest, archiveNewest: horizon.newest },
      'WhatsApp history pull complete — archive now reaches back to archiveOldest (whole archive, all customers)',
    );
    return { kind: 'pulled', total: horizon.total, oldest: horizon.oldest };
  } catch (err) {
    const reason = (err as Error)?.message ?? 'unknown';
    deps.log.warn(
      { customerId: deps.customerId, reason },
      'WhatsApp history pull SKIPPED (reachability/auth) — onboarding continues; re-run once WA is configured',
    );
    return { kind: 'unavailable', reason };
  }
}
