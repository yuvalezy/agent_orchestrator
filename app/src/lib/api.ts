export interface ApiError extends Error { status?: number }

// Same-origin, cookie-authenticated (httpOnly `ao_app_device`). Nothing to attach
// by hand — the device cookie rides along with credentials: 'include'.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`/app/api${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    // A dead network rejects with a bare TypeError('Failed to fetch'), which surfaced verbatim
    // in the UI. It is a state the app reaches easily and looks alive in: the worker serves the
    // shell from cache, so the login screen renders perfectly on a phone that is off the tailnet,
    // and only the first API call reveals there is no server on the other end.
    const offline = new Error('Can\'t reach the server. Check that this device is on the tailnet (Tailscale connected), then try again.') as ApiError;
    offline.status = 0;
    throw offline;
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('app:unauthorized'));
    const body = await response.json().catch(() => ({})) as { error?: string };
    const error = new Error(body.error ?? 'Request failed') as ApiError;
    error.status = response.status;
    throw error;
  }
  // Tolerate empty 2xx bodies — login answers 201, logout/push answer 204, none
  // of which are guaranteed to carry JSON.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
