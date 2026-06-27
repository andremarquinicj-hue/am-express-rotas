// geo.js — distância, parsing de coordenadas e geocodificação (Mapbox Geocoding v6)
// Com FUNIL DE TENTATIVAS: se o endereço completo falhar, tenta versões mais simples
// (rua+número+cidade, CEP+cidade, rua+cidade) — resolve etiquetas que a IA leu meio bagunçadas.
const GEO_CACHE_KEY = "amx:geocache:v3";

function loadCache() {
  try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || "{}"); } catch { return {}; }
}
function saveCache(c) {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(c)); } catch {}
}

const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");
const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");

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

// "Rua São João 1185 Casa R S João" -> "Rua São João 1185" (rua + primeiro número)
function streetAndNumber(endereco) {
  const s = clean(endereco);
  const m = s.match(/^(.*?\d{1,6})(?:\b|$)/);
  return m ? clean(m[1]).replace(/[,;]+$/, "") : s;
}
// "Rua São João 1185" -> "Rua São João" (só o nome da rua)
function streetName(endereco) {
  const sn = streetAndNumber(endereco);
  return clean(sn.replace(/\s*\d[\d\s]*$/, "")) || clean(endereco.replace(/\d.*$/, ""));
}

// Monta a lista ordenada de buscas a tentar para uma parada.
function buildQueries(s) {
  const g = s.geo;
  if (!g || (!g.endereco && !g.cidade)) return [clean(s.address)].filter(Boolean);
  const cidade = clean(g.cidade), uf = clean(g.uf), cep = onlyDigits(g.cep);
  const bairro = clean(g.bairro), endereco = clean(g.endereco);
  const sn = streetAndNumber(endereco);
  const st = streetName(endereco);
  const cityUf = [cidade, uf].filter(Boolean).join(", ");
  const out = [];
  const push = (...parts) => {
    const v = parts.map(clean).filter(Boolean).join(", ");
    if (v && !out.includes(v)) out.push(v);
  };
  push(endereco, bairro, cityUf);         // 1. como a IA leu (completo)
  push(sn, cityUf);                        // 2. rua + número + cidade/uf
  if (cep.length === 8) push(cep, cidade); // 3. CEP + cidade
  push(st, bairro, cityUf);                // 4. rua (sem nº) + bairro + cidade
  push(st, cityUf);                        // 5. rua + cidade
  return out.filter(Boolean);
}

// Faz UMA busca no Mapbox. Retorna {lat,lng} ou null (e cacheia, inclusive a ausência).
async function geocodeQuery(q, token, proximity) {
  const cache = loadCache();
  const ck = q.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(cache, ck)) return cache[ck];

  const params = new URLSearchParams({
    q, access_token: token, country: "br", language: "pt", limit: "1",
    types: "address,street,place,postcode,locality,neighborhood",
  });
  if (proximity && proximity.lng != null && proximity.lat != null) {
    params.set("proximity", `${proximity.lng},${proximity.lat}`);
  }
  const res = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`, { headers: { Accept: "application/json" } });
  if (res.status === 401) throw new Error("Chave do Mapbox inválida (401).");
  if (!res.ok) throw new Error("geocode http " + res.status);
  const data = await res.json();
  const f = data && data.features && data.features[0];
  let out = null;
  if (f) {
    const c = f.properties?.coordinates;
    const g = f.geometry?.coordinates;
    const lat = c?.latitude ?? (Array.isArray(g) ? g[1] : null);
    const lng = c?.longitude ?? (Array.isArray(g) ? g[0] : null);
    if (lat != null && lng != null) out = { lat, lng };
  }
  cache[ck] = out; saveCache(cache);
  return out;
}

// Geocodifica UM endereço simples (usado p/ o galpão, que o usuário digita limpo).
export async function geocodeOne(address, token = "", proximity = null) {
  const q = clean(address);
  if (!q) return null;
  if (!token) throw new Error("Configure a chave do Mapbox nas Configurações.");
  return geocodeQuery(q, token, proximity);
}

// Geocodifica uma PARADA tentando o funil de buscas até achar.
async function geocodeStop(s, token, proximity) {
  const queries = buildQueries(s);
  for (let i = 0; i < queries.length; i++) {
    const r = await geocodeQuery(queries[i], token, proximity);
    if (r) return { ...r, approx: i >= 3 }; // tentativas 4-5 = nível de rua (aproximado)
    if (i < queries.length - 1) await new Promise((res) => setTimeout(res, 140));
  }
  return null;
}

// Geocodifica uma lista de paradas. onProgress(done, total, currentStop)
export async function geocodeQueue(stops, { token = "", proximity = null, onProgress, signal } = {}) {
  const pending = stops.filter((s) => !s.geocoded && s.address);
  let done = 0;
  for (const s of pending) {
    if (signal?.aborted) break;
    try {
      const r = await geocodeStop(s, token, proximity);
      if (r) { s.lat = r.lat; s.lng = r.lng; s.geocoded = true; s.geoError = false; s.approx = !!r.approx; }
      else { s.geoError = true; }
    } catch (e) {
      s.geoError = true;
      if (/Mapbox/.test(e.message)) { onProgress?.(pending.length, pending.length, s); throw e; }
    }
    done++;
    onProgress?.(done, pending.length, s);
    await new Promise((r) => setTimeout(r, 150));
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
