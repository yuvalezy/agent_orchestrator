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
