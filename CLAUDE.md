# MotoLeilão — Instruções para Claude Code

## O que é
Dashboard de monitoramento de leilões de motos com sistema de assinaturas.

- **Site:** https://motoleiloes.com.br — HTTPS ativo (Enforce HTTPS no GitHub Pages)
- **Site legado (redireciona):** https://jgmpereira.github.io/motoleilao
- **Repositório:** https://github.com/jgmpereira/motoleilao (branch: `main`)
- **Supabase:** https://ntlwhwmtsyniinbkwjgg.supabase.co
- **Supabase CLI:** `/tmp/supabase/supabase`

---

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | HTML single-file (`index.html`) — CSS e JS embutidos, sem bundler |
| Backend | Supabase REST API (sem SDK — usar `fetch` direto) |
| Hospedagem | GitHub Pages |
| Scraping | Node.js + Playwright |
| Automação | GitHub Actions |
| Dev | GitHub Codespaces |
| Monetização | Kiwify R$19,90/mês + Supabase Auth + Resend + Edge Functions |

---

## Regras absolutas

- **Nunca desativar RLS** — está ativo em todas as tabelas. Não contornar, não sugerir bypass.
- **Não usar Supabase JS SDK** — sempre `fetch` direto na REST API.
- **Não instalar dependências pesadas** — projeto sem bundler; imports via CDN se necessário.
- **Não alterar schema do Supabase** sem verificar impacto no RLS e nos scrapers.
- **Não modificar branch `main` sem testar** o scraper/função afetada antes.
- **Email via Resend:** domínio `motoleiloes.com.br` verificado; envio liberado para qualquer destinatário. Remetente padrão: `contato@motoleiloes.com.br`.

---

## Git — sempre junto

```bash
git add . && git commit -m "mensagem clara" && git push
```

Mensagens de commit em português, descritivas.

---

## Variáveis de ambiente

Ficam em `.env` na raiz (recriar se Codespaces resetar) e nos Secrets do repositório GitHub.

| Variável | Uso |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_KEY` | Chave de serviço (bypassa RLS — só nos scrapers/scripts) |
| `RESEND_API_KEY` | Envio de emails |
| `FIPE_TOKEN` | Header `X-Subscription-Token` para `fipe.parallelum.com.br` v2 |
| `KIWIFY_WEBHOOK_SECRET` | Autenticação do webhook Kiwify |

---

## Banco de dados

### `leiloes`
| Coluna | Tipo | Notas |
|---|---|---|
| id | text | Ex: `sodre_2026_03_30` |
| plataforma | text | Ex: `Sodré Santoro` |
| data | date | Data do leilão |
| hora | text | Horário |
| nome | text | Nome do leilão |
| link | text | URL no site da leiloeira |
| encerrado | bool | `false` = ativo, `true` = encerrado |

### `motos`
| Coluna | Tipo | Notas |
|---|---|---|
| id | int | PK |
| leilao_id | text | FK → leiloes.id |
| lote | text | |
| marca | text | |
| modelo | text | |
| ano | text | Ex: `23/24` |
| cilindrada | int | Em cc |
| condicao | text | `financiada`, `sinistro`, `sucata`, `lotamento` |
| lance_inicial | numeric | |
| url | text | URL do lote |
| foto | text | URL da foto |
| fipe_csv | numeric | Valor FIPE em cache no registro |

### `arrematados`
| Coluna | Tipo | Notas |
|---|---|---|
| id | int | PK |
| moto_id | int | FK → motos.id |
| valor | numeric | Valor arrematado |
| status_arrematado | text | `vendido` ou `condicional` |
| data_registro | timestamp | |

### `fipe_modelos`
| Coluna | Tipo | Notas |
|---|---|---|
| key | text | PK: `marca\|modelo\|ano` |
| marca_codigo | text | |
| modelo_codigo | text | |
| ano_codigo | text | |

### `fipe_valores`
| Coluna | Tipo | Notas |
|---|---|---|
| key | text | PK: `marca\|modelo\|ano` |
| valor | numeric | Valor FIPE em R$ |
| mes_referencia | text | |
| atualizado_em | timestamp | |

### `assinantes`
| Coluna | Notas |
|---|---|
| email | Identificador do assinante |
| status | `ativo` ou outro — bloqueia acesso se != `ativo` |
| plano | |
| data_inicio / data_cancelamento | |
| kiwify_order_id | |

---

## Scrapers

| Script | Plataforma | Estratégia | Horário BRT |
|---|---|---|---|
| `scrapers/sodre.js` | Sodré Santoro | Paginação `&page=N` | 8h diário |
| `scrapers/sodre-encerrados.js` | Sodré (encerrados) | API `prd-api.sodresantoro.com.br/api/v1/lots-finished` | 20h diário |
| `scrapers/freitas.js` | Freitas | Fetch HTML + regex, sem Playwright | 6h20 diário |
| `scrapers/vip.js` | VIP Leilões | Cookie via redirect 302 + POST paginado | 6h40 diário |
| `scrapers/superbid.js` | Superbid | REST JSON paginado, 3 estratégias de parsing | 7h diário |
| `scrapers/superbid-encerrados.js` | Superbid (encerrados) | Página SSR `/oferta/{id}` (`__NEXT_DATA__`); sinal `hasBids`, valor = `currentMaxBid` | 21h diário |
| `scrapers/copart.js` | Copart | **Playwright obrigatório** — WAF Imperva bloqueia fetch direto | 6h50 diário |
| `scripts/fipe-diario.js` | FIPE | Orquestra `popular-fipe.js` (motos novas, prioridade) + `atualizar-fipe-mensal.js` (preços velhos), cota compartilhada — roda no workflow `fipe-diario.yml` | 9h diário |
| `scripts/backup-supabase.js` | Backup | Exporta tabelas críticas → `backups/YYYY-MM-DD/` | 3h diário |

> A API FIPE (`fipe.parallelum.com.br` / `fipe.online`) limita **1.000 requisições por DIA** com token gratuito (500/dia sem token) — confirmado na doc oficial (`fipe.online/docs/comece-aqui`); o 429 da API é explicitamente "limite diário atingido", não é uma janela por hora. `scripts/fipe-budget.js` usa teto interno de 900/dia (margem de segurança abaixo do real).
>
> `scripts/popular-fipe.js` e `scripts/atualizar-fipe-mensal.js` também podem rodar isolados (`node scripts/popular-fipe.js`), cada um com sua própria cota de 900/dia — mas em produção rodam sempre via `fipe-diario.js`. `scripts/reprocessar-fipe.js` é manual (correção pontual), não roda em nenhum workflow.

### Atenções por scraper

**Copart:** usa `page.evaluate(fetch(...))` para paginar com a sessão/cookies do Playwright (bypassa WAF). Se o Angular mudar o endpoint ou formato DataTables, precisa recapturar o body template manualmente.

**Sodré encerrados:** processa leilões dos últimos 7 dias (janela fixa, não depende mais da flag `encerrado`) **+** qualquer leilão de até 21 dias atrás que ainda tenha arrematados com `status_arrematado=condicional` pendente — reprocessa pra pegar quando o condicional resolve pra "vendido" (corrigido Jul/2026: antes só reprocessava os 3 dias e condicionais que resolviam depois disso ficavam congelados pra sempre). Passado ~1 semana a API do Sodré (`lots-finished`) já não retorna mais dados do leilão (confirmado testando direto) — condicionais mais antigos que isso não têm mais como ser corrigidos automaticamente, o dado já não existe mais do lado do Sodré.

**Sodré encerrados — bug de colisão de lote entre auction_ids diferentes no mesmo dia (corrigido Jul/2026):** `gerarLeilaoId()` em `sodre.js` gera o `leilao_id` só pela data (`sodre_AAAA_MM_DD`) — se a Sodré roda **dois leilões reais distintos no mesmo dia** (auction_ids diferentes), ambos caem no mesmo `leilao_id` no banco, mas `leiloes.link` só guarda um dos auction_ids. `sodre-encerrados.js` extraía o auction_id só do `link` e buscava `lots-finished` só dele — motos do outro auction_id real ficavam sem cobertura e, se por coincidência tivessem o **mesmo número de lote**, o valor de uma era gravado na outra. Caso real: BMW F750 GS do leilão `sodre_2026_07_14` (auction_id 28787, lote 32, vendida por R$40.000) recebeu o valor de um Fiat Uno de um segundo leilão real do mesmo dia (auction_id 28765, também lote 32, vendido por R$18.000) — o site mostrava R$18.000 em vez de R$40.000. Corrigido: o scraper agora extrai o auction_id de **cada moto individualmente** (via `motos.url`), agrupa por auction_id e casa lote↔moto só dentro do mesmo auction_id, nunca cross-auction. A janela incondicional (item acima) também foi ampliada de 3 para 7 dias, pra reconferir qualquer leilão recente com mais folga.

**Superbid encerrados:** NÃO usa o feed `searchType=closed` (pool de SEO randômico, não-paginável e desatualizado). Busca cada oferta por `www.superbid.net/oferta/{offerId}` (offerId vem de `motos.url`) e lê `props.pageProps.offerDetails.offers[0]` do `__NEXT_DATA__`. É idempotente (pula motos já arrematadas) e não depende da flag `encerrado` — processa janela de 7 dias para evitar corrida com o `superbid.js` ativo (que fecha leilões passados às 7h). `winnerBid` só popula dias depois → usar `hasBids` como sinal. `statusId 11` = condicional; demais encerrados com lances = vendido. **Obs:** o `superbid.js` ativo gera linhas de moto duplicadas apontando para poucos offerIds — o encerrados grava o resultado correto por moto, mas a duplicação é upstream.

**Scripts FIPE (resolvido Jul/2026):** `atualizar-fipe-mensal.js`, `popular-fipe.js` e `reprocessar-fipe.js` migrados pra API v2 autenticada (`FIPE_TOKEN`) — corrigido o parsing (modelos/anos como array direto, não objeto `{modelos:[...]}`) e os nomes de campo da resposta (`price`/`brand`/`model`/`codeFipe`/`referenceMonth`, não os nomes v1 `Valor`/`Marca`/`Modelo`/`CodigoFipe`/`MesReferencia`). Automação diária (Jul/2026): `scripts/fipe-diario.js` orquestra `popular-fipe.js` (fase 1, prioridade — motos novas sem preço) e `atualizar-fipe-mensal.js` (fase 2 — preços desatualizados) no mesmo processo Node, compartilhando a cota via `scripts/fipe-budget.js` (objeto `{count,limit}` cacheado pelo `require()`, teto ~900 req/dia somadas). Cada script isolado ainda funciona sozinho com sua própria cota de 900/dia (uso manual). Os três compartilham `scripts/fipe-nao-encontrados.json` como lista de falhas conhecidas.

**Bug de casamento de ano na FIPE (corrigido Jul/2026):** os 3 pontos que casam moto→FIPE (`popular-fipe.js`, `reprocessar-fipe.js`, e o fallback ao vivo em `index.html` quando não há cache) comparavam o ano curto de 2 dígitos da moto (ex. `"20"` vindo de `"20/20"`) contra os nomes de 4 dígitos da FIPE usando `.startsWith()`/`.includes()` — `"2000 Gasolina".startsWith("20")` também é `true`, então quando o modelo tinha anos antigos (década de 2000) cadastrados antes do ano certo (2020), o código pegava o errado. Caso real: Kawasaki Ninja ZX-6R tem dois cadastros na FIPE pro mesmo nome — "NINJA ZX-6R 600cc" (anos 1995-2013) e "NINJA ZX-6R 636cc" (2005-2006, 2013-2016, 2020+) — uma moto ano 20/20 (636cc de verdade) acabou casando com o cadastro 600cc errado e gravando o preço de uma unidade **do ano 2000** (R$18.054) em vez de 2020 (R$56.004). Corrigido pra sempre comparar o ano completo de 4 dígitos (`anoParaAnoCompleto`). 11 motos com esse lookup_key já foram corrigidas manualmente no banco; não foi feita uma varredura geral atrás de outros modelos com o mesmo tipo de cadastro duplicado (custaria bastante cota) — se um valor de FIPE parecer visivelmente errado (muito abaixo/acima do esperado pro ano), suspeitar disso e conferir `fipe_modelos` por nomes duplicados pra mesma marca/modelo.

**`reprocessar-fipe.js` — modo `encerrados` e trava de cota:** além de `ESCOPO=all`, agora aceita `ESCOPO=encerrados` (só motos de leilões com `encerrado=true` e `fipe_csv` nulo) e `PULAR_LIMPEZA=1` (pula a etapa de limpeza de registros com o bug antigo de `marca_nome`). Tem trava de cota (`REQ_LIMIT`, padrão 900 requisições) que para no meio da lista e reporta quantas rodadas ainda faltam; mantém uma lista de falhas conhecidas (compartilhada com `popular-fipe.js` via `fipe-nao-encontrados.json`) pra não gastar cota reprocessando o que já sabe que não bate.

---

## Frontend — `index.html` (funções-chave)

### Infraestrutura
| Linha | Função | Descrição |
|---|---|---|
| ~1028 | `supaFetch` | Helper REST Supabase — trata 204/body vazio (`return=minimal`) |
| ~1324 | `carregarDados` | Carrega leilões, motos, arrematados, fipeCache |
| ~1406 | `showPage` | Troca de aba + hash routing |
| ~1426 | `navigateToHash` | Lê hash da URL e navega |

### Hash routing
```
#leiloes         → aba leilões
#motos-{id}      → abre leilão direto
#fipe            → análise FIPE
#historico       → histórico
#admin           → painel admin (só para jgmpereira123@gmail.com)
```

### Segmento de moto (Jun/2026)
Classificação automática por palavras-chave no campo `modelo`:
| Segmento | Palavras-chave (exemplos) |
|---|---|
| `esportiva` | cbr, r3, r6, ninja 300/400, mt-03, rs4 |
| `scooter` | pcx, biz, lead, nmax, burgman |
| `trail` | crosser, lander, tenere, falcon, bros |
| `naked` | mt-07, mt-09, hornet, z400, duke |
| `adventure` | versys, tiger, africa twin, gs |
| `custom` | drag star, intruder, shadow, boulevard |
| `commuter` | (fallback — qualquer outra) |

Função `getSegmento(modelo, cilindrada)` — retorna o segmento. Filtro mobile via `<dialog>` com chips por segmento.

### Histórico (aba 📋 Histórico, Jul/2026)
- `renderHistoricoGeral()` — lista todas as motos arrematadas (com valor registrado em `arrematados`)
- Filtros: busca livre, condição, porte, monta, segmento, % FIPE (sobre o **valor arrematado**, não o lance inicial — diferente do filtro %FIPE da aba inicial), período (últimos 7/30 dias, pela data do leilão), marca (painel com principais + "outras", mesmo agrupamento da aba inicial). Todos atuam sobre o histórico completo *antes* da paginação — nunca só na página atual.
- Paginação: `HIST_PAGE_SIZE = 50`. Mudar qualquer filtro/busca ou limpar filtros reseta pra página 1; se um filtro reduz o resultado e a página atual fica fora do intervalo, recua automaticamente pra última página válida.

### Painel Admin (Jun/2026)
- Aba `⚙️ Admin` (`#tab-admin`) visível somente para `jgmpereira123@gmail.com`
- Constante `ADMIN_EMAIL` no topo do bloco admin
- `initAdmin()` — chamado em `carregarDados()`, mostra/esconde aba + botões Importar e +Leilão
- `convidarVip(email)` — POST `/functions/v1/admin-invite-vip` com `{ email }`
- `revogarVip(email)` — POST `/functions/v1/admin-invite-vip` com `{ action:'revoke', email }`; deleta do Auth + da tabela
- `renderAdminVips()` — lista `assinantes?plano=eq.vip`
- Botões `#btn-importar` e `#btn-novo-leilao` no header também ficam ocultos para não-admin

### FIPE — hierarquia de cache
```
localStorage → Supabase (fipe_valores) → API externa
```

### Proteção ao deletar
Motos com `arrematado` registrado **não são deletadas** ao reimportar ou deletar leilão.

### supaFetch — padrão
```js
// SEMPRE verificar body antes de JSON.parse — return=minimal retorna vazio
// 204 → retorna null; body vazio → retorna null
// Prefer padrão: 'return=minimal' (exceto quando precisa do registro inserido)
```

---

## Edge Functions

| Função | URL | Descrição |
|---|---|---|
| `kiwify-webhook` | `.../functions/v1/kiwify-webhook?token=tkv7tkdm8ns` | Recebe eventos Kiwify; cria/cancela usuários |
| `admin-invite-vip` | `.../functions/v1/admin-invite-vip` | Convida e revoga VIPs (requer JWT do admin) |

### `admin-invite-vip` — detalhes
- Valida JWT via `supabase.auth.getUser(token)` — rejeita com 403 se não for `jgmpereira123@gmail.com`
- **`action` omitido (invite):** cria usuário no Auth (`email_confirm:true`, `senha_temporaria:true`), upsert em `assinantes` com `plano:'vip'`, envia email via Resend
- **`action:'revoke'`:** busca UID via `GET /auth/v1/admin/users?filter={email}`, deleta via `DELETE /auth/v1/admin/users/{id}`, depois apaga linha em `assinantes`
- CORS completo: `OPTIONS` preflight + headers em todas as respostas
- Env vars: `SUPABASE_URL`, `SERVICE_ROLE_KEY`, `RESEND_API_KEY`

---

## Monetização

- **Webhook Kiwify:** `https://ntlwhwmtsyniinbkwjgg.supabase.co/functions/v1/kiwify-webhook?token=tkv7tkdm8ns`
- **Eventos tratados:** `order_approved` (cria usuário) → `order_refunded` / `subscription_canceled` (cancela)
- **Remetente de email (Resend):** `contato@motoleiloes.com.br` (domínio verificado)
- **Usuários VIP:** convidados pelo admin via painel `⚙️ Admin` (Edge Function `admin-invite-vip`)
- **Fluxo de primeiro login:** troca de senha obrigatória antes de acessar o app
- **Assinatura expirada:** tela dark com cadeado; token salvo no localStorage para recuperar sessão após reativar

---

## Pendências ativas

- [ ] **Google Search Console** — verificação DNS pendente para `motoleiloes.com.br`
- [ ] **Arrematados outros leilões** — implementar scraper de encerrados para VIP, Copart, Freitas, Milan (Superbid ✅ feito)

> **Resolvido:** duplicação de motos no `superbid.js` — a paginação por `start` do endpoint `seo/offers` é furada (retorna páginas sobrepostas/repetidas, ex. `start=30` == `start=90`), o que acumulava a mesma oferta várias vezes. Corrigido: busca única com `pageSize=total` + dedupe por `offer.id`. Leilões encerrados antigos (com motos duplicadas já gravadas antes do fix) não são autocorrigidos.

---

## Pontos de atenção

- Arrematados inseridos antes de Mar/2026 não têm `status_arrematado` (coluna era nula)
- Motos de marcas chinesas sem cobertura FIPE (JTZ, Haojian) sempre retornam "não encontrado"
- Arquivo `.env` precisa ser recriado se o Codespaces for resetado
- Se a Sodré mudar a URL da API novamente → scraper retorna 404 silencioso
- Edge Function `admin-invite-vip` usa `SERVICE_ROLE_KEY` (não `SUPABASE_SERVICE_ROLE_KEY`) — variável de ambiente configurada no dashboard do Supabase
- Migration `20260616120000_admin_rls_assinantes.sql` precisa ser aplicada manualmente no SQL editor do Supabase (políticas `admin_select_assinantes` e `admin_update_assinantes`)