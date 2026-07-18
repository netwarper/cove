/* Service worker: offline app shell + notification handling.
 *
 * Caches the static app shell so the app opens offline. API requests are never
 * cached (they need the live, authenticated server). Note data is not stored
 * here — it stays encrypted on the server. */
'use strict';

const CACHE = 'meeting-notes-shell-v1';
const SHELL = [
  '/', '/index.html',
  '/css/styles.css',
  '/js/api.js', '/js/editor.js', '/js/app.js',
  '/manifest.webmanifest', '/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // live server only
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      // runtime-cache same-origin shell assets
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => cached))
  );
});

// Allow the page to raise notifications through the SW (more reliable when the
// tab is backgrounded). True closed-app push would require a push service.
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'notify' && self.registration.showNotification) {
    self.registration.showNotification(d.title || 'Reminder', { body: d.body || '', icon: '/icon.svg', tag: d.tag });
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow('/');
  }));
});
