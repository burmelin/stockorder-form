// Keeps the app on the phone so it opens instantly, even on a weak signal.
// - The app page: the saved copy opens straight away, and a fresh copy is fetched in the
//   background. When the fresh copy differs, the page is told so it can offer "Reload".
// - Icons and fonts: kept once, reused.
// - Data (the Apps Script server) is never touched here: stock and orders always come live,
//   and the app keeps its own saved copy of the last data it loaded.
var CACHE = 'burmelin-app-v1';
var APP_FILES = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
                 '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];

self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(APP_FILES); }).then(function() { return self.skipWaiting(); }));
});

self.addEventListener('activate', function(event) {
  event.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
  }).then(function() { return self.clients.claim(); }));
});

// Set when a newer page has been saved in the background. The open page may not be listening
// yet when that happens, so pages also ask ("hello") once they've loaded.
var updateWaiting = false;
function tellPages(message) {
  self.clients.matchAll({ type: 'window' }).then(function(list) { list.forEach(function(c) { c.postMessage(message); }); });
}
self.addEventListener('message', function(event) {
  if (event.data === 'hello' && updateWaiting && event.source) event.source.postMessage({ type: 'update-ready' });
});

// The app page: answer from the saved copy at once; refresh it in the background
function appPage(event) {
  return caches.open(CACHE).then(function(cache) {
    return cache.match('/').then(function(saved) {
      // Read the saved copy now: once it's handed to the browser its body can't be read again
      var savedText = saved ? saved.clone().text() : Promise.resolve(null);
      // By address: a navigation request can't be re-sent with options of its own
      var saving = Promise.resolve();
      var fresh = fetch(event.request.url, { cache: 'no-store', credentials: 'same-origin' }).then(function(res) {
        if (res.ok && (res.headers.get('content-type') || '').indexOf('text/html') > -1) {
          saving = Promise.all([res.clone().text(), savedText]).then(function(t) {
            if (t[0] === t[1]) { updateWaiting = false; return; }
            return cache.put('/', new Response(t[0], { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).then(function() {
              if (saved) { updateWaiting = true; tellPages({ type: 'update-ready' }); }
            });
          });
        }
        return res;
      });
      event.waitUntil(fresh.then(function() { return saving; }).catch(function() {}));
      return saved || fresh;
    });
  });
}

// Icons and fonts never change under the same address
function keptFile(request) {
  return caches.open(CACHE).then(function(cache) {
    return cache.match(request).then(function(saved) {
      return saved || fetch(request).then(function(res) {
        if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) event.respondWith(appPage(event));
    else if (url.pathname.indexOf('/icons/') === 0 || url.pathname === '/manifest.webmanifest') event.respondWith(keptFile(req));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(keptFile(req));
  }
});
