# MotoLeilão — Mapa do Projeto

Dashboard de monitoramento de leilões de moto.
**URL:** https://jgmpereira.github.io/motoleilao
**Repositório:** https://github.com/jgmpereira/motoleilao
**Supabase:** https://ntlwhwmtsyniinbkwjgg.supabase.co

---

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | HTML single-file (`index.html`) — CSS e JS embutidos |
| Backend | Supabase REST API (sem SDK) |
| Hospedagem | GitHub Pages |
| Scraping | Node.js + Playwright |
| Automação | GitHub Actions |
| Dev | GitHub Codespaces |

---

## Banco de Dados (Supabase)

### `leiloes`
| Coluna | Tipo | Descrição |
|---|---|---|
| id | text | Ex: `sodre_2026_03_30` |
| plataforma | text | Ex: `Sodré Santoro` |
| data | date | Data do leilão |
| hora | text | Horário |
| nome | text | Nome do leilão |
| link | text | URL do leilão no site |
| encerrado | bool | `false` = ativo, `true` = encerrado |

### `motos`
| Coluna | Tipo | Descrição |
|---|---|---|
| id | int | PK |
| leilao_id | text | FK → leiloes.id |
| lote | text | Número do lote |
| marca | text | |
| modelo | text | |
| ano | text | Ex: `23/24` |
| cilindrada | int | Em cc |
| condicao | text | `financiada`, `sinistro`, `sucata`, `lotamento` |
| lance_inicial | numeric | |
| url | text | URL do lote no site |
| foto | text | URL da foto |
| fipe_csv | numeric | Valor FIPE em cache no registro |

### `arrematados`
| Coluna | Tipo | Descrição |
|---|---|---|
| id | int | PK |
| moto_id | int | FK → motos.id |
| valor | numeric | Valor arrematado |
| status_arrematado | text | `vendido` ou `condicional` |
| data_registro | timestamp | |

### `fipe_modelos`
| Coluna | Tipo | Descrição |
|---|---|---|
| key | text | PK: `marca|modelo|ano` |
| marca_codigo | text | |
| modelo_codigo | text | |
| ano_codigo | text | |

### `fipe_valores`
| Coluna | Tipo | Descrição |
|---|---|---|
| key | text | PK: `marca|modelo|ano` |
| valor | numeric | Valor FIPE em R$ |
| mes_referencia | text | Mês da consulta |
| atualizado_em | timestamp | |

---

## Scrapers

### `scrapers/sodre.js` — Leilões ativos
- **O que faz:** Busca lotes ativos do Sodré Santoro, salva em `motos`
- **Paginação:** URL `&page=N` até não ter mais lotes novos
- **Campos capturados:** `url`, `foto`, `lote`, `marca`, `modelo`, `ano`, `lance_inicial`
- **Agendamento:** Todo dia às 8h BRT (`0 11 * * *` UTC)
- **Workflow:** `.github/workflows/scraper-sodre.yml`

### `scrapers/sodre-encerrados.js` — Leilões encerrados
- **O que faz:** Para cada leilão com `encerrado=false` e `data < hoje`, chama a API de lotes encerrados e salva valores em `arrematados`
- **API Sodré:** `https://prd-api.sodresantoro.com.br/api/v1/lots-finished?auctionId={id}&page={n}`
- **Filtra:** Só salva lotes com `lot_status = vendido` ou `condicional` e `bid_actual > 0`
- **Salva:** `valor` + `status_arrematado` em `arrematados`; marca leilão como `encerrado=true`
- **Agendamento:** Todo dia à meia-noite BRT (`0 3 * * *` UTC)
- **Workflow:** `.github/workflows/scraper-sodre-encerrados.yml`

### `scrapers/freitas.js` — Freitas Leiloeiro
- **O que faz:** Fetch direto de HTML (sem Playwright), parseia lotes via regex
- **Filtro:** `isMoto()` whitelist de marcas — rejeita carros
- **Agendamento:** Todo dia às 06:20 BRT (`20 9 * * *` UTC)
- **Workflow:** `.github/workflows/scraper-freitas.yml`

### `scrapers/vip.js` — VIP Leilões
- **O que faz:** GET /canal para cookie + POST /pesquisa paginado, parseia cards HTML
- **Autenticação:** Cookie `__CBCanal` obtido via redirect 302 (aceita 200 e 302)
- **Filtro:** `isMoto()` whitelist de marcas — rejeita carros que escapem do filtro da busca
- **Agendamento:** Todo dia às 06:40 BRT (`40 9 * * *` UTC)
- **Workflow:** `.github/workflows/scraper-vip.yml`

### `scrapers/superbid.js` — Superbid
- **O que faz:** API REST JSON, paginada, busca lotes abertos de motos
- **Parsing:** `parseShortDesc` com 3 estratégias: padrão barra (MARCA/MODELO), keyword "modelo", fallback strip prefixo
- **Filtro:** Remove lotes com `cilindrada` = ano (1900–2100), `isMoto()` whitelist
- **Agendamento:** Todo dia às 07:00 BRT (`0 10 * * *` UTC)
- **Workflow:** `.github/workflows/scraper-superbid.yml`

### `scrapers/copart.js` — Copart Brasil
- **O que faz:** Playwright obrigatório — WAF Imperva/Incapsula bloqueia fetch direto do Node.js
- **Estratégia:**
  1. Navega para URL filtrada (`categoria:Motos`, `#LotYear:[1980 TO 2027]`) no Playwright
  2. Intercepta o request que o Angular app faz ao endpoint `/public/vehicleFinder/search` (body é `x-www-form-urlencoded`, formato DataTables)
  3. Usa esse body como template e incrementa `start=N` para paginar (20 por página, ~2315 lotes)
  4. Réplica os requests via `page.evaluate(fetch(...))` — mesma sessão/cookies, bypassa WAF
- **Filtra:** Lotes com `stt: "Aguardando Classificação"` ou `ad` vazio (vendas futuras sem data)
- **Campos:** `ln` (lote), `mkn` (marca), `lm` (modelo), `lcy` (ano), `ad` (data leilão), `stt` (status/condição), `hb` (bid), `tims` (foto — URL completa com `?imageType=big`)
- **Agrupa:** Por data em `copart_YYYYMMDD`
- **Agendamento:** Todo dia às 06:50 BRT (`50 9 * * *` UTC)
- **Workflow:** `.github/workflows/scraper-copart.yml`

### `scripts/popular-fipe.js` — Pré-popular FIPE
- **O que faz:** Busca FIPE de todas as motos sem valor FIPE no banco
- **Agendamento:** Dia 1 de cada mês às 7h BRT
- **Workflow:** `.github/workflows/fipe-mensal.yml`

### `scripts/backup-supabase.js` — Backup diário
- **O que faz:** Exporta todas as tabelas críticas como JSON para `backups/YYYY-MM-DD/`
- **Tabelas:** `leiloes`, `motos`, `arrematados`, `fipe_valores`
- **Paginação:** Busca em lotes de 1.000 registros para tabelas grandes
- **Retenção:** Apaga automaticamente backups com mais de 30 dias
- **Agendamento:** Todo dia às 3h BRT
- **Workflow:** `.github/workflows/backup-supabase.yml`

---

## GitHub Actions Workflows

| Arquivo | Descrição | Horário (BRT) |
|---|---|---|
| `scraper-sodre.yml` | Scraper Sodré Santoro — lotes ativos | 8h diário |
| `scraper-sodre-encerrados.yml` | Scraper Sodré — encerrados | 20h diário |
| `scraper-freitas.yml` | Scraper Freitas Leiloeiro | 6h20 diário |
| `scraper-vip.yml` | Scraper VIP Leilões | 6h40 diário |
| `scraper-superbid.yml` | Scraper Superbid | 7h diário |
| `scraper-copart.yml` | Scraper Copart Brasil (Playwright) | 6h50 diário |
| `fipe-mensal.yml` | Atualização FIPE | 7h dia 1 do mês |
| `backup-supabase.yml` | Backup das tabelas do Supabase | 3h diário |

---

## Frontend — `index.html` (mapa de funções)

### Infraestrutura
| Linha | Função | Descrição |
|---|---|---|
| 642 | `supaFetch` | Helper REST para Supabase. Trata body vazio (204/return=minimal) |
| 682 | `carregarDados` | Carrega leilões, motos, arrematados, fipeCache do Supabase |
| 728 | `setLoading` / `hideLoading` | Spinner de carregamento |
| 765 | `showPage` | Troca de aba + hash routing |
| 783 | `navigateToHash` | Lê hash da URL e navega para a aba/leilão correto |

### Aba Leilões (`#leiloes`)
| Linha | Função | Descrição |
|---|---|---|
| 798 | `renderLeiloes` | Renderiza cards de leilões na home |
| 952 | `abrirLeilaoFiltrado` | Abre leilão direto com filtro ativo |
| 986 | `deletarLeilao` | Deleta leilão (protege motos com arrematado) |
| 1021 | `abrirLeilao` | Abre aba de motos de um leilão; dispara busca FIPE background |
| 4026 | `aplicarFiltrosHome` | Filtros da home (porte, condição, plataforma, etc.) |
| 4046 | `abrirModalLeilao` | Modal para criar novo leilão manualmente |
| 4049 | `salvarNovoLeilao` | Salva novo leilão no Supabase |

### Aba Motos do Leilão (`#motos-{id}`)
| Linha | Função | Descrição |
|---|---|---|
| 3274 | `setFiltroPorte` | Filtro por porte (cc) na listagem de motos |
| 3327 | `sortMotos` | Ordenação da tabela de motos |
| 3347 | `renderMotos` | Renderiza tabela de motos do leilão aberto |
| 3422 | `td-arrematado` | Célula com input de valor + badge vendido/condicional |
| 3444 | `getIndicador` | Calcula badge EXCELENTE/ÓTIMO/OK/CARO baseado em % FIPE |
| 3455 | `salvarArrematado` | Salva/atualiza/deleta valor arrematado manualmente |
| 3191 | `toggleMotoSelecionada` | Seleção múltipla de motos |
| 3238 | `excluirSelecionadas` | Exclui motos selecionadas em lote |
| 3283 | `editarCilindrada` | Edita cilindrada inline na tabela |
| 3851 | `abrirFichaMoto` | Abre modal com ficha completa da moto |

### FIPE
| Linha | Função | Descrição |
|---|---|---|
| 1044 | `fipeKey` | Gera chave `marca|modelo|ano` para cache |
| 1322 | `normFipe` | Normaliza string para comparação |
| 1333 | `scoreModelo` | Score de similaridade entre nome da moto e nome FIPE |
| 1387 | `buscarFipe` | Busca FIPE: localStorage → Supabase → API externa |
| 1544 | `saveFipeCache` | Salva cache FIPE no localStorage |
| 1549 | `buscarFipeNoBanco` | Consulta `fipe_valores` no Supabase |
| 1560 | `salvarFipeNoBanco` | Salva resultado FIPE em `fipe_modelos` + `fipe_valores` |
| 1603 | `atualizarFipeMensal` | Força atualização de todos os valores FIPE |
| 3002 | `buscarFipeBackground` | Dispara busca FIPE em background ao abrir leilão |
| 3111 | `buscarFipeLeilao` | Busca FIPE de todas as motos do leilão atual |

### Importação
| Linha | Função | Descrição |
|---|---|---|
| 1681 | `abrirModalImportar` | Abre modal de importação |
| 1783 | `extractCilindrada` | Extrai cc do nome da moto |
| 1882 | `parseFreitas` | Parser importação Freitas |
| 1974 | `parseSodre` | Parser importação Sodré (texto) |
| 2081 | `parseSuperbid` | Parser importação Superbid |
| 2235 | `parseVip` | Parser importação Vip Leilões |
| 2340 | `parseCopart` | Parser importação Copart |
| 2453 | `parseMilan` | Parser importação Milan |
| 2571 | `parseSodreEncerrados` | Parser importação Sodré encerrados (texto) |
| 2793 | `previewImport` | Preview antes de confirmar importação |
| 2906 | `executarImport` | Executa importação no Supabase |

### Aba Histórico (`#historico`)
| Linha | Função | Descrição |
|---|---|---|
| 3632 | `renderHistoricoGeral` | Renderiza tabela com todas as motos arrematadas |
| 3626 | `sortHistorico` | Ordenação da tabela de histórico |
| 3610 | `setHistFiltro` | Filtros do histórico (plataforma, condição, período) |
| 3741 | `deletarArrematado` | Remove registro de arrematado |
| 3757 | `updateStats` | Atualiza contadores do header |

### Utilitários
| Linha | Função | Descrição |
|---|---|---|
| 747 | `parseDateISO` | Parse de data ISO |
| 753 | `getBadgeLeilao` | Badge de status do leilão (ativo/encerrado/esta semana) |
| 1863 | `getPorte` | Retorna categoria de porte por cc |
| 1869 | `getPorteLabel` | Retorna label+classe CSS do porte |
| 1877 | `toTitle` | Converte string para Title Case |
| 3950 | `normalizarMarca` | Normaliza nome de marca |
| 3969 | `popularFiltroMarcas` | Popula filtro de marcas na home |
| 4132 | `showToast` | Exibe notificação temporária |

---

## Padrões e Decisões Técnicas

### supaFetch
```js
// SEMPRE verificar body antes de JSON.parse — return=minimal retorna vazio
// 204 → retorna null
// body vazio → retorna null
// Prefer padrão: 'return=minimal' (exceto quando precisa do registro inserido)
```

### FIPE — hierarquia de cache
```
localStorage → Supabase (fipe_valores) → API externa
```

### FIPE — matching de modelos
- Normalização de strings (`normFipe`)
- Mapa de sinônimos (ex: `cg160` → `cg 160`)
- Score por palavras (`scoreModelo`)
- Fallbacks progressivos se score baixo

### Hash routing
```
#leiloes         → aba leilões
#motos-{id}      → abre leilão direto
#fipe            → aba análise FIPE
#historico       → aba histórico
```

### Proteção ao deletar
- Motos com `arrematado` registrado **não são deletadas** ao reimportar ou deletar leilão

---

## Estado Atual (Abril 2026)

### ✅ Funcionando
- 5 scrapers automáticos rodando diariamente: Sodré, Freitas, VIP, Superbid, Copart
- Scraper Sodré ativo (70+ lotes por leilão)
- Scraper encerrados com URL correta (`prd-api.sodresantoro.com.br/api/v1`)
- Scraper encerrados roda às 20h BRT e já pega leilões do mesmo dia (`data=lte`)
- Scraper Freitas: fetch direto HTML, sem Playwright, `isMoto()` whitelist
- Scraper VIP: cookie via redirect 302, POST paginado, `isMoto()` whitelist
- Scraper Superbid: REST JSON paginado, 3 estratégias de parsing de descrição
- Scraper Copart: Playwright + interceptação do body DataTables do Angular app, `page.evaluate(fetch())` para paginar com sessão ativa
- Badge `vendido` / `condicional` na listagem, card e histórico
- FIPE automático ao abrir leilão
- Atualização mensal FIPE (dia 1)
- Fix `popular-fipe.js`: erro 409 no cache não impede salvar `fipe_csv`
- Hash routing em todas as abas; logo clicável volta à home e limpa filtros
- Importação manual de múltiplas plataformas
- Backup automático diário do Supabase (pasta `backups/YYYY-MM-DD/`, retém 30 dias)
- Cards do dashboard exibem dia/mês a partir do campo `data` quando `dia`/`mes` são nulos
- Filtros de porte (Alta CC / Média CC / Pequena CC) funcionam mesmo quando `cilindrada` é nulo (fallback por `monta`)
- Cards e ficha exibem label "Alta CC · 850cc" (não só a cilindrada)

### 🔧 Pontos de atenção
- Arrematados inseridos antes de Mar/2026 não têm `status_arrematado` (coluna era nula)
- Se a Sodré mudar a URL da API novamente, o scraper vai retornar 404 silencioso
- O scraper de encerrados só reprocessa leilões com `encerrado=false` — se precisar reprocessar um já encerrado, é necessário setar `encerrado=false` no Supabase manualmente
- Motos de marcas chinesas sem cobertura FIPE (JTZ, Haojian) sempre retornam "não encontrado"
- Arquivo `.env` com `SUPABASE_KEY` precisa ser recriado se o Codespaces for resetado
- Copart: se o Angular mudar o formato do body DataTables ou endpoint, o scraper precisará recapturar o template

---

## Novo Layout (em produção no `main` desde Abr/2026)

### ✅ Implementado
- Aba **Motos** — grid com foto, filtros na sidebar, badges de condição/porte/monta
- Aba **Agenda** — lista de leilões com filtros de período, plataforma e status
- Filtros: busca, período, condição, porte, % FIPE, marca (expandível), plataforma
- URL por filtro — filtros ativos refletem no hash da URL (navegável com botão voltar)
- Foto clicável → abre anúncio no site da leiloeira (nova aba)
- Card → hash `#moto-{id}`, abre ficha; Ctrl+click abre em nova aba
- Ficha da moto: foto, badges, lance/FIPE, análise histórica, arrematações anteriores
- Indicador histórico: menor visto, média, limite caro, veredicto automático
- Mobile: sidebar como overlay, botão Filtros fixo no topo, grid 2 colunas
- Cilindrada inferida pelo nome do modelo quando não cadastrada
- Monta inferida pela cilindrada quando não cadastrada
- Busca global do topo removida (substituída pelo campo na sidebar)

### 🔲 Próximos passos
- Lance atual em tempo real
- Melhorias no histórico da aba Histórico

---

## Como usar este README em nova conversa

Cole no início do chat:
```
Contexto: projeto MotoLeilão. Segue o README com mapa completo do projeto:
[cole o conteúdo do README aqui]
Última sessão: [descreva o que foi feito]
Próximo passo: [o que quer fazer agora]
```
