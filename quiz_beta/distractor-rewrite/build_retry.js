// Costruisce i batch di retry: righe rifiutate dal validatore + righe accettate
// ma con padding evidente. Ogni riga porta la proposta precedente e il motivo.
const fs = require("fs");
const C2 = __dirname;
const originals = JSON.parse(fs.readFileSync(C2 + "/originals.json"));
const byId = new Map(originals.map((o) => [o.id, o]));
const rejected = JSON.parse(fs.readFileSync(C2 + "/report/rejected.json"));
const missing = JSON.parse(fs.readFileSync(C2 + "/report/missing.json"));
const accepted = JSON.parse(fs.readFileSync(C2 + "/report/accepted.json"));

const PAD = [
  [/\b(Senior|Junior|Jr\.?|Sr\.?)$/i, "suffisso Junior/Senior inventato"],
  [/^(Il|La|Lo|I|Le|Gli|il|la|lo) (celebre|famos[oa]|grande|giovane|vecchi[oa]|leggendari[oa]|not[oa]|mitic[oa]|iconic[oa]) /, "prefisso aggettivo di riempimento"],
  [/\b(il|la) (Leggendari[oa]|Grande|Celebre|leggendari[oa]|celebre)$/, "suffisso aggettivo di riempimento"],
  [/\b(il|la) celebre\b/i, "\"il celebre\" di riempimento"],
  [/^(Miss|Mister|Mr\.?|Mrs\.?|Signor|Signora|Signorina|Sir|Lady|Lord|Dottor|Dott\.) \S+( \S+)?$/, "onorifico incollato a un nome corto"],
  [/\b(straordinari[oa]|eccezional[ei]|potentissim[oa]|incredibil[ei]|sovruman[oi])\b/i, "intensificatore di riempimento"],
];
function paddingReasons(o, answers) {
  const reasons = [];
  const correct = o.answers[o.correctAnswerIndex];
  answers.forEach((a, i) => {
    if (i === o.correctAnswerIndex) return;
    for (const [re, label] of PAD) {
      if (!re.test(a)) continue;
      if (re.source.includes("Senior|Junior") && /\b(Jr\.?|Sr\.?|Junior|Senior)$/i.test(correct)) continue;
      if (label.startsWith("onorifico") && /^(Miss|Mister|Mr\.?|Mrs\.?|Signor|Signora|Sir|Lady|Lord)\b/.test(correct)) continue;
      if (label.startsWith("intensificatore") && /\b(straordinari[oa]|eccezional[ei]|potentissim[oa]|incredibil[ei])\b/i.test(correct)) continue;
      reasons.push(`risposta ${i + 1}: ${label}`);
      break;
    }
  });
  return reasons;
}

const rows = [];
for (const r of rejected) {
  const o = byId.get(r.id);
  rows.push({ ...o, previousAttempt: r.answers, problems: r.reasons.map(humanReason) });
}
for (const id of missing) rows.push({ ...byId.get(id), previousAttempt: null, problems: ["nessuna proposta ricevuta"] });
let paddingRows = 0;
for (const a of accepted) {
  const o = byId.get(a.id);
  const problems = paddingReasons(o, a.answers);
  if (problems.length) {
    paddingRows += 1;
    rows.push({ ...o, previousAttempt: a.answers, problems });
  }
}
function humanReason(code) {
  const m = code.match(/^(\w+?)(?:_(\d))?$/);
  const n = m && m[2] !== undefined ? ` (risposta ${Number(m[2]) + 1})` : "";
  const base = (m ? m[1] : code);
  const map = {
    too_short: "distrattore troppo corto rispetto alla fascia",
    too_long: "distrattore troppo lungo rispetto alla fascia",
    tell_still_present: "la giusta resta riconoscibile dalla lunghezza (unica piu' lunga o piu' corta di 1,5x)",
    correct_changed: "la risposta giusta e' stata modificata o spostata: va copiata tal quale allo stesso indice",
    distractor_equals_correct: "un distrattore coincide con la risposta giusta",
    duplicate: "due risposte uguali",
    missing_accent: "accento mancante (perche/e/piu/gia/cosi/citta/qual e)",
    empty_answer: "risposta vuota",
    answers_count: "numero di risposte diverso da 4",
  };
  return (map[base] || base) + n;
}

const SIZE = Number(process.argv[2] || 20);
const prefix = process.argv[3] || "r1";
fs.mkdirSync(C2 + "/retry", { recursive: true });
for (const f of fs.readdirSync(C2 + "/retry")) if (f.startsWith(`batch_${prefix}_`)) fs.unlinkSync(C2 + "/retry/" + f);
let n = 0;
for (let i = 0; i < rows.length; i += SIZE) {
  n += 1;
  const tag = `${prefix}_${String(n).padStart(2, "0")}`;
  fs.writeFileSync(`${C2}/retry/batch_${tag}.json`, JSON.stringify(rows.slice(i, i + SIZE), null, 1));
}
console.log(`retry rows: ${rows.length} (rejected ${rejected.length}, missing ${missing.length}, padding ${paddingRows}) -> ${n} batch da ${SIZE} con prefisso ${prefix}`);
