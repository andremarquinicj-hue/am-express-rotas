// app.js — AM Express · Rotas (Preact + htm, sem build)
import { loadState, saveState, uid, clearState, todayISO } from "./modules/storage.js";
import { geocodeQueue, getCurrentPosition, geocodeOne, parseLatLng, haversine, limparGeocache } from "./modules/geo.js";
import { optimizeRoute } from "./modules/route.js";
import { parseCSV } from "./modules/csv.js";
import { startScanner, stopScanner, feedback } from "./modules/scanner.js";
import { startCamera, stopCamera, capturePhoto, lerEtiqueta, montarEndereco } from "./modules/ocr.js";
import { login, getSession, isLogged, logout, isOwner } from "./modules/auth.js";
import { registrarDia, listarHistorico, limparHistorico, exportarCSV } from "./modules/history.js";
import { routeGeometry } from "./modules/directions.js";

// A nuvem é carregada sob demanda: se o arquivo faltar ou o Firebase falhar,
// o app continua funcionando 100% no celular (nunca trava por causa disso).
let _cloudPromise = null;
function loadCloud() {
  if (!_cloudPromise) {
    _cloudPromise = import("./modules/cloud.js").catch((e) => { console.warn("nuvem indisponível", e); return null; });
  }
  return _cloudPromise;
}

const { h, render } = window.preact;
const { useState, useEffect, useRef, useMemo, useCallback } = window.preactHooks;
const APP_VERSION = "v27";
const html = window.htm.bind(h);

/* ============================ helpers ============================ */
const fmtKm = (k) => (k >= 10 ? Math.round(k) : k.toFixed(1)).toString().replace(".", ",");
const fmtMoney = (v) => "R$ " + Math.abs(v).toFixed(2).replace(".", ",");
const normCode = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
const today = () =>
  new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });

function matchStopByCode(stops, decoded) {
  const d = normCode(decoded);
  if (!d) return null;
  let s = stops.find((x) => x.code && normCode(x.code) === d);
  if (s) return s;
  s = stops.find((x) => x.code && d.includes(normCode(x.code)) && normCode(x.code).length >= 4);
  if (s) return s;
  s = stops.find((x) => x.code && normCode(x.code).includes(d) && d.length >= 6);
  return s || null;
}

/* ---- matching por ENDEREÇO (IA lê a etiqueta de novo e acha a parada) ---- */
const stripAccents = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const normTxt = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");
const STOP_WORDS = new Set(["rua", "r", "av", "avenida", "alameda", "al", "travessa", "tv", "rodovia",
  "estrada", "praca", "numero", "num", "no", "de", "da", "do", "das", "dos", "e", "apto", "ap",
  "apartamento", "bloco", "bl", "casa", "lote", "quadra", "qd", "jardim", "jd", "vila", "vl",
  "bairro", "cep", "sp", "brasil", "brazil", "shop"]);
const addrTokens = (s) => normTxt(s).split(" ").filter((t) => t && t.length >= 2 && !STOP_WORDS.has(t));
// palavras que precedem um número de UNIDADE (não é o número do logradouro)
const UNIT_WORDS = ["apto", "ap", "apartamento", "bloco", "bl", "casa", "quadra", "qd", "lote",
  "lt", "sala", "loja", "fundos", "torre", "edificio", "ed", "unidade", "un", "andar", "cep"];
const UNIT_RE = new RegExp(`\\b(?:${UNIT_WORDS.join("|")})\\s+(\\d{1,5})\\b`, "g");
// número do logradouro: pega o 1º número que NÃO está logo após uma palavra de unidade
// (resolve o caso "Bloco 3 Apto 12, Rua X, 1185" → ignora 3 e 12, acha 1185)
const firstNumber = (s) => {
  const raw = (s || "");
  // remove CEP inteiro (00000-000 ou 00000000) antes de tudo — nunca é o número da casa
  const semCep = raw.replace(/\b\d{5}-?\d{3}\b/g, " ");
  const norm = normTxt(semCep);
  const skip = new Set();
  let m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(norm))) skip.add(m[1]);
  const all = norm.match(/\b\d{1,5}\b/g) || [];
  const real = all.find((n) => !skip.has(n));
  return real || all[0] || "";
};

function scoreStop(stop, dados) {
  let score = 0;
  const stopDigits = onlyDigits(stop.address);
  const readCep = onlyDigits(dados.cep);
  if (readCep.length === 8 && stopDigits.includes(readCep)) score += 50;
  const readNum = firstNumber(dados.endereco);
  if (readNum) {
    const stopNums = normTxt(stop.address).match(/\b\d{1,5}\b/g) || [];
    if (stopNums.includes(readNum)) score += 18;
  }
  const stopTok = new Set(addrTokens(stop.address));
  const readAddr = new Set([...addrTokens(dados.endereco), ...addrTokens(dados.bairro)]);
  let shared = 0; readAddr.forEach((t) => { if (stopTok.has(t)) shared++; });
  score += Math.min(shared * 8, 34);
  const stopName = new Set(addrTokens(stop.name));
  const readName = new Set(addrTokens(dados.nome));
  let nameShared = 0; readName.forEach((t) => { if (stopName.has(t)) nameShared++; });
  score += Math.min(nameShared * 12, 28);
  const readCity = new Set(addrTokens(dados.cidade));
  let cityShared = 0; readCity.forEach((t) => { if (stopTok.has(t)) cityShared++; });
  score += Math.min(cityShared * 3, 6);
  return score;
}

function matchStopByAddress(stops, dados) {
  const scored = stops.map((s) => ({ stop: s, score: scoreStop(s, dados) })).sort((a, b) => b.score - a.score);
  const best = scored[0] || null;
  const second = scored[1] || null;
  const confident = !!best && best.score >= 40 && (!second || best.score - second.score >= 12);
  return {
    best: best && best.score >= 20 ? best.stop : null,
    confident,
    candidates: scored.filter((x) => x.score >= 12).slice(0, 4).map((x) => x.stop),
  };
}

const emptyConf = () => ({ nome: "", endereco: "", numero: "", complemento: "", bairro: "", cidade: "", uf: "", cep: "", codigo: "", telefone: "" });

/* ---- agrupamento: chave do endereço + lista de pacotes da parada ---- */
function addrKey(d) {
  const num = firstNumber(d.endereco || "");
  const street = addrTokens(d.endereco || "").filter((t) => !/^\d+$/.test(t)).join(" ");
  if (!street || !num) return ""; // precisa de rua E número pra agrupar com segurança
  return `${street}#${num}`;       // sem cidade: a IA erra muito o nome da cidade
}
// chave de uma parada já existente (recalcula dos campos guardados, p/ ser consistente)
const stopKey = (s) => addrKey(s.geo || { endereco: s.address });
const pkgsOf = (s) => (s.packages && s.packages.length
  ? s.packages
  : [{ id: s.id, code: s.code || "", name: s.name || "Sem nome", phone: s.phone || "", note: s.note || "" }]);
const pkgCount = (s) => pkgsOf(s).length;

/* ============================ icons ============================ */
const Icon = ({ name, ...p }) => {
  const paths = {
    home: "M3 11l9-8 9 8M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10",
    scan: "M4 7V5a1 1 0 011-1h2M4 17v2a1 1 0 001 1h2M20 7V5a1 1 0 00-1-1h-2M20 17v2a1 1 0 01-1 1h-2M4 12h16",
    map: "M9 4l6 2 6-2v14l-6 2-6-2-6 2V6l6-2zm0 0v14m6-12v14",
    list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    truck: "M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 18a2 2 0 11-4 0 2 2 0 014 0zm12 0a2 2 0 11-4 0 2 2 0 014 0z",
    pin: "M12 21s7-6.4 7-11a7 7 0 10-14 0c0 4.6 7 11 7 11zm0-8.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
    check: "M5 13l4 4L19 7",
    x: "M6 6l12 12M18 6L6 18",
    plus: "M12 5v14M5 12h14",
    gear: "M12 8a4 4 0 100 8 4 4 0 000-8zM3 12h2m14 0h2M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10l1.4 1.4m0-12.8l-1.4 1.4m-10 10L5.6 18.4",
    upload: "M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2",
    nav: "M3 11l18-8-8 18-2-8-8-2z",
    phone: "M4 4h4l2 5-3 2a12 12 0 006 6l2-3 5 2v4a2 2 0 01-2 2A16 16 0 014 6a2 2 0 010-2z",
    flag: "M5 3v18M5 4h11l-1.5 4L16 12H5",
    location: "M12 2v3m0 14v3M2 12h3m14 0h3M12 7a5 5 0 100 10 5 5 0 000-10z",
    camera: "M3 8a2 2 0 012-2h2l1.5-2h7L17 6h2a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2zM12 11a3 3 0 100 6 3 3 0 000-6z",
    history: "M12 8v5l3 2M3 12a9 9 0 109-9 9 9 0 00-7.5 4M3 4v4h4",
    logout: "M16 17l5-5-5-5M21 12H9M9 4H6a2 2 0 00-2 2v12a2 2 0 002 2h3",
    edit: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
    download: "M12 4v12m0 0l-4-4m4 4l4-4M4 20h16",
    users: "M16 19v-2a3 3 0 00-3-3H6a3 3 0 00-3 3v2M9.5 11a3 3 0 100-6 3 3 0 000 6zM21 19v-2a3 3 0 00-2.2-2.9M15.5 5.2a3 3 0 010 5.6",
  };
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" ...${p}><path d=${paths[name]} /></svg>`;
};

/* ============================ toasts ============================ */
let _pushToast = () => {};
function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    _pushToast = (msg, kind = "") => {
      const id = uid();
      setItems((a) => [...a, { id, msg, kind }]);
      setTimeout(() => setItems((a) => a.filter((t) => t.id !== id)), 2600);
    };
  }, []);
  return html`<div class="toast-host">
    ${items.map((t) => html`<div key=${t.id} class=${"toast " + (t.kind ? "toast--" + t.kind : "")}>${t.msg}</div>`)}
  </div>`;
}
const toast = (m, k) => _pushToast(m, k);

/* ============================ Login ============================ */
function LoginScreen({ onLogged }) {
  const [senha, setSenha] = useState("");
  const [busy, setBusy] = useState(false);

  const entrar = async () => {
    if (!senha.trim()) return toast("Digite sua senha", "err");
    setBusy(true);
    const u = await login(senha);
    setBusy(false);
    if (u) { toast(`Bem-vindo, ${u.nome}!`, "ok"); onLogged(); }
    else toast("Senha incorreta", "err");
  };

  return html`<div class="login">
    <div class="login__brand">
      <img class="login__logo" src="assets/logo-branca.png" alt="AM Express" />
      <div class="login__tag">ROTAS & ENTREGAS</div>
    </div>
    <div class="login__card">
      <div class="card__title" style="margin-bottom:4px">Acesso da equipe</div>
      <p class="muted small" style="margin-top:0">Digite sua senha para entrar.</p>
      <div class="field"><label>Senha de acesso</label>
        <input class="input" type="password" value=${senha} onInput=${(e) => setSenha(e.target.value)}
          placeholder="••••••••" onKeyDown=${(e) => e.key === "Enter" && entrar()} /></div>
      <button class="btn btn--lg" disabled=${busy} onClick=${entrar}>
        ${busy ? html`<span class="spinner"></span> Entrando...` : "Entrar"}</button>
    </div>
  </div>`;
}

/* ============================ Header ============================ */
function Header({ onHistory, onConfig }) {
  return html`<header class="hdr">
    <img class="hdr__logo" src="assets/logo-branca.png" alt="AM Express" />
    <div class="hdr__spacer"></div>
    <button class="hdr__btn" onClick=${onHistory} aria-label="Histórico">${html`<${Icon} name="history" width="20" height="20" />`}</button>
    <button class="hdr__btn" onClick=${onConfig} aria-label="Configurações">${html`<${Icon} name="gear" width="20" height="20" />`}</button>
  </header>`;
}

/* ============================ TabBar ============================ */
function TabBar({ view, setView, pending }) {
  const tabs = [
    { id: "home", label: "Início", icon: "home" },
    { id: "scan", label: "Numerar", icon: "scan" },
    { id: "map", label: "Rota", icon: "map" },
    { id: "list", label: "Entregas", icon: "list", badge: pending },
  ];
  return html`<nav class="tabbar">
    ${tabs.map(
      (t) => html`<button key=${t.id} class=${"tab " + (view === t.id ? "is-active" : "")}
        onClick=${() => setView(t.id)}>
        ${t.badge ? html`<span class="tab__badge">${t.badge}</span>` : null}
        <${Icon} name=${t.icon} />
        <span>${t.label}</span>
        <span class="tab__dot"></span>
      </button>`
    )}
  </nav>`;
}

/* ============================ Dashboard ============================ */
function Dashboard({ config, counts, totalKm, onCapture, onImport, onOptimize, onConfig, optimizing, hasRoute, userName, isOwner, onTeam, rotaNum, dayTotals, hasClosedRoutes, onNovaRota, onRotasDia, onVerSemLocal, dayMoney, dayTime, fmtDuracao }) {
  const pct = counts.total ? Math.round((counts.delivered / counts.total) * 100) : 0;
  return html`<main class="main">
    <div class="hero">
      <div class="hero__date">${today()}${rotaNum > 1 ? ` • Rota ${rotaNum}` : ""}</div>
      ${userName ? html`<div class="hero__hi">Olá, ${userName}</div>` : null}
      <div class="hero__big">${counts.delivered}<small>/${counts.total} entregues</small></div>
      <div class="hero__sub">${counts.total ? `${counts.pending} restantes • ${fmtKm(totalKm)} km na rota` : (rotaNum > 1 ? `Bipe os pacotes da Rota ${rotaNum}` : "Bipe as etiquetas para começar o dia")}</div>
      <div class="hero__bar"><i style=${{ width: pct + "%" }}></i></div>
    </div>

    ${hasClosedRoutes ? html`<div class="daybox">
      <div class="daybox__lbl">Total do dia (${dayTotals.rotas} rota${dayTotals.rotas !== 1 ? "s" : ""})</div>
      <div class="daybox__row">
        <div class="daybox__stat"><b>${dayTotals.entregues}<i>/${dayTotals.pacotes}</i></b><span>entregues</span></div>
        <div class="daybox__stat"><b>${dayTotals.falhas}</b><span>falhas</span></div>
        <div class="daybox__stat"><b>${fmtKm(dayTotals.km)}</b><span>km no dia</span></div>
      </div>
      ${dayTime ? html`<div class="daybox__row daybox__row--time">
        <div class="daybox__stat"><b>${fmtDuracao(dayTime.minutos)}</b><span>${dayTime.emAndamento ? "tempo até agora" : "tempo total"}</span></div>
        <div class="daybox__stat"><b>${dayTime.porPacote != null ? dayTime.porPacote.toFixed(1) + " min" : "—"}</b><span>média por pacote</span></div>
      </div>` : null}
    </div>` : (dayTime && counts.total > 0 ? html`<div class="timebox">
      <${Icon} name="history" width="16" height="16"/>
      <span><b>${fmtDuracao(dayTime.minutos)}</b> ${dayTime.emAndamento ? "rodando" : "no total"}${dayTime.porPacote != null ? html` <span class="muted">• ${dayTime.porPacote.toFixed(1)} min/pacote</span>` : ""}</span>
    </div>` : null)}

    ${dayMoney && dayTotals.entregues > 0
      ? html`<div class=${"moneybox " + (dayMoney.lucro >= 0 ? "moneybox--ok" : "moneybox--bad")}>
          <div class="moneybox__lbl">${dayMoney.lucro >= 0 ? "✅ Compensou hoje" : "⚠️ Não compensou hoje"}</div>
          <div class="moneybox__lucro">${dayMoney.lucro >= 0 ? "+" : ""}${fmtMoney(dayMoney.lucro)}</div>
          <div class="moneybox__row">
            <div class="moneybox__stat"><b>${fmtMoney(dayMoney.ganho)}</b><span>ganho (${dayTotals.entregues} entregas)</span></div>
            <div class="moneybox__stat"><b>-${fmtMoney(dayMoney.custoComb)}</b><span>combustível (${dayMoney.litros.toFixed(1)} L)</span></div>
          </div>
        </div>`
      : (counts.total > 0 ? html`<button class="btn btn--ghost moneybox__cta" onClick=${onConfig}><${Icon} name="gear" width="16" height="16"/> Configure os custos pra ver se compensou hoje</button>` : null)}

    <div class="stats">
      <div class="stat stat--royal"><div class="stat__num">${counts.total}</div><div class="stat__lbl">Pacotes${rotaNum > 1 ? " (rota)" : ""}</div></div>
      <div class="stat stat--ok"><div class="stat__num">${counts.delivered}</div><div class="stat__lbl">Entregues</div></div>
      <div class="stat"><div class="stat__num">${fmtKm(totalKm)}</div><div class="stat__lbl">KM rota</div></div>
    </div>

    ${counts.total === 0
      ? html`<div class="card">
          <div class="card__title" style="margin-bottom:6px">${rotaNum > 1 ? `Rota ${rotaNum} — comece a bipar` : "Comece o dia"}</div>
          <p class="muted small" style="margin-top:0">Aponte a câmera para a etiqueta de cada pacote — a IA lê o endereço sozinha e monta a melhor rota.</p>
          <button class="btn btn--lg" onClick=${onCapture}><${Icon} name="camera" width="20" height="20"/> Bipar etiquetas</button>
          <button class="btn btn--ghost" style="margin-top:10px" onClick=${onImport}><${Icon} name="upload" width="18" height="18"/> Importar planilha / digitar</button>
        </div>`
      : html`<div class="card">
          <div class="row row--between" style="margin-bottom:12px">
            <div><div class="card__title">Rota ${rotaNum} do dia</div>
              <div class="muted small">${hasRoute ? `${counts.stops} parada${counts.stops !== 1 ? "s" : ""} • ${counts.total} pacote${counts.total !== 1 ? "s" : ""}` : "Ainda não otimizada"}</div></div>
            ${hasRoute ? html`<span class="chip chip--delivered">Pronta</span>` : html`<span class="chip chip--warn">Pendente</span>`}
          </div>
          <button class="btn btn--lg" disabled=${optimizing} onClick=${onOptimize}>
            ${optimizing ? html`<span class="spinner"></span> Otimizando...` : html`<${Icon} name="nav" width="20" height="20"/> ${hasRoute ? "Recalcular melhor rota" : "Otimizar rota"}`}
          </button>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn btn--navy" onClick=${onCapture}><${Icon} name="camera" width="18" height="18"/> Bipar mais</button>
            <button class="btn btn--ghost" onClick=${onConfig}><${Icon} name="flag" width="18" height="18"/> Galpão</button>
          </div>
          <button class="btn btn--ghost btn--newroute" style="margin-top:10px" onClick=${onNovaRota}>
            <${Icon} name="plus" width="18" height="18"/> Fechar rota e começar nova</button>
        </div>`}

    ${counts.semLocal > 0
      ? html`<div class="card card--danger">
          <div class="row" style="gap:10px"><${Icon} name="x" width="22" height="22" style=${{ color: "var(--danger)", flex: "none" }}/>
          <div><b>${counts.semLocal} endereço${counts.semLocal !== 1 ? "s" : ""} não localizado${counts.semLocal !== 1 ? "s" : ""}</b>
          <div class="muted small">${counts.semLocalPacotes} pacote${counts.semLocalPacotes !== 1 ? "s" : ""} ${counts.semLocalPacotes !== 1 ? "ficaram de fora" : "ficou de fora"} da rota otimizada. Corrija o endereço antes de sair.</div></div></div>
          <button class="btn btn--danger" style="margin-top:12px" onClick=${onVerSemLocal}>Ver e corrigir</button>
        </div>`
      : null}

    ${!config.origin && counts.total > 0
      ? html`<div class="card" style="border-color:var(--warn);background:var(--warn-bg)">
          <div class="row" style="gap:10px"><${Icon} name="pin" width="22" height="22" style=${{ color: "var(--warn)", flex: "none" }}/>
          <div><b>Defina o ponto de partida</b><div class="muted small">Sem o galpão (ou sua localização), não dá pra calcular a rota.</div></div></div>
          <button class="btn btn--navy" style="margin-top:12px" onClick=${onConfig}>Definir ponto de partida</button>
        </div>`
      : null}

    ${isOwner ? html`<button class="btn btn--ghost" style="margin-top:14px" onClick=${onTeam}>
      <${Icon} name="users" width="18" height="18"/> Ver equipe (hoje)</button>` : null}
    <button class="btn btn--ghost" style="margin-top:10px" onClick=${onRotasDia}>
      <${Icon} name="history" width="18" height="18"/> Rotas de hoje (este login)</button>
  </main>`;
}

/* ============================ Capture (foto da etiqueta -> IA) ============================ */
function CaptureView({ token, onAdd, onClose, count }) {
  const videoRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [conf, setConf] = useState(null);   // dados lidos a conferir
  const [photo, setPhoto] = useState(null); // thumb da foto

  useEffect(() => {
    let alive = true;
    startCamera(videoRef.current).catch((e) => { toast(e.message || "Câmera indisponível", "err"); onClose(); });
    return () => { alive = false; stopCamera(); };
  }, []);

  const capturar = async () => {
    if (busy) return;
    const dataUrl = capturePhoto(videoRef.current);
    setPhoto(dataUrl);
    setBusy(true);
    try {
      const r = await lerEtiqueta(dataUrl);
      if (r.ok && r.dados) { setConf(r.dados); }
      else { toast(r.error || "Não consegui ler. Edite na mão.", "err"); setConf(emptyConf()); }
    } catch (e) {
      toast(e.message || "Erro ao ler etiqueta", "err");
      setConf(emptyConf());
    }
    setBusy(false);
  };

  const manual = () => { setPhoto(null); setConf(emptyConf()); };
  const porCep = () => { setPhoto(null); setConf({ ...emptyConf(), _focusCep: true }); };

  const confirmar = (dados, keepGoing) => {
    onAdd(dados);
    setConf(null); setPhoto(null);
    if (!keepGoing) onClose();
  };

  return html`<div class="cap">
    <div class="cap__top">
      <div class="cap__count">Lidos hoje • ${count}</div>
      <button class="scan__close" onClick=${onClose}><${Icon} name="x" width="22" height="22"/></button>
    </div>
    <div class="cap__cam">
      <video ref=${videoRef} playsinline autoplay muted></video>
      <div class="cap__frame"></div>
      ${busy ? html`<div class="cap__loading"><span class="spinner spinner--lg"></span><div>Lendo a etiqueta com IA...</div></div>` : null}
    </div>
    <div class="cap__hint">Encaixe a <b>etiqueta inteira</b> no quadro e toque para ler. O endereço é preenchido sozinho.</div>
    <div class="cap__bar">
      <button class="cap__manual" onClick=${porCep}><${Icon} name="pin" width="20" height="20"/><span>Por CEP</span></button>
      <button class="cap__shutter" disabled=${busy} onClick=${capturar} aria-label="Capturar"></button>
      <button class="cap__manual" onClick=${manual}><${Icon} name="edit" width="20" height="20"/><span>Manual</span></button>
    </div>
    ${conf ? html`<${ConferSheet} dados=${conf} photo=${photo} onCancel=${() => { setConf(null); setPhoto(null); }} onConfirm=${confirmar} />` : null}
  </div>`;
}

/* ============================ Conferência ============================ */
function ConferSheet({ dados, photo, onConfirm, onCancel }) {
  const [d, setD] = useState({ ...emptyConf(), numero: "", ...dados });
  const [buscandoCep, setBuscandoCep] = useState(false);
  const cepInputRef = useRef(null);
  const nomeInputRef = useRef(null);
  const numeroInputRef = useRef(null);
  const viaCep = !!(dados && dados._focusCep); // veio do atalho "Por CEP" (sem foto)
  const set = (k) => (e) => setD((s) => ({ ...s, [k]: e.target.value }));

  // se "endereco" já veio com o número embutido (foto da etiqueta), separa pro campo Número
  useEffect(() => {
    if (dados && dados.endereco && !dados.numero) {
      const n = firstNumber(dados.endereco);
      if (n) {
        const semNum = dados.endereco.replace(new RegExp(`\\b${n}\\b`), "").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim().replace(/^,|,$/g, "").trim();
        setD((s) => ({ ...s, endereco: semNum || dados.endereco, numero: n }));
      }
    }
    if (viaCep) setTimeout(() => cepInputRef.current && cepInputRef.current.focus(), 200);
  }, []);

  const buscarCep = async (cepRaw) => {
    const cep = onlyDigits(cepRaw);
    if (cep.length !== 8) return;
    setBuscandoCep(true);
    try {
      const r = await fetch(`/api/cep?cep=${cep}`);
      const j = await r.json();
      if (j && j.found) {
        setD((s) => ({ ...s, endereco: j.endereco || s.endereco, bairro: j.bairro || s.bairro, cidade: j.cidade || s.cidade, uf: j.uf || s.uf, cep: cep }));
        toast("Endereço encontrado pelo CEP", "ok");
        // fluxo rápido: depois do CEP resolver, vai direto pro Nome (e depois Número)
        setTimeout(() => nomeInputRef.current && nomeInputRef.current.focus(), 150);
      } else {
        toast("CEP não encontrado — confira o número", "err");
      }
    } catch (e) { toast("Falha ao buscar o CEP", "err"); }
    finally { setBuscandoCep(false); }
  };

  const onCepInput = (e) => {
    const v = e.target.value;
    setD((s) => ({ ...s, cep: v }));
    if (onlyDigits(v).length === 8) buscarCep(v);
  };

  const add = (keepGoing) => {
    const enderecoFinal = [d.endereco.trim(), d.numero.trim()].filter(Boolean).join(", ");
    if (!enderecoFinal && !d.cidade.trim()) return toast("Preencha ao menos o endereço", "err");
    const { _focusCep, ...limpo } = d;
    onConfirm({ ...limpo, endereco: enderecoFinal }, keepGoing);
  };

  return html`<div class="sheet-bg" onClick=${onCancel}>
    <div class="sheet" onClick=${(e) => e.stopPropagation()}>
      <div class="sheet__grip"></div>
      <div class="row row--between"><div class="sheet__title">${viaCep ? "Endereço por CEP" : "Confira o endereço"}</div>
        ${photo ? html`<img src=${photo} class="confer__thumb" alt="etiqueta" />` : null}</div>
      <p class="sheet__sub">${viaCep ? "Informe o CEP — a rua, bairro e cidade vêm sozinhos. Só falta o nome e o número." : "A IA leu isto. Ajuste se precisar e adicione."}</p>

      ${viaCep ? html`
        <div class="field field--cep">
          <label>CEP</label>
          <div class="cepwrap">
            <input ref=${cepInputRef} class="input" inputmode="numeric" value=${d.cep} onInput=${onCepInput} placeholder="00000-000" maxlength="9" autofocus />
            ${buscandoCep ? html`<span class="spinner cepwrap__spin"></span>` : null}
          </div>
        </div>
        <div class="field"><label>Destinatário</label><input ref=${nomeInputRef} class="input" value=${d.nome} onInput=${set("nome")} placeholder="Nome do cliente" /></div>
        <div class="grid-addr">
          <div class="field field--rua"><label>Rua / Avenida</label><input class="input" value=${d.endereco} onInput=${set("endereco")} placeholder="Preenchido pelo CEP" /></div>
          <div class="field field--num"><label>Número</label><input ref=${numeroInputRef} class="input" inputmode="numeric" value=${d.numero} onInput=${set("numero")} placeholder="Nº na embalagem" /></div>
        </div>
      ` : html`
        <div class="field"><label>Destinatário</label><input class="input" value=${d.nome} onInput=${set("nome")} placeholder="Nome do cliente" /></div>
        <div class="field field--cep">
          <label>CEP <span class="muted small">(preenche o endereço sozinho)</span></label>
          <div class="cepwrap">
            <input class="input" inputmode="numeric" value=${d.cep} onInput=${onCepInput} placeholder="00000-000" maxlength="9" />
            ${buscandoCep ? html`<span class="spinner cepwrap__spin"></span>` : null}
          </div>
        </div>
        <div class="grid-addr">
          <div class="field field--rua"><label>Rua / Avenida</label><input class="input" value=${d.endereco} onInput=${set("endereco")} placeholder="Preenchido pelo CEP" /></div>
          <div class="field field--num"><label>Número</label><input class="input" inputmode="numeric" value=${d.numero} onInput=${set("numero")} placeholder="Nº na embalagem" /></div>
        </div>
      `}

      <div class="grid2">
        <div class="field"><label>Bairro</label><input class="input" value=${d.bairro} onInput=${set("bairro")} /></div>
        <div class="field"><label>Complemento</label><input class="input" value=${d.complemento || ""} onInput=${set("complemento")} placeholder="Apto, bloco..." /></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Cidade</label><input class="input" value=${d.cidade} onInput=${set("cidade")} /></div>
        <div class="field"><label>UF</label><input class="input" value=${d.uf} onInput=${set("uf")} maxlength="2" /></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Código</label><input class="input" value=${d.codigo} onInput=${set("codigo")} /></div>
        <div class="field"><label>Telefone</label><input class="input" value=${d.telefone} onInput=${set("telefone")} /></div>
      </div>
      <button class="btn btn--lg btn--ok" onClick=${() => add(true)}><${Icon} name="check" width="20" height="20"/> Adicionar e bipar próximo</button>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn--ghost" onClick=${() => add(false)}>Adicionar e fechar</button>
        <button class="btn btn--ghost" onClick=${onCancel}>Refazer foto</button>
      </div>
    </div>
  </div>`;
}

/* ============================ Scanner screen (numerar) ============================ */
function ScannerView({ mode, onMatch, onClose, count }) {
  const elId = "reader";
  useEffect(() => {
    let active = true;
    startScanner(elId, (decoded) => { if (active) onMatch(decoded); }).catch((e) => {
      toast(e.message || "Não foi possível abrir a câmera", "err");
      onClose();
    });
    return () => { active = false; stopScanner(); };
  }, []);

  return html`<div class="scan">
    <div class="scan__top">
      <div class="scan__count">${mode === "separate" ? "Numerando" : "Entregando"} • ${count}</div>
      <button class="scan__close" onClick=${onClose}><${Icon} name="x" width="22" height="22"/></button>
    </div>
    <div class="scan__cam"><div id=${elId}></div>
      <div class="scan__frame"><div class="scan__box"><i></i><div class="scan__laser"></div></div></div>
    </div>
    <div class="scan__hint">${mode === "separate"
      ? "Bipe o código de barras do pacote. O número da parada aparece — escreva no pacote."
      : "Bipe o pacote para confirmar a entrega."}</div>
  </div>`;
}

/* ============================ Scan result (número GIGANTE) ============================ */
function ScanResult({ result, onNext }) {
  useEffect(() => {
    if (result.kind === "ok-separate") feedback("ok");
    else if (result.kind === "delivered") feedback("ok");
    else if (result.kind === "dup") feedback("dup");
    else feedback("bad");
    const t = setTimeout(onNext, result.kind === "ok-separate" ? 2200 : 1600);
    return () => clearTimeout(t);
  }, []);

  let cls = "scanres--ok", label = "", num = "", name = "", addr = "", msg = "";
  if (result.kind === "ok-separate") {
    label = "Parada nº"; num = result.stop.order; name = result.stop.name; addr = result.stop.address;
  } else if (result.kind === "delivered") {
    label = "Entregue ✓"; num = result.stop.order; name = result.stop.name;
    msg = result.next ? `Próxima: parada ${result.next.order}` : "Última entrega do dia!";
  } else if (result.kind === "dup") {
    cls = "scanres--dup"; label = "Já numerado"; num = result.stop.order; name = result.stop.name;
  } else if (result.kind === "not-found") {
    cls = "scanres--bad"; msg = "Pacote não está na lista de hoje"; name = result.code;
  } else if (result.kind === "no-route") {
    cls = "scanres--dup"; msg = "Otimize a rota antes de numerar"; name = result.stop?.name || "";
  }

  return html`<div class=${"scanres " + cls} onClick=${onNext}>
    <div class="scanres__label">${label}</div>
    ${num !== "" ? html`<div class="scanres__num">${num}</div>` : null}
    ${name ? html`<div class="scanres__name">${name}</div>` : null}
    ${addr ? html`<div class="scanres__addr">${addr}</div>` : null}
    ${msg ? html`<div class="scanres__msg">${msg}</div>` : null}
  </div>`;
}

/* ============================ Numerar por FOTO (IA lê de novo e acha a parada) ============================ */
function NumberView({ stops, onSeparate, onClose, count }) {
  const videoRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { kind, stop }
  const [pick, setPick] = useState(null);      // { candidates, dados }
  const [porCep, setPorCep] = useState(false);
  const [cepBusca, setCepBusca] = useState("");
  const camOn = !result && !pick && !porCep;

  useEffect(() => {
    if (!camOn) return;
    startCamera(videoRef.current).catch((e) => { toast(e.message || "Câmera indisponível", "err"); onClose(); });
    return () => stopCamera();
  }, [camOn]);

  const ler = async () => {
    if (busy) return;
    const dataUrl = capturePhoto(videoRef.current);
    setBusy(true);
    try {
      const r = await lerEtiqueta(dataUrl);
      const dados = r.ok && r.dados ? r.dados : null;
      if (!dados) { toast(r.error || "Não consegui ler. Escolha na lista.", "err"); setBusy(false); setPick({ candidates: [], dados: emptyConf() }); return; }
      const m = matchStopByAddress(stops, dados);
      setBusy(false);
      if (m.best && m.confident) setResult(onSeparate(m.best));
      else setPick({ candidates: m.candidates, dados });
    } catch (e) { setBusy(false); toast(e.message || "Erro ao ler", "err"); setPick({ candidates: [], dados: emptyConf() }); }
  };

  const choose = (stop) => { setPick(null); setPorCep(false); setCepBusca(""); setResult(onSeparate(stop)); };
  const reset = () => { setResult(null); setPick(null); setPorCep(false); setCepBusca(""); };

  // busca as paradas da rota com o CEP informado — mais certeiro e rápido que a câmera
  const buscarPorCep = (cepRaw) => {
    const cep = onlyDigits(cepRaw);
    setCepBusca(cepRaw);
    if (cep.length !== 8) return;
    const achadas = stops.filter((s) => onlyDigits((s.geo && s.geo.cep) || "") === cep && s.order);
    if (!achadas.length) { toast("Nenhuma parada desta rota tem esse CEP", "err"); return; }
    if (achadas.length === 1) { choose(achadas[0]); return; }
    setPorCep(false);
    setPick({ candidates: achadas, dados: { ...emptyConf(), nome: `CEP ${cepRaw}` } });
  };

  if (result) return html`<${NumberResult} result=${result} onNext=${reset} onClose=${onClose} />`;

  if (porCep) {
    return html`<div class="cap">
      <div class="cap__top">
        <div class="cap__count">Numerar pelo CEP</div>
        <button class="scan__close" onClick=${onClose}><${Icon} name="x" width="22" height="22"/></button>
      </div>
      <div class="pick">
        <p class="pick__hint">Digite o CEP da embalagem. O app mostra qual parada (e número) é da rota de hoje.</p>
        <div class="field field--cep" style="margin-top:10px">
          <label>CEP</label>
          <input class="input" inputmode="numeric" autofocus value=${cepBusca} onInput=${(e) => buscarPorCep(e.target.value)} placeholder="00000-000" maxlength="9" />
        </div>
        <button class="btn btn--ghost" style="margin-top:14px" onClick=${reset}>Voltar para a câmera</button>
      </div>
    </div>`;
  }

  if (pick) {
    const all = [...stops].filter((s) => s.order).sort((a, b) => a.order - b.order);
    const list = pick.candidates.length ? pick.candidates : all;
    const viaCepPick = pick.dados && pick.dados.nome && pick.dados.nome.startsWith("CEP ");
    return html`<div class="cap">
      <div class="cap__top">
        <div class="cap__count">Qual encomenda?</div>
        <button class="scan__close" onClick=${onClose}><${Icon} name="x" width="22" height="22"/></button>
      </div>
      <div class="pick">
        <p class="pick__hint">${viaCepPick ? "Mais de uma parada com esse CEP — confira nome e endereço e toque na certa:" : pick.candidates.length ? "Não tive certeza — toque na encomenda certa:" : "Não reconheci o endereço. Escolha na lista:"}</p>
        ${!viaCepPick ? html`<div class="pick__read">Lido: <b>${pick.dados.nome || "—"}</b>${montarEndereco(pick.dados) ? ` · ${montarEndereco(pick.dados)}` : ""}</div>` : null}
        ${list.map((s) => html`<button class="pick__item" onClick=${() => choose(s)}>
          <div class=${"pick__num" + (s.status === "separated" || s.status === "delivered" ? " pick__num--done" : "")}>${s.order}</div>
          <div class="pick__info"><div class="pick__name">${s.name}${pkgCount(s) > 1 ? html` <span class="qty-badge">${pkgCount(s)}</span>` : ""}</div><div class="pick__addr">${s.address}</div></div>
        </button>`)}
        ${pick.candidates.length && !viaCepPick ? html`<button class="btn btn--ghost" onClick=${() => setPick({ candidates: [], dados: pick.dados })}>Mostrar todas as paradas</button>` : null}
        <button class="btn btn--ghost" onClick=${reset}>${viaCepPick ? "Buscar outro CEP" : "Tirar outra foto"}</button>
      </div>
    </div>`;
  }

  return html`<div class="cap">
    <div class="cap__top">
      <div class="cap__count">Numerados • ${count}</div>
      <button class="scan__close" onClick=${onClose}><${Icon} name="x" width="22" height="22"/></button>
    </div>
    <div class="cap__cam">
      <video ref=${videoRef} playsinline autoplay muted></video>
      <div class="cap__frame"></div>
      ${busy ? html`<div class="cap__loading"><span class="spinner spinner--lg"></span><div>Lendo a etiqueta...</div></div>` : null}
    </div>
    <div class="cap__hint">Fotografe a <b>etiqueta</b> de novo. O app acha a parada e mostra o <b>número</b> pra escrever no pacote.</div>
    <div class="cap__bar">
      <button class="cap__manual" onClick=${() => setPorCep(true)}><${Icon} name="pin" width="20" height="20"/><span>Por CEP</span></button>
      <button class="cap__shutter" disabled=${busy} onClick=${ler} aria-label="Ler etiqueta"></button>
      <div style="width:64px"></div>
    </div>
  </div>`;
}

function NumberResult({ result, onNext, onClose }) {
  useEffect(() => {
    if (result.kind === "ok-separate") feedback("ok");
    else if (result.kind === "dup") feedback("dup");
    else feedback("bad");
  }, []);

  let cls = "scanres--ok", label = "", num = "", name = "", addr = "", msg = "";
  if (result.kind === "ok-separate") {
    label = "Parada nº"; num = result.stop.order; name = result.stop.name; addr = result.stop.address;
    if (pkgCount(result.stop) > 1) msg = `${pkgCount(result.stop)} pacotes aqui — escreva ${result.stop.order} em todos`;
  }
  else if (result.kind === "dup") { cls = "scanres--dup"; label = "Já numerado"; num = result.stop.order; name = result.stop.name; addr = result.stop.address; }
  else if (result.kind === "no-route") { cls = "scanres--dup"; msg = "Otimize a rota antes de numerar"; name = result.stop?.name || ""; }

  return html`<div class=${"scanres " + cls}>
    <div class="scanres__label">${label}</div>
    ${num !== "" ? html`<div class="scanres__num">${num}</div>` : null}
    ${name ? html`<div class="scanres__name">${name}</div>` : null}
    ${addr ? html`<div class="scanres__addr">${addr}</div>` : null}
    ${msg ? html`<div class="scanres__msg">${msg}</div>` : null}
    <div class="scanres__actions">
      <button class="btn btn--lg btn--ok" onClick=${onNext}><${Icon} name="camera" width="20" height="20"/> Numerar próximo</button>
      <button class="btn btn--ghost btn--onlight" onClick=${onClose}>Fechar</button>
    </div>
  </div>`;
}

/* ============================ Map screen (rota real + GPS ao vivo) ============================ */
function MapView({ stops, config, onRecalc }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  const meRef = useRef(null);
  const posRef = useRef(null);
  const watchRef = useRef(null);
  const wakeRef = useRef(null);
  const [nav, setNav] = useState(false);
  const [routeInfo, setRouteInfo] = useState(null);

  const ordered = useMemo(() => stops.filter((s) => s.geocoded && s.order).sort((a, b) => a.order - b.order), [stops]);
  const totalPacotes = useMemo(() => ordered.reduce((n, s) => n + pkgCount(s), 0), [ordered]);
  const pendentesPacotes = useMemo(() => ordered.reduce((n, s) => n + (s.status === "delivered" ? 0 : pkgCount(s)), 0), [ordered]);

  // desenha mapa + markers + rota real
  useEffect(() => {
    const L = window.L;
    if (!L || !ref.current) return;
    const center = config.origin || ordered[0] || { lat: -21.255, lng: -48.322 };
    const map = L.map(ref.current, { zoomControl: false }).setView([center.lat, center.lng], 13);
    mapRef.current = map;
    const token = config.mapboxToken;
    if (token) {
      L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`,
        { tileSize: 512, zoomOffset: -1, maxZoom: 20, attribution: "© Mapbox © OpenStreetMap" }).addTo(map);
    } else {
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    }

    const bounds = [];
    if (config.origin) {
      L.marker([config.origin.lat, config.origin.lng], {
        icon: L.divIcon({ className: "", html: `<div class="leaflet-marker-num" style="background:#0d152e"><span>🏠</span></div>`, iconSize: [30, 30], iconAnchor: [15, 28] }),
      }).addTo(map).bindPopup("Ponto de partida");
      bounds.push([config.origin.lat, config.origin.lng]);
    }
    const straight = config.origin ? [[config.origin.lat, config.origin.lng]] : [];
    ordered.forEach((s) => {
      const multi = pkgCount(s) > 1;
      const color = s.status === "delivered" ? "#15a34a" : s.status === "failed" ? "#dc2626" : (multi ? "#dc2626" : "#2B5CE6");
      const badge = multi ? `<i class="marker-qty">${pkgCount(s)}</i>` : "";
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: "", html: `<div class="marker-wrap"><div class="leaflet-marker-num" style="background:${color}"><span>${s.order}</span></div>${badge}</div>`, iconSize: [30, 30], iconAnchor: [15, 28] }),
      }).addTo(map).bindPopup(`<b>${s.order}. ${s.name}</b><br>${s.address}${multi ? `<br><b style="color:#dc2626">${pkgCount(s)} pacotes neste endereço</b>` : ""}`);
      straight.push([s.lat, s.lng]);
      bounds.push([s.lat, s.lng]);
    });
    if (config.finishAtOrigin && config.origin) straight.push([config.origin.lat, config.origin.lng]);

    // linha reta provisória (enquanto carrega a rota real)
    let routeLayer = straight.length > 1
      ? L.polyline(straight, { color: "#2B5CE6", weight: 3, opacity: 0.45, dashArray: "1 8", lineCap: "round" }).addTo(map)
      : null;
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });

    // rota REAL nas ruas (assíncrona)
    let cancelled = false;
    if (token && ordered.length) {
      routeGeometry(config.origin, ordered, { token, finishAtOrigin: config.finishAtOrigin })
        .then((r) => {
          if (cancelled || !r || !r.line.length) return;
          if (routeLayer) map.removeLayer(routeLayer);
          routeLayer = L.polyline(r.line, { color: "#2B5CE6", weight: 5, opacity: 0.85, lineCap: "round", lineJoin: "round" }).addTo(map);
          setRouteInfo({ km: r.km, min: r.min });
        }).catch(() => {});
    }

    // re-desenha "você" se já tem posição
    if (posRef.current) drawMe(posRef.current, false);

    return () => { cancelled = true; map.remove(); mapRef.current = null; meRef.current = null; };
  }, [ordered, config]);

  function drawMe(pos, follow) {
    const L = window.L, map = mapRef.current;
    if (!L || !map) return;
    if (meRef.current) meRef.current.setLatLng([pos.lat, pos.lng]);
    else meRef.current = L.marker([pos.lat, pos.lng], {
      icon: L.divIcon({ className: "", html: `<div class="me-dot"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 1000,
    }).addTo(map);
    if (follow) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16), { animate: true });
  }

  // liga/desliga navegação ao vivo (GPS + tela acesa)
  useEffect(() => {
    if (!nav) return;
    if (!navigator.geolocation) { toast("GPS indisponível", "err"); setNav(false); return; }
    // tela sempre ligada
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen").then((s) => { wakeRef.current = s; }).catch(() => {});
    }
    watchRef.current = navigator.geolocation.watchPosition(
      (p) => { posRef.current = { lat: p.coords.latitude, lng: p.coords.longitude }; drawMe(posRef.current, true); },
      () => toast("Não consegui pegar sua localização", "err"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 }
    );
    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      try { wakeRef.current?.release(); } catch {}
      wakeRef.current = null;
    };
  }, [nav]);

  const hasRoute = ordered.length > 0;
  return html`<div class="map-screen">
    <div class="map-wrap" style="position:relative;flex:1">
      <div id="map" ref=${ref}></div>
      ${!hasRoute ? html`<div class="empty" style="position:absolute;inset:0;background:var(--bg);display:flex;flex-direction:column;justify-content:center">
        <div class="empty__icon">🗺️</div><div class="empty__title">Sem rota ainda</div>
        <div>Bipe as etiquetas e otimize a rota na tela Início.</div></div>` : null}

      ${hasRoute ? html`<div class="route-bar">
        <div class="route-bar__top">
          ${routeInfo ? html`<div class="route-bar__info"><b>${fmtKm(routeInfo.km)} km</b> • ${routeInfo.min} min</div>` : html`<div class="route-bar__info muted">calculando rota real…</div>`}
          <div class="route-bar__pkg"><b>${totalPacotes}</b> pacote${totalPacotes !== 1 ? "s" : ""} <span class="muted">•</span> <b>${ordered.length}</b> parada${ordered.length !== 1 ? "s" : ""}${pendentesPacotes !== totalPacotes ? html` <span class="muted">• ${pendentesPacotes} restam</span>` : ""}</div>
        </div>
        <div class="route-bar__btns">
          <button class="route-bar__recalc" onClick=${onRecalc} title="Recalcular a partir da minha posição">
            <${Icon} name="location" width="16" height="16"/> Daqui
          </button>
          <button class=${"route-bar__nav " + (nav ? "is-on" : "")} onClick=${() => setNav((v) => !v)}>
            <${Icon} name="nav" width="18" height="18"/> ${nav ? "Parar" : "Navegar"}
          </button>
        </div>
      </div>` : null}
    </div>
  </div>`;
}

/* ============================ Delivery list ============================ */
function ListView({ stops, onOpen, onScanDeliver, onAvisarProximo }) {
  const ordered = useMemo(() => {
    const withOrder = stops.filter((s) => s.order).sort((a, b) => a.order - b.order);
    const without = stops.filter((s) => !s.order);
    return [...withOrder, ...without];
  }, [stops]);

  // fila de avisos "saiu para entrega": só conta quem tem telefone, ainda não foi avisado, e está pendente
  const filaAvisar = useMemo(() => ordered.filter((s) =>
    (s.phone || "").replace(/\D/g, "") && !s.avisoSaiuEm && s.status !== "delivered" && s.status !== "failed"
  ), [ordered]);

  if (!stops.length)
    return html`<main class="main"><div class="empty">
      <div class="empty__icon">📦</div><div class="empty__title">Nenhuma entrega</div>
      <div>Bipe as etiquetas na tela Início.</div></div></main>`;

  return html`<main class="main">
    <button class="btn btn--ok btn--lg" style="margin-bottom:14px" onClick=${onScanDeliver}>
      <${Icon} name="scan" width="20" height="20"/> Bipar entrega</button>

    ${filaAvisar.length > 0 ? html`<button class="btn btn--navy avisarfila" style="margin-bottom:14px" onClick=${() => onAvisarProximo(filaAvisar[0])}>
      <${Icon} name="truck" width="18" height="18"/> Avisar próximo cliente (${filaAvisar.length} pendente${filaAvisar.length !== 1 ? "s" : ""})
    </button>` : null}

    <div class="card card--flush">
      ${ordered.map((s) => html`<div key=${s.id} class=${"stop stop--" + s.status} onClick=${() => onOpen(s)}>
        <div class=${"stop__num" + (pkgCount(s) > 1 ? " stop__num--multi" : "")}>${s.order || "–"}</div>
        <div class="stop__body">
          <div class="stop__name">${s.name}${pkgCount(s) > 1 ? html` <span class="qty-badge">${pkgCount(s)} pacotes</span>` : ""}</div>
          <div class="stop__addr">${s.address}</div>
          <div class="stop__meta">
            <span class=${"chip chip--" + s.status}>${s.status === "pending" ? "Pendente" : s.status === "separated" ? "Numerado" : s.status === "delivered" ? "Entregue" : "Falhou"}</span>
            ${s.code ? html`<span class="tag-code">${s.code}</span>` : null}
            ${s.avisoSaiuEm ? html`<span class="chip chip--separated">Avisado</span>` : null}
          </div>
        </div>
        <div class="stop__chevron">›</div>
      </div>`)}
    </div>
  </main>`;
}

/* ============================ Sheet base ============================ */
function Sheet({ title, sub, children, onClose }) {
  return html`<div class="sheet-bg" onClick=${onClose}>
    <div class="sheet" onClick=${(e) => e.stopPropagation()}>
      <div class="sheet__grip"></div>
      <div class="sheet__title">${title}</div>
      ${sub ? html`<p class="sheet__sub">${sub}</p>` : null}
      ${children}
    </div>
  </div>`;
}

/* ============================ Import sheet (planilha / manual) ============================ */
function ImportSheet({ onClose, onAddStops }) {
  const [tab, setTab] = useState("csv");
  const [text, setText] = useState("");
  const [m, setM] = useState({ code: "", name: "", address: "", phone: "" });
  const fileRef = useRef(null);

  const doCSV = () => {
    if (!text.trim()) return toast("Cole os dados ou escolha um arquivo", "err");
    const { stops, total, skipped } = parseCSV(text);
    if (!total) return toast("Não encontrei entregas válidas", "err");
    onAddStops(stops);
    toast(`${total} entrega(s) importada(s)${skipped ? ` • ${skipped} ignorada(s)` : ""}`, "ok");
    onClose();
  };
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setText(String(r.result || "")); toast("Arquivo carregado, confira e importe"); };
    r.readAsText(f, "utf-8");
  };
  const addManual = () => {
    if (!m.address.trim()) return toast("Informe o endereço", "err");
    const ll = parseLatLng(m.address);
    onAddStops([{
      id: uid(), code: m.code.trim(), name: m.name.trim() || "Sem nome", address: m.address.trim(),
      phone: m.phone.trim(), note: "", lat: ll?.lat, lng: ll?.lng, geocoded: !!ll,
      geoError: false, order: null, status: "pending", failReason: "", deliveredAt: null,
    }]);
    toast("Entrega adicionada", "ok");
    setM({ code: "", name: "", address: "", phone: "" });
  };

  return html`<${Sheet} title="Importar / digitar" sub="Use só se não for bipar a etiqueta." onClose=${onClose}>
    <div class="btn-row" style="margin-bottom:14px">
      <button class=${"btn " + (tab === "csv" ? "" : "btn--ghost")} onClick=${() => setTab("csv")}>Planilha / CSV</button>
      <button class=${"btn " + (tab === "manual" ? "" : "btn--ghost")} onClick=${() => setTab("manual")}>Manual</button>
    </div>
    ${tab === "csv"
      ? html`<div>
          <input ref=${fileRef} type="file" accept=".csv,.txt,text/csv" style="display:none" onChange=${onFile} />
          <button class="btn btn--ghost" style="margin-bottom:10px" onClick=${() => fileRef.current?.click()}>
            <${Icon} name="upload" width="18" height="18"/> Escolher arquivo .csv</button>
          <div class="field">
            <label>ou cole aqui (uma entrega por linha)</label>
            <textarea class="textarea" placeholder=${"codigo;nome;endereco;telefone\nAME001;João Silva;Rua A, 100, Jaboticabal SP;16998887777"} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
          </div>
          <p class="muted small" style="margin-top:-4px">Colunas: <b>codigo, nome, endereco, telefone</b> (e opcionalmente <b>lat, lng</b>). Separador <b>;</b> ou <b>,</b>.</p>
          <button class="btn btn--lg" onClick=${doCSV}>Importar lista</button>
        </div>`
      : html`<div>
          <div class="field"><label>Código do pacote</label><input class="input" value=${m.code} onInput=${(e) => setM({ ...m, code: e.target.value })} placeholder="AME001" /></div>
          <div class="field"><label>Destinatário</label><input class="input" value=${m.name} onInput=${(e) => setM({ ...m, name: e.target.value })} placeholder="Nome do cliente" /></div>
          <div class="field"><label>Endereço completo</label><input class="input" value=${m.address} onInput=${(e) => setM({ ...m, address: e.target.value })} placeholder="Rua, nº, bairro, cidade UF" /></div>
          <div class="field"><label>Telefone / WhatsApp</label><input class="input" value=${m.phone} onInput=${(e) => setM({ ...m, phone: e.target.value })} placeholder="(16) 99888-7777" /></div>
          <button class="btn btn--lg" onClick=${addManual}><${Icon} name="plus" width="18" height="18"/> Adicionar entrega</button>
          <button class="btn btn--ghost" style="margin-top:10px" onClick=${onClose}>Concluir</button>
        </div>`}
  </${Sheet}>`;
}

/* ============================ Config sheet ============================ */
function ConfigSheet({ config, session, onClose, onSave, onClearDay, onLogout }) {
  const [origAddr, setOrigAddr] = useState(config.origin?.label || "");
  const [finish, setFinish] = useState(!!config.finishAtOrigin);
  const [token, setToken] = useState(config.mapboxToken || "");
  const [busy, setBusy] = useState(false);
  const [consumo, setConsumo] = useState(config.kmPorLitro != null ? String(config.kmPorLitro) : "");
  const [precoComb, setPrecoComb] = useState(config.precoCombustivel != null ? String(config.precoCombustivel) : "");
  const [valorPct, setValorPct] = useState(config.valorPorPacote != null ? String(config.valorPorPacote) : "");

  const salvarCustos = () => {
    onSave({
      ...config,
      kmPorLitro: consumo ? Number(String(consumo).replace(",", ".")) : null,
      precoCombustivel: precoComb ? Number(String(precoComb).replace(",", ".")) : null,
      valorPorPacote: valorPct ? Number(String(valorPct).replace(",", ".")) : null,
    });
    toast("Custos salvos", "ok");
  };

  const useGPS = async () => {
    setBusy(true);
    try {
      const p = await getCurrentPosition();
      onSave({ ...config, origin: { lat: p.lat, lng: p.lng, label: "Minha localização atual" }, finishAtOrigin: finish, mapboxToken: token });
      toast("Ponto de partida definido pela sua localização", "ok");
      onClose();
    } catch { toast("Não consegui pegar o GPS", "err"); }
    setBusy(false);
  };
  const useAddr = async () => {
    if (!origAddr.trim()) return toast("Informe o endereço do galpão", "err");
    setBusy(true);
    try {
      const ll = parseLatLng(origAddr) || (await geocodeOne(origAddr, token));
      if (!ll) { toast("Endereço não encontrado", "err"); setBusy(false); return; }
      onSave({ ...config, origin: { ...ll, label: origAddr.trim() }, finishAtOrigin: finish, mapboxToken: token });
      toast("Ponto de partida salvo", "ok");
      onClose();
    } catch (e) { toast(e.message || "Falha ao localizar endereço", "err"); }
    setBusy(false);
  };

  return html`<${Sheet} title="Configurações" sub=${`Logado como ${session?.nome || "Entregador"}.`} onClose=${onClose}>
    <div class="field"><label>Endereço do galpão / ponto de partida</label>
      <input class="input" value=${origAddr} onInput=${(e) => setOrigAddr(e.target.value)} placeholder="Rua do galpão, nº, cidade UF" /></div>
    <div class="btn-row">
      <button class="btn" disabled=${busy} onClick=${useAddr}>${busy ? html`<span class="spinner"></span>` : "Salvar endereço"}</button>
      <button class="btn btn--ghost" disabled=${busy} onClick=${useGPS}><${Icon} name="location" width="18" height="18"/> Usar GPS</button>
    </div>
    ${config.origin ? html`<p class="muted small">Atual: ${config.origin.label}</p>` : null}

    <div class="divider"></div>
    <label class="row row--between" style="cursor:pointer">
      <span><b>Voltar ao galpão no fim</b><div class="muted small">Inclui o retorno no cálculo de KM</div></span>
      <input type="checkbox" checked=${finish} onChange=${(e) => { setFinish(e.target.checked); onSave({ ...config, finishAtOrigin: e.target.checked }); }} style="width:22px;height:22px" />
    </label>

    <div class="divider"></div>
    <div class="field"><label>Chave do Mapbox</label>
      <input class="input" value=${token} onInput=${(e) => setToken(e.target.value)} placeholder="pk.eyJ1Ijoi..." onBlur=${() => onSave({ ...config, mapboxToken: token })} />
      <p class="muted small" style="margin-top:4px">${config.mapboxToken ? html`<b style="color:var(--ok)">✓ Chave salva</b>` : html`<b style="color:var(--danger)">Sem chave: mapa e endereços não funcionam</b>`}</p></div>
    <button class="btn btn--ghost" onClick=${() => { limparGeocache(); toast("Cache de endereços limpo. Otimize a rota de novo.", "ok"); }}>
      <${Icon} name="pin" width="18" height="18"/> Limpar cache de endereços</button>

    <div class="divider"></div>
    <div class="card__title" style="margin-bottom:2px">Custos da entrega</div>
    <p class="muted small" style="margin-top:0">Pra calcular se a rota compensou (combustível x ganho do dia).</p>
    <div class="grid2">
      <div class="field"><label>Consumo (km/litro)</label><input class="input" inputmode="decimal" value=${consumo} onInput=${(e) => setConsumo(e.target.value)} onBlur=${salvarCustos} placeholder="Ex.: 35" /></div>
      <div class="field"><label>Preço do combustível (R$/L)</label><input class="input" inputmode="decimal" value=${precoComb} onInput=${(e) => setPrecoComb(e.target.value)} onBlur=${salvarCustos} placeholder="Ex.: 6,10" /></div>
    </div>
    <div class="field"><label>Valor recebido por pacote (R$)</label>
      <input class="input" inputmode="decimal" value=${valorPct} onInput=${(e) => setValorPct(e.target.value)} onBlur=${salvarCustos} placeholder="Ex.: 4,50" /></div>

    <div class="divider"></div>
    <div class="btn-row">
      <button class="btn btn--ghost" onClick=${onLogout}><${Icon} name="logout" width="18" height="18"/> Sair</button>
      <button class="btn btn--danger" onClick=${() => { if (confirm("Apagar todas as entregas e zerar o dia?")) { onClearDay(); onClose(); } }}>
        <${Icon} name="x" width="18" height="18"/> Limpar dia</button>
    </div>
    <p class="muted small" style="text-align:center;margin-top:16px;opacity:.6">AM Express · Rotas — ${APP_VERSION}</p>
  </${Sheet}>`;
}

/* ============================ História ============================ */
function HistoricoSheet({ onClose }) {
  const dias = useMemo(() => listarHistorico(), []);
  const fmt = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

  return html`<${Sheet} title="Histórico de entregas" sub="Seu registro diário. Exporte o relatório da AM Express." onClose=${onClose}>
    ${!dias.length
      ? html`<div class="empty" style="padding:30px 0"><div class="empty__icon">📅</div><div>Nenhum dia registrado ainda.</div></div>`
      : html`<div>
          <button class="btn btn--lg" style="margin-bottom:14px" onClick=${() => exportarCSV(dias)}>
            <${Icon} name="download" width="20" height="20"/> Exportar relatório (CSV)</button>
          <div class="card card--flush">
            ${dias.map((r) => { const pct = r.total ? Math.round((r.entregues / r.total) * 100) : 0;
              return html`<div key=${r.data} class="histo">
                <div class="histo__date"><b>${fmt(r.data)}</b><span class="muted small">${r.entregador}</span></div>
                <div class="histo__nums">
                  <span><b>${r.entregues}</b>/${r.total} entreg.</span>
                  <span>${fmtKm(r.km)} km</span>
                  <span class=${"chip " + (pct >= 90 ? "chip--delivered" : "chip--warn")}>${pct}%</span>
                </div>
              </div>`; })}
          </div>
          <button class="btn btn--ghost" style="margin-top:12px" onClick=${() => { if (confirm("Apagar todo o histórico?")) { limparHistorico(); onClose(); toast("Histórico limpo"); } }}>Limpar histórico</button>
        </div>`}
  </${Sheet}>`;
}

/* ============================ Stop detail sheet ============================ */
function StopSheet({ stop, onClose, onUpdate, onDelete, onEditAddress, onRemovePkg, autoEdit }) {
  const g = stop.geo || {};
  const [editing, setEditing] = useState(!!autoEdit);
  const [buscandoCep, setBuscandoCep] = useState(false);
  const [f, setF] = useState({
    nome: stop.name || "", endereco: g.endereco || stop.address || "", numero: "",
    complemento: g.complemento || "", bairro: g.bairro || "",
    cidade: g.cidade || "", uf: g.uf || "", cep: g.cep || "", codigo: stop.code || "",
  });
  // separa o número embutido no endereço (compatibilidade com paradas antigas)
  useEffect(() => {
    const n = firstNumber(f.endereco);
    if (n && !f.numero) {
      const semNum = f.endereco.replace(new RegExp(`\\b${n}\\b`), "").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim().replace(/^,|,$/g, "").trim();
      setF((o) => ({ ...o, endereco: semNum || f.endereco, numero: n }));
    }
  }, []);
  const set = (k) => (e) => setF((o) => ({ ...o, [k]: e.target.value }));

  const buscarCep = async (cepRaw) => {
    const cep = onlyDigits(cepRaw);
    if (cep.length !== 8) return;
    setBuscandoCep(true);
    try {
      const r = await fetch(`/api/cep?cep=${cep}`);
      const j = await r.json();
      if (j && j.found) {
        setF((o) => ({ ...o, endereco: j.endereco || o.endereco, bairro: j.bairro || o.bairro, cidade: j.cidade || o.cidade, uf: j.uf || o.uf, cep }));
        toast("Endereço encontrado pelo CEP", "ok");
      } else { toast("CEP não encontrado — confira o número", "err"); }
    } catch (e) { toast("Falha ao buscar o CEP", "err"); }
    finally { setBuscandoCep(false); }
  };
  const onCepInput = (e) => {
    const v = e.target.value;
    setF((o) => ({ ...o, cep: v }));
    if (onlyDigits(v).length === 8) buscarCep(v);
  };

  const nav = () => {
    const q = stop.geocoded ? `${stop.lat},${stop.lng}` : encodeURIComponent(stop.address);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${q}`, "_blank");
  };
  const wpp = () => {
    const num = (stop.phone || "").replace(/\D/g, "");
    if (!num) return toast("Sem telefone cadastrado", "err");
    window.open(`https://wa.me/55${num}`, "_blank");
  };
  const wppMsg = (texto, flagCampo) => {
    const num = (stop.phone || "").replace(/\D/g, "");
    if (!num) return toast("Sem telefone cadastrado — não dá pra avisar este cliente", "err");
    window.open(`https://wa.me/55${num}?text=${encodeURIComponent(texto)}`, "_blank");
    if (flagCampo) onUpdate({ ...stop, [flagCampo]: Date.now() });
  };
  const primeiroNome = (stop.name || "").trim().split(" ")[0] || "";
  const avisarSaiu = () => wppMsg(
    `Olá${primeiroNome ? " " + primeiroNome : ""}! Aqui é da AM Express 📦\nSua entrega já saiu e está a caminho do seu endereço hoje. Em breve chegamos!`,
    "avisoSaiuEm"
  );
  const avisarPorta = () => wppMsg(
    `Olá${primeiroNome ? " " + primeiroNome : ""}! Aqui é da AM Express 🚪\nNosso entregador está na sua porta agora com a entrega. Pode atender, por favor?`,
    "avisoPortaEm"
  );
  const multi = pkgCount(stop) > 1;

  if (editing) {
    const salvar = () => {
      const enderecoFinal = [f.endereco.trim(), f.numero.trim()].filter(Boolean).join(", ");
      if (!enderecoFinal) return toast("Preencha o endereço", "err");
      onEditAddress(stop.id, { ...f, endereco: enderecoFinal });
      setEditing(false); onClose();
    };
    return html`<${Sheet} title="Editar endereço" sub="Corrija o que a IA leu errado" onClose=${() => setEditing(false)}>
      <div class="field"><label>Destinatário</label><input class="input" value=${f.nome} onInput=${set("nome")} /></div>
      <div class="field field--cep">
        <label>CEP <span class="muted small">(preenche o endereço sozinho)</span></label>
        <div class="cepwrap">
          <input class="input" inputmode="numeric" value=${f.cep} onInput=${onCepInput} placeholder="00000-000" maxlength="9" />
          ${buscandoCep ? html`<span class="spinner cepwrap__spin"></span>` : null}
        </div>
      </div>
      <div class="grid-addr">
        <div class="field field--rua"><label>Rua / Avenida</label><input class="input" value=${f.endereco} onInput=${set("endereco")} /></div>
        <div class="field field--num"><label>Número</label><input class="input" inputmode="numeric" value=${f.numero} onInput=${set("numero")} placeholder="Nº na embalagem" /></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Bairro</label><input class="input" value=${f.bairro} onInput=${set("bairro")} /></div>
        <div class="field"><label>Complemento</label><input class="input" value=${f.complemento} onInput=${set("complemento")} placeholder="Apto, bloco..." /></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Cidade</label><input class="input" value=${f.cidade} onInput=${set("cidade")} /></div>
        <div class="field"><label>UF</label><input class="input" value=${f.uf} onInput=${set("uf")} maxlength="2" /></div>
      </div>
      <div class="field"><label>Código</label><input class="input" value=${f.codigo} onInput=${set("codigo")} /></div>
      <button class="btn btn--lg" onClick=${salvar}>
        <${Icon} name="check" width="20" height="20"/> Salvar e localizar</button>
      <button class="btn btn--ghost" style="margin-top:10px" onClick=${() => setEditing(false)}>Cancelar</button>
    </${Sheet}>`;
  }

  return html`<${Sheet} title=${`${stop.order ? stop.order + ". " : ""}${stop.name}`} sub=${stop.address} onClose=${onClose}>
    <div class="row" style="gap:8px;margin-bottom:14px;flex-wrap:wrap">
      ${stop.code ? html`<span class="tag-code">${stop.code}</span>` : null}
      <span class=${"chip chip--" + stop.status}>${stop.status === "pending" ? "Pendente" : stop.status === "separated" ? "Numerado" : stop.status === "delivered" ? "Entregue" : "Falhou"}</span>
      ${multi ? html`<span class="qty-badge">${pkgCount(stop)} pacotes</span>` : null}
    </div>
    ${stop.note ? html`<p class="muted small">📝 ${stop.note}</p>` : null}
    ${multi ? html`<div class="pkgbox">
      <div class="pkgbox__title">${pkgCount(stop)} pacotes neste endereço</div>
      ${pkgsOf(stop).map((p, i) => html`<div class="pkgbox__item">
        <span class="pkgbox__n">${i + 1}</span>
        <span class="pkgbox__name">${p.name}${p.code ? html` <span class="tag-code">${p.code}</span>` : ""}</span>
        <button class="pkgbox__del" title="Remover este pacote" onClick=${() => { if (confirm(`Remover o pacote de ${p.name}?`)) onRemovePkg(stop.id, p.id); }}>✕</button>
      </div>`)}
      <div class="muted small" style="margin-top:6px">Escreva o número <b>${stop.order || "–"}</b> em todos eles.</div>
    </div>` : null}
    <div class="btn-row" style="margin-bottom:10px">
      <button class="btn btn--navy" onClick=${nav}><${Icon} name="nav" width="18" height="18"/> Abrir no mapa</button>
      <button class="btn btn--ghost" onClick=${wpp}><${Icon} name="phone" width="18" height="18"/> WhatsApp</button>
    </div>
    <div class="btn-row" style="margin-bottom:10px">
      <button class="btn btn--ghost btn--avisar" onClick=${avisarSaiu}>
        <${Icon} name="truck" width="18" height="18"/> Avisar: saiu p/ entrega
        ${stop.avisoSaiuEm ? html`<span class="avisado-tick">✓</span>` : null}</button>
      <button class="btn btn--ghost btn--avisar" onClick=${avisarPorta}>
        <${Icon} name="pin" width="18" height="18"/> Avisar: na porta
        ${stop.avisoPortaEm ? html`<span class="avisado-tick">✓</span>` : null}</button>
    </div>
    <button class="btn btn--ghost" style="margin-bottom:10px" onClick=${() => setEditing(true)}>
      <${Icon} name="edit" width="18" height="18"/> Editar endereço</button>
    ${stop.status !== "delivered"
      ? html`<button class="btn btn--ok btn--lg" onClick=${() => { onUpdate({ ...stop, status: "delivered", deliveredAt: Date.now() }); toast("Marcado como entregue", "ok"); onClose(); }}>
          <${Icon} name="check" width="20" height="20"/> Marcar entregue</button>`
      : html`<button class="btn btn--ghost" onClick=${() => { onUpdate({ ...stop, status: "separated", deliveredAt: null }); onClose(); }}>Desfazer entrega</button>`}
    ${stop.status !== "failed" && stop.status !== "delivered"
      ? html`<button class="btn btn--danger" style="margin-top:10px" onClick=${() => { const r = prompt("Motivo da falha (ausente, recusado...):") || "Não entregue"; onUpdate({ ...stop, status: "failed", failReason: r }); onClose(); }}>Registrar problema</button>`
      : null}
    <button class="btn btn--ghost btn--del" style="margin-top:10px" onClick=${() => { if (confirm(`Excluir esta entrega da rota?${multi ? " (remove os " + pkgCount(stop) + " pacotes deste endereço)" : ""}`)) onDelete(stop.id); }}>
      <${Icon} name="x" width="18" height="18"/> Excluir entrega da rota</button>
  </${Sheet}>`;
}

/* ============================ Geocode banner ============================ */
function GeoBanner({ progress }) {
  if (!progress) return null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return html`<div style="position:fixed;left:0;right:0;top:calc(var(--header-h) + var(--safe-t));z-index:35;max-width:560px;margin:0 auto;padding:10px 16px;background:var(--navy);color:#fff">
    <div class="row row--between" style="margin-bottom:6px"><b class="small">Localizando endereços...</b><span class="small">${progress.done}/${progress.total}</span></div>
    <div class="progress"><i style=${{ width: pct + "%" }}></i></div>
  </div>`;
}

/* ============================ Rotas do dia (vários celulares, mesmo login) ============================ */
function RotasDoDiaSheet({ userId, userName, rotaAtual, onClose, onAbrirRota, onCriarRota }) {
  const [rotas, setRotas] = useState(null);
  const [busy, setBusy] = useState(false);

  const carregar = async () => {
    setRotas(null);
    const cloud = await loadCloud();
    if (!cloud) { setRotas([]); return; }
    const ok = await cloud.initCloud();
    if (!ok) { setRotas([]); return; }
    const lista = await cloud.listRoutes(userId, todayISO());
    setRotas(lista);
  };
  useEffect(() => { carregar(); }, []);

  const criar = async () => {
    setBusy(true);
    try { await onCriarRota(); } finally { setBusy(false); }
  };

  const excluir = async (r) => {
    const pacotes = (r.stops || []).reduce((n, s) => n + pkgCount(s), 0);
    const aviso = pacotes > 0
      ? `A Rota ${r.num} tem ${pacotes} pacote(s). Excluir mesmo assim? Isso não pode ser desfeito.`
      : `Excluir a Rota ${r.num} (vazia)?`;
    if (!confirm(aviso)) return;
    const cloud = await loadCloud();
    if (cloud) { await cloud.initCloud(); await cloud.deleteRoute(userId, todayISO(), r.num); }
    toast(`Rota ${r.num} excluída`, "ok");
    carregar();
  };

  const abrir = (r) => {
    if (r.status === "fechada") {
      if (!confirm(`A Rota ${r.num} já foi encerrada. Quer reabrir para adicionar ou ajustar pacotes?`)) return;
    }
    onAbrirRota(r.num);
  };

  const linha = (r) => {
    const pacotes = (r.stops || []).reduce((n, s) => n + pkgCount(s), 0);
    const entregues = (r.stops || []).reduce((n, s) => n + (s.status === "delivered" ? pkgCount(s) : 0), 0);
    const isAtual = r.num === rotaAtual;
    const vazia = pacotes === 0;
    return html`<div class="rotaline" key=${r.num}>
      <div class="rotaline__info">
        <div class="rotaline__title">Rota ${r.num} ${isAtual ? html`<span class="muted small">(neste celular)</span>` : ""}</div>
        <div class="muted small">${vazia ? "vazia" : `${pacotes} pacote${pacotes !== 1 ? "s" : ""} • ${entregues} entregue${entregues !== 1 ? "s" : ""}`}</div>
      </div>
      ${!isAtual ? html`<button class="rotaline__del" title="Excluir rota" onClick=${() => excluir(r)}><${Icon} name="x" width="16" height="16"/></button>` : null}
      ${!isAtual ? html`<button class="btn btn--ghost rotaline__btn" onClick=${() => abrir(r)}>Abrir aqui</button>` : null}
    </div>`;
  };

  const emAndamento = rotas ? rotas.filter((r) => r.status !== "fechada") : [];
  const encerradas = rotas ? rotas.filter((r) => r.status === "fechada") : [];

  return html`<${Sheet} title="Rotas de hoje" sub=${userName} onClose=${onClose}>
    <p class="muted small" style="margin-top:0">Veja todas as rotas do dia — inclusive as que outra pessoa já está preparando neste mesmo login, em outro celular.</p>
    <button class="btn btn--lg" disabled=${busy} onClick=${criar}>
      ${busy ? html`<span class="spinner"></span>` : html`<${Icon} name="plus" width="20" height="20"/>`} Criar nova rota agora
    </button>
    <div class="divider"></div>

    ${rotas === null
      ? html`<div class="row" style="justify-content:center;padding:20px"><span class="spinner"></span></div>`
      : html`
        <div class="card__title" style="margin-bottom:4px">Em andamento</div>
        ${emAndamento.length === 0 ? html`<p class="muted small">Nenhuma rota em andamento.</p>` : emAndamento.map(linha)}

        ${encerradas.length ? html`
          <div class="divider"></div>
          <div class="card__title" style="margin-bottom:4px">Encerradas (${encerradas.length})</div>
          <p class="muted small" style="margin-top:0">Tocar em "Abrir aqui" pede confirmação antes de reabrir.</p>
          ${encerradas.map(linha)}
        ` : null}
      `}
    <button class="btn btn--ghost" style="margin-top:14px" onClick=${carregar}><${Icon} name="history" width="18" height="18"/> Atualizar</button>
  </${Sheet}>`;
}

/* ============================ Equipe (dono vê os entregadores) ============================ */
function EquipeSheet({ onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      const cloud = await loadCloud();
      if (cancel) return;
      const ok = cloud && await cloud.initCloud();
      if (!ok) { if (!cancel) setRows([]); return; }
      const data = await cloud.getTeamDay(todayISO(), [["andre", "André"], ["guilherme", "Guilherme"]]);
      if (!cancel) setRows(data);
    })();
    return () => { cancel = true; };
  }, []);
  const dayCount = (data) => {
    const stops = (data && data.stops) || [];
    const sum = (pred) => stops.filter(pred).reduce((n, s) => n + pkgCount(s), 0);
    const fech = ((data && data.rotasFechadas) || []).reduce((a, r) => ({
      pacotes: a.pacotes + (r.pacotes || 0), entregues: a.entregues + (r.entregues || 0),
      falhas: a.falhas + (r.falhas || 0), km: a.km + (r.km || 0),
    }), { pacotes: 0, entregues: 0, falhas: 0, km: 0 });
    const atual = sum(() => true);
    return {
      total: fech.pacotes + atual,
      delivered: fech.entregues + sum((s) => s.status === "delivered"),
      failed: fech.falhas + sum((s) => s.status === "failed"),
      km: fech.km + ((data && data.lastKm) || 0),
      rotas: ((data && data.rotasFechadas) || []).length + (atual > 0 ? 1 : 0),
    };
  };
  return html`<${Sheet} title="Equipe — hoje" sub=${today()} onClose=${onClose}>
    ${rows === null
      ? html`<div class="row" style="justify-content:center;padding:24px"><span class="spinner"></span></div>`
      : rows.map(({ nome, data }) => {
          const c = dayCount(data);
          const updated = data && data.atualizadoEm
            ? new Date(data.atualizadoEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : null;
          return html`<div class="team">
            <div class="row row--between" style="margin-bottom:8px">
              <div class="team__name">${nome}${c.rotas > 1 ? html` <span class="muted small">• ${c.rotas} rotas</span>` : ""}</div>
              <div class="muted small">${updated ? `atualizado ${updated}` : "sem dados hoje"}</div>
            </div>
            <div class="team__stats">
              <div class="team__stat"><b>${c.delivered}<i>/${c.total}</i></b><span>entregues</span></div>
              <div class="team__stat"><b>${c.failed}</b><span>falhas</span></div>
              <div class="team__stat"><b>${fmtKm(c.km)}</b><span>km</span></div>
            </div>
          </div>`;
        })}
    <p class="muted small" style="margin-top:14px;opacity:.7">Atualiza conforme cada entregador usa o app (com internet).</p>
  </${Sheet}>`;
}

/* ============================ App ============================ */
function App() {
  const [logged, setLogged] = useState(isLogged());
  const [state, setState] = useState(() => {
    const s = loadState();
    const hoje = todayISO();
    // virou o dia? zera as entregas (o histórico de ontem já ficou salvo por data)
    if (s.dia !== hoje) return { ...s, dia: hoje, stops: [], lastKm: 0, atualizadoEm: 0, rotaNum: 1, rotasFechadas: [], diaIniciadoEm: null };
    return s;
  });
  const [view, setView] = useState("home");
  const [sheet, setSheet] = useState(null);          // 'import' | 'config' | 'historico'
  const [capture, setCapture] = useState(false);
  const [selStop, setSelStop] = useState(null);
  const [scanMode, setScanMode] = useState(null);    // 'separate' | 'deliver'
  const [scanResult, setScanResult] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
  const [geoProgress, setGeoProgress] = useState(null);

  useEffect(() => { saveState(state); }, [state]);

  const { stops, config } = state;
  const session = getSession();
  const stopsRef = useRef(stops);
  stopsRef.current = stops; // sempre a lista mais atual (evita agrupar errado por leitura desatualizada)
  const stateRef = useRef(state);
  stateRef.current = state;
  const cloudUserId = session?.user || null;
  const cloudOkRef = useRef(false);
  const cloudLoadedRef = useRef(false);
  const cloudModRef = useRef(null);
  const [teamSheet, setTeamSheet] = useState(false);
  const [rotasSheet, setRotasSheet] = useState(false);
  const setStops = useCallback((updater) => setState((s) => ({ ...s, stops: typeof updater === "function" ? updater(s.stops) : updater })), []);

  // marca o início do dia (cronômetro) no 1º pacote bipado, em qualquer rota
  useEffect(() => {
    if (stops.length > 0 && !state.diaIniciadoEm) {
      setState((s) => (s.diaIniciadoEm ? s : { ...s, diaIniciadoEm: Date.now() }));
    }
  }, [stops.length]);
  const setConfig = useCallback((cfg) => setState((s) => ({ ...s, config: cfg })), []);

  // ---- nuvem: restaura o dia ao entrar (backup) e mantém a nuvem atualizada ----
  useEffect(() => {
    if (!logged || !cloudUserId) return;
    let cancel = false;
    (async () => {
      const cloud = await loadCloud();
      if (cancel) return;
      cloudModRef.current = cloud;
      const ok = cloud && await cloud.initCloud();
      cloudOkRef.current = !!ok;
      if (!ok) { cloudLoadedRef.current = true; return; } // sem nuvem: segue só no local
      try {
        const hoje = todayISO();
        const remote = await cloud.getDay(cloudUserId, hoje);
        if (cancel) return;
        const local = stateRef.current;
        const localTs = local.atualizadoEm || 0;
        const remoteTs = (remote && remote.atualizadoEm) || 0;
        if (remote && Array.isArray(remote.stops) && remoteTs > localTs) {
          // nuvem mais nova -> restaura (ex.: reinstalou o app, trocou de aparelho)
          setState((s) => ({ ...s, stops: remote.stops, lastKm: remote.lastKm || 0, dia: hoje, atualizadoEm: remoteTs, rotaNum: remote.rotaNum || 1, rotasFechadas: remote.rotasFechadas || [], diaIniciadoEm: remote.diaIniciadoEm || s.diaIniciadoEm || null }));
        } else {
          // local é a fonte -> garante que a nuvem tenha o estado atual
          cloud.saveDay(cloudUserId, hoje, {
            stops: local.stops || [], lastKm: local.lastKm || 0, dia: hoje,
            rotaNum: local.rotaNum || 1, rotasFechadas: local.rotasFechadas || [], diaIniciadoEm: local.diaIniciadoEm || null,
            entregador: session?.nome || cloudUserId, atualizadoEm: localTs || Date.now(),
          });
        }
      } catch (e) { console.warn(e); }
      finally { if (!cancel) cloudLoadedRef.current = true; }
    })();
    return () => { cancel = true; };
  }, [logged, cloudUserId]);

  // ---- nuvem: salva quando muda (após o restore inicial) ----
  useEffect(() => {
    if (!cloudOkRef.current || !cloudLoadedRef.current || !cloudUserId) return;
    const cloud = cloudModRef.current;
    if (!cloud) return;
    const hoje = todayISO();
    const t = setTimeout(() => {
      const ts = Date.now();
      const rNum = stateRef.current.rotaNum || 1;
      // 1) compatibilidade: salva o "snapshot do dia" (usado pela tela Equipe e telas antigas)
      cloud.saveDay(cloudUserId, hoje, {
        stops: stopsRef.current, lastKm: stateRef.current.lastKm || 0, dia: hoje,
        rotaNum: rNum, rotasFechadas: stateRef.current.rotasFechadas || [], diaIniciadoEm: stateRef.current.diaIniciadoEm || null,
        entregador: session?.nome || cloudUserId, atualizadoEm: ts,
      });
      // 2) gaveta própria desta rota — não conflita com outro celular preparando outra rota
      cloud.saveRoute(cloudUserId, hoje, rNum, {
        stops: stopsRef.current, lastKm: stateRef.current.lastKm || 0,
        status: "ativa", entregador: session?.nome || cloudUserId, atualizadoEm: ts,
      });
      setState((s) => ({ ...s, atualizadoEm: ts }));
    }, 800);
    return () => clearTimeout(t);
  }, [stops, state.lastKm, state.rotaNum, state.diaIniciadoEm]);

  const counts = useMemo(() => {
    const sum = (pred) => stops.filter(pred).reduce((n, s) => n + pkgCount(s), 0);
    const semLocal = stops.filter((s) => s.geoError || (!s.geocoded && s.address));
    return {
      total: sum(() => true),
      stops: stops.length,
      delivered: sum((s) => s.status === "delivered"),
      separated: sum((s) => s.status === "separated"),
      failed: sum((s) => s.status === "failed"),
      pending: sum((s) => s.status !== "delivered"),
      pendingStops: stops.filter((s) => s.status !== "delivered").length,
      semLocal: semLocal.length,
      semLocalPacotes: semLocal.reduce((n, s) => n + pkgCount(s), 0),
    };
  }, [stops]);
  const totalKm = useMemo(() => state.lastKm || 0, [state.lastKm]);
  const rotaNum = state.rotaNum || 1;
  const rotasFechadas = state.rotasFechadas || [];
  // somas do dia inteiro = rota atual + rotas já fechadas
  const dayTotals = useMemo(() => {
    const fech = rotasFechadas.reduce((a, r) => ({
      pacotes: a.pacotes + (r.pacotes || 0), entregues: a.entregues + (r.entregues || 0),
      falhas: a.falhas + (r.falhas || 0), km: a.km + (r.km || 0),
    }), { pacotes: 0, entregues: 0, falhas: 0, km: 0 });
    return {
      pacotes: fech.pacotes + counts.total,
      entregues: fech.entregues + counts.delivered,
      falhas: fech.falhas + counts.failed,
      km: fech.km + (state.lastKm || 0),
      rotas: rotasFechadas.length + (counts.total > 0 ? 1 : 0),
    };
  }, [rotasFechadas, counts.total, counts.delivered, counts.failed, state.lastKm]);
  const hasRoute = useMemo(() => stops.some((s) => s.order), [stops]);

  // cronômetro do dia: do 1º pacote bipado até a última entrega marcada (ou "agora" se ainda em curso)
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000); // atualiza a cada 30s, suficiente pra um cronômetro
    return () => clearInterval(id);
  }, []);
  const dayTime = useMemo(() => {
    const inicio = state.diaIniciadoEm;
    if (!inicio) return null;
    const ultimaAtual = stops.reduce((max, s) => (s.deliveredAt && s.deliveredAt > max ? s.deliveredAt : max), 0);
    const ultimaFechadas = rotasFechadas.reduce((max, r) => (r.ultimaEntregaTs && r.ultimaEntregaTs > max ? r.ultimaEntregaTs : max), 0);
    const ultimaEntrega = Math.max(ultimaAtual, ultimaFechadas);
    const emAndamento = dayTotals.entregues < dayTotals.pacotes || dayTotals.pacotes === 0;
    const fim = emAndamento ? nowTick : (ultimaEntrega || nowTick);
    const ms = Math.max(0, fim - inicio);
    const minutos = Math.round(ms / 60000);
    const porPacote = dayTotals.entregues > 0 ? ms / dayTotals.entregues / 60000 : null;
    return { minutos, porPacote, emAndamento, inicio };
  }, [state.diaIniciadoEm, stops, rotasFechadas, dayTotals.entregues, dayTotals.pacotes, nowTick]);
  const fmtDuracao = (min) => {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return `${h}h${m > 0 ? ` ${m}min` : ""}`;
  };

  // "Compensou?" — ganho do dia (pacotes entregues x valor) menos custo estimado de combustível
  const dayMoney = useMemo(() => {
    const { kmPorLitro, precoCombustivel, valorPorPacote } = config || {};
    if (!kmPorLitro || !precoCombustivel || !valorPorPacote) return null;
    const litros = dayTotals.km / kmPorLitro;
    const custoComb = litros * precoCombustivel;
    const ganho = dayTotals.entregues * valorPorPacote;
    return { custoComb, ganho, lucro: ganho - custoComb, litros };
  }, [config?.kmPorLitro, config?.precoCombustivel, config?.valorPorPacote, dayTotals.km, dayTotals.entregues]);

  // registra o resumo do dia no histórico sempre que muda (soma de todas as rotas)
  useEffect(() => {
    if (!logged || !dayTotals.pacotes) return;
    registrarDia({ entregador: session?.nome, total: dayTotals.pacotes, entregues: dayTotals.entregues, falhas: dayTotals.falhas, km: dayTotals.km });
  }, [dayTotals.pacotes, dayTotals.entregues, dayTotals.falhas, dayTotals.km, logged]);

  /* ---- adicionar entregas ---- */
  const addStops = (newStops) => {
    setStops((cur) => [...cur, ...newStops]);
    setTimeout(() => runGeocode([...stopsRef.current]), 200);
  };

  // vindo da conferência (1 etiqueta lida pela IA) — agrupa se o endereço já existe
  const addFromConf = (d) => {
    const address = montarEndereco(d);
    const key = addrKey(d);
    const pkg = { id: uid(), code: (d.codigo || "").trim(), name: (d.nome || "").trim() || "Sem nome", phone: (d.telefone || "").trim(), note: "" };
    const existing = key ? stopsRef.current.find((s) => stopKey(s) === key) : null;
    if (existing) {
      setStops((cur) => cur.map((s) => (s.id === existing.id
        ? { ...s, packages: [...pkgsOf(s), pkg] }
        : s)));
      toast(`Somado à parada de ${existing.name} • ${pkgCount(existing) + 1} pacotes aqui`, "ok");
      return;
    }
    addStops([{
      id: uid(), key, code: pkg.code, name: pkg.name, address, phone: pkg.phone, note: "",
      packages: [pkg], lat: undefined, lng: undefined,
      geo: { endereco: (d.endereco || "").trim(), complemento: (d.complemento || "").trim(), bairro: (d.bairro || "").trim(), cidade: (d.cidade || "").trim(), uf: (d.uf || "").trim(), cep: (d.cep || "").trim() },
      geocoded: false, geoError: false, order: null, status: "pending", failReason: "", deliveredAt: null,
    }]);
    toast("Pacote adicionado", "ok");
  };

  /* ---- geocodificar ---- */
  const runGeocode = async (list) => {
    const pending = list.filter((s) => !s.geocoded && s.address);
    if (!pending.length) return;
    if (!config.mapboxToken) { setSheet("config"); toast("Configure a chave do Mapbox", "err"); return; }
    setGeoProgress({ done: 0, total: pending.length });
    try {
      await geocodeQueue(list, { token: config.mapboxToken, proximity: config.origin || null, onProgress: (done, total) => setGeoProgress({ done, total }) });
    } catch (e) { setGeoProgress(null); toast(e.message || "Falha no geocoding", "err"); return; }
    setStops([...list]);
    setGeoProgress(null);
    const failed = list.filter((s) => s.geoError).length;
    toast(failed ? `Endereços localizados • ${failed} não encontrado(s)` : "Endereços localizados", failed ? "err" : "ok");
  };

  /* ---- otimizar rota ---- */
  const runOptimize = async () => {
    if (!config.origin) { setSheet("config"); return toast("Defina o ponto de partida primeiro", "err"); }
    const notGeo = stops.filter((s) => !s.geocoded && s.address);
    if (notGeo.length) { toast("Localizando endereços antes de otimizar...", ""); await runGeocode(stops); }
    setOptimizing(true);
    setTimeout(() => {
      const geoStops = stops.filter((s) => s.geocoded);
      const { order, totalKm, ungeocoded } = optimizeRoute(config.origin, geoStops, { finishAtOrigin: config.finishAtOrigin });
      const orderMap = new Map(order.map((id, i) => [id, i + 1]));
      setState((s) => ({ ...s, lastKm: totalKm, stops: s.stops.map((st) => ({ ...st, order: orderMap.get(st.id) || null })) }));
      setOptimizing(false);
      setView("map");
      toast(`Rota pronta • ${order.length} paradas • ${fmtKm(totalKm)} km${ungeocoded ? ` • ${ungeocoded} sem local` : ""}`, "ok");
    }, 50);
  };

  /* ---- scan (numerar / entregar) ---- */
  const handleScan = (decoded) => {
    const stop = matchStopByCode(stops, decoded);
    if (scanMode === "separate") {
      if (!stop) return setScanResult({ kind: "not-found", code: decoded });
      if (!stop.order) return setScanResult({ kind: "no-route", stop });
      if (stop.status === "separated" || stop.status === "delivered") return setScanResult({ kind: "dup", stop });
      setStops((cur) => cur.map((s) => (s.id === stop.id ? { ...s, status: "separated" } : s)));
      setScanResult({ kind: "ok-separate", stop: { ...stop, status: "separated" } });
    } else if (scanMode === "deliver") {
      if (!stop) return setScanResult({ kind: "not-found", code: decoded });
      setStops((cur) => cur.map((s) => (s.id === stop.id ? { ...s, status: "delivered", deliveredAt: Date.now() } : s)));
      const next = stops.filter((s) => s.order && s.status !== "delivered" && s.id !== stop.id).sort((a, b) => a.order - b.order)[0];
      setScanResult({ kind: "delivered", stop, next });
    }
  };

  /* ---- numerar por foto (IA acha a parada pelo endereço) ---- */
  const numberStop = (stop) => {
    if (!stop.order) return { kind: "no-route", stop };
    if (stop.status === "separated" || stop.status === "delivered") return { kind: "dup", stop };
    setStops((cur) => cur.map((s) => (s.id === stop.id ? { ...s, status: "separated" } : s)));
    return { kind: "ok-separate", stop: { ...stop, status: "separated" } };
  };

  /* ---- Rotas do dia: criar uma rota nova SEM fechar a atual (ex.: operador na base) ---- */
  const criarRotaAgora = async () => {
    if (counts.total > 0 && counts.delivered < counts.total) {
      if (!confirm(`Este celular já tem ${counts.total - counts.delivered} pacote(s) pendente(s) na Rota ${rotaNum}. Trocar para uma rota nova mesmo assim? (a Rota ${rotaNum} continua salva, dá pra voltar pela tela "Rotas de hoje")`)) return;
    }
    const cloud = cloudModRef.current;
    let proximo = (rotasFechadas.length ? Math.max(...rotasFechadas.map((r) => r.num)) : rotaNum) + 1;
    if (cloudOkRef.current && cloud && cloudUserId) {
      try { proximo = await cloud.nextRouteNum(cloudUserId, todayISO()); } catch (e) { console.warn(e); }
    }
    setState((s) => ({ ...s, stops: [], lastKm: 0, rotaNum: proximo }));
    setRotasSheet(false);
    setView("home");
    toast(`Rota ${proximo} criada — pode começar a bipar`, "ok");
  };

  // troca o celular pra trabalhar em outra rota já existente na nuvem (ex.: entregador
  // assume a rota que o operador da base já deixou preparada)
  const abrirRotaExistente = async (num) => {
    const cloud = cloudModRef.current;
    if (!cloud || !cloudUserId) return;
    try {
      const remota = await cloud.getRoute(cloudUserId, todayISO(), num);
      setState((s) => ({ ...s, stops: (remota && remota.stops) || [], lastKm: (remota && remota.lastKm) || 0, rotaNum: num }));
      await cloud.saveRoute(cloudUserId, todayISO(), num, { status: "ativa", atualizadoEm: Date.now() });
      setRotasSheet(false);
      setView("home");
      toast(`Rota ${num} aberta neste celular`, "ok");
    } catch (e) { toast("Não consegui abrir essa rota", "err"); }
  };

  /* ---- fechar a rota atual e começar uma nova no mesmo dia ---- */
  const novaRota = async () => {
    if (counts.total === 0) { toast("Bipe os pacotes desta rota primeiro", ""); return; }
    const falta = counts.total - counts.delivered;
    const aviso = falta > 0
      ? `Ainda há ${falta} pacote(s) não entregue(s) nesta rota. Fechar mesmo assim e começar a próxima rota?`
      : `Fechar a Rota ${rotaNum} e começar a próxima rota?`;
    if (!confirm(aviso)) return;
    const ultimaEntregaTs = stops.reduce((max, s) => (s.deliveredAt && s.deliveredAt > max ? s.deliveredAt : max), 0);
    const resumo = {
      id: uid(), num: rotaNum,
      pacotes: counts.total, entregues: counts.delivered, falhas: counts.failed,
      km: state.lastKm || 0, fechadaEm: Date.now(), ultimaEntregaTs,
    };
    // marca esta rota como fechada na nuvem (se disponível) e descobre o próximo número
    // livre — reservar na nuvem evita colidir com uma rota que o operador da base já
    // tenha criado de outro celular enquanto este estava na rua.
    let proximo = rotaNum + 1;
    const cloud = cloudModRef.current;
    if (cloudOkRef.current && cloud && cloudUserId) {
      try {
        const hoje = todayISO();
        await cloud.saveRoute(cloudUserId, hoje, rotaNum, { status: "fechada", atualizadoEm: Date.now() });
        proximo = await cloud.nextRouteNum(cloudUserId, hoje);
      } catch (e) { console.warn(e); }
    }
    setState((s) => ({
      ...s,
      rotasFechadas: [...(s.rotasFechadas || []), resumo],
      stops: [], lastKm: 0, rotaNum: proximo,
    }));
    setView("home");
    toast(`Rota ${rotaNum} fechada • começando Rota ${proximo}`, "ok");
  };

  /* ---- atalho do aviso "endereços não localizados": abre a 1ª já no modo editar ---- */
  /* ---- avisar cliente "saiu para entrega" direto da lista (fila sequencial) ---- */
  const avisarSaiuPara = (stop) => {
    const num = (stop.phone || "").replace(/\D/g, "");
    if (!num) return toast("Sem telefone cadastrado", "err");
    const primeiroNome = (stop.name || "").trim().split(" ")[0] || "";
    const texto = `Olá${primeiroNome ? " " + primeiroNome : ""}! Aqui é da AM Express 📦\nSua entrega já saiu e está a caminho do seu endereço hoje. Em breve chegamos!`;
    window.open(`https://wa.me/55${num}?text=${encodeURIComponent(texto)}`, "_blank");
    setStops((cur) => cur.map((s) => (s.id === stop.id ? { ...s, avisoSaiuEm: Date.now() } : s)));
  };

  const verSemLocal = () => {
    const alvo = stops.find((s) => s.geoError || (!s.geocoded && s.address));
    if (!alvo) return toast("Nenhum endereço pendente — pode otimizar de novo", "ok");
    setView("list");
    setSelStop({ ...alvo, _autoEdit: true });
  };

  /* ---- excluir parada ou pacote (bipou errado / duas vezes) ---- */
  const deleteStop = (id) => { setStops((cur) => cur.filter((s) => s.id !== id)); toast("Entrega removida da rota", "ok"); };
  const removePackage = (stopId, pkgId) => {
    setStops((cur) => cur.flatMap((s) => {
      if (s.id !== stopId) return [s];
      const pkgs = pkgsOf(s).filter((p) => p.id !== pkgId);
      if (!pkgs.length) return []; // era o último pacote -> remove a parada
      return [{ ...s, packages: pkgs, name: pkgs[0].name, code: pkgs[0].code, phone: pkgs[0].phone }];
    }));
    toast("Pacote removido", "ok");
  };

  /* ---- editar endereço de uma parada (corrige número lido errado pela IA) ---- */
  const editStopAddress = (id, d) => {
    const address = montarEndereco(d);
    const key = addrKey(d);
    const geo = { endereco: (d.endereco || "").trim(), complemento: (d.complemento || "").trim(), bairro: (d.bairro || "").trim(), cidade: (d.cidade || "").trim(), uf: (d.uf || "").trim(), cep: (d.cep || "").trim() };
    let merged = false;
    setStops((cur) => {
      const me = cur.find((s) => s.id === id);
      if (!me) return cur;
      const target = key ? cur.find((s) => s.id !== id && stopKey(s) === key) : null;
      if (target) { // o endereço corrigido ficou igual a outra parada -> junta
        merged = true;
        return cur
          .map((s) => (s.id === target.id ? { ...s, packages: [...pkgsOf(s), ...pkgsOf(me)] } : s))
          .filter((s) => s.id !== id);
      }
      return cur.map((s) => {
        if (s.id !== id) return s;
        const newName = (d.nome || "").trim() || s.name;
        const newCode = (d.codigo || "").trim() || s.code;
        const pkgs = pkgsOf(s).map((p, i) => (i === 0 ? { ...p, name: newName, code: newCode } : p));
        return { ...s, name: newName, code: newCode, address, key, geo, packages: pkgs, lat: undefined, lng: undefined, geocoded: false, geoError: false };
      });
    });
    setTimeout(() => runGeocode([...stopsRef.current]), 300);
    toast(merged ? "Corrigido e juntado à parada igual" : "Endereço atualizado, localizando...", "ok");
  };

  /* ---- recalcular a rota a partir da MINHA posição (GPS) ---- */
  const recalcFromHere = async () => {
    const geoStops = stops.filter((s) => s.geocoded);
    if (!geoStops.length) return toast("Sem paradas com localização", "err");
    const remaining = geoStops.filter((s) => s.status !== "delivered");
    if (!remaining.length) return toast("Todas as paradas já foram entregues", "ok");
    toast("Pegando sua localização...", "");
    let pos;
    try { pos = await getCurrentPosition(); }
    catch { return toast("Não consegui pegar sua localização. Ative o GPS.", "err"); }
    const origin = { lat: pos.lat, lng: pos.lng };
    const { order, totalKm } = optimizeRoute(origin, remaining, { finishAtOrigin: config.finishAtOrigin });
    const delivered = stops.filter((s) => s.status === "delivered").sort((a, b) => (a.order || 0) - (b.order || 0));
    const orderMap = new Map();
    delivered.forEach((s, i) => orderMap.set(s.id, i + 1));
    order.forEach((id, i) => orderMap.set(id, delivered.length + i + 1));
    setState((s) => ({ ...s, lastKm: totalKm, stops: s.stops.map((st) => ({ ...st, order: orderMap.get(st.id) || st.order })) }));
    setView("map");
    toast(`Rota recalculada de onde você está • ${remaining.length} parada(s) restante(s) renumerada(s)`, "ok");
  };

  const openScan = (mode) => {
    if (!stops.length) { setSheet("import"); return toast("Bipe as etiquetas primeiro", "err"); }
    if (mode === "separate" && !hasRoute) { toast("Otimize a rota primeiro", "err"); return; }
    setScanMode(mode);
  };

  const onSetView = (v) => { if (v === "scan") return openScan("separate"); setView(v); };

  const doLogout = () => { logout(); setSheet(null); setLogged(false); };

  if (!logged) return html`<div class="app-shell"><${LoginScreen} onLogged=${() => setLogged(true)} /><${ToastHost} /></div>`;

  return html`<div class="app-shell">
    <${Header} onHistory=${() => setSheet("historico")} onConfig=${() => setSheet("config")} />
    <${GeoBanner} progress=${geoProgress} />

    ${view === "home" && html`<${Dashboard} config=${config} counts=${counts} totalKm=${totalKm}
      optimizing=${optimizing} hasRoute=${hasRoute} userName=${session?.nome}
      isOwner=${isOwner()} onTeam=${() => setTeamSheet(true)}
      rotaNum=${rotaNum} dayTotals=${dayTotals} hasClosedRoutes=${rotasFechadas.length > 0} onNovaRota=${novaRota}
      onRotasDia=${() => setRotasSheet(true)} onVerSemLocal=${verSemLocal} dayMoney=${dayMoney} dayTime=${dayTime} fmtDuracao=${fmtDuracao}
      onCapture=${() => setCapture(true)} onImport=${() => setSheet("import")} onOptimize=${runOptimize} onConfig=${() => setSheet("config")} />`}
    ${view === "map" && html`<${MapView} stops=${stops} config=${config} onRecalc=${recalcFromHere} />`}
    ${view === "list" && html`<${ListView} stops=${stops} onOpen=${setSelStop} onScanDeliver=${() => openScan("deliver")} onAvisarProximo=${avisarSaiuPara} />`}

    <${TabBar} view=${view === "scan" ? "scan" : view} setView=${onSetView} pending=${counts.pending} />

    ${capture && html`<${CaptureView} token=${config.mapboxToken} count=${counts.total}
      onAdd=${addFromConf} onClose=${() => setCapture(false)} />`}

    ${scanMode === "separate" && html`<${NumberView} stops=${stops} count=${`${counts.separated}/${counts.total}`}
      onSeparate=${numberStop} onClose=${() => { setScanMode(null); if (view === "scan") setView("home"); }} />`}
    ${scanMode === "deliver" && html`<${ScannerView} mode="deliver" count=${`${counts.delivered}/${counts.total}`}
      onMatch=${handleScan} onClose=${() => { setScanMode(null); setScanResult(null); }} />`}
    ${scanResult && html`<${ScanResult} result=${scanResult} onNext=${() => setScanResult(null)} />`}

    ${sheet === "import" && html`<${ImportSheet} onClose=${() => setSheet(null)} onAddStops=${addStops} />`}
    ${sheet === "config" && html`<${ConfigSheet} config=${config} session=${session}
      onClose=${() => setSheet(null)} onSave=${setConfig} onLogout=${doLogout}
      onClearDay=${() => { setState({ ...loadState(), stops: [], lastKm: 0 }); clearState(); toast("Dia zerado"); }} />`}
    ${sheet === "historico" && html`<${HistoricoSheet} onClose=${() => setSheet(null)} />`}
    ${teamSheet && html`<${EquipeSheet} onClose=${() => setTeamSheet(false)} />`}
    ${rotasSheet && cloudUserId && html`<${RotasDoDiaSheet} userId=${cloudUserId} userName=${session?.nome} rotaAtual=${rotaNum}
      onClose=${() => setRotasSheet(false)} onAbrirRota=${abrirRotaExistente} onCriarRota=${criarRotaAgora} />`}
    ${selStop && html`<${StopSheet} stop=${stops.find((s) => s.id === selStop.id) || selStop} onClose=${() => setSelStop(null)}
      autoEdit=${!!selStop._autoEdit}
      onUpdate=${(u) => setStops((cur) => cur.map((s) => (s.id === u.id ? u : s)))}
      onDelete=${(id) => { deleteStop(id); setSelStop(null); }}
      onEditAddress=${editStopAddress}
      onRemovePkg=${removePackage} />`}

    <${ToastHost} />
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
