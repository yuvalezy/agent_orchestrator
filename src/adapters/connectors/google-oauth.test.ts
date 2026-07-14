import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleAuthUrl, clientFromGmailCred, exchangeGoogleCode, resolveConsoleGoogleClient, type FetchLike } from './google-oauth';
import { signOAuthState, verifyOAuthState } from './oauth-state';
import { CONNECTORS, connectorById } from './registry';

// Pure unit coverage for the Google OAuth client, the signed state, and the registry. No network:
// exchangeGoogleCode takes an injectable fetch; the rest are pure or use an injected resolver.

test('buildGoogleAuthUrl: correct consent params + offline/consent', () => {
  const url = new URL(
    buildGoogleAuthUrl({ clientId: 'cid', redirectUri: 'https://box/cb', scopes: ['a', 'b'], state: 'st' }),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://box/cb');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'a b');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'st');
});

test('exchangeGoogleCode: posts to the token endpoint and returns parsed JSON', async () => {
  let seenUrl = '';
  let seenBody = '';
  const fakeFetch: FetchLike = (async (input: unknown, init?: { body?: unknown }) => {
    seenUrl = String(input);
    seenBody = String(init?.body ?? '');
    return { ok: true, json: async () => ({ refresh_token: 'rt', access_token: 'at' }) } as unknown as Response;
  }) as FetchLike;
  const tok = await exchangeGoogleCode({ client: { clientId: 'cid', clientSecret: 'sec' }, code: 'code123', redirectUri: 'https://box/cb' }, fakeFetch);
  assert.equal(tok.refresh_token, 'rt');
  assert.equal(seenUrl, 'https://oauth2.googleapis.com/token');
  assert.match(seenBody, /grant_type=authorization_code/);
  assert.match(seenBody, /code=code123/);
});

test('oauth-state: round-trips the connector id, rejects tamper / expiry / wrong secret', () => {
  const secret = 'a'.repeat(32);
  const state = signOAuthState('gmail_work', secret);
  assert.equal(verifyOAuthState(state, secret), 'gmail_work');
  // tampered signature
  assert.equal(verifyOAuthState(state.slice(0, -2) + 'xy', secret), null);
  // wrong secret
  assert.equal(verifyOAuthState(state, 'b'.repeat(32)), null);
  // expired (now well past exp)
  assert.equal(verifyOAuthState(state, secret, Date.now() + 3_600_000), null);
  // malformed
  assert.equal(verifyOAuthState('garbage', secret), null);
});

test('clientFromGmailCred / resolveConsoleGoogleClient: parse blobs, prefer GOOGLE_OAUTH_CLIENT', () => {
  const gmailBlob = JSON.stringify({ client_id: 'g-id', client_secret: 'g-sec', refresh_token: 'rt' });
  const bootstrap = JSON.stringify({ client_id: 'boot-id', client_secret: 'boot-sec' });
  const resolveGmailOnly = (ref: string): string | undefined => (ref === 'GMAIL_WORK_OAUTH' ? gmailBlob : undefined);
  assert.deepEqual(clientFromGmailCred('any', resolveGmailOnly), { clientId: 'g-id', clientSecret: 'g-sec' });
  assert.deepEqual(resolveConsoleGoogleClient(resolveGmailOnly), { clientId: 'g-id', clientSecret: 'g-sec' });
  const resolveBoth = (ref: string): string | undefined => (ref === 'GOOGLE_OAUTH_CLIENT' ? bootstrap : gmailBlob);
  assert.deepEqual(resolveConsoleGoogleClient(resolveBoth), { clientId: 'boot-id', clientSecret: 'boot-sec' });
  assert.equal(resolveConsoleGoogleClient(() => undefined), undefined);
});

test('registry: ids unique, google connectors carry scopes, secrets do not', () => {
  const ids = CONNECTORS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of CONNECTORS) {
    if (c.kind === 'google-oauth') assert.ok(c.scopes && c.scopes.length > 0, `${c.id} needs scopes`);
    else assert.equal(c.scopes, undefined, `${c.id} is a secret and must not carry scopes`);
  }
  assert.equal(connectorById('gmail_work')?.credentialName, 'GMAIL_WORK_OAUTH');
  assert.equal(connectorById('nope'), undefined);
});
