export const meta = {
  name: 'quiz-map-architecture',
  description: 'Mappa architettura quiz/auth Somto per progettare guest-play + ricerca temi + product readiness',
  phases: [{ title: 'Map' }],
}

const AREAS = [
  { key: 'auth', prompt: 'Mappa il sistema di AUTENTICAZIONE della PWA web (cartella public/). Leggi: public/firebaseConfig.js, public/js/components/authGuard.js, public/js/pages/login.page.js, public/js/api/users.api.js, e cerca qualsiasi uso di anonymous auth (grep "signInAnonymous", "isAnonymous", "linkWith", "AnonymousAuth"). Spiega: come funziona authGuard (requireAuth), come avviene login/signup, ensureUserDoc, e SE/COME si potrebbe abilitare il gioco da OSPITE (anonymous auth) — è già supportato? cosa servirebbe? Come fare upgrade anon->account permanente a registrazione (linkWithCredential).' },
  { key: 'quiz_data', prompt: 'Mappa il flusso DATI del quiz web. Leggi tutto public/js/api/quiz.api.js e public/js/pages/quiz-play.page.js (e quiz-setup.page.js). Spiega in dettaglio: fetchPlayableQuestions (come campiona? ordina? cap?), come si svolge una partita, come si calcola/scrive il punteggio (quizAttempts, quizStats), submit/record attempt, rate limit. Quali scritture richiedono auth non-anonima? Cosa serve perche un OSPITE possa giocare una partita (anche senza salvare stats).' },
  { key: 'rules', prompt: 'Leggi firestore.rules. Estrai e spiega le regole per: quizQuestions, users/{uid}/quizAttempts, users/{uid}/quizStats, users/{uid}/rateLimits, users (create/update), e la funzione isSignedIn() (e simili). DOMANDA CHIAVE: un utente ANONIMO (firebase anonymous auth, request.auth != null ma provider anonimo) passa isSignedIn()? Puo leggere quizQuestions? Puo scrivere quizAttempts/quizStats sul proprio uid? Cosa si romperebbe abilitando guest play anonimo. Indica eventuali modifiche rules necessarie.' },
  { key: 'themes', prompt: 'Mappa la selezione TEMI del quiz. Leggi public/js/pages/quiz-setup.page.js e le funzioni rilevanti in public/js/api/quiz.api.js (fetchPlayableQuestions / fetchPlayableThemes). Problema: i temi derivano da un campione random di 300 domande, senza ricerca, e con ~130 titoli non li mostra tutti. Indaga: esiste un modo affidabile per elencare TUTTI i titoli che hanno domande quiz? (es. un campo su titles, o un aggregato, o una query distinct su quizQuestions). Proponi 2-3 soluzioni concrete (con/ senza nuovo indice/campo) per listing completo + ricerca testuale, valutando costi di lettura Firestore.' },
  { key: 'public_seo', prompt: 'Mappa le superfici PUBBLICHE/SEO rilevanti per un quiz di acquisizione. Leggi: public/quiz-film-serie-tv.html (landing marketing), functions/modules/titlePage.js (SSR pagine titolo), firebase.json (rewrites/routing/headers), public/robots.txt, e come e generata la sitemap. Spiega dove potrebbe vivere una pagina QUIZ PUBBLICA GIOCABILE (indicizzabile, deep-link per titolo es /quiz/one-piece), come si integrerebbe col routing hosting e con le pagine titolo. Nota i vincoli (no catch-all rewrite, noindex sulle pagine app).' },
  { key: 'ios_parity', prompt: 'Mappa il quiz su iOS (SwiftUI) per capire la parita necessaria. Leggi: ios/TwoWatch/Features/Quiz/QuizHomeView.swift, QuizGameSetupView.swift, QuizPlayView.swift, ios/TwoWatch/Data/Repositories/QuizRepository.swift, e come l app gestisce il gate auth (Features/AppShell/RootView.swift, SessionStore). Spiega: come iOS lista i temi (fetchPlayableThemes), come gioca/scrive stats, e se l accesso al quiz e dietro login. Cosa servirebbe per allineare iOS a eventuali cambi web (guest play, ricerca temi). Nota: priorita e il WEB per acquisizione, ma elenca il delta iOS.' },
  { key: 'tests_build', prompt: 'Mappa TEST e BUILD del progetto. Leggi: scripts/test-rules/ (come si lancia, package.json), scripts/test-functions/ se presente, qualsiasi build per public/ (esbuild? package.json alla root o in public/, cartella public/dist/ come e generata), e come si avvia l emulatore Firestore. Spiega i comandi esatti per: (1) eseguire i test rules in emulatore, (2) buildare gli asset web (se serve), (3) lint/typecheck se presenti. Serve per la fase di QA/test pre-lancio.' },
]

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['area','howItWorks','keyFiles','recommendations','risks'],
  properties: {
    area: { type: 'string' },
    keyFiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path','role'], properties: { path: { type: 'string' }, role: { type: 'string' } } } },
    howItWorks: { type: 'string', description: 'spiegazione dettagliata del funzionamento attuale' },
    guestPlayImpact: { type: 'string', description: 'cosa cambia/serve per guest play o per il tema in oggetto' },
    recommendations: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

phase('Map')
log('Mappatura architettura quiz/auth: ' + AREAS.length + ' aree in parallelo.')
const results = await parallel(AREAS.map(a => () =>
  agent(a.prompt + '\n\nRestituisci un oggetto strutturato preciso e concreto (cita path file reali).', { label: 'map:' + a.key, phase: 'Map', schema: SCHEMA, agentType: 'general-purpose' })
))
return results.filter(Boolean)
