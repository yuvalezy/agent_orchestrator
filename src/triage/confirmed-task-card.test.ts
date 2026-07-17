import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmedTaskCard } from './triage.service';

// The founder's complaint, pinned: the confirmed card used to read, in its entirety, "A task
// created from an earlier message is confirmed." — naming no task. These fix the shape that
// names it, and the degradations that must never blank the card out.

const INTENT = { suggestedTitle: 'Fix export', summary: 'Export fails', priority: 'high' };

test('names the task: mirrors the new-task card (customer: title + the quoted summary)', () => {
  assert.deepEqual(confirmedTaskCard(INTENT, 'Acme Co'), {
    title: '🆕 Task (confirmed) · high',
    body: 'Acme Co: Fix export\n“Export fails”',
  });
});

test('no recorded intent → the original generic wording, never a blank card', () => {
  assert.deepEqual(confirmedTaskCard(null, 'Acme Co'), {
    title: '🆕 Task (confirmed)',
    body: 'A task created from an earlier message is confirmed.',
  });
});

test('an intent with no title AND no summary is worth no more than the generic card', () => {
  assert.deepEqual(confirmedTaskCard({ suggestedTitle: '  ', summary: null, priority: 'low' }, 'Acme Co'), {
    title: '🆕 Task (confirmed)',
    body: 'A task created from an earlier message is confirmed.',
  });
});

test('unknown customer → the task is still named (the name is the dispensable half)', () => {
  assert.deepEqual(confirmedTaskCard(INTENT, null), {
    title: '🆕 Task (confirmed) · high',
    body: 'Fix export\n“Export fails”',
  });
});

test('no title → the summary carries the headline, and is not then repeated as a quote', () => {
  assert.deepEqual(confirmedTaskCard({ suggestedTitle: null, summary: 'Export fails', priority: null }, 'Acme Co'), {
    title: '🆕 Task (confirmed)',
    body: 'Acme Co: Export fails',
  });
});
