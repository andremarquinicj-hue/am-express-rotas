// app.js — AM Express · Rotas (Preact + htm, sem build)
import { loadState, saveState, uid, clearState } from "./modules/storage.js";
import { geocodeQueue, getCurrentPosition, geocodeOne, parseLatLng, haversine } from "./modules/geo.js";
import { optimizeRoute } from "./modules/route.js";
import { parseCSV } from "./modules/csv.js";
import { startScanner, stopScanner, feedback } from "./modules/scanner.js";

const { h, render } = window.preact;
const { useState, useEffect, useRef, useMemo, useCallback } = window.preactHooks;
const html = window.htm.bind(h);

/* ============================ helpers ============================ */
const fmtKm = (k) => (k >= 10 ? Math.round(k) : k.toFixed(1)).toString().replace(".", ",");
const normCode = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
const today = () =>
  new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });

function matchStopByCode(stops, decoded) {
  const d = normCode(decoded);
  if (!d) return null;
  // 1) match exato
  let s = stops.find((x) => x.code && normCode(x.code) === d);
  if (s) return s;
  // 2) código contido no conteúdo do QR (ex.: URL com o código)
  s = stops.find((x) => x.code && d.includes(normCode(x.code)) && normCode(x.code).length >= 4);
  if (s) return s;
  // 3) conteúdo contido no código (parcial)
  s = stops.find((x) => x.code && normCode(x.code).includes(d) && d.length >= 6);
  return s || null;
}

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

/* ============================ Header ============================ */
function Header({ title, sub, onConfig }) {
  return html`<header class="hdr">
    <img class="hdr__logo" src="assets/logo.png" alt="AM Express" />
    <div class="hdr__title">${title}<small>${sub}</small></div>
    <div class="hdr__spacer"></div>
    <button class="hdr__btn" onClick=${onConfig} aria-label="Configurações">${html`<${Icon} name="gear" width="20" height="20" />`}</button>
  </header>`;
}

/* ============================ TabBar ============================ */
function TabBar({ view, setView, pending }) {
  const tabs = [
    { id: "home", label: "Início", icon: "home" },
    { id: "scan", label: "Separar", icon: "scan" },
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
function Dashboard({ stops, config, counts, totalKm, onImport, onOptimize, onConfig, optimizing, hasRoute }) {
  const pct = counts.total ? Math.round((counts.delivered / counts.total) * 100) : 0;
  return html`<main class="main">
    <div class="hero">
      <div class="hero__date">${today()}</div>
      <div class="hero__big">${counts.delivered}<small>/${counts.total} entregues</small></div>
      <div class="hero__sub">${counts.total ? `${counts.pending} restantes • ${fmtKm(totalKm)} km na rota` : "Carregue as entregas do dia para começar"}</div>
      <div class="hero__bar"><i style=${{ width: pct + "%" }}></i></div>
    </div>

    <div class="stats">
      <div class="stat stat--royal"><div class="stat__num">${counts.total}</div><div class="stat__lbl">Pacotes</div></div>
      <div class="stat stat--ok"><div class="stat__num">${counts.delivered}</div><div class="stat__lbl">Entregues</div></div>
      <div class="stat"><div class="stat__num">${fmtKm(totalKm)}</div><div class="stat__lbl">KM rota</div></div>
    </div>

    ${counts.total === 0
      ? html`<div class="card">
          <div class="card__title" style="margin-bottom:6px">Comece o dia</div>
          <p class="muted small" style="margin-top:0">Importe a lista de entregas (CSV/planilha) ou cadastre na mão. O app vai geocodificar os endereços e montar a melhor rota.</p>
          <button class="btn btn--lg" onClick=${onImport}><${Icon} name="upload" width="20" height="20"/> Carregar entregas</button>
        </div>`
      : html`<div class="card">
          <div class="row row--between" style="margin-bottom:12px">
            <div><div class="card__title">Rota do dia</div>
              <div class="muted small">${hasRoute ? `${counts.total} paradas otimizadas` : "Ainda não otimizada"}</div></div>
            ${hasRoute ? html`<span class="chip chip--delivered">Pronta</span>` : html`<span class="chip chip--warn">Pendente</span>`}
          </div>
          <button class="btn btn--lg" disabled=${optimizing} onClick=${onOptimize}>
            ${optimizing ? html`<span class="spinner"></span> Otimizando...` : html`<${Icon} name="nav" width="20" height="20"/> ${hasRoute ? "Recalcular melhor rota" : "Otimizar rota"}`}
          </button>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn btn--ghost" onClick=${onImport}><${Icon} name="plus" width="18" height="18"/> Adicionar</button>
            <button class="btn btn--ghost" onClick=${onConfig}><${Icon} name="flag" width="18" height="18"/> Galpão</button>
          </div>
        </div>`}

    ${!config.origin && counts.total > 0
      ? html`<div class="card" style="border-color:var(--warn);background:var(--warn-bg)">
          <div class="row" style="gap:10px"><${Icon} name="pin" width="22" height="22" style=${{ color: "var(--warn)", flex: "none" }}/>
          <div><b>Defina o ponto de partida</b><div class="muted small">Sem o galpão (ou sua localização), não dá pra calcular a rota.</div></div></div>
          <button class="btn btn--navy" style="margin-top:12px" onClick=${onConfig}>Definir ponto de partida</button>
        </div>`
      : null}
  </main>`;
}

/* ============================ Scanner screen ============================ */
function ScannerView({ stops, mode, onMatch, onClose, count }) {
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
      <div class="scan__count">${mode === "separate" ? "Separando" : "Entregando"} • ${count}</div>
      <button class="scan__close" onClick=${onClose}><${Icon} name="x" width="22" height="22"/></button>
    </div>
    <div class="scan__cam"><div id=${elId}></div>
      <div class="scan__frame"><div class="scan__box"><i></i><div class="scan__laser"></div></div></div>
    </div>
    <div class="scan__hint">${mode === "separate"
      ? "Aponte para o código do pacote. O número da parada vai aparecer na tela — escreva no pacote."
      : "Bipe o pacote para confirmar a entrega."}</div>
  </div>`;
}

/* ============================ Scan result (número GIGANTE) ============================ */
function ScanResult({ result, onNext, onClose }) {
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
    cls = "scanres--ok";
  } else if (result.kind === "dup") {
    cls = "scanres--dup"; label = "Já separado"; num = result.stop.order; name = result.stop.name;
  } else if (result.kind === "not-found") {
    cls = "scanres--bad"; msg = "Pacote não está na lista de hoje"; name = result.code;
  } else if (result.kind === "no-route") {
    cls = "scanres--dup"; msg = "Otimize a rota antes de separar"; name = result.stop?.name || "";
  }

  return html`<div class=${"scanres " + cls} onClick=${onNext}>
    <div class="scanres__label">${label}</div>
    ${num !== "" ? html`<div class="scanres__num">${num}</div>` : null}
    ${name ? html`<div class="scanres__name">${name}</div>` : null}
    ${addr ? html`<div class="scanres__addr">${addr}</div>` : null}
    ${msg ? html`<div class="scanres__msg">${msg}</div>` : null}
  </div>`;
}

/* ============================ Map screen ============================ */
function MapView({ stops, config }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  useEffect(() => {
    const L = window.L;
    if (!L || !ref.current) return;
    const ordered = stops.filter((s) => s.geocoded && s.order).sort((a, b) => a.order - b.order);
    const center = config.origin || ordered[0] || { lat: -21.255, lng: -48.322 };
    const map = L.map(ref.current, { zoomControl: false }).setView([center.lat, center.lng], 13);
    mapRef.current = map;
    const token = config.mapboxToken;
    if (token) {
      L.tileLayer(
        `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`,
        { tileSize: 512, zoomOffset: -1, maxZoom: 20, attribution: "© Mapbox © OpenStreetMap" }
      ).addTo(map);
    } else {
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "© OpenStreetMap",
      }).addTo(map);
    }

    const bounds = [];
    if (config.origin) {
      L.marker([config.origin.lat, config.origin.lng], {
        icon: L.divIcon({ className: "", html: `<div class="leaflet-marker-num" style="background:#0d152e"><span>🏠</span></div>`, iconSize: [30, 30], iconAnchor: [15, 28] }),
      }).addTo(map).bindPopup("Ponto de partida");
      bounds.push([config.origin.lat, config.origin.lng]);
    }

    const line = config.origin ? [[config.origin.lat, config.origin.lng]] : [];
    ordered.forEach((s) => {
      const color = s.status === "delivered" ? "#15a34a" : s.status === "failed" ? "#dc2626" : "#2B5CE6";
      L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: "", html: `<div class="leaflet-marker-num" style="background:${color}"><span>${s.order}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 28] }),
      }).addTo(map).bindPopup(`<b>${s.order}. ${s.name}</b><br>${s.address}`);
      line.push([s.lat, s.lng]);
      bounds.push([s.lat, s.lng]);
    });
    if (config.finishAtOrigin && config.origin) line.push([config.origin.lat, config.origin.lng]);
    if (line.length > 1) L.polyline(line, { color: "#2B5CE6", weight: 3, opacity: 0.7, dashArray: "1 8", lineCap: "round" }).addTo(map);
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });

    return () => { map.remove(); mapRef.current = null; };
  }, [stops, config]);

  const locate = async () => {
    try {
      const p = await getCurrentPosition();
      mapRef.current?.setView([p.lat, p.lng], 15);
      window.L.circleMarker([p.lat, p.lng], { radius: 8, color: "#2B5CE6", fillColor: "#2B5CE6", fillOpacity: 0.9 }).addTo(mapRef.current);
    } catch { toast("GPS indisponível", "err"); }
  };

  const ordered = stops.filter((s) => s.order).length;
  return html`<div class="map-screen">
    <div class="map-wrap" style="position:relative;flex:1">
      <div id="map" ref=${ref}></div>
      ${ordered === 0 ? html`<div class="empty" style="position:absolute;inset:0;background:var(--bg);display:flex;flex-direction:column;justify-content:center">
        <div class="empty__icon">🗺️</div><div class="empty__title">Sem rota ainda</div>
        <div>Otimize a rota na tela Início para ver o mapa.</div></div>` : null}
      <div class="map-fab"><button onClick=${locate} aria-label="Minha localização">${html`<${Icon} name="location" width="22" height="22"/>`}</button></div>
    </div>
  </div>`;
}

/* ============================ Delivery list ============================ */
function ListView({ stops, onOpen, onScanDeliver }) {
  const ordered = useMemo(() => {
    const withOrder = stops.filter((s) => s.order).sort((a, b) => a.order - b.order);
    const without = stops.filter((s) => !s.order);
    return [...withOrder, ...without];
  }, [stops]);

  if (!stops.length)
    return html`<main class="main"><div class="empty">
      <div class="empty__icon">📦</div><div class="empty__title">Nenhuma entrega</div>
      <div>Carregue a lista do dia na tela Início.</div></div></main>`;

  const chip = (s) => {
    const map = { pending: ["chip--pending", "Pendente"], separated: ["chip--separated", "Separado"], delivered: ["chip--delivered", "Entregue"], failed: ["chip--failed", "Falhou"] };
    const [c, t] = map[s.status] || map.pending;
    return html`<span class=${"chip " + c}>${t}</span>`;
  };

  return html`<main class="main">
    <button class="btn btn--ok btn--lg" style="margin-bottom:14px" onClick=${onScanDeliver}>
      <${Icon} name="scan" width="20" height="20"/> Bipar entrega</button>
    <div class="card card--flush">
      ${ordered.map((s) => html`<div key=${s.id} class=${"stop stop--" + s.status} onClick=${() => onOpen(s)}>
        <div class=${"stop__num " + (s.order ? "" : "stop__num")} style=${s.order ? "" : ""}>
          ${s.order || "–"}</div>
        <div class="stop__body">
          <div class="stop__name">${s.name}</div>
          <div class="stop__addr">${s.address}</div>
          <div class="stop__meta">${chip(s)} ${s.code ? html`<span class="tag-code">${s.code}</span>` : null}</div>
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
      ${sub ? html`<div class="sheet__sub">${sub}</div>` : null}
      ${children}
    </div></div>`;
}

/* ============================ Import sheet ============================ */
function ImportSheet({ onClose, onAddStops }) {
  const [tab, setTab] = useState("csv");
  const [text, setText] = useState("");
  const [m, setM] = useState({ code: "", name: "", address: "", phone: "", note: "" });
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
      phone: m.phone.trim(), note: m.note.trim(), lat: ll?.lat, lng: ll?.lng, geocoded: !!ll,
      geoError: false, order: null, status: "pending", failReason: "", deliveredAt: null,
    }]);
    toast("Entrega adicionada", "ok");
    setM({ code: "", name: "", address: "", phone: "", note: "" });
  };

  return html`<${Sheet} title="Carregar entregas" sub="Importe a lista do dia ou adicione uma por uma." onClose=${onClose}>
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
          <p class="muted small" style="margin-top:-4px">Colunas reconhecidas: <b>codigo, nome, endereco, telefone</b> (e opcionalmente <b>lat, lng</b>). Aceita separador <b>;</b> ou <b>,</b>.</p>
          <button class="btn btn--lg" onClick=${doCSV}>Importar lista</button>
        </div>`
      : html`<div>
          <div class="field"><label>Código do pacote (QR/barras)</label><input class="input" value=${m.code} onInput=${(e) => setM({ ...m, code: e.target.value })} placeholder="AME001" /></div>
          <div class="field"><label>Destinatário</label><input class="input" value=${m.name} onInput=${(e) => setM({ ...m, name: e.target.value })} placeholder="Nome do cliente" /></div>
          <div class="field"><label>Endereço completo</label><input class="input" value=${m.address} onInput=${(e) => setM({ ...m, address: e.target.value })} placeholder="Rua, nº, bairro, cidade UF" /></div>
          <div class="field"><label>Telefone / WhatsApp</label><input class="input" value=${m.phone} onInput=${(e) => setM({ ...m, phone: e.target.value })} placeholder="(16) 99888-7777" /></div>
          <button class="btn btn--lg" onClick=${addManual}><${Icon} name="plus" width="18" height="18"/> Adicionar entrega</button>
          <button class="btn btn--ghost" style="margin-top:10px" onClick=${onClose}>Concluir</button>
        </div>`}
  </${Sheet}>`;
}

/* ============================ Config sheet ============================ */
function ConfigSheet({ config, onClose, onSave, onClearDay, geocoding }) {
  const [origAddr, setOrigAddr] = useState(config.origin?.label || "");
  const [finish, setFinish] = useState(!!config.finishAtOrigin);
  const [token, setToken] = useState(config.mapboxToken || "");
  const [busy, setBusy] = useState(false);

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

  return html`<${Sheet} title="Configurações" sub="Ponto de partida e preferências da rota." onClose=${onClose}>
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
    <div class="field"><label>Chave do Mapbox (obrigatória p/ mapa e endereços)</label>
      <input class="input" value=${token} onInput=${(e) => setToken(e.target.value)} placeholder="pk.eyJ1Ijoi..." onBlur=${() => onSave({ ...config, mapboxToken: token })} />
      <p class="muted small" style="margin-top:4px">Crie grátis em mapbox.com → Tokens. O plano gratuito cobre 100 mil buscas/mês — sobra pra operação. ${config.mapboxToken ? html`<b style="color:var(--ok)">✓ Chave salva</b>` : html`<b style="color:var(--danger)">Sem chave: mapa e geocoding não funcionam</b>`}</p></div>

    <div class="divider"></div>
    <button class="btn btn--danger" onClick=${() => { if (confirm("Apagar todas as entregas e zerar o dia?")) { onClearDay(); onClose(); } }}>
      <${Icon} name="x" width="18" height="18"/> Limpar dia (apagar tudo)</button>
  </${Sheet}>`;
}

/* ============================ Stop detail sheet ============================ */
function StopSheet({ stop, onClose, onUpdate }) {
  const nav = () => {
    const q = stop.geocoded ? `${stop.lat},${stop.lng}` : encodeURIComponent(stop.address);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${q}`, "_blank");
  };
  const wpp = () => {
    const num = stop.phone.replace(/\D/g, "");
    if (!num) return toast("Sem telefone cadastrado", "err");
    window.open(`https://wa.me/55${num}`, "_blank");
  };
  return html`<${Sheet} title=${`${stop.order ? stop.order + ". " : ""}${stop.name}`} sub=${stop.address} onClose=${onClose}>
    <div class="row" style="gap:8px;margin-bottom:14px;flex-wrap:wrap">
      ${stop.code ? html`<span class="tag-code">${stop.code}</span>` : null}
      <span class=${"chip chip--" + stop.status}>${stop.status}</span>
    </div>
    ${stop.note ? html`<p class="muted small">📝 ${stop.note}</p>` : null}
    <div class="btn-row" style="margin-bottom:10px">
      <button class="btn btn--navy" onClick=${nav}><${Icon} name="nav" width="18" height="18"/> Navegar</button>
      <button class="btn btn--ghost" onClick=${wpp}><${Icon} name="phone" width="18" height="18"/> WhatsApp</button>
    </div>
    ${stop.status !== "delivered"
      ? html`<button class="btn btn--ok btn--lg" onClick=${() => { onUpdate({ ...stop, status: "delivered", deliveredAt: Date.now() }); toast("Marcado como entregue", "ok"); onClose(); }}>
          <${Icon} name="check" width="20" height="20"/> Marcar entregue</button>`
      : html`<button class="btn btn--ghost" onClick=${() => { onUpdate({ ...stop, status: "separated", deliveredAt: null }); onClose(); }}>Desfazer entrega</button>`}
    ${stop.status !== "failed" && stop.status !== "delivered"
      ? html`<button class="btn btn--danger" style="margin-top:10px" onClick=${() => { const r = prompt("Motivo da falha (ausente, recusado...):") || "Não entregue"; onUpdate({ ...stop, status: "failed", failReason: r }); onClose(); }}>Registrar problema</button>`
      : null}
  </${Sheet}>`;
}

/* ============================ Geocode banner ============================ */
function GeoBanner({ progress }) {
  if (!progress) return null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return html`<div style="position:fixed;left:0;right:0;top:var(--header-h);z-index:35;max-width:560px;margin:0 auto;padding:10px 16px;background:var(--navy);color:#fff">
    <div class="row row--between" style="margin-bottom:6px"><b class="small">Localizando endereços...</b><span class="small">${progress.done}/${progress.total}</span></div>
    <div class="progress"><i style=${{ width: pct + "%" }}></i></div>
  </div>`;
}

/* ============================ App ============================ */
function App() {
  const [state, setState] = useState(loadState);
  const [view, setView] = useState("home");
  const [sheet, setSheet] = useState(null);          // 'import' | 'config' | null
  const [selStop, setSelStop] = useState(null);
  const [scanMode, setScanMode] = useState(null);    // 'separate' | 'deliver' | null
  const [scanResult, setScanResult] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
  const [geoProgress, setGeoProgress] = useState(null);

  // persiste
  useEffect(() => { saveState(state); }, [state]);

  const { stops, config } = state;
  const setStops = useCallback((updater) => setState((s) => ({ ...s, stops: typeof updater === "function" ? updater(s.stops) : updater })), []);
  const setConfig = useCallback((cfg) => setState((s) => ({ ...s, config: cfg })), []);

  const counts = useMemo(() => ({
    total: stops.length,
    delivered: stops.filter((s) => s.status === "delivered").length,
    separated: stops.filter((s) => s.status === "separated").length,
    pending: stops.filter((s) => s.status !== "delivered").length,
  }), [stops]);
  const totalKm = useMemo(() => state.lastKm || 0, [state.lastKm]);
  const hasRoute = useMemo(() => stops.some((s) => s.order), [stops]);

  /* ---- importar ---- */
  const addStops = (newStops) => {
    setStops((cur) => [...cur, ...newStops]);
    // dispara geocodificação dos que faltam
    setTimeout(() => runGeocode([...stops, ...newStops]), 200);
  };

  /* ---- geocodificar ---- */
  const runGeocode = async (list) => {
    const pending = list.filter((s) => !s.geocoded && s.address);
    if (!pending.length) return;
    if (!config.mapboxToken) { setSheet("config"); toast("Configure a chave do Mapbox para localizar endereços", "err"); return; }
    setGeoProgress({ done: 0, total: pending.length });
    try {
      await geocodeQueue(list, {
        token: config.mapboxToken,
        proximity: config.origin || null,
        onProgress: (done, total) => setGeoProgress({ done, total }),
      });
    } catch (e) {
      setGeoProgress(null);
      toast(e.message || "Falha no geocoding", "err");
      return;
    }
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
      setState((s) => ({
        ...s,
        lastKm: totalKm,
        stops: s.stops.map((st) => ({ ...st, order: orderMap.get(st.id) || null })),
      }));
      setOptimizing(false);
      setView("map");
      toast(`Rota pronta • ${order.length} paradas • ${fmtKm(totalKm)} km${ungeocoded ? ` • ${ungeocoded} sem local` : ""}`, "ok");
    }, 50);
  };

  /* ---- scan handler ---- */
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

  const openScan = (mode) => {
    if (!stops.length) { setSheet("import"); return toast("Carregue as entregas primeiro", "err"); }
    if (mode === "separate" && !hasRoute) { toast("Otimize a rota primeiro", "err"); return; }
    setScanMode(mode);
  };

  // intercepta a aba "Separar"
  const onSetView = (v) => {
    if (v === "scan") return openScan("separate");
    setView(v);
  };

  return html`<div class="app-shell">
    <${Header} title="AM Express" sub="Rotas & Entregas" onConfig=${() => setSheet("config")} />
    <${GeoBanner} progress=${geoProgress} />

    ${view === "home" && html`<${Dashboard} stops=${stops} config=${config} counts=${counts} totalKm=${totalKm}
      optimizing=${optimizing} hasRoute=${hasRoute}
      onImport=${() => setSheet("import")} onOptimize=${runOptimize} onConfig=${() => setSheet("config")} />`}
    ${view === "map" && html`<${MapView} stops=${stops} config=${config} />`}
    ${view === "list" && html`<${ListView} stops=${stops} onOpen=${setSelStop} onScanDeliver=${() => openScan("deliver")} />`}

    <${TabBar} view=${view === "scan" ? "scan" : view} setView=${onSetView} pending=${counts.pending} />

    ${scanMode && html`<${ScannerView} stops=${stops} mode=${scanMode} count=${scanMode === "separate" ? `${counts.separated}/${counts.total}` : `${counts.delivered}/${counts.total}`}
      onMatch=${handleScan} onClose=${() => { setScanMode(null); setScanResult(null); if (view === "scan") setView("home"); }} />`}
    ${scanResult && html`<${ScanResult} result=${scanResult} onNext=${() => setScanResult(null)} onClose=${() => setScanResult(null)} />`}

    ${sheet === "import" && html`<${ImportSheet} onClose=${() => setSheet(null)} onAddStops=${addStops} />`}
    ${sheet === "config" && html`<${ConfigSheet} config=${config} geocoding=${!!geoProgress}
      onClose=${() => setSheet(null)} onSave=${setConfig}
      onClearDay=${() => { setState({ ...loadState(), stops: [], lastKm: 0 }); clearState(); toast("Dia zerado"); }} />`}
    ${selStop && html`<${StopSheet} stop=${stops.find((s) => s.id === selStop.id) || selStop} onClose=${() => setSelStop(null)}
      onUpdate=${(u) => setStops((cur) => cur.map((s) => (s.id === u.id ? u : s)))} />`}

    <${ToastHost} />
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
