/* Offline app shell. Bump CACHE whenever a shell file changes. */
const CACHE = 'pain-tracker-v14';
const SHELL = ['.', 'index.html', 'styles.css', 'app.js', 'data.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('pain-tracker-') && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(new Request(request, { cache: 'reload' }))
      .then(async response => {
        if (response.ok) await (await caches.open(CACHE)).put('index.html', response.clone());
        return response;
      })
      .catch(() => caches.match('index.html')));
    return;
  }

  const fresh = fetch(new Request(request, { cache: 'reload' })).then(async response => {
    if (response.ok) await (await caches.open(CACHE)).put(request, response.clone());
    return response;
  });
  event.waitUntil(fresh.catch(() => {}));
  event.respondWith(caches.match(request).then(cached => cached || fresh));
});
