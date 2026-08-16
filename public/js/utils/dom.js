export function qs(sel, root = document){
  return root.querySelector(sel);
}

export function qsa(sel, root = document){
  return [...root.querySelectorAll(sel)];
}

export function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// Rimpicciolisce il font del nome profilo finché sta su UNA riga dentro il suo
// contenitore (niente "va a capo" né sfarfallio da reflow). Misura reale +
// riduzione di 1px alla volta fino a fit o floor (~62% del default) — così si
// adatta alla larghezza effettiva invece di indovinare per lunghezza. Il loop è
// sincrono (nessun paint intermedio → nessun flicker). Sotto il floor resta
// l'ellissi CSS come rete di sicurezza. Usato da account.page.js e user.page.js
// su `.profile-hero-name`. Il 2° arg (name) è ignorato: si misura il testo reale.
export function fitProfileName(el){
  if (!el || !el.parentElement) return;
  el.style.whiteSpace = "nowrap";
  el.style.fontSize = "";                                   // reset al default CSS
  const text = (el.textContent || "").trim();
  if (!text) return;
  const cs = getComputedStyle(el);
  const avail = el.parentElement.clientWidth - 14;          // colonna meta (stabile: flex:1), meno margine (stacco dai bottoni)
  if (avail <= 0) return;
  // Misura il testo con canvas (deterministico, niente reflow né circolarità di
  // layout) e riduci il font finché ci sta. Sotto il floor resta l'ellissi CSS.
  const canvas = fitProfileName._canvas || (fitProfileName._canvas = document.createElement("canvas"));
  const ctx = canvas.getContext("2d");
  const measure = (px) => { ctx.font = `${cs.fontWeight} ${px}px ${cs.fontFamily}`; return ctx.measureText(text).width; };
  const start = parseFloat(cs.fontSize) || 21;
  let size = start;
  while (size > 11 && measure(size) > avail) size -= 0.5;
  el.style.fontSize = (size >= start ? "" : size + "px");
}
