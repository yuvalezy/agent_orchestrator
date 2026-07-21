/* Single service worker for the AO Founder PWA — one registration owns the '/app/'
 * scope, so the app shell and background push MUST live together here.
 *
 * App shell:
 *   - navigations: network-first, falling back to the cached shell / offline page
 *   - /app/api:    network-first, never cached (SSE + auth state stay live)
 *   - hashed build assets: cache-first (immutable, content-hashed filenames)
 *
 * Push: handled natively off the Push API — NO Firebase SDK in this worker. FCM is
 * only a relay; what arrives here is a plain push event whose data is the envelope
 * fcm-sender.ts sent. The page still uses the Firebase SDK to MINT the token
 * (getToken needs it); the worker only has to render what arrives, which is
 * ~15 lines. See the commit message for the three separate bugs the SDK-in-worker
 * arrangement cost us. */
const CACHE = 'ao-founder-shell-v5';
// icon-192.png is precached because a notification must render while offline, and
// Android will not rasterize an SVG for a notification icon.
const SHELL = ['/app/', '/app/index.html', '/app/offline.html', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-192.png'];

// ── Which clients are the INSTALLED app? ──────────────────────────────────────────────
// The Clients API exposes no display mode, so a standalone PWA window and a plain browser
// tab are indistinguishable here — and focusing the tab is exactly the bug (a notification
// tap landed in Chrome instead of the installed app). The page reports its own display
// mode (swClient.ts → {type:'client-mode'}) and we remember the ids that said "standalone".
//
// It has to be PERSISTED: a push wakes a FRESH worker, so anything in module scope is gone
// by the time the notification is clicked. The shell cache is already open on every event,
// so it doubles as the store rather than dragging in IndexedDB for one Set of strings.
const CLIENTS_KEY = '/app/__standalone-clients';

async function standaloneIds() {
  try {
    const cache = await caches.open(CACHE);
    const stored = await cache.match(CLIENTS_KEY);
    if (!stored) return [];
    const ids = await stored.json();
    return Array.isArray(ids) ? ids : [];
  } catch (err) {
    return [];
  }
}

/** Record `id` as standalone, dropping any id that no longer has a live window (self-pruning). */
async function rememberStandalone(id) {
  const live = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const liveIds = new Set(live.map((client) => client.id));
  const kept = (await standaloneIds()).filter((known) => liveIds.has(known));
  if (!kept.includes(id)) kept.push(id);
  const cache = await caches.open(CACHE);
  await cache.put(CLIENTS_KEY, new Response(JSON.stringify(kept), { headers: { 'content-type': 'application/json' } }));
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'client-mode' || !data.standalone) return;
  const id = event.source && event.source.id;
  if (id) event.waitUntil(rememberStandalone(id));
});

// ── Background push ───────────────────────────────────────────────────────────────────
/** Does the founder currently have the APP itself on screen? */
async function appIsOnScreen() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((client) => {
    if (client.visibilityState !== 'visible') return false;
    try { return new URL(client.url).pathname.startsWith('/app'); } catch (err) { return false; }
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // Payloads are data-only (fcm-sender.ts), and deliberately generic: a severity-driven
    // title, "Tap to open", and a route. No customer content ever transits the relay, so
    // there is nothing here to leak into a notification.
    let data = {};
    try { data = (event.data ? event.data.json() : {}).data || {}; } catch (err) { data = {}; }

    // Suppress only when the APP is visible — the SSE feed already updates an open app
    // live, so a notification would duplicate what the founder is looking at. Scoped to
    // /app clients on purpose: the Firebase SDK suppressed on ANY visible window of the
    // ORIGIN, so an open console tab silently swallowed every push, with no signal.
    if (await appIsOnScreen()) return;

    const route = typeof data.route === 'string' && data.route.startsWith('/app') ? data.route : '/app/';
    await self.registration.showNotification(data.title || 'AO Founder', {
      body: data.body || 'New update from your assistant.',
      tag: data.tag || 'ao-founder',
      renotify: false,
      // PNG, not the SVG: Android silently falls back to a generic bell rather than
      // rasterize an SVG here, so the notification would arrive unbranded.
      icon: '/app/icon-192.png',
      badge: '/app/icon-192.png',
      // A founder-attention alert that auto-dismisses while they are away is an alert
      // they never got; Telegram's would still be waiting for them.
      requireInteraction: data.severity === 'warning',
      data: { url: route },
    });
  })());
});

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
// Order matters, and it is the opposite of the obvious one: the INSTALLED app wins over any
// client we happen to find. Focusing whatever /app client existed first is what dropped the
// founder into a Chrome tab. openWindow gets an ABSOLUTE, in-scope URL — that resolved URL is
// what Chrome matches against the installed app's scope to launch the PWA instead of a tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.url) || '/app/';
  const target = new URL(route, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const known = new Set(await standaloneIds());

    // The installed app is already running: focus it and let it route in-place (SPA nav, no reload).
    const installed = windows.find((client) => known.has(client.id));
    if (installed) {
      installed.postMessage({ type: 'navigate', route });
      return installed.focus();
    }

    // Nothing installed on screen: ask the browser to open it, which launches the PWA when the
    // URL is in the installed scope. Only if that is refused do we settle for an existing tab.
    const opened = await self.clients.openWindow(target);
    if (opened) return opened;

    const tab = windows.find((client) => client.url.includes('/app'));
    if (tab) {
      tab.postMessage({ type: 'navigate', route });
      return tab.focus();
    }
    return undefined;
  })());
});
