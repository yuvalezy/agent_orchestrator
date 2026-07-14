import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDraftReviser,
  buildDraftReviseMessageHandler,
  type DraftReviserDeps,
} from './draft-revise';
import type { KnowledgeChunk, ReviseRequest, ReviseResult } from '../ports/llm.port';
import type { Notification } from '../ports/founder-notifier.port';
import type { DraftForRevise, RevisedDraft } from '../outbound/outbound-repo';
import type { StyleLane } from '../knowledge/style-lane';

// Pure-mock unit tests for the Draft correction loop CORE (no DB/network — reviser LLM,
// retriever, outbound repo, inbox read, notifier all mocked). Verifies: regeneration is
// grounded in the ORIGINAL inbound body (not a triage paraphrase), the reviser gets the prior
// draft + instruction + retrieved knowledge, the revised draft is persisted + re-presented with
// the 🔁 button, throw-isolation (a reviser failure never throws — the founder is asked to
// retry), and the clear-marker-BEFORE-work idempotency of the capture handler.

const chunk = (over: Partial<KnowledgeChunk> = {}): KnowledgeChunk => ({
  content: 'We support CSV export.',
  title: 'Exports',
  route: '/exports',
  section: null,
  distance: 0.1,
  ...over,
});

const draft = (over: Partial<DraftForRevise> = {}): DraftForRevise => ({
  queueId: 'q1',
  decisionId: 'd1',
  customerId: 'cust-1',
  priorBody: 'Yes, we have a QuickBooks integration.',
  inboxMessageId: 'inbox-1',
  agentOutput: {
    intent: { category: 'question_existing', summary: 'Asked about QuickBooks', suggested_title: 't', priority: 'low', confidence: 0.9, related_open_task_ref: null },
    draft_body: 'Yes, we have a QuickBooks integration.',
    citations: [],
    language: 'en',
    customer_name: 'Ada',
  },
  ...over,
});

interface Cap {
  reviseReqs: ReviseRequest[];
  retrieveCalls: Array<{ q: string; customerId: string | null }>;
  inboxReads: string[];
  reviseDraftCalls: Array<{ queueId: string; body: string; agentOutput: unknown; revision: { instruction: string; by: string } }>;
  notifies: Array<{ customerId: string; n: Notification; buttons?: Array<{ id: string; label: string }> }>;
  learns: unknown[];
  styleLaneCalls: Array<string | null>;
}

function makeDeps(over?: {
  getDraft?: DraftForRevise | null;
  reviseResult?: ReviseResult;
  reviseReplyImpl?: (r: ReviseRequest) => Promise<ReviseResult>;
  knowledge?: KnowledgeChunk[];
  revised?: RevisedDraft | null;
  inbox?: { subject: string | null; body: string | null } | null;
  learn?: DraftReviserDeps['learnCorrection'];
  /** When set, a StyleLane stub returning these directives (a throw when `styleLaneThrows`). */
  guidance?: string[];
  styleLaneThrows?: boolean;
}): { deps: DraftReviserDeps; cap: Cap } {
  const cap: Cap = { reviseReqs: [], retrieveCalls: [], inboxReads: [], reviseDraftCalls: [], notifies: [], learns: [], styleLaneCalls: [] };
  const styleLane: StyleLane | undefined =
    over?.guidance !== undefined || over?.styleLaneThrows
      ? {
          guidanceFor: async (customerId) => {
            cap.styleLaneCalls.push(customerId);
            if (over?.styleLaneThrows) throw new Error('style lane down');
            return over?.guidance ?? [];
          },
        }
      : undefined;
  const deps: DraftReviserDeps = {
    reviser: {
      reviseReply: over?.reviseReplyImpl
        ? over.reviseReplyImpl
        : async (r: ReviseRequest): Promise<ReviseResult> => {
            cap.reviseReqs.push(r);
            return over?.reviseResult ?? { body: 'We do not currently offer a QuickBooks integration.', usedSourceIndexes: [] };
          },
    },
    retriever: {
      retrieve: async (q: string, customerId: string | null) => {
        cap.retrieveCalls.push({ q, customerId });
        return over?.knowledge ?? [];
      },
    },
    notifier: {
      notifyCustomerEvent: async (customerId, n, buttons) => {
        cap.notifies.push({ customerId, n, buttons });
      },
    },
    getDraftForRevise: async () => (over?.getDraft === undefined ? draft() : over.getDraft),
    reviseDraft: async (queueId, body, agentOutput, revision) => {
      cap.reviseDraftCalls.push({ queueId, body, agentOutput, revision });
      return over?.revised === undefined
        ? { queueId, oldDecisionId: 'd1', newDecisionId: 'd2', customerId: 'cust-1' }
        : over.revised;
    },
    getInboxSubjectBody: async (id) => {
      cap.inboxReads.push(id);
      return over?.inbox === undefined ? { subject: null, body: 'Do you integrate with QuickBooks?' } : over.inbox;
    },
    learnCorrection: over?.learn
      ? async (input) => { cap.learns.push(input); await over.learn!(input); }
      : undefined,
    styleLane,
  };
  return { deps, cap };
}

test('reviseFromInstruction: regenerates from the ORIGINAL inbound body + prior draft + instruction, persists + re-presents with 🔁', async () => {
  const { deps, cap } = makeDeps({ knowledge: [chunk()] });
  const svc = buildDraftReviser(deps);

  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'We have no QuickBooks integration — say so.', by: 'user-1' });

  // Re-read the original inbound message (DA S5 — grounding fidelity).
  assert.deepEqual(cap.inboxReads, ['inbox-1']);
  // Retrieval + reviser both use the RAW inbound body, not the triage summary.
  assert.equal(cap.retrieveCalls.length, 1);
  assert.equal(cap.retrieveCalls[0].q, 'Do you integrate with QuickBooks?');
  assert.equal(cap.retrieveCalls[0].customerId, 'cust-1');

  assert.equal(cap.reviseReqs.length, 1);
  const r = cap.reviseReqs[0];
  assert.equal(r.question, 'Do you integrate with QuickBooks?');
  assert.equal(r.language, 'en');
  assert.equal(r.customerName, 'Ada');
  assert.equal(r.priorDraft, 'Yes, we have a QuickBooks integration.');
  assert.equal(r.instruction, 'We have no QuickBooks integration — say so.');
  assert.equal(r.knowledge.length, 1);

  // Persisted: new body + new agent_output carrying the intent/language/customer_name + revised_from.
  assert.equal(cap.reviseDraftCalls.length, 1);
  const rd = cap.reviseDraftCalls[0];
  assert.equal(rd.queueId, 'q1');
  assert.equal(rd.body, 'We do not currently offer a QuickBooks integration.');
  const ao = rd.agentOutput as { draft_body: string; language: string; customer_name: string; revised_from: string };
  assert.equal(ao.draft_body, 'We do not currently offer a QuickBooks integration.');
  assert.equal(ao.language, 'en');
  assert.equal(ao.customer_name, 'Ada');
  assert.equal(ao.revised_from, 'd1');
  assert.deepEqual(rd.revision, { instruction: 'We have no QuickBooks integration — say so.', by: 'user-1' });

  // Re-presented with the SAME buttons incl. 🔁 (iterative).
  assert.equal(cap.notifies.length, 1);
  assert.equal(cap.notifies[0].customerId, 'cust-1');
  assert.deepEqual(cap.notifies[0].buttons?.map((b) => b.id), ['da:q1', 'de:q1', 'dr:q1', 'dv:q1']);
  assert.match(cap.notifies[0].n.title, /revised/i);
  assert.match(cap.notifies[0].n.body, /We do not currently offer/);
});

test('reviseFromInstruction: falls back to intent.summary when there is no inbound message', async () => {
  const { deps, cap } = makeDeps({ getDraft: draft({ inboxMessageId: null }) });
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'shorter', by: 'u' });
  assert.equal(cap.inboxReads.length, 0, 'no inbox read without an inbox message');
  assert.equal(cap.reviseReqs[0].question, 'Asked about QuickBooks', 'uses stored summary');
});

test('reviseFromInstruction: not an open draft → no-op (no reviser, no persist, no notify)', async () => {
  const { deps, cap } = makeDeps({ getDraft: null });
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'x', by: 'u' });
  assert.equal(cap.reviseReqs.length, 0);
  assert.equal(cap.reviseDraftCalls.length, 0);
  assert.equal(cap.notifies.length, 0);
});

test('reviseFromInstruction: guarded reviseDraft null (approved/rejected first) → no re-present', async () => {
  const { deps, cap } = makeDeps({ revised: null });
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'x', by: 'u' });
  assert.equal(cap.reviseDraftCalls.length, 1);
  assert.equal(cap.notifies.length, 0, 'no presentation when the draft was already resolved');
});

test('reviseFromInstruction: reviser failure NEVER throws — founder asked to retry (throw isolation, DA B2)', async () => {
  const { deps, cap } = makeDeps({ reviseReplyImpl: async () => { throw new Error('all providers failed'); } });
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'x', by: 'u' }); // must not reject
  assert.equal(cap.reviseDraftCalls.length, 0, 'nothing persisted on failure');
  assert.equal(cap.notifies.length, 1);
  assert.match(cap.notifies[0].n.title, /failed/i);
  assert.equal(cap.notifies[0].n.severity, 'warning');
});

test('reviseFromInstruction: a learnCorrection failure does NOT affect the committed + presented draft', async () => {
  const { deps, cap } = makeDeps({ learn: async () => { throw new Error('classify down'); } });
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'x', by: 'u' }); // must not reject
  assert.equal(cap.reviseDraftCalls.length, 1);
  assert.equal(cap.notifies.length, 1, 'draft still re-presented despite learning failure');
  assert.match(cap.notifies[0].n.title, /revised/i);
  assert.equal(cap.learns.length, 1);
});

test('reviseFromInstruction: a re-present failure AFTER commit does NOT ask to re-revise (DA S1) + never throws', async () => {
  // notifyCustomerEvent throws on the FIRST call (the revised-draft presentation), succeeds after.
  let calls = 0;
  const notifies: Notification[] = [];
  const { deps } = makeDeps({});
  deps.notifier.notifyCustomerEvent = async (_c, n) => {
    calls += 1;
    if (calls === 1) throw new Error('telegram down');
    notifies.push(n);
  };
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'x', by: 'u' }); // must not reject
  // The soft "revised but could not re-post" note — NOT the "revision failed, tap Revise again".
  assert.equal(notifies.length, 1);
  assert.match(notifies[0].title, /revised/i);
  assert.doesNotMatch(notifies[0].body, /tap 🔁 Revise and send your instruction again/);
});

test('reviseFromInstruction: style lane voice guidance flows into the ReviseRequest AND never leaks into citations', async () => {
  const voice = ['Be warm and informal', 'Sign off with "Cheers"'];
  const { deps, cap } = makeDeps({
    guidance: voice,
    knowledge: [chunk({ title: 'Exports', section: null, route: '/exports', content: 'We support CSV export.' })],
    reviseResult: { body: 'Cheers — yes, CSV export works great!', usedSourceIndexes: [0] },
  });
  const svc = buildDraftReviser(deps);

  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'warmer tone please', by: 'u' });

  // The lane was asked for THIS customer's directives and they rode into the regeneration request.
  assert.deepEqual(cap.styleLaneCalls, ['cust-1']);
  assert.equal(cap.reviseReqs.length, 1);
  assert.deepEqual(cap.reviseReqs[0].voiceGuidance, voice, 'voice guidance is passed to the reviser');

  // Voice directives are DIRECTIVE, never a citation: they must not appear in the rendered "Based
  // on:" list nor in the persisted agent_output.citations (which are derived from knowledge only).
  const ao = cap.reviseDraftCalls[0].agentOutput as { citations: string[] };
  const citationsBlob = ao.citations.join('\n');
  for (const v of voice) assert.ok(!citationsBlob.includes(v), `voice directive must not be cited: ${v}`);
  assert.ok(ao.citations.some((c) => c.includes('Exports')), 'the knowledge source IS cited');

  const notifyBody = cap.notifies[0].n.body;
  for (const v of voice) assert.ok(!notifyBody.includes(v), 'voice directive must not surface in the founder-facing citations');
});

test('reviseFromInstruction: no style lane wired → voiceGuidance omitted, revise still succeeds', async () => {
  const { deps, cap } = makeDeps({ knowledge: [chunk()] });
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'x', by: 'u' });
  assert.equal(cap.styleLaneCalls.length, 0, 'lane never called when unwired');
  assert.equal(cap.reviseReqs[0].voiceGuidance, undefined);
  assert.equal(cap.reviseDraftCalls.length, 1, 'revise still commits');
});

test('reviseFromInstruction: a style lane failure NEVER breaks revise (best-effort → no voice guidance)', async () => {
  const { deps, cap } = makeDeps({ styleLaneThrows: true, knowledge: [chunk()] });
  const svc = buildDraftReviser(deps);
  await svc.reviseFromInstruction({ queueId: 'q1', instruction: 'x', by: 'u' }); // must not reject
  assert.deepEqual(cap.styleLaneCalls, ['cust-1']);
  assert.deepEqual(cap.reviseReqs[0].voiceGuidance, [], 'a lane throw degrades to empty guidance');
  assert.equal(cap.reviseDraftCalls.length, 1, 'revise commits despite the lane fault');
  assert.match(cap.notifies[0].n.title, /revised/i);
});

// ── capture handler (clear-marker-first idempotency) ─────────────────────────

function reviserStub(): { svc: { reviseFromInstruction: (i: { queueId: string; instruction: string; by: string }) => Promise<void> }; calls: Array<{ queueId: string; instruction: string; by: string }> } {
  const calls: Array<{ queueId: string; instruction: string; by: string }> = [];
  return { svc: { reviseFromInstruction: async (i) => { calls.push(i); } }, calls };
}

test('revise capture: armed thread + non-empty text → CLEAR marker BEFORE reviseFromInstruction (at-most-once)', async () => {
  const order: string[] = [];
  const map = new Map<string, string>([['42', 'q7']]);
  const calls: Array<{ queueId: string; instruction: string; by: string }> = [];
  const handler = buildDraftReviseMessageHandler({
    readArmedRevise: async (t) => map.get(t) ?? null,
    clearArmedRevise: async (t) => { order.push('clear'); map.delete(t); },
    reviser: { reviseFromInstruction: async (i) => { order.push('revise'); calls.push(i); } },
  });

  await handler({ threadId: '42', text: 'we have no QuickBooks', by: 'u5' });

  assert.deepEqual(order, ['clear', 'revise'], 'marker cleared before the work → replay is a no-op');
  assert.deepEqual(calls, [{ queueId: 'q7', instruction: 'we have no QuickBooks', by: 'u5' }]);
  assert.equal(map.has('42'), false);
});

test('revise capture: a re-delivered message after clear finds NO marker → no-op (idempotent)', async () => {
  const map = new Map<string, string>([['42', 'q7']]);
  const { svc, calls } = reviserStub();
  const handler = buildDraftReviseMessageHandler({
    readArmedRevise: async (t) => map.get(t) ?? null,
    clearArmedRevise: async (t) => { map.delete(t); },
    reviser: svc,
  });
  await handler({ threadId: '42', text: 'instruction', by: 'u' }); // consumes + clears
  await handler({ threadId: '42', text: 'instruction', by: 'u' }); // replay → nothing armed
  assert.equal(calls.length, 1, 'exactly one revise despite replay');
});

test('revise capture: UNARMED thread → ignored (no clear, no revise)', async () => {
  const { svc, calls } = reviserStub();
  let cleared = false;
  const handler = buildDraftReviseMessageHandler({
    readArmedRevise: async () => null,
    clearArmedRevise: async () => { cleared = true; },
    reviser: svc,
  });
  await handler({ threadId: '42', text: 'chatting', by: 'u' });
  assert.equal(calls.length, 0);
  assert.equal(cleared, false);
});

test('revise capture: empty/whitespace instruction → NOT consumed, marker stays armed', async () => {
  const map = new Map<string, string>([['42', 'q7']]);
  const { svc, calls } = reviserStub();
  const handler = buildDraftReviseMessageHandler({
    readArmedRevise: async (t) => map.get(t) ?? null,
    clearArmedRevise: async (t) => { map.delete(t); },
    reviser: svc,
  });
  await handler({ threadId: '42', text: '   \n ', by: 'u' });
  assert.equal(calls.length, 0, 'never regenerate on a blank instruction');
  assert.equal(map.get('42'), 'q7', 'marker stays armed for the next non-empty message');
});
