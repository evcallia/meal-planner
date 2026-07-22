// Web Push handlers, pulled into the generated service worker via workbox
// importScripts (vite.config.ts). Payloads come from backend/app/push.py as
// JSON: { title, body, tag, url }.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall back to defaults
  }
  const title = data.title || 'Meal Planner';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      // Same-tag notifications replace each other, so a burst of edits
      // collapses into one entry in the tray.
      tag: data.tag || 'meal-planner',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
