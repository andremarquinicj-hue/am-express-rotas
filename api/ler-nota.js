// api/ler-nota.js — lê a foto de uma NOTA FISCAL (DANFE) e extrai o DESTINATÁRIO
// (para onde entregar) e a QUANTIDADE DE VOLUMES (caixas). Uma nota = uma parada.
// A chave da IA fica só no servidor (ANTHROPIC_API_KEY no Vercel).

const PROMPT = `Esta é a foto de uma NOTA FISCAL ELETRÔNICA brasileira (DANFE).

Extraia os dados de ENTREGA e devolva APENAS um objeto JSON válido, sem nenhum texto antes ou depois:
{"nome":"","cnpj":"","endereco":"","complemento":"","bairro":"","cidade":"","uf":"","cep":"","telefone":"","volumes":1,"especie":"","peso":"","nf":"","pedido":""}

REGRA MAIS IMPORTANTE — de quem são os dados:
- Use SEMPRE o quadro "DESTINATÁRIO / REMETENTE" (é para onde a mercadoria vai).
- NUNCA use os dados do EMITENTE (topo da nota, quem vendeu) nem do TRANSPORTADOR.
- Se houver um quadro "LOCAL DE ENTREGA" ou "ENTREGA" diferente do destinatário, PREFIRA o local de entrega.

Campos:
- "nome": NOME/RAZÃO SOCIAL do destinatário.
- "cnpj": CNPJ/CPF do destinatário, só dígitos.
- "endereco": SÓ logradouro + número, formato "Rua Nome da Rua, 123". Se o número estiver em campo separado ou junto ("Av. Brasil 1500"), normalize para "Av. Brasil, 1500". Se não houver número, deixe só o logradouro.
- "complemento": sala, galpão, quadra, lote, km, referência (ex.: "Galpão 3", "KM 12").
- "bairro": BAIRRO/DISTRITO. "cidade": MUNICÍPIO. "uf": sigla de 2 letras. "cep": só dígitos.
- "telefone": FONE/FAX do destinatário, só dígitos.
- "volumes": a QUANTIDADE no quadro "TRANSPORTADOR / VOLUMES TRANSPORTADOS" (campo QUANTIDADE). É o número de caixas/volumes. Se houver várias linhas de volume, some. Se não encontrar, use 1.
- "especie": ESPÉCIE dos volumes (ex.: "CAIXA", "PALLET", "VOLUME"). Se não houver, "".
- "peso": PESO BRUTO como aparece (ex.: "45,500"). Se não houver, "".
- "nf": o número da nota (campo "Nº" do cabeçalho do DANFE), só dígitos.
- "pedido": número do pedido/OC se aparecer, senão "".

Nunca invente. Campo ilegível ou ausente = "" (ou 1 para volumes).`;

function extrairObj(txt) {
  if (!txt) return null;
  const m = txt.match(/\{[\s\S]*\}/);
  const raw = m ? m[0] : txt;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
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
        max_tokens: 1500,
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
    const o = extrairObj(txt);
    if (!o) { res.status(200).json({ ok: false, error: "Não consegui ler os dados desta nota." }); return; }

    const nota = {
      nome: String(o.nome || "").trim(),
      cnpj: String(o.cnpj || "").replace(/\D/g, ""),
      endereco: String(o.endereco || "").trim(),
      complemento: String(o.complemento || "").trim(),
      bairro: String(o.bairro || "").trim(),
      cidade: String(o.cidade || "").trim(),
      uf: String(o.uf || "").trim().toUpperCase().slice(0, 2),
      cep: String(o.cep || "").replace(/\D/g, ""),
      telefone: String(o.telefone || "").replace(/\D/g, ""),
      volumes: Math.max(1, parseInt(o.volumes, 10) || 1),
      especie: String(o.especie || "").trim(),
      peso: String(o.peso || "").trim(),
      nf: String(o.nf || "").replace(/\D/g, ""),
      pedido: String(o.pedido || "").trim(),
    };
    if (!nota.endereco && !nota.cep) { res.status(200).json({ ok: false, error: "Não achei o endereço do destinatário nesta foto." }); return; }
    res.status(200).json({ ok: true, nota });
  } catch (e) {
    res.status(500).json({ error: "Erro ao ler a nota.", detail: String(e && e.message || e).slice(0, 200) });
  }
};
