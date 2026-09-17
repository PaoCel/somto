"use strict";

// Minimal RFC4180-compliant CSV parser (no external dependency — the format
// surface we need is small: quoted fields, embedded commas, `""` escape,
// CRLF/LF line endings). Returns an array of rows, each row an array of
// string fields. Does NOT interpret headers — callers slice row 0 off.
function parseCsv(rawText) {
  const text = String(rawText ?? "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Lookahead for \r\n; either way this ends the row.
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush trailing field/row if the text didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // Drop fully-empty trailing rows (trailing newline artifacts).
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

module.exports = { parseCsv };
