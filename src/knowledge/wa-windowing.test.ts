import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowChat, type WaWindowMessage } from './wa-windowing';

const at = (min: number): Date => new Date(2026, 0, 1, 0, min, 0); // minute offsets on a fixed day
const msg = (min: number, body = 'hi'): WaWindowMessage => ({ from: 'c', body, at: at(min) });

const config = { idleGapMs: 30 * 60_000, maxPerWindow: 5 }; // 30-min idle gap

test('a continuous burst is one window', () => {
  const w = windowChat([msg(0), msg(5), msg(10)], config);
  assert.equal(w.length, 1);
  assert.equal(w[0].messages.length, 3);
  assert.equal(w[0].startAt.getTime(), at(0).getTime());
});

test('an idle gap beyond the threshold starts a new window', () => {
  const w = windowChat([msg(0), msg(5), msg(50), msg(52)], config); // 45-min gap before msg(50)
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.messages.length), [2, 2]);
});

test('a long unbroken burst is split at maxPerWindow', () => {
  const w = windowChat([0, 2, 4, 6, 8, 10, 12].map((m) => msg(m)), config); // 7 msgs, cap 5
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.messages.length), [5, 2]);
});

test('empty-body messages are dropped before windowing', () => {
  const w = windowChat([msg(0, '  '), msg(1, 'real'), msg(2, '')], config);
  assert.equal(w.length, 1);
  assert.equal(w[0].messages.length, 1);
  assert.equal(w[0].messages[0].body, 'real');
});

test('unsorted input is sorted by time', () => {
  const w = windowChat([msg(10), msg(0), msg(5)], config);
  assert.equal(w.length, 1);
  assert.deepEqual(
    w[0].messages.map((m) => m.at.getTime()),
    [at(0), at(5), at(10)].map((d) => d.getTime()),
  );
});

test('all-empty chat → no windows', () => {
  assert.equal(windowChat([msg(0, ''), msg(1, '   ')], config).length, 0);
});
