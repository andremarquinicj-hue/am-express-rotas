# AM Express · Rotas 🚚

App PWA para o entregador da **AM Express**: bipa os códigos de barras / QR dos pacotes, **traça a melhor rota**, **numera as entregas** e controla **quantos pacotes entregou** e **quantos KM andou** no dia.

Feito pra rodar no celular, instalável como app (PWA), sem precisar de loja.

---

## 🧠 Como o app funciona (o "pulo do gato")

O código de barras do pacote, sozinho, é **só um número** — ele não tem o endereço dentro. (É assim no Mercado Livre, Shopee, Circuit, todos.) Então o fluxo certo é este:

1. **Carregar as entregas do dia** → você importa um CSV/planilha (ou digita) com os endereços. O app geocodifica (acha a coordenada de cada um).
2. **Otimizar a rota** → o app calcula a melhor ordem saindo do galpão. **Cada parada ganha um número.**
3. **Separar / Numerar** → você bipa um pacote e o app mostra um **número GIGANTE** na tela. Você escreve esse número no pacote com caneta. Pronto: pacote numerado na ordem da rota.
4. **Entregar** → segue a rota no mapa. Em cada parada, bipa o pacote pra confirmar a entrega.
5. **Acompanhar** → o painel mostra `entregues X / total`, a barra de progresso e os **KM** do dia.

> Resumindo: o número do código de barras serve pra **casar** o pacote físico com a parada da rota. O endereço vem da planilha, não do código.

---

## 📄 Formato do CSV (planilha de entregas)

Salve a planilha como **CSV** (no Excel/Google Sheets: *Arquivo → Baixar/Salvar como → CSV*). O app aceita `;`, `,` ou tabulação como separador e reconhece nomes de coluna em português. Exemplo:

```csv
codigo;nome;endereco;telefone;obs
AMX001;Maria Silva;Rua das Flores 123, Centro, Jaboticabal SP;16999990001;Portão azul
AMX002;João Souza;Av. Brasil 456, Jaboticabal SP;16999990002;
AMX003;Ana Lima;Rua 7 de Setembro 89, Jaboticabal SP;;Deixar na portaria
```

**Colunas aceitas** (use as que tiver):

| Coluna       | Aliases aceitos                          | Obrigatória? |
|--------------|------------------------------------------|--------------|
| `codigo`     | codigo, código, code, id, pacote         | Recomendado  |
| `nome`       | nome, cliente, destinatario              | Opcional     |
| `endereco`   | endereco, endereço, address, local       | **Sim**\*    |
| `telefone`   | telefone, fone, celular, whatsapp        | Opcional     |
| `lat`        | lat, latitude                            | Opcional     |
| `lng`        | lng, lon, long, longitude                | Opcional     |
| `obs`        | obs, observacao, nota, complemento       | Opcional     |

\* **Dica de ouro:** se a sua planilha já tiver `lat` e `lng`, o app **pula o geocoding** (fica instantâneo e 100% preciso). Se não tiver, ele busca a coordenada pelo endereço — funciona, mas endereço bem escrito (com cidade e estado) ajuda muito.

---

## 📱 Como usar no dia a dia

1. Abra o app e vá em **Configurar** → cole sua **chave do Mapbox** (veja como pegar abaixo) e defina o **galpão** (endereço ou "usar minha localização").
2. Toque em **Importar** → cole/escolha o CSV (ou digite manual).
3. Toque em **Otimizar rota**. As paradas ganham número e aparecem no mapa.
4. Aba **Separar** → bipe cada pacote e escreva o número que aparecer.
5. Aba **Rota / Entregas** → siga a ordem. Em cada cliente, toque na parada pra **navegar (Google Maps)** ou **chamar no WhatsApp**, e bipe pra **confirmar a entrega**.
6. O painel **Início** mostra entregues e KM do dia.

> ⚠️ A câmera só funciona em **HTTPS** (o Vercel já entrega isso) e quando você **instala o app** (PWA) ou abre num navegador que permite câmera.

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
