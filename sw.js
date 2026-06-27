/* AM Express · Rotas — Service Worker
   Estratégia:
   - App shell + libs de CDN: cache-first (funciona offline depois da 1ª carga).
   - Tiles do mapa (OSM), geocoding (Nominatim) e navegação (Google Maps):
     NUNCA cacheia. São dados ao vivo / pesados / com regras de uso próprias.
*/
const CACHE = "amx-rotas-v4";

// App shell local
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./modules/storage.js",
  "./modules/geo.js",
  "./modules/route.js",
  "./modules/csv.js",
  "./modules/scanner.js",
  "./modules/ocr.js",
  "./modules/auth.js",
  "./modules/history.js",
  "./modules/directions.js",
  "./manifest.webmanifest",
  "./assets/logo.png",
  "./assets/logo-branca.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png",
  "./assets/favicon.png",
];

// Libs de CDN que o app precisa pra rodar (mesmas versões do index.html)
const CDN = [
  "https://unpkg.com/preact@10.22.1/dist/preact.umd.js",
  "https://unpkg.com/preact@10.22.1/hooks/dist/hooks.umd.js",
  "https://unpkg.com/htm@3.1.1/dist/htm.umd.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
];

// Domínios que JAMAIS devem ser cacheados (dados ao vivo / autenticados)
const NEVER_CACHE = [
  "/api/",
  "api.mapbox.com",
  "tile.openstreetmap.org",
  "nominatim.openstreetmap.org",
  "google.com/maps",
  "maps.google.com",
  "api.whatsapp.com",
  "wa.me",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Shell é obrigatório; CDN tenta cachear mas não quebra o install se falhar.
      await cache.addAll(SHELL);
      await Promise.allSettled(CDN.map((u) => cache.add(u)));
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Nunca interferir em dados ao vivo (mapa, geocoding, navegação)
  if (NEVER_CACHE.some((d) => url.host.includes(d) || url.href.includes(d))) {
    return; // deixa a rede cuidar
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Cacheia respostas boas do próprio app e das libs de CDN
        if (
          res &&
          res.status === 200 &&
          (url.origin === self.location.origin || CDN.includes(req.url))
        ) {
          const copy = res.clone();
          const cache = await caches.open(CACHE);
          cache.put(req, copy);
        }
        return res;
      } catch (e) {
        // Offline e sem cache: pra navegação, devolve o index (SPA)
        if (req.mode === "navigate") {
          const fallback = await caches.match("./index.html");
          if (fallback) return fallback;
        }
        throw e;
      }
    })()
  );
});
