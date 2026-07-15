import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUrgencyInboxSql } from './console-urgency-repo';

test('urgency inbox freezes score time in the cursor and ranks by safe state, age, and retries', () => {
  const { text, values } = buildUrgencyInboxSql({ asOf: '2026-07-14T00:00:00.000Z', cursor: null, limit: 25 });
  assert.match(text, /WHEN 'failed' THEN 1000 WHEN 'pending' THEN 500 ELSE 200/);
  assert.match(text, /LEAST\(72/);
  assert.match(text, /LEAST\(20, i.retry_count \* 5\)/);
  assert.match(text, /i\.status IN \('failed', 'pending', 'processing'\)/);
  assert.match(text, /ORDER BY urgency_score DESC, created_at DESC, id DESC/);
  assert.deepEqual(values, ['2026-07-14T00:00:00.000Z', null, null, null, 26]);
});

test('urgency cursor carries its original snapshot and strict deterministic tie-break', () => {
  const cursor = { asOf: '2026-07-14T00:00:00.000Z', score: 512, at: '2026-07-13T00:00:00.000000Z', id: '42' };
  const { text, values } = buildUrgencyInboxSql({ asOf: cursor.asOf, cursor, limit: 10 });
  assert.match(text, /urgency_score.*created_at DESC, id DESC/s);
  assert.match(text, /< \(\$2::int, \$3::timestamptz, \$4::bigint\)/);
  assert.deepEqual(values, [cursor.asOf, 512, cursor.at, '42', 11]);
});
