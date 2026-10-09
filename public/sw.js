// Offline-cache: appens egne filer caches når de hentes, så appen virker uden net.
// Selve siden (og version.json) hentes altid frisk når der er net, så nye versioner slår igennem.
// Kald til Anthropic API (andet domæne) går altid direkte på nettet.
const CACHE = "pcb-fejlsoegning-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const fresh = req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/") || url.pathname.endsWith("version.json");
  event.respondWith(
    fetch(req, fresh ? { cache: "no-cache" } : undefined)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))),
  );
});
