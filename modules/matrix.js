// matrix.js — distâncias REAIS de rua entre vários pontos (Mapbox Matrix API).
// É assim que a rota passa a "conhecer" as cidades: mão única, ferrovia, rodovia
// e o traçado verdadeiro entram na conta — em vez de linha reta no mapa.
// Usado só no nível dos GRUPOS (poucos pontos por chamada = leve e dentro da cota).

export async function fetchMatrix(points, token, { signal } = {}) {
  if (!token || !points || points.length < 2 || points.length > 25) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords}` +
    `?annotations=duration&access_token=${token}`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const j = await res.json();
    const M = j && j.durations;
    if (!M || M.length !== points.length) return null;
    // troca null (par sem rota) por um custo alto, pra não quebrar a comparação
    return M.map((row) => row.map((v) => (v == null ? 9e9 : v)));
  } catch {
    return null; // sem rede/erro: quem chamou cai na linha reta (haversine)
  }
}
