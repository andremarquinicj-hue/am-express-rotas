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
