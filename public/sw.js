/* Service worker: offline app shell + notification handling.
 *
 * The app shell is served NETWORK-FIRST: because this app normally runs against
 * its own local server, we always want the freshest HTML/CSS/JS on reload and
 * only fall back to the cache when offline. (A cache-first strategy previously
 * pinned users to a stale version until the cache name changed.) API requests
 * are never cached — they need the live, authenticated server. Note data is not
 * stored here; it stays encrypted on the server. */
'use strict';

const CACHE = 'meeting-notes-shell-v54';
const SHELL = [
  '/', '/index.html', '/manual.html',
  '/css/styles.css',
  '/js/api.js', '/js/editor.js', '/js/recorder.js', '/js/taskparse.js', '/js/app.js', '/js/manual.js',
  '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png',
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
  if (url.origin !== self.location.origin) return; // don't touch cross-origin
  // Network-first: fetch fresh, update the cache, fall back to cache offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((cached) => cached || caches.match('/index.html')))
  );
});

// Allow the page to raise notifications through the SW (more reliable when the
// tab is backgrounded). True closed-app push would require a push service.
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'notify' && self.registration.showNotification) {
    self.registration.showNotification(d.title || 'Reminder', { body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: d.tag });
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => {
    for (const c of cs) if ('focus' in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow('/');
  }));
});
