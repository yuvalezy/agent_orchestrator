import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';
import { TriageService } from './triage.service';
import type { ClaimedInbox } from '../inbox/inbox-repo';
import type { ContactResolutionQueries } from '../customers/contact-resolution';
import type { Intent } from '../ports/llm.port';
import type { GroupSummaryPort } from '../ports/group-summary.port';

// DB-backed pipeline test: the DB-touching core (config load, bridge, decisions,
// inbox marks) runs for real; the PORTS (taskTarget/llm/notifier) + contact
// resolution are injected fakes. Seeds a customer + inbox row, cleans up. Skips
// with no DB.

const TAG = 'ttest';
let waInstanceId: string;
let sdInstanceId: string;
let customerId: string;

async function dbReady(): Promise<boolean> {
  try {
    const { rows } = await query<{ id: string }>(`SELECT id FROM channel_instances WHERE provider='whatsapp_manager' LIMIT 1`);
    if (!rows[0]) return false;
    waInstanceId = rows[0].id;
    return true;
  } catch { return false; }
}

async function serviceDeskReady(): Promise<boolean> {
  try {
    const { rows } = await query<{ id: string }>(`SELECT id FROM channel_instances WHERE provider='ezy_service_desk' LIMIT 1`);
    if (!rows[0]) return false;
    sdInstanceId = rows[0].id;
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

const BUG: Intent = { category: 'bug_report', summary: 'Export fails', suggested_title: 'Fix export', priority: 'high', confidence: 0.9, explicit_action_request: true, related_open_task_ref: null };

function fakes(
  intents: Intent[],
  contactKind: 'known' | 'unknown',
  opts: {
    groupSummary?: GroupSummaryPort;
    bpCustomerId?: string;
    attachThrows?: boolean;
    /** undefined = scheduler NOT wired (the pre-feature behavior); 'ok' = it takes the message;
     *  'declines' = it cannot start, so triage must fall through to the task path. */
    meeting?: 'ok' | 'declines';
  } = {},
) {
  const initiated: unknown[] = [];
  const created: unknown[] = [];
  const notified: Array<{ title: string; buttons: boolean }> = [];
  const adminNotes: Array<{ title: string }> = [];
  const attached: Array<{ taskRef: string; filename: string; contentType: string; bytes: number }> = [];
  let skipped = 0;
  const contactQueries: ContactResolutionQueries = {
    // WA author rows never take the bp-ref path; the muted-group path DOES (opts).
    findCustomerByBpRef: async () => (opts.bpCustomerId ? { customerId: opts.bpCustomerId } : null),
    findContactByAddress: async () => (contactKind === 'known' ? { customerId, contactId: 'c1' } : null),
    findCustomersByEmailDomain: async () => [],
    findContactEmailByAddress: async () => null,
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
      listAllTasks: async () => openTasks.map((t) => ({ ref: t.ref, title: t.title, status: t.status })),
      setStatus: async () => {},
      listWorkItemTypes: async () => [],
      attachFileToTask: async (t, bytes, filename, contentType) => {
        if (opts.attachThrows) throw new Error('upload failed');
        attached.push({ taskRef: t.ref, filename, contentType, bytes: bytes.byteLength });
      },
      listChangedTasks: async () => ({ tasks: [], nextCursor: '' }),
    },
    llm: {
      extractIntents: async () => intents,
      judgeSimilarity: async () => [],
      draftReply: async () => ({ body: '', usedSourceIndexes: [] }),
    },
    notifier: {
      ensureCustomerTopic: async () => ({ ref: 't' }),
      notifyCustomerEvent: async (_c, n, b) => { notified.push({ title: n.title, buttons: !!b }); },
      notifyAdmin: async (n) => { adminNotes.push({ title: n.title }); },
      askFounder: async () => {},
      onDecision: () => {},
    },
    contactQueries,
    deepLink: (r) => `http://portal/t/${r}`,
    bumpSkipped: async () => { skipped += 1; },
    groupSummary: opts.groupSummary,
    meetingScheduler: opts.meeting
      ? {
          tryInitiate: async (i) => {
            initiated.push(i);
            return opts.meeting === 'ok';
          },
          onDuration: async () => {},
          onTypedTime: async () => true,
          onSlot: async () => {},
          onDecline: async () => {},
        }
      : undefined,
  });
  return { svc, created, notified, adminNotes, attached, initiated, get skipped() { return skipped; } };
}

/** A GroupSummaryPort fake with call counters, for the muted-group routing tests. */
function groupSummaryFake(opts: {
  bpRef?: string | null;
  summary?: { title: string; body: string; imageCount: number } | null;
  images?: Array<{ ref: string; mimeType?: string }>;
}) {
  const calls = { summarize: 0, listImages: 0, fetchMedia: 0, resolveBp: 0 };
  const gs: GroupSummaryPort = {
    resolveGroupBpRef: async () => { calls.resolveBp += 1; return opts.bpRef ?? null; },
    summarizeLastHour: async () => { calls.summarize += 1; return opts.summary ?? null; },
    listRecentImages: async () => { calls.listImages += 1; return opts.images ?? []; },
    fetchMedia: async (ref) => {
      calls.fetchMedia += 1;
      return { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'image/jpeg', filename: `wa-media-${ref}.jpg` };
    },
    mediaUrl: (ref) => `http://wa/messages/${ref}/media`,
  };
  return { gs, calls };
}

/** `receivedAt` (the message's own send time) defaults to now(); the backfill-cutoff
 *  tests pass an explicit instant to place the message either side of the watermark. */
async function seedInbox(msgId: string, body: string | null, receivedAt?: string): Promise<ClaimedInbox> {
  const { rows } = await query<{ id: string; received_at: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, channel_thread_id, sender_address, direction, body, received_at, status)
     VALUES ($1, $2, '50900000001', '50900000001', 'inbound', $3, COALESCE($4::timestamptz, now()), 'processing') RETURNING id, received_at`,
    [waInstanceId, msgId, body, receivedAt ?? null],
  );
  return {
    id: rows[0].id, channel_instance_id: waInstanceId, channel_type: 'whatsapp',
    channel_message_id: msgId,
    message_id_header: null,
    channel_thread_id: '50900000001', sender_address: '50900000001', sender_name: null,
    subject: null, body, received_at: rows[0].received_at, recipients: null, account_email: null,
    ticket_number: null, is_group: null, chat_muted: null, mentions_me: null,
  };
}

/** Seed a WhatsApp GROUP inbox row (persists the metadata flags in raw_metadata,
 *  and returns a ClaimedInbox with the flags set — as claimBatch would). */
async function seedGroupInbox(
  msgId: string,
  flags: { isGroup: boolean | null; chatMuted: boolean | null; mentionsMe: boolean | null },
  groupId = '120363000000000009',
): Promise<ClaimedInbox> {
  const raw = { metadata: { isGroup: flags.isGroup, chatMuted: flags.chatMuted, mentionsMe: flags.mentionsMe } };
  const { rows } = await query<{ id: string; received_at: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, channel_thread_id, sender_address, sender_name, direction, body, received_at, status, raw_metadata)
     VALUES ($1, $2, $3, $4, $5, 'inbound', $6, now(), 'processing', $7::jsonb) RETURNING id, received_at`,
    [waInstanceId, msgId, groupId, '50761111111', 'Author', 'hey @founder can you check this', JSON.stringify(raw)],
  );
  return {
    id: rows[0].id, channel_instance_id: waInstanceId, channel_type: 'whatsapp',
    channel_message_id: msgId,
    message_id_header: null,
    channel_thread_id: groupId, sender_address: '50761111111', sender_name: 'Author',
    subject: null, body: 'hey @founder can you check this', received_at: rows[0].received_at,
    recipients: null, account_email: null, ticket_number: null,
    is_group: flags.isGroup, chat_muted: flags.chatMuted, mentions_me: flags.mentionsMe,
  };
}

async function seedServiceDeskInbox(msgId: string, body: string, ticketId: string, ticketNumber: string): Promise<ClaimedInbox> {
  const { rows } = await query<{ id: string; received_at: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, channel_thread_id, sender_address, direction, body, received_at, status, raw_metadata)
     VALUES ($1, $2, $3, $4, 'inbound', $5, now(), 'processing', $6::jsonb) RETURNING id, received_at`,
    [sdInstanceId, msgId, ticketId, 'bp-triage-sd', body, JSON.stringify({ ticketNumber })],
  );
  return {
    id: rows[0].id, channel_instance_id: sdInstanceId, channel_type: 'service_desk',
    channel_message_id: msgId,
    message_id_header: null,
    channel_thread_id: ticketId, sender_address: 'bp-triage-sd', sender_name: null,
    subject: null, body, received_at: rows[0].received_at, recipients: null, account_email: null,
    ticket_number: ticketNumber, is_group: null, chat_muted: null, mentions_me: null,
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

test('compliment is context-only and never falls through to createTask', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-compliment', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const thanks: Intent = {
    category: 'compliment', summary: 'Customer says thanks', suggested_title: 'Thank customer',
    priority: 'low', confidence: 0.99, explicit_action_request: false, related_open_task_ref: null,
  };
  const f = fakes([thanks], 'known');
  const row = await seedInbox(`${TAG}-compliment`, 'Gracias Yuval');
  await f.svc.process(row);

  assert.equal(f.created.length, 0, 'context-only category cannot mutate the project');
  assert.equal(f.notified.length, 0, 'a normal acknowledgement does not waste founder attention');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed');
});

test('actionable category without an explicit current-message request is held for confirmation', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-not-explicit', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const mistakenFollowUp: Intent = {
    category: 'follow_up', summary: 'Customer acknowledges the congratulations', suggested_title: 'Follow up',
    priority: 'low', confidence: 0.9, explicit_action_request: false, related_open_task_ref: null,
  };
  const f = fakes([mistakenFollowUp], 'known');
  const row = await seedInbox(`${TAG}-not-explicit`, 'Gracias Yuval');
  await f.svc.process(row);

  assert.equal(f.created.length, 0, 'no task without an explicit ask in the current message');
  assert.match(f.notified[0]?.title ?? '', /Confirm before creating/);
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

test('service-desk ticket → task source stamped with the portal serviceDeskApp/Ticket convention', async (t) => {
  if (!(await serviceDeskReady())) return t.skip('no service-desk channel instance in this db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-sd', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;

  const f = fakes([BUG], 'known');
  const ticketId = 'ttest-ticket-uuid-1';
  const row = await seedServiceDeskInbox(`${TAG}-sd-1`, 'the export button is broken', ticketId, 'SD-TEST-1');
  await f.svc.process(row);

  assert.equal(f.created.length, 1, 'createTask called once');
  const source = (f.created[0] as { source: { service: string; entityType: string; entityId: string; display: string; url?: string } }).source;
  assert.deepEqual(source, {
    service: 'serviceDeskApp',
    entityType: 'Ticket',
    entityId: ticketId,
    display: 'SD-TEST-1',
    url: `/service-desk/tickets/${ticketId}`,
  });
});

// ── M2 muted-group @-mention routing matrix ──

const GROUP_SUMMARY = {
  title: 'Cotton Candy group — export issue',
  body: 'The team reports the export button is broken and shared a screenshot.',
  imageCount: 1,
};

test('muted group + @-mention → group path: summarize + task from summary + image attached', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-group-onboarded', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const { gs, calls } = groupSummaryFake({ bpRef: 'bp-group-onboarded', summary: GROUP_SUMMARY, images: [{ ref: '501' }] });
  const f = fakes([BUG], 'known', { groupSummary: gs, bpCustomerId: customerId });
  const row = await seedGroupInbox(`${TAG}-grp-1`, { isGroup: true, chatMuted: true, mentionsMe: true });
  await f.svc.process(row);

  assert.equal(calls.summarize, 1, 'summarizeLastHour called once');
  assert.equal(f.created.length, 1, 'a task is created from the summary');
  const createdTask = f.created[0] as { description: string; source: { entityId: string } };
  assert.equal(createdTask.source.entityId, row.channel_thread_id, 'task source is the group thread');
  assert.ok(createdTask.description.includes(GROUP_SUMMARY.body), 'the summary body feeds the task description');
  assert.equal(f.attached.length, 1, 'the last-hour image is attached to the task');
  assert.equal(f.attached[0].taskRef, 'task-1');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed');
});

test('muted group + @-mention, re-processed (R49) → NO re-summarize, no second task, re-notified', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-group-r49', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const { gs, calls } = groupSummaryFake({ bpRef: 'bp-group-r49', summary: GROUP_SUMMARY, images: [{ ref: '601' }] });
  const f = fakes([BUG], 'known', { groupSummary: gs, bpCustomerId: customerId });
  const row = await seedGroupInbox(`${TAG}-grp-r49`, { isGroup: true, chatMuted: true, mentionsMe: true });

  await f.svc.process(row);
  assert.equal(calls.summarize, 1, 'summarized on the first pass');
  assert.equal(f.created.length, 1, 'one task on the first pass');

  // A reclaim after a post-createTask failure must hit the HOISTED R49 short-circuit
  // (DA finding 1) — re-notify + finish, WITHOUT re-summarizing or re-creating.
  await f.svc.process(row);
  assert.equal(calls.summarize, 1, 'R49: NOT re-summarized on reclaim');
  assert.equal(f.created.length, 1, 'R49: no second task');
  assert.equal(f.notified.length, 2, 'R49: re-notified on the short-circuit');
});

// ── the live-triage watermark (agent_customers.backfill_cutoff) ──
// Backfilled history reaches the reconciler with updated_at = now() and so arrives
// here looking brand new. Without this gate a WhatsApp history pull auto-creates a
// task per historical message. Guard lives at the top of runMoneyLoop, so it covers
// the author path AND the muted-group path off one config load.

/** Seed a customer whose backfill_cutoff is `cutoff` (an ISO instant, or null). */
async function seedCustomerWithCutoff(bpRef: string, cutoff: string | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id, backfill_cutoff)
     VALUES ($1, 'Triage Test Co', 'proj-1', 'wit-1', '99', $2::timestamptz) RETURNING id`,
    [bpRef, cutoff],
  );
  return rows[0].id;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

test('cutoff: message PREDATING the cutoff → inbox skipped, NO task, no notify', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  customerId = await seedCustomerWithCutoff('bp-cutoff-pre', new Date().toISOString());

  const f = fakes([BUG], 'known');
  // A months-old WhatsApp message the backfill just surfaced — the exact flood case.
  const row = await seedInbox(`${TAG}-cut-pre`, 'the export button was broken back then', daysAgo(90));
  await f.svc.process(row);

  assert.equal(f.created.length, 0, 'pre-cutoff history must NEVER create a task');
  assert.equal(f.notified.length, 0, 'pre-cutoff history must not ping the founder');
  const inbox = await query<{ status: string; customer_id: string }>(
    `SELECT status, customer_id FROM agent_inbox WHERE id = $1`, [row.id],
  );
  assert.equal(inbox.rows[0].status, 'skipped', "stored for context, never triaged — the existing 'skipped' status");
  assert.equal(inbox.rows[0].customer_id, customerId, 'still attributed to the customer, so it stays retrievable as context');
});

test('cutoff: message AFTER the cutoff → triaged normally (live traffic still works)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  customerId = await seedCustomerWithCutoff('bp-cutoff-post', daysAgo(30));

  const f = fakes([BUG], 'known');
  const row = await seedInbox(`${TAG}-cut-post`, 'the export button is broken');
  await f.svc.process(row);

  assert.equal(f.created.length, 1, 'post-cutoff message is real work → task created');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed');
});

test('cutoff: NULL cutoff → triaged, however old (anti-regression: NULL must never mute a customer)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  // Every customer onboarded before the watermark had a job has backfill_cutoff NULL.
  // If NULL ever read as "skip everything", live triage would go silently dead for all
  // of them — so assert it against a message old enough that ANY cutoff would skip it.
  customerId = await seedCustomerWithCutoff('bp-cutoff-null', null);

  const f = fakes([BUG], 'known');
  const row = await seedInbox(`${TAG}-cut-null`, 'the export button is broken', daysAgo(365));
  await f.svc.process(row);

  assert.equal(f.created.length, 1, 'NULL cutoff = triage everything (the pre-watermark behavior)');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed');
});

test('cutoff: received_at EXACTLY == cutoff → triaged (boundary is exclusive)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  // Onboarding stamps the cutoff at now(), so a message on the same instant is live
  // traffic. Ties resolve toward triage: a missed task beats a muted customer.
  const INSTANT = '2026-01-01T00:00:00.000Z';
  customerId = await seedCustomerWithCutoff('bp-cutoff-eq', INSTANT);

  const f = fakes([BUG], 'known');
  const row = await seedInbox(`${TAG}-cut-eq`, 'the export button is broken', INSTANT);
  await f.svc.process(row);

  assert.equal(f.created.length, 1, 'a message exactly AT the cutoff is triaged, not skipped');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed');
});

test('muted group + @-mention, summary unavailable → skipped + admin note, no task', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { gs, calls } = groupSummaryFake({ bpRef: 'bp-group-nosum', summary: null }); // summarizeLastHour → null
  const f = fakes([BUG], 'known', { groupSummary: gs });
  const row = await seedGroupInbox(`${TAG}-grp-nosum`, { isGroup: true, chatMuted: true, mentionsMe: true });
  await f.svc.process(row);

  assert.equal(calls.summarize, 1, 'summarize attempted');
  assert.equal(f.created.length, 0, 'no task when there is no summary');
  assert.ok(f.adminNotes.some((n) => n.title.includes('unavailable')), 'admin noted the unavailable summary');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'skipped');
});

test('muted group + no mention → skipped, no summarize', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { gs, calls } = groupSummaryFake({ bpRef: 'bp-x', summary: GROUP_SUMMARY });
  const f = fakes([BUG], 'known', { groupSummary: gs });
  const row = await seedGroupInbox(`${TAG}-grp-2`, { isGroup: true, chatMuted: true, mentionsMe: false });
  await f.svc.process(row);
  assert.equal(calls.summarize, 0, 'no summarize for a muted non-mention');
  assert.equal(f.created.length, 0);
  const inbox = await query<{ status: string; last_error: string }>(`SELECT status, last_error FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'skipped');
  assert.match(inbox.rows[0].last_error, /muted group/);
});

test('unmuted group → author path (no summarize)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-group-unmuted', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const { gs, calls } = groupSummaryFake({ bpRef: 'bp-group-unmuted', summary: GROUP_SUMMARY });
  const f = fakes([BUG], 'known', { groupSummary: gs });
  const row = await seedGroupInbox(`${TAG}-grp-3`, { isGroup: true, chatMuted: false, mentionsMe: true });
  await f.svc.process(row);
  assert.equal(calls.summarize, 0, 'an unmuted group never takes the summarize path');
  assert.equal(f.created.length, 1, 'the author path creates the task as usual');
});

test('group flags absent (backfill) → author path (no summarize)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-group-backfill', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const { gs, calls } = groupSummaryFake({ bpRef: 'bp-group-backfill', summary: GROUP_SUMMARY });
  const f = fakes([BUG], 'known', { groupSummary: gs });
  const row = await seedGroupInbox(`${TAG}-grp-4`, { isGroup: null, chatMuted: null, mentionsMe: null });
  await f.svc.process(row);
  assert.equal(calls.summarize, 0, 'null flags fall through to the author path');
  assert.equal(f.created.length, 1);
});

test('muted group + mention, BP not onboarded → founder note + admin onboard note + skip (no task)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { gs, calls } = groupSummaryFake({ bpRef: 'bp-not-linked', summary: GROUP_SUMMARY, images: [{ ref: '777' }] });
  const f = fakes([BUG], 'known', { groupSummary: gs }); // bpCustomerId absent → findCustomerByBpRef → null
  const row = await seedGroupInbox(`${TAG}-grp-5`, { isGroup: true, chatMuted: true, mentionsMe: true });
  await f.svc.process(row);
  assert.equal(calls.summarize, 1, 'still summarizes (surfaced to the founder)');
  assert.equal(f.created.length, 0, 'no task without an onboarded BP');
  assert.ok(f.adminNotes.length >= 2, 'an onboard note + a summary/media note');
  const inbox = await query<{ status: string; last_error: string }>(`SELECT status, last_error FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'skipped');
  assert.match(inbox.rows[0].last_error, /not onboarded/);
});

test('attach is best-effort: upload throws → the row is still processed', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-group-attachfail', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const { gs } = groupSummaryFake({ bpRef: 'bp-group-attachfail', summary: GROUP_SUMMARY, images: [{ ref: '888' }] });
  const f = fakes([BUG], 'known', { groupSummary: gs, bpCustomerId: customerId, attachThrows: true });
  const row = await seedGroupInbox(`${TAG}-grp-6`, { isGroup: true, chatMuted: true, mentionsMe: true });
  await f.svc.process(row);
  assert.equal(f.created.length, 1, 'the task is created');
  assert.equal(f.attached.length, 0, 'no successful attach');
  assert.ok(f.adminNotes.some((n) => /attach failed/i.test(n.title)), 'an admin note flags the failed attach');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed', 'row processed despite the attach failure');
});

// ── meeting_request: the TSK-00249 regression ────────────────────────────────────
// "avisame cuando puedes hablar" (let me know when you can talk) was triaged follow_up and
// became a task whose whole content was "a customer wants to talk to you". These pin the three
// outcomes that matter: it schedules, it NEVER silently drops, and it is byte-for-byte the old
// behavior when the feature is off.

const WANTS_TO_TALK: Intent = {
  category: 'meeting_request', summary: 'Customer asks to be notified when the founder is available to talk',
  suggested_title: 'Notify customer when available for call', priority: 'medium',
  confidence: 0.7, explicit_action_request: true, related_open_task_ref: null,
};

test('meeting_request goes to the scheduler and creates NO task (the TSK-00249 fix)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-meeting', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const f = fakes([WANTS_TO_TALK], 'known', { meeting: 'ok' });
  const row = await seedInbox(`${TAG}-meeting`, 'avisame cuando puedes hablar');
  await f.svc.process(row);

  assert.equal(f.initiated.length, 1, 'the ask must reach the scheduler');
  assert.equal(f.created.length, 0, 'a request to TALK must not become a project task');
  const inbox = await query<{ status: string }>(`SELECT status FROM agent_inbox WHERE id = $1`, [row.id]);
  assert.equal(inbox.rows[0].status, 'processed');
});

test('meeting_request passes the founder tz-independent customer zone + language through', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id, timezone, preferred_language)
     VALUES ('bp-triage-meeting-tz', 'Triage Test Co', 'proj-1', 'wit-1', '99', 'America/Panama', 'es') RETURNING id`,
  );
  customerId = rows[0].id;
  const f = fakes([WANTS_TO_TALK], 'known', { meeting: 'ok' });
  await f.svc.process(await seedInbox(`${TAG}-meeting-tz`, 'avisame cuando puedes hablar'));

  const i = f.initiated[0] as { customerTz: string; preferredLanguage: string; intent: Intent };
  assert.equal(i.customerTz, 'America/Panama', 'the confirmation is rendered in the CUSTOMER zone');
  assert.equal(i.preferredLanguage, 'es');
  assert.equal(i.intent.category, 'meeting_request', 'the intent travels so the task fallback can rebuild it');
});

test('a scheduler that CANNOT start falls through to the task — the ask is never dropped', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-meeting-decline', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const f = fakes([WANTS_TO_TALK], 'known', { meeting: 'declines' }); // no calendar / no slots
  await f.svc.process(await seedInbox(`${TAG}-meeting-decline`, 'avisame cuando puedes hablar'));

  assert.equal(f.initiated.length, 1);
  assert.equal(f.created.length, 1, 'no meeting AND no task would silently drop a customer request');
  const decisions = await query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_decisions WHERE customer_id = $1 AND decision_type = 'triage'`,
    [customerId],
  );
  assert.equal(decisions.rows[0].n, '1', 'exactly one audit row per intent — the fall-through must not double-record');
});

test('meeting_request with the scheduler UNWIRED creates a task exactly as before', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-meeting-off', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const f = fakes([WANTS_TO_TALK], 'known'); // flag off → dep absent
  await f.svc.process(await seedInbox(`${TAG}-meeting-off`, 'avisame cuando puedes hablar'));

  assert.equal(f.created.length, 1, 'absent dep = pre-feature behavior');
  assert.equal((f.created[0] as { tags: string[] }).tags[0], 'meeting_request');
});

test('a vague "we should talk sometime" books nothing and creates nothing (inherits the confirm gate)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_customers (bp_ref, display_name, project_ref, work_item_type_ref, telegram_topic_id)
     VALUES ('bp-triage-meeting-vague', 'Triage Test Co', 'proj-1', 'wit-1', '99') RETURNING id`,
  );
  customerId = rows[0].id;
  const vague: Intent = { ...WANTS_TO_TALK, explicit_action_request: false };
  const f = fakes([vague], 'known', { meeting: 'ok' });
  await f.svc.process(await seedInbox(`${TAG}-meeting-vague`, 'algún día tenemos que hablar'));

  assert.equal(f.initiated.length, 0, 'the confirm gate must precede the scheduler');
  assert.equal(f.created.length, 0);
  assert.equal(f.notified.length, 1, 'the founder is asked instead');
});
