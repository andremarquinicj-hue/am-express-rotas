// csv.js — parser de CSV/planilha com mapeamento flexível de colunas (PT-BR)
import { uid } from "./storage.js";
import { parseLatLng } from "./geo.js";

function detectSep(line) {
  const c = (line.match(/;/g) || []).length;
  const v = (line.match(/,/g) || []).length;
  const t = (line.match(/\t/g) || []).length;
  if (t >= c && t >= v) return "\t";
  return c >= v ? ";" : ",";
}

function splitLine(line, sep) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === sep && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

const FIELD_ALIASES = {
  code:    ["codigo", "código", "code", "rastreio", "rastreamento", "tracking", "id", "nf", "pedido", "etiqueta", "barcode", "qr"],
  name:    ["nome", "name", "destinatario", "destinatário", "cliente", "recebedor"],
  address: ["endereco", "endereço", "address", "destino", "logradouro", "local", "rua"],
  phone:   ["telefone", "fone", "phone", "celular", "whatsapp", "contato"],
  lat:     ["lat", "latitude"],
  lng:     ["lng", "lon", "long", "longitude"],
  note:    ["obs", "observacao", "observação", "nota", "complemento", "referencia", "referência", "note"],
};

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some((a) => n === a || n.includes(a))) { map[field] = i; break; }
    }
  });
  return map;
}

// Retorna { stops, total, skipped, hasHeader }
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { stops: [], total: 0, skipped: 0 };
  const sep = detectSep(lines[0]);
  const firstCells = splitLine(lines[0], sep);

  // header presente se alguma célula casar com alias conhecido
  const map = mapHeaders(firstCells);
  const hasHeader = Object.keys(map).length >= 2;

  let rows, colMap;
  if (hasHeader) {
    rows = lines.slice(1);
    colMap = map;
  } else {
    // sem cabeçalho: assume ordem código, nome, endereço, telefone
    rows = lines;
    colMap = { code: 0, name: 1, address: 2, phone: 3 };
  }

  const stops = [];
  let skipped = 0;
  for (const line of rows) {
    const c = splitLine(line, sep);
    const get = (f) => (colMap[f] !== undefined ? (c[colMap[f]] || "").trim() : "");
    const address = get("address");
    const code = get("code");
    if (!address && !(get("lat") && get("lng"))) { skipped++; continue; }

    let lat, lng, geocoded = false;
    if (colMap.lat !== undefined && colMap.lng !== undefined) {
      const la = parseFloat(get("lat").replace(",", "."));
      const lo = parseFloat(get("lng").replace(",", "."));
      if (!isNaN(la) && !isNaN(lo)) { lat = la; lng = lo; geocoded = true; }
    }
    // permite "lat,lng" dentro do campo endereço
    if (!geocoded) {
      const p = parseLatLng(address);
      if (p) { lat = p.lat; lng = p.lng; geocoded = true; }
    }

    stops.push({
      id: uid(),
      code: code || "",
      name: get("name") || "Sem nome",
      address: address || `${lat}, ${lng}`,
      phone: get("phone") || "",
      note: get("note") || "",
      lat, lng, geocoded,
      geoError: false,
      order: null,
      status: "pending",     // pending | separated | delivered | failed
      failReason: "",
      deliveredAt: null,
    });
  }
  return { stops, total: stops.length, skipped, hasHeader };
}
