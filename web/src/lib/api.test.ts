import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken, type ApiError } from './api';

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function headersOf(fetchMock: ReturnType<typeof vi.fn>): Headers {
  return (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers;
}

// csrfToken is module-level state that survives between tests.
beforeEach(() => setCsrfToken(null));
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('prefixes the console api base path and sends cookies', async () => {
    const fetchMock = mockFetch(jsonResponse({ data: { ok: true } }));

    await expect(api('/settings')).resolves.toEqual({ data: { ok: true } });
    expect(fetchMock.mock.calls[0][0]).toBe('/console/api/settings');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
  });

  it('attaches the csrf header to mutating requests once a token is set', async () => {
    setCsrfToken('token-abc');
    const fetchMock = mockFetch(jsonResponse({ data: {} }));

    await api('/settings/foo', { method: 'PUT', body: JSON.stringify({ value: 1 }) });

    const headers = headersOf(fetchMock);
    expect(headers.get('x-console-csrf')).toBe('token-abc');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('omits the csrf header on reads even when a token is set', async () => {
    setCsrfToken('token-abc');
    const fetchMock = mockFetch(jsonResponse({ data: {} }));

    await api('/settings', { method: 'GET' });

    expect(headersOf(fetchMock).get('x-console-csrf')).toBeNull();
  });

  it('resolves undefined for 204 responses instead of parsing a body', async () => {
    mockFetch(new Response(null, { status: 204 }));

    await expect(api('/push/subscription', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('throws the server error message with the status attached', async () => {
    mockFetch(jsonResponse({ error: 'value out of range' }, 400));

    const error = (await api('/settings/foo', { method: 'PUT' }).catch((e: ApiError) => e)) as ApiError;
    expect(error.message).toBe('value out of range');
    expect(error.status).toBe(400);
  });

  it('falls back to a generic message when the error body is not json', async () => {
    mockFetch(new Response('<html>502</html>', { status: 502 }));

    await expect(api('/settings')).rejects.toThrow('Request failed');
  });

  it('broadcasts console:unauthorized on a 401 so the shell can re-auth', async () => {
    mockFetch(jsonResponse({ error: 'nope' }, 401));
    const onUnauthorized = vi.fn();
    window.addEventListener('console:unauthorized', onUnauthorized);

    await expect(api('/settings')).rejects.toThrow('nope');
    expect(onUnauthorized).toHaveBeenCalledOnce();

    window.removeEventListener('console:unauthorized', onUnauthorized);
  });
});
