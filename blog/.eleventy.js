/**
 * Eleventy — blog editoriale di Somto.
 *
 * Build SEPARATA dalla PWA: questo progetto genera solo HTML statico
 * dentro `public/blog/`. La PWA resta buildless; l'HTML prodotto qui
 * viene committato e servito da Firebase Hosting.
 *
 *   input:  blog/src/
 *   output: public/blog/   (la dir di output È già /blog, quindi i
 *                           permalink NON includono il prefisso /blog/)
 *
 * URL risultanti (pretty URL, trailing slash):
 *   https://somto.it/blog/                     → hub
 *   https://somto.it/blog/{article-slug}/      → articoli
 */
const titleSlugs = require("./src/_data/titleSlugs.json");
const makeTitleLink = require("./src/_includes/filters/titleLink.js");

module.exports = function (eleventyConfig) {
  // Data globale del sito, disponibile in tutti i template come `site.*`.
  eleventyConfig.addGlobalData("site", {
    name: "Somto",
    baseUrl: "https://somto.it",
    blogBaseUrl: "https://somto.it/blog",
  });

  // Shortcode {% title "Nome titolo" %} — linka alla pagina pubblica Somto.
  // Fallback a testo plain se il nome non è in titleSlugs.json.
  eleventyConfig.addShortcode("title", makeTitleLink(titleSlugs));

  // Filtro: data ISO (YYYY-MM-DD) per gli attributi datetime / JSON-LD.
  eleventyConfig.addFilter("isoDate", (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return d.toISOString().slice(0, 10);
  });

  // Filtro: data leggibile in italiano (es. "19 maggio 2026").
  eleventyConfig.addFilter("dateIt", (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat("it-IT", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(d);
  });

  // Collezione articoli, ordinata dal più recente al più vecchio.
  eleventyConfig.addCollection("articoli", (collectionApi) => {
    return collectionApi
      .getFilteredByTag("articolo")
      .sort((a, b) => b.date - a.date);
  });

  return {
    dir: {
      input: "src",
      output: "../public/blog",
      includes: "_includes",
      data: "_data",
    },
    // Markdown processato da Nunjucks → consente {{ }} e filtri nei .md.
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["md", "njk", "html"],
  };
};
