# Somto

[![CI](https://github.com/PaoCel/somto/actions/workflows/ci.yml/badge.svg)](https://github.com/PaoCel/somto/actions/workflows/ci.yml)
[![Security](https://github.com/PaoCel/somto/actions/workflows/security.yml/badge.svg)](https://github.com/PaoCel/somto/actions/workflows/security.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Somto è un social per film e serie TV: watchlist, voti e recensioni, quiz,
feed e discussioni. Il repository contiene la [PWA](https://somto.it), l'app
iOS e il backend Firebase.

Il codice è pubblico per trasparenza e collaborazione. Il repository non
include credenziali, accesso ai progetti Firebase Somto o diritti sul nome,
sul logo e sugli asset di terze parti.

Sviluppato in un repository privato (oltre 1200 commit) da febbraio 2026.
Questo repo è pubblicato come snapshot dello stato attuale, non come
mirror della history: la cronologia privata contiene dati operativi non
adatti a un repository pubblico (vedi [SECURITY.md](SECURITY.md) per come
segnalare un problema, non per rivivere quella storia).

## Stack

- PWA multipagina in JavaScript, HTML e CSS, senza framework runtime.
- App iOS SwiftUI per iOS 17+, progetto generato con XcodeGen.
- Firebase Auth, Firestore, Storage e Cloud Functions.
- Test Node, Firebase Emulator Suite e Playwright.

## Quick start

Prerequisiti: Node.js 22, Java 21, Firebase CLI e, per iOS, Xcode 15+ con
XcodeGen.

```bash
git clone https://github.com/PaoCel/somto.git somto
cd somto
npm ci
npm --prefix functions ci
scripts/hooks/install.sh

# test unitari
npm test
npm --prefix functions run test:unit

# rules e test end-to-end sugli emulatori
npm --prefix functions run test:rules
npm run e2e
```

Lo sviluppo locale usa il progetto fittizio `demo-2watch` e non deve
contattare produzione o staging. Le configurazioni Firebase client tracciate
identificano applicazioni pubbliche e non concedono permessi IAM o di deploy;
l'accesso ai dati resta governato da Security Rules e App Check.

## Orientarsi

| Voglio… | Documento |
|---|---|
| Capire l'architettura | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Sviluppare in locale | [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) |
| Capire il modello dati | [docs/FIREBASE_DATA_MODEL.md](docs/FIREBASE_DATA_MODEL.md) |
| Capire sicurezza e permessi | [docs/SECURITY.md](docs/SECURITY.md) |
| Contribuire | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Segnalare una vulnerabilità | [SECURITY.md](SECURITY.md) |

## Struttura

```text
public/                    PWA
ios/                       app SwiftUI
functions/                 Cloud Functions principali
functions-public-profile/ Cloud Functions profili pubblici
blog/                      blog Eleventy
firestore.rules            regole Firestore
storage.rules              regole Storage
scripts/                   guardie, build e tooling
test/ e e2e/               test web e browser
docs/                      architettura e decisioni tecniche
```

## Sicurezza e ambienti

- Non inserire mai `.env`, service account, chiavi private, token o dati utente.
- Usare gli emulatori per sviluppo e test automatici.
- Non tentare deploy verso i progetti Somto: richiedono autorizzazioni esterne
  al repository e guardie aggiuntive.
- Segnalare privatamente le vulnerabilità seguendo [SECURITY.md](SECURITY.md).

## Contributi

Issue e pull request sono benvenute. Prima di iniziare, leggere
[CONTRIBUTING.md](CONTRIBUTING.md) e il [codice di condotta](CODE_OF_CONDUCT.md).

## Licenza e attribuzioni

Il codice è distribuito con licenza [Apache-2.0](LICENSE). La licenza non
concede diritti sul nome o sui loghi Somto; si applicano le condizioni in
[TRADEMARKS.md](TRADEMARKS.md). Dati, immagini e marchi di terze parti restano
soggetti ai rispettivi titolari e alle note in [NOTICE](NOTICE).

Somto usa l'API TMDB ma non è approvato né certificato da TMDB.
