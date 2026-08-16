# Somto iOS

Bootstrap nativo SwiftUI dell'app iOS Somto. Il piano storico di porting è in
[IOS_SWIFT_PORTING_PLAN.md](IOS_SWIFT_PORTING_PLAN.md).

## Stato attuale

- shell iOS con `TabView` a 5 sezioni
- sessione Firebase Auth con email/password
- design system dark-first coerente col prodotto web
- search globale come sheet con scope `titoli / utenti / generi / persone`
- `Title Detail` con hero, provider, trailer, watchlist e rating base
- `Watchlist`, `Notifiche` e `Profilo` allineati al backend Firestore esistente
- profilo pubblico nativo apribile da search, feed e notifiche
- thread list + thread detail nativi con realtime messaggi e discussione pubblica dai title detail
- primo blocco `Match` nativo agganciato alla callable `getMatchQueue` e al salvataggio feedback

## Aprire il progetto

1. Da questa cartella genera il progetto:

```bash
xcodegen generate
```

2. Apri [TwoWatch.xcodeproj](TwoWatch.xcodeproj).
3. Avvia il target `TwoWatch` su simulatore iOS 17+.

## Config Firebase

La bootstrap preferisce `GoogleService-Info.plist` quando presente per usare la configurazione iOS completa. [FirebaseConfig.plist](TwoWatch/Resources/FirebaseConfig.plist) resta disponibile come fallback e come source of truth per region/emulator settings.

Chiavi supportate:

- `API_KEY`
- `PROJECT_ID`
- `GOOGLE_APP_ID`
- `GCM_SENDER_ID`
- `STORAGE_BUCKET`
- `FUNCTIONS_REGION`
- `APP_CHECK_DEBUG_PROVIDER`
- `USE_EMULATORS`
- `EMULATOR_HOST`
- `AUTH_PORT`
- `FIRESTORE_PORT`
- `FUNCTIONS_PORT`
- `STORAGE_PORT`

Note:

- la configurazione attuale permette Auth email/password, Firestore, Functions e Storage;
- App Check viene inizializzato prima di Firebase: su device usa `App Attest` con fallback `DeviceCheck`, mentre su simulatore usa automaticamente il debug provider;
- `APP_CHECK_DEBUG_PROVIDER=true` forza il debug provider anche su device di sviluppo, utile finché non abiliti enforcement o quando lavori fuori dal perimetro App Attest;
- se abiliti gli emulatori in `FirebaseConfig.plist`, la bootstrap iOS li applica anche quando `GoogleService-Info.plist` è presente.

## Prossimi step

- completare `PostDetail`, friend requests/recommendations inbox e routing social senza fallback web
- aggiungere `Upcoming / Per te` nativo
- portare push/APNs/FCM e rifiniture finali di haptics/loading/error states
