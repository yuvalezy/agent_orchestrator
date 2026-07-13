const CACHE = 'ao-console-shell-v1';
const SHELL = ['/console/', '/console/manifest.webmanifest', '/console/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/console/api/')) return;
  if (url.pathname === '/console/' || url.pathname.startsWith('/console/assets/') || url.pathname === '/console/manifest.webmanifest' || url.pathname === '/console/icon.svg') {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    })));
  }
});
