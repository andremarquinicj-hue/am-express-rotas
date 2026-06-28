// auth.js — acesso da equipe AM Express (2 usuários: dono + entregador)
// A senha digitada identifica QUEM é o usuário (cada um tem a sua).
// Fase 2: trocar por login individual + nuvem via Firebase Auth.

// Para trocar uma senha: gere o SHA-256 da nova senha e substitua o "hash" abaixo.
const USERS = [
  { user: "andre",     nome: "André",     role: "dono",        hash: "37a6409e59451fd0c395f7be7bb6d7503965db82478cc768cb3f645d1f9961db" }, // senha: andre2026
  { user: "guilherme", nome: "Guilherme", role: "entregador",  hash: "63b42c6ff00e92e2853f9b2dc3025276279a53091ac0f775c94ecce253788936" }, // senha: guilherme2026
];

const SESS_KEY = "amx:auth:v2"; // v2: novo sistema de 2 usuários (invalida sessões antigas)

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Recebe só a senha. Retorna o usuário {user,nome,role} se acertar, ou false.
export async function login(senha) {
  const h = await sha256(String(senha || ""));
  const u = USERS.find((x) => x.hash === h);
  if (!u) return false;
  const sess = { user: u.user, nome: u.nome, role: u.role, ts: Date.now() };
  try { localStorage.setItem(SESS_KEY, JSON.stringify(sess)); } catch {}
  return u;
}

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESS_KEY) || "null"); } catch { return null; }
}

export function isLogged() {
  return !!getSession();
}

export function isOwner() {
  const s = getSession();
  return s && s.role === "dono";
}

export function logout() {
  try { localStorage.removeItem(SESS_KEY); } catch {}
}
