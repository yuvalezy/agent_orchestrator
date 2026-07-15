import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import {
  stampBackfillCutoff,
  markBackfillDone,
  registerCustomerDocsRoot,
  resolveDocsRoot,
  defaultDocsRoot,
  kebabName,
  ensureWaHistoryPull,
  waPullMarkerKey,
  type WaHistoryPullPort,
  type WaHistoryPullDeps,
} from './onboarding-backfill';

// Onboarding's backfill step. The acceptance bar is IDEMPOTENCY — re-running `npm run onboard`
// must not move the cutoff or re-trigger a WhatsApp pull — so the cutoff tests are DB-backed
// (mirroring context-loader.test.ts): the guard IS a SQL predicate, and a fake `query` would
// only assert that the string I wrote is the string I wrote. The pure decisions (docs-root
// resolution) and the injected-port orchestration (WA pull) are unit-tested with seams.

const CUST = `display_name = 'OnboardBackfill Test Co'`;
after(async () => {
  await query(`DELETE FROM agent_customers WHERE ${CUST}`).catch(() => {});
  await closePool();
});

async function dbReady(): Promise<boolean> {
  try {
    await query(`SELECT 1 FROM agent_customers LIMIT 1`);
    return true;
  } catch { return false; }
}

/** migration 032 adds docs_repo/docs_root; skip those tests until it is applied. */
async function docsColumnsReady(): Promise<boolean> {
  try {
    await query(`SELECT docs_root FROM agent_customers LIMIT 1`);
    return true;
  } catch { return false; }
}

async function seed(bpRef: string, cutoff: string | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, backfill_cutoff)
     VALUES ($1, 'OnboardBackfill Test Co', 'proj-1', 'wit-1', $2::timestamptz) RETURNING id`,
    [bpRef, cutoff],
  );
  return rows[0].id;
}

const readRow = async (id: string) =>
  (
    await query<{ backfill_cutoff: Date | null; backfill_status: string | null }>(
      'SELECT backfill_cutoff, backfill_status FROM agent_customers WHERE id = $1',
      [id],
    )
  ).rows[0];

// ── backfill_cutoff: the go-live watermark ───────────────────────────────────────────────

test('stampBackfillCutoff: first onboard stamps now() and moves status pending → in_progress', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seed('bp-obf-first', null);

  const before = Date.now();
  const res = await stampBackfillCutoff(id);
  const after_ = Date.now();

  assert.ok(res, 'stamped a known customer');
  assert.equal(res.stamped, true, 'reports that IT did the stamping');
  const row = await readRow(id);
  assert.ok(row.backfill_cutoff, 'cutoff is no longer NULL');
  const t0 = row.backfill_cutoff.getTime();
  assert.ok(t0 >= before - 1000 && t0 <= after_ + 1000, 'cutoff is now(), not an epoch/default');
  assert.equal(res.cutoff.getTime(), t0, 'the returned cutoff is what landed in the row');
  assert.equal(row.backfill_status, 'in_progress', 'seeding has begun');
});

test('stampBackfillCutoff: RE-RUN does not move the cutoff (the whole point)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  // A customer stamped a year ago, mid-seed. Everything they sent since is live traffic that
  // triage has already processed; re-stamping now() would retroactively mute all of it.
  const original = '2025-07-14T10:00:00.000Z';
  const id = await seed('bp-obf-rerun', original);

  const res = await stampBackfillCutoff(id);

  assert.ok(res);
  assert.equal(res.stamped, false, 'reports that it did NOT stamp');
  assert.equal(res.cutoff.toISOString(), original, 'returns the EFFECTIVE (pre-existing) cutoff');
  const row = await readRow(id);
  assert.equal(row.backfill_cutoff?.toISOString(), original, 'the row is untouched — the watermark held');
});

test('stampBackfillCutoff: a re-run does not clobber a finished status back to in_progress', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seed('bp-obf-done', '2025-07-14T10:00:00.000Z');
  await markBackfillDone(id);

  await stampBackfillCutoff(id);

  const row = await readRow(id);
  assert.equal(row.backfill_status, 'done', 'status stays done — the UPDATE never fires on a stamped row');
});

test('stampBackfillCutoff: an existing customer whose cutoff is NULL still gets a first stamp', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  // Every customer onboarded before the watermark existed is in this state. `upserted.created`
  // is FALSE for them, so an `if (created)` guard would never stamp them — hence the SQL
  // predicate keys on the column's NULL-ness, not on insert-vs-update.
  const id = await seed('bp-obf-legacy', null);

  const res = await stampBackfillCutoff(id);

  assert.equal(res?.stamped, true, 'a pre-existing row with a NULL cutoff is a FIRST stamp');
  assert.ok((await readRow(id)).backfill_cutoff);
});

test('stampBackfillCutoff: unknown customer → null (no row invented)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  assert.equal(await stampBackfillCutoff('00000000-0000-0000-0000-000000000000'), null);
});

test('markBackfillDone: in_progress → done (the live sweep terminal)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seed('bp-obf-markdone', null);
  await stampBackfillCutoff(id);
  assert.equal((await readRow(id)).backfill_status, 'in_progress');

  await markBackfillDone(id);

  assert.equal((await readRow(id)).backfill_status, 'done', 'satisfies the CHECK constraint');
});

// ── docs_root registration ───────────────────────────────────────────────────────────────

test('registerCustomerDocsRoot: persists repo-relative root; re-registering is a no-op', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  if (!(await docsColumnsReady())) return t.skip('migration 032 not applied');
  const id = await seed('bp-obf-docs', null);

  await registerCustomerDocsRoot(id, { repo: null, root: 'customers/obf/backend/config/registration/docs' });
  await registerCustomerDocsRoot(id, { repo: null, root: 'customers/obf/backend/config/registration/docs' });

  const { rows } = await query<{ docs_repo: string | null; docs_root: string }>(
    'SELECT docs_repo, docs_root FROM agent_customers WHERE id = $1',
    [id],
  );
  assert.equal(rows.length, 1, 'still exactly one row');
  assert.equal(rows[0].docs_root, 'customers/obf/backend/config/registration/docs');
  assert.equal(rows[0].docs_repo, null, 'NULL repo = portal (what listCustomerDocSources expects)');
});

// ── docs-root resolution (pure) ──────────────────────────────────────────────────────────

const BASE = '/mnt/dev/portal';
const resolve = (over: Partial<Parameters<typeof resolveDocsRoot>[0]> = {}) =>
  resolveDocsRoot({ displayName: 'Cotton Candy CRM', repoBase: BASE, exists: () => true, ...over });

test('resolveDocsRoot: convention path is customers/<kebab>/backend/config/registration/docs', () => {
  const res = resolve();
  assert.deepEqual(res, {
    kind: 'register',
    repo: null,
    root: 'customers/cotton-candy-crm/backend/config/registration/docs',
    origin: 'convention',
  });
});

test('resolveDocsRoot: checks the CONVENTION path under the portal checkout before registering', () => {
  const probed: string[] = [];
  resolve({ exists: (p) => { probed.push(p); return true; } });
  assert.deepEqual(probed, ['/mnt/dev/portal/customers/cotton-candy-crm/backend/config/registration/docs']);
});

test('resolveDocsRoot: no directory → SKIP, never a guessed path into the DB', () => {
  const res = resolve({ exists: () => false });
  assert.equal(res.kind, 'skip', 'a path that is not on disk is NEVER registered');
});

test('resolveDocsRoot: a name that reduces to no slug → skip (not customers/account/…)', () => {
  const res = resolve({ displayName: '???', exists: () => true });
  assert.equal(res.kind, 'skip', 'must not fall back to a literal slug some other customer could own');
});

test('resolveDocsRoot: explicit --docs-root wins over the convention and is not re-derived', () => {
  const res = resolve({ argRoot: 'customers/weird_name/docs' });
  assert.deepEqual(res, { kind: 'register', repo: null, root: 'customers/weird_name/docs', origin: 'explicit' });
});

test('resolveDocsRoot: explicit --docs-root is normalized to repo-relative (leading slash stripped)', () => {
  const res = resolve({ argRoot: '/customers/x/docs/' });
  assert.equal((res as { root: string }).root, 'customers/x/docs', 'no leading slash — fs-doc-source joins it onto the base');
});

test('resolveDocsRoot: a MISSING explicit --docs-root THROWS (a typo must be loud, not silent NULL)', () => {
  assert.throws(
    () => resolve({ argRoot: 'customers/typo/docs', exists: () => false }),
    /does not exist/,
    'the founder asserted this path; storing NULL would leave them thinking docs are registered',
  );
});

test('resolveDocsRoot: an empty --docs-root throws rather than registering the repo root', () => {
  assert.throws(() => resolve({ argRoot: '   ' }), /empty/);
});

test('defaultDocsRoot / kebabName: display-name normalization', () => {
  assert.equal(kebabName('Cotton Candy CRM'), 'cotton-candy-crm');
  assert.equal(kebabName('  Holadoc, S.A.  '), 'holadoc-s-a');
  assert.equal(kebabName('???'), null, 'empty reduction is null, NOT the literal "account"');
  assert.equal(defaultDocsRoot('???'), null);
  assert.equal(defaultDocsRoot('Pilates Gal'), 'customers/pilates-gal/backend/config/registration/docs');
});

// ── the WhatsApp history pull ────────────────────────────────────────────────────────────

const quietLog = { info: () => {}, warn: () => {} };

function pullDeps(over: {
  client?: Partial<WaHistoryPullPort>;
  isPulled?: boolean;
  onMark?: () => void;
  /** Default: only OUR customer is un-stamped — i.e. every OTHER customer is gated, so the pull is safe. */
  unstamped?: string[];
} = {}): WaHistoryPullDeps {
  return {
    customerId: 'cust-1',
    client: {
      triggerBackfill: async () => ({ kind: 'accepted' as const }),
      waitForBackfill: async () => ({ kind: 'finished' as const }),
      getHistoryHorizon: async () => ({ total: 900, oldest: new Date('2025-01-01T00:00:00Z'), newest: new Date() }),
      ...over.client,
    },
    isPulled: async () => over.isPulled ?? false,
    markPulled: async () => { over.onMark?.(); },
    unstampedCustomers: async () => over.unstamped ?? [],
    log: quietLog,
  };
}

test('ensureWaHistoryPull: a completed pull marks the customer and reports the archive horizon', async () => {
  let marked = 0;
  const res = await ensureWaHistoryPull(pullDeps({ onMark: () => { marked += 1; } }));
  assert.deepEqual(res, { kind: 'pulled', total: 900, oldest: new Date('2025-01-01T00:00:00Z') });
  assert.equal(marked, 1, 'an OBSERVED completion is the only thing that writes the marker');
});

test('ensureWaHistoryPull: RE-RUN does not re-trigger a pull that already ran (idempotency bar)', async () => {
  let triggered = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({ isPulled: true, client: { triggerBackfill: async () => { triggered += 1; return { kind: 'accepted' as const }; } } }),
  );
  assert.deepEqual(res, { kind: 'already-pulled' });
  assert.equal(triggered, 0, 'the marker short-circuits BEFORE the trigger');
});

test('ensureWaHistoryPull: WA unreachable → unavailable, never a throw (onboarding must complete)', async () => {
  const res = await ensureWaHistoryPull(
    pullDeps({ client: { triggerBackfill: async () => { throw new Error('connect ECONNREFUSED'); } } }),
  );
  assert.equal(res.kind, 'unavailable');
  assert.match((res as { reason: string }).reason, /ECONNREFUSED/);
});

test('ensureWaHistoryPull: a 403 (write key unset) is tolerated and NOT marked — a re-run retries', async () => {
  let marked = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({
      onMark: () => { marked += 1; },
      client: { triggerBackfill: async () => { throw new Error('whatsapp_manager 403 Forbidden'); } },
    }),
  );
  assert.equal(res.kind, 'unavailable');
  assert.equal(marked, 0, 'marking a failed pull would permanently skip it — the customer would never get history');
});

test('ensureWaHistoryPull: not-ready (device unlinked) → skipped, unmarked, no wait', async () => {
  let waited = 0;
  let marked = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({
      onMark: () => { marked += 1; },
      client: {
        triggerBackfill: async () => ({ kind: 'not-ready' as const }),
        waitForBackfill: async () => { waited += 1; return { kind: 'finished' as const }; },
      },
    }),
  );
  assert.deepEqual(res, { kind: 'not-ready' });
  assert.equal(waited, 0, 'nothing was started, so there is nothing to wait for');
  assert.equal(marked, 0);
});

test('ensureWaHistoryPull: already-running → in-flight, unmarked (it may predate our contacts)', async () => {
  let marked = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({ onMark: () => { marked += 1; }, client: { triggerBackfill: async () => ({ kind: 'already-running' as const }) } }),
  );
  assert.deepEqual(res, { kind: 'in-flight' });
  assert.equal(marked, 0, 'a pull that started before this customer was whitelisted never saw them');
});

test('ensureWaHistoryPull: a timeout is NOT success — unmarked, so a re-run confirms', async () => {
  let marked = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({ onMark: () => { marked += 1; }, client: { waitForBackfill: async () => ({ kind: 'timeout' as const }) } }),
  );
  assert.deepEqual(res, { kind: 'timeout' });
  assert.equal(marked, 0, 'we did not observe it finish; wasted re-work beats missing history');
});

// ── the fail-closed cutoff gate (the pull is GLOBAL, the cutoff is PER-CUSTOMER) ─────────
// The pull fills the archive for EVERY customer, and whatsapp_manager stamps updated_at=now() on
// every row it stores, so the AO's reconcile worker sees months-old history as brand-new live
// traffic → agent_inbox 'pending' → triage → createTask, with no approval gate. backfill_cutoff is
// the only brake, and it is per-customer. Onboarding customer #5 must therefore not be able to
// auto-create portal tasks out of customers #1-4's old chats.

test('ensureWaHistoryPull: REFUSES the whole-archive pull while another customer has no cutoff', async () => {
  let triggered = 0;
  let marked = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({
      unstamped: ['other-a', 'other-b'],
      onMark: () => { marked += 1; },
      client: { triggerBackfill: async () => { triggered += 1; return { kind: 'accepted' as const }; } },
    }),
  );
  assert.deepEqual(res, { kind: 'ungated-customers', customerIds: ['other-a', 'other-b'] });
  assert.equal(triggered, 0, 'an un-gated customer means their history would auto-create tasks — never trigger');
  assert.equal(marked, 0, 'nothing ran, so nothing is marked; onboarding them then re-running is the fix');
});

test('ensureWaHistoryPull: OUR OWN un-stamped id never blocks us (step 1 stamps it before this runs)', async () => {
  let triggered = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({
      unstamped: ['cust-1'],
      client: { triggerBackfill: async () => { triggered += 1; return { kind: 'accepted' as const }; } },
    }),
  );
  assert.equal(res.kind, 'pulled', 'the gate is about the OTHER customers the global pull would sweep');
  assert.equal(triggered, 1);
});

test('ensureWaHistoryPull: every customer gated → the pull proceeds (migration 033 is what makes this the normal case)', async () => {
  const res = await ensureWaHistoryPull(pullDeps({ unstamped: [] }));
  assert.equal(res.kind, 'pulled');
});

test('ensureWaHistoryPull: a run that ENDED IN ERROR is not "finished" — unmarked, so a re-run retries', async () => {
  let marked = 0;
  const res = await ensureWaHistoryPull(
    pullDeps({ onMark: () => { marked += 1; }, client: { waitForBackfill: async () => ({ kind: 'failed' as const }) } }),
  );
  assert.deepEqual(res, { kind: 'failed' });
  assert.equal(
    marked,
    0,
    'marking a failed pull would report success AND permanently skip the retry — the customer would never get history',
  );
});

test('waPullMarkerKey: per-customer, so onboarding customer B still pulls B\'s contacts', () => {
  assert.notEqual(waPullMarkerKey('a'), waPullMarkerKey('b'));
  assert.equal(waPullMarkerKey('cust-1'), 'onboard:wa-backfill:cust-1');
});
