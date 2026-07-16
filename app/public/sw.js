/* Single service worker for the AO Founder PWA — one registration owns the '/app/'
 * scope, so the app shell and Firebase background push MUST live together here.
 *
 * App shell:
 *   - navigations: network-first, falling back to the cached shell / offline page
 *   - /app/api:    network-first, never cached (SSE + auth state stay live)
 *   - hashed build assets: cache-first (immutable, content-hashed filenames)
 *
 * Push: the page registers this script as `/app/sw.js?config=<base64 JSON>` once the
 * founder enables notifications (see swClient.ts / push.ts). The Firebase compat SDK
 * is only pulled in when that config is present, so a push-less install (and offline
 * boot) never depends on the gstatic network fetch. Keep the compat version roughly
 * in step with the `firebase` npm version the page bundles. */
const CACHE = 'ao-founder-shell-v2';
const SHELL = ['/app/', '/app/index.html', '/app/offline.html', '/app/manifest.webmanifest', '/app/icon.svg'];

// ── Firebase background push (only when a config rides in on the querystring) ──────────
function readConfig() {
  try {
    const raw = new URL(self.location.href).searchParams.get('config');
    return raw ? JSON.parse(atob(raw)) : null;
  } catch (err) {
    return null;
  }
}

const fcmConfig = readConfig();
if (fcmConfig && fcmConfig.apiKey) {
  try {
    importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
    firebase.initializeApp(fcmConfig);
    // Payloads are data-only, so this handler owns display (no double notification).
    firebase.messaging().onBackgroundMessage((payload) => {
      const data = payload.data || {};
      const notification = payload.notification || {};
      const title = notification.title || data.title || 'AO Founder';
      const body = notification.body || data.body || 'New update from your assistant.';
      const tag = payload.collapseKey || data.tag || 'ao-founder';
      // Deep link: '/app/customer/<id>' or '/app/attention' (must stay inside /app).
      const route = typeof data.route === 'string' && data.route.startsWith('/app') ? data.route : '/app/';
      self.registration.showNotification(title, {
        body,
        tag,
        renotify: false,
        icon: '/app/icon.svg',
        badge: '/app/icon.svg',
        data: { url: route },
      });
    });
  } catch (err) {
    // Offline or gstatic blocked at eval time: the app shell below still installs, and
    // push resumes on the next online activation of this same worker.
  }
}

// ── App shell ─────────────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('ao-founder-shell-')).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return;
  // Never let the worker serve a cached copy of itself — the browser updates it out of band.
  if (url.pathname === '/app/sw.js') return;

  // Live data and the event stream are never served from cache.
  if (url.pathname.startsWith('/app/api')) {
    event.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } })));
    return;
  }

  // App navigations: try the network, keep the shell fresh, fall back offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => { void caches.open(CACHE).then((cache) => cache.put('/app/index.html', response.clone())); return response; })
        .catch(() => caches.match('/app/index.html').then((cached) => cached ?? caches.match('/app/offline.html')).then((res) => res ?? Response.error())),
    );
    return;
  }

  // Content-hashed assets and other shell files: cache-first.
  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match('/app/offline.html').then((res) => res ?? Response.error()))),
  );
});

// ── Notification click (harmless when push is inactive) ────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/app/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((client) => client.url.includes('/app'));
      if (existing) {
        // Focus the running app and let it route in-place (SPA nav), no reload.
        existing.postMessage({ type: 'navigate', route: target });
        return existing.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
