export interface ApiError extends Error { status?: number }

let csrfToken: string | null = null;

export function setCsrfToken(value: string | null): void {
  csrfToken = value;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && !['GET', 'HEAD'].includes(init.method) && csrfToken) headers.set('x-console-csrf', csrfToken);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await fetch(`/console/api${path}`, { ...init, headers, credentials: 'include' });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('console:unauthorized'));
    const body = await response.json().catch(() => ({})) as { error?: string };
    const error = new Error(body.error ?? 'Request failed') as ApiError;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
