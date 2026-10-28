// Offline support. The app's own code (page, scripts, styles) is network-first so a release shows up on the next open,
// with the cached copy used offline. Vendor files and icons are cache-first. Food lookups and AI calls always go to the network.
const CACHE = "ledger-v23";
const SHELL = ["./", "./index.html", "./css/app.css", "./js/app.js", "./js/core.js", "./js/ai.js", "./manifest.webmanifest",
  "./vendor/zxing-wasm-reader-3.1.4.js", "./vendor/zxing_reader.wasm", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./data/livsmedel.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
const put = (req, res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; };
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/tests/")) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then(r => put(new Request("./index.html"), r)).catch(() => caches.match("./index.html")));
    return;
  }
  if (/\/(js|css)\/[^/]+$/.test(url.pathname) || url.pathname.endsWith("manifest.webmanifest")) {
    e.respondWith(fetch(e.request, {cache: "no-cache"}).then(r => put(e.request, r)).catch(() => caches.match(e.request)));
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
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => put(e.request, r))));
});
