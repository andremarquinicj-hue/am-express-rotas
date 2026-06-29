// api/geocode.js — busca de endereço pelo SERVIDOR (Mapbox Geocoding v6).
// Faz a chamada server-to-server, então NÃO sofre com restrição de domínio (403)
// como acontece no navegador/PWA. A chave fica no servidor (MAPBOX_TOKEN no Vercel).
// Se MAPBOX_TOKEN não estiver setado, usa o token enviado pelo app (fallback).

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // aceita GET (?q=...) ou POST ({q, proximity, token})
  let q, proximity, tokenIn;
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    q = body && body.q; proximity = body && body.proximity; tokenIn = body && body.token;
  } else {
    q = req.query && req.query.q;
    proximity = req.query && req.query.proximity;
    tokenIn = req.query && req.query.token;
  }

  q = (q || "").toString().trim();
  if (!q) { res.status(400).json({ error: "Faltou o endereço (q)." }); return; }

  const token = process.env.MAPBOX_TOKEN || tokenIn;
  if (!token) { res.status(500).json({ error: "MAPBOX_TOKEN não configurado no servidor." }); return; }

  try {
    const params = new URLSearchParams({
      q, access_token: token, country: "br", language: "pt", limit: "1",
      types: "address,street,place,postcode,locality,neighborhood",
    });
    if (proximity && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(String(proximity))) {
      params.set("proximity", String(proximity));
    }
    const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(r.status === 401 || r.status === 403 ? 403 : r.status)
        .json({ error: `mapbox ${r.status}`, detail: txt.slice(0, 200) });
      return;
    }
    const data = await r.json();
    const f = data && data.features && data.features[0];
    let lat = null, lng = null;
    if (f) {
      const c = f.properties && f.properties.coordinates;
      const g = f.geometry && f.geometry.coordinates;
      lat = (c && c.latitude != null) ? c.latitude : (Array.isArray(g) ? g[1] : null);
      lng = (c && c.longitude != null) ? c.longitude : (Array.isArray(g) ? g[0] : null);
    }
    if (lat != null && lng != null) res.status(200).json({ lat, lng });
    else res.status(200).json({ found: false });
  } catch (e) {
    res.status(500).json({ error: "Falha no geocode: " + (e && e.message ? e.message : "erro") });
  }
};
