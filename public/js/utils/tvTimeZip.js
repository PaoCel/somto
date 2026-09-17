import { t as i18nT } from "../i18n/index.js";
// tvTimeZip.js — Mini-unzip client-side per gli export ZIP legati a TV Time:
// l'export GDPR ufficiale ("Richiedi i tuoi dati", ~20 CSV) e l'export
// dell'estensione opensource Refract ("TV Time Out", 3 JSON + 1 HTML
// riepilogo). Stesso principio per entrambi: leggere SOLO i file di dati
// che servono, MAI l'intero ZIP (che nel caso GDPR contiene PII: email,
// hash password, IP...). Questo modulo estrae le entry richieste
// interamente in-browser (nessun upload dello ZIP intero) leggendo la End
// Of Central Directory + Central Directory dello ZIP, poi decomprimendo
// solo le entry richieste (STORED o DEFLATE, gli unici metodi che questi
// export possono ragionevolmente usare) via
// `DecompressionStream('deflate-raw')` (supportato da Chrome/Edge/Safari 16.4+;
// nessuna libreria esterna).
//
// Se l'estrazione fallisce per qualunque motivo (formato ZIP inatteso,
// DecompressionStream non supportato, file non trovati), il chiamante deve
// offrire un fallback: caricare i file singolarmente.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 65535;

function findEndOfCentralDirectory(view) {
  // EOCD sits at the end of the file, optionally followed by a comment
  // (max 65535 bytes) — scan backwards from the end for the signature
  // rather than assuming no comment.
  const maxScan = Math.min(view.byteLength, EOCD_MIN_SIZE + EOCD_MAX_COMMENT);
  const start = view.byteLength - maxScan;
  for (let i = view.byteLength - EOCD_MIN_SIZE; i >= start; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return -1;
}

function readCentralDirectoryEntries(view, bytes, decoder) {
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset === -1) {
    throw new Error(i18nT("EOCD non trovato: file non è uno ZIP valido (o è corrotto)."));
  }
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("Central directory ZIP malformato.");
    }
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const fileName = decoder.decode(bytes.subarray(nameStart, nameStart + fileNameLength));

    entries.push({
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = nameStart + fileNameLength + extraFieldLength + commentLength;
  }
  return entries;
}

async function inflateRaw(compressedBytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(i18nT("DecompressionStream non supportato da questo browser."));
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(compressedBytes);
  void writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

async function extractEntryBytes(view, bytes, entry) {
  // Local file header precedes the actual (possibly compressed) data; its
  // variable-length fields (name + extra) must be skipped to find the data
  // start — the sizes/offsets from the CENTRAL directory are authoritative,
  // but the local header's OWN name/extra lengths (which can differ in
  // practice, e.g. extra field padding) determine where data begins.
  const lh = entry.localHeaderOffset;
  if (view.getUint32(lh, true) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(i18nT("Local file header mancante per \"{fileName}\".", { fileName: entry.fileName }));
  }
  const nameLength = view.getUint16(lh + 26, true);
  const extraLength = view.getUint16(lh + 28, true);
  const dataStart = lh + 30 + nameLength + extraLength;
  const compressedBytes = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressedBytes; // STORED: no compression
  }
  if (entry.compressionMethod === 8) {
    return inflateRaw(compressedBytes); // DEFLATE
  }
  throw new Error(i18nT("Metodo di compressione non supportato ({compressionMethod}) per \"{fileName}\".", { compressionMethod: entry.compressionMethod, fileName: entry.fileName }));
}

// Shared low-level extraction: reads the central directory once, then
// decompresses every entry whose basename satisfies `matchBaseName`.
// `keyFor(baseName)` picks the result object's key for a matched entry
// (identity for exact-name matching; a stable logical name for
// pattern-based matching, since the actual basename varies per export).
async function extractZipEntriesWhere(fileOrBlob, matchBaseName, keyFor) {
  const buffer = await fileOrBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const decoder = new TextDecoder("utf-8");

  const entries = readCentralDirectoryEntries(view, bytes, decoder);
  const result = {};

  for (const entry of entries) {
    // These exports can nest entries under a top-level folder — match on
    // the basename, not the full path, so "some-folder/tracking-prod-records.csv"
    // still matches "tracking-prod-records.csv".
    const baseName = entry.fileName.split("/").pop();
    if (!matchBaseName(baseName)) continue;
    // eslint-disable-next-line no-await-in-loop
    const dataBytes = await extractEntryBytes(view, bytes, entry);
    result[keyFor(baseName)] = decoder.decode(dataBytes);
  }

  return result;
}

/**
 * Extracts specific named entries from a ZIP File/Blob, entirely in-browser.
 * `targetFileNames`: array of exact file names to look for (case-sensitive,
 * matches TV Time's flat export layout — no subdirectory nesting expected).
 * Returns { [fileName]: string } for every target found (decoded as UTF-8
 * text) — entries not present in the ZIP are simply absent from the result
 * (caller checks for missing keys).
 *
 * Throws on any structural ZIP problem (caller should catch and fall back to
 * asking the user for the CSVs individually — see the module docstring).
 */
export async function extractZipEntries(fileOrBlob, targetFileNames) {
  const targets = new Set(targetFileNames);
  return extractZipEntriesWhere(fileOrBlob, (baseName) => targets.has(baseName), (baseName) => baseName);
}

/**
 * Extracts entries matching a PREFIX + SUFFIX pattern rather than an exact
 * name — needed for the Refract export, whose file names embed the export
 * date ("tvtime-movies-2026-07-06.json") so no fixed name can be listed
 * upfront. `patterns`: array of `{ key, prefix, suffix }`; the first
 * matching pattern's `key` becomes the result key (so
 * `{ key: "movies", prefix: "tvtime-movies-", suffix: ".json" }` maps
 * "tvtime-movies-2026-07-06.json" -> result.movies).
 */
export async function extractZipEntriesByPattern(fileOrBlob, patterns) {
  const findKey = (baseName) => {
    const hit = patterns.find((p) => baseName.startsWith(p.prefix) && baseName.endsWith(p.suffix));
    return hit ? hit.key : null;
  };
  return extractZipEntriesWhere(fileOrBlob, (baseName) => findKey(baseName) != null, findKey);
}
