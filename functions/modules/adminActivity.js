/**
 * Notifiche admin sull'attivita' vera degli utenti.
 *
 * Perche' esiste: gli analytics dicono quanti, non chi ne' quando. La campanella
 * admin gia' diceva "qualcuno si e' iscritto" e quello si e' rivelato l'unico
 * segnale che si guarda davvero. Questo modulo estende lo stesso canale a tutto
 * il resto: post, commenti, voti, follow, titoli aggiunti, liste, account
 * cancellati.
 *
 * Il problema di un firehose e' il rumore. Qui si risolve con le **finestre**:
 * le azioni che arrivano a raffica (un utente che si aggiunge la libreria a
 * mano, venti titoli di fila) non fanno venti notifiche — la prima crea il
 * documento e fa la push, quelle dopo lo aggiornano dentro la stessa finestra e
 * il testo diventa "ha aggiunto 20 titoli". La push parte solo alla creazione
 * (`pushOnNotificationCreate` e' un onCreate), quindi una raffica = una push.
 *
 * Il client non va aggiornato: il tipo `admin_activity` cade nel `default` di
 * `NotificationRepository` (iOS) e di `notifications.page.js` (web), che
 * mostrano `data.message`. La frase la compone il server.
 */

const ADMIN_ACTIVITY_TYPE = "admin_activity";
const NOTIF_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Finestra di raggruppamento per tipo di attivita'. 0 = notifica singola. */
const COALESCE_MS = {
  library: 15 * 60 * 1000,
  watchlist: 15 * 60 * 1000,
  rating: 15 * 60 * 1000,
  comment: 5 * 60 * 1000,
  thread_message: 5 * 60 * 1000,
  post: 0,
  follow: 0,
  list: 0,
  account_deleted: 0,
};

/** Frase per la campanella. `count` e' quante volte l'azione e' capitata nella finestra. */
function activityMessage({ kind, name, count, detail }) {
  const who = name || "Un utente";
  const many = count > 1;
  const what = String(detail?.what || "").trim();
  const on = what ? ` — ${what}` : "";

  switch (kind) {
    case "post":
      return `${who} ha pubblicato un post${on}`;
    case "comment":
      return many
        ? `${who} ha scritto ${count} commenti`
        : `${who} ha commentato${on}`;
    case "thread_message":
      return many
        ? `${who} ha scritto ${count} messaggi in una discussione`
        : `${who} ha scritto in una discussione${on}`;
    case "rating":
      return many
        ? `${who} ha votato ${count} titoli`
        : `${who} ha votato${on}`;
    case "follow":
      return `${who} ha iniziato a seguire ${detail?.what || "qualcuno"}`;
    case "library":
      return many
        ? `${who} ha aggiunto ${count} titoli alla libreria`
        : `${who} ha aggiunto un titolo alla libreria${on}`;
    case "watchlist":
      return many
        ? `${who} ha messo ${count} titoli in watchlist`
        : `${who} ha messo un titolo in watchlist${on}`;
    case "list":
      return `${who} ha creato una lista${on}`;
    case "account_deleted":
      return `${who} ha cancellato il suo account`;
    default:
      return many ? `${who}: ${count} attivita'` : `${who}: nuova attivita'`;
  }
}

module.exports = ({ admin, logger, resolveAdminUids }) => {
  const expiresAtValue = () => admin.firestore.Timestamp.fromMillis(Date.now() + NOTIF_TTL_MS);

  function safeString(value, max = 200) {
    return String(value === null || value === undefined ? "" : value).slice(0, max);
  }

  /** Profili guidati e account di servizio non sono attivita' di persone vere. */
  function isSyntheticUid(uid) {
    return String(uid || "").startsWith("guided_");
  }

  /**
   * Nome da mostrare. Best-effort: se la lettura fallisce si ripiega su
   * "Un utente" invece di far saltare la notifica.
   */
  async function displayNameFor(db, uid) {
    try {
      const snap = await db.collection("users").doc(uid).get();
      const u = snap.data() || {};
      const name = String(u.displayName || u.username || "").trim();
      if (name) return name;
      if (u.email) return String(u.email).split("@")[0];
    } catch (err) {
      logger.debug?.("[adminActivity] displayName lookup failed", { uid, error: err?.message });
    }
    return "Un utente";
  }

  /**
   * Registra un'attivita' per gli admin.
   *
   * Best-effort in senso stretto: non lancia mai, perche' e' chiamata dentro
   * trigger e callable che non devono fallire per una notifica.
   *
   * @param {string} kind            Chiave di `COALESCE_MS`.
   * @param {string} actorUid        Chi ha fatto la cosa.
   * @param {string} [actorName]     Nome gia' noto al chiamante (evita una read).
   * @param {string} [eventId]       Id stabile dell'evento, per l'idempotenza dei retry.
   * @param {object} [detail]        `{ what, ctaUrl, ...ids }` — finisce in `data`.
   */
  async function recordAdminActivity({ kind, actorUid, actorName = "", eventId = "", detail = {} } = {}) {
    try {
      const uid = String(actorUid || "").trim();
      if (!kind || !uid || isSyntheticUid(uid)) return;

      const adminUids = resolveAdminUids().filter((a) => a && a !== uid);
      if (!adminUids.length) return;

      const db = admin.firestore();
      const windowMs = COALESCE_MS[kind] ?? 0;
      // Finestra a bucket fissi: l'id del documento si ricava dal tempo, senza
      // dover leggere prima uno stato "finestra aperta".
      const bucket = windowMs > 0 ? Math.floor(Date.now() / windowMs) * windowMs : null;
      const docId = bucket === null
        ? `adminact_${kind}_${eventId || db.collection("_").doc().id}`
        : `adminact_${kind}_${uid}_${bucket}`;

      const name = actorName || await displayNameFor(db, uid);

      await Promise.all(adminUids.map(async (adminUid) => {
        const ref = db
          .collection("users")
          .doc(adminUid)
          .collection("notifications")
          .doc(docId);

        // Transazione perche' la frase dipende dal conteggio: senza leggere il
        // valore corrente, "ha aggiunto 7 titoli" resterebbe "1".
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const previous = snap.exists ? (snap.data()?.data?.count || 0) : 0;
          const count = previous + 1;

          tx.set(ref, {
            toUid: adminUid,
            fromUid: uid,
            type: ADMIN_ACTIVITY_TYPE,
            data: {
              kind,
              count,
              fromName: name,
              message: activityMessage({ kind, name, count, detail }),
              ...(detail.what ? { preview: safeString(detail.what, 160) } : {}),
              ...(detail.ctaUrl ? { ctaUrl: safeString(detail.ctaUrl, 300) } : {}),
              ...(detail.titleId ? { titleId: safeString(detail.titleId, 120) } : {}),
              ...(detail.postId ? { postId: safeString(detail.postId, 120) } : {}),
              ...(detail.threadId ? { threadId: safeString(detail.threadId, 120) } : {}),
            },
            read: false,
            // Anche sugli aggiornamenti: un'attivita' appena arrivata deve
            // stare in cima alla campanella, non dove stava 14 minuti fa.
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: expiresAtValue(),
          }, { merge: true });
        });
      }));
    } catch (err) {
      logger.warn("[adminActivity] record failed", {
        kind,
        actorUid,
        error: err?.message || String(err),
      });
    }
  }

  return { recordAdminActivity, activityMessage, ADMIN_ACTIVITY_TYPE, COALESCE_MS };
};

module.exports.activityMessage = activityMessage;
module.exports.COALESCE_MS = COALESCE_MS;
module.exports.ADMIN_ACTIVITY_TYPE = ADMIN_ACTIVITY_TYPE;
