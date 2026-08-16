// netflixCsvPreview.js — Stima client-side best-effort del file Netflix CSV
// PRIMA di inviarlo al server. Serve solo per la preview ("N voci trovate,
// ~M riconoscibili, ~K da verificare") — il parsing autorevole (identico
// pattern-per-pattern) avviene server-side in
// functions/lib/importAdapters/netflixCsv.js, che ri-parsa sempre il file
// da zero (mai fidarsi di questo conteggio client per le scritture).

// RFC4180-ish CSV parser minimale (quote, virgole, doppio-quote escape).
function parseCsvRows(rawText) {
  const text = String(rawText || "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { pushField(); i += 1; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i += 1; pushRow(); i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/**
 * Stima grezza: quante righe totali, quante hanno un marker di stagione
 * riconoscibile (Stagione N / Miniserie / Parte N) o sono chiaramente un
 * film (0 segmenti extra), e quante restano "da verificare" (ambigue).
 * Ritorna { total, recognizable, ambiguous, malformed }.
 */
export function previewNetflixCsv(rawText) {
  const table = parseCsvRows(rawText);
  if (table.length === 0) {
    return { total: 0, recognizable: 0, ambiguous: 0, malformed: 0 };
  }
  const header = table[0].map((h) => String(h || "").trim().toLowerCase());
  const titleIdx = header.indexOf("title");
  const dateIdx = header.indexOf("date");
  if (titleIdx === -1 || dateIdx === -1) {
    return { total: 0, recognizable: 0, ambiguous: 0, malformed: table.length - 1 };
  }

  let total = 0;
  let recognizable = 0;
  let ambiguous = 0;
  let malformed = 0;

  for (let i = 1; i < table.length; i += 1) {
    const record = table[i];
    if (!record || record.length === 0) continue;
    const rawTitle = String(record[titleIdx] || "").trim();
    const rawDate = String(record[dateIdx] || "").trim();
    if (!rawTitle || !/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(rawDate)) {
      malformed += 1;
      continue;
    }
    total += 1;

    const segments = rawTitle.split(": ").map((s) => s.trim()).filter(Boolean);
    if (segments.length <= 1) {
      recognizable += 1; // 0 extra segments -> movie
      continue;
    }
    const rest = segments.slice(1);
    const hasSeasonMarker = /^Stagione\s+\d+/i.test(rest[0]) || /^(Miniserie|Limited Series)$/i.test(rest[0]) || /^Parte\s+\d+$/i.test(rest[0]);
    if (hasSeasonMarker) {
      recognizable += 1;
    } else {
      ambiguous += 1;
    }
  }

  return { total, recognizable, ambiguous, malformed };
}
