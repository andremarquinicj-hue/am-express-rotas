// history.js — registro diário das entregas + exportação de relatório AM Express

const HIST_KEY = "amx:history:v1";

function load() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || "{}"); } catch { return {}; }
}
function save(obj) {
  try { localStorage.setItem(HIST_KEY, JSON.stringify(obj)); } catch {}
}

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Salva/atualiza o resumo do dia atual. Chamar sempre que o estado muda.
// resumo: { entregador, total, entregues, falhas, km }
export function registrarDia(resumo) {
  const all = load();
  const dia = hojeISO();
  all[dia] = {
    data: dia,
    entregador: resumo.entregador || "Entregador",
    total: resumo.total || 0,
    entregues: resumo.entregues || 0,
    falhas: resumo.falhas || 0,
    km: Math.round((resumo.km || 0) * 10) / 10,
    atualizadoEm: Date.now(),
  };
  save(all);
}

// Lista os dias, mais recente primeiro.
export function listarHistorico() {
  const all = load();
  return Object.values(all).sort((a, b) => (a.data < b.data ? 1 : -1));
}

export function limparHistorico() {
  save({});
}

function fmtData(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Gera o CSV do relatório e dispara o download.
export function exportarCSV(linhas) {
  const head = ["Data", "Entregador", "Pacotes", "Entregues", "Falhas", "% Conclusão", "KM rodados"];
  const rows = linhas.map((r) => {
    const pct = r.total ? Math.round((r.entregues / r.total) * 100) : 0;
    return [fmtData(r.data), r.entregador, r.total, r.entregues, r.falhas, pct + "%", String(r.km).replace(".", ",")];
  });
  const csv = [head, ...rows].map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `AM-Express-relatorio-${hojeISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
