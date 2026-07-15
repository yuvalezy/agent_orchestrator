import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildThreadMarkers, markerKey, MARKER_TTL_MS } from './thread-markers';

function makeStore(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    store: {
      get: async (k: string) => map.get(k) ?? null,
      set: async (k: string, v: string) => { map.set(k, v); },
      clear: async (k: string) => { map.delete(k); },
    },
  };
}

test('arming any marker clears every other kind on that thread', async () => {
  const { map, store } = makeStore();
  const clock = new Date('2026-07-15T10:00:00Z');
  const markers = buildThreadMarkers(store, () => clock);

  await markers.arm('draft_edit', '42', 'queue-1');
  assert.equal(await markers.read('draft_edit', '42'), 'queue-1');

  // The regression this exists for: a third marker joining the invariant.
  await markers.arm('schedule', '42', '{"pending":true}');
  assert.equal(await markers.read('draft_edit', '42'), null);
  assert.equal(await markers.read('schedule', '42'), '{"pending":true}');

  await markers.arm('draft_revise', '42', 'queue-2');
  assert.equal(await markers.read('schedule', '42'), null);
  assert.equal(await markers.read('draft_revise', '42'), 'queue-2');

  assert.deepEqual([...map.keys()], [markerKey('draft_revise', '42')]);
});

test('markers are thread-scoped — arming one thread leaves another alone', async () => {
  const { store } = makeStore();
  const markers = buildThreadMarkers(store, () => new Date('2026-07-15T10:00:00Z'));
  await markers.arm('draft_edit', '42', 'queue-1');
  await markers.arm('draft_edit', '43', 'queue-2');
  assert.equal(await markers.read('draft_edit', '42'), 'queue-1');
  assert.equal(await markers.read('draft_edit', '43'), 'queue-2');
});

// W2: an abandoned ✏️ Edit used to stay armed forever, so the founder's next unrelated
// message was consumed as the draft body and sent verbatim to the customer.
test('an armed marker expires, and an expired one reads as absent', async () => {
  const { map, store } = makeStore();
  let clock = new Date('2026-07-15T10:00:00Z');
  const markers = buildThreadMarkers(store, () => clock);

  await markers.arm('draft_edit', '42', 'queue-1');
  clock = new Date(clock.getTime() + MARKER_TTL_MS - 1_000);
  assert.equal(await markers.read('draft_edit', '42'), 'queue-1', 'still inside the window');

  clock = new Date(clock.getTime() + 2_000);
  assert.equal(await markers.read('draft_edit', '42'), null, 'past the TTL');
  assert.equal(map.size, 0, 'expiry also reclaims the row');
});

test('a legacy pre-TTL marker value is dropped rather than treated as freshly armed', async () => {
  // Armed before this shipped: a bare queueId, so its age is unknowable.
  const { map, store } = makeStore({ [markerKey('draft_edit', '42')]: 'queue-legacy' });
  const markers = buildThreadMarkers(store, () => new Date('2026-07-15T10:00:00Z'));
  assert.equal(await markers.read('draft_edit', '42'), null);
  assert.equal(map.size, 0);
});

test('a malformed marker reads as absent', async () => {
  const { store } = makeStore({ [markerKey('schedule', '42')]: '{"v":99,"value":"x"}' });
  const markers = buildThreadMarkers(store, () => new Date('2026-07-15T10:00:00Z'));
  assert.equal(await markers.read('schedule', '42'), null);
});

test('clear removes only the named kind', async () => {
  const { store } = makeStore();
  const markers = buildThreadMarkers(store, () => new Date('2026-07-15T10:00:00Z'));
  await markers.arm('schedule', '42', 'v');
  await markers.clear('draft_edit', '42');
  assert.equal(await markers.read('schedule', '42'), 'v');
  await markers.clear('schedule', '42');
  assert.equal(await markers.read('schedule', '42'), null);
});
