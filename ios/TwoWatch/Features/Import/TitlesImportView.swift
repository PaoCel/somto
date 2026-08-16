@preconcurrency import FirebaseFirestore
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications

/// Tetto per il file di import letto in-app. Ampio (40MB) per export grandi; oltre,
/// l'utente carica dal sito somto.it/import.
private let importFileMaxBytes = 40 * 1024 * 1024

/// Legge e valida un file di testo per l'import FUORI dal main thread (niente
/// blocco/ANR su file grandi), rifiutando esplicitamente gli archivi ZIP: se
/// l'utente prova a passare lo ZIP di TV Time invece dei CSV/JSON estratti, mostra
/// un errore chiaro invece di caricare byte binari illeggibili.
private func readImportTextFile(at url: URL) async throws -> String {
    try await Task.detached(priority: .userInitiated) {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }

        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           size > importFileMaxBytes {
            throw TitlesImportError.fileTooLarge
        }

        let data = try Data(contentsOf: url, options: .mappedIfSafe)

        if data.count > importFileMaxBytes {
            throw TitlesImportError.fileTooLarge
        }

        // ZIP e altri contenitori "PK…": vanno estratti prima di scegliere i file.
        if data.starts(with: [0x50, 0x4B] as [UInt8]) {
            throw TitlesImportError.archiveNotSupported
        }

        if let text = String(data: data, encoding: .utf8) {
            return text
        }
        if importDataLooksLikeText(data), let latin = String(data: data, encoding: .isoLatin1) {
            return latin
        }
        throw TitlesImportError.unreadableFile
    }.value
}

/// Euristica "sembra testo": nessun byte NUL e pochi byte di controllo non
/// stampabili nel campione iniziale, così un binario (immagine/archivio/db) non
/// viene accettato come testo solo perché Latin-1 lo decodifica comunque.
private func importDataLooksLikeText(_ data: Data) -> Bool {
    let sample = data.prefix(4096)
    guard !sample.isEmpty else { return true }
    var suspicious = 0
    for byte in sample {
        if byte == 0x00 { return false }
        if byte < 0x09 || (byte > 0x0D && byte < 0x20) {
            suspicious += 1
        }
    }
    return Double(suspicious) / Double(sample.count) < 0.05
}

/// Risultato dell'estrazione dello ZIP TV Time: formato riconosciuto + i due file
/// (film/serie) come testo, con i nomi per il display.
private struct ExtractedTvTimeZip {
    let format: TvTimeExportFormat
    let movies: String?
    let series: String?
    let moviesName: String?
    let seriesName: String?
    // File extra dell'export GDPR (Refract li ha già dentro i JSON film/serie):
    // voti episodi, voti/emozioni film, commenti, liste. `var` con default nil
    // così i call site che estraggono solo film/serie compilano invariati.
    var episodeVotes: String? = nil
    var movieRatings: String? = nil
    var movieVotes: String? = nil
    var movieComments: String? = nil
    var episodeComments: String? = nil
    var lists: String? = nil
    // Voti dati alle SERIE: su un account vecchio e' l'unico voto presente,
    // i voti per episodio sono arrivati dopo.
    var showRatings: String? = nil
}

/// Estrae dallo ZIP TV Time (fuori dal main thread) i soli file dati che servono:
/// GDPR (`tracking-prod-records.csv` = film, `-v2.csv` = serie) o Refract
/// (`tvtime-movies-*.json` / `tvtime-series-*.json`). Il resto dello ZIP (PII) non
/// viene mai letto. Vedi `TVTimeZip` (port della web `tvTimeZip.js`).
private func extractTvTimeZip(at url: URL) async throws -> ExtractedTvTimeZip {
    try await Task.detached(priority: .userInitiated) {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }

        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           size > importFileMaxBytes {
            throw TitlesImportError.fileTooLarge
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        if data.count > importFileMaxBytes {
            throw TitlesImportError.fileTooLarge
        }

        // GDPR: nomi esatti. Estraiamo TUTTI i file dati (non solo film/serie)
        // in parità col web (public/js/pages/import.page.js): voti, emozioni,
        // commenti e liste. La PII (email, hash password, IP) resta nello ZIP.
        let gdpr = try TVTimeZip.extract(from: data) { base in
            switch base {
            case "tracking-prod-records.csv": return "movies"
            case "tracking-prod-records-v2.csv": return "series"
            case "ratings-3-prod-episode_votes.csv": return "episodeVotes"
            case "ratings-live-votes.csv": return "movieRatings"
            case "emotions-live-votes.csv": return "movieVotes"
            case "comments-prod-comments.csv": return "movieComments"
            case "episode_comment.csv": return "episodeComments"
            case "lists-prod-lists.csv": return "lists"
            case "tv_show_rate.csv": return "showRatings"
            default: return nil
            }
        }
        if gdpr["movies"] != nil || gdpr["series"] != nil {
            return ExtractedTvTimeZip(
                format: .gdpr,
                movies: gdpr["movies"],
                series: gdpr["series"],
                moviesName: gdpr["movies"] != nil ? "tracking-prod-records.csv" : nil,
                seriesName: gdpr["series"] != nil ? "tracking-prod-records-v2.csv" : nil,
                episodeVotes: gdpr["episodeVotes"],
                movieRatings: gdpr["movieRatings"],
                movieVotes: gdpr["movieVotes"],
                movieComments: gdpr["movieComments"],
                episodeComments: gdpr["episodeComments"],
                lists: gdpr["lists"],
                showRatings: gdpr["showRatings"]
            )
        }

        // Refract: prefisso + suffisso (il nome porta la data dell'export).
        let refract = try TVTimeZip.extract(from: data) { base in
            if base.hasPrefix("tvtime-movies-") && base.hasSuffix(".json") { return "movies" }
            if base.hasPrefix("tvtime-series-") && base.hasSuffix(".json") { return "series" }
            return nil
        }
        if refract["movies"] != nil || refract["series"] != nil {
            return ExtractedTvTimeZip(
                format: .refract,
                movies: refract["movies"],
                series: refract["series"],
                moviesName: refract["movies"] != nil ? "tvtime-movies.json" : nil,
                seriesName: refract["series"] != nil ? "tvtime-series.json" : nil
            )
        }

        throw TitlesImportError.zipMissingTvTimeFiles
    }.value
}

enum TitlesImportSource: String, CaseIterable, Identifiable {
    case tvTime = "tvtime_gdpr"
    case netflix = "netflix_csv"
    case trakt = "trakt"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .tvTime: return "TV Time"
        case .netflix: return "Netflix"
        case .trakt: return "Trakt"
        }
    }

    /// Colore ufficiale del brand per il chip logo del selettore sorgente.
    var brandColor: Color {
        switch self {
        case .tvTime: return Color(red: 0.941, green: 0.149, blue: 0.294) // TV Time #F0264B
        case .netflix: return Color(red: 0.898, green: 0.035, blue: 0.078) // Netflix #E50914
        case .trakt: return Color(red: 0.929, green: 0.110, blue: 0.141) // Trakt #ED1C24
        }
    }

    /// Monogramma bianco dentro il chip (nessun asset esterno).
    var brandMonogram: String {
        switch self {
        case .tvTime: return "tv"
        case .netflix: return "N"
        case .trakt: return "tr"
        }
    }
}

/// Stato locale del flusso di collegamento Trakt (OAuth device flow), separato
/// dallo stato dell'import vero e proprio (`job`). Vive solo mentre la sheet
/// di collegamento è aperta; una volta connesso l'utente torna alla card
/// sorgente che ora mostra "Importa da Trakt" al posto del collegamento.
private enum TraktConnectPhase: Equatable {
    case idle
    case starting
    case awaitingAuthorization(TraktConnectSession)
    case connected
    case expired
    case denied

    var isAwaitingAuthorization: Bool {
        if case .awaitingAuthorization = self { return true }
        return false
    }
}

/// Formato dell'export TV Time scelto dentro il tab TV Time (non c'è
/// autodetect dal contenuto su iOS come sul web, dato che qui l'utente
/// sceglie i file uno a uno tramite il file picker di sistema, non uno ZIP
/// intero — l'utente sa già quale export ha scaricato).
enum TvTimeExportFormat: String, CaseIterable, Identifiable {
    case gdpr
    case refract

    var id: String { rawValue }

    var label: String {
        switch self {
        case .gdpr: return "Export GDPR"
        case .refract: return "Refract (TV Time Out)"
        }
    }
}

/// Quale @State var riceve il prossimo file scelto dal fileImporter
/// condiviso (Netflix CSV, TV Time GDPR CSV film/serie, TV Time Refract JSON
/// film/serie — 5 destinazioni possibili, un solo fileImporter).
private enum TitlesImportFileTarget {
    case netflixCsv
    case tvTimeGdprMovies
    case tvTimeGdprSeries
    case tvTimeRefractMovies
    case tvTimeRefractSeries
    case tvTimeZip
}

/// Decisione locale (non ancora inviata al server) su una riga dello Screen B
/// (review manuale). Le righe rimaste `.undecided` non finiscono nel payload
/// `resolutions` — `skipRemaining:true` le dispone comunque alla conferma.
private enum ManualReviewDecision: Equatable {
    case undecided
    case skip
    case acceptSuggestion
    case importTitle(titleId: String, titleName: String)
}

private struct ImportTitleSearchSheet: View {
    let item: TitlesImportUnresolvedItem
    let titleRepository: TitleRepository
    let onSelect: (Title) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Title] = []
    @State private var isSearching = false
    @State private var errorMessage: String?

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TwoWatchBackground()
                Group {
                    if trimmedQuery.count < 2 {
                        ContentUnavailableView(
                            "Cerca il titolo corretto",
                            systemImage: "magnifyingglass",
                            description: Text("Scrivi almeno due caratteri.")
                        )
                    } else if isSearching {
                        ProgressView()
                            .tint(TwoWatchTheme.textPrimary)
                    } else if let errorMessage {
                        ContentUnavailableView(
                            "Ricerca non disponibile",
                            systemImage: "wifi.exclamationmark",
                            description: Text(errorMessage)
                        )
                    } else if results.isEmpty {
                        ContentUnavailableView.search(text: trimmedQuery)
                    } else {
                        List(results) { title in
                            Button {
                                onSelect(title)
                                dismiss()
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(title.name)
                                            .font(.subheadline.weight(.bold))
                                            .foregroundStyle(TwoWatchTheme.textPrimary)
                                        Text([title.type.label, title.year.map(String.init)]
                                            .compactMap { $0 }
                                            .joined(separator: " · "))
                                            .font(.caption)
                                            .foregroundStyle(TwoWatchTheme.textMuted)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: "checkmark.circle")
                                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .listRowBackground(TwoWatchTheme.panelStrong)
                        }
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            .navigationTitle(item.displayLabel)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Titolo, film o serie")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") {
                        dismiss()
                    }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
        .onAppear {
            if query.isEmpty {
                query = item.movieNameGuess
                    ?? item.seriesNameGuess
                    ?? item.rawTitle
                    ?? ""
            }
        }
        .task(id: trimmedQuery) {
            guard trimmedQuery.count >= 2 else {
                results = []
                isSearching = false
                errorMessage = nil
                return
            }

            isSearching = true
            errorMessage = nil
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }

            do {
                let found = try await titleRepository.searchTitles(trimmedQuery, limit: 12)
                guard !Task.isCancelled else { return }
                results = found
            } catch {
                guard !Task.isCancelled else { return }
                results = []
                errorMessage = String(localized: "Controlla la connessione e riprova.")
            }
            isSearching = false
        }
    }
}

struct TitlesImportView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let initialImportID: String?
    /// Valorizzata quando la view è presentata DENTRO il cover dell'onboarding
    /// (`OnboardingFlowView`): lì `shell.activePresentedDestination` non chiude
    /// niente, quindi sia la "X" sia il passaggio allo step successivo passano
    /// da questa closure.
    let onboardingHandoff: (() -> Void)?

    // TV Time chiude il 15/07: in evidenza di default.
    @State private var selectedSource: TitlesImportSource

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        initialImportID: String?,
        initialSource: TitlesImportSource? = nil,
        onboardingHandoff: (() -> Void)? = nil
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.initialImportID = initialImportID
        self.onboardingHandoff = onboardingHandoff
        _selectedSource = State(initialValue: initialSource ?? .tvTime)
    }

    @State private var selectedFileName: String?
    @State private var selectedCsv: String = ""

    // TV Time richiede 2 CSV separati (film + serie), estratti manualmente
    // dallo ZIP dell'export GDPR (vedi nota sulla scelta implementativa in
    // TitlesImportRepository.startTvTimeImport).
    @State private var tvTimeFormat: TvTimeExportFormat = .gdpr
    @State private var tvTimeMoviesFileName: String?
    @State private var tvTimeMoviesCsv: String = ""
    @State private var tvTimeSeriesFileName: String?
    @State private var tvTimeSeriesCsv: String = ""
    // File extra GDPR estratti dallo ZIP (voti/emozioni/commenti/liste). Vuoti
    // se l'utente carica i singoli file film/serie a mano invece dello ZIP.
    @State private var tvTimeEpisodeVotesCsv: String = ""
    @State private var tvTimeMovieRatingsCsv: String = ""
    @State private var tvTimeShowRatingsCsv: String = ""
    @State private var tvTimeMovieVotesCsv: String = ""
    @State private var tvTimeMovieCommentsCsv: String = ""
    @State private var tvTimeEpisodeCommentsCsv: String = ""
    @State private var tvTimeListsCsv: String = ""

    // TV Time Refract ("TV Time Out"): stesso principio, ma JSON invece di
    // CSV, e l'invio passa sempre dalla sessione di upload diretto a Storage
    // (createImportUploadSession) invece del body callable. Il matching è
    // identico agli altri formati (worker resumabile a tick).
    @State private var tvTimeRefractMoviesFileName: String?
    @State private var tvTimeRefractMoviesJson: String = ""
    @State private var tvTimeRefractSeriesFileName: String?
    @State private var tvTimeRefractSeriesJson: String = ""
    @State private var tvTimeZipFileName: String?

    @State private var fileImporterTarget: TitlesImportFileTarget = .tvTimeGdprMovies

    // Trakt: OAuth device flow (nessun file da caricare). `traktPollTask`
    // tiene il riferimento al Task di poll in corso per poterlo cancellare se
    // l'utente chiude la sheet o cambia sorgente prima che si connetta.
    @State private var traktPhase: TraktConnectPhase = .idle
    @State private var isTraktConnectSheetPresented = false
    @State private var traktPollTask: Task<Void, Never>?
    @State private var isStartingTraktImport = false

    @State private var options = TitlesImportOptions()
    @State private var job: TitlesImportJob?
    @State private var listener: ListenerRegistration?
    @State private var isImporting = false
    @State private var isFileImporterPresented = false
    @State private var errorMessage: String?
    @State private var pushStatus: UNAuthorizationStatus = .notDetermined
    @State private var isPushPromptPresented = false
    @State private var isOpeningSupportChat = false
    // Sheet LOCALE (non shell.activePresentedSheet): questa view è presentata
    // come fullScreenCover via activePresentedDestination, quindi uno sheet
    // montato su RootView finirebbe SOTTO il cover e non sarebbe visibile
    // finché non si chiude l'import. Presentando lo sheet qui, appare sopra.
    @State private var supportThreadID: String?
    // Fallback "Continua dal sito" (somto.it/import.html) quando l'import
    // fallisce. Stessa ragione del sheet locale qui sopra: NON usare
    // shell.activePresentedDestination = .web(...) — sostituirebbe il
    // fullScreenCover chiudendo l'import.
    @State private var webImportFallbackURL: URL?
    // Lettura+decodifica del file scelto in corso (off-main thread): spinner
    // sulla riga picker interessata + avvio import disabilitato nel frattempo.
    @State private var isReadingFile = false

    // Quick-confirm flow (Screen A/B/C, awaiting_confirmation -> completed):
    // stato dello Screen B (sheet review manuale) + del bottone conferma,
    // condivisi da Screen A e Screen B (entrambi chiamano `confirmImport`).
    @State private var isManualReviewPresented = false
    @State private var unresolvedItems: [TitlesImportUnresolvedItem] = []
    @State private var isLoadingUnresolvedItems = false
    @State private var itemDecisions: [String: ManualReviewDecision] = [:]
    @State private var manualTitleSearchItem: TitlesImportUnresolvedItem?
    @State private var isConfirmingImport = false

    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            TwoWatchBackground()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    if job == nil {
                        sourceSelector
                    }
                    privacyNote

                    if let job {
                        statusCard(job)
                        if onboardingHandoff != nil, isJobRunning(job.status) {
                            onboardingHandoffCard
                        }
                    } else {
                        switch selectedSource {
                        case .tvTime:
                            tvTimePickerCard
                        case .netflix:
                            netflixPickerCard
                        case .trakt:
                            traktPickerCard
                        }
                    }

                    backgroundCard
                    supportChatLink
                }
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .padding(.bottom, 36)
            }
        }
        .navigationTitle("Import cronologia")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Chiudi") {
                    if let onboardingHandoff {
                        onboardingHandoff()
                    } else {
                        shell.activePresentedDestination = nil
                    }
                }
                .foregroundStyle(TwoWatchTheme.textPrimary)
            }
        }
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: fileImporterContentTypes,
            allowsMultipleSelection: false
        ) { result in
            handleFileImport(result)
        }
        .task {
            pushStatus = await container.pushNotifications.currentAuthorizationStatus()
            if let initialImportID, job == nil {
                observe(importID: initialImportID)
            } else if job == nil, let uid = session.firebaseUser?.uid {
                // Riprendi un import gia' avviato invece di mostrare un picker
                // vuoto: un picker vuoto fa credere che il caricamento precedente
                // non sia riuscito -> l'utente ricarica lo stesso file (causa
                // n.1 del carico Firestore). Se c'e' un import in corso o pronto
                // da confermare, ne mostriamo lo stato e lo seguiamo live.
                if let active = try? await container.titlesImportRepository.fetchActiveImport(userID: uid) {
                    job = active
                    observe(importID: active.id)
                }
            }
        }
        .onDisappear {
            listener?.remove()
            listener = nil
            traktPollTask?.cancel()
            traktPollTask = nil
        }
        .alert(
            "Import cronologia",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { _ in errorMessage = nil }
            )
        ) {
            Button("Continua dal sito") {
                webImportFallbackURL = SomtoWebLinks.importURL
            }
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .sheet(item: Binding(
            get: { webImportFallbackURL.map(WebImportFallbackPresentation.init) },
            set: { webImportFallbackURL = $0?.url }
        )) { presentation in
            InAppSafariView(url: presentation.url)
                .ignoresSafeArea()
        }
        .sheet(item: Binding(
            get: { supportThreadID.map(SupportThreadPresentation.init) },
            set: { supportThreadID = $0?.id }
        )) { presentation in
            NavigationStack {
                ThreadDetailView(container: container, session: session, shell: shell, threadID: presentation.id)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Chiudi") {
                                supportThreadID = nil
                            }
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                    }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $isPushPromptPresented) {
            PushPermissionPromptSheet(
                onEnable: {
                    container.pushPromptService.markPromptSeen()
                    let granted = await container.pushNotifications.requestAuthorizationFromUser()
                    pushStatus = await container.pushNotifications.currentAuthorizationStatus()
                    container.analytics.log(AnalyticsEvent.pushPromptEnabled, [
                        "source": PushPromptService.Trigger.postImport.rawValue,
                        "granted": granted
                    ])
                },
                onDismiss: {
                    container.pushPromptService.markPromptSeen()
                    container.analytics.log(AnalyticsEvent.pushPromptDismissed, [
                        "source": PushPromptService.Trigger.postImport.rawValue
                    ])
                }
            )
            .onAppear {
                container.analytics.log(AnalyticsEvent.pushPromptShown, [
                    "source": PushPromptService.Trigger.postImport.rawValue
                ])
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(headerTitle)
                .font(.title2.weight(.black))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Text(headerSubtitle)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineSpacing(2)
        }
    }

    private var headerTitle: String {
        switch selectedSource {
        case .tvTime: return "Importa da TV Time"
        case .netflix: return String(localized: "Importa la cronologia Netflix")
        case .trakt: return "Importa da Trakt"
        }
    }

    private var headerSubtitle: String {
        switch selectedSource {
        case .tvTime:
            return String(localized: "TV Time chiude il 15 luglio: importa ora la tua cronologia film e serie, watchlist inclusa.")
        case .netflix:
            return String(localized: "Somto legge il CSV di Netflix e aggiorna i titoli visti, il progresso serie e i rewatch rilevati nella cronologia.")
        case .trakt:
            return String(localized: "Collega il tuo account Trakt: importiamo titoli visti, voti e watchlist in automatico, senza caricare nessun file.")
        }
    }

    private var sourceSelector: some View {
        HStack(spacing: 10) {
            ForEach(TitlesImportSource.allCases) { source in
                Button {
                    guard selectedSource != source else { return }
                    selectedSource = source
                    errorMessage = nil
                } label: {
                    VStack(spacing: 5) {
                        sourceLogo(for: source)
                        Text(source.label)
                            .font(.subheadline.weight(.bold))
                        if source == .tvTime {
                            Text("Chiude il 15/07")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.brandPrimary)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 68)
                    .foregroundStyle(selectedSource == source ? TwoWatchTheme.textPrimary : TwoWatchTheme.textSecondary)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(selectedSource == source ? TwoWatchTheme.brandPrimary.opacity(0.14) : TwoWatchTheme.panelStrong)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(selectedSource == source ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Chip logo brand della sorgente: quadrato arrotondato col colore
    /// ufficiale + monogramma bianco (asset locale, nessun hotlink esterno).
    private func sourceLogo(for source: TitlesImportSource) -> some View {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(source.brandColor)
            .frame(width: 28, height: 28)
            .overlay(
                Text(source.brandMonogram)
                    .font(.system(size: source == .netflix ? 17 : 15, weight: .heavy))
                    .foregroundStyle(.white)
            )
    }

    private var privacyNote: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .foregroundStyle(TwoWatchTheme.success)
            Text("Leggiamo solo la cronologia: email, password e altri dati personali non lasciano il tuo dispositivo.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineSpacing(2)
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(TwoWatchTheme.success.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TwoWatchTheme.success.opacity(0.24), lineWidth: 1))
    }

    private var netflixPickerCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                netflixSteps

                tvTimeFilePickerRow(
                    title: String(localized: "Scegli il CSV Netflix"),
                    subtitle: selectedFileName ?? String(localized: "Il file che hai scaricato da Netflix"),
                    fileName: selectedFileName,
                    isLoading: isReadingFile && fileImporterTarget == .netflixCsv
                ) {
                    fileImporterTarget = .netflixCsv
                    isFileImporterPresented = true
                }

                rewatchToggle
                Text("I rewatch presenti più volte dentro il file Netflix vengono contati automaticamente.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)

                Button {
                    Task { await startNetflixImport() }
                } label: {
                    if isImporting {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Avvia import")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(selectedCsv.isEmpty || isImporting || isReadingFile)
            }
        }
    }

    private var netflixSteps: some View {
        VStack(alignment: .leading, spacing: 12) {
            importStepRow(number: 1, text: String(localized: "Apri la cronologia Netflix.")) {
                Button {
                    if let url = URL(string: "https://www.netflix.com/settings/viewing-history") {
                        openURL(url)
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.up.right.square.fill")
                        Text("Apri netflix.com/settings/viewing-history")
                    }
                    .font(.caption.weight(.bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            }
            importStepRow(number: 2, text: "Seleziona in alto il profilo giusto, poi in fondo alla pagina tocca \u{201c}Scarica tutto\u{201d}.")
            importStepRow(number: 3, text: String(localized: "Torna qui e carica il CSV scaricato."))
        }
    }

    private var traktPickerCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                if traktPhase == .connected {
                    traktConnectedRow
                } else {
                    traktDisconnectedSteps
                }

                rewatchToggle
                Text("I rewatch rilevati nella cronologia Trakt vengono contati automaticamente.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)

                Button {
                    if traktPhase == .connected {
                        Task { await startTraktImport() }
                    } else {
                        isTraktConnectSheetPresented = true
                        Task { await beginTraktConnect() }
                    }
                } label: {
                    if isImporting || isStartingTraktImport {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text(traktPhase == .connected ? "Importa da Trakt" : "Connetti Trakt")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isImporting || isStartingTraktImport)
            }
        }
        .sheet(isPresented: $isTraktConnectSheetPresented, onDismiss: {
            // Se l'utente chiude la sheet senza completare, ferma il poll:
            // riproverà toccando di nuovo "Connetti Trakt".
            if traktPhase != .connected {
                traktPollTask?.cancel()
                traktPollTask = nil
                traktPhase = .idle
            }
        }) {
            traktConnectSheet
        }
    }

    private var traktDisconnectedSteps: some View {
        VStack(alignment: .leading, spacing: 12) {
            importStepRow(number: 1, text: "Tocca \u{201c}Connetti Trakt\u{201d} qui sotto: ti mostriamo un codice.")
            importStepRow(number: 2, text: String(localized: "Apri la pagina di attivazione Trakt sul telefono o sul computer e inserisci il codice."))
            importStepRow(number: 3, text: "Torna qui: appena l'account risulta collegato, avvia l'import.")
        }
    }

    private var traktConnectedRow: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(TwoWatchTheme.success)
            VStack(alignment: .leading, spacing: 3) {
                Text("Account Trakt collegato")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Titoli visti, voti e watchlist sono pronti per l'import.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(TwoWatchTheme.success.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(TwoWatchTheme.success.opacity(0.24), lineWidth: 1))
    }

    /// Sheet locale del device flow OAuth Trakt: mostra il codice utente
    /// prominente + link ad Attivazione Trakt, e riflette lo stato del poll
    /// in corso (avviato da `beginTraktConnect`, che appende alla sheet).
    private var traktConnectSheet: some View {
        NavigationStack {
            ZStack {
                TwoWatchBackground()
                VStack(spacing: 20) {
                    Spacer(minLength: 8)

                    switch traktPhase {
                    case .idle, .starting:
                        ProgressView()
                            .tint(TwoWatchTheme.textPrimary)
                        Text("Stiamo generando il codice...")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                    case .awaitingAuthorization(let session):
                        VStack(spacing: 10) {
                            Text("Il tuo codice")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                            Text(session.userCode)
                                .font(.system(.largeTitle, design: .monospaced).weight(.black))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                                .padding(.horizontal, 24)
                                .padding(.vertical, 14)
                                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(TwoWatchTheme.border, lineWidth: 1))
                        }

                        Button {
                            if let url = URL(string: session.verificationUrl) {
                                openURL(url)
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "arrow.up.right.square.fill")
                                Text("Apri trakt.tv e inserisci il codice")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())

                        HStack(spacing: 10) {
                            ProgressView()
                                .tint(TwoWatchTheme.textSecondary)
                            Text("In attesa che tu autorizzi Somto su Trakt...")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }

                    case .connected:
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(TwoWatchTheme.success)
                        Text("Account collegato!")
                            .font(.title3.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text("Ora puoi avviare l'import da Trakt.")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                        Button {
                            isTraktConnectSheetPresented = false
                        } label: {
                            Text("Continua")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())

                    case .expired:
                        Image(systemName: "clock.badge.exclamationmark.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(TwoWatchTheme.warning)
                        Text("Codice scaduto")
                            .font(.title3.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text("Non hai fatto in tempo ad autorizzare Somto. Riprova.")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .multilineTextAlignment(.center)

                        Button {
                            Task { await beginTraktConnect() }
                        } label: {
                            Text("Genera un nuovo codice")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())

                    case .denied:
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(TwoWatchTheme.warning)
                        Text("Autorizzazione rifiutata")
                            .font(.title3.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text("Hai negato l'accesso su Trakt. Puoi riprovare quando vuoi.")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .multilineTextAlignment(.center)

                        Button {
                            Task { await beginTraktConnect() }
                        } label: {
                            Text("Riprova")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }

                    Spacer(minLength: 8)
                }
                .padding(.horizontal, 24)
                .multilineTextAlignment(.center)
            }
            .navigationTitle("Collega Trakt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") {
                        isTraktConnectSheetPresented = false
                    }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var tvTimePickerCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    importStepRow(
                        number: 1,
                        text: String(localized: "Apri gdpr.tvtime.com/gdpr/self-service e richiedi l'export. Riceverai una mail con lo ZIP."),
                        extra: {
                            Button {
                                if let url = URL(string: "https://gdpr.tvtime.com/gdpr/self-service") {
                                    openURL(url)
                                }
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "arrow.up.right.square.fill")
                                    Text("Apri gdpr.tvtime.com")
                                }
                                .font(.caption.weight(.bold))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                        }
                    )

                    tvTimeSocialAccountNote

                    importStepRow(number: 2, text: String(localized: "Carica qui sotto lo ZIP ricevuto via mail: penso io a estrarre i file giusti. (In alternativa puoi estrarlo dall'app File e caricare i singoli file.)"))
                }

                tvTimeFormatSelector

                tvTimeFilePickerRow(
                    title: String(localized: "Carica lo ZIP dell'export"),
                    subtitle: tvTimeZipFileName ?? "Consigliato — estraggo io i file dallo ZIP",
                    fileName: tvTimeZipFileName,
                    isLoading: isReadingFile && fileImporterTarget == .tvTimeZip
                ) {
                    fileImporterTarget = .tvTimeZip
                    isFileImporterPresented = true
                }

                Text("Puoi caricare direttamente lo ZIP, oppure i singoli file qui sotto.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)

                if tvTimeFormat == .gdpr {
                    tvTimeFilePickerRow(
                        title: "tracking-prod-records.csv",
                        subtitle: String(localized: "File dei film (obbligatorio)"),
                        fileName: tvTimeMoviesFileName,
                        isLoading: isReadingFile && fileImporterTarget == .tvTimeGdprMovies
                    ) {
                        fileImporterTarget = .tvTimeGdprMovies
                        isFileImporterPresented = true
                    }

                    tvTimeFilePickerRow(
                        title: "tracking-prod-records-v2.csv",
                        subtitle: "File delle serie (obbligatorio)",
                        fileName: tvTimeSeriesFileName,
                        isLoading: isReadingFile && fileImporterTarget == .tvTimeGdprSeries
                    ) {
                        fileImporterTarget = .tvTimeGdprSeries
                        isFileImporterPresented = true
                    }
                } else {
                    tvTimeFilePickerRow(
                        title: "tvtime-movies-*.json",
                        subtitle: String(localized: "File dei film (obbligatorio)"),
                        fileName: tvTimeRefractMoviesFileName,
                        isLoading: isReadingFile && fileImporterTarget == .tvTimeRefractMovies
                    ) {
                        fileImporterTarget = .tvTimeRefractMovies
                        isFileImporterPresented = true
                    }

                    tvTimeFilePickerRow(
                        title: "tvtime-series-*.json",
                        subtitle: "File delle serie (obbligatorio)",
                        fileName: tvTimeRefractSeriesFileName,
                        isLoading: isReadingFile && fileImporterTarget == .tvTimeRefractSeries
                    ) {
                        fileImporterTarget = .tvTimeRefractSeries
                        isFileImporterPresented = true
                    }

                    Text("Questo export non include voti o recensioni.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }

                rewatchToggle
                Text("I rewatch presenti più volte nella cronologia TV Time vengono contati automaticamente.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)

                if tvTimeFormat == .gdpr {
                    commentConsentToggle
                }

                Button {
                    Task {
                        if tvTimeFormat == .refract {
                            await startTvTimeRefractImport()
                        } else {
                            await startTvTimeImport()
                        }
                    }
                } label: {
                    if isImporting {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Avvia import")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(tvTimeStartDisabled || isImporting || isReadingFile)
            }
        }
    }

    private var fileImporterContentTypes: [UTType] {
        // Il picker "ZIP intero" filtra .zip; gli altri CSV/JSON, così un file
        // singolo non può essere uno ZIP (e il picker ZIP mostra solo archivi).
        fileImporterTarget == .tvTimeZip ? [.zip] : [.commaSeparatedText, .plainText, .json]
    }

    private var tvTimeStartDisabled: Bool {
        switch tvTimeFormat {
        case .gdpr:
            return tvTimeMoviesCsv.isEmpty && tvTimeSeriesCsv.isEmpty
        case .refract:
            return tvTimeRefractMoviesJson.isEmpty && tvTimeRefractSeriesJson.isEmpty
        }
    }

    private var tvTimeFormatSelector: some View {
        Picker("Formato export", selection: $tvTimeFormat) {
            ForEach(TvTimeExportFormat.allCases) { format in
                Text(format.label).tag(format)
            }
        }
        .pickerStyle(.segmented)
    }

    private func tvTimeFilePickerRow(title: String, subtitle: String, fileName: String?, isLoading: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if isLoading {
                    ProgressView()
                        .tint(TwoWatchTheme.textPrimary)
                        .frame(width: 24)
                } else {
                    Image(systemName: fileName != nil ? "checkmark.circle.fill" : "doc.badge.plus")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(fileName != nil ? TwoWatchTheme.success : TwoWatchTheme.textPrimary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(isLoading ? String(localized: "Leggo il file...") : (fileName ?? title))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 58)
            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(TwoWatchTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
    }

    /// Riga step numerato riusabile per i flussi guidati Netflix/TV Time.
    private func importStepRow(number: Int, text: String) -> some View {
        importStepRow(number: number, text: text) { EmptyView() }
    }

    private func importStepRow<Extra: View>(
        number: Int,
        text: String,
        @ViewBuilder extra: () -> Extra
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.caption.weight(.black))
                .foregroundStyle(.white)
                .frame(width: 20, height: 20)
                .background(TwoWatchTheme.brandPrimary, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(text)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineSpacing(2)
                extra()
            }
            Spacer(minLength: 0)
        }
    }

    private var tvTimeSocialAccountNote: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            Text("Account TV Time creato con Google o Apple? Nella pagina GDPR puoi impostare la password con la tua email, poi scarichi l'export.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineSpacing(2)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(TwoWatchTheme.brandPrimary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(TwoWatchTheme.brandPrimary.opacity(0.24), lineWidth: 1))
    }

    private var tvTimeRatingConversionNote: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "star.fill")
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            Text("Su Somto i voti sono in decimi: quello che su TV Time era \u{201c}Bello\u{201d} diventa 7, \u{201c}Super\u{201d} 9, \u{201c}Wow\u{201d} 10, \u{201c}Ok\u{201d} 6, \u{201c}Brutto\u{201d} 4. Potrai sempre modificarli. Importiamo anche recensioni, rewatch e watchlist.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineSpacing(2)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private var supportChatLink: some View {
        Button {
            guard !isOpeningSupportChat else { return }

            // L'account di supporto (admin) non ha un thread "support_{uid}" verso
            // se stesso — il server salta utente==supporto e risponde
            // "insufficient permissions". Per gli admin apriamo la lista messaggi
            // (dove il supporto legge/risponde alle richieste), non un self-thread.
            guard !session.permissions.canRunAdminTools else {
                shell.activePresentedDestination = nil
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    shell.presentThreads()
                }
                return
            }

            isOpeningSupportChat = true
            Task { @MainActor in
                do {
                    let threadID = try await container.threadsRepository.ensureMySupportThread()
                    // Sheet locale: appare sopra il fullScreenCover dell'import,
                    // niente chiusura dell'import né delay di sincronizzazione.
                    supportThreadID = threadID
                } catch {
                    errorMessage = UserFacingError.message(for: error)
                }
                isOpeningSupportChat = false
            }
        } label: {
            HStack(spacing: 8) {
                if isOpeningSupportChat {
                    ProgressView()
                        .tint(TwoWatchTheme.textSecondary)
                } else {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                }
                Text(isOpeningSupportChat ? "Apro la chat di assistenza..." : "Problemi con l'export? Scrivici in chat, ti aiutiamo noi.")
                    .underline()
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .buttonStyle(.plain)
        .disabled(isOpeningSupportChat)
        .padding(.top, 4)
    }

    private var rewatchToggle: some View {
        Toggle(isOn: $options.countExistingAsRewatch) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Conta come rewatch anche i titoli già visti su Somto")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Lascia spento se hai già segnato quei titoli a mano e vuoi evitare doppi conteggi.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
        }
        .tint(TwoWatchTheme.brandPrimary)
    }

    /// Nota informativa (solo TV Time GDPR): i commenti-episodio fanno parte
    /// dell'export e li importiamo insieme al resto (niente più toggle di
    /// consenso → meno attrito). `options.importComments` resta al default `true`.
    /// La ripubblicazione come discussioni resta comunque dietro revisione
    /// manuale (non automatica né garantita), quindi la disclosure è doverosa.
    private var commentConsentToggle: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "text.bubble")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            VStack(alignment: .leading, spacing: 4) {
                Text("Importiamo anche i tuoi commenti")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Se avevi scritto commenti sugli episodi, li importiamo e proviamo a riportarli su Somto come tue discussioni. Non è automatico né garantito: passano da una revisione prima di essere pubblicati.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            Spacer(minLength: 0)
        }
    }

    /// Dispatcher per stato: `awaiting_confirmation`/`completed` hanno un
    /// flusso actionable dedicato (Screen A/B/C, quick-confirm); tutti gli
    /// altri stati (uploading/queued/matching/manual_processing/failed)
    /// restano sul rendering generico invariato.
    @ViewBuilder
    private func statusCard(_ job: TitlesImportJob) -> some View {
        switch job.status {
        case "awaiting_confirmation":
            confirmationCard(job)
        case "completed":
            completedSummaryCard(job)
        default:
            genericStatusCard(job)
        }
    }

    private func genericStatusCard(_ job: TitlesImportJob) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Image(systemName: statusIcon(job.status))
                        .font(.title2.weight(.bold))
                        .foregroundStyle(statusTint(job.status))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(statusTitle(job.status))
                            .font(.headline.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text(statusSubtitle(job))
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                    Spacer(minLength: 0)
                }

                // manual_processing non ha un vero progresso a righe (viene
                // gestito fuori dalla pipeline automatica) — mostra una barra
                // fissa a metà invece di 5% (che leggerebbe come "quasi fermo").
                ProgressView(value: job.status == "manual_processing" ? 0.35 : job.progressFraction)
                    .tint(TwoWatchTheme.brandPrimary)

                if job.status == "manual_processing" {
                    Text("Il formato generato dall'estensione Refract non viene ancora importato automaticamente. Abbiamo salvato i file necessari e completeremo noi l'import.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                } else {
                    Text("\(job.processedCount) / \(job.totalRows) righe analizzate")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }

                // Gate sulla source EFFETTIVA del job (popolata dal listener
                // Firestore un istante dopo l'avvio, vedi TitlesImportJob.source),
                // non sul tab selezionato — Refract non ha voti/recensioni e
                // non deve mai mostrare questa nota.
                if job.source == "tvtime_gdpr" {
                    tvTimeRatingConversionNote
                }

                if job.status == "failed" {
                    VStack(alignment: .leading, spacing: 10) {
                        if let error = job.error {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.warning)
                        }
                        webImportFallbackButton(isProminent: (job.error ?? "").contains("somto.it"))
                    }
                }

                HStack(spacing: 10) {
                    Button {
                        shell.activePresentedDestination = nil
                        shell.selectedTab = .profile
                    } label: {
                        Text(job.isTerminal ? "Vai al profilo" : "Lascia in background")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())

                    if pushStatus != .authorized && pushStatus != .provisional {
                        Button {
                            Task { await enablePush() }
                        } label: {
                            Image(systemName: "bell.badge.fill")
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(TwoWatchTheme.textPrimary)
                        .accessibilityLabel("Attiva notifiche")
                    }
                }
            }
        }
    }

    // MARK: - Screen A: awaiting_confirmation (quick confirm)

    /// Screen A: sostituisce la vecchia card "morta" (status message + solo
    /// "Vai al profilo") con un flusso actionable — l'utente PRIMA non aveva
    /// modo di completare l'import da iOS, restava bloccato per sempre in
    /// `awaiting_confirmation`. Path primario a zero decisioni ("Importa i
    /// titoli trovati") + path secondario di controllo manuale (Screen B).
    private func confirmationCard(_ job: TitlesImportJob) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Quasi fatto")
                            .font(.headline.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text(confirmationBodyText(job))
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineSpacing(2)
                    }
                    Spacer(minLength: 0)
                }

                if job.source == "tvtime_gdpr" {
                    tvTimeRatingConversionNote
                }

                Button {
                    Task { await performConfirm(job: job, resolutions: [], mode: "quick", dismissSheet: false) }
                } label: {
                    if isConfirmingImport {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Importa i titoli trovati")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isConfirmingImport)

                if job.unresolvedCount > 0 {
                    Text("Aggiunge i titoli riconosciuti e salta le \(job.unresolvedCount) voci dubbie.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)

                    Button {
                        openManualReview(job)
                    } label: {
                        Text("Controlla i titoli dubbi")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(TwoWatchTheme.textPrimary)
                    .disabled(isConfirmingImport)
                }

                HStack(spacing: 10) {
                    Button {
                        shell.activePresentedDestination = nil
                        shell.selectedTab = .profile
                    } label: {
                        Text("Lascia in background")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(TwoWatchTheme.textSecondary)
                    .disabled(isConfirmingImport)

                    if pushStatus != .authorized && pushStatus != .provisional {
                        Button {
                            Task { await enablePush() }
                        } label: {
                            Image(systemName: "bell.badge.fill")
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(TwoWatchTheme.textPrimary)
                        .accessibilityLabel("Attiva notifiche")
                    }
                }
            }
        }
        .onAppear {
            let props: [String: Any] = [
                "source": job.source ?? "",
                "platform": "ios",
                "matched": bucketCount(job.matchedCount),
                "unresolved": bucketCount(job.unresolvedCount)
            ]
            container.analytics.log(AnalyticsEvent.importReadyForConfirmation, props)
            container.analytics.log(AnalyticsEvent.importConfirmationOpened, props)
        }
        .sheet(isPresented: $isManualReviewPresented) {
            manualReviewSheet(job)
        }
    }

    private func confirmationBodyText(_ job: TitlesImportJob) -> String {
        var text = "\(job.matchedCount) titoli sono già nel tuo profilo."
        if job.unresolvedCount > 0 {
            text += " \(job.unresolvedCount) voci non siamo riusciti ad abbinarle in automatico."
        }
        return text
    }

    // MARK: - Screen B: manual review sheet

    private func openManualReview(_ job: TitlesImportJob) {
        container.analytics.log(AnalyticsEvent.importManualReviewOpened, [
            "source": job.source ?? "",
            "platform": "ios",
            "unresolved": bucketCount(job.unresolvedCount)
        ])
        unresolvedItems = []
        itemDecisions = [:]
        manualTitleSearchItem = nil
        isManualReviewPresented = true
    }

    /// Sheet di review manuale: lista le righe non risolte con, per ognuna,
    /// un tap "Usa {suggerimento}" (quando il matcher ne ha uno), ricerca nel
    /// catalogo o "Salta". Le indecise vengono saltate alla conferma, ma il
    /// conteggio e la CTA lo dichiarano esplicitamente.
    private func manualReviewSheet(_ job: TitlesImportJob) -> some View {
        NavigationStack {
            ZStack {
                TwoWatchBackground()
                VStack(spacing: 12) {
                    if isLoadingUnresolvedItems {
                        Spacer()
                        ProgressView()
                            .tint(TwoWatchTheme.textPrimary)
                        Spacer()
                    } else if unresolvedItems.isEmpty {
                        Spacer()
                        manualReviewEmptyState
                        Spacer()
                    } else {
                        ScrollView(showsIndicators: false) {
                            VStack(alignment: .leading, spacing: 12) {
                                manualReviewCounterRow
                                Text("Quando chiudi l'import, le voci ancora da decidere vengono saltate e non aggiunte alla libreria.")
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                manualReviewBulkActionsRow(job)
                                ForEach(unresolvedItems) { item in
                                    manualReviewRow(item)
                                }
                            }
                            .padding(.horizontal, 18)
                            .padding(.top, 12)
                            .padding(.bottom, 12)
                        }
                    }

                    Button {
                        Task { await confirmManualReview(job) }
                    } label: {
                        if isConfirmingImport {
                            ProgressView()
                                .tint(.white)
                                .frame(maxWidth: .infinity)
                        } else {
                            Text(manualReviewCounts.pending > 0
                                 ? "Conferma e salta \(manualReviewCounts.pending)"
                                 : "Conferma e chiudi")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isConfirmingImport || isLoadingUnresolvedItems)
                    .padding(.horizontal, 18)
                    .padding(.bottom, 12)
                }
            }
            .navigationTitle("Titoli dubbi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") {
                        isManualReviewPresented = false
                    }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task(id: job.id) {
            await loadUnresolvedItems(job)
        }
        .sheet(item: $manualTitleSearchItem) { item in
            ImportTitleSearchSheet(
                item: item,
                titleRepository: container.titleRepository
            ) { title in
                itemDecisions[item.itemId] = .importTitle(
                    titleId: title.id,
                    titleName: title.name
                )
                manualTitleSearchItem = nil
            }
        }
    }

    private var manualReviewEmptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 36))
                .foregroundStyle(TwoWatchTheme.success)
            Text("Nessuna voce da controllare")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
    }

    private var manualReviewCounts: (accepted: Int, skipped: Int, pending: Int) {
        var accepted = 0
        var skipped = 0
        for decision in itemDecisions.values {
            switch decision {
            case .acceptSuggestion, .importTitle:
                accepted += 1
            case .skip:
                skipped += 1
            case .undecided:
                break
            }
        }
        return (
            accepted,
            skipped,
            max(0, unresolvedItems.count - accepted - skipped)
        )
    }

    private var manualReviewCounterRow: some View {
        let counts = manualReviewCounts
        return Text("Accettati \(counts.accepted) · Saltati \(counts.skipped) · Da decidere \(counts.pending)")
            .font(.caption.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.textMuted)
    }

    private func manualReviewBulkActionsRow(_ job: TitlesImportJob) -> some View {
        Button {
            Task {
                await performConfirm(job: job, resolutions: [], mode: "manual", dismissSheet: true)
            }
        } label: {
            Text("Salta tutti")
                .font(.subheadline.weight(.bold))
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(TwoWatchTheme.textSecondary)
        .disabled(isConfirmingImport)
    }

    private func manualReviewRow(_ item: TitlesImportUnresolvedItem) -> some View {
        let decision = itemDecisions[item.itemId] ?? .undecided
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(item.displayLabel)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text(item.kindLabel)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            if case .importTitle(_, let titleName) = decision {
                Label("Scelto: \(titleName)", systemImage: "checkmark.circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.success)
            }

            HStack(spacing: 10) {
                if let suggestion = item.suggestion {
                    Button {
                        itemDecisions[item.itemId] = decision == .acceptSuggestion ? .undecided : .acceptSuggestion
                    } label: {
                        Text(decision == .acceptSuggestion ? "Suggerimento scelto" : "Usa \(suggestion.displayLabel)")
                            .font(.caption.weight(.bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(decision == .acceptSuggestion ? TwoWatchTheme.success : TwoWatchTheme.brandPrimary)
                }

                Button {
                    itemDecisions[item.itemId] = decision == .skip ? .undecided : .skip
                } label: {
                    Text(decision == .skip ? "Saltata" : "Salta")
                        .font(.caption.weight(.bold))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(decision == .skip ? TwoWatchTheme.warning : TwoWatchTheme.textSecondary)
            }

            Button {
                manualTitleSearchItem = item
            } label: {
                Label("Cerca un altro titolo", systemImage: "magnifyingglass")
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(TwoWatchTheme.textPrimary)
        }
        .padding(14)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private func loadUnresolvedItems(_ job: TitlesImportJob) async {
        guard let uid = session.firebaseUser?.uid else { return }
        isLoadingUnresolvedItems = true
        defer { isLoadingUnresolvedItems = false }
        do {
            unresolvedItems = try await container.titlesImportRepository.fetchUnresolvedItems(userID: uid, importID: job.id)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// La CTA finale invia SOLO le righe su cui l'utente ha deciso qualcosa
    /// (skip, suggerimento o titolo cercato); le indecise restano tali nel
    /// payload — `skipRemaining:true` le dispone comunque server-side, così
    /// il job finisce sempre in un'unica chiamata.
    private func confirmManualReview(_ job: TitlesImportJob) async {
        let resolutions: [TitlesImportResolution] = unresolvedItems.compactMap { item in
            switch itemDecisions[item.itemId] ?? .undecided {
            case .skip:
                return TitlesImportResolution(itemId: item.itemId, action: .skip)
            case .acceptSuggestion:
                return TitlesImportResolution(itemId: item.itemId, action: .acceptSuggestion)
            case .importTitle(let titleId, _):
                return TitlesImportResolution(itemId: item.itemId, action: .importTitle(titleId: titleId))
            case .undecided:
                return nil
            }
        }
        await performConfirm(job: job, resolutions: resolutions, mode: "manual", dismissSheet: true)
    }

    /// Chiamata condivisa a `confirmTitlesImport` per TUTTI i path di
    /// conferma (Screen A quick, Screen B salta-tutti/conferma-e-chiudi) —
    /// sempre con `skipRemaining:true`: qualunque riga
    /// non esplicitamente risolta viene saltata server-side, garantendo che
    /// il job finisca sempre in un'unica chiamata (mai un limbo residuo).
    private func performConfirm(job: TitlesImportJob, resolutions: [TitlesImportResolution], mode: String, dismissSheet: Bool) async {
        isConfirmingImport = true
        defer { isConfirmingImport = false }
        container.analytics.log(AnalyticsEvent.importQuickConfirmed, [
            "source": job.source ?? "",
            "platform": "ios",
            "confirmation_mode": mode,
            "skipped": bucketCount(job.unresolvedCount)
        ])
        do {
            let result = try await container.titlesImportRepository.confirmImport(
                importId: job.id,
                resolutions: resolutions,
                skipRemaining: true
            )
            applyJobUpdate(mergingConfirmResult(result, into: job))
            if dismissSheet {
                isManualReviewPresented = false
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func mergingConfirmResult(_ result: TitlesImportConfirmResult, into current: TitlesImportJob) -> TitlesImportJob {
        TitlesImportJob(
            id: current.id,
            status: result.status,
            totalRows: current.totalRows,
            processedCount: current.processedCount,
            matchedCount: current.matchedCount,
            unresolvedCount: result.unresolvedCount,
            errorCount: current.errorCount,
            error: current.error,
            source: current.source,
            importedTitleCount: result.importedTitleCount,
            skippedCount: result.skippedCount
        )
    }

    // MARK: - Screen C: completed summary

    /// Screen C: riepilogo finale. Nessuna CTA "crea post" (fuori scope,
    /// vedi spec) — solo libreria / "segna cosa stai guardando", entrambe
    /// portano alla tab Watchlist.
    private func completedSummaryCard(_ job: TitlesImportJob) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.success)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Importazione completata")
                            .font(.headline.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text(completedBodyText(job))
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                    Spacer(minLength: 0)
                }

                if job.source == "tvtime_gdpr" {
                    tvTimeRatingConversionNote
                }

                VStack(spacing: 10) {
                    Button {
                        goToLibrary(action: "library")
                    } label: {
                        Text("Vai alla mia libreria")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())

                    Button {
                        goToLibrary(action: "mark_watching")
                    } label: {
                        Text("Segna cosa stai guardando")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(TwoWatchTheme.textPrimary)
                }
            }
        }
    }

    private func completedBodyText(_ job: TitlesImportJob) -> String {
        var text = "Importati \(job.importedTitleCount) titoli"
        if job.skippedCount > 0 {
            text += " · \(job.skippedCount) saltati"
        }
        if job.errorCount > 0 {
            text += " · \(job.errorCount) errori"
        }
        return text
    }

    private func goToLibrary(action: String) {
        container.analytics.log(AnalyticsEvent.importPostActionClicked, [
            "platform": "ios",
            "action": action
        ])
        shell.activePresentedDestination = nil
        shell.selectedTab = .watchlist
    }

    /// Bottone "Continua dal sito" (somto.it/import.html). Prominente quando è
    /// il backend stesso a suggerire il sito (guardia byte: il messaggio
    /// d'errore contiene "somto.it"), discreto negli altri fallimenti.
    @ViewBuilder
    private func webImportFallbackButton(isProminent: Bool) -> some View {
        if isProminent {
            Button {
                webImportFallbackURL = SomtoWebLinks.importURL
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "safari.fill")
                    Text("Continua dal sito")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
        } else {
            Button {
                webImportFallbackURL = SomtoWebLinks.importURL
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "safari.fill")
                    Text("Continua dal sito")
                        .underline()
                }
                .font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(TwoWatchTheme.brandPrimary)
        }
    }

    private var backgroundCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Puoi chiudere questa schermata")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text("In questi giorni stiamo ricevendo molte richieste: l'elaborazione può richiedere più del solito. Ti avviseremo con una notifica; i titoli riconosciuti appariranno nella libreria del tuo profilo.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineSpacing(2)
        }
        .padding(14)
        .background(TwoWatchTheme.panel.opacity(0.7), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            errorMessage = UserFacingError.message(for: error)
        case .success(let urls):
            guard let url = urls.first else { return }
            // Cattura lo slot bersaglio ORA (sincrono): la lettura è async e nel
            // frattempo l'utente può aprire l'altro picker (film/serie), cambiando
            // `fileImporterTarget`. Leggerlo dopo l'await scriverebbe il contenuto
            // nello slot sbagliato.
            let target = fileImporterTarget
            Task { await loadPickedFile(url, target: target) }
        }
    }

    /// Aggiorna lo stato con il contenuto del file scelto. La lettura + validazione
    /// avviene fuori dal main thread (vedi `readImportTextFile`), così un file grande
    /// non blocca la UI e uno ZIP viene rifiutato con un messaggio chiaro invece di
    /// caricare byte binari illeggibili.
    @MainActor
    private func loadPickedFile(_ url: URL, target: TitlesImportFileTarget) async {
        if target == .tvTimeZip {
            await loadPickedTvTimeZip(url)
            return
        }
        let fileName = url.lastPathComponent
        isReadingFile = true
        defer { isReadingFile = false }
        do {
            let text = try await readImportTextFile(at: url)
            // Il selettore di formato è manuale e parte su GDPR: chi ha
            // l'export Refract (tvtime-*.json) lo infilava negli slot CSV e
            // l'import finiva con zero titoli, perche' il parser CSV non
            // riconosce l'header di un JSON. Il contenuto e' l'unica fonte
            // affidabile: se non combacia con lo slot, correggiamo lo slot.
            let target = retargetedForContent(text, target: target)
            switch target {
            case .netflixCsv:
                selectedCsv = text
                selectedFileName = fileName
            case .tvTimeGdprMovies:
                tvTimeMoviesCsv = text
                tvTimeMoviesFileName = fileName
            case .tvTimeGdprSeries:
                tvTimeSeriesCsv = text
                tvTimeSeriesFileName = fileName
            case .tvTimeRefractMovies:
                tvTimeRefractMoviesJson = text
                tvTimeRefractMoviesFileName = fileName
            case .tvTimeRefractSeries:
                tvTimeRefractSeriesJson = text
                tvTimeRefractSeriesFileName = fileName
            case .tvTimeZip:
                break // gestito sopra da loadPickedTvTimeZip
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Corregge lo slot bersaglio quando il contenuto del file appartiene
    /// palesemente all'altro formato TV Time, e allinea il selettore.
    ///
    /// Un export Refract inizia con `[` o `{` (JSON), un export GDPR con la
    /// riga di header CSV: sono distinguibili dal primo carattere utile, senza
    /// parsare nulla. Caso reale: due utenti hanno caricato i `tvtime-*.json`
    /// negli slot CSV col selettore lasciato su GDPR, e l'import è finito a
    /// zero titoli senza che nulla glielo dicesse.
    @MainActor
    private func retargetedForContent(_ text: String, target: TitlesImportFileTarget) -> TitlesImportFileTarget {
        guard let firstChar = text.first(where: { !$0.isWhitespace && !$0.isNewline }) else { return target }
        let looksLikeJson = firstChar == "[" || firstChar == "{"

        switch (target, looksLikeJson) {
        case (.tvTimeGdprMovies, true):
            tvTimeFormat = .refract
            return .tvTimeRefractMovies
        case (.tvTimeGdprSeries, true):
            tvTimeFormat = .refract
            return .tvTimeRefractSeries
        case (.tvTimeRefractMovies, false):
            tvTimeFormat = .gdpr
            return .tvTimeGdprMovies
        case (.tvTimeRefractSeries, false):
            tvTimeFormat = .gdpr
            return .tvTimeGdprSeries
        default:
            return target
        }
    }

    /// Carica lo ZIP dell'export TV Time: estrae i file dati (GDPR o Refract) e
    /// riempie gli slot corrispondenti, così l'utente NON deve estrarlo a mano.
    /// La PII (email, hash password, IP nello ZIP GDPR) resta nello ZIP: leggiamo
    /// solo i file di tracking, mai il resto.
    @MainActor
    private func loadPickedTvTimeZip(_ url: URL) async {
        isReadingFile = true
        defer { isReadingFile = false }
        do {
            let extracted = try await extractTvTimeZip(at: url)
            tvTimeZipFileName = url.lastPathComponent
            tvTimeFormat = extracted.format
            switch extracted.format {
            case .gdpr:
                if let m = extracted.movies { tvTimeMoviesCsv = m; tvTimeMoviesFileName = extracted.moviesName }
                if let s = extracted.series { tvTimeSeriesCsv = s; tvTimeSeriesFileName = extracted.seriesName }
                tvTimeEpisodeVotesCsv = extracted.episodeVotes ?? ""
                tvTimeMovieRatingsCsv = extracted.movieRatings ?? ""
                tvTimeMovieVotesCsv = extracted.movieVotes ?? ""
                tvTimeMovieCommentsCsv = extracted.movieComments ?? ""
                tvTimeEpisodeCommentsCsv = extracted.episodeComments ?? ""
                tvTimeListsCsv = extracted.lists ?? ""
                tvTimeShowRatingsCsv = extracted.showRatings ?? ""
            case .refract:
                if let m = extracted.movies { tvTimeRefractMoviesJson = m; tvTimeRefractMoviesFileName = extracted.moviesName }
                if let s = extracted.series { tvTimeRefractSeriesJson = s; tvTimeRefractSeriesFileName = extracted.seriesName }
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    // Oltre questa soglia (byte UTF-8 del CSV grezzo) il body callable
    // sfonderebbe il limite 1MB del doc Firestore → trasporto via Storage.
    // Tenuto sotto la guardia server (900KB) con margine.
    private static let importInlineMaxBytes = 700 * 1024

    private func startNetflixImport() async {
        guard !selectedCsv.isEmpty else { return }
        isImporting = true
        errorMessage = nil
        defer { isImporting = false }

        do {
            let started: TitlesImportJob
            if selectedCsv.utf8.count > Self.importInlineMaxBytes {
                let session = try await container.titlesImportRepository.createImportUploadSession(
                    source: "netflix_csv",
                    fileFlags: ["hasNetflix": !selectedCsv.isEmpty],
                    options: options
                )
                try await container.titlesImportRepository.uploadImportFiles(
                    storagePaths: session.storagePaths,
                    texts: ["netflix": selectedCsv]
                )
                started = try await container.titlesImportRepository.finalizeImportUpload(importId: session.importId)
            } else {
                started = try await container.titlesImportRepository.startNetflixImport(
                    rawCsv: selectedCsv,
                    options: options
                )
            }
            job = started
            observe(importID: started.id)
            await offerPushPromptAfterImportStart()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func startTvTimeImport() async {
        guard !tvTimeMoviesCsv.isEmpty || !tvTimeSeriesCsv.isEmpty else { return }
        isImporting = true
        errorMessage = nil
        defer { isImporting = false }

        do {
            // File extra dell'export GDPR (voti/emozioni/commenti/liste):
            // presenti solo se estratti dallo ZIP. Chiavi allineate al server
            // (normalizeManualImportFileKinds / storagePaths in
            // functions/lib/importAdapters/tvTimeRefractStandby.js).
            let extras: [(kind: String, flag: String, text: String)] = [
                ("episodeVotes", "hasEpisodeVotes", tvTimeEpisodeVotesCsv),
                ("movieRatings", "hasMovieRatings", tvTimeMovieRatingsCsv),
                ("movieVotes", "hasMovieVotes", tvTimeMovieVotesCsv),
                ("movieComments", "hasMovieComments", tvTimeMovieCommentsCsv),
                ("episodeComments", "hasEpisodeComments", tvTimeEpisodeCommentsCsv),
                ("lists", "hasLists", tvTimeListsCsv),
                ("showRatings", "hasShowRatings", tvTimeShowRatingsCsv),
            ].filter { !$0.text.isEmpty }

            let combinedBytes = tvTimeMoviesCsv.utf8.count + tvTimeSeriesCsv.utf8.count
                + extras.reduce(0) { $0 + $1.text.utf8.count }
            let started: TitlesImportJob
            // La sorgente inline gestisce solo film+serie: se ci sono file extra
            // (o la libreria è grande) si passa al trasporto via Storage, che
            // carica e processa tutti i file come fa il web.
            if combinedBytes > Self.importInlineMaxBytes || !extras.isEmpty {
                var fileFlags: [String: Bool] = [
                    "hasMovies": !tvTimeMoviesCsv.isEmpty,
                    "hasSeries": !tvTimeSeriesCsv.isEmpty,
                ]
                var texts: [String: String] = [
                    "movies": tvTimeMoviesCsv,
                    "series": tvTimeSeriesCsv,
                ]
                for e in extras {
                    fileFlags[e.flag] = true
                    texts[e.kind] = e.text
                }
                let session = try await container.titlesImportRepository.createImportUploadSession(
                    source: "tvtime_gdpr",
                    fileFlags: fileFlags,
                    options: options
                )
                try await container.titlesImportRepository.uploadImportFiles(
                    storagePaths: session.storagePaths,
                    texts: texts
                )
                started = try await container.titlesImportRepository.finalizeImportUpload(importId: session.importId)
            } else {
                started = try await container.titlesImportRepository.startTvTimeImport(
                    rawCsvV1: tvTimeMoviesCsv,
                    rawCsvV2: tvTimeSeriesCsv,
                    options: options
                )
            }
            job = started
            observe(importID: started.id)
            await offerPushPromptAfterImportStart()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Refract ("TV Time Out"): sessione di upload diretto a Storage in 3
    /// passi (crea sessione -> upload JSON -> finalizza). `finalizeImportUpload`
    /// ora ACCODA il matching resumabile e ritorna `{status:"queued"}`; lo
    /// stato finale arriva dal listener (observeImport), come per gli altri
    /// trasporti.
    private func startTvTimeRefractImport() async {
        guard !tvTimeRefractMoviesJson.isEmpty || !tvTimeRefractSeriesJson.isEmpty else { return }
        isImporting = true
        errorMessage = nil
        defer { isImporting = false }

        do {
            let session = try await container.titlesImportRepository.createImportUploadSession(
                source: "tvtime_refract",
                fileFlags: [
                    "hasMovies": !tvTimeRefractMoviesJson.isEmpty,
                    "hasSeries": !tvTimeRefractSeriesJson.isEmpty
                ],
                options: options
            )
            try await container.titlesImportRepository.uploadImportFiles(
                storagePaths: session.storagePaths,
                texts: ["movies": tvTimeRefractMoviesJson, "series": tvTimeRefractSeriesJson]
            )
            let started = try await container.titlesImportRepository.finalizeImportUpload(importId: session.importId)
            job = started
            observe(importID: started.id)
            await offerPushPromptAfterImportStart()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Avvia (o riavvia) il device flow Trakt: chiede un nuovo `userCode` al
    /// server e poi poll `pollTraktConnect` ogni `interval` secondi finché non
    /// arriva un esito terminale o scade `expiresIn`. Il poll gira su un Task
    /// cancellabile (chiusura sheet / dismiss / nuova sessione).
    private func beginTraktConnect() async {
        traktPollTask?.cancel()
        traktPhase = .starting

        do {
            let connectSession = try await container.titlesImportRepository.startTraktConnect()
            traktPhase = .awaitingAuthorization(connectSession)

            traktPollTask = Task {
                let deadline = Date().addingTimeInterval(TimeInterval(connectSession.expiresIn))
                let interval = max(1, connectSession.interval)

                while !Task.isCancelled && Date() < deadline {
                    try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
                    if Task.isCancelled { return }

                    do {
                        let status = try await container.titlesImportRepository.pollTraktConnect()
                        guard !Task.isCancelled else { return }
                        switch status {
                        case .connected:
                            traktPhase = .connected
                            return
                        case .expired:
                            traktPhase = .expired
                            return
                        case .denied:
                            traktPhase = .denied
                            return
                        case .pending, .none:
                            continue
                        }
                    } catch {
                        // Errore di rete transitorio durante il poll: continua a
                        // riprovare finché non scade il device code.
                        continue
                    }
                }

                if !Task.isCancelled, traktPhase.isAwaitingAuthorization {
                    traktPhase = .expired
                }
            }
        } catch {
            isTraktConnectSheetPresented = false
            errorMessage = UserFacingError.message(for: error)
            traktPhase = .idle
        }
    }

    private func startTraktImport() async {
        isStartingTraktImport = true
        errorMessage = nil
        defer { isStartingTraktImport = false }

        do {
            let started = try await container.titlesImportRepository.startTraktImport(options: options)
            job = started
            observe(importID: started.id)
            await offerPushPromptAfterImportStart()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    /// Pre-prompt push soft dopo l'avvio di un import (uno dei momenti di
    /// valore più alto: l'utente ha appena investito tempo caricando i file
    /// e vuole sapere quando è pronto). Stesso gate one-time di
    /// `PushPromptService` usato post-onboarding in RootView — se l'utente
    /// l'ha già visto lì (o altrove), non ricompare qui.
    private func offerPushPromptAfterImportStart() async {
        guard !container.pushPromptService.hasSeenPrompt else { return }
        let status = await container.pushNotifications.currentAuthorizationStatus()
        guard container.pushPromptService.shouldOfferPrompt(currentStatus: status) else { return }
        try? await Task.sleep(nanoseconds: 400_000_000)
        isPushPromptPresented = true
    }

    private func observe(importID: String) {
        guard let uid = session.firebaseUser?.uid else { return }
        listener?.remove()
        listener = container.titlesImportRepository.observeImport(userID: uid, importID: importID) { next in
            if let next {
                applyJobUpdate(next)
            }
        }
    }

    /// Punto unico di scrittura di `job`: rileva la TRANSIZIONE di stato
    /// (non lo stato assoluto) per loggare `importCompleted`/`importFailed`
    /// una volta sola, sia che arrivino dal listener Firestore sia dal merge
    /// locale post-`confirmImport` (vedi `performConfirm`) — senza questo,
    /// entrambi i percorsi che scrivono `job` rischierebbero un doppio log.
    private func applyJobUpdate(_ next: TitlesImportJob) {
        let previousStatus = job?.status
        job = next
        if previousStatus != "completed", next.status == "completed" {
            container.analytics.log(AnalyticsEvent.importCompleted, [
                "source": next.source ?? "",
                "platform": "ios",
                "matched": bucketCount(next.importedTitleCount),
                "skipped": bucketCount(next.skippedCount)
            ])
        }
        if previousStatus != "failed", next.status == "failed" {
            container.analytics.log(AnalyticsEvent.importFailed, [
                "source": next.source ?? "",
                "platform": "ios"
            ])
        }
    }

    /// Bucket dei conteggi per gli eventi analytics (mai un numero esatto
    /// come prop libera): fasce allineate 1:1 al bucketing web.
    private func bucketCount(_ n: Int) -> String {
        if n <= 0 { return "0" }
        if n < 10 { return "1_9" }
        if n < 50 { return "10_49" }
        if n < 200 { return "50_199" }
        if n < 1000 { return "200_999" }
        return "1000_plus"
    }

    private func enablePush() async {
        _ = await container.pushNotifications.requestAuthorizationFromUser()
        pushStatus = await container.pushNotifications.currentAuthorizationStatus()
    }

    /// Stati in cui il job macina da solo e non serve l'utente. Gli altri
    /// (`awaiting_confirmation`, `completed`, `failed`) vogliono un'azione, e
    /// lì il rimando allo step successivo dell'onboarding non va offerto.
    private func isJobRunning(_ status: String) -> Bool {
        ["uploading", "queued", "matching", "manual_processing"].contains(status)
    }

    /// Onboarding: l'import è partito e macina. Invece di lasciare l'utente a
    /// fissare una barra di progresso, lo rimandiamo agli step — che è il senso
    /// dell'import-first (`docs/ONBOARDING_V2.md`).
    private var onboardingHandoffCard: some View {
        GlassCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                Text("L'import va avanti da solo")
                    .font(.headline)
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text("Non serve restare qui: ti avvisiamo appena la tua libreria è pronta.")
                    .font(.footnote)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                Button("Continua a preparare Somto") {
                    onboardingHandoff?()
                }
                .buttonStyle(PrimaryButtonStyle())
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func statusTitle(_ status: String) -> String {
        switch status {
        case "uploading":
            return "Caricamento in corso"
        case "queued":
            return "Import in coda"
        case "matching":
            return "Importazione in corso"
        case "awaiting_confirmation":
            return "Import quasi pronto"
        case "manual_processing":
            return "File ricevuti"
        case "completed":
            return "Import completato"
        case "failed":
            return String(localized: "Import non riuscito")
        default:
            return "Import in corso"
        }
    }

    private func statusSubtitle(_ job: TitlesImportJob) -> String {
        switch job.status {
        case "uploading":
            return "Stiamo caricando i tuoi file in modo sicuro."
        case "queued":
            return String(localized: "Abbiamo ricevuto il file, ci pensiamo noi: non serve ricaricarlo. Puoi lasciare lavorare Somto in background.")
        case "matching":
            return String(localized: "Stiamo abbinando i titoli al catalogo Somto. Non serve ricaricare il file.")
        case "awaiting_confirmation":
            return "\(job.matchedCount) titoli aggiornati. Alcune voci richiedono un controllo."
        case "manual_processing":
            return String(localized: "Abbiamo riconosciuto l'export Refract di TV Time. Lo stiamo elaborando manualmente: ti avvisiamo appena il profilo è aggiornato.")
        case "completed":
            return "\(job.matchedCount) titoli aggiornati nella tua libreria."
        case "failed":
            return String(localized: "Non siamo riusciti a completare l'elaborazione.")
        default:
            return String(localized: "Puoi chiudere questa schermata e tornare più tardi.")
        }
    }

    private func statusIcon(_ status: String) -> String {
        switch status {
        case "uploading":
            return "arrow.up.circle.fill"
        case "queued":
            return "tray.and.arrow.down.fill"
        case "matching":
            return "hourglass"
        case "awaiting_confirmation":
            return "questionmark.circle.fill"
        case "manual_processing":
            return "person.crop.circle.badge.checkmark"
        case "completed":
            return "checkmark.circle.fill"
        case "failed":
            return "exclamationmark.triangle.fill"
        default:
            return "square.and.arrow.down.fill"
        }
    }

    private func statusTint(_ status: String) -> Color {
        switch status {
        case "completed":
            return TwoWatchTheme.success
        case "failed":
            return TwoWatchTheme.warning
        default:
            return TwoWatchTheme.brandPrimary
        }
    }
}

/// Wrapper `Identifiable` per presentare il thread di supporto come sheet
/// locale via `.sheet(item:)`.
private struct SupportThreadPresentation: Identifiable {
    let id: String
}

/// Wrapper `Identifiable` per presentare il fallback web "Continua dal sito"
/// come sheet locale via `.sheet(item:)` (stesso pattern del thread supporto).
private struct WebImportFallbackPresentation: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}
