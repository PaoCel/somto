# Somto Blog

Il blog e' un progetto Eleventy separato dalla PWA. Gli articoli sorgente stanno in `src/articoli/` e la build genera HTML statico in `../public/blog/`.

## Workflow attuale

```sh
cd blog
npm run build
```

L'output in `public/blog/` va committato insieme ai sorgenti Markdown.

## Automazione consigliata

Gli articoli possono essere semi-automatizzati, ma non dovrebbero andare online senza revisione umana. I temi su film, serie TV e cataloghi streaming cambiano spesso: un articolo generato senza controllo puo' citare date, disponibilita' o titoli non corretti.

Workflow consigliato:

1. Una job ricorrente propone 2-4 topic freschi usando fonti aggiornate e dati interni Somto.
2. La job crea una bozza Markdown in `src/articoli/` con front matter completo: `slug`, `title`, `description`, `date`, `kicker`, `readingTime`, `lede`, `ctaTitle`, `ctaText`, `relatedSlugs`.
3. La bozza resta in branch o PR, non in produzione.
4. Revisione editoriale: verifica fonti, tono, feature citate e link interni.
5. Build Eleventy e deploy del sito.

Per una prima versione pratica, basta una automazione settimanale che prepari bozze e un breve changelog editoriale. La pubblicazione automatica completa ha senso solo dopo avere controlli su fonti, duplicati, factualita' e coerenza con le feature reali dell'app.
