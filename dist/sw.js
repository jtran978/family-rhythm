const CACHE = 'family-rhythm-v18';
const SHELL = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Only cache the app's own files. Supabase data and photos always come fresh.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Always ask the server for the newest copy (skips the browser's 10-minute cache);
  // fall back to the saved copy when offline.
  event.respondWith(
    fetch(new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' }))
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data && event.data.text() }; }
  const title = payload.title || 'Casa Yuffie';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || 'A gentle check-in is waiting.',
    icon: './icon-512.png',
    badge: './icon-180.png',
    tag: payload.tag || 'family-rhythm',
    data: { url: payload.url || './' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.registration.scope)) { await client.focus(); return; }
    }
    await self.clients.openWindow(target);
  })());
});
