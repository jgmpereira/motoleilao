# Manual de Scrapers & Fontes de Dados — MotoLeilão

> Como cada leiloeiro é coletado, como descobrir a fonte de dados de um site novo,
> e os problemas conhecidos de cada um. Mantido junto do código (versionado no Git).

Última atualização: Jun/2026.

---

## Índice
- [Metodologia: como descobrir a fonte de dados de um site](#metodologia)
- [Sodré Santoro](#sodré-santoro)
- [Copart](#copart)
- [Freitas Leiloeiro](#freitas)
- [Superbid](#superbid)
- [VIP Leilões](#vip-leilões)
- [Problemas conhecidos / pendências](#problemas-conhecidos)

---

## Metodologia
### Como descobrir de onde um site tira os dados

Passo a passo usado pra investigar qualquer leiloeiro novo (ou re-investigar quando um quebra):

**1. Baixar o HTML cru e ver se os dados já vêm nele**
```bash
curl -s "URL_DA_PAGINA" -H "User-Agent: Mozilla/5.0" -o /tmp/p.html
wc -c /tmp/p.html                       # tamanho
grep -ciE "marca|modelo|lance|R\$" /tmp/p.html   # dados aparecem?
```
- HTML grande e com os dados → site **server-rendered** (PHP/Rails). Extrai do HTML.
- HTML pequeno e vazio → ou exige headers de navegador (ver passo 2), ou é SPA que busca via API (passo 3).

**2. Tentar de novo com headers de navegador completos**
Muitos servidores devolvem versão reduzida/bloqueada pra `curl` "pelado". Com User-Agent + Accept + Accept-Language reais, o HTML costuma vir completo:
```bash
curl -s "URL" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" \
  -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
  -H "Accept-Language: pt-BR,pt;q=0.9" \
  -o /tmp/p.html
wc -c /tmp/p.html
```
> Foi exatamente isso que destravou o Sodré: com curl pelado vinha 10 KB; com headers de navegador veio 357 KB completo.

**3. Se for SPA, achar a API que ela chama (DevTools)**
- F12 → aba **Network** → marca **Preserve log** e **Disable cache** → filtro **Fetch/XHR**.
- **Abrir o DevTools ANTES** de carregar a página (senão perde as chamadas iniciais).
- Recarregar (F5) e procurar a chamada com os dados (Size maior, Preview com JSON de marca/modelo/lance).
- Ignorar tracking: `collect`, `gtm`, `predict`, `zones`, `accountproperties`, `hit`, `sodresantorobr`, `clarity`, `liveperson/lpsnmedia`, `fonts`, `recaptcha`.
- Atalho no Console (depois de digitar `allow pasting`):
```javascript
performance.getEntriesByType("resource").map(r=>r.name)
  .filter(u=>!/google|gtm|collect|facebook|analytics|fonts|liveperson|lpsn|clarity|recaptcha|adobe|predict|zones|accountproperties|insider|\.css|\.woff|\.png|\.jpg|\.svg/i.test(u))
  .forEach(u=>console.log(u))
```

**4. Cavar os JS da página** (quando a API não aparece): baixar os arquivos JS dos controllers e procurar `fetch`/`ajax`/URLs:
```bash
curl -s "URL_DO_JS" -o /tmp/x.js
grep -oE "https?://[^\"' ]+|/api/[a-z0-9/_-]+" /tmp/x.js | sort -u
```

**5. Último recurso: Playwright** — se o site exige sessão/cookies/JS pra entregar dados (ex.: Copart com WAF Imperva), automatizar um navegador real. Ver seção Copart.

### Regras de ouro
- **RLS sempre ativo** no Supabase.
- Não quebrar os scrapers que já funcionam ao mexer num.
- Mudança em scraper de **encerrados** reprocessa dados — testar com 1 leilão antes de soltar.
- Backup diário existe (`backup-supabase.yml`) — dá pra reverter.

---

## Sodré Santoro

**Arquitetura:** site **server-rendered (PHP)**, stack jQuery + Stimulus. NÃO é SPA com API JSON pública pra página individual. Os dados da página de cada lote vêm **dentro do HTML renderizado**.

### Fontes
| Uso | Fonte | Observação |
|---|---|---|
| Lotes ativos | `leilao.sodresantoro.com.br/leilao/{auctionId}/lote/{lotId}/` | HTML completo (~357 KB) — **exige headers de navegador** (ver Metodologia passo 2), senão vem 10 KB vazio |
| Listagem geral de motos | `www.sodresantoro.com.br/veiculos/lotes?lot_category=motos&sort=auction_date_init_asc` | usada hoje pra descobrir os lotes |
| Encerrados (valores) | `prd-api.sodresantoro.com.br/api/v1/lots-finished?auctionId={id}&page={n}` | **API JSON** paginada (tem `meta.lastPage`) |

### Scrapers
- `scrapers/sodre.js` — lotes ativos. **Já usa o link individual** `/leilao/{auction_id}/lote/{lot_id}/`.
- `scrapers/sodre-encerrados.js` — valores de arremate via API `lots-finished`.

### API de encerrados — campos por lote (`lots-finished`)
```json
{
  "lot_id": 2770173,
  "auction_id": 28635,
  "lot_number": "0015",
  "lot_status_id": "6",
  "lot_status": "não vendido",      // ou "vendido" / "condicional"
  "lot_title": "TRIUMPH SCRAMBLER 400X 24/25",
  "bid_actual": "14200.00",          // valor (string!) — usar parseFloat
  "bid_initial": "0.00",
  "lot_is_scrap": false
}
```
> Confirmado: a API reflete o site corretamente. Se o banco diverge, o erro está no **mapeamento lote→moto** do scraper (ver Problemas conhecidos).

### ⏰ Janela de disponibilidade dos encerrados (CONFIRMADO Jun/2026)
**Página individual** `/leilao/{id}/lote/{id}/` de um lote encerrado:
- **1-2 dias após encerrar: AINDA fica no ar** e mostra o resultado completo no HTML — status (`vendido`), valor do lance (ex.: R$ 23.300), e a **escada de lances** (histórico: 23.300 → 22.800 → ... com comissão e total). Isso a API NÃO dá.
- **~3 dias após: removida** (confirmado: um lote de 3 dias atrás já não abria).

**API `lots-finished`:**
- Dura um pouco mais que a página, mas **também expira** — leilões antigos retornam 0 lotes (testado: vários IDs antigos vazios).
- **É a fonte de verdade pro valor:** o lote 0254 deu R$ 23.300/vendido na API, idêntico à página. Sem divergência.

**Resumo de fontes de encerrado:** API = principal (valor confiável, dura mais, dá pra paginar todos os lotes). Página individual = bônus opcional só nos primeiros 1-2 dias (traz escada de lances/comissão), mas some rápido.

### ⚠️ PAGINAÇÃO — robustez (atenção)
A API retorna **15 lotes por página**, ordenados por `lot_number`. Leilão grande tem muitas páginas (ex.: 28656 = ~390 lotes em **26 páginas**; o lote 0254 só apareceu na página 17).
O `sodre-encerrados.js` **percorre todas as páginas corretamente** (vai até `meta.lastPage`). PORÉM **não tem retry**: se uma página do meio falhar (timeout/500), ele faz `break` e para — perdendo todas as páginas seguintes (numa falha na pág. 10 de 26, perde da 10 à 26). **Melhoria recomendada:** retry por página + não abortar tudo numa falha isolada. Isso, combinado com a janela de tempo curta, é a provável causa de motos de leilão encerrado sem valor.

### 🔄 "Condicional" é status TEMPORÁRIO (CONFIRMADO ao vivo)
Status possíveis na API: `vendido`, `não vendido`, `cancelado` e (no dia do leilão) `condicional`.

Descoberta (Jun/2026): no dia do leilão, lotes cujo lance não atinge o mínimo ficam **`condicional`** (vendedor precisa aprovar) com um `bid_actual` **provisório**. Dias depois a Sodré resolve cada um e o status vira **definitivo** (`vendido`/`não vendido`/`cancelado`), muitas vezes com **valor diferente**. O `condicional` então **desaparece** da API.
- Exemplo real: Triumph Scrambler 400X foi capturada como `condicional R$41.000`; dias depois a API mostrava `não vendido R$14.200`. O banco ficou congelado na foto provisória → valor/status errados no dash.

**Consequência:** capturar só uma vez (no dia) grava dados provisórios que envelhecem errados. **Precisa reprocessar** os leilões recentes por alguns dias **enquanto a API ainda responde** (janela curta), atualizando status+valor, até não sobrar `condicional`. Depois disso o dado está estável e a API vai expirar.
**Implementação sugerida:** não marcar o leilão como "fechado pra sempre" no primeiro processamento; manter reprocessando enquanto houver `condicional` E a API ainda retornar dados; parar quando zerar condicionais ou a API esvaziar.

### Dados disponíveis na página individual (HTML, 357 KB)
Confirmado via `grep`. Campos e como extrair:

| Dado | Onde está no HTML | Exemplo |
|---|---|---|
| auction_id | `data-lot-auction-id-param="..."` | `28658` |
| lot_id | `data-lot-lot-id-param="..."` | `2773253` |
| Pátio (endereço) | atributo `patio="..."` | `Rod. Pres. Dutra, Km 223,5 ... Guarulhos` |
| Local do leilão | texto após label `Local do leilão:` | — |
| Local do lote | texto após label `Local do lote:` | — |
| Estado | texto `localizad[ao]s no estado de {UF}` | `São Paulo`, `Goiás` |
| Incremento mínimo | `data-lances-incrementminimum-param="..."` | `200` |
| Todas as fotos | `data-swiper-photos-value="..."` (CSV) + `data-swiper-path-image-value` (base) | `28656/2772400/177...A.JPG,...B.JPG,...` |
| segment_id | `data-favoritos-segment-id-value="..."` | `1643080` |

→ habilita exibir local/pátio/estado, **filtro por estado** (Frente B) e **galeria de fotos** (bônus). Não há `application/ld+json` (testado, ausente).

> ⚠️ **Alerta de desalinhamento de IDs:** numa captura, a página do lote `2773253`/auction `28658` trouxe fotos com path `28656/2772400/...` e `segment-id 1643080` — números que NÃO batem com a URL. Pode ser carrossel de "lotes relacionados" na mesma página, ou IDs internos distintos. **Cuidado ao extrair:** ancorar sempre no bloco do lote certo, não pegar o primeiro `data-*` da página. Forte candidato à raiz do bug do lote errado (Scrambler).

### TODO Sodré (mapeado, ainda não implementado)
- [ ] Extrair **local/pátio/estado/horário** do HTML individual e salvar no banco (novas colunas).
- [ ] Investigar por quanto tempo a página individual fica no ar após encerrar (fonte alternativa de valor de arremate).
- [ ] Reprocessar **condicional** depois pra ver se virou vendido/não-vendido (hoje é foto única).

---

## Copart

**Arquitetura:** SPA **Angular** protegida por **WAF Imperva/Incapsula** (`/_Incapsula_Resource?...`). A home e a página de lote retornam HTML (200, ~220 KB) mas é só a **casca** — os dados (valor, status, specs) são carregados via API pelo Angular **dentro do browser**. Por `curl` NÃO se vê o conteúdo do lote (o número do lote nem aparece no HTML). **Exige Playwright.**

### Fontes
| Uso | Como |
|---|---|
| Lista (motos) | Playwright navega `vehicleFinderSearch?searchStr=...`; intercepta o POST que o Angular faz a `/public/vehicleFinder/search` (body `x-www-form-urlencoded`, DataTables); pagina com `page.evaluate(fetch())` na mesma sessão (bypassa WAF). |
| Detalhe do lote | `www.copart.com.br/lot/{lotId}` — Angular, dados via API interna (não visível por curl). |

Scraper: `scrapers/copart.js` (só ativos). **`copart-encerrados.js` NÃO existe.**

**Campos da listagem:** `ln` (lote), `mkn` (marca), `lm` (modelo), `lcy` (ano), `ad` (data), `stt` (status/condição), `hb` (highest bid), `ob` (opening bid), `tims` (foto `?imageType=big`). Filtra "vendas futuras" (`stt: Aguardando Classificação` ou `ad` vazio).

### Encerrados — PENDENTE (precisa de POC com Playwright)
- Confirmado (Jun/2026): a página `/lot/{id}` carrega (200), WAF não bloqueia a casca, MAS o valor/status do lote **não está no HTML** (Angular monta via API no browser). O lote tem `hb` (highest bid) na **listagem**, mas não confirmamos se vira "valor de arremate final" após encerrar.
- **POC necessária:** rodar Playwright na página de um lote encerrado, deixar o Angular carregar, e (a) capturar a chamada de API de detalhe (igual o scraper ativo faz com a busca) OU (b) ler o valor/status do DOM renderizado. Verificar se o valor final de venda é público (Copart às vezes só mostra pra logados/cadastrados).
- Pendência antiga confirmada: "Copart encerrados — precisa de POC com Playwright para confirmar se o valor final é público."
- Fragilidade geral: se o Angular mudar o formato do body DataTables ou o endpoint, recapturar o template.

---

## Freitas

**Arquitetura:** server-rendered. **Fetch direto de HTML** (sem Playwright), parse via regex. (No Codespaces o domínio do Freitas é **bloqueado pela allowlist de egress** → 000; investigar via navegador. Em produção/GitHub Actions funciona normal.)

### Fontes
| Uso | URL |
|---|---|
| Lista de lotes (motos) | `www.freitasleiloeiro.com.br/Leiloes/PesquisarLotes?Categoria=1&TipoLoteId=3` |
| Detalhe do lote | `www.freitasleiloeiro.com.br/Leiloes/LoteDetalhes?leilaoId={id}&loteNumero={n}` |
| Fotos (CDN, padrão fixo) | `cdn3.freitasleiloeiro.com.br/LEILOES/{leilaoId}/FOTOS/{lote3}/LT{lote3}_01.JPG` |

Scraper: `scrapers/freitas.js` — fetch HTTP com `Referer`, regex. `isMoto()` whitelist de marcas (rejeita carros — o número do lote é geral, carros+motos juntos; motos costumam ter números mais altos). Marca leilão `encerrado=true` só pela data (`data < hoje`) — **não captura valor**.

### Campos na página da moto ATIVA (confirmado via Console, Jun/2026)
- Linha resumo: `MARCA/MODELO, ANO, PLACA: ..., COMBUSTÍVEL, COR` (ex.: `HONDA/CBR 650R, 20/20, PLACA: E__-___2, GASOLINA, VERMELHA`)
- **Lance Inicial**, **Maior lance** (ao vivo, ex.: R$ 36.500), histórico "Últimos lances do lote", Lance/Data
- **Local do leilão**, Data do leilão, Condições de venda, Catálogo
- **Mapa Google** (`initMap`) → tem localização geográfica do pátio
- Um valor de referência solto (ex.: R$ 26.000 — provável avaliação/FIPE, confirmar)

### Encerrados — REVISÃO (era "inviável", na verdade é viável NA JANELA ATIVA)
- Página de lote **encerrado dá erro / é removida** logo após o leilão (janela mais curta que o Sodré — testado: lote de leilão encerrado retornou "Ocorreu um erro").
- **MAS** a página **ativa** mostra o **"Maior lance" em tempo real**. → Pra ter valor de arremate do Freitas, capturar o **maior lance no fim/durante** o leilão (não depois). Não há API JSON nem página pós-encerramento.
- Conclusão antiga ("Freitas encerrados sem fonte pública, inviável") estava parcialmente errada: é inviável **depois**, viável **durante**. Exigiria um scraper rodando perto do horário de encerramento.

**🔲 A CONFIRMAR (hipótese do dono):** a página do lote pode ficar acessível **durante todo o dia do leilão** com o valor já fechado (não só no segundo do encerramento). Se confirmado, a janela é de horas, não de minutos → dá pra rodar o scraper de encerrados algumas horas após o leilão, no mesmo dia.
**Teste:** no dia de um leilão Freitas, anotar a hora de encerramento e tentar abrir a página do lote (`LoteDetalhes?leilaoId=&loteNumero=`) algumas horas depois, ainda no mesmo dia, e ver se mostra o maior lance final. Depois testar no dia seguinte (provavelmente já dá erro).

---

## Superbid

**Arquitetura:** SPA **Next.js** — dados em `__NEXT_DATA__` (JSON no HTML, extraído via `extractNextData()`). NÃO bloqueado pelo Codespaces. É o leiloeiro com infra mais madura (encerrados já implementado), mas com o **pior problema de dados** (duplicatas — ver abaixo).

### Fontes
| Uso | Fonte |
|---|---|
| Lista (motos abertas) | API `offer-query.superbid.net/seo/offers/?...&searchType=opened` (JSON, paginável com `pageSize`) |
| Detalhe / encerrado | `www.superbid.net/oferta/{offerId}` (Next.js, `offerDetails.offers[0]`) |
| Link do leilão | `exchange.superbid.net/leilao/{aucId}` |

Scrapers: `scrapers/superbid.js` (ativos) e `scrapers/superbid-encerrados.js` (**já existe e é maduro**).

### Encerrados — JÁ IMPLEMENTADO (bem resolvido)
`superbid-encerrados.js` lê `www.superbid.net/oferta/{offerId}` (offerId vem de `motos.url`). Mapa de status:
- `statusId 1` → aberto → pula
- `statusId 3` + `hasBids:true` → encerrado com lances → **vendido**
- `statusId 11` + `hasBids:true` → lance único no mínimo → **condicional**
- `statusId 6` + `hasBids:false` → deserto → pula

**Sinal de arremate = `hasBids`** (NÃO `winnerBid.currentWinner`, que é enganoso — eles já caíram nessa e documentaram). **Valor = `offerDetail.currentMaxBid` ?? `price`** (o maior lance). Idempotente, à prova de corrida com o scraper ativo, janela de 7 dias. → este scraper já incorpora as lições que descobrimos na unha nos outros (pegar o maior lance, desconfiar do campo "oficial").

### 🐛 BUG GRAVE — duplicatas (confirmado Jun/2026)
**1189 motos Superbid no banco, mas só 532 offerIds únicos → ~657 duplicatas (55% da base!).** Alguns offerIds repetidos 5-6× (ex.: `4625597` ×6).
**Causa:** o dedupe no `superbid.js` compara motos **dentro do mesmo `leilao_id`** (busca `motos?leilao_id=eq.{lid}` e deleta/reinsere). Mas a unicidade real de uma moto é a **URL `/oferta/{offerId}`**. Se a mesma oferta cai em `leilao_id` diferente entre execuções (ou o leilao_id muda), ela é reinserida sem ser detectada → acumula cópias a cada run.
**Correção (2 partes):**
1. **Prevenir:** dedupe por **URL/offerId** (não por leilao_id). Idealmente uma constraint UNIQUE em `motos.url` + upsert `on_conflict=url`. Ou, antes de inserir, checar se a URL já existe no banco.
2. **Limpar o passado:** SQL idempotente que remove duplicatas por offerId/url, **preservando** a linha que tem `arrematado` (ou a mais recente). Rodar com cuidado (destrutivo) — tem backup diário.

---

## VIP Leilões

**Arquitetura:** server-rendered com proteção por **cookie `__CBCanal`** (obtido via GET `/canal`, aceita HTTP 200 ou 302). NÃO bloqueado pelo Codespaces (responde 302). Stack com `data-bind-*` attributes (knockout-like).

### Fontes
| Uso | URL |
|---|---|
| Lista (motos) | `www.vipleiloes.com.br/pesquisa?classificacao=Motos` (POST paginado, precisa do cookie) |
| Detalhe / encerrado | `www.vipleiloes.com.br/evento/anuncio/{slug}` |
| Cookie | GET `www.vipleiloes.com.br/canal` → `Set-Cookie: __CBCanal=...` |

Scraper: `scrapers/vip.js` — pega cookie, POST paginado na pesquisa, regex. `isMoto()` + `isCarro()`. Já captura `local`. **`vip-encerrados.js` NÃO existe** (ficou pela metade; agora há fonte confirmada — dá pra criar).

### Encerrados — FONTE CONFIRMADA (melhor caso entre os leiloeiros)
A página `/evento/anuncio/{slug}` de um lote **encerrado CONTINUA no ar** com o resultado (testado: lote do dia 22 acessível no dia 23, HTTP 200, 188 KB). Mostra status + escada de lances. **Melhor que Sodré/Freitas** (que somem rápido). Falta confirmar por quantos dias persiste.

**Status:** `class="offer-status anuncio-Vendido"` / `data-bind-situacaoClass="Vendido"`. Variantes: `Vendido`, `Vendido por Compre Já`, `Encerrado` (não vendido).
**Datas:** JSON inline `"data_inicio"` e `"data_encerramento"` (ex.: `"23/06/2026 00:21:26 +00:00"`).
**Campos extras:** KM, Final da placa, endereço completo do pátio (ex.: "RODOVIA BR 470 KM 17...").

### ⚠️ ARMADILHA do valor de arremate (importante)
O valor "oficial" no atributo `<h2 ... data-bind-valorAtual>` mostrava **R$ 11.500**, MAS a escada de lances (vários `<span>R$ ...`) ia até **R$ 11.800**. O **valor real de arremate é o MAIOR lance da escada**, não o `data-bind-valorAtual` (que estava defasado / era penúltimo). 
**Regra pro scraper:** pegar o **maior** valor entre os lances (`<span>R$ ...` dentro do bloco de lances), NÃO confiar só no `valorAtual`. Pegar o valorAtual gravaria valor menor que o arremate real. (Armadilha análoga à do "condicional" do Sodré — confirmar sempre contra a escada.)

---

## Problemas conhecidos

### Sodré encerrados — valor/status defasado (Scrambler)
**Sintoma:** Triumph Scrambler 400X no banco como "R$41.000 condicional", mas API/site mostram "R$14.200 não vendido".
**Causa real (descoberta Jun/2026):** NÃO era mapeamento errado — é a **dinâmica do `condicional`**. O scraper capturou no dia do leilão (status provisório `condicional`, valor provisório 41 mil). Dias depois a Sodré resolveu → `não vendido` R$14.200, mas o banco ficou congelado na foto antiga. Ver seção "Condicional é status temporário" no Sodré.
**Correção:** reprocessar leilões recentes por alguns dias (dentro da janela da API) até não haver mais `condicional`, atualizando status+valor. NÃO marcar como encerrado definitivo no primeiro processamento se ainda houver condicionais.
**Obs.:** ainda vale revisar o `motoMap` (chaves com/sem zero-padding podem colidir) por garantia, mas a causa principal é a dinâmica do condicional.

### Leilão encerrado ainda aparece na home
**Sintoma:** motos de leilão já encerrado (ex.: dia 22) continuam na listagem de ativos.
**Causa provável:** leilão não foi marcado `encerrado=true`. O `sodre-encerrados.js` só processa leilões com `data < hoje` e roda 20h BRT — se rodou antes do encerramento ou a data não bateu, fica ativo. O front (`renderGridMotos`/`renderFavoritos`) filtra por `leilao.encerrado`, então depende desse flag estar correto.

### Condicional não é reprocessado
Hoje o status "condicional" é capturado uma vez e nunca atualizado. Falta lógica pra revisitar e ver o desfecho (vendido/não-vendido).

### Superbid — duplicatas massivas (PRIORITÁRIO)
1189 motos no banco, só 532 únicas → ~657 duplicatas (55%). Causa: dedupe por `leilao_id` em vez de URL/offerId. Ver seção Superbid. Correção: UNIQUE em `motos.url` + upsert por url no scraper, e SQL de limpeza preservando linhas com arrematado.

### FIPE — matching impreciso (histórico)
Marcas chinesas sem cobertura FIPE (JTZ, Haojian) sempre retornam "não encontrado". Idas e vindas no matching; ver README seção FIPE.
