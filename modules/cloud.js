// cloud.js — sincronização na nuvem (Firestore, offline-first)
// Estrutura: usuarios/{userId}/dias/{YYYY-MM-DD} -> { stops, lastKm, dia, entregador, atualizadoEm }
// Carrega o SDK compat via <script> no index.html (window.firebase).

const firebaseConfig = {
  apiKey: "AIzaSyANwIIJ2Jmyqz8346APJaCUMqMmAF0KO0I",
  authDomain: "am-express-rotas.firebaseapp.com",
  projectId: "am-express-rotas",
  storageBucket: "am-express-rotas.firebasestorage.app",
  messagingSenderId: "717865220881",
  appId: "1:717865220881:web:15fd53c36eed21c544eab0",
};

let db = null;
let ready = false;

export function initCloud() {
  if (ready) return true;
  try {
    const fb = window.firebase;
    if (!fb || !fb.firestore) return false;            // SDK não carregou (offline na 1ª vez)
    if (!fb.apps.length) fb.initializeApp(firebaseConfig);
    db = fb.firestore();
    // persistência offline: salva local e sincroniza quando a internet volta
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

// lê o dia de um usuário (uma vez). Retorna o objeto ou null.
export async function getDay(userId, dia) {
  if (!ready) return null;
  try {
    const snap = await dayRef(userId, dia).get();
    return snap.exists ? snap.data() : null;
  } catch (e) { console.warn("[cloud] getDay", e); return null; }
}

// salva (merge) o dia de um usuário.
export async function saveDay(userId, dia, payload) {
  if (!ready) return false;
  try {
    await dayRef(userId, dia).set({ ...payload }, { merge: true });
    return true;
  } catch (e) { console.warn("[cloud] saveDay", e); return false; }
}

// lê o dia de vários usuários (para o dono ver a equipe).
// users = [[id, nome], ...]. Retorna [{ id, nome, data }].
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
