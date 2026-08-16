# Somto — Playbook autorità di entità ("somto" su Google + AI)

Obiettivo: far riconoscere a Google e alle AI che **"Somto" = l'app per film e serie TV**,
non solo il nome proprio nigeriano (Somtochukwu). Il codice è fatto (schema `sameAs`,
`llms.txt`, deploy 2026-07-15). Restano le azioni off-site. Ordine = impatto.

## 1. Wikidata (impatto MAX, gratis) — ~15 min
Login su https://www.wikidata.org → "Create a new Item". Compila:
- **Label (en):** `Somto` · **Label (it):** `Somto`
- **Description (en):** `movie and TV series social app` · **(it):** `app social per film e serie TV`
- **Also known as (it):** `Somto App`

Statements (pulsante "+ add statement"):
- `instance of (P31)` = `mobile app (Q620615)`
- `instance of (P31)` = `social networking service (Q3220391)`
- `official website (P856)` = `https://somto.it`
- `operating system (P306)` = `iOS (Q48493)`
- `country of origin (P495)` = `Italy (Q38)`
- `inception (P571)` = `2026`
- `developer (P178)` o `founded by`: `Paolo Celestini`
- `App Store app ID (P7107)` = `6760966564`

Panel su Google atteso in 3–6 mesi. Nessuna soglia di notabilità come Wikipedia.

## 2. sameAs bidirezionale (5 min) — CRITICO
Google verifica l'entità solo se il link torna a somto.it. Metti nel campo "sito web":
- **Instagram @somto.watch** → bio → website: `https://somto.it`
- **TikTok @somto.watch** → modifica profilo → sito web: `https://somto.it`

Bio suggerita (entrambi):
> Il social per film e serie TV 🎬 Watchlist, voti, quiz e consigli tra amici. Gratis su web e iOS. 👇 somto.it

## 3. Search Console (5 min, dopo il deploy)
https://search.google.com/search-console (proprietà somto.it):
- Barra "Controllo URL" → incolla `https://somto.it/` → **Richiedi indicizzazione** (ripesca lo schema nuovo).
- Ripeti per `https://somto.it/llms.txt`.
- Verifica in "Pagine": nessun aumento di errori.

## 4. Menzioni / backlink (pattern density per le AI) — continuo
- **Product Hunt**: lancia Somto (categoria Entertainment). Backlink dofollow + traffico.
- **Directory app IT**: AlternativeTo (come alternativa a Letterboxd/TV Time), Slashdot, SaaSHub.
- **1–2 articoli/press**: blog di settore, newsletter cinema/serie IT.

## 5. Listicle + community (fa scattare i suggerimenti AI) — continuo
Le AI citano chi appare su più fonti. Hai già le pagine confronto:
- https://somto.it/somto-vs-letterboxd.html
- https://somto.it/somto-vs-justwatch.html
- https://somto.it/vieni-da-tv-time.html

Fatti citare in thread/articoli tipo "migliori app watchlist in italiano",
"alternativa a Letterboxd/TV Time". NB: su Reddit partecipa da umano, niente spam.

## 6. Opzionale (quando ci sono i numeri)
- Aggiungere `aggregateRating` allo schema `SoftwareApplication` quando l'App Store
  ha abbastanza recensioni reali (non inventare: va preso dai dati veri).
- Wikipedia (serve notabilità: qualche citazione di stampa indipendente prima).

---
Fatto lato codice il 2026-07-15: `public/index.html` (Organization sameAs+founder+
alternateName, SoftwareApplication publisher/downloadUrl), `public/llms.txt`, SW v124.
Commit 1ef7b27 + 8b3fc12.
