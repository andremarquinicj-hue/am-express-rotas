// scanner.js — wrapper do leitor de QR/código de barras (html5-qrcode via global)
let instance = null;
let lastCode = null;
let lastAt = 0;

function supportedFormats() {
  const F = window.Html5QrcodeSupportedFormats;
  if (!F) return undefined;
  return [
    F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93,
    F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E,
    F.ITF, F.CODABAR, F.DATA_MATRIX, F.PDF_417, F.AZTEC,
  ].filter((x) => x !== undefined);
}

export async function startScanner(elementId, onDecode) {
  const { Html5Qrcode } = window;
  if (!Html5Qrcode) throw new Error("Leitor não carregou. Verifique a conexão.");
  if (instance) await stopScanner();

  instance = new Html5Qrcode(elementId, {
    verbose: false,
    formatsToSupport: supportedFormats(),
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });

  const config = {
    fps: 12,
    qrbox: (vw, vh) => {
      const min = Math.min(vw, vh);
      const w = Math.floor(min * 0.72);
      return { width: w, height: Math.floor(w * 0.66) };
    },
    aspectRatio: 1.33,
  };

  await instance.start(
    { facingMode: "environment" },
    config,
    (decoded) => {
      const now = Date.now();
      if (decoded === lastCode && now - lastAt < 1400) return; // cooldown anti-duplicata
      lastCode = decoded; lastAt = now;
      onDecode(decoded);
    },
    () => {} // ignora erros de frame
  );
}

export async function stopScanner() {
  if (!instance) return;
  try { await instance.stop(); } catch {}
  try { instance.clear(); } catch {}
  instance = null;
  lastCode = null;
}

export function feedback(kind = "ok") {
  // vibração
  try {
    if (navigator.vibrate) navigator.vibrate(kind === "bad" ? [80, 60, 80] : 60);
  } catch {}
  // beep curto via WebAudio
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (feedback._ctx ||= new Ctx());
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = kind === "bad" ? 220 : kind === "dup" ? 440 : 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    o.start(); o.stop(ctx.currentTime + 0.2);
  } catch {}
}
