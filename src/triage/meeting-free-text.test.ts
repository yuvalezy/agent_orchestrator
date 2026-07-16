import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PendingAsk } from '../query/pending-ask';
import { buildMeetingFreeTextHook, meetingIdFromOptions } from './meeting-free-text';

const MEETING = 'd20a9dec-6191-44c4-a789-5d0badd34197';

const slotAsk = (): PendingAsk => ({
  v: 1,
  customerId: 'cust-1',
  options: [
    { id: `ms0:${MEETING}`, label: 'Thu 17 Jul 11:00' },
    { id: `ms1:${MEETING}`, label: 'Thu 17 Jul 14:00' },
    { id: `mtask:${MEETING}`, label: 'Just make a task' },
  ],
});

const contactAsk = (): PendingAsk => ({
  v: 1,
  customerId: 'cust-1',
  options: [
    { id: 'add_contact:yes', label: 'Add contact' },
    { id: 'add_contact:no', label: 'Ignore' },
  ],
});

interface Opts {
  parseTime?: (i: { text: string; meetingId: string }) => Promise<Date | null>;
  onTypedTime?: (id: string, at: Date, by: string) => Promise<boolean>;
}
function harness(opts: Opts = {}) {
  const booked: Array<{ id: string; at: Date; by: string }> = [];
  const posts: string[] = [];
  const parsed: Array<{ text: string; meetingId: string }> = [];
  const hook = buildMeetingFreeTextHook({
    parseTime: async (i) => {
      parsed.push(i);
      return opts.parseTime ? opts.parseTime(i) : new Date('2026-07-16T15:00:00-05:00');
    },
    onTypedTime: async (id, at, by) => {
      booked.push({ id, at, by });
      return opts.onTypedTime ? opts.onTypedTime(id, at, by) : true;
    },
    postAnswer: async (_t, text) => void posts.push(text),
  });
  const run = (text: string, pending = slotAsk()) => hook({ threadId: '9', text, by: 'founder', pending });
  return { run, booked, posts, parsed };
}

// ── Recognizing its own question ──────────────────────────────────────────────────────

test('the meeting id is read back out of our own option ids', () => {
  assert.equal(meetingIdFromOptions(slotAsk().options), MEETING);
  assert.equal(meetingIdFromOptions(contactAsk().options), null, "another feature's question is not ours");
  assert.equal(meetingIdFromOptions([]), null);
});

// This is the blast-radius guard: the hook widens ONE question, not every askFounder.
test('a non-meeting question is DECLINED untouched', async () => {
  const h = harness();
  assert.equal(await h.run('sure, go ahead', contactAsk()), 'declined');
  assert.deepEqual(h.booked, [], 'nothing booked');
  assert.deepEqual(h.posts, [], 'and the generic re-ask is left to say its piece');
  assert.deepEqual(h.parsed, [], 'we do not even spend an LLM call on it');
});

// ── The happy path ────────────────────────────────────────────────────────────────────

test('a typed time books the meeting and resolves the question', async () => {
  const h = harness();
  assert.equal(await h.run('thursday 3pm'), 'resolved');
  assert.equal(h.booked.length, 1);
  assert.equal(h.booked[0].id, MEETING, 'routed to the meeting the buttons belong to');
  assert.equal(h.booked[0].by, 'founder');
  assert.deepEqual(h.parsed, [{ text: 'thursday 3pm', meetingId: MEETING }]);
});

// ── The founder must be able to answer again ──────────────────────────────────────────

test('a time the scheduler REFUSES (busy/past) keeps the question armed', async () => {
  // onTypedTime returning false means it has already explained why — this hook must not
  // pile a second message on top, and must not disarm: the buttons are still the escape.
  const h = harness({ onTypedTime: async () => false });
  assert.equal(await h.run('thursday 3pm'), 'consumed');
  assert.deepEqual(h.posts, [], 'the scheduler owns that explanation');
});

test('a message with no time in it is explained, not guessed at', async () => {
  const h = harness({ parseTime: async () => null });
  assert.equal(await h.run('what do you think?'), 'consumed');
  assert.equal(h.booked.length, 0, 'NEVER guess a time — this books a real meeting');
  assert.match(h.posts[0], /did not catch a time/i);
  assert.match(h.posts[0], /thursday 3pm/i, 'shows the founder a shape that works');
});

// The parse is a network call. If it throws and the hook rethrows, the router logs and drops
// the update — the founder's message vanishes under a question they can still see.
test('a parse failure is reported and the question survives', async () => {
  const h = harness({
    parseTime: async () => {
      throw new Error('llm 503');
    },
  });
  assert.equal(await h.run('thursday 3pm'), 'consumed', 'never throws into the router');
  assert.equal(h.booked.length, 0);
  assert.match(h.posts[0], /could not read that/i);
  assert.match(h.posts[0], /tap a slot/i, 'points at the affordance that still works');
});

// ── Routing ───────────────────────────────────────────────────────────────────────────

test('the parsed instant reaches the scheduler unmodified', async () => {
  const at = new Date('2026-07-20T11:00:00-05:00');
  const h = harness({ parseTime: async () => at });
  await h.run('el lunes 11am');
  assert.equal(h.booked[0].at.toISOString(), at.toISOString());
});

test('a duration question is ours too — the id carries, whatever the option', async () => {
  const durationAsk: PendingAsk = {
    v: 1,
    customerId: 'cust-1',
    options: [
      { id: `md30:${MEETING}`, label: '30 min' },
      { id: `mtask:${MEETING}`, label: 'Just make a task' },
    ],
  };
  assert.equal(meetingIdFromOptions(durationAsk.options), MEETING);
  // onTypedTime itself refuses anything not awaiting_slot, so the stage check lives in one
  // place rather than being re-derived from the option shape here.
  const h = harness({ onTypedTime: async () => true });
  assert.equal(await h.run('thursday 3pm', durationAsk), 'resolved');
});
