import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import { TriageService } from './triage.service';
import type { ClaimedInbox } from '../inbox/inbox-repo';
import type { ContactResolutionQueries } from '../customers/contact-resolution';
import type { Intent } from '../ports/llm.port';

// DB-backed pipeline test: the DB-touching core (config load, bridge, decisions,
// inbox marks) runs for real; the PORTS (taskTarget/llm/notifier) + contact
// resolution are injected fakes. Seeds a customer + inbox row, cleans up. Skips
// with no DB.

const TAG = 'ttest';
let waInstanceId: string;
let customerId: string;

async function dbReady(): Promise<boolean> {
  try {
    const { rows } = await query<{ id: string }>(`SELECT id FROM channel_instances WHERE provider='whatsapp_manager' LIMIT 1`);
    if (!rows[0]) return false;
    waInstanceId = rows[0].id;
    return true;
  } catch { return false; }
}

const CUST = `display_name = 'Triage Test Co'`;
after(async () => {
  // FK-safe order across BOTH seeded customers: decisions → tasks → inbox → customers.
  await query(`DELETE FROM agent_decisions WHERE customer_id IN (SELECT id FROM agent_customers WHERE ${CUST})`).catch(() => {});
  await query(`DELETE FROM agent_tasks WHERE customer_id IN (SELECT id FROM agent_customers WHERE ${CUST})`).catch(() => {});
  await query(`DELETE FROM agent_inbox WHERE channel_message_id LIKE '${TAG}-%'`).catch(() => {});
  await query(`DELETE FROM agent_customers WHERE ${CUST}`).catch(() => {});
  await closePool();
});

const BUG: Intent = { category: 'bug_report', summary: 'Export fails', suggested_title: 'Fix export', priority: 'high', confidence: 0.9, related_open_task_ref: null };

function fakes(intents: Intent[], contactKind: 'known' | 'unknown') {
  const created: unknown[] = [];
  const notified: Array<{ title: string; buttons: boolean }> = [];
  let skipped = 0;
  const contactQueries: ContactResolutionQueries = {
    findContactByAddress: async () => (contactKind === 'known' ? { customerId, contactId: 'c1' } : null),
    findCustomersByEmailDomain: async () => [],
  };
  // Realistic fake: createTask registers a task keyed by its sourceEntityId, and
  // findOpenTasks(sourceEntity) returns matching tasks — so the multi-intent
  // collapse (code-review #2) is actually exercisable.
  const openTasks: Array<{ ref: string; title: string; status: string; entityId?: string }> = [];
  const svc = new TriageService({
    taskTarget: {
      createTask: async (i) => {
        const ref = `task-${openTasks.length + 1}`;
        openTasks.push({ ref, title: i.title, status: 'todo', entityId: i.source.entityId });
        created.push(i);
        return { ref };
      },
      addComment: async () => {},
      findOpenTasks: async () => openTasks.map((t) => ({ ref: t.ref, title: t.title, status: t.status })),
      findTasksBySource: async (q) =>
        openTasks.filter((t) => t.entityId === q.sourceEntity.id).map((t) => ({ ref: t.ref, title: t.title, status: t.status })),
      setStatus: async () => {},
      listWorkItemTypes: async () => [],
    },
    llm: { extractIntents: async () => intents, judgeSimilarity: async () => [] },
    notifier: {
      ensureCustomerTopic: async () => ({ ref: 't' }),
      notifyCustomerEvent: async (_c, n, b) => { notified.push({ title: n.title, buttons: !!b }); },
      notifyAdmin: async () => {},
      askFounder: async () => {},
      onDecision: () => {},
    },
    contactQueries,
    deepLink: (r) => `http://portal/t/${r}`,
    bumpSkipped: async () => { skipped += 1; },
  });
  return { svc, created, notified, get skipped() { return skipped; } };
}

async function seedInbox(msgId: string, body: string | null): Promise<ClaimedInbox> {
  const { rows } = await query<{ id: string; received_at: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, channel_thread_id, sender_address, direction, body, received_at, status)
     VALUES ($1, $2, '50900000001', '50900000001', 'inbound', $3, now(), 'processing') RETURNING id, received_at`,
    [waInstanceId, msgId, body],
  );
  return {
    id: rows[0].id, channel_instance_id: waInstanceId, channel_type: 'whatsapp',
    channel_thread_id: '50900000001', sender_address: '50900000001', sender_name: null,
    subject: null, body, received_at: rows[0].received_at,
  };
}

test('create path: known sender → createTask + bridge + decision + notify(button) + processed', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-test', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;

  const f = fakes([BUG], 'known');
  const row = await seedInbox(`${TAG}-1`, 'the export button is broken');
  await f.svc.process(row);

  assert.equal(f.created.length, 1, 'createTask called once');
  assert.equal(f.notified.length, 1);
  assert.equal(f.notified[0].buttons, true, 'new-task notice has the ❌ button');
  const inbox = await query<{ status: string; customer_id: string }>(`SELECT status, customer_id FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed');
  assert.equal(inbox.rows[0].customer_id, customerId);
  const bridge = await query<{ n: string }>(`SELECT count(*)::int AS n FROM agent_tasks WHERE inbox_message_id = $1`, [row.id]);
  assert.equal(Number(bridge.rows[0].n), 1);
  const dec = await query<{ n: string }>(`SELECT count(*)::int AS n FROM agent_decisions WHERE inbox_message_id = $1 AND decision_type = 'triage'`, [row.id]);
  assert.equal(Number(dec.rows[0].n), 1);

  // R49 short-circuit: re-process the same row → no second createTask, but DOES
  // re-notify (so a prior notify-failure doesn't leave the founder un-notified).
  await f.svc.process(row);
  assert.equal(f.created.length, 1, 'R49: createTask NOT called again');
  assert.equal(f.notified.length, 2, 'R49: re-notified on the short-circuit');
});

test('multi-intent message → two distinct tasks (no sibling collapse)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-multi', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const BUG2: Intent = { ...BUG, suggested_title: 'Fix login', summary: 'login broken' };
  const f = fakes([BUG, BUG2], 'known'); // one message, two distinct intents
  const row = await seedInbox(`${TAG}-multi`, 'export is broken and also login is broken');
  await f.svc.process(row);
  assert.equal(f.created.length, 2, 'two distinct intents → two tasks, not one + a comment');
});

test('unknown sender → skipped + counter bumped, no task', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const f = fakes([BUG], 'unknown');
  const row = await seedInbox(`${TAG}-2`, 'hello from a stranger');
  await f.svc.process(row);
  assert.equal(f.created.length, 0);
  assert.equal(f.skipped, 1);
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'skipped');
});
