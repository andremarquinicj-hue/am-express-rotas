// geo.js — distância, parsing de coordenadas e geocodificação (Mapbox Geocoding v6)
const GEO_CACHE_KEY = "amx:geocache:v1";

function loadCache() {
  try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || "{}"); } catch { return {}; }
}
function saveCache(c) {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(c)); } catch {}
}

// Distância em km (Haversine)
export function haversine(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// "-21.25, -48.32" -> {lat,lng}
export function parseLatLng(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(-?\d{1,3}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1].replace(",", "."));
  const lng = parseFloat(m[2].replace(",", "."));
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Geocodifica um endereço usando a Mapbox Geocoding API v6 (forward).
// token: chave (access_token) do Mapbox. proximity: {lat,lng} opcional p/ enviesar perto do galpão.
export async function geocodeOne(address, token = "", proximity = null) {
  const q = String(address || "").trim();
  if (!q) return null;
  if (!token) throw new Error("Configure a chave do Mapbox nas Configurações.");

  const cache = loadCache();
  const ck = q.toLowerCase();
  if (cache[ck]) return cache[ck];

  const params = new URLSearchParams({
    q,
    access_token: token,
    country: "br",
    language: "pt",
    limit: "1",
    types: "address,street,place,postcode,locality,neighborhood",
  });
  if (proximity && proximity.lng != null && proximity.lat != null) {
    params.set("proximity", `${proximity.lng},${proximity.lat}`);
  }

  const url = `https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 401) throw new Error("Chave do Mapbox inválida (401).");
  if (!res.ok) throw new Error("geocode http " + res.status);
  const data = await res.json();
  const f = data && data.features && data.features[0];
  if (!f) return null;
  // v6: properties.coordinates {longitude,latitude}; fallback geometry.coordinates [lng,lat]
  const c = f.properties?.coordinates;
  const g = f.geometry?.coordinates;
  const lat = c?.latitude ?? (Array.isArray(g) ? g[1] : null);
  const lng = c?.longitude ?? (Array.isArray(g) ? g[0] : null);
  if (lat == null || lng == null) return null;
  const out = { lat, lng };
  cache[ck] = out;
  saveCache(cache);
  return out;
}

// Geocodifica uma lista pela Mapbox. Rápido e dentro do free tier (100k/mês).
// onProgress(done, total, currentStop)
export async function geocodeQueue(stops, { token = "", proximity = null, onProgress, signal } = {}) {
  const pending = stops.filter((s) => !s.geocoded && s.address);
  let done = 0;
  for (const s of pending) {
    if (signal?.aborted) break;
    try {
      const r = await geocodeOne(s.address, token, proximity);
      if (r) { s.lat = r.lat; s.lng = r.lng; s.geocoded = true; s.geoError = false; }
      else { s.geoError = true; }
    } catch (e) {
      s.geoError = true;
      // Sem token / chave inválida: aborta a fila inteira (erro de config, não de endereço)
      if (/Mapbox/.test(e.message)) { onProgress?.(pending.length, pending.length, s); throw e; }
    }
    done++;
    onProgress?.(done, pending.length, s);
    await new Promise((r) => setTimeout(r, 150)); // folgado dentro do rate-limit do Mapbox
  }
  return stops;
}

export function getCurrentPosition(opts = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Sem GPS"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000, ...opts }
    );
  });
}
