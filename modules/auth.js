// auth.js — acesso simples por senha (proteção básica da equipe AM Express)
// Fase 2: trocar por login individual via Firebase Auth.

// Hash SHA-256 da senha de acesso. Senha padrão: "amexpress2026"
// (peça pra trocar quando quiser — é só gerar outro hash).
const SENHA_HASH = "161eb4a72f3b0e913dc5f1936f4decbf5b8368f399abce60d75efb408bc405df";

const SESS_KEY = "amx:auth:v1";

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function login(senha, nomeEntregador) {
  const h = await sha256(String(senha || ""));
  if (h !== SENHA_HASH) return false;
  const sess = { nome: (nomeEntregador || "").trim() || "Entregador", ts: Date.now() };
  try { localStorage.setItem(SESS_KEY, JSON.stringify(sess)); } catch {}
  return true;
}

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESS_KEY) || "null"); } catch { return null; }
}

export function isLogged() {
  return !!getSession();
}

export function logout() {
  try { localStorage.removeItem(SESS_KEY); } catch {}
}
