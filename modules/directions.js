// directions.js — traça a rota REAL nas ruas (Mapbox Directions API)
// Recebe os pontos já na ordem otimizada e devolve a linha do caminho (pra desenhar no mapa).

// Mapbox Directions aceita até 25 coordenadas por chamada.
// Pra rotas grandes, quebramos em lotes sobrepondo o último ponto de cada lote.
const MAX_PTS = 25;

function chunkPoints(points) {
  const chunks = [];
  let i = 0;
  while (i < points.length - 1) {
    const end = Math.min(i + MAX_PTS, points.length);
    chunks.push(points.slice(i, end));
    i = end - 1; // sobrepõe o último ponto pra emendar os trechos
  }
  return chunks;
}

async function fetchLeg(coords, token, signal) {
  const path = coords.map((c) => `${c.lng},${c.lat}`).join(";");
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${path}` +
    `?geometries=geojson&overview=full&access_token=${token}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error("directions http " + res.status);
  const data = await res.json();
  const route = data.routes && data.routes[0];
  if (!route) return null;
  return {
    coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]), // -> [lat,lng] p/ Leaflet
    distance: route.distance || 0, // metros
    duration: route.duration || 0, // segundos
  };
}

// Retorna { line: [[lat,lng]...], km, min } ou null se não der.
export async function routeGeometry(origin, orderedStops, { token, finishAtOrigin = false, signal } = {}) {
  if (!token) return null;
  const pts = [];
  if (origin) pts.push({ lat: origin.lat, lng: origin.lng });
  orderedStops.forEach((s) => pts.push({ lat: s.lat, lng: s.lng }));
  if (finishAtOrigin && origin) pts.push({ lat: origin.lat, lng: origin.lng });
  if (pts.length < 2) return null;

  const chunks = chunkPoints(pts);
  let line = [];
  let dist = 0, dur = 0, algumReal = false;
  for (const ch of chunks) {
    let leg = null;
    // cada trecho tenta 2x (rede móvel oscila); falha de um trecho NÃO derruba os outros
    for (let tent = 0; tent < 2 && !leg; tent++) {
      try { leg = await fetchLeg(ch, token, signal); }
      catch (e) { if (signal && signal.aborted) return null; leg = null; }
    }
    if (leg) {
      line = line.length ? line.concat(leg.coords.slice(1)) : leg.coords;
      dist += leg.distance;
      dur += leg.duration;
      algumReal = true;
    } else {
      // trecho indisponível: emenda em linha reta SÓ neste pedaço (o resto continua real)
      const reta = ch.map((c) => [c.lat, c.lng]);
      line = line.length ? line.concat(reta.slice(1)) : reta;
      for (let i = 1; i < ch.length; i++) {
        const dLat = (ch[i].lat - ch[i - 1].lat), dLng = (ch[i].lng - ch[i - 1].lng);
        dist += Math.sqrt(dLat * dLat + dLng * dLng) * 111320; // aproximação em metros
      }
    }
  }
  if (!line.length || !algumReal) return null;
  return { line, km: Math.round((dist / 1000) * 10) / 10, min: Math.round(dur / 60) };
}
