/* Offline app shell. Bump CACHE whenever a shell file changes. */
const CACHE = 'pain-tracker-v51';
const FIREBASE_VERSION = '12.18.0';
const SHELL = ['.', 'index.html', 'styles.css?v=51', 'app.js?v=51', 'data.js?v=51',
  'sync-data.js?v=51', 'sync.js?v=51', 'firebase-config.js?v=51', 'manifest.webmanifest', 'icon.svg'];
const OPTIONAL = [
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-check.js`,
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' }))))
      .then(async () => {
        const cache = await caches.open(CACHE);
        await Promise.allSettled(OPTIONAL.map(async path => {
          const response = await fetch(new Request(path, { cache: 'reload', mode: 'cors' }));
          if (response.ok) await cache.put(path, response);
        }));
      })
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

// Only the app's own page is the offline copy. Other files opened directly under the app's address
// (robots.txt, the icon) must not replace it, or an offline launch would show that file instead of the app.
function isAppShell(url) {
  const scope = new URL(self.registration.scope);
  const { origin, pathname } = new URL(url);
  return origin === scope.origin && (pathname === scope.pathname || pathname === `${scope.pathname}index.html`);
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const firebaseModule = url.origin === 'https://www.gstatic.com'
    && url.pathname.startsWith(`/firebasejs/${FIREBASE_VERSION}/`);
  if (url.origin !== self.location.origin && !firebaseModule) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(new Request(request, { cache: 'reload' }))
      .then(async response => {
        if (response.ok && isAppShell(request.url)) await (await caches.open(CACHE)).put('index.html', response.clone());
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
  event.respondWith(caches.match(request).then(cached => cached || fresh.catch(() => Response.error())));
});
