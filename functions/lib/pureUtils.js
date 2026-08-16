"use strict";

// Helper minimi condivisi, senza alcun I/O (niente admin, niente logger, niente
// fetch). Estratti da functions/index.js perche' il motore di raccomandazione
// (lib/recommendationEngine.js) e l'harness di benchmark offline devono usare
// ESATTAMENTE le stesse implementazioni di produzione: se qui e in index.js le
// definizioni divergono, il benchmark misura un motore che non e' quello live.
//
// `clamp` NON coerce a numero (Math.max/Math.min su NaN propaga NaN): e' il
// comportamento storico di index.js e va tenuto identico. Da non confondere con
// il `clamp` di lib/tasteProfileAggregate.js, che invece fa `Number(n) || 0`.

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return (ts.seconds * 1000) + Math.floor((ts.nanoseconds || 0) / 1e6);
  return 0;
}

// Variante piu' permissiva di toMillis: accetta anche Date, _seconds/_nanoseconds
// (forma serializzata dei Timestamp) e stringhe ISO. Usata dal decay del taste
// profile, dove i valori arrivano sia da Firestore sia da JSON esportato.
function tsToMs(value) {
  if (!value) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === "function") {
    try { return Number(value.toMillis()) || 0; } catch (_) { return 0; }
  }
  if (typeof value._seconds === "number") {
    return (value._seconds * 1000) + Math.floor((value._nanoseconds || 0) / 1e6);
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeNormalized(value) {
  return Array.from(
    new Set(
      normalizeText(value)
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => t.length >= 2)
    )
  );
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toId(value) {
  return String(value || "").trim();
}

function safeString(str, maxLen = 500) {
  return String(str || "").slice(0, maxLen || 500);
}

// Fisher-Yates. `random` iniettabile: in produzione resta Math.random, il
// benchmark passa un PRNG con seed per avere run riproducibili.
function shuffleRows(array, random = Math.random) {
  const out = Array.from(array || []);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = {
  toMillis,
  tsToMs,
  normalizeText,
  tokenizeNormalized,
  safeArray,
  clamp,
  toId,
  safeString,
  shuffleRows,
};
