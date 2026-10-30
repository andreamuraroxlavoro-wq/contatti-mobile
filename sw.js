/* CONTATTI MOBILE — service worker: tiene in cache l'app e la libreria della mappa per l'uso offline; i dati stanno in IndexedDB */
var CACHE = 'cm-v31';
var FILES = ['./', './index.html', './icona-512-v2.png', './icona-192-v2.png', './apple-touch-icon-v2.png', './favicon-v2.png', './lib/leaflet.js', './lib/leaflet.css'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return Promise.allSettled(FILES.map(function (f) { return c.add(f); })); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  var u = e.request.url;
  if (e.request.method !== 'GET' || /googleapis|accounts\.google|tile\.openstreetmap/.test(u)) return;
  if (new URL(u).origin === location.origin) {
    /* rete prima (così gli aggiornamenti dell'app arrivano subito), cache se offline */
    e.respondWith(fetch(e.request, { cache: 'no-store' }).then(function (res) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, cp); }); return res; }).catch(function () { return caches.match(e.request).then(function (r) { return r || caches.match('./index.html'); }); }));
  }
});
