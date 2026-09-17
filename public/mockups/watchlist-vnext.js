/* watchlist-vnext.js — render dei mockup Watchlist. Statico, nessuna chiamata a Firebase.
   Poster e loghi piattaforma: TMDB (dati reali, mercato IT). */

const IMG = (p, s = "w342") => `https://image.tmdb.org/t/p/${s}${p}`;

const PROV = {
  nf:  { n: "Netflix",      l: "/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg" },
  pv:  { n: "Prime Video",  l: "/pvske1MyAoymrs5bguRfVqYiM9a.jpg" },
  dp:  { n: "Disney+",      l: "/97yvRBw1GzX7fXprcF80er19ot.jpg" },
  sky: { n: "Sky Go",       l: "/vDdk3LyjWkYlfCtkrhkjFKFK1Hg.jpg" },
  now: { n: "NOW",          l: "/g0E9h3JAeIwmdvxlT73jiEuxdNj.jpg" },
  pp:  { n: "Paramount+",   l: "/h5DcR0J2EESLitnhR8xLG1QymTE.jpg" },
};
const plogo = (k, s = "w92") => IMG(PROV[k].l, s);

/* dataset: film e serie reali, durate e voti TMDB */
const T = {
  perfect:   { n: "Perfect Days", p: "/vRLicecIah55HKQkmXpkpD5KuPq.jpg", b: "/hjWxngV6tidwDkfJDEgMjHD2KEz.jpg", t: "movie", y: 2023, r: 124, g: "Dramma", v: 7.8, prov: "now" },
  past:      { n: "Past Lives", p: "/uZWU5pmJG3AO9pgpXQUSggf1JX.jpg", b: "/7HR38hMBl23lf38MAN63y4pKsHz.jpg", t: "movie", y: 2023, r: 106, g: "Dramma", v: 7.7, prov: "pv" },
  anatomia:  { n: "Anatomia di una caduta", p: "/kSbp0b7QEB8xcyW0YK6RcdWLhG0.jpg", t: "movie", y: 2023, r: 151, g: "Thriller", v: 7.5, prov: "pv" },
  zona:      { n: "La zona d'interesse", p: "/qIcSYnugkFfyO8M6S8ge5sZsMb6.jpg", t: "movie", y: 2023, r: 105, g: "Dramma", v: 7.0, prov: "now" },
  domani:    { n: "C'è ancora domani", p: "/hc9SHN0vB6iyr6MBYI6bKrpDHvJ.jpg", t: "movie", y: 2023, r: 118, g: "Dramma", v: 8.1, prov: "nf" },
  dune2:     { n: "Dune - Parte due", p: "/nhdQxDCI64rMgypYZpsF7UvbdJA.jpg", t: "movie", y: 2024, r: 166, g: "Fantascienza", v: 8.1, prov: "nf" },
  oppen:     { n: "Oppenheimer", p: "/fRtaxfyynWMJI6DhejyA6JOzVTB.jpg", t: "movie", y: 2023, r: 189, g: "Storico", v: 8.0, prov: "sky" },
  povere:    { n: "Povere creature!", p: "/8rwQrD5PBr290AaePDC9kd61dnD.jpg", t: "movie", y: 2023, r: 141, g: "Fantasy", v: 7.6, prov: "dp" },
  airone:    { n: "Il ragazzo e l'airone", p: "/p9tHvoXaIUapKWygs1DKKkvVjCY.jpg", t: "movie", y: 2023, r: 124, g: "Animazione", v: 7.4, prov: "nf" },
  killers:   { n: "Killers of the Flower Moon", p: "/l7CXClIApqEWrUaaSNFBMvFtKQ2.jpg", t: "movie", y: 2023, r: 206, g: "Crime", v: 7.4, prov: "pv" },
  parasite:  { n: "Parasite", p: "/mMM8kcfspicib7AmPTvf97Rarwn.jpg", t: "movie", y: 2019, r: 132, g: "Thriller", v: 8.5, prov: "pv" },
  eeaao:     { n: "Everything Everywhere All at Once", p: "/4YF4QREw9vUjJSvzypd5uvpDxcT.jpg", t: "movie", y: 2022, r: 140, g: "Avventura", v: 7.7, prov: "pp" },
  gladiator: { n: "Il gladiatore II", p: "/tVBCG6qHQQaq2doZsOvpGNcwMuP.jpg", t: "movie", y: 2024, r: 148, g: "Azione", v: 6.6, prov: "pp" },
  chall:     { n: "Challengers", p: "/81tKWsMg90EmFRDTlsTIE5ouKWy.jpg", t: "movie", y: 2024, r: 132, g: "Dramma", v: 6.9, prov: "pv" },
  chimera:   { n: "La chimera", p: "/hpL03rfX1UXqyGxtXljl8A5HIKr.jpg", t: "movie", y: 2023, r: 131, g: "Dramma", v: 7.3, prov: "now" },
  iocap:     { n: "Io capitano", p: "/iP6WtSOhlClcIxRUgbTpeFO2rMe.jpg", t: "movie", y: 2023, r: 121, g: "Dramma", v: 7.8, prov: "nf" },
  br2049:    { n: "Blade Runner 2049", p: "/4XJQG11Ytl8mKfgbl2jkoY5ZuFX.jpg", t: "movie", y: 2017, r: 164, g: "Fantascienza", v: 7.6, prov: "nf" },
  whiplash:  { n: "Whiplash", p: "/jQwkXN38AGrK2s3LJqxZow1Ic7z.jpg", t: "movie", y: 2014, r: 107, g: "Dramma", v: 8.4, prov: "pv" },

  bear:      { n: "The Bear", p: "/eKfVzzEazSIjJMrw9ADa2x8ksLz.jpg", b: "/aJtG4txtmiRHwAAqENQHZvBs6kY.jpg", t: "tv", y: 2022, s: 5, g: "Dramma", v: 8.1, prov: "dp" },
  sciss:     { n: "Scissione", p: "/jnwqpZpmwvEo0CFLjDwfnnAf4ow.jpg", b: "/ixgFmf1X59PUZam2qbAfskx2gQr.jpg", t: "tv", y: 2022, s: 3, g: "Sci-fi", v: 8.4, prov: "sky" },
  shogun:    { n: "Shōgun", p: "/beNlavRswn5FS9PeDs9dFTYtjxp.jpg", b: "/bwSmgmd90hCWwqOKQYTEraeOZhJ.jpg", t: "tv", y: 2024, s: 1, g: "Storico", v: 8.4, prov: "dp" },
  fallout:   { n: "Fallout", p: "/bnayCOZ739OHS2DHPy7ZQDGC8iv.jpg", t: "tv", y: 2024, s: 2, g: "Sci-fi", v: 8.1, prov: "pv" },
  ripley:    { n: "Ripley", p: "/rpSo8z9alultGVTqQ3dkLEyU8xx.jpg", t: "tv", y: 2024, s: 1, g: "Thriller", v: 7.9, prov: "nf" },
  reindeer:  { n: "Baby Reindeer", p: "/tN9OcbkAOPwHSr1sgMornZtQZBx.jpg", t: "tv", y: 2024, s: 1, g: "Dramma", v: 7.6, prov: "nf" },
  tlou:      { n: "The Last of Us", p: "/u0xTEHOd8pw6SLGRL5fZyDpoaew.jpg", t: "tv", y: 2023, s: 2, g: "Dramma", v: 8.4, prov: "sky" },
  succ:      { n: "Succession", p: "/z0XiwdrCQ9yVIr4O0pxzaAYRxdW.jpg", t: "tv", y: 2018, s: 4, g: "Dramma", v: 8.3, prov: "now" },
  dark:      { n: "Dark", p: "/dXmLXRtjCUfkocm9aWVyqGjFAF4.jpg", t: "tv", y: 2017, s: 3, g: "Mistero", v: 8.4, prov: "nf" },
  arcane:    { n: "Arcane", p: "/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg", t: "tv", y: 2021, s: 2, g: "Animazione", v: 8.8, prov: "nf" },
  marefuori: { n: "Mare Fuori", p: "/i318aG3wUpGLDPxn3cmKM9UvpOy.jpg", t: "tv", y: 2020, s: 5, g: "Dramma", v: 7.5, prov: "nf" },
  adol:      { n: "Adolescence", p: "/20i4nShZZg1g1VFHSB8xpaYM4r7.jpg", t: "tv", y: 2025, s: 1, g: "Dramma", v: 7.8, prov: "nf" },
  penguin:   { n: "The Penguin", p: "/hNIyAf0jw4ZzcPC5kvtNsTt8uK4.jpg", t: "tv", y: 2024, s: 1, g: "Crime", v: 8.4, prov: "sky" },
  corpi:     { n: "Il problema dei 3 corpi", p: "/4j7TQD4pKVooSASeD9B0GMl3ysM.jpg", t: "tv", y: 2024, s: 1, g: "Sci-fi", v: 7.5, prov: "nf" },
};

/* ------------------------------- icone ------------------------------- */
const I = {
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.9 3 3 6.4 3 10.6c0 2.3 1.2 4.3 3.1 5.7L5.5 20l3.7-1.8c.9.2 1.8.4 2.8.4 5.1 0 9-3.4 9-7.6S17.1 3 12 3Z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22Zm7-6.2v-5A7 7 0 0 0 13 4V3a1 1 0 1 0-2 0v1a7 7 0 0 0-6 6.8v5L3 18v1h18v-1Z"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  dice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 1.5 2.4 5.4 5.6.7-4.2 4 1.1 5.6L12 14.5 7.1 17.2l1.1-5.6L4 7.6l5.6-.7L12 1.5Z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/></svg>`,
  resume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg>`,
  users: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 14c2.2 0 4-1.8 4-4s-1.8-4-4-4-4 1.8-4 4 1.8 4 4 4Zm-8 0c2.2 0 4-1.8 4-4S10.2 6 8 6 4 7.8 4 10s1.8 4 4 4Zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4Zm8 0c-.3 0-.7 0-1.1.1 1.3 1 2.1 2.3 2.1 3.9v2h7v-2c0-2.7-5.3-4-8-4Z"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 2.6h11A1.9 1.9 0 0 1 19.4 4.5v16.1c0 .8-.9 1.3-1.6.9L12 18.1l-5.8 3.4c-.7.4-1.6-.1-1.6-.9V4.5A1.9 1.9 0 0 1 6.5 2.6Z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
  tv: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2.5" y="6" width="19" height="12.5" rx="2.5"/><path d="m8 3 4 3 4-3"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></svg>`,
  chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.3 3.3 3.6 9.7c-.4.3-.6.8-.6 1.3V20a1 1 0 0 0 1 1h4.4a1 1 0 0 0 1-1v-4.4a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 1V20a1 1 0 0 0 1 1H20a1 1 0 0 0 1-1v-9c0-.5-.2-1-.6-1.3l-7.7-6.4a1 1 0 0 0-1.4 0Z"/></svg>`,
  cards: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.2" y="6.6" width="12" height="14.2" rx="3"/><rect x="8.8" y="3.2" width="12" height="14.2" rx="3" stroke-opacity=".55"/></svg>`,
  quiz: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.4"/><circle cx="12" cy="17" r=".9" fill="currentColor"/></svg>`,
  user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1.4-3.6 4-5.4 7.5-5.4s6.1 1.8 7.5 5.4"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

/* ------------------------------- helper ------------------------------- */
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`);
const meta = (k) => {
  const x = T[k];
  return x.t === "movie" ? `${x.y} · ${dur(x.r)} · ${x.g}` : `${x.y} · ${x.s} stagioni · ${x.g}`;
};

function statusBar() {
  return `<div class="ph-status"><span>21:42</span><span class="sig">
    <svg viewBox="0 0 20 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="4.5" y="5.5" width="3" height="6.5" rx="1"/><rect x="9" y="3" width="3" height="9" rx="1"/><rect x="13.5" y="0" width="3" height="12" rx="1" opacity=".4"/></svg>
    <svg viewBox="0 0 24 12" fill="currentColor"><rect x="0" y="1" width="19" height="10" rx="3" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/><rect x="1.6" y="2.6" width="13" height="6.8" rx="1.6"/><rect x="20.4" y="4" width="1.8" height="4" rx=".9" opacity=".5"/></svg>
  </span></div>`;
}

function appbar() {
  return `<div class="ph-appbar">
    <div class="grp"><span class="ic">${I.menu}</span><span class="ic">${I.search}</span></div>
    <span class="wm">Somto</span>
    <div class="grp"><span class="ic">${I.chat}</span><span class="ic" style="position:relative">${I.bell}<i class="ph-dot"></i></span></div>
  </div>`;
}

function tabbar() {
  const tab = (ic, l, on) => `<div class="ph-tab${on ? " on" : ""}">${ic}<span>${l}</span></div>`;
  return `<div class="ph-tabbar">
    ${tab(I.home, "Home")}${tab(I.cards, "Match")}${tab(I.bookmark, "Watchlist", true)}${tab(I.quiz, "Quiz")}${tab(I.user, "Profilo")}
  </div>`;
}

function phone(inner, extra = "") {
  return `${statusBar()}${appbar()}<div class="ph-screen"><div class="ph-scroll">${inner}</div></div>${extra}${tabbar()}`;
}

/* ------------------------------ componenti ------------------------------ */

function head(sub = "128 da vedere · 61 film, 67 serie") {
  return `<div class="wl-head">
    <div><h1>Watchlist</h1><div class="sub">${sub}</div></div>
    <div class="acts">
      <div class="wl-iconbtn">${I.search}</div>
      <div class="wl-iconbtn primary">${I.plus}</div>
    </div>
  </div>`;
}

function tonight(k = "perfect") {
  const x = T[k];
  return `<div class="wl-tonight">
    <img src="${IMG(x.b, "w780")}" alt="">
    <div class="scrim"></div>
    <span class="wl-kicker">${I.spark} Stasera</span>
    <div class="body">
      <h2>${x.n}</h2>
      <div class="meta">${meta(k)} · ★ ${x.v.toFixed(1)}</div>
      <span class="wl-reason">${I.clock} 2h e ce la fai · su ${PROV[x.prov].n} · salvato 4 mesi fa</span>
      <div class="btns">
        <div class="wl-btn wl-btn--pri">${I.play} Guardo questo</div>
        <div class="wl-btn wl-btn--ghost">${I.dice} Un altro</div>
      </div>
    </div>
  </div>`;
}

function contRow() {
  const items = [
    { k: "bear", ep: "S3 E4", pct: 62 },
    { k: "sciss", ep: "S2 E2", pct: 21 },
    { k: "shogun", ep: "S1 E6", pct: 55 },
    { k: "fallout", ep: "S1 E7", pct: 84 },
  ];
  return `<div class="wl-sec">
    <div class="wl-sec-head"><h3>${I.resume} Continua</h3><span class="wl-count">4 in corso</span></div>
    <div class="wl-hrow">${items.map(({ k, ep, pct }) => `
      <div class="wl-cont">
        <div class="pw">
          <img src="${IMG(T[k].p, "w185")}" alt="">
          <span class="ep">${ep}</span>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </div>
        <div class="nm">${T[k].n}</div>
        <div class="sb">${pct}% · ${PROV[T[k].prov].n}</div>
      </div>`).join("")}
    </div>
  </div>`;
}

function chips(active = 0, sticky = true) {
  let list = [
    { l: "Tutto", n: 128 },
    { l: "Film", n: 61 },
    { l: "Serie", n: 67 },
    { l: "Sotto 2h", n: 34, ic: I.clock },
    { l: "Netflix", n: 41, img: plogo("nf") },
    { l: "Prime", n: 22, img: plogo("pv") },
    { l: "Con amici", n: 9, ic: I.users },
  ];
  // Il chip attivo viene portato in testa: è quello che fa la riga reale quando
  // selezioni un filtro (la riga scrolla per tenerlo visibile).
  if (active > 0) list = [list[active], ...list.filter((_, i) => i !== active)];
  const onIdx = active > 0 ? 0 : active;
  return `<div class="wl-chips${sticky ? " wl-chips--sticky" : ""}">
    <div class="wl-chip wl-chip--icon">${I.sliders}</div>
    ${list.map((c, i) => `<div class="wl-chip${i === onIdx ? " on" : ""}">${c.img ? `<img src="${c.img}" alt="">` : c.ic ? c.ic : ""}${c.l}<span class="n">${c.n}</span></div>`).join("")}
  </div>`;
}

function cell(k, opt = {}) {
  const x = T[k];
  return `<div class="wl-cell${opt.sel ? " sel" : ""}">
    <img src="${IMG(x.p, "w342")}" alt="${x.n}">
    <span class="prov"><img src="${plogo(x.prov)}" alt=""></span>
    ${opt.friend ? `<span class="friend">${opt.friend}</span>` : ""}
    ${opt.dur ? `<span class="dur">${x.t === "movie" ? dur(x.r) : x.s + " stag."}</span>` : ""}
    ${opt.pct ? `<div class="bar"><i style="width:${opt.pct}%"></i></div>` : ""}
  </div>`;
}

function grid(keys, opts = {}) {
  return `<div class="wl-grid${opts.two ? " wl-grid--2" : ""}">${keys.map((k) => cell(k, opts.per?.[k] || { dur: opts.dur })).join("")}</div>`;
}

function listsShelf() {
  const L = [
    { n: "Marvel cronologico", c: [T.dune2, T.gladiator, T.eeaao, T.arcane], sb: "23 titoli", pct: 52 },
    { n: "Serate con Anna", c: [T.past, T.chall, T.perfect, T.chimera], sb: "8 titoli", av: ["A", "P"], pct: 25 },
    { n: "Oscar 2026", c: [T.oppen, T.povere, T.zona, T.killers], sb: "15 titoli", pct: 80 },
  ];
  return `<div class="wl-sec">
    <div class="wl-sec-head"><h3>${I.folder} Le tue liste</h3><span class="link">Gestisci</span></div>
    <div class="wl-hrow">
      ${L.map((l) => `<div class="wl-listcard">
        <div class="wl-mosaic">${l.c.map((t) => `<img src="${IMG(t.p, "w185")}" alt="">`).join("")}</div>
        <div class="nm">${l.n}</div>
        <div class="sb">${l.av ? `<span class="wl-avatars">${l.av.map((a, i) => `<span style="background:${i ? "#E91E63" : "#9C27B0"}">${a}</span>`).join("")}</span>` : ""}${l.sb}</div>
        <div class="prog"><i style="width:${l.pct}%"></i></div>
      </div>`).join("")}
      <div class="wl-listcard"><div class="wl-new">${I.plus}</div><div class="nm">Nuova lista</div><div class="sb">Maratona, serata, tema</div></div>
    </div>
  </div>`;
}

/* -------------------------------- frame A -------------------------------- */

const A = phone(`
  ${head()}
  ${tonight("perfect")}
  ${contRow()}
  ${chips(0)}
  ${grid(["dune2", "shogun", "past", "oppen", "reindeer", "anatomia"], { dur: true })}
`);

const A2 = phone(`
  ${chips(3)}
  ${grid(["past", "zona", "reindeer", "whiplash", "adol", "chimera"], { dur: true, per: {
    reindeer: { dur: true, friend: "L" },
    adol: { dur: true, pct: 30 },
  } })}
  <div style="height:18px"></div>
  ${listsShelf()}
`);

/* -------------------------------- frame B -------------------------------- */

const B = phone(`
  ${head("128 titoli · aggiornata oggi")}
  ${chips(0)}
  ${grid(["dune2", "shogun", "perfect", "oppen", "bear", "past", "povere", "sciss", "anatomia", "tlou", "reindeer", "arcane", "zona", "fallout", "killers"], { dur: true })}
`, `<div class="wl-fab">${I.dice} Scegli tu</div>`);

const B2 = phone(`
  ${head("128 titoli · aggiornata oggi")}
  ${chips(0)}
  ${grid(["dune2", "shogun", "perfect", "oppen", "bear", "past", "povere", "sciss", "anatomia"], { dur: true, per: { perfect: { dur: true, sel: true } } })}
`, `<div class="wl-dim"></div>
  <div class="wl-sheet">
    <div class="grab"></div>
    <div class="wl-preview">
      <img src="${IMG(T.perfect.p, "w185")}" alt="">
      <div><h4>Perfect Days</h4><div class="sub">${meta("perfect")} · su NOW</div></div>
    </div>
    <div class="wl-act">${I.check} Segna come visto</div>
    <div class="wl-act">${I.play} Guarda ora su NOW</div>
    <div class="wl-act">${I.folder} Sposta in una lista</div>
    <div class="wl-act">${I.users} Proponi a un amico</div>
    <div class="wl-act danger">${I.trash} Rimuovi dalla watchlist</div>
  </div>`);

/* -------------------------------- frame C -------------------------------- */

function shelf(tag, title, note, keys, per = {}) {
  return `<div class="wl-sec">
    <div class="wl-sec-head"><h3>${title}</h3><span class="link">Vedi tutti</span></div>
    ${note ? `<div class="wl-shelf-note">${note}</div>` : ""}
    <div class="wl-hrow">${keys.map((k) => `
      <div class="wl-tile">
        <div class="pw">
          <img src="${IMG(T[k].p, "w185")}" alt="">
          <span class="prov" style="position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:6px;overflow:hidden"><img src="${plogo(T[k].prov)}" alt="" style="width:100%;height:100%"></span>
          ${per[k]?.ep ? `<span class="ep" style="position:absolute;left:5px;bottom:7px;font-size:10px;font-weight:700;background:rgba(10,10,10,.78);padding:2px 6px;border-radius:999px">${per[k].ep}</span>` : ""}
          ${per[k]?.pct ? `<div class="bar" style="position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(0,0,0,.5)"><i style="display:block;height:100%;width:${per[k].pct}%;background:var(--brand-primary)"></i></div>` : ""}
        </div>
        <div class="nm">${T[k].n}</div>
        <div class="sb">${per[k]?.sb || (T[k].t === "movie" ? dur(T[k].r) : T[k].s + " stagioni")}</div>
      </div>`).join("")}
    </div>
  </div>`;
}

const C = phone(`
  ${head()}
  ${shelf("", `${I.resume} Sto guardando`, "4 serie aperte", ["bear", "sciss", "shogun"], {
    bear: { ep: "S3 E4", pct: 62, sb: "62% · Disney+" },
    sciss: { ep: "S2 E2", pct: 21, sb: "21% · Sky Go" },
    shogun: { ep: "S1 E6", pct: 55, sb: "55% · Disney+" },
  })}
  ${shelf("", `${I.clock} Stasera ci sta`, "Sotto le 2 ore, su una piattaforma che hai", ["perfect", "past", "zona"], {
    perfect: { sb: "2h 04m · NOW" }, past: { sb: "1h 46m · Prime" }, zona: { sb: "1h 45m · NOW" },
  })}
  ${shelf("", `${I.users} Dai tuoi amici`, "Salvati anche da chi segui", ["ripley", "anatomia", "chimera"], {
    ripley: { sb: "Luca, Anna" }, anatomia: { sb: "Marco" }, chimera: { sb: "Anna" },
  })}
  ${shelf("", `${I.bookmark} Prima o poi`, "121 titoli in coda", ["dune2", "oppen", "killers"])}
`);

const C2 = phone(`
  <div class="wl-head" style="margin-bottom:10px">
    <div><h1 style="font-size:24px">Stasera ci sta</h1><div class="sub">34 titoli sotto le 2 ore</div></div>
    <div class="acts"><div class="wl-iconbtn">${I.sliders}</div></div>
  </div>
  ${chips(3)}
  ${grid(["perfect", "past", "zona", "whiplash", "domani", "iocap", "reindeer", "adol", "ripley", "chimera", "chall", "arcane"], { dur: true })}
`);

/* ------------------------------ frame sheet ------------------------------ */

const SHEET = phone(`
  ${head()}
  ${chips(0)}
  ${grid(["dune2", "shogun", "perfect", "oppen", "bear", "past", "povere", "sciss", "anatomia"], { dur: true })}
`, `<div class="wl-dim"></div>
  <div class="wl-sheet">
    <div class="grab"></div>
    <h4>Filtra la watchlist</h4>
    <div class="sub">34 titoli su 128</div>
    <div class="wl-sheet-grp"><label>Tipo</label><div class="row">
      <span class="wl-chip">Tutto<span class="n">128</span></span>
      <span class="wl-chip">Film<span class="n">61</span></span>
      <span class="wl-chip">Serie<span class="n">67</span></span>
    </div></div>
    <div class="wl-sheet-grp"><label>Durata</label><div class="row">
      <span class="wl-chip on">${I.clock} Sotto 2h<span class="n">34</span></span>
      <span class="wl-chip">Sotto 1h<span class="n">6</span></span>
      <span class="wl-chip">Serie brevi<span class="n">18</span></span>
    </div></div>
    <div class="wl-sheet-grp"><label>Dove si guarda</label><div class="row">
      <span class="wl-chip"><img src="${plogo("nf")}" alt="">Netflix<span class="n">41</span></span>
      <span class="wl-chip"><img src="${plogo("pv")}" alt="">Prime<span class="n">22</span></span>
      <span class="wl-chip"><img src="${plogo("dp")}" alt="">Disney+<span class="n">14</span></span>
      <span class="wl-chip"><img src="${plogo("sky")}" alt="">Sky<span class="n">9</span></span>
    </div></div>
    <div class="wl-sheet-grp"><label>Ordina</label><div class="row">
      <span class="wl-chip on">Salvati di recente</span>
      <span class="wl-chip">A–Z</span>
      <span class="wl-chip">Più corti</span>
      <span class="wl-chip">Voto community</span>
    </div></div>
    <div class="wl-btn wl-btn--pri">Mostra 34 titoli</div>
  </div>`);

/* ------------------------------ frame empty ------------------------------ */

const EMPTY = phone(`
  ${head("Ancora vuota")}
  <div class="wl-empty">
    <div class="art">
      <img src="${IMG(T.perfect.p, "w185")}" style="transform:translate(-50%,-50%) rotate(-11deg) translateX(-58px)" alt="">
      <img src="${IMG(T.shogun.p, "w185")}" style="transform:translate(-50%,-50%) rotate(9deg) translateX(58px)" alt="">
      <img src="${IMG(T.dune2.p, "w185")}" style="transform:translate(-50%,-50%) scale(1.12);z-index:2" alt="">
    </div>
    <h3>Qui finisce quello che vuoi vedere</h3>
    <p>Salva un film o una serie e Somto ti dirà dove si guarda, quanto dura e quando è il momento giusto per farlo.</p>
    <div class="wl-btn wl-btn--pri">${I.search} Cerca un titolo</div>
    <div style="height:10px"></div>
    <div class="wl-btn wl-btn--ghost" style="flex:1;width:100%">${I.cards} Fatti dare 5 idee</div>
  </div>
`);

/* -------------------------------- mount -------------------------------- */
const M = { frameA: A, frameA2: A2, frameB: B, frameB2: B2, frameC: C, frameC2: C2, frameSheet: SHEET, frameEmpty: EMPTY };
Object.entries(M).forEach(([id, html]) => {
  const node = document.getElementById(id);
  if (node) node.innerHTML = html;
});
