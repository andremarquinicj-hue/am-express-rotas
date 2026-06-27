// ocr.js — câmera ao vivo + captura da etiqueta + leitura via IA (/api/ler-etiqueta)

let _stream = null;

// Liga a câmera traseira no elemento <video>.
export async function startCamera(videoEl) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Câmera não suportada neste navegador.");
  _stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  videoEl.srcObject = _stream;
  await videoEl.play().catch(() => {});
  return _stream;
}

export function stopCamera() {
  try { _stream?.getTracks().forEach((t) => t.stop()); } catch {}
  _stream = null;
}

// Captura o frame atual do vídeo, reduz e comprime em JPEG base64 (data URL).
export function capturePhoto(videoEl, maxSide = 1400, quality = 0.72) {
  const vw = videoEl.videoWidth || 1280;
  const vh = videoEl.videoHeight || 720;
  let w = vw, h = vh;
  if (Math.max(w, h) > maxSide) {
    const r = maxSide / Math.max(w, h);
    w = Math.round(w * r); h = Math.round(h * r);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

// Manda a foto pra IA ler. Retorna { ok, dados } ou { ok:false, error }.
export async function lerEtiqueta(dataUrl, { signal } = {}) {
  const res = await fetch("/api/ler-etiqueta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
    signal,
  });
  let j;
  try { j = await res.json(); } catch { throw new Error("Resposta inválida do servidor."); }
  if (!res.ok) throw new Error(j?.error || ("Erro " + res.status));
  return j;
}

// Monta o endereço completo (pra geocodificar) a partir dos campos lidos.
export function montarEndereco(d) {
  const partes = [d.endereco, d.bairro, d.cidade, d.uf].map((x) => (x || "").trim()).filter(Boolean);
  let s = partes.join(", ");
  if (d.cep && d.cep.trim()) s += " " + d.cep.trim();
  return s;
}
