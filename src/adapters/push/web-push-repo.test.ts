import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';
import { closePool, query } from '../../db';
import { listAllPushSubscriptions, parsePushSubscription } from './web-push-repo';

const valid = { endpoint: 'https://fcm.googleapis.com/fcm/send/subscription', keys: { p256dh: 'public-key', auth: 'auth-key' } };

test('push subscription parser accepts the standard browser shape only', () => {
  assert.deepEqual(parsePushSubscription(valid), valid);
  assert.equal(parsePushSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys: valid.keys }), null);
  assert.equal(parsePushSubscription({ endpoint: 'https://127.0.0.1/x', keys: valid.keys }), null);
  assert.equal(parsePushSubscription({ endpoint: valid.endpoint, keys: { p256dh: '', auth: 'x' } }), null);
  assert.equal(parsePushSubscription({ endpoint: valid.endpoint }), null);
});

// ── Console subscribers admin repo (founder_push_subscriptions) ────────────────────────

const createdSubs: string[] = [];

async function subsMigrated(): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'founder_push_subscriptions' AND column_name = 'endpoint_hash'`,
  ).catch(() => null);
  return Boolean(res?.rows[0]);
}

async function seedSub(opts: { disabled?: boolean; failureCount?: number; lastFailureKind?: string | null } = {}): Promise<{ id: string; prefix: string }> {
  const hash = crypto.createHash('sha256').update(`sub-${Math.random()}-${Date.now()}`).digest('hex');
  const { rows } = await query<{ id: string }>(
    `INSERT INTO founder_push_subscriptions (endpoint_hash, founder_actor, ciphertext, iv, auth_tag, disabled_at, failure_count, last_failure_kind)
     VALUES ($1, 'founder', decode($2,'hex'), decode($3,'hex'), decode($4,'hex'), $5, $6, $7)
     RETURNING id::text`,
    [
      hash,
      '00'.repeat(12),
      '00'.repeat(12),
      '00'.repeat(16),
      opts.disabled ? new Date().toISOString() : null,
      opts.failureCount ?? 0,
      opts.lastFailureKind ?? null,
    ],
  );
  createdSubs.push(rows[0].id);
  // The list query computes encode(substring(endpoint_hash::bytea from 1 for 6), 'hex') —
  // the hex encoding of the first 6 ASCII bytes of the hash TEXT (not the first 6 hex chars
  // decoded). Mirror that here so the assertion compares like-for-like.
  const prefix = Buffer.from(hash.slice(0, 6), 'utf8').toString('hex');
  return { id: rows[0].id, prefix };
}

after(async () => {
  if (createdSubs.length > 0) {
    await query('DELETE FROM founder_push_subscriptions WHERE id = ANY($1::bigint[])', [createdSubs]).catch(() => {});
  }
  await closePool();
});

test('listAllPushSubscriptions returns active + disabled, never decrypts and never leaks endpoint payloads', async (t) => {
  if (!(await subsMigrated())) return t.skip('migration 029 not applied to this database');
  const active = await seedSub({ failureCount: 0 });
  const disabled = await seedSub({ disabled: true, failureCount: 4, lastFailureKind: 'gone' });

  const rows = await listAllPushSubscriptions();
  const activeRow = rows.find((r) => r.id === active.id);
  const disabledRow = rows.find((r) => r.id === disabled.id);
  assert.ok(activeRow, 'active row is listed');
  assert.ok(disabledRow, 'disabled row is listed');
  assert.equal(activeRow!.disabledAt, null);
  assert.equal(disabledRow!.disabledAt && typeof disabledRow!.disabledAt, 'string');
  assert.equal(disabledRow!.failureCount, 4);
  assert.equal(disabledRow!.lastFailureKind, 'gone');

  // The endpoint_prefix is exactly the 12-char hex of the first 6 bytes of endpoint_hash.
  assert.equal(activeRow!.endpointPrefix, active.prefix);
  assert.match(activeRow!.endpointPrefix, /^[0-9a-f]{12}$/);

  // The list NEVER decrypts and never returns ciphertext/iv/auth_tag bytes or any endpoint URL.
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes('ciphertext'), false);
  assert.equal(serialized.includes('auth_tag'), false);
  assert.equal(serialized.includes('"iv"'), false);
  assert.equal(serialized.includes('fcm.googleapis.com'), false);
  assert.equal(serialized.includes('p256dh'), false);
});
