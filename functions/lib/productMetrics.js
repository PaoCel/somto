// Product metrics: contatori funnel aggregati e ANONIMI su `productMetrics/{YYYY-MM-DD}`.
// Nessun dato per-utente: solo conteggi giornalieri (base giuridica: legittimo
// interesse / statistica aggregata, non identificabile). Admin-read via rules,
// scrittura solo server (admin SDK). I contatori sono increment O(1); i campi
// core (utenti attivi, attivazione) li calcola lo snapshot schedulato dai dati
// gia' esistenti, senza scrivere sui trigger caldi (es. titleStates).

const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

// Chiave giorno in fuso Europe/Rome (YYYY-MM-DD), coerente con gli schedulati.
function romeDateKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Incrementa un contatore del giorno corrente. Best-effort: non deve mai far
// fallire il chiamante (un trigger/callable) se la scrittura metrica inciampa.
async function bumpDailyMetric(field, n = 1) {
  try {
    await admin.firestore().collection("productMetrics").doc(romeDateKey()).set({
      [field]: admin.firestore.FieldValue.increment(n),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    logger.warn("[productMetrics] bump failed", { field, error: e?.message });
  }
}

module.exports = { romeDateKey, bumpDailyMetric };
