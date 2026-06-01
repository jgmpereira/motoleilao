# MotoLeilão — Instruções para Claude Code

## O que é
Dashboard de monitoramento de leilões de motos com sistema de assinaturas.

- **Site:** https://xn--motoleio-xza.com.br (motoleião.com.br) — HTTPS ativo (Enforce HTTPS no GitHub Pages)
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
- **Email via Resend:** domínio `xn--motoleio-xza.com.br` verificado; envio liberado para qualquer destinatário. Remetente padrão: `contato@xn--motoleio-xza.com.br`.

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
| `scripts/popular-fipe.js` | FIPE | API v2 parallelum + `X-Subscription-Token` | Dia 1/mês 7h |
| `scripts/backup-supabase.js` | Backup | Exporta tabelas críticas → `backups/YYYY-MM-DD/` | 3h diário |

### Atenções por scraper

**Copart:** usa `page.evaluate(fetch(...))` para paginar com a sessão/cookies do Playwright (bypassa WAF). Se o Angular mudar o endpoint ou formato DataTables, precisa recapturar o body template manualmente.

**Sodré encerrados:** só processa leilões com `encerrado=false`. Para reprocessar um já encerrado, setar `encerrado=false` manualmente no Supabase.

**Superbid encerrados:** NÃO usa o feed `searchType=closed` (pool de SEO randômico, não-paginável e desatualizado). Busca cada oferta por `www.superbid.net/oferta/{offerId}` (offerId vem de `motos.url`) e lê `props.pageProps.offerDetails.offers[0]` do `__NEXT_DATA__`. É idempotente (pula motos já arrematadas) e não depende da flag `encerrado` — processa janela de 7 dias para evitar corrida com o `superbid.js` ativo (que fecha leilões passados às 7h). `winnerBid` só popula dias depois → usar `hasBids` como sinal. `statusId 11` = condicional; demais encerrados com lances = vendido. **Obs:** o `superbid.js` ativo gera linhas de moto duplicadas apontando para poucos offerIds — o encerrados grava o resultado correto por moto, mas a duplicação é upstream.

**popular-fipe.js (bug pendente):** a API v2 do parallelum retorna modelos como **array direto**, não objeto. O script está tentando acessar como objeto — precisa corrigir para usar o array direto. O mesmo pode valer para anos.

---

## Frontend — `index.html` (funções-chave)

### Infraestrutura
| Linha | Função | Descrição |
|---|---|---|
| 642 | `supaFetch` | Helper REST Supabase — trata 204/body vazio (`return=minimal`) |
| 682 | `carregarDados` | Carrega leilões, motos, arrematados, fipeCache |
| 765 | `showPage` | Troca de aba + hash routing |
| 783 | `navigateToHash` | Lê hash da URL e navega |

### Hash routing
```
#leiloes         → aba leilões
#motos-{id}      → abre leilão direto
#fipe            → análise FIPE
#historico       → histórico
```

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

## Monetização

- **Webhook Kiwify:** `https://ntlwhwmtsyniinbkwjgg.supabase.co/functions/v1/kiwify-webhook?token=tkv7tkdm8ns`
- **Eventos tratados:** `order_approved` (cria usuário) → `order_refunded` / `subscription_canceled` (cancela)
- **Remetente de email (Resend):** `contato@xn--motoleio-xza.com.br` (domínio verificado)
- **Usuários VIP:** lista de emails com bypass de verificação de assinatura
- **Fluxo de primeiro login:** troca de senha obrigatória antes de acessar o app
- **Assinatura expirada:** tela dark com cadeado; token salvo no localStorage para recuperar sessão após reativar

---

## Pendências ativas

- [ ] **`scripts/popular-fipe.js`** — corrigir parsing: resposta de modelos é array direto, não objeto (idem para anos)
- [ ] **Google Search Console** — verificação DNS pendente para `xn--motoleio-xza.com.br`
- [ ] **Arrematados outros leilões** — implementar scraper de encerrados para VIP, Copart, Freitas, Milan (Superbid ✅ feito)

> **Resolvido:** duplicação de motos no `superbid.js` — a paginação por `start` do endpoint `seo/offers` é furada (retorna páginas sobrepostas/repetidas, ex. `start=30` == `start=90`), o que acumulava a mesma oferta várias vezes. Corrigido: busca única com `pageSize=total` + dedupe por `offer.id`. Leilões encerrados antigos (com motos duplicadas já gravadas antes do fix) não são autocorrigidos.

---

## Pontos de atenção

- Arrematados inseridos antes de Mar/2026 não têm `status_arrematado` (coluna era nula)
- Motos de marcas chinesas sem cobertura FIPE (JTZ, Haojian) sempre retornam "não encontrado"
- Arquivo `.env` precisa ser recriado se o Codespaces for resetado
- Se a Sodré mudar a URL da API novamente → scraper retorna 404 silencioso