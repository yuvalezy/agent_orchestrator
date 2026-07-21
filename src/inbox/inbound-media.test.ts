import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInboundScreenshots, type InboundMediaFetch } from './inbound-media';

// M-vision: the transient screenshot loader. It is best-effort by contract — every gate miss and
// every fetch failure yields [] so triage can always proceed text-only. Bytes are base64-encoded
// in place. The fetch is injected, so these tests never touch the network.

const GATE = { maxBytes: 5_000_000 };

// A downloaded image descriptor that clears every gate — each reject test overrides ONE field.
function okInput(over: Partial<Parameters<typeof loadInboundScreenshots>[0]> = {}) {
  return { ref: 'wa-101', mediaType: 'image', mimetype: 'image/png', status: 'downloaded', filesize: 42_000, ...over };
}

const bytesFetch: InboundMediaFetch = async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
function neverCalled(): InboundMediaFetch {
  return async () => {
    throw new Error('fetch must not be called on a gate miss');
  };
}

test('happy path: a downloaded image within the gate → one base64 LlmImage', async () => {
  const out = await loadInboundScreenshots(okInput(), bytesFetch, GATE);
  assert.equal(out.length, 1);
  assert.equal(out[0].mediaType, 'image/png');
  assert.equal(out[0].dataBase64, Buffer.from([1, 2, 3]).toString('base64'));
});

test('reject: mediaType is not an image → [] (never fetches)', async () => {
  assert.deepEqual(await loadInboundScreenshots(okInput({ mediaType: 'ptt' }), neverCalled(), GATE), []);
});

test('reject: mimetype not in the supported set → [] (never fetches)', async () => {
  assert.deepEqual(await loadInboundScreenshots(okInput({ mimetype: 'image/tiff' }), neverCalled(), GATE), []);
  assert.deepEqual(await loadInboundScreenshots(okInput({ mimetype: 'application/pdf' }), neverCalled(), GATE), []);
});

test('reject: status is not "downloaded" → [] (never fetches)', async () => {
  assert.deepEqual(await loadInboundScreenshots(okInput({ status: 'pending' }), neverCalled(), GATE), []);
  assert.deepEqual(await loadInboundScreenshots(okInput({ status: null }), neverCalled(), GATE), []);
});

test('reject: filesize over the gate → [] (never fetches)', async () => {
  assert.deepEqual(await loadInboundScreenshots(okInput({ filesize: 5_000_001 }), neverCalled(), GATE), []);
});

test('reject: filesize missing → [] (never fetches)', async () => {
  assert.deepEqual(await loadInboundScreenshots(okInput({ filesize: null }), neverCalled(), GATE), []);
  assert.deepEqual(await loadInboundScreenshots(okInput({ filesize: undefined }), neverCalled(), GATE), []);
});

test('accepts each supported image mimetype (jpeg/png/webp/gif) and is case-insensitive', async () => {
  for (const mt of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
    const out = await loadInboundScreenshots(okInput({ mimetype: mt }), bytesFetch, GATE);
    assert.equal(out.length, 1, `expected ${mt} to pass`);
  }
});

test('fetch error (throw) → [] (best-effort: triage proceeds text-only)', async () => {
  const throwing: InboundMediaFetch = async () => {
    throw new Error('whatsapp_manager 500');
  };
  assert.deepEqual(await loadInboundScreenshots(okInput(), throwing, GATE), []);
});

test('fetch returns null or empty bytes → [] (no image block)', async () => {
  assert.deepEqual(await loadInboundScreenshots(okInput(), async () => null, GATE), []);
  assert.deepEqual(
    await loadInboundScreenshots(okInput(), async () => ({ bytes: new Uint8Array(), contentType: 'image/png' }), GATE),
    [],
  );
});

test('reject: fetched bytes exceed the gate even when declared filesize is small', async () => {
  const oversized = new Uint8Array(GATE.maxBytes + 1);
  assert.deepEqual(
    await loadInboundScreenshots(okInput({ filesize: 1 }), async () => ({ bytes: oversized, contentType: 'image/png' }), GATE),
    [],
  );
});

test('reject: fetched content type is not a supported image even when metadata says image/png', async () => {
  assert.deepEqual(
    await loadInboundScreenshots(okInput(), async () => ({ bytes: new Uint8Array([1]), contentType: 'text/html' }), GATE),
    [],
  );
});

test('uses normalized fetched content type after independently validating it', async () => {
  const out = await loadInboundScreenshots(
    okInput({ mimetype: 'image/png' }),
    async () => ({ bytes: new Uint8Array([1]), contentType: 'IMAGE/JPEG; charset=binary' }),
    GATE,
  );
  assert.equal(out[0]?.mediaType, 'image/jpeg');
});
