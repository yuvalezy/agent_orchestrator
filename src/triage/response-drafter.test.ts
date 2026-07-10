import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponseDrafter, renderCitations, type ResponseDrafterDeps } from './response-drafter';
import type { ClaimedInbox } from '../inbox/inbox-repo';
import type { KnowledgeChunk, DraftRequest, DraftResult } from '../ports/llm.port';
import type { Notification } from '../ports/founder-notifier.port';
import type { EnqueueDraftInput, OpenDraftForInbox } from '../outbound/outbound-repo';

// Pure-mock unit tests for the M2(c) response-drafter CORE (no DB/network — LLM,
// retriever-fed knowledge, outbound repo, decisions repo, notifier all mocked).
// Verifies: cited draft enqueued is_draft (via enqueueDraft) with channel-correct +
// quoted-reply wiring, decision recorded with body/citations/language, presentation
// carries the Approve/Edit/Reject buttons, reclaim-idempotency re-presents (no second
// draft), no-sender skip, and renderCitations clamp/dedupe/fallback.

const chunk = (over: Partial<KnowledgeChunk> = {}): KnowledgeChunk => ({
  content: 'Export runs nightly at 02:00 UTC.',
  title: 'Exports',
  route: '/docs/exports',
  section: 'Scheduling',
  distance: 0.12,
  ...over,
});

const row = (over: Partial<ClaimedInbox> = {}): ClaimedInbox => ({
  id: 'inbox-1',
  channel_instance_id: 'ci-wa-1',
  channel_type: 'whatsapp',
  channel_message_id: 'wamid.ABC123',
  channel_thread_id: 'thr-1',
  sender_address: '+15551230000',
  sender_name: 'Ada',
  subject: null,
  body: 'When does the nightly export run?',
  received_at: '2026-07-09T10:00:00Z',
  recipients: null,
  account_email: null,
  ticket_number: null,
  is_group: null,
  chat_muted: null,
  mentions_me: null,
  ...over,
});

interface Captured {
  draftReqs: DraftRequest[];
  records: Array<{ customerId: string; inboxMessageId: string; agentOutput: unknown }>;
  enqueues: EnqueueDraftInput[];
  notifies: Array<{ customerId: string; n: Notification; buttons?: Array<{ id: string; label: string }> }>;
  findInboxIds: string[];
}

function makeDeps(over?: {
  draftResult?: DraftResult;
  open?: OpenDraftForInbox | null;
  draftReplyImpl?: (r: DraftRequest) => Promise<DraftResult>;
  notifyImpl?: () => Promise<void>;
}): { deps: ResponseDrafterDeps; cap: Captured } {
  const cap: Captured = { draftReqs: [], records: [], enqueues: [], notifies: [], findInboxIds: [] };
  const deps: ResponseDrafterDeps = {
    llm: {
      draftReply: over?.draftReplyImpl
        ? over.draftReplyImpl
        : async (r: DraftRequest): Promise<DraftResult> => {
            cap.draftReqs.push(r);
            return over?.draftResult ?? { body: 'El export nocturno corre a las 02:00 UTC.', usedSourceIndexes: [0] };
          },
    },
    notifier: {
      notifyCustomerEvent: async (customerId, n, buttons) => {
        cap.notifies.push({ customerId, n, buttons });
        if (over?.notifyImpl) await over.notifyImpl();
      },
    },
    enqueueDraft: async (input): Promise<string> => {
      cap.enqueues.push(input);
      return 'queue-42';
    },
    recordDraftDecision: async (input): Promise<{ decisionId: string }> => {
      cap.records.push(input);
      return { decisionId: 'dec-7' };
    },
    findOpenDraftByInbox: async (inboxMessageId): Promise<OpenDraftForInbox | null> => {
      cap.findInboxIds.push(inboxMessageId);
      return over?.open ?? null;
    },
  };
  return { deps, cap };
}

const cfg = { displayName: 'Ada Lovelace', preferredLanguage: 'es' };

test('draftAndPresent: enqueues a cited draft, records the decision, presents with buttons', async () => {
  const { deps, cap } = makeDeps();
  const drafter = buildResponseDrafter(deps);
  const knowledge = [chunk(), chunk({ title: 'Retries', section: null, route: '/docs/retries' })];

  await drafter.draftAndPresent({
    row: row(),
    customerId: 'cust-9',
    config: cfg,
    threadKey: 'thr-key-1',
    knowledge,
    intent: { category: 'question_existing', summary: 's', suggested_title: 't', priority: 'low', confidence: 0.9, related_open_task_ref: null },
  });

  // Reclaim guard checked first.
  assert.deepEqual(cap.findInboxIds, ['inbox-1']);

  // LLM asked in the customer's language, with the question + customer name + knowledge.
  assert.equal(cap.draftReqs.length, 1);
  assert.equal(cap.draftReqs[0].language, 'es');
  assert.equal(cap.draftReqs[0].customerName, 'Ada Lovelace');
  assert.match(cap.draftReqs[0].question, /nightly export/);
  assert.equal(cap.draftReqs[0].knowledge.length, 2);

  // Decision recorded BEFORE enqueue, carrying draft_body + citations + language + intent.
  assert.equal(cap.records.length, 1);
  const ao = cap.records[0].agentOutput as { draft_body: string; citations: string[]; language: string; intent: { category: string } };
  assert.equal(cap.records[0].customerId, 'cust-9');
  assert.equal(cap.records[0].inboxMessageId, 'inbox-1');
  assert.equal(ao.draft_body, 'El export nocturno corre a las 02:00 UTC.');
  assert.deepEqual(ao.citations, ['Exports › Scheduling (/docs/exports)']);
  assert.equal(ao.language, 'es');
  assert.equal(ao.intent.category, 'question_existing');

  // Enqueue is channel-correct (same inbound instance — no cross-account), quoted, threaded,
  // FK'd to the decision, carrying the draft body.
  assert.equal(cap.enqueues.length, 1);
  const e = cap.enqueues[0];
  assert.equal(e.channelInstanceId, 'ci-wa-1');
  assert.equal(e.channelType, 'whatsapp');
  assert.equal(e.recipientAddress, '+15551230000');
  assert.equal(e.threadKey, 'thr-key-1');
  assert.equal(e.inReplyTo, 'wamid.ABC123'); // in_reply_to = inbound channel_message_id (must-fix #2)
  assert.equal(e.customerId, 'cust-9');
  assert.equal(e.decisionId, 'dec-7');
  assert.equal(e.body, 'El export nocturno corre a las 02:00 UTC.');

  // Presentation: buttons for the enqueued queue id, body shows citations + language.
  assert.equal(cap.notifies.length, 1);
  const p = cap.notifies[0];
  assert.equal(p.customerId, 'cust-9');
  assert.deepEqual(
    p.buttons,
    [
      { id: 'da:queue-42', label: '✅ Approve' },
      { id: 'de:queue-42', label: '✏️ Edit' },
      { id: 'dr:queue-42', label: '🚫 Reject' },
    ],
  );
  assert.equal(p.n.severity, 'action');
  assert.match(p.n.body, /Based on:/);
  assert.match(p.n.body, /- Exports › Scheduling \(\/docs\/exports\)/);
  assert.match(p.n.body, /Language: es/);
});

test('draftAndPresent: reclaim guard re-presents an existing open draft, no second draft', async () => {
  const open: OpenDraftForInbox = {
    queueId: 'queue-existing',
    decisionId: 'dec-existing',
    customerId: 'cust-9',
    body: 'Respuesta previa.',
    agentOutput: { intent: { category: 'question_existing' }, draft_body: 'Respuesta previa.', citations: ['Exports › Scheduling (/docs/exports)'], language: 'es' },
  };
  const { deps, cap } = makeDeps({ open });
  const drafter = buildResponseDrafter(deps);

  await drafter.draftAndPresent({
    row: row(),
    customerId: 'cust-9',
    config: cfg,
    threadKey: 'thr-key-1',
    knowledge: [chunk()],
    intent: { category: 'question_existing', summary: 's', suggested_title: 't', priority: 'low', confidence: 0.9, related_open_task_ref: null },
  });

  // No re-draft, no new decision, no new queue row.
  assert.equal(cap.draftReqs.length, 0);
  assert.equal(cap.records.length, 0);
  assert.equal(cap.enqueues.length, 0);
  // Re-presented with the EXISTING draft's buttons + stored citations/language.
  assert.equal(cap.notifies.length, 1);
  assert.equal(cap.notifies[0].buttons?.[0].id, 'da:queue-existing');
  assert.match(cap.notifies[0].n.body, /Respuesta previa\./);
  assert.match(cap.notifies[0].n.body, /Based on:/);
  assert.match(cap.notifies[0].n.body, /Language: es/);
});

test('reconfirmOpenDraft: true + re-present when an open draft exists', async () => {
  const open: OpenDraftForInbox = {
    queueId: 'queue-existing',
    decisionId: 'dec-existing',
    customerId: 'cust-9',
    body: 'Respuesta previa.',
    agentOutput: { citations: ['Exports'], language: 'es' },
  };
  const { deps, cap } = makeDeps({ open });
  const drafter = buildResponseDrafter(deps);
  const ok = await drafter.reconfirmOpenDraft('inbox-1');
  assert.equal(ok, true);
  assert.equal(cap.notifies.length, 1);
  assert.equal(cap.notifies[0].buttons?.[0].id, 'da:queue-existing');
});

test('reconfirmOpenDraft: false + no notify when no open draft', async () => {
  const { deps, cap } = makeDeps({ open: null });
  const drafter = buildResponseDrafter(deps);
  const ok = await drafter.reconfirmOpenDraft('inbox-1');
  assert.equal(ok, false);
  assert.equal(cap.notifies.length, 0);
});

test('draftAndPresent: no sender_address → skip (no LLM/enqueue/notify), never throws', async () => {
  const { deps, cap } = makeDeps();
  const drafter = buildResponseDrafter(deps);
  await drafter.draftAndPresent({
    row: row({ sender_address: null }),
    customerId: 'cust-9',
    config: cfg,
    threadKey: 'thr-key-1',
    knowledge: [chunk()],
    intent: { category: 'question_existing', summary: 's', suggested_title: 't', priority: 'low', confidence: 0.9, related_open_task_ref: null },
  });
  assert.equal(cap.draftReqs.length, 0);
  assert.equal(cap.enqueues.length, 0);
  assert.equal(cap.notifies.length, 0);
});

test('draftAndPresent: a notify failure propagates (→ reclaim re-presents) but nothing double-enqueues', async () => {
  const { deps, cap } = makeDeps({ notifyImpl: async () => { throw new Error('telegram down'); } });
  const drafter = buildResponseDrafter(deps);
  await assert.rejects(
    () => drafter.draftAndPresent({
      row: row(),
      customerId: 'cust-9',
      config: cfg,
      threadKey: 'thr-key-1',
      knowledge: [chunk()],
      intent: { category: 'question_existing', summary: 's', suggested_title: 't', priority: 'low', confidence: 0.9, related_open_task_ref: null },
    }),
    /telegram down/,
  );
  // Exactly one enqueue + one decision — the reclaim guard (findOpenDraftByInbox) makes a
  // re-run idempotent; the throw is what triggers that re-run at the triage level.
  assert.equal(cap.enqueues.length, 1);
  assert.equal(cap.records.length, 1);
});

test('draftAndPresent: WhatsApp subject+body assembled into the question', async () => {
  const { deps, cap } = makeDeps();
  const drafter = buildResponseDrafter(deps);
  await drafter.draftAndPresent({
    row: row({ subject: 'Export question', body: 'When does it run?' }),
    customerId: 'cust-9',
    config: cfg,
    threadKey: 'tk',
    knowledge: [chunk()],
    intent: { category: 'question_existing', summary: 's', suggested_title: 't', priority: 'low', confidence: 0.9, related_open_task_ref: null },
  });
  assert.equal(cap.draftReqs[0].question, 'Export question\n\nWhen does it run?');
});

// ── renderCitations ────────────────────────────────────────────────────────────

test('renderCitations: maps used indexes to labels in order', () => {
  const k = [chunk({ title: 'A', section: 'S1', route: '/a' }), chunk({ title: 'B', section: 'S2', route: '/b' })];
  assert.deepEqual(renderCitations(k, [1, 0]), ['B › S2 (/b)', 'A › S1 (/a)']);
});

test('renderCitations: dedupes repeated + same-label indexes', () => {
  const k = [chunk({ title: 'A', section: 'S1', route: '/a' }), chunk({ title: 'B', section: 'S2', route: '/b' })];
  assert.deepEqual(renderCitations(k, [0, 0, 1]), ['A › S1 (/a)', 'B › S2 (/b)']);
});

test('renderCitations: clamps out-of-range / negative / non-integer indexes', () => {
  const k = [chunk({ title: 'A', section: 'S1', route: '/a' })];
  // 5 (oob), -1 (neg), 1.5 (non-int) all dropped; 0 kept.
  assert.deepEqual(renderCitations(k, [5, -1, 1.5, 0]), ['A › S1 (/a)']);
});

test('renderCitations: empty valid set → fallback to ALL chunk labels', () => {
  const k = [chunk({ title: 'A', section: 'S1', route: '/a' }), chunk({ title: 'B', section: null, route: '/b' })];
  assert.deepEqual(renderCitations(k, [9, -3]), ['A › S1 (/a)', 'B (/b)']);
});

test('renderCitations: empty usedSourceIndexes → fallback to ALL chunk labels', () => {
  const k = [chunk({ title: 'A', section: 'S1', route: '/a' })];
  assert.deepEqual(renderCitations(k, []), ['A › S1 (/a)']);
});

test('renderCitations: null title → "Untitled", missing section/route degrade gracefully', () => {
  const k = [chunk({ title: null, section: null, route: null })];
  assert.deepEqual(renderCitations(k, [0]), ['Untitled']);
});
