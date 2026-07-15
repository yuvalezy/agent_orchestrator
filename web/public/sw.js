// Notification-only worker. It intentionally handles NO fetch events and keeps NO
// cache: installable/offline PWA support is deferred, while push delivery still
// needs a same-origin service worker.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('ao-console-shell-')).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
));
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* ignore malformed payload */ }
  const route = typeof data.route === 'string' && data.route.startsWith('/console') ? data.route : '/console/';
  const tag = typeof data.tag === 'string' ? data.tag : 'founder-console';
  event.waitUntil(self.registration.showNotification('Founder attention needed', {
    body: 'Open the private console to review.', tag, data: { route }, renotify: false,
  }));
});
self.addEventListener('notificationclick', (event) => {
  const route = typeof event.notification.data?.route === 'string' ? event.notification.data.route : '/console/';
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).pathname.startsWith('/console'));
    return existing ? existing.focus().then(() => existing.navigate(route)) : clients.openWindow(route);
  }));
});
