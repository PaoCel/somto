# Pubblicare Somto su Google Play (PWA → TWA via PWABuilder)

Percorso per portare la PWA esistente (`somto.it`) su Google Play come **Trusted Web Activity** (TWA), senza riscrivere l'app: PWABuilder impacchetta un wrapper Android che mostra il sito live a schermo intero, senza barra URL, se il dominio è "verificato" tramite Digital Asset Links.

Stato verificato il 2026-07-12 (audit PWABuilder). Aggiorna questo file se cambi manifest, service worker o package Android.

## 0. Cosa è già pronto (nessuna azione richiesta)

Verificato in `public/manifest.json`, `public/service-worker.js`, `firebase.json`:

- **Manifest core**: `name`/`short_name` "Somto", `id: "/"`, `start_url: "/home.html"`, `scope: "/"`, `display: "standalone"`, `background_color`/`theme_color` `#0A0A0A`, `shortcuts` (Impostazioni, Supporto), icone 192 e 512 con `purpose: "maskable any"`.
- **Service worker** `v108` (`public/service-worker.js`): cache offline con fallback `/offline.html`, `skipWaiting()` sia automatico che via messaggio `SKIP_WAITING`, integrazione FCM push (`firebase-messaging-compat.js`).
- **HTTPS + HSTS**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` su tutte le route (`firebase.json`).
- **Pagine legali/account**: `public/delete-account.html`, `public/privacy.html`, `public/terms.html` live — servono per la Data Safety form e per il requisito Play di un link "elimina account" raggiungibile.
- **Navigazione multipagina**: essendo un sito multipagina classico (non SPA con history.pushState fittizio), il tasto **Indietro** di Android funziona nativamente dentro la TWA senza codice aggiuntivo.

## 1. Preparazione manifest (prima di generare il pacchetto)

Aggiungere a `public/manifest.json`, senza toccare i campi già validi elencati sopra (vincolo: NON cambiare `start_url`, `scope`, `display`, `id` — vedi guardrail §6):

```json
{
  "lang": "it",
  "categories": ["entertainment", "social"],
  "screenshots": [
    {
      "src": "/screenshots/home-mobile.png",
      "sizes": "1080x1920",
      "type": "image/png",
      "form_factor": "narrow"
    },
    {
      "src": "/screenshots/home-desktop.png",
      "sizes": "1920x1080",
      "type": "image/png",
      "form_factor": "wide"
    }
  ]
}
```

- `lang`/`categories` sono consigliati, non bloccanti: migliorano la scheda "Informazioni sull'app" generata da PWABuilder e l'indicizzazione.
- `screenshots` servono a PWABuilder per precompilare gli screenshot dello store listing — se mancano andranno comunque caricati a mano in Play Console (§4), ma averli nel manifest velocizza il pacchettizzatore. Servili da `public/screenshots/` (nuova cartella), path relativi come gli altri asset statici.
- **Icona maskable**: verificata già presente con `purpose: "maskable any"` a 192 e 512px. Margine di sicurezza stimato ~25-28% dal centro, sopra il minimo richiesto (~19.4%) — verificare comunque su [maskable.app](https://maskable.app/editor) caricando `public/icons/icon-512.png` prima di procedere, per essere sicuri che logo/testo non finiscano tagliati sui launcher che applicano la maschera circolare/squircle.
- **Icona hi-res Play Console (512×512)**: l'attuale `public/icons/icon-512.png` è **senza canale alpha** (RGB puro, non RGBA — verificato con `file`). Play Console per l'icona "hi-res" dello store listing generalmente vuole PNG a 32-bit; verificare al momento dell'upload se viene rifiutata per il canale alpha mancante — in caso, esportarne una copia con alpha (anche solo opaco) per quel singolo upload, senza toccare l'icona del manifest/PWA.

Deploy di queste modifiche: `firebase deploy --only hosting` come di consueto (nessun cambio a rules/functions).

## 2. Generare il pacchetto Android su PWABuilder

**Azione manuale** (nessun account speciale richiesto per questo step, solo browser):

1. Vai su [pwabuilder.com](https://www.pwabuilder.com/).
2. Inserisci l'URL `https://somto.it` e avvia la scansione.
3. PWABuilder analizza manifest + service worker e mostra uno "score": con i punti del §0/§1 a posto dovrebbe risultare verde/quasi completo. Eventuali warning residui (manifest fields opzionali) non bloccano il pacchetto.
4. Sezione **Android** → "Generate Package" (o "Store Package").
5. Configurazione pacchetto:
   - **Package ID**: identificatore reverse-domain univoco e definitivo (es. `it.somto.app` o `com.paolocelestini.somto` — scegline uno e non cambiarlo più: è l'identità dell'app su Play, cambiarlo dopo la pubblicazione significa una nuova scheda da zero). Verificare che non sia già in uso.
   - **App name** / **Launcher name**: "Somto".
   - **Signing key**: lasciare che sia **PWABuilder a generare la keystore** (opzione consigliata per chi non ha già una key esistente) — la scarica insieme al pacchetto. In alternativa, se in futuro si userà Play App Signing con upload key propria, fornire qui la key esistente.
6. Scarica lo zip generato: contiene l'**AAB** (Android App Bundle, il file da caricare su Play Console) + la **keystore** (da conservare in un posto sicuro, NON nel repo — serve per ogni futura firma/aggiornamento se non si usa Play App Signing) + un file **`assetlinks.json`** già compilato con il package name e il fingerprint SHA-256 del certificato di firma.

**Conservazione keystore**: la keystore scaricata è un segreto a tutti gli effetti (perdila = non potrai più aggiornare l'app con lo stesso package se non usi Play App Signing). Salvarla fuori dal repo Git, in un password manager o storage cifrato, mai in `docs/` o commit.

## 3. Digital Asset Links (`assetlinks.json`) — il pezzo bloccante di oggi

Questo è l'unico elemento **mancante e bloccante** rilevato dall'audit: oggi `https://somto.it/.well-known/assetlinks.json` risponde `[]` (il placeholder di default di Google Hosting, non un file nostro — verificato via `curl` e assenza del file in `public/.well-known/`).

1. Prendi il contenuto di `assetlinks.json` generato da PWABuilder al passo 2 (contiene `package_name` + `sha256_cert_fingerprints`, formato tipo):
   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": {
       "namespace": "android_app",
       "package_name": "it.somto.app",
       "sha256_cert_fingerprints": ["AA:BB:CC:...:ZZ"]
     }
   }]
   ```
2. Salvalo come `public/.well-known/assetlinks.json` nel repo (la cartella `.well-known/` esiste già, contiene `apple-app-site-association` per iOS — stesso pattern).
3. Verifica che `firebase.json` serva quel path senza interferenze: gli altri file in `.well-known/` sono serviti come statici di default; se in futuro si aggiunge un rewrite catch-all, assicurarsi che `/.well-known/**` resti escluso (oggi non c'è rewrite catch-all, rimosso per SEO — vedi `CLAUDE.md` root).
4. Deploy: `firebase deploy --only hosting`.
5. **Verifica live** (obbligatoria prima di procedere allo submission):
   ```bash
   curl -s https://somto.it/.well-known/assetlinks.json
   ```
   Deve restituire il JSON con il package name e il fingerprint corretti (non più `[]`). Puoi anche validare con lo strumento ufficiale Google: `https://developers.google.com/digital-asset-links/tools/generator` (statement list check).
6. Se in futuro si passa a **Play App Signing** (Google ri-firma l'AAB con una chiave propria), il fingerprint SHA-256 finale sarà quello della chiave di Play, non quello generato da PWABuilder — recuperabile da Play Console → Configurazione app → Integrità dell'app → "Certificato di firma dell'app", e va aggiornato in `assetlinks.json` + ri-deployato.

## 4. Google Play Console — pubblicazione

**Tutti i passi seguenti sono AZIONE MANUALE del proprietario dell'account Google Play** (richiedono l'identità/pagamento del proprietario, non automatizzabili da qui):

1. **Creazione account developer**: [play.google.com/console](https://play.google.com/console/) → registrazione una tantum, **fee $25 una tantum** — richiede l'account Google del proprietario.
2. **Crea nuova app**: nome "Somto", categoria predefinita coerente con `categories` del manifest, dichiarazioni su contenuti/pubblico.
3. **Upload AAB**: sezione Produzione (o prima una track interna/chiusa per test) → carica il file `.aab` scaricato da PWABuilder al §2.
4. **Firma app**: se è il primo upload, Play propone **Play App Signing** (consigliato: Google gestisce la chiave di firma finale, riducendo il rischio di smarrimento chiave). Se si accetta, ricordarsi di aggiornare `assetlinks.json` col fingerprint definitivo di Play (vedi §3.6) **prima** di promuovere la release in produzione, altrimenti la TWA mostra la barra URL invece di aprirsi a schermo intero.
5. **Store listing** — asset richiesti (da preparare, non ancora presenti in questo repo salvo l'icona app):
   - Icona app **512×512** (32-bit PNG, verificare alpha — vedi §1).
   - Feature graphic **1024×500** (banner store, da creare ex novo — non esiste ancora nel repo).
   - Screenshot: almeno 2 per telefono (consigliato 1080×1920 o simile), opzionali tablet. Se popolati in `screenshots` del manifest (§1) possono essere riusati.
   - Descrizione breve/lunga, in italiano (coerente con i contenuti marketing esistenti in `public/*-film-serie*.html`).
6. **Data Safety form**: dichiarare i dati raccolti/condivisi (account email, dati di utilizzo/analytics, contenuti generati dall'utente — voti/recensioni/watchlist). Coerente con `public/privacy.html` già live: usarla come riferimento per compilare la form senza contraddirla.
7. **Pagina eliminazione account**: Play richiede un URL pubblico per l'eliminazione account per app con creazione account — usare `https://somto.it/delete-account.html` (già live, verificato).
8. **Content rating questionnaire**, **target audience**, **ads declaration** (Somto non ha ads, dichiarare di conseguenza).
9. **Submission per la review**: dopo il completamento di tutte le sezioni obbligatorie, invio alla review Google (tempi variabili, giorni).

## 4bis. Test prima della produzione (consigliato, non bloccante)

**Azione manuale**, ma può essere fatta prima di spendere sforzo sullo store listing completo:

1. In Play Console, prima di puntare alla track **Produzione**, crea una track **Interna** (Internal testing) — richiede solo un elenco email di tester (anche solo la propria), pubblicazione quasi istantanea, nessuna review Google.
2. Installa l'AAB tramite il link di opt-in della track interna su un device Android reale.
3. Verifica a occhio: l'app si apre **senza barra degli indirizzi** (se compare, il problema è quasi sempre l'`assetlinks.json` non ancora propagato o il fingerprint sbagliato — vedi §7); il tasto Indietro naviga dentro il sito e chiude l'app solo dalla home; le notifiche push (se già concesse) arrivano; il deep link `https://somto.it/...` da un'altra app (es. condivisione titolo/lista) apre l'app invece del browser.
4. Solo dopo questa verifica manuale procedere con lo store listing completo (§4) e la promozione a produzione.

Nota: la propagazione delle Digital Asset Links dopo il deploy di `assetlinks.json` non è istantanea lato Android (cache del verificatore di sistema) — se il test immediatamente dopo il deploy mostra ancora la barra URL, attendere qualche minuto/ricontrollare prima di concludere che il fingerprint è sbagliato.

## 5. Aggiornamenti futuri

- La TWA è un **wrapper**: mostra sempre `https://somto.it` live. Un deploy hosting (`firebase deploy --only hosting`) aggiorna immediatamente cosa vedono gli utenti Android **senza bisogno di una nuova build/submission Play**, esattamente come per un utente browser/PWA installata.
- Il **pacchetto Android** (AAB) va rigenerato e ricaricato su Play Console **solo se cambia**:
  - il **manifest** in modo strutturale (nome, icone, `start_url`, `scope`, `display`) — PWABuilder rilegge il manifest a build time, non a runtime;
  - il **package name** (mai, dopo la prima pubblicazione — è l'identità della scheda Play);
  - la **firma/keystore** (es. passaggio a Play App Signing, rotazione chiave);
  - versioning interno del pacchetto Android stesso (`versionCode`/`versionName` nell'AAB) per requisiti Play — questo va comunque incrementato a ogni nuovo upload di AAB, anche se il contenuto web non cambia (raro: capita solo se serve toccare configurazione nativa del wrapper).
- **Non serve** rigenerare il pacchetto per contenuti, fix di bug web, nuove pagine, cambi di stile: tutto ciò vive nel sito e si aggiorna col normale deploy hosting.

## 6. Guardrail — cosa NON rompere

Questi elementi, se cambiati senza coordinare un aggiornamento del pacchetto Android, **rompono l'esperienza TWA** (tipicamente: ricompare la barra degli indirizzi, l'app sembra "un browser" invece che un'app nativa — perdita di fiducia dell'utente e possibile rigetto di Google Play per non conformità ai Digital Asset Links):

- **`start_url`** (`public/manifest.json`) — deve continuare a puntare a una route valida e stabile (`/home.html`). Cambiarlo senza rigenerare il pacchetto lascia la TWA ad aprire un URL diverso da quello verificato/atteso.
- **`scope`** — resta `/`. Se si restringesse lo scope, qualunque link che esce da quel path (es. cross-navigazione tra sezioni) farebbe comparire la barra URL perché "fuori scope" per la TWA.
- **`display: "standalone"`** — se si rimuove o si cambia a `browser`, l'intera esperienza torna a un tab browser classico con barra URL, vanificando l'installazione da Play.
- **`public/.well-known/assetlinks.json`** — se questo file sparisce, ha un JSON malformato, o il fingerprint non corrisponde più alla chiave che firma l'AAB pubblicato (es. dopo un passaggio a Play App Signing non riflesso qui), la verifica dei Digital Asset Links fallisce silenziosamente e Android mostra la barra URL nella TWA. **Verificare con il curl del §3.5 dopo ogni deploy hosting**, non solo alla prima pubblicazione.
- **Rimozione/rinomina di `public/delete-account.html`** — è referenziata sia dalla Data Safety/Account deletion policy di Play sia (potenzialmente) da link salvati nello store listing: se si sposta, aggiornare anche la Play Console.
- **Downgrade del service worker** (rimozione di `skipWaiting`/offline fallback) — non blocca la TWA di per sé, ma degrada l'esperienza offline che Play valuta in fase di review per le PWA-wrapped app.

## 7. Troubleshooting comune

- **L'app si apre ma mostra la barra degli indirizzi (sembra un browser)**: quasi sempre `assetlinks.json` non verificato. Controlla, in ordine: (1) `curl https://somto.it/.well-known/assetlinks.json` restituisce il JSON atteso, non `[]`; (2) il `package_name` nel file combacia esattamente col Package ID scelto in PWABuilder/Play Console; (3) il `sha256_cert_fingerprints` combacia con la chiave che ha **effettivamente firmato** l'AAB installato — se il pacchetto è passato per Play App Signing, il fingerprint è quello di Play, non quello locale generato da PWABuilder (vedi §3.6); (4) attendi qualche minuto per la cache di verifica lato Android (§4bis).
- **PWABuilder segnala service worker/manifest non trovato durante la scansione**: verifica che `https://somto.it/manifest.json` e `https://somto.it/service-worker.js` rispondano 200 con `Content-Type` corretto (non serviti dietro auth, non 404) — non dovrebbe succedere dato che sono asset pubblici serviti da Firebase Hosting, ma è il primo sospetto se lo score PWABuilder è basso.
- **Icona rifiutata in Play Console** (formato/alpha): esporta una copia dedicata per l'upload store (non serve toccare `public/icons/icon-512.png`, che resta quello usato dal manifest/PWA — sono due usi indipendenti).
- **Serve aggiornare l'AAB dopo un cambio di package/firma**: non esiste un percorso di "rinomina" — un nuovo package name su Play è a tutti gli effetti una app nuova, con nuova scheda, nuove recensioni da zero, nuovo URL store. Evitare di arrivarci: il Package ID va deciso una volta sola con cura al §2.
- **Deep link esterni** (es. link a `/lista/{slug}` o `/quiz/invite/{token}` condivisi da altre app) non aprono la TWA ma il browser: verificare che il dominio/scope in `assetlinks.json` e nel manifest coprano quei path (`scope: "/"` li copre già tutti — se in futuro si restringe lo scope, ricontrollare qui).

## Riferimenti

- `public/manifest.json`, `public/service-worker.js` — sorgenti PWA.
- `public/.well-known/` — Digital Asset Links (Android) + Apple App Site Association (iOS), stesso pattern per le due piattaforme.
- `public/delete-account.html`, `public/privacy.html`, `public/terms.html` — pagine richieste da Play Console.
- [pwabuilder.com](https://www.pwabuilder.com/) — generatore pacchetto Android/TWA.
- [Digital Asset Links tool generator](https://developers.google.com/digital-asset-links/tools/generator) — validazione `assetlinks.json`.
