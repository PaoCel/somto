/**
 * Shortcode Eleventy: trasforma il nome di un titolo in un link verso la
 * relativa pagina pubblica Somto (`/film/{slug}/` o `/serie/{slug}/`), se
 * presente in `src/_data/titleSlugs.json`. Altrimenti restituisce il testo
 * plain, così l'articolo non si rompe se un nome non è ancora mappato.
 *
 * Uso negli articoli .md/.njk:
 *   {% title "Stranger Things" %}
 *   {% title "Stranger Things", "serie" %}   (type esplicito)
 *
 * Il `type` esplicito (secondo arg) sovrascrive il tipo letto dalla mappa.
 * Quando il nome non è in mappa, il fallback è il testo plain — niente link.
 */
module.exports = function (slugs) {
  const map = slugs && typeof slugs === "object" ? slugs : {};
  return function (titleName, type) {
    const display = String(titleName == null ? "" : titleName);
    if (!display) return "";
    const key = display.toLowerCase().trim();
    const entry = map[key];
    if (!entry || typeof entry !== "object" || !entry.slug) {
      return display;
    }
    const resolvedType = String(type || entry.type || "serie").toLowerCase() === "film"
      ? "film"
      : "serie";
    const slug = String(entry.slug);
    const escapedDisplay = display
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<a href="/${resolvedType}/${slug}/" class="blog-title-link">${escapedDisplay}</a>`;
  };
};
