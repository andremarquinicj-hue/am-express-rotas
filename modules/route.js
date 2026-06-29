// route.js — otimização da ordem de entrega (TSP heurístico)
import { haversine } from "./geo.js";

// Constrói matriz de distâncias (km) entre pontos [{lat,lng}]
function distMatrix(points) {
  const n = points.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = haversine(points[i], points[j]);
      m[i][j] = d; m[j][i] = d;
    }
  return m;
}

function tourLength(order, m) {
  let t = 0;
  for (let i = 0; i < order.length - 1; i++) t += m[order[i]][order[i + 1]];
  return t;
}

// Vizinho mais próximo a partir do índice 0 (origem)
function nearestNeighbor(m, n) {
  const visited = new Array(n).fill(false);
  const order = [0];
  visited[0] = true;
  let cur = 0;
  for (let k = 1; k < n; k++) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j] && m[cur][j] < bestD) { bestD = m[cur][j]; best = j; }
    }
    order.push(best); visited[best] = true; cur = best;
  }
  return order;
}

// Melhora a rota com 2-opt (mantém origem fixa no índice 0)
function twoOpt(order, m, { fixEnd = false, maxPasses = 60 } = {}) {
  const n = order.length;
  let improved = true, passes = 0;
  const last = fixEnd ? n - 1 : n;
  while (improved && passes < maxPasses) {
    improved = false; passes++;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < last; j++) {
        const a = order[i - 1], b = order[i], c = order[j], d = order[j + 1] ?? null;
        const before = m[a][b] + (d !== null ? m[c][d] : 0);
        const after = m[a][c] + (d !== null ? m[b][d] : 0);
        if (after + 1e-9 < before) {
          let lo = i, hi = j;
          while (lo < hi) { [order[lo], order[hi]] = [order[hi], order[lo]]; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return order;
}

/**
 * Otimiza a ordem de entrega.
 * @param origin {lat,lng}  ponto de partida (galpão ou posição atual)
 * @param stops  [{id,lat,lng,...}]  apenas paradas com coordenadas
 * @param opts   { finishAtOrigin }
 * @returns { order: [stopId...], totalKm }
 */
export function optimizeRoute(origin, stops, opts = {}) {
  const geo = stops.filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
  if (!origin || geo.length === 0) return { order: [], totalKm: 0, ungeocoded: stops.length };

  const finish = !!opts.finishAtOrigin;
  // pontos: [origem, ...paradas, (origem)]
  const pts = [origin, ...geo.map((s) => ({ lat: s.lat, lng: s.lng }))];
  if (finish) pts.push(origin);
  const n = pts.length;
  const m = distMatrix(pts);

  let order;
  if (finish) {
    // resolve sem o nó final duplicado, depois reanexa
    const sub = pts.slice(0, n - 1);
    const ms = distMatrix(sub);
    order = nearestNeighbor(ms, sub.length);
    order = twoOpt(order, ms, { fixEnd: false });
    order.push(n - 1); // volta à origem
  } else {
    order = nearestNeighbor(m, n);
    order = twoOpt(order, m, { fixEnd: false });
  }

  const totalKm = tourLength(order, m);
  // remove origem (índice 0) e eventual retorno (último) p/ mapear ids de paradas
  const stopOrder = order
    .filter((idx) => idx !== 0 && idx !== (finish ? n - 1 : -1))
    .map((idx) => geo[idx - 1].id);

  return { order: stopOrder, totalKm, ungeocoded: stops.length - geo.length };
}
