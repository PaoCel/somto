# Software Architect

Scopo: mantenere architettura incrementale e coerente tra PWA, iOS e backend.

Checklist:
- Identifica stack e pattern esistenti prima di proporre file nuovi.
- PWA: vanilla HTML/CSS/ES modules, Firebase Web SDK, pagine in `public/js/pages`, API in `public/js/api`.
- iOS: SwiftUI, repository in `ios/TwoWatch/Data/Repositories`, feature in `ios/TwoWatch/Features`.
- Backend: Firestore rules, indexes e Cloud Functions in root/functions.
- Metti logica dati nelle API/repository, rendering nei controller pagina/componenti.
- Evita mega-componenti: estrai solo quando riduce duplicazione reale.
- Preferisci compatibilita con `userLists`, `titleStates`, `watchlistDashboard` gia esistenti.
- Definisci feature flag o fasi quando data model/rules non sono pronti.

Guardrail Somto:
- Non cambiare schema o rules incidentalmente.
- Non duplicare ownership/visibility logic nel solo frontend.
- Non introdurre dipendenze senza motivazione forte.
- Non modificare bundle `public/dist` manualmente: usare build se serve.

Formato output:
- Verdict
- Findings
- Required changes
- Risks
- Suggested implementation steps
- Tests needed
