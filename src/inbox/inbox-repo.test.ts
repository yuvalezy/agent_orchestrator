import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../db';

// Fixture test for the M2 group-flag extraction added to claimBatch's SELECT
// (inbox-repo.ts). claimBatch claims GLOBALLY (every pending inbound row), so
// invoking it here would race the other DB-backed test files that keep their own
// rows 'pending' (e.g. ingestion.test.ts). Instead we assert the EXACT extraction
// expressions against seeded raw_metadata fixtures — validating the
// ->'metadata'->>'flag'::boolean path for true / false / absent (→ null), which is
// the load-bearing part of the change. Skips cleanly with no DB.

const TAG = 'test-inboxflags-';
let instanceId: string;

async function dbReady(): Promise<boolean> {
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM channel_instances WHERE provider='whatsapp_manager' LIMIT 1`,
    );
    if (!rows[0]) return false;
    instanceId = rows[0].id;
    return true;
  } catch {
    return false;
  }
}

after(async () => {
  await query(`DELETE FROM agent_inbox WHERE channel_message_id LIKE '${TAG}%'`).catch(() => {});
  await closePool();
});

async function seedRaw(msgId: string, raw: unknown): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO agent_inbox (channel_instance_id, channel_message_id, channel_thread_id, sender_address, direction, body, received_at, status, raw_metadata)
     VALUES ($1, $2, '120363000000000123', '50761111111', 'inbound', 'hi', now(), 'processing', $3::jsonb) RETURNING id`,
    [instanceId, msgId, JSON.stringify(raw)],
  );
  return rows[0].id;
}

/** Mirrors claimBatch's SELECT extraction (inbox-repo.ts) verbatim. */
async function extractFlags(id: string): Promise<{ is_group: boolean | null; chat_muted: boolean | null; mentions_me: boolean | null }> {
  const { rows } = await query<{ is_group: boolean | null; chat_muted: boolean | null; mentions_me: boolean | null }>(
    `SELECT (c.raw_metadata->'metadata'->>'isGroup')::boolean   AS is_group,
            (c.raw_metadata->'metadata'->>'chatMuted')::boolean AS chat_muted,
            (c.raw_metadata->'metadata'->>'mentionsMe')::boolean AS mentions_me
       FROM agent_inbox c WHERE c.id = $1`,
    [id],
  );
  return rows[0];
}

test('group flags parse from raw_metadata->metadata: all true', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seedRaw(`${TAG}true`, { metadata: { isGroup: true, chatMuted: true, mentionsMe: true } });
  assert.deepEqual(await extractFlags(id), { is_group: true, chat_muted: true, mentions_me: true });
});

test('group flags parse from raw_metadata->metadata: all false', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seedRaw(`${TAG}false`, { metadata: { isGroup: false, chatMuted: false, mentionsMe: false } });
  assert.deepEqual(await extractFlags(id), { is_group: false, chat_muted: false, mentions_me: false });
});

test('group flags absent (backfill row, no metadata) → all null', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seedRaw(`${TAG}absent`, { message_id: 'x', body: 'hi' }); // no metadata key
  assert.deepEqual(await extractFlags(id), { is_group: null, chat_muted: null, mentions_me: null });
});

test('the skip case: group + muted, mention absent → true/true/null', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  // metadata present but mentionsMe omitted → the flag is null, which the triage
  // branch treats as "not mentioned" (row.mentions_me falsy) → skip.
  const id = await seedRaw(`${TAG}mixed`, { metadata: { isGroup: true, chatMuted: true } });
  assert.deepEqual(await extractFlags(id), { is_group: true, chat_muted: true, mentions_me: null });
});

// ── M-vision: mirror claimBatch's raw_metadata->'media' extraction (inbox-repo.ts) verbatim ──────
/** Mirrors claimBatch's media SELECT extraction (inbox-repo.ts) verbatim. */
async function extractMedia(id: string): Promise<{ media_type: string | null; media_mimetype: string | null; media_status: string | null; media_filesize: number | null }> {
  const { rows } = await query<{ media_type: string | null; media_mimetype: string | null; media_status: string | null; media_filesize: number | null }>(
    `SELECT c.raw_metadata->'media'->>'mediaType' AS media_type,
            c.raw_metadata->'media'->>'mimetype'  AS media_mimetype,
            c.raw_metadata->'media'->>'status'    AS media_status,
            (c.raw_metadata->'media'->>'filesize')::double precision AS media_filesize
       FROM agent_inbox c WHERE c.id = $1`,
    [id],
  );
  return rows[0];
}

test('media fields parse from raw_metadata->media (filesize is a real number, not a string)', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seedRaw(`${TAG}media`, { media: { mediaType: 'image', mimetype: 'image/png', status: 'downloaded', filesize: 48213 } });
  const m = await extractMedia(id);
  assert.deepEqual(m, { media_type: 'image', media_mimetype: 'image/png', media_status: 'downloaded', media_filesize: 48213 });
  assert.equal(typeof m.media_filesize, 'number'); // ::double precision → JS number (an int8 cast would be a string)
});

test('media absent (text-only / backfill row) → all media fields null', async (t) => {
  if (!(await dbReady())) return t.skip('no db');
  const id = await seedRaw(`${TAG}nomedia`, { metadata: { isGroup: false } }); // no media key
  assert.deepEqual(await extractMedia(id), { media_type: null, media_mimetype: null, media_status: null, media_filesize: null });
});
