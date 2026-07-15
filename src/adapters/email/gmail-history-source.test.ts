import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGmailQuery, buildStarredQuery, buildGmailHistorySource } from './gmail-history-source';
import type { ProviderEmail } from '../../ports/channel.port';

// Unit tests for the Gmail history source: query construction (domain + address scoping, no
// redundant same-domain clause), the `is:starred (...)` id-set query, thread normalization +
// per-account/thread error isolation, and the starred MARKING — one leg stamps `starred` inline, so
// a starred thread must yield exactly ONE thread (a second leg would double-write its memory).

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

test('buildStarredQuery: wraps the SAME identity clause in is:starred (...)', () => {
  const q = buildStarredQuery({ domain: 'holadocmed.com', addresses: ['boss@gmail.com'] });
  assert.match(q!, /^is:starred \(/);
  assert.match(q!, /from:holadocmed\.com OR to:holadocmed\.com/);
  assert.match(q!, /from:boss@gmail\.com OR to:boss@gmail\.com/);
});

test('buildStarredQuery: empty identity → null (nothing to search)', () => {
  assert.equal(buildStarredQuery({ domain: null, addresses: [] }), null);
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

/** A client whose search answers the starred query from `starredIds` and the plain query from
 *  `allIds`. `is:starred (<identity>)` matches a subset of the identity query, but the two searches
 *  carry SEPARATE caps — so what the plain search actually RETURNS (its most-recent `cap`) need not
 *  contain a starred id at all. That gap is what these fixtures exercise. */
const client = (allIds: string[], starredIds: string[] = []) => ({
  searchThreadIds: async (q: string) => (q.startsWith('is:starred') ? starredIds : allIds),
  getThread: async (tid: string) => [email({ threadId: tid })],
});

test('reads threads across accounts; skips a thread with no body; namespaces threadKey', async () => {
  const src = buildGmailHistorySource({
    accounts: [
      {
        name: 'email:gmail:work',
        client: {
          searchThreadIds: async (q) => (q.startsWith('is:starred') ? [] : ['t1', 't2']),
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

// ── starred marking (one leg, one threadKey — never a second read) ────────────────
test('a starred thread yields exactly ONE thread carrying starred:true (no duplicate leg)', async () => {
  // The starred search is a SUBSET of the plain one, so reading it as its own leg would surface t1
  // twice and (dedup being on thread_key) write its conversation memory twice.
  const src = buildGmailHistorySource({
    accounts: [{ name: 'w', client: client(['t1', 't2'], ['t1']) }],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
  });
  const threads = await src.readThreads('c');
  assert.equal(threads.length, 2, 'the starred thread is not read a second time');
  assert.deepEqual(threads.map((t) => t.threadKey), ['gmail:w:t1', 'gmail:w:t2']);
  assert.equal(threads[0].starred, true, 'in the starred id-set → marked');
  assert.equal(threads[1].starred, false, 'not in the set → cannot propose');
});

// The set MARKS the threads the plain search returned, and ADDS the ones it didn't. Marking-only was
// wrong in the one case a star exists for: maxThreadsPerAccount keeps the most RECENT threads, so an
// old starred thread ranks below the cap, is never fetched, is never marked, and — the star being the
// only gate that yields a card — silently produces nothing. The aged thread the founder deliberately
// flagged was the exact one the leg dropped.
test('a starred id OUTSIDE the recency cap is still read and marked (the set adds, not just marks)', async () => {
  const src = buildGmailHistorySource({
    // cap=1: the plain search returns only the newest thread ('t1'); 't9' is the old starred one.
    accounts: [{ name: 'w', client: client(['t1'], ['t9']) }],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
    maxThreadsPerAccount: 1,
  });
  const threads = await src.readThreads('c');
  assert.deepEqual(threads.map((t) => t.threadKey), ['gmail:w:t1', 'gmail:w:t9'], 'the capped-out star is pulled in');
  assert.equal(threads[0].starred, false);
  assert.equal(threads[1].starred, true, 'and it can now propose — the whole point of the star');
});

test('best-effort: a starred-search failure degrades to zero stars, never killing the history read', async () => {
  const src = buildGmailHistorySource({
    accounts: [
      {
        name: 'w',
        client: {
          searchThreadIds: async (q) => {
            if (q.startsWith('is:starred')) throw new Error('rate limited');
            return ['t1'];
          },
          getThread: async (tid) => [email({ threadId: tid })],
        },
      },
    ],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
  });
  const threads = await src.readThreads('c');
  assert.equal(threads.length, 1, 'history still read');
  assert.equal(threads[0].starred, false, 'unknown stars degrade to no proposals, not a crash');
});

test('stars are per-account (one account’s starred set never marks another’s threads)', async () => {
  const src = buildGmailHistorySource({
    accounts: [
      { name: 'a', client: client(['t1'], ['t1']) },
      { name: 'b', client: client(['t1'], []) },
    ],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
  });
  const threads = await src.readThreads('c');
  assert.deepEqual(threads.map((t) => [t.threadKey, t.starred]), [
    ['gmail:a:t1', true],
    ['gmail:b:t1', false],
  ]);
});

test('the starred cap is passed to the starred search, separate from the thread cap', async () => {
  const caps: Record<string, number | undefined> = {};
  const src = buildGmailHistorySource({
    accounts: [
      {
        name: 'w',
        client: {
          searchThreadIds: async (q, cap) => {
            caps[q.startsWith('is:starred') ? 'starred' : 'plain'] = cap;
            return [];
          },
          getThread: async () => [],
        },
      },
    ],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
    maxThreadsPerAccount: 50,
    maxStarredPerAccount: 7,
  });
  await src.readThreads('c');
  assert.equal(caps.plain, 50);
  assert.equal(caps.starred, 7);
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
      { name: 'ok', client: client(['t9']) },
    ],
    getIdentity: async () => ({ domain: 'x.com', addresses: [] }),
  });
  const threads = await src.readThreads('c');
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadKey, 'gmail:ok:t9');
});
