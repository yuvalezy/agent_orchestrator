import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutInlineKeyboard } from './keyboard-layout';

const opt = (label: string) => ({ id: `id-${label}`, label });
const labels = (rows: ReturnType<typeof layoutInlineKeyboard>) => rows.map((r) => r.map((b) => b.text));

// The regression this file exists for: the real meeting slot prompt rendered as
// "Thu 1…  Thu 1…  Fri 17 …  Fri 17 …  Just …" because all five shared one row.
test('the meeting slot prompt gives every slot a readable row', () => {
  const rows = layoutInlineKeyboard([
    opt('Thu 17 Jul 11:00'), opt('Thu 17 Jul 14:00'),
    opt('Fri 18 Jul 09:00'), opt('Fri 18 Jul 12:00'),
    opt('Just make a task'),
  ]);
  assert.deepEqual(labels(rows), [
    ['Thu 17 Jul 11:00'], ['Thu 17 Jul 14:00'],
    ['Fri 18 Jul 09:00'], ['Fri 18 Jul 12:00'],
    ['Just make a task'],
  ]);
});

// ...while the SAME function must not waste five rows on the duration prompt, whose labels
// are short. This is why the rule is a width budget and not a columns-per-row constant.
test('the duration prompt keeps its short options together, escape on its own row', () => {
  const rows = layoutInlineKeyboard([
    opt('15 min'), opt('30 min'), opt('45 min'), opt('60 min'), opt('Just make a task'),
  ]);
  assert.deepEqual(labels(rows), [['15 min', '30 min', '45 min', '60 min'], ['Just make a task']]);
});

test('a two-option question still renders as one row', () => {
  assert.deepEqual(labels(layoutInlineKeyboard([opt('Add contact'), opt('Ignore')])), [
    ['Add contact', 'Ignore'],
  ]);
});

test('caller order is preserved — the escape never migrates under the thumb', () => {
  const rows = layoutInlineKeyboard([opt('aa'), opt('bb'), opt('cc'), opt('dd'), opt('ee'), opt('ff')]);
  assert.deepEqual(rows.flat().map((b) => b.text), ['aa', 'bb', 'cc', 'dd', 'ee', 'ff']);
  assert.ok(rows.every((r) => r.length <= 4), 'never more than 4 buttons in a row');
});

test('a single over-budget label gets its own row rather than dragging a neighbour', () => {
  const rows = layoutInlineKeyboard([opt('short'), opt('a'.repeat(40)), opt('also short')]);
  assert.deepEqual(labels(rows), [['short'], ['a'.repeat(40)], ['also short']]);
});

test('callback_data is carried through untouched (it is the option id)', () => {
  const rows = layoutInlineKeyboard([{ id: 'ms0:abc-123', label: 'Thu 17 Jul 11:00' }]);
  assert.equal(rows[0][0].callback_data, 'ms0:abc-123');
});

test('no options yields no rows (never a row of nothing)', () => {
  assert.deepEqual(layoutInlineKeyboard([]), []);
});
