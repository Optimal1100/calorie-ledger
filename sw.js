// Offline support: the app shell is cached; food lookups and AI calls always go to the network.
const CACHE = "ledger-v18";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./vendor/zxing-wasm-reader-3.1.4.js", "./vendor/zxing_reader.wasm",
  "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./data/livsmedel.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (e.request.mode === "navigate") {
    // Network first so updates show up; fall back to the cached page offline.
    e.respondWith(fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)); return r; })
      .catch(() => caches.match("./index.html")));
    return;
  }
  // Bundled food data refreshes weekly: answer from the cache straight away and fetch a fresh copy for next time.
  if (url.pathname.includes("/data/")) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      const fresh = fetch(e.request, {cache: "no-cache"}).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    }));
    return;
  }
  // Everything else from this site (scripts, icons, the bundled food and barcode data): cache first, and keep what gets fetched.
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  })));
});
