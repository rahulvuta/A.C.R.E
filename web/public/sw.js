/*
  A.C.R.E on a weak connection (card 20). After the first visit the app's own pages and code
  are kept on the device, so the app opens with the network off. Only files from this site are
  kept here: calls to the A.C.R.E service and map pictures always go to the network, and the
  page itself keeps the last results for each field.
*/
const CACHE = "acre-pages-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(["./", "./index.html"]).catch(() => undefined);
      // The build lists every file it made; keep them all so every step opens offline, not only the ones visited.
      try {
        const res = await fetch("./asset-manifest.json", { cache: "no-store" });
        if (res.ok) {
          const manifest = await res.json();
          const files = new Set();
          for (const entry of Object.values(manifest)) {
            if (entry.file) files.add("./" + entry.file);
            for (const f of entry.css || []) files.add("./" + f);
            for (const f of entry.assets || []) files.add("./" + f);
          }
          await Promise.all([...files].map((f) => cache.add(f).catch(() => undefined)));
        }
      } catch {
        /* a dev server has no list; files are kept as they are used */
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE && name.startsWith("acre-pages-")) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Opening the app: the newest page when there is a connection, the kept one when there is not.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put("./index.html", fresh.clone());
          return fresh;
        } catch {
          return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
        }
      })(),
    );
    return;
  }

  // The app's own files: the kept copy at once, refreshed in the background when the network answers.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const kept = await cache.match(req);
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return kept || (await fresh) || Response.error();
    })(),
  );
});
