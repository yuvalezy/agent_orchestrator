// One worker owns the '/app/' scope: app shell + background push (public/sw.js).
//
// The worker needs NO Firebase config. It handles the Push API natively, and the
// payload it renders is self-describing, so there is nothing to hand it at
// registration time — the page keeps the Firebase SDK solely to mint the token.
// (An earlier cut passed the config on the registration querystring; that made the
// worker's URL, and therefore its identity, depend on push being enabled.)
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' });
}

/**
 * Tell the worker this client is the INSTALLED app, not a browser tab.
 *
 * The Clients API has no display-mode field, so the worker's notificationclick handler would
 * otherwise focus whichever /app client it found first — which is how a notification tap ended
 * up in a Chrome tab while the installed PWA sat idle. Only standalone is worth reporting: a
 * tab says nothing, and silence is already the safe default on the worker side.
 */
export function reportDisplayMode(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!window.matchMedia('(display-mode: standalone)').matches) return;
  navigator.serviceWorker.controller?.postMessage({ type: 'client-mode', standalone: true });
}
