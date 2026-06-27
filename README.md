# AM Express · Rotas 🚚

App PWA para o entregador da **AM Express**: bipa os códigos de barras / QR dos pacotes, **traça a melhor rota**, **numera as entregas** e controla **quantos pacotes entregou** e **quantos KM andou** no dia.

Feito pra rodar no celular, instalável como app (PWA), sem precisar de loja.

---

## 🧠 Como o app funciona (o novo fluxo com IA)

O código de barras do pacote, sozinho, é **só um número** — não tem o endereço dentro. Por isso o app **lê a etiqueta inteira por foto**: a IA enxerga o texto e preenche o endereço sozinha. Fluxo do dia:

1. **Login** → o entregador entra com nome + senha de acesso.
2. **Bipar etiquetas (foto)** → aponte a câmera para a etiqueta de cada pacote. A IA lê **nome, endereço, código e telefone**, você confere rapidinho e adiciona. (Tem também inserção manual e import de planilha como reserva.)
3. **Otimizar a rota** → o app calcula a melhor ordem saindo do galpão (tempo + combustível). **Cada parada ganha um número.**
4. **Numerar** → bipe o código de barras de cada pacote e o app mostra o **número GIGANTE** da parada na ordem da rota. Escreva no pacote.
5. **Rota** → abra o mapa e siga a **rota real nas ruas**, com sua **localização ao vivo** acompanhando (a tela fica acesa durante a navegação).
6. **Entregar** → em cada parada, bipe pra confirmar. O painel mostra `entregues X / total` e os **KM**.
7. **Histórico** → consulte os dias anteriores e exporte o **relatório AM Express** (CSV).

> A IA é o caminho principal pra preencher o endereço sem digitar. O código (que a IA lê da etiqueta) é o que **casa** o pacote físico com a parada na hora de numerar.

---

## 🤖 Chave da IA (obrigatória pra leitura da etiqueta)

A leitura por foto usa a API da Anthropic (modelo Haiku) através de uma função no Vercel (`api/ler-etiqueta.js`) — a chave fica **só no servidor**, nunca no celular. Para ativar:

1. No Vercel, abra o projeto → **Settings → Environment Variables**.
2. Adicione uma variável:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** sua chave da Anthropic (a mesma linha que você usa no IronCut)
3. Salve e faça um **Redeploy** (Deployments → ... → Redeploy) pra valer.

Custo: o Haiku lê cada etiqueta por **fração de centavo** — alguns centavos no dia inteiro com 100–200 pacotes. Sem a chave, a leitura por IA não funciona, mas a inserção manual e o import de planilha continuam funcionando normalmente.

---

## 📄 Reserva: importar planilha (CSV)

Se um dia você tiver a lista pronta, dá pra importar em vez de fotografar. Salve como **CSV** (no Excel/Sheets: *Arquivo → Baixar/Salvar como → CSV*). Aceita `;`, `,` ou tabulação. Exemplo:

```csv
codigo;nome;endereco;telefone
AMX001;Maria Silva;Rua das Flores 123, Centro, Jaboticabal SP;16999990001
AMX002;João Souza;Av. Brasil 456, Jaboticabal SP;16999990002
```

**Colunas aceitas:** `codigo`, `nome`, `endereco` (obrigatória), `telefone`, e opcionalmente `lat`/`lng`.

> **Dica:** se a planilha já tiver `lat` e `lng`, o app pula o geocoding (instantâneo e exato).

---

## 📱 Como usar no dia a dia

1. **Entre** com seu nome e a senha (padrão: `amexpress2026` — troque depois, veja abaixo).
2. Em **⚙️ Configurações**, defina o **galpão** (endereço ou GPS) e cole a **chave do Mapbox**.
3. Toque em **Bipar etiquetas** e fotografe cada pacote. Confira o endereço e adicione.
4. Toque em **Otimizar rota** — as paradas ganham número e aparecem no mapa.
5. Aba **Numerar** → bipe o código de barras de cada pacote e escreva o número que aparece.
6. Aba **Rota** → toque em **Iniciar navegação** e siga a rota real com sua posição ao vivo.
7. Aba **Entregas** → bipe pra confirmar cada entrega (ou toque na parada pra abrir no mapa / WhatsApp).
8. **🕘 Histórico** (ícone no topo) → veja os dias e exporte o relatório.

> ⚠️ Câmera, GPS e "tela sempre acesa" só funcionam em **HTTPS** (o Vercel entrega) e melhor ainda com o app **instalado** (PWA) no celular.

### 🔒 Trocar a senha de acesso
A senha padrão é `amexpress2026`. Para trocar, gere o SHA-256 da nova senha e substitua a constante `SENHA_HASH` em `modules/auth.js`. (Na Fase 2, isso vira login individual por entregador via Firebase.)

---


## 🔑 Chave do Mapbox (mapa + endereços)

O app usa o **Mapbox** pro mapa e pra transformar endereço em coordenada (geocoding). É **gratuito** no seu volume — o plano free cobre **100 mil buscas/mês** e **50 mil carregamentos de mapa/mês**, e sua operação (~6 mil/mês) cabe folgado.

Como pegar a chave (uma vez só):

1. Crie conta em <https://account.mapbox.com/auth/signup/>.
2. Entre em **Tokens** (<https://account.mapbox.com/access-tokens/>).
3. Copie o **Default public token** (começa com `pk.`) — ou crie um novo.
4. No app, vá em **Configurar** e cole a chave no campo **Chave do Mapbox**.

> Dica de segurança: como é um app público, a chave fica visível no navegador (é um *public token*, feito pra isso). Pra proteger, no painel do Mapbox você pode adicionar **URL restrictions** liberando só o domínio do seu Vercel (ex.: `am-express-rotas.vercel.app`). Assim ninguém usa sua chave em outro site.

---

## 🚀 Subir no GitHub + Vercel (deploy)

Este projeto é **100% estático** (sem build). Dá pra publicar em minutos.

### 1) GitHub

**Opção A — pelo site (mais fácil):**
1. Crie um repositório novo em <https://github.com/new> (ex.: `am-express-rotas`), público ou privado.
2. Na página do repo vazio, clique em **uploading an existing file**.
3. **Arraste todos os arquivos e pastas** deste projeto (mantendo as pastas `assets/` e `modules/`).
4. **Commit changes**.

**Opção B — pelo terminal:**
```bash
cd am-express-rotas
git init
git add .
git commit -m "AM Express Rotas — MVP"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/am-express-rotas.git
git push -u origin main
```

### 2) Vercel

1. Entre em <https://vercel.com> com sua conta GitHub.
2. **Add New… → Project** → **Import** o repositório `am-express-rotas`.
3. Em **Framework Preset**, deixe **Other** (é estático).
4. **Build Command:** deixe **vazio**. **Output Directory:** deixe **vazio** (ou `.`).
5. **Deploy**.

Em ~30s o Vercel te dá uma URL tipo `https://am-express-rotas.vercel.app` (com HTTPS, então a câmera funciona). Cada `git push` novo faz o deploy sozinho.

### 3) Instalar no celular (PWA)

- **Android (Chrome):** abra a URL → menu **⋮** → **Instalar app / Adicionar à tela inicial**.
- **iPhone (Safari):** abra a URL → botão **Compartilhar** → **Adicionar à Tela de Início**.

---

## 🧩 Stack

- **Preact + htm** via CDN (sem build step) · **localStorage** pra persistir o dia
- **Leaflet + Mapbox** (tiles do mapa)
- **Mapbox Geocoding API v6** pra transformar endereço em coordenada (com cache local)
- **TSP heurístico** próprio (nearest-neighbor + 2-opt) pra otimizar a rota no próprio celular
- **html5-qrcode** pra ler QR e códigos de barras (Code128/39, EAN, ITF, DataMatrix, PDF417…)
- **Service Worker** pra funcionar offline (menos mapa/geocoding, que precisam de internet)

## ⚠️ Sobre escala e próximos passos

Com o Mapbox no plano gratuito você tá coberto pra rodar diariamente sem estourar limite. Se um dia a operação crescer muito (acima de 100 mil buscas/mês), o Mapbox cobra a partir daí — mas o app já **cacheia** os endereços e aceita **lat/lng direto no CSV**, então dá pra reduzir bem as buscas. Se a planilha de origem já vier com coordenadas, o geocoding nem é usado.

Próximas iterações possíveis: **OCR da etiqueta** (ler endereço pela foto), **rota por ruas reais** (Mapbox Directions/Optimization, em vez da linha reta), e **integração com a API da AM Express**.

---

Feito pra AM Express. 💙
