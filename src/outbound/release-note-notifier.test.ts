import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseNoteNotifier, notificationDirective, type ReleaseNoteNotifierDeps } from './release-note-notifier';
import type { CustomerHistoryMatch } from '../knowledge/memory-repo';

// M2(e) DoD: a release note matching a customer's history yields ONE personalized cited
// draft; re-ingesting the same note does NOT re-draft (the ledger claim is the gate).

const NOTE = {
  key: 'release:2026-07/export-csv',
  title: 'CSV export is here',
  content: 'You can now export any report to CSV from the report toolbar.',
};

interface Calls {
  claimed: Set<string>; // (noteKey|customerId) already claimed → idempotency ledger
  enqueued: Array<{ customerId?: string | null; body: string; channelInstanceId: string }>;
  presented: Array<{ customerId: string; buttons: number }>;
  drafts: number;
  finalized: number;
}

function buildDeps(matches: CustomerHistoryMatch[], calls: Calls): ReleaseNoteNotifierDeps {
  return {
    embedding: { embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]) },
    matchCustomers: async () => matches,
    claimNotification: async (noteKey, customerId) => {
      const k = `${noteKey}|${customerId}`;
      if (calls.claimed.has(k)) return false; // already notified → re-ingest is a no-op
      calls.claimed.add(k);
      return true;
    },
    finalizeNotification: async () => {
      calls.finalized += 1;
    },
    loadCustomerConfig: async (customerId) => ({ displayName: `Cust ${customerId}`, preferredLanguage: 'es' }),
    resolvePrimaryChannel: async (customerId) => ({
      channelInstanceId: `inst-${customerId}`,
      channelType: 'whatsapp',
      recipientAddress: '50761234567',
    }),
    llm: {
      draftReply: async (req) => {
        calls.drafts += 1;
        // The directive must carry the customer's original request (personalization).
        assert.match(req.question, /previously reached out/);
        assert.equal(req.language, 'es');
        assert.equal(req.knowledge.length, 1);
        return { body: `Hola — ${NOTE.title}`, usedSourceIndexes: [0] };
      },
    },
    enqueueDraft: async (input) => {
      calls.enqueued.push({ customerId: input.customerId, body: input.body, channelInstanceId: input.channelInstanceId });
      return `q-${input.customerId}`;
    },
    recordDraftDecision: async () => ({ decisionId: 'dec-1' }),
    notifier: {
      notifyCustomerEvent: async (customerId, _n, buttons) => {
        calls.presented.push({ customerId, buttons: buttons?.length ?? 0 });
      },
    },
    config: { matchMaxDistance: 0.35, maxCustomers: 50, memoryTypes: ['task', 'conversation'] },
  };
}

function freshCalls(): Calls {
  return { claimed: new Set(), enqueued: [], presented: [], drafts: 0, finalized: 0 };
}

test('release note matching a customer history → ONE personalized cited draft, presented with buttons', async () => {
  const calls = freshCalls();
  const matches: CustomerHistoryMatch[] = [
    { customerId: 'cust-A', distance: 0.12, excerpt: 'Can I export my sales report to a spreadsheet?' },
  ];
  const notifier = buildReleaseNoteNotifier(buildDeps(matches, calls));

  const res = await notifier.notifyForReleaseNote(NOTE);

  assert.equal(res.matched, 1);
  assert.equal(res.drafted, 1);
  assert.equal(res.skipped, 0);
  assert.equal(res.failed, 0);
  assert.equal(calls.drafts, 1, 'exactly one draft generated');
  assert.equal(calls.enqueued.length, 1, 'exactly one draft enqueued');
  assert.equal(calls.enqueued[0].customerId, 'cust-A');
  assert.equal(calls.enqueued[0].channelInstanceId, 'inst-cust-A');
  assert.equal(calls.finalized, 1);
  // Presented via the SAME approve/edit/reject flow (3 buttons).
  assert.deepEqual(calls.presented, [{ customerId: 'cust-A', buttons: 3 }]);
});

test('re-ingesting the SAME release note does NOT re-draft (ledger idempotency)', async () => {
  const calls = freshCalls();
  const matches: CustomerHistoryMatch[] = [
    { customerId: 'cust-A', distance: 0.12, excerpt: 'export to spreadsheet please' },
  ];
  const notifier = buildReleaseNoteNotifier(buildDeps(matches, calls));

  const first = await notifier.notifyForReleaseNote(NOTE);
  const second = await notifier.notifyForReleaseNote(NOTE); // same note.key

  assert.equal(first.drafted, 1);
  assert.equal(second.drafted, 0, 'no second draft');
  assert.equal(second.skipped, 1, 'the customer was already notified → skipped');
  assert.equal(calls.drafts, 1, 'the LLM was invoked exactly once across both ingests');
  assert.equal(calls.enqueued.length, 1, 'exactly one draft ever enqueued');
});

test('a customer with no resolvable channel is claimed but not drafted (never sends to nobody)', async () => {
  const calls = freshCalls();
  const matches: CustomerHistoryMatch[] = [{ customerId: 'cust-B', distance: 0.2, excerpt: 'x' }];
  const deps = buildDeps(matches, calls);
  deps.resolvePrimaryChannel = async () => null; // no contact / no active instance
  const notifier = buildReleaseNoteNotifier(deps);

  const res = await notifier.notifyForReleaseNote(NOTE);

  assert.equal(res.drafted, 0);
  assert.equal(res.skipped, 1);
  assert.equal(calls.enqueued.length, 0, 'nothing enqueued for an unresolvable recipient');
});

test('notificationDirective embeds the original request verbatim', () => {
  const d = notificationDirective('export to CSV');
  assert.match(d, /"export to CSV"/);
  assert.match(d, /PROACTIVE product update/);
});
