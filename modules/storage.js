// storage.js — persistência local (offline-first)
const KEY = "amx:rotas:v1";

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DEFAULT = {
  stops: [],
  dia: todayISO(),          // dia atual — usado pra zerar automaticamente quando vira o dia
  rotaNum: 1,               // número da rota atual do dia
  rotasFechadas: [],        // rotas já fechadas hoje: [{ num, pacotes, entregues, falhas, km, fechadaEm }]
  config: {
    origin: null,            // { lat, lng, label }
    finishAtOrigin: false,   // voltar ao galpão no fim
    mapboxToken: "pk.eyJ1IjoibWFycXVpbmkyMyIsImEiOiJjbXF2MW1lYjMxMHE1MnNwaWlucnczbDY0In0.a70Fspe1SBw5lAVaP82Mww", // chave pública do Mapbox (restrita ao domínio, mapa + geocoding)
  },
  meta: { createdAt: Date.now() },
};

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT);
    const s = JSON.parse(raw);
    return { ...structuredClone(DEFAULT), ...s, config: { ...DEFAULT.config, ...(s.config || {}) } };
  } catch {
    return structuredClone(DEFAULT);
  }
}

let _t = null;
export function saveState(state) {
  clearTimeout(_t);
  _t = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn("save falhou", e); }
  }, 120);
}

export function clearState() {
  localStorage.removeItem(KEY);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
