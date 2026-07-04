// route.js — otimização hierárquica: CIDADE -> BAIRRO -> RUA -> casa
// A ideia é imitar como um entregador experiente trabalha: fecha um bairro por vez,
// e dentro do bairro varre rua por rua (sem pular entre ruas paralelas).
import { haversine } from "./geo.js";

/* ---------------- helpers de texto ---------------- */
const stripAcc = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const norm = (s) => stripAcc(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function cityKey(stop) {
  return norm((stop.geo || {}).cidade || "") || "?";
}
/* ---------------- agrupamento espacial (não depende do texto do bairro) ----------------
 * O texto do bairro falha muito (etiqueta sem bairro, ViaCEP vazio em cidade pequena).
 * Então agrupamos por PROXIMIDADE real: células de ~850m, e células pequenas (<3 paradas)
 * são fundidas ao grupo vizinho — o resultado se comporta como "bairros de verdade". */
const CELL = 0.008; // ~850m
// agrupa paradas por rua (a rua é a unidade atômica: nunca é dividida entre grupos)
function agrupaRuas(stopsList) {
  const g = new Map();
  let anon = 0;
  for (const s of stopsList) {
    const k = streetKey(s) || `__solo_${anon++}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(s);
  }
  return [...g.values()].map((sts) => ({ stops: sts, c: centroid(sts) }));
}
function buildClusters(stopsList) {
  // 1) ruas inteiras; 2) cada rua entra no cluster da célula do seu CENTRO
  const ruas = agrupaRuas(stopsList);
  const m = new Map();
  for (const r of ruas) {
    const k = Math.round(r.c.lat / CELL) + ":" + Math.round(r.c.lng / CELL);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  let clusters = [...m.values()].map((rs) => {
    const sts = rs.flatMap((r) => r.stops);
    return { stops: sts, c: centroid(sts) };
  });
  // funde grupos pequenos ao vizinho mais próximo (evita fragmentação/zigue-zague)
  while (clusters.length > 1) {
    const small = clusters.find((c) => c.stops.length < 3);
    if (!small) break;
    let best = null, bd = Infinity;
    for (const c of clusters) {
      if (c === small) continue;
      const d = haversine(small.c, c.c);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) break;
    best.stops.push(...small.stops);
    best.c = centroid(best.stops);
    clusters = clusters.filter((c) => c !== small);
  }
  return clusters;
}

/* ordena grupos (cidades ou clusters) a partir de um ponto: greedy + 2-opt.
 * O 2-opt é o que elimina o "vai-e-volta" entre regiões que o vizinho-mais-próximo cria. */
async function orderGroupsSmart(entry, groups, opts = {}) {
  const arr = groups.map((g) => ({ ...g, c: g.c || centroid(g.stops) }));
  if (arr.length <= 1) return arr;
  // distâncias REAIS de rua (Matrix) quando disponíveis; senão, linha reta
  const pontos = [entry, ...arr.map((g) => g.c)];
  if (opts.retorno) pontos.push(opts.retorno);
  let M = null;
  if (opts.matrixFor && pontos.length <= 25) {
    try { M = await opts.matrixFor(pontos); } catch { M = null; }
  }
  const iRet = opts.retorno ? pontos.length - 1 : -1;
  const dEntry = (i) => (M ? M[0][i + 1] : haversine(entry, arr[i].c));
  const dBetw = (i, j) => (M ? M[i + 1][j + 1] : haversine(arr[i].c, arr[j].c));
  const dRet = (i) => (!opts.retorno ? 0 : (M ? M[i + 1][iRet] : haversine(arr[i].c, opts.retorno)));

  // greedy inicial
  const used = new Array(arr.length).fill(false);
  let order = [];
  let cur = -1; // -1 = ponto de entrada
  for (let k = 0; k < arr.length; k++) {
    let b = -1, bd = Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (used[i]) continue;
      const d = cur < 0 ? dEntry(i) : dBetw(cur, i);
      if (d < bd) { bd = d; b = i; }
    }
    used[b] = true; order.push(b); cur = b;
  }
  const cost = (ord) => {
    let t = dEntry(ord[0]);
    for (let i = 1; i < ord.length; i++) t += dBetw(ord[i - 1], ord[i]);
    t += dRet(ord[ord.length - 1]);
    return t;
  };
  let best = cost(order), improved = true, passes = 0;
  while (improved && passes < 40) {
    improved = false; passes++;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = order.slice();
        let lo = i, hi = j;
        while (lo < hi) { [cand[lo], cand[hi]] = [cand[hi], cand[lo]]; lo++; hi--; }
        const c = cost(cand);
        if (c + 1e-9 < best) { best = c; order = cand; improved = true; }
      }
    }
    // or-opt: mover um grupo inteiro de posição
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        if (j === i) continue;
        const cand = order.slice();
        const [g] = cand.splice(i, 1);
        cand.splice(j > i ? j - 1 : j, 0, g);
        const c = cost(cand);
        if (c + 1e-9 < best) { best = c; order = cand; improved = true; }
      }
    }
  }
  return order.map((i) => arr[i]);
}
// chave da rua: logradouro sem o número DA CASA (preservando números que fazem
// parte do nome, tipo "Rua 7 de Setembro" ou "Avenida 2")
function streetKey(stop) {
  const g = stop.geo || {};
  const raw = String(g.endereco || stop.address || "");
  let rua;
  if (raw.includes(",")) {
    // formato do app: "Nome da Rua, 123, ..." -> tudo antes da 1ª vírgula é o nome
    rua = raw.split(",")[0];
  } else {
    // sem vírgula: remove só um número no FINAL (provável nº da casa)
    rua = raw.replace(/\s+\d{1,5}\s*[a-zA-Z]?\s*$/, "");
  }
  rua = norm(rua);
  return rua || null;
}

/* ---------------- ordenação dentro da rua (projeção no eixo principal) ---------------- */
function sortAlongAxis(points) {
  if (points.length <= 2) return points.slice();
  const mLat = points.reduce((a, p) => a + p.lat, 0) / points.length;
  const mLng = points.reduce((a, p) => a + p.lng, 0) / points.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    const dx = p.lng - mLng, dy = p.lat - mLat;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta), uy = Math.sin(theta);
  return points.slice().sort((a, b) =>
    ((a.lng - mLng) * ux + (a.lat - mLat) * uy) - ((b.lng - mLng) * ux + (b.lat - mLat) * uy));
}

/* ---------------- TSP em nível de SEGMENTO (rua), usado DENTRO de cada bairro ---------------- */
function segDist(pa, pb) { return haversine(pa, pb); }

function greedySegments(origin, segs) {
  const n = segs.length;
  const used = new Array(n).fill(false);
  const orderIdx = [];
  let cur = origin;
  for (let k = 0; k < n; k++) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const d = Math.min(segDist(cur, segs[i].A), segDist(cur, segs[i].B));
      if (d < bestD) { bestD = d; best = i; }
    }
    used[best] = true;
    orderIdx.push(best);
    const dA = segDist(cur, segs[best].A), dB = segDist(cur, segs[best].B);
    cur = dA <= dB ? segs[best].B : segs[best].A;
  }
  return orderIdx;
}

function dpCost(orderIdx, segs, origin) {
  const n = orderIdx.length;
  const s0 = segs[orderIdx[0]];
  let prev = [segDist(origin, s0.A), segDist(origin, s0.B)];
  for (let i = 1; i < n; i++) {
    const p = segs[orderIdx[i - 1]], c = segs[orderIdx[i]];
    const exits = [p.B, p.A];
    const next = [Infinity, Infinity];
    for (let o = 0; o < 2; o++) {
      const entry = o === 0 ? c.A : c.B;
      next[o] = Math.min(prev[0] + segDist(exits[0], entry), prev[1] + segDist(exits[1], entry));
    }
    prev = next;
  }
  return Math.min(prev[0], prev[1]);
}

function twoOptSegments(orderIdx, segs, origin, maxPasses = 30) {
  let improved = true, passes = 0;
  let bestCost = dpCost(orderIdx, segs, origin);
  while (improved && passes < maxPasses) {
    improved = false; passes++;
    for (let i = 0; i < orderIdx.length - 1; i++) {
      for (let j = i + 1; j < orderIdx.length; j++) {
        const cand = orderIdx.slice();
        let lo = i, hi = j;
        while (lo < hi) { [cand[lo], cand[hi]] = [cand[hi], cand[lo]]; lo++; hi--; }
        const c = dpCost(cand, segs, origin);
        if (c + 1e-9 < bestCost) { orderIdx = cand; bestCost = c; improved = true; }
      }
    }
  }
  return orderIdx;
}

// or-opt: tenta MOVER cada rua para outra posição da sequência (escapa de
// mínimos locais em que o 2-opt trava — reduz "voltinhas" desnecessárias)
function orOptSegments(orderIdx, segs, origin, maxPasses = 15) {
  let bestCost = dpCost(orderIdx, segs, origin), improved = true, passes = 0;
  while (improved && passes < maxPasses) {
    improved = false; passes++;
    for (let i = 0; i < orderIdx.length; i++) {
      for (let j = 0; j <= orderIdx.length - 1; j++) {
        if (j === i) continue;
        const cand = orderIdx.slice();
        const [seg] = cand.splice(i, 1);
        cand.splice(j > i ? j - 1 : j, 0, seg);
        const c = dpCost(cand, segs, origin);
        if (c + 1e-9 < bestCost) { bestCost = c; orderIdx = cand; improved = true; }
      }
    }
  }
  return orderIdx;
}

function fixOrientations(orderIdx, segs, origin) {
  const n = orderIdx.length;
  const INF = Infinity;
  const dp = Array.from({ length: n }, () => [INF, INF]);
  const parent = Array.from({ length: n }, () => [0, 0]);
  const s0 = segs[orderIdx[0]];
  dp[0][0] = segDist(origin, s0.A);
  dp[0][1] = segDist(origin, s0.B);
  for (let i = 1; i < n; i++) {
    const prev = segs[orderIdx[i - 1]], cur = segs[orderIdx[i]];
    const exits = [prev.B, prev.A];
    for (let o = 0; o < 2; o++) {
      const entry = o === 0 ? cur.A : cur.B;
      for (let po = 0; po < 2; po++) {
        const c = dp[i - 1][po] + segDist(exits[po], entry);
        if (c < dp[i][o]) { dp[i][o] = c; parent[i][o] = po; }
      }
    }
  }
  const orient = new Array(n);
  let o = dp[n - 1][0] <= dp[n - 1][1] ? 0 : 1;
  for (let i = n - 1; i >= 0; i--) { orient[i] = o; o = parent[i][o]; }
  return orient;
}

// roda o TSP de ruas dentro de UM bairro; retorna { stops: [...ordenadas], exit: últimoPonto }
function routeHood(entry, stopsDoBairro) {
  const groups = new Map();
  let anon = 0;
  for (const s of stopsDoBairro) {
    const key = streetKey(s) || `__solo_${anon++}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const segs = [];
  for (const [, pts] of groups) {
    const sorted = sortAlongAxis(pts);
    segs.push({ pts: sorted, A: { lat: sorted[0].lat, lng: sorted[0].lng }, B: { lat: sorted[sorted.length - 1].lat, lng: sorted[sorted.length - 1].lng } });
  }
  let orderIdx = greedySegments(entry, segs);
  if (segs.length > 2) {
    orderIdx = twoOptSegments(orderIdx, segs, entry);
    orderIdx = orOptSegments(orderIdx, segs, entry);
    orderIdx = twoOptSegments(orderIdx, segs, entry, 10); // passada final curta
  }
  const orient = fixOrientations(orderIdx, segs, entry);
  const out = [];
  for (let i = 0; i < orderIdx.length; i++) {
    const seg = segs[orderIdx[i]];
    const pts = orient[i] === 0 ? seg.pts : seg.pts.slice().reverse();
    out.push(...pts);
  }
  const last = out[out.length - 1];
  return { stops: out, exit: { lat: last.lat, lng: last.lng } };
}

/* ---------------- helpers de agrupamento/centróide ---------------- */
function centroid(list) {
  return {
    lat: list.reduce((a, s) => a + s.lat, 0) / list.length,
    lng: list.reduce((a, s) => a + s.lng, 0) / list.length,
  };
}
// ordena grupos por vizinho-mais-próximo entre centróides, a partir de um ponto
function nnGroups(start, groups) {
  const arr = groups.map((g) => ({ ...g, c: centroid(g.stops) }));
  const used = new Array(arr.length).fill(false);
  const out = [];
  let cur = start;
  for (let k = 0; k < arr.length; k++) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < arr.length; i++) {
      if (used[i]) continue;
      const d = haversine(cur, arr[i].c);
      if (d < bestD) { bestD = d; best = i; }
    }
    used[best] = true;
    out.push(arr[best]);
    cur = arr[best].c;
  }
  return out;
}

/* ---------------- API pública (mesma assinatura de antes) ---------------- */
export async function optimizeRoute(origin, stops, opts = {}) {
  const geo = stops.filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
  if (!origin || geo.length === 0) return { order: [], totalKm: 0, ungeocoded: stops.length };

  // 1) cidade -> lista de paradas (texto da cidade é confiável)
  const cidades = new Map();
  for (const s of geo) {
    const ck = cityKey(s);
    if (!cidades.has(ck)) cidades.set(ck, []);
    cidades.get(ck).push(s);
  }
  const cidadeGroups = [...cidades.entries()].map(([key, sts]) => ({ key, stops: sts }));

  // 2) ordem das cidades: greedy + 2-opt a partir da origem (fecha uma cidade por vez)
  const cidadesOrdenadas = await orderGroupsSmart(origin, cidadeGroups, { retorno: opts.finishAtOrigin ? origin : null, matrixFor: opts.matrixFor });

  const finalStops = [];
  let cur = origin;
  for (const cidade of cidadesOrdenadas) {
    // 3) dentro da cidade: grupos por PROXIMIDADE real (não depende do texto do bairro)
    const clusters = buildClusters(cidade.stops);
    // 4) ordem dos grupos: greedy + 2-opt a partir do ponto atual (mata o vai-e-volta)
    const clustersOrdenados = await orderGroupsSmart(cur, clusters, { matrixFor: opts.matrixFor });
    for (const cl of clustersOrdenados) {
      // 5) dentro do grupo: rua por rua (TSP de segmentos + serpentina)
      const r = routeHood(cur, cl.stops);
      finalStops.push(...r.stops);
      cur = r.exit;
    }
  }

  // km total da sequência (origem -> paradas [-> origem])
  let totalKm = 0;
  let prev = origin;
  for (const p of finalStops) { totalKm += haversine(prev, p); prev = p; }
  if (opts.finishAtOrigin) totalKm += haversine(prev, origin);

  return { order: finalStops.map((s) => s.id), totalKm, ungeocoded: stops.length - geo.length };
}
