import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmailClient } from './gmail-client';
import { getProviderMetrics, resetProviderMetrics } from '../../observability/provider-metrics';

const CRED = JSON.stringify({ client_id: 'ci', client_secret: 'cs', refresh_token: 'rt' });
const NOW = 1_700_000_000_000;
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function msg(id: string, from: string) {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(NOW),
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: 's' }], body: { data: b64url(`body ${id}`) } },
  };
}

/** Route Gmail API calls by URL. `history` maps pageToken→response for pagination. */
function mockFetch(routes: {
  history?: Record<string, unknown>;
  profileHistoryId?: string;
  list?: string[];
  historyStatus?: number;
}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('oauth2.googleapis.com/token')) return res(200, { access_token: 'tok', expires_in: 3600 });
    if (u.includes('/profile')) return res(200, { historyId: routes.profileHistoryId ?? '1000' });
    if (u.includes('/history')) {
      if (routes.historyStatus === 404) return res(404, { error: 'expired' });
      const token = new URL(u).searchParams.get('pageToken') ?? '_';
      return res(200, routes.history?.[token] ?? { history: [], historyId: '1005' });
    }
    if (u.includes('/messages/') && u.includes('format=full')) {
      const id = u.split('/messages/')[1].split('?')[0];
      return res(200, msg(id, 'alice@example.com'));
    }
    if (u.includes('/messages?')) return res(200, { messages: (routes.list ?? []).map((id) => ({ id })) });
    return res(404, {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('incremental DRAINS all history pages before advancing (DA R51 note 1)', async () => {
  const { fetchImpl } = mockFetch({
    history: {
      _: { history: [{ messagesAdded: [{ message: { id: 'm1' } }] }], historyId: '1005', nextPageToken: 'p2' },
      p2: { history: [{ messagesAdded: [{ message: { id: 'm2' } }] }], historyId: '1005' }, // no nextPageToken
    },
  });
  const client = new GmailClient(() => CRED, () => NOW, fetchImpl);
  const { messages, nextCursor } = await client.listChanges(JSON.stringify({ historyId: '1000', lastPollMs: NOW - 1000 }));
  assert.deepEqual(messages.map((m) => m.id).sort(), ['m1', 'm2']); // BOTH pages, not page 1 only
  assert.equal(JSON.parse(nextCursor).historyId, '1005');
});

test('bootstrap (no cursor) captures the profile historyId + lists inbox', async () => {
  const { fetchImpl, calls } = mockFetch({ profileHistoryId: '2000', list: ['m1'] });
  const client = new GmailClient(() => CRED, () => NOW, fetchImpl);
  const { messages, nextCursor } = await client.listChanges(null);
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(nextCursor).historyId, '2000');
  // profile fetched BEFORE the message list (dup-safe overlap)
  assert.ok(calls.findIndex((c) => c.includes('/profile')) < calls.findIndex((c) => c.includes('/messages?')));
});

test('historyId 404 → re-bootstrap (no crash, no drop)', async () => {
  const { fetchImpl } = mockFetch({ historyStatus: 404, profileHistoryId: '3000', list: ['m9'] });
  const client = new GmailClient(() => CRED, () => NOW, fetchImpl);
  const { messages, nextCursor } = await client.listChanges(JSON.stringify({ historyId: '1', lastPollMs: NOW - 5000 }));
  assert.equal(messages[0].id, 'm9'); // recovered via bootstrap
  assert.equal(JSON.parse(nextCursor).historyId, '3000');
});

test('send builds a base64url RFC-822 with reply headers', async () => {
  let sentBody: { raw?: string; threadId?: string } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (String(url).includes('/token')) return res(200, { access_token: 't', expires_in: 3600 });
    sentBody = JSON.parse(String(init.body)) as { raw?: string; threadId?: string };
    return res(200, { id: 'sent-1' });
  }) as unknown as typeof fetch;
  const client = new GmailClient(() => CRED, () => NOW, fetchImpl);
  const out = await client.send({ to: 'x@y.com', subject: 'Re: hi', bodyText: 'reply', threadId: 'thr', inReplyTo: '<abc@x>' });
  assert.equal(out.messageId, 'sent-1');
  assert.equal(sentBody!.threadId, 'thr');
  const raw = Buffer.from(sentBody!.raw!, 'base64url').toString('utf8');
  assert.match(raw, /In-Reply-To: <abc@x>/);
  assert.match(raw, /To: x@y\.com/);
});

test('OAuth refresh has a bounded deadline and records the timeout', async () => {
  resetProviderMetrics();
  const fetchImpl = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as unknown as typeof fetch;
  const client = new GmailClient(() => CRED, () => NOW, fetchImpl, 5);

  await assert.rejects(() => client.listChanges(null), (err: unknown) => (err as Error).name === 'TimeoutError');
  assert.deepEqual(
    getProviderMetrics().map(({ provider, requests, timeouts }) => ({ provider, requests, timeouts })),
    [{ provider: 'google:gmail', requests: 3, timeouts: 3 }],
  );
});
