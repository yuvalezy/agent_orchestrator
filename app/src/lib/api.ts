export interface ApiError extends Error { status?: number }

// Same-origin, cookie-authenticated (httpOnly `ao_app_device`). Nothing to attach
// by hand — the device cookie rides along with credentials: 'include'.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`/app/api${path}`, { ...init, headers, credentials: 'include' });
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
