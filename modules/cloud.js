// cloud.js — sincronização na nuvem (Firestore, offline-first)
// Estrutura: usuarios/{userId}/dias/{YYYY-MM-DD} -> { stops, lastKm, dia, entregador, atualizadoEm }
// O SDK do Firebase é carregado SOB DEMANDA (não trava a abertura do app).

const firebaseConfig = {
  apiKey: "AIzaSyANwIIJ2Jmyqz8346APJaCUMqMmAF0KO0I",
  authDomain: "am-express-rotas.firebaseapp.com",
  projectId: "am-express-rotas",
  storageBucket: "am-express-rotas.firebasestorage.app",
  messagingSenderId: "717865220881",
  appId: "1:717865220881:web:15fd53c36eed21c544eab0",
};

const FB_VER = "10.14.1";
let db = null;
let ready = false;
let _loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("falha ao carregar " + src));
    document.head.appendChild(s);
  });
}

// garante que window.firebase + firestore existam (carrega só na 1a vez)
async function ensureFirebase() {
  if (window.firebase && window.firebase.firestore) return true;
  if (!_loading) {
    _loading = (async () => {
      await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-firestore-compat.js`);
    })();
  }
  try { await _loading; } catch (e) { _loading = null; throw e; }
  return !!(window.firebase && window.firebase.firestore);
}

export async function initCloud() {
  if (ready) return true;
  try {
    const ok = await ensureFirebase();
    if (!ok) return false;
    const fb = window.firebase;
    if (!fb.apps.length) fb.initializeApp(firebaseConfig);
    db = fb.firestore();
    try { db.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch {}
    ready = true;
    return true;
  } catch (e) {
    console.warn("[cloud] init falhou", e);
    return false;
  }
}

export function cloudReady() { return ready; }

function dayRef(userId, dia) {
  return db.collection("usuarios").doc(userId).collection("dias").doc(dia);
}

export async function getDay(userId, dia) {
  if (!ready) return null;
  try {
    const snap = await dayRef(userId, dia).get();
    return snap.exists ? snap.data() : null;
  } catch (e) { console.warn("[cloud] getDay", e); return null; }
}

export async function saveDay(userId, dia, payload) {
  if (!ready) return false;
  try {
    await dayRef(userId, dia).set({ ...payload }, { merge: true });
    return true;
  } catch (e) { console.warn("[cloud] saveDay", e); return false; }
}

// users = [[id, nome], ...] -> [{ id, nome, data }]
export async function getTeamDay(dia, users) {
  if (!ready) return [];
  const out = [];
  for (const [id, nome] of users) {
    let data = null;
    try { const snap = await dayRef(id, dia).get(); data = snap.exists ? snap.data() : null; } catch {}
    out.push({ id, nome, data });
  }
  return out;
}

/* ================= Rotas por documento (permite 2 celulares ao mesmo tempo) =================
 * usuarios/{userId}/dias/{dia}/rotas/{rotaNum} -> { num, stops, lastKm, status, criadaPor, atualizadoEm }
 * Cada rota tem seu próprio documento, então o operador da base pode preparar a Rota 3
 * enquanto o entregador está na Rota 2 — sem um sobrescrever o outro.
 */
function routesCol(userId, dia) {
  return dayRef(userId, dia).collection("rotas");
}
function routeRef(userId, dia, num) {
  return routesCol(userId, dia).doc(String(num));
}

// lê todas as rotas do dia (qualquer status). Retorna [{ num, ...dados }] ordenado por num.
export async function listRoutes(userId, dia) {
  if (!ready) return [];
  try {
    const snap = await routesCol(userId, dia).get();
    const out = [];
    snap.forEach((doc) => out.push({ num: Number(doc.id), ...doc.data() }));
    out.sort((a, b) => a.num - b.num);
    return out;
  } catch (e) { console.warn("[cloud] listRoutes", e); return []; }
}

export async function getRoute(userId, dia, num) {
  if (!ready) return null;
  try {
    const snap = await routeRef(userId, dia, num).get();
    return snap.exists ? snap.data() : null;
  } catch (e) { console.warn("[cloud] getRoute", e); return null; }
}

export async function saveRoute(userId, dia, num, payload) {
  if (!ready) return false;
  try {
    await routeRef(userId, dia, num).set({ num, ...payload }, { merge: true });
    return true;
  } catch (e) { console.warn("[cloud] saveRoute", e); return false; }
}

// exclui uma rota inteira da nuvem (ex.: foi criada por engano e está vazia/abandonada)
export async function deleteRoute(userId, dia, num) {
  if (!ready) return false;
  try {
    await routeRef(userId, dia, num).delete();
    return true;
  } catch (e) { console.warn("[cloud] deleteRoute", e); return false; }
}

// reserva o próximo número de rota livre pra esse usuário/dia (evita 2 celulares pegarem o mesmo número)
export async function nextRouteNum(userId, dia) {
  if (!ready) return 1;
  try {
    const rotas = await listRoutes(userId, dia);
    const max = rotas.reduce((m, r) => Math.max(m, r.num || 0), 0);
    return max + 1;
  } catch (e) { console.warn("[cloud] nextRouteNum", e); return 1; }
}

// equipe (dono): todas as rotas de hoje de cada entregador, juntas
export async function getTeamRoutes(dia, users) {
  if (!ready) return [];
  const out = [];
  for (const [id, nome] of users) {
    let rotas = [];
    try { rotas = await listRoutes(id, dia); } catch {}
    out.push({ id, nome, rotas });
  }
  return out;
}
