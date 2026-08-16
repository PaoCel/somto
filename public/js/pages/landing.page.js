/**
 * landing.page.js — controller della landing pubblica (/).
 * Pagina statica e indicizzabile: il JS è solo enhancement.
 * - inoltra i deep-link app (?post=...) al feed sociale /community.html
 *   (il feed/composer si sono spostati da Home a Community, vedi community-nav)
 * - reindirizza alla feed gli utenti gia loggati
 * - header solido allo scroll + smooth scroll sulle ancore
 * - muro di locandine dell'hero (js/components/posterWall.js)
 */

import { mountPosterWall } from "../components/posterWall.js";

const FEED_URL = "/community.html";

// Muro di locandine dell'hero: stesso componente del login. Prima qui c'erano
// cinque rettangoli gradient in CSS — la landing non mostrava mai un titolo vero.
mountPosterWall(document.getElementById("lpWall"), { colClass: "lp-wall-col" });

// Il rimando ad Android non e' piu' un banner da chiudere: sta nell'hero
// ("Gratis · Android e iPhone"), tra le porte e nel footer, e porta a
// /android.html con le istruzioni complete.

// 1) Deep-link app sulla root -> inoltra alla feed mantenendo i parametri
const params = new URLSearchParams(location.search);
if (params.has("post")) {
  location.replace(FEED_URL + location.search);
}

// 2) Header: sfondo solido dopo lo scroll
const nav = document.getElementById("lpNav");
if (nav) {
  const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 12);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

// 3) Smooth scroll per i link interni
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const id = link.getAttribute("href").slice(1);
    const target = id && document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

// 4) Utenti gia autenticati: salta la landing, vai alla feed
(async () => {
  try {
    const { auth } = await import("../firebase.js");
    const { onAuthStateChanged } = await import(
      "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"
    );
    onAuthStateChanged(auth, (user) => {
      if (user) location.replace(FEED_URL);
    });
  } catch (err) {
    // Firebase non disponibile: la landing resta comunque pienamente usabile.
    console.warn("landing: auth check skipped", err);
  }
})();
