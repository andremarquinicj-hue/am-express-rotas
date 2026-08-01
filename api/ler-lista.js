// api/ler-lista.js — lê um PRINT da lista de entregas (ex.: app da transportadora)
// e devolve TODAS as entregas visíveis, já estruturadas. Um print = vários pacotes.
// A chave fica só no servidor (variável de ambiente ANTHROPIC_API_KEY no Vercel).

const PROMPT = `Esta é uma CAPTURA DE TELA de um aplicativo de transportadora com uma LISTA de entregas no Brasil.
Cada cartão da lista tem: nome do cliente, um número entre parênteses (quantidade de pacotes) e o endereço.

Extraia TODAS as entregas COMPLETAMENTE visíveis e devolva APENAS um array JSON válido, sem nenhum texto antes ou depois:
[{"nome":"","qtd":1,"endereco":"","complemento":"","bairro":"","cidade":"","uf":"","cep":""}]

Regras IMPORTANTES:
- "qtd": o número entre parênteses após o nome. Se não houver, use 1.
- "endereco": SÓ logradouro + número, no formato "Rua Nome da Rua, 123". Normalize:
  · Se o número vier ANTES da rua (ex.: "57,Rua José de Mattos"), corrija para "Rua José de Mattos, 57".
  · Se o número aparecer DUPLICADO (ex.: "Rua Honório Gasparino 594 594"), use uma vez só: "Rua Honório Gasparino, 594".
  · Palavras como "casa", "Casa" junto do número são complemento (ex.: "Avenida X Casa 55" → endereco "Avenida X, 55", complemento "casa").
- "bairro", "cidade", "uf" (sigla), "cep": separados. Se o texto estiver CORTADO com "..." mas for óbvio, complete (ex.: "São P..." ou "Sã..." no fim = uf "SP"; "Dobrad..." = cidade "Dobrada"). Se não for óbvio, deixe "".
- Cartões CORTADOS no topo ou no fim da tela (sem nome ou sem endereço legível por inteiro): NÃO inclua — eles aparecem completos em outro print.
- Nunca invente dados. Campo ausente = "" (ou 1 para qtd).`;

function extrairArray(txt) {
  if (!txt) return null;
  const m = txt.match(/\[[\s\S]*\]/);
  const raw = m ? m[0] : txt;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

module.exports = async (req, res) => {
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

    let media = "image/jpeg";
    let data = image;
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(image);
    if (m) { media = m[1]; data = m[2]; }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 3000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media, data } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      res.status(502).json({ error: "Falha na IA de leitura.", detail: errTxt.slice(0, 300) });
      return;
    }
    const j = await r.json();
    const txt = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const itens = extrairArray(txt);
    if (!itens) { res.status(200).json({ ok: false, error: "Não consegui estruturar a lista deste print." }); return; }
    // saneamento leve
    const limpos = itens
      .filter((x) => x && (x.nome || x.endereco))
      .map((x) => ({
        nome: String(x.nome || "").trim(),
        qtd: Math.max(1, parseInt(x.qtd, 10) || 1),
        endereco: String(x.endereco || "").trim(),
        complemento: String(x.complemento || "").trim(),
        bairro: String(x.bairro || "").trim(),
        cidade: String(x.cidade || "").trim(),
        uf: String(x.uf || "").trim().toUpperCase().slice(0, 2),
        cep: String(x.cep || "").replace(/\D/g, ""),
      }));
    res.status(200).json({ ok: true, itens: limpos });
  } catch (e) {
    res.status(500).json({ error: "Erro ao ler o print.", detail: String(e && e.message || e).slice(0, 200) });
  }
};
