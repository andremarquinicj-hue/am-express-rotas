// api/cep.js — busca de endereço pelo CEP (ViaCEP), via SERVIDOR.
// Evita qualquer problema de CORS/domínio no navegador. Não precisa de chave.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const raw = (req.query && req.query.cep) || "";
  const cep = String(raw).replace(/\D/g, "");
  if (cep.length !== 8) { res.status(400).json({ error: "CEP precisa ter 8 dígitos." }); return; }

  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { headers: { Accept: "application/json" } });
    if (!r.ok) { res.status(502).json({ error: "ViaCEP indisponível." }); return; }
    const data = await r.json();
    if (data.erro) { res.status(200).json({ found: false }); return; }
    res.status(200).json({
      found: true,
      cep: data.cep || cep,
      endereco: data.logradouro || "",   // rua/avenida (sem número)
      bairro: data.bairro || "",
      cidade: data.localidade || "",
      uf: data.uf || "",
    });
  } catch (e) {
    res.status(500).json({ error: "Falha ao buscar CEP: " + (e && e.message ? e.message : "erro") });
  }
};
