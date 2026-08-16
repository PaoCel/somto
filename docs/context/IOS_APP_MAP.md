# iOS — mappa app, header globale, onboarding

Leggi quando tocchi la shell iOS (RootView, tab bar, header) o il flusso di onboarding.

## App architecture (cheat sheet)
- Entry: `ios/TwoWatch/App/TwoWatchApp.swift` → `RootView` in `Features/AppShell/RootView.swift`
- Tab bar in `AppTabShellView` (RootView): Home / Match / Watchlist / Quiz / Profile
- Tab enum: `AppTab` in `App/AppShellStore.swift`
- AppShellStore presentation flags: `isMenuPresented`, `isSearchPresented`, `isNotificationsPresented`, `isUpcomingPresented`, `activePresentedDestination` (fullScreenCover), `activePresentedSheet`
- AppContainer (`App/AppContainer.swift`) wires repos: auth, user, title, watchlist, notification, home, threads, match, posts, socialInbox, upcoming, quiz
- Session: `SessionStore` con `appUser: AppUser?`, `firebaseUser`, `isAuthenticated`, `isLoading`

## Header globale
- Componente: `BrandChromeBar` in `DesignSystem/Components/BrandWordmarkView.swift`
- Layout 4 tasti: `[hamburger][search]   [SomtoWordmark]   [chat][bell]`
- Container del header **trasparente**. Solo i singoli buttons + wordmark hanno chip material individuali (`.ultraThinMaterial`) → contenuto sotto non viene mai coperto da un pill pieno
- Applicato in RootView via `.brandChromePill(shell:)` su tutte le 5 tab (Home/Match/Watchlist/Quiz/Profile) — chrome identico ovunque. Ogni tab scroll dà `.padding(.top, 48)` al contenuto per uno spazio uniforme sotto l'header (Match esclusa: layout full-bleed a carte; Watchlist `72` per più stacco dal selettore area)

## Onboarding feature
Path (`Features/Onboarding/`):
- `OnboardingFlowView.swift` — coordinatore: welcome → taste, poi persistenza.
- `OnboardingWelcomeView.swift` — carosello 3 schermate (cos'è Somto + le 5 tab).
- `OnboardingTasteView.swift` — picker ~8 titoli amati (min 4 / target 8 / max 12), ricerca + griglia popolari.
- Mostrato in `RootView` come `fullScreenCover` su `SessionStore.requiresOnboarding`, dopo il gate community-safety. Welcome e taste skippabili (no hard-gate).
- Persistenza in `UserRepository`: `fetchOnboardingNeedsPrompt` (gate `completedLevel<1 && lastPromptAt==nil`), `completeOnboarding(uid:seedTitleIds:)`, `markOnboardingSkipped`. Scrive `usersPrivate/{uid}` (`onboardingStatus` + `tasteProfile.seedTitleIds` + `confidenceScore`), allineato a `finalizeOnboarding` della PWA (`public/js/api/onboarding.api.js`).
