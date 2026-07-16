import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiError } from './api';

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('prefixes the /app/api base path and sends the device cookie', async () => {
    const fetchMock = mockFetch(jsonResponse({ data: [] }));

    await expect(api('/messages')).resolves.toEqual({ data: [] });
    expect(fetchMock.mock.calls[0][0]).toBe('/app/api/messages');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
  });

  it('sets a json content-type only when there is a body', async () => {
    const fetchMock = mockFetch(jsonResponse({ data: {} }));
    await api('/decisions', { method: 'POST', body: JSON.stringify({ messageId: 'm', optionId: 'o' }) });
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get('content-type')).toBe('application/json');
  });

  it('resolves undefined for 204 responses', async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(api('/push/register', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('resolves for an empty 2xx body instead of throwing on JSON.parse (login 201)', async () => {
    mockFetch(new Response('', { status: 201 }));
    await expect(api('/login', { method: 'POST', body: JSON.stringify({ password: 'x', label: 'y' }) })).resolves.toBeUndefined();
  });

  it('throws the server error message with the status attached', async () => {
    mockFetch(jsonResponse({ error: 'bad password' }, 401));
    const error = (await api('/login', { method: 'POST' }).catch((e: ApiError) => e)) as ApiError;
    expect(error.message).toBe('bad password');
    expect(error.status).toBe(401);
  });

  it('broadcasts app:unauthorized on a 401 so the shell can re-gate', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 401));
    const onUnauthorized = vi.fn();
    window.addEventListener('app:unauthorized', onUnauthorized);
    await expect(api('/messages')).rejects.toThrow('nope');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    window.removeEventListener('app:unauthorized', onUnauthorized);
  });
});
