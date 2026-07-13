import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailQuery, buildGmailHistorySource } from './gmail-history-source';
import type { ProviderEmail } from '../../ports/channel.port';

// Unit tests for the Gmail history source: query construction (domain + address scoping, no
// redundant same-domain clause) and thread normalization + per-account/thread error isolation.

test('buildGmailQuery: domain + off-domain addresses, skips redundant same-domain address', () => {
  const q = buildGmailQuery({ domain: 'holadocmed.com', addresses: ['kzyman@holadocmed.com', 'boss@gmail.com'] });
  assert.match(q!, /from:holadocmed\.com OR to:holadocmed\.com/);
  assert.match(q!, /from:boss@gmail\.com OR to:boss@gmail\.com/);
  assert.ok(!q!.includes('kzyman@holadocmed.com'), 'same-domain address is covered by the domain term');
});

test('buildGmailQuery: no domain → uses explicit addresses', () => {
  const q = buildGmailQuery({ domain: null, addresses: ['a@x.com'] });
  assert.equal(q, 'from:a@x.com OR to:a@x.com');
});

test('buildGmailQuery: empty identity → null (nothing to search)', () => {
  assert.equal(buildGmailQuery({ domain: null, addresses: [] }), null);
});

const email = (over: Partial<ProviderEmail>): ProviderEmail => ({
  id: 'm1',
  threadId: 't1',
  from: 'them@holadocmed.com',
  to: [],
  cc: [],
  subject: 'hi',
  bodyText: 'a real body',
  sentAt: new Date(0),
  raw: {},
  ...over,
});

test('reads threads across accounts; skips a thread with no body; namespaces threadKey', async () => {
  const src = buildGmailHistorySource({
    accounts: [
      {
        name: 'email:gmail:work',
        client: {
          searchThreadIds: async () => ['t1', 't2'],
          getThread: async (tid) => (tid === 't1' ? [email({ threadId: 't1' })] : [email({ threadId: 't2', bodyText: '   ' })]),
        },
      },
    ],
    getIdentity: async () => ({ domain: 'holadocmed.com', addresses: [] }),
  });
  const threads = await src.readThreads('cust-1');
  assert.equal(threads.length, 1, 'the empty-body thread is dropped');
  assert.equal(threads[0].threadKey, 'gmail:email:gmail:work:t1');
  assert.equal(threads[0].channel, 'email');
});

test('no identity → empty (no search attempted)', async () => {
  let searched = false;
  const src = buildGmailHistorySource({
    accounts: [{ name: 'w', client: { searchThreadIds: async () => { searched = true; return []; }, getThread: async () => [] } }],
    getIdentity: async () => ({ domain: null, addresses: [] }),
  });
  assert.deepEqual(await src.readThreads('c'), []);
  assert.equal(searched, false);
});

test('a search error on one account is isolated (returns what other work yields)', async () => {
  const src = buildGmailHistorySource({
    accounts: [
      { name: 'boom', client: { searchThreadIds: async () => { throw new Error('401'); }, getThread: async () => [] } },
      { name: 'ok', client: { searchThreadIds: async () => ['t9'], getThread: async () => [email({ threadId: 't9' })] } },
    ],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
  });
  const threads = await src.readThreads('c');
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadKey, 'gmail:ok:t9');
});
