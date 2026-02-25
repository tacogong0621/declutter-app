const CACHE_NAME = 'declutter-v2.0';
const urlsToCache = [
  '/declutter-app/',
  '/declutter-app/index.html',
  '/declutter-app/manifest.json',
  '/declutter-app/icon-192.png',
  '/declutter-app/icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  // Network-first: always try to get fresh content, fall back to cache offline
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache a copy of the successful response
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});
