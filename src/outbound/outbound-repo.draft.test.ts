import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db';
import * as repo from './outbound-repo';

// PURE unit tests for the M2(c) draft-queue mutations — NO DB, NO network. We stub the
// shared pg Pool (pool.query for the single-statement helpers; pool.connect → a fake
// client for the transactional guarded flips), capture every statement, and assert the
// SQL shape + params + the ONE-transaction ordering. This proves: (a) a draft parks as
// (status='pending', is_draft=true) so the drainer never claims it; (b) approve/edit
// flip it to a deliverable (status='approved', is_draft=false) reusing the existing
// threading columns; (c) reject → 'cancelled'; (d) every flip resolves the linked
// decision in the SAME transaction; (e) a replayed tap (0 rows) is a null no-op.

interface Captured {
  text: string;
  params: unknown[];
}

const origQuery = pool.query;
const origConnect = pool.connect;

// ── single-statement (pool.query) capture ─────────────────────────────────────
let poolCalls: Captured[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poolResult: any = { rows: [] };

// ── transactional (pool.connect → client.query) capture ───────────────────────
let clientCalls: Captured[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let updateResult: any = { rows: [] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let draftInsertResult: any = { rows: [] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let answeredResult: any = { rows: [] };

const fakeClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: async (text: string, params?: unknown[]): Promise<any> => {
    clientCalls.push({ text, params: params ?? [] });
    if (/SELECT o\.id AS outbound_id/.test(text)) return answeredResult;
    if (/INSERT INTO agent_outbound_queue/.test(text)) return draftInsertResult;
    if (/UPDATE\s+agent_outbound_queue/.test(text)) return updateResult;
    return { rows: [] };
  },
  release: () => {},
};

beforeEach(() => {
  poolCalls = [];
  poolResult = { rows: [] };
  clientCalls = [];
  updateResult = { rows: [] };
  draftInsertResult = { rows: [] };
  answeredResult = { rows: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = async (text: string, params?: unknown[]) => {
    poolCalls.push({ text, params: params ?? [] });
    return poolResult;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connect = async () => fakeClient;
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = origQuery;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).connect = origConnect;
});

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clientSql = (): string[] => clientCalls.map((c) => collapse(c.text));

// ── enqueueDraft ──────────────────────────────────────────────────────────────

test('enqueueDraft: parks (status=pending, is_draft=true) linked to the decision; recipient normalized', async () => {
  draftInsertResult = { rows: [{ id: 'q-1' }] };
  const id = await repo.enqueueDraft({
    channelInstanceId: 'inst-1',
    channelType: 'whatsapp',
    recipientAddress: '+1 (555) 000-1234',
    body: 'draft body',
    threadKey: 'thread-abc',
    inReplyTo: 'wamid.INBOUND',
    subject: null,
    customerId: 'cust-1',
    decisionId: 'dec-9',
  });

  assert.equal(id, 'q-1');
  const insert = clientCalls.find((c) => /INSERT INTO agent_outbound_queue/.test(c.text))!;
  const sql = collapse(insert.text);
  assert.match(sql, /INSERT INTO agent_outbound_queue/);
  // draft parks pending + is_draft=true (un-drainable) with the decision link.
  assert.match(sql, /\$9, true, \$8/);
  assert.match(sql, /decision_id/);
  assert.match(sql, /RETURNING id/);

  const p = insert.params;
  assert.equal(p[0], 'cust-1'); // customer_id
  assert.equal(p[1], 'inst-1'); // channel_instance_id — same account as the inbound row
  // recipient is normalized per channel (R37 contact-join must hit) — proven by
  // equality to the exported normalizer, not a hand-copied expectation.
  assert.equal(p[2], repo.normalizeRecipient('whatsapp', '+1 (555) 000-1234'));
  assert.equal(p[3], 'thread-abc'); // thread_key (existing threading reused)
  assert.equal(p[4], 'wamid.INBOUND'); // in_reply_to (quoted-reply reuse)
  assert.equal(p[5], null); // subject
  assert.equal(p[6], 'draft body');
  assert.equal(p[7], 'dec-9'); // decision_id FK
  assert.equal(p[8], 'pending');
  assert.deepEqual([clientSql()[0], clientSql().at(-1)], ['BEGIN', 'COMMIT']);
});

test('enqueueDraft: nullable fields default to null', async () => {
  draftInsertResult = { rows: [{ id: 'q-2' }] };
  await repo.enqueueDraft({
    channelInstanceId: 'inst-1',
    channelType: 'email',
    recipientAddress: 'a@b.com',
    body: 'x',
    decisionId: 'dec-1',
  });
  const p = clientCalls.find((c) => /INSERT INTO agent_outbound_queue/.test(c.text))!.params;
  assert.equal(p[0], null); // customerId
  assert.equal(p[3], null); // threadKey
  assert.equal(p[4], null); // inReplyTo
  assert.equal(p[5], null); // subject
});

test('enqueueDraft: a raced direct WhatsApp answer parks cancelled and resolves the draft as modified', async () => {
  draftInsertResult = { rows: [{ id: 'q-raced' }] };
  answeredResult = {
    rows: [{ outbound_id: '900', outbound_body: 'Already answered', provider_message_id: 'wamid.OUT' }],
  };
  const id = await repo.enqueueDraft({
    channelInstanceId: 'inst-1', channelType: 'whatsapp', recipientAddress: '50760000000',
    body: 'stale suggestion', decisionId: 'dec-raced',
  });
  assert.equal(id, 'q-raced');
  const insert = clientCalls.find((c) => /INSERT INTO agent_outbound_queue/.test(c.text))!;
  assert.equal(insert.params[8], 'cancelled');
  const resolved = clientCalls.find((c) => /UPDATE\s+agent_decisions/.test(c.text))!;
  assert.equal(resolved.params[0], 'dec-raced');
  assert.equal(resolved.params[1], '900');
  assert.deepEqual(JSON.parse(resolved.params[2] as string), {
    action: 'direct_reply', by: 'founder:whatsapp', edited_body: 'Already answered',
    outbound_inbox_id: '900', provider_message_id: 'wamid.OUT',
  });
});

// ── approveDraft ────────────────────────────────────────────────────────────────

test('approveDraft: guarded flip → deliverable + resolves decision accepted, in ONE transaction', async () => {
  updateResult = { rows: [{ id: 'q-1', decision_id: 'dec-9', customer_id: 'cust-1' }] };
  const res = await repo.approveDraft('q-1', 'founder-42');

  assert.deepEqual(res, { queueId: 'q-1', decisionId: 'dec-9', customerId: 'cust-1' });

  const sqls = clientSql();
  // exact transaction envelope + resolution ordering.
  assert.deepEqual(
    [sqls[0], sqls[sqls.length - 1]],
    ['BEGIN', 'COMMIT'],
    'wrapped in BEGIN/COMMIT',
  );
  const queueUpd = clientCalls.find((c) => /UPDATE\s+agent_outbound_queue/.test(c.text))!;
  const qSql = collapse(queueUpd.text);
  // flips to a DELIVERABLE row (approved + is_draft=false) — the ONLY writer that does so.
  assert.match(qSql, /status = 'approved'/);
  assert.match(qSql, /is_draft = false/);
  assert.match(qSql, /approved_by = \$2/);
  assert.match(qSql, /approved_at = now\(\)/);
  // guarded so a replay is a no-op.
  assert.match(qSql, /WHERE id = \$1 AND is_draft = true AND status = 'pending'/);
  assert.match(qSql, /RETURNING id, decision_id, customer_id/);
  assert.deepEqual(queueUpd.params, ['q-1', 'founder-42']);

  const decUpd = clientCalls.find((c) => /UPDATE\s+agent_decisions/.test(c.text))!;
  assert.ok(decUpd, 'decision resolved in the same client/transaction');
  assert.match(collapse(decUpd.text), /WHERE id = \$1 AND outcome = 'pending'/);
  assert.equal(decUpd.params[0], 'dec-9');
  assert.equal(decUpd.params[1], 'accepted');
  assert.equal(decUpd.params[2], null, 'approve carries no human_override');
});

test('approveDraft: replayed tap (0 rows) → null no-op; no resolve, no commit', async () => {
  updateResult = { rows: [] };
  const res = await repo.approveDraft('q-1', 'founder-42');

  assert.equal(res, null);
  const sqls = clientSql();
  assert.ok(sqls.includes('BEGIN'));
  assert.ok(sqls.includes('ROLLBACK'), 'rolled back, not committed');
  assert.ok(!sqls.includes('COMMIT'), 'no commit on the no-op');
  assert.ok(!clientCalls.some((c) => /UPDATE\s+agent_decisions/.test(c.text)), 'no double-resolve');
});

// ── replaceDraftBodyAndApprove ──────────────────────────────────────────────────

test('replaceDraftBodyAndApprove: also sets body + resolves modified with edited_body override', async () => {
  updateResult = { rows: [{ id: 'q-1', decision_id: 'dec-9', customer_id: 'cust-1' }] };
  const res = await repo.replaceDraftBodyAndApprove('q-1', 'the founder edit', 'founder-42');

  assert.deepEqual(res, { queueId: 'q-1', decisionId: 'dec-9', customerId: 'cust-1' });
  const queueUpd = clientCalls.find((c) => /UPDATE\s+agent_outbound_queue/.test(c.text))!;
  assert.match(collapse(queueUpd.text), /body = \$3/);
  assert.match(collapse(queueUpd.text), /status = 'approved'/);
  assert.deepEqual(queueUpd.params, ['q-1', 'founder-42', 'the founder edit']);

  const decUpd = clientCalls.find((c) => /UPDATE\s+agent_decisions/.test(c.text))!;
  assert.equal(decUpd.params[1], 'modified');
  const override = JSON.parse(decUpd.params[2] as string);
  assert.deepEqual(override, { action: 'edit', by: 'founder-42', edited_body: 'the founder edit' });
});

// ── cancelDraft ─────────────────────────────────────────────────────────────────

test('cancelDraft: flips to cancelled (never drained) + resolves rejected override', async () => {
  updateResult = { rows: [{ id: 'q-1', decision_id: 'dec-9', customer_id: 'cust-1' }] };
  const res = await repo.cancelDraft('q-1', 'founder-42');

  assert.deepEqual(res, { queueId: 'q-1', decisionId: 'dec-9', customerId: 'cust-1' });
  const queueUpd = clientCalls.find((c) => /UPDATE\s+agent_outbound_queue/.test(c.text))!;
  const qSql = collapse(queueUpd.text);
  assert.match(qSql, /status = 'cancelled'/);
  // reject must NOT resurrect the row as deliverable.
  assert.ok(!/is_draft = false/.test(qSql), 'reject never flips is_draft=false');
  assert.deepEqual(queueUpd.params, ['q-1']);

  const decUpd = clientCalls.find((c) => /UPDATE\s+agent_decisions/.test(c.text))!;
  assert.equal(decUpd.params[1], 'rejected');
  assert.deepEqual(JSON.parse(decUpd.params[2] as string), { action: 'reject', by: 'founder-42' });
});

test('cancelDraft: replayed tap → null no-op', async () => {
  updateResult = { rows: [] };
  assert.equal(await repo.cancelDraft('q-1', 'founder-42'), null);
  assert.ok(!clientCalls.some((c) => /UPDATE\s+agent_decisions/.test(c.text)));
});

// ── read helpers ────────────────────────────────────────────────────────────────

test('getDraftForEdit: returns the open-draft resolution; null when not open', async () => {
  poolResult = { rows: [{ id: 'q-1', decision_id: 'dec-9', customer_id: 'cust-1' }] };
  assert.deepEqual(await repo.getDraftForEdit('q-1'), {
    queueId: 'q-1',
    decisionId: 'dec-9',
    customerId: 'cust-1',
  });
  assert.match(collapse(poolCalls[0].text), /WHERE id = \$1 AND is_draft = true AND status = 'pending'/);

  poolResult = { rows: [] };
  assert.equal(await repo.getDraftForEdit('q-x'), null);
});

test('findOpenDraftByInbox: joins queue→decision on decision_id, scoped to open draft_reply', async () => {
  poolResult = {
    rows: [
      {
        id: 'q-1',
        decision_id: 'dec-9',
        customer_id: 'cust-1',
        body: 'draft text',
        agent_output: { intent: 'question_existing', citations: ['a'] },
      },
    ],
  };
  const found = await repo.findOpenDraftByInbox('inbox-77');
  assert.deepEqual(found, {
    queueId: 'q-1',
    decisionId: 'dec-9',
    customerId: 'cust-1',
    body: 'draft text',
    agentOutput: { intent: 'question_existing', citations: ['a'] },
  });
  const sql = collapse(poolCalls[0].text);
  assert.match(sql, /JOIN agent_decisions d ON d\.id = q\.decision_id/);
  assert.match(sql, /d\.inbox_message_id = \$1 AND d\.decision_type = 'draft_reply'/);
  assert.match(sql, /q\.is_draft = true AND q\.status = 'pending'/);
  assert.equal(poolCalls[0].params[0], 'inbox-77');

  poolResult = { rows: [] };
  assert.equal(await repo.findOpenDraftByInbox('inbox-none'), null);
});
