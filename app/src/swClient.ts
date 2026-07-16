// Both the app-shell and Firebase background push live in ONE worker (public/sw.js).
// A scope allows only one registration, so a second worker at '/app/' would evict the
// first — instead we register a single script and hand it the Firebase config on the
// registration URL's querystring. The config is persisted so a cold start (main.tsx)
// re-registers the same push-enabled worker without waiting for the settings screen.
const SW_CONFIG_KEY = 'ao_sw_config';

export function storedSwConfig(): string | null {
  return localStorage.getItem(SW_CONFIG_KEY);
}

export function setStoredSwConfig(encoded: string | null): void {
  if (encoded) localStorage.setItem(SW_CONFIG_KEY, encoded);
  else localStorage.removeItem(SW_CONFIG_KEY);
}

export function swUrl(encodedConfig: string | null): string {
  return encodedConfig ? `/app/sw.js?config=${encodedConfig}` : '/app/sw.js';
}

/** Register the single worker with whatever config is currently persisted. */
export function registerServiceWorker(encodedConfig: string | null = storedSwConfig()): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(swUrl(encodedConfig), { scope: '/app/' });
}
