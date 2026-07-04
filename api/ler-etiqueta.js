// api/ler-etiqueta.js — lê a etiqueta do pacote com IA (Anthropic Haiku, visão)
// Recebe uma foto (base64) e devolve os dados do DESTINATÁRIO já estruturados.
// A chave fica só no servidor (variável de ambiente ANTHROPIC_API_KEY no Vercel).

const PROMPT = `Você está lendo a etiqueta de um pacote de entrega no Brasil (pode ser J&T, Shopee, Mercado Livre, Correios, etc.).
Extraia os dados de QUEM VAI RECEBER (o destinatário), ignorando o remetente/origem.

Responda APENAS um JSON válido, sem nenhum texto antes ou depois, exatamente neste formato:
{"nome":"","endereco":"","bairro":"","cidade":"","uf":"","cep":"","codigo":"","telefone":""}

Regras:
- "endereco": logradouro + número + complemento (ex.: "Rua das Flores, 123, Apto 4"). Não inclua bairro/cidade aqui.
- "bairro", "cidade", "uf" (sigla, ex.: SP), "cep": separados.
- "codigo": o código de rastreio / número do pedido principal da etiqueta.
- "telefone": se aparecer, só números.
- Se algum campo não aparecer na etiqueta, deixe "" (string vazia). Nunca invente.`;

function extrairJSON(txt) {
  if (!txt) return null;
  // tenta achar o primeiro bloco { ... }
  const m = txt.match(/\{[\s\S]*\}/);
  const raw = m ? m[0] : txt;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = async (req, res) => {
  // CORS básico (mesmo domínio, mas garante)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST" }); return; }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: "Chave da IA não configurada no servidor (ANTHROPIC_API_KEY)." }); return; }

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const image = body && body.image;
    if (!image) { res.status(400).json({ error: "Nenhuma imagem recebida." }); return; }

    // separa media_type e dados do data URL
    let media = "image/jpeg";
    let data = image;
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(image);
    if (m) { media = m[1]; data = m[2]; }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media, data } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });

    const j = await r.json();
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) || ("HTTP " + r.status);
      res.status(502).json({ error: "Falha na IA: " + msg });
      return;
    }

    const txt = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const dados = extrairJSON(txt);
    if (!dados) { res.status(200).json({ ok: false, error: "Não consegui ler a etiqueta. Tente uma foto mais nítida.", raw: txt }); return; }

    res.status(200).json({ ok: true, dados });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
