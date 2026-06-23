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

**Arquitetura:** SPA Angular protegida por **WAF Imperva/Incapsula** — bloqueia `fetch` direto do Node. **Exige Playwright.**

**Como funciona** (`scrapers/copart.js`):
1. Playwright navega pra URL filtrada (`categoria:Motos`, ano).
2. Intercepta o request que o Angular faz pra `/public/vehicleFinder/search` (body `x-www-form-urlencoded`, formato DataTables).
3. Usa o body como template e incrementa `start=N` pra paginar (20/página).
4. Replica os requests via `page.evaluate(fetch(...))` — mesma sessão/cookies → bypassa o WAF.

**Campos:** `ln` (lote), `mkn` (marca), `lm` (modelo), `lcy` (ano), `ad` (data), `stt` (status/condição), `hb` (bid), `tims` (foto, `?imageType=big`).
**Fragilidade:** se o Angular mudar o formato do body DataTables ou o endpoint, precisa recapturar o template.

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

**Arquitetura:** **API REST JSON** paginada (host em `exchange.superbid.net`).
- Ativos (`scrapers/superbid.js`): query paginada, `parseShortDesc` com 3 estratégias (barra MARCA/MODELO, keyword "modelo", fallback). Remove lote cujo "cilindrada" é ano (1900–2100). `isMoto()` whitelist.
- Encerrados (`scrapers/superbid-encerrados.js`): por oferta `www.superbid.net/oferta/{offerId}`.

---

## VIP Leilões

**Arquitetura:** server-rendered com proteção por cookie.
- Lista: `www.vipleiloes.com.br/pesquisa?classificacao=Motos` (POST paginado).
- Detalhe: `www.vipleiloes.com.br/evento/anuncio/{slug}`.
- **Cookie `__CBCanal`** obtido via redirect 302 (GET /canal). `isMoto()` whitelist.

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

### FIPE — matching impreciso (histórico)
Marcas chinesas sem cobertura FIPE (JTZ, Haojian) sempre retornam "não encontrado". Idas e vindas no matching; ver README seção FIPE.
