# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MotoLeilao** is a motorcycle auction monitor (in Portuguese). It is a **single-file application** — the entire app lives in `index.html`, which contains embedded CSS (in `<style>`), HTML structure, and JavaScript (in `<script>`).

There is no build step, no package manager, no bundler, and no test suite. To run the app, simply open `index.html` in a browser or serve it with any static file server (e.g. `python3 -m http.server`).

## Architecture

### Backend: Supabase
All persistence is handled via direct REST calls to Supabase (no SDK). The connection config is at the top of the `<script>` block:

```js
const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = '...'; // anon key
```

The `supaFetch(path, opts)` helper wraps all Supabase REST calls.

**Tables:**
- `leiloes` — auction records (id, plataforma, nome, data, hora, local, link, encerrado)
- `motos` — motorcycle lots (linked to `leiloes` via `leilao_id`; fields: lote, marca, modelo, ano, cor, condicao, cilindrada, monta, lance_inicial, financeira, etc.)
- `arrematados` — winning bids (linked to `motos` via `moto_id`; valor, data_registro)

### External API: FIPE
FIPE pricing data is fetched from the public API at `parallelum.com.br`. Results are cached in `localStorage` under the key `fipeCache` to avoid rate limits. FIPE is only fetched when the user opens a specific auction (not on initial load).

### State
Global variables in the script block:
- `LEILOES`, `MOTOS` — arrays loaded from Supabase on startup
- `ARREMATADOS` — object keyed by `moto_id`
- `currentLeilao` — the currently viewed auction
- `fipeCache` — persisted to localStorage

### UI / Navigation
- Single-page app with tab-based navigation (`showPage(name)`)
- Pages: `leiloes` (auction grid), `motos` (lot table for a specific auction), `analise` (FIPE analysis charts), `historico` (won bids history)
- All rendering is done by DOM manipulation functions (`renderLeiloes()`, `renderMotos()`, `renderAnalise()`, `renderHistoricoGeral()`)
- Modals for: adding auctions, adding motos, importing CSV, viewing motorcycle details (ficha), bid history

### CSV Import
Users can import motorcycle lots from CSV files. The import parses CSVs in-browser and upserts into Supabase via `executarImport()`.

### Key Utility Functions
- `supaFetch(path, opts)` — all Supabase API calls
- `getBadgeLeilao(l)` — classifies auction urgency (hoje/urgente/proxima/encerrado)
- `parseDateISO(str)` — parses `YYYY-MM-DD` strings to Date
- `getPorte(cilindrada)` — classifies engine size (pequena/media/alta)
- `normalizarMarca(marca)` — normalizes brand names for filtering
- `showToast(msg, icon)` — displays transient notifications
