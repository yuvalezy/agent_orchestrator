import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNeedsInfoDrafter, clarificationDirective, type NeedsInfoDrafterDeps } from './needs-info-draft';
import type { ClaimedInbox } from '../inbox/inbox-repo';
import type { Intent } from '../ports/llm.port';

// WP2(c) needs-info drafter: an unclear intent yields ONE clarification-question draft on the
// customer's channel (is_draft=true), grounded ONLY on the unclear message summary, presented with
// Approve/Edit/Reject; reclaim re-presents an existing open draft rather than re-drafting; a
// senderless row is skipped. The triage-level additive/flag-off behavior is tested in triage.service.test.ts.

const UNCLEAR: Intent = {
  category: 'unclear',
  summary: 'Something about the last invoice, unclear what they need',
  suggested_title: 'Unclear',
  priority: 'low',
  confidence: 0.3,
  explicit_action_request: false,
  related_open_task_ref: null,
};

function waRow(over: Partial<ClaimedInbox> = {}): ClaimedInbox {
  return {
    id: 'inbox-1', channel_instance_id: 'inst-A', channel_type: 'whatsapp',
    channel_message_id: 'wamid.IN', message_id_header: null,
    channel_thread_id: 'thread-A', sender_address: '50761234567', sender_name: null,
    subject: null, body: '???', received_at: '2026-07-16T00:00:00.000Z', recipients: null,
    account_email: null, ticket_number: null, is_group: null, chat_muted: null, mentions_me: null,
    ...over,
  };
}

interface Calls {
  composed: number;
  enqueued: Array<{ channelType: string; recipientAddress: string; subject?: string | null; inReplyTo?: string | null; decisionId: string; body: string }>;
  decisions: Array<{ customerId: string; inboxMessageId: string; agentOutput: unknown }>;
  presented: Array<{ customerId: string; buttons: number }>;
}

function buildDeps(calls: Calls, over: Partial<NeedsInfoDrafterDeps> = {}): NeedsInfoDrafterDeps {
  return {
    llm: {
      draftReply: async () => {
        calls.composed += 1;
        return { body: '¿Podrías contarnos un poco más sobre lo que necesitas?', usedSourceIndexes: [0] };
      },
    },
    notifier: {
      notifyCustomerEvent: async (customerId, _n, buttons) => {
        calls.presented.push({ customerId, buttons: buttons?.length ?? 0 });
      },
    },
    enqueueDraft: async (input) => {
      calls.enqueued.push(input);
      return 'q-1';
    },
    recordDraftDecision: async (input) => {
      calls.decisions.push(input);
      return { decisionId: 'dec-1' };
    },
    findOpenDraftByInbox: async () => null,
    ...over,
  };
}

function freshCalls(): Calls {
  return { composed: 0, enqueued: [], decisions: [], presented: [] };
}

test('the clarification directive asks WHAT they meant and forbids assuming/answering', () => {
  const d = clarificationDirective('they mentioned an invoice');
  assert.match(d, /they mentioned an invoice/);
  assert.match(d, /clarify what they need/i);
  assert.match(d, /do NOT assume/i);
  assert.match(d, /do NOT answer a question they did not clearly ask/i);
});

test('unclear intent → composes, enqueues an is_draft on the customer channel, presents with 3 buttons', async () => {
  const calls = freshCalls();
  const drafter = buildNeedsInfoDrafter(buildDeps(calls));

  await drafter.draftClarification({
    row: waRow(), customerId: 'cust-A',
    config: { displayName: 'Acme', preferredLanguage: 'es' },
    threadKey: 'thread-A', intent: UNCLEAR,
  });

  assert.equal(calls.composed, 1);
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.enqueued[0].channelType, 'whatsapp');
  assert.equal(calls.enqueued[0].recipientAddress, '50761234567');
  assert.equal(calls.enqueued[0].inReplyTo, 'wamid.IN', 'quotes the inbound WhatsApp message');
  assert.equal(calls.enqueued[0].subject, undefined, 'no subject on a non-email channel');
  assert.equal(calls.enqueued[0].decisionId, 'dec-1');

  assert.equal(calls.decisions.length, 1);
  assert.equal(calls.decisions[0].inboxMessageId, 'inbox-1', 'the draft decision links the unclear inbox row');
  assert.equal((calls.decisions[0].agentOutput as Record<string, unknown>).kind, 'needs_info_clarification');

  assert.deepEqual(calls.presented, [{ customerId: 'cust-A', buttons: 3 }]);
});

test('email row → Re: subject + threads on the RFC Message-ID header', async () => {
  const calls = freshCalls();
  const drafter = buildNeedsInfoDrafter(buildDeps(calls));
  await drafter.draftClarification({
    row: waRow({ channel_type: 'email', subject: 'Question', message_id_header: '<abc@mail>', sender_address: 'a@acme.com' }),
    customerId: 'cust-A', config: { displayName: 'Acme', preferredLanguage: 'en' }, threadKey: 'thread-A', intent: UNCLEAR,
  });
  assert.equal(calls.enqueued[0].subject, 'Re: Question');
  assert.equal(calls.enqueued[0].inReplyTo, '<abc@mail>', 'email threads on the header, not the channel id');
});

test('reclaim: an existing open draft is re-presented, never re-drafted (idempotent)', async () => {
  const calls = freshCalls();
  const drafter = buildNeedsInfoDrafter(
    buildDeps(calls, {
      findOpenDraftByInbox: async () => ({ queueId: 'q-existing', decisionId: 'dec-0', customerId: 'cust-A', body: 'prior clarification', agentOutput: {} }),
    }),
  );
  await drafter.draftClarification({
    row: waRow(), customerId: 'cust-A', config: { displayName: 'Acme', preferredLanguage: 'es' }, threadKey: 'thread-A', intent: UNCLEAR,
  });
  assert.equal(calls.composed, 0, 'no LLM re-draft on reclaim');
  assert.equal(calls.enqueued.length, 0, 'no second draft enqueued');
  assert.deepEqual(calls.presented, [{ customerId: 'cust-A', buttons: 3 }], 'the existing draft is re-presented');
});

test('a senderless row is skipped (nothing drafted) — the founder already got the notice', async () => {
  const calls = freshCalls();
  const drafter = buildNeedsInfoDrafter(buildDeps(calls));
  await drafter.draftClarification({
    row: waRow({ sender_address: null }), customerId: 'cust-A',
    config: { displayName: 'Acme', preferredLanguage: 'es' }, threadKey: 'thread-A', intent: UNCLEAR,
  });
  assert.equal(calls.composed, 0);
  assert.equal(calls.enqueued.length, 0);
  assert.equal(calls.presented.length, 0);
});
