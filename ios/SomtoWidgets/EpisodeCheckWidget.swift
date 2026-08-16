import AppIntents
import SwiftUI
import WidgetKit

// Il widget "Segna episodio": una serie, il punto in cui sei, un bottone.
//
// E' l'unico posto di Somto dove si SCRIVE da fuori dall'app. Come ci arriva la
// scrittura sta in `WidgetAuthBridge.swift`: l'app deposita in un keychain
// condiviso il refresh token, qui lo si scambia per un id token e si chiama la
// stessa callable che usa l'app (`applyTitleStateAction`). Nessun SDK Firebase
// dentro l'estensione, quindi niente gRPC nel processo con meno memoria di tutti.
//
// PERCHE' NON E' L'App Intent CHE SI ERA ROTTO — `AddToWatchlistIntent` moriva
// PRIMA di `perform()`, nel bootstrap headless di Firebase (vedi
// docs/PENDING.md). Qui di bootstrap non ce n'e': due richieste HTTPS e basta.

// MARK: - La serie scelta

/// La serie che il widget segue. L'elenco arriva dal riassunto nell'App Group,
/// quindi scegliere una serie non fa una sola richiesta di rete.
struct SeriesEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Serie" }
    /// `let` e non `var`: sotto la concorrenza stretta di Swift 6 una `static
    /// var` e' stato globale mutabile, e non compila.
    static let defaultQuery = SeriesEntityQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct SeriesEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [SeriesEntity] {
        Self.selectableSeries().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [SeriesEntity] {
        Self.selectableSeries()
    }

    /// Senza scelta il widget segue la serie in corso piu' recente: appena
    /// aggiunto mostra qualcosa invece di un riquadro da configurare.
    func defaultResult() async -> SeriesEntity? {
        Self.selectableSeries().first
    }

    /// Le serie che si possono scegliere: prima quelle in corso, poi quelle in
    /// watchlist mai iniziate.
    ///
    /// Anche le seconde, e non e' un di piu': su una serie non iniziata il
    /// bottone segna il primo episodio, che e' un'azione legittima. Alla prova
    /// sul device l'elenco ne mostrava cinque — erano esattamente le serie in
    /// corso, ma chi guarda vede la sua watchlist e si aspetta di trovarci
    /// quello che c'e' dentro.
    ///
    /// I film restano fuori: "episodio successivo" su un film non vuol dire
    /// niente.
    static func selectableSeries() -> [SeriesEntity] {
        (WatchlistWidgetSnapshotStore.read()?.rows ?? [])
            .filter { $0.isSeries }
            .sorted { left, right in
                (left.kind == .inProgress ? 0 : 1) < (right.kind == .inProgress ? 0 : 1)
            }
            .map { SeriesEntity(id: $0.id, name: $0.name) }
    }
}

struct SelectSeriesIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Scegli la serie" }
    static var description: IntentDescription { IntentDescription("La serie che il widget segue.") }

    @Parameter(title: "Serie")
    var series: SeriesEntity?

    init() {}

    init(series: SeriesEntity?) {
        self.series = series
    }
}

// MARK: - Il bottone

/// Segna come visto l'episodio successivo di una serie.
///
/// Fa esattamente cio' che fa il bottone dentro l'app: la callable
/// `applyTitleStateAction` con `mark_series_episode`. `source: "widget"` perche'
/// da dove arriva un'azione e' un dato che l'app gia' registra, e un giorno
/// dira' se questo widget lo usa qualcuno.
struct MarkEpisodeWatchedIntent: AppIntent {
    static var title: LocalizedStringResource { "Segna episodio visto" }
    /// Il senso del widget e' non aprire l'app.
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Titolo")
    var titleId: String

    init() {
        titleId = ""
    }

    init(titleId: String) {
        self.titleId = titleId
    }

    func perform() async throws -> some IntentResult {
        let trimmed = titleId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .result() }

        // Il secondo tap mentre il primo e' in volo non parte. Non e' una
        // finezza: segnerebbe DUE episodi, e chi lo fa lo fa proprio perche'
        // crede che il primo non sia servito a niente.
        guard !WatchlistWidgetPendingStore.isInFlight(trimmed) else { return .result() }
        WatchlistWidgetPendingStore.set(.inFlight, for: trimmed)

        do {
            let result = try await WidgetCallableClient.call(
                name: "applyTitleStateAction",
                data: ["titleId": trimmed, "action": "mark_series_episode", "source": "widget"]
            )
            // Il server risponde con lo stato aggiornato: si prende quello. Cosi'
            // il widget mostra il punto NUOVO e il bottone e' subito pronto per
            // l'episodio dopo, invece di restare su una conferma da guardare.
            let progress = (result["state"] as? [String: Any])?["seriesProgress"] as? [String: Any]
            WatchlistWidgetSnapshotStore.applyProgress(
                titleId: trimmed,
                episodesWatched: progress?["episodesWatchedCount"] as? Int,
                season: progress?["lastWatchedSeasonNumber"] as? Int,
                episode: progress?["lastWatchedEpisodeNumber"] as? Int
            )
            WatchlistWidgetPendingStore.remove(trimmed)
        } catch {
            // Un errore qui non ha dove andare: non c'e' schermata, non c'e'
            // avviso. Diventa uno stato del widget, che e' l'unica cosa onesta
            // da dire a chi ha toccato un bottone e non sa se e' successo
            // qualcosa.
            WatchlistWidgetPendingStore.set(.failed, for: trimmed)
        }

        WidgetCenter.shared.reloadTimelines(ofKind: WatchlistWidgetSnapshotStore.episodeWidgetKind)
        WidgetCenter.shared.reloadTimelines(ofKind: WatchlistWidgetSnapshotStore.widgetKind)
        return .result()
    }
}

/// Porta una serie in testa al widget grande.
///
/// PERCHE' UN INTENT E NON LA CONFIGURAZIONE — cambiare serie da "Modifica
/// widget" e' una strada che non trova nessuno (constatato sul device). Qui il
/// cambio e' un tap sulla miniatura: nessuna rete, nessuna app che si apre, si
/// scrive quale serie comanda e si ridisegna.
struct PinSeriesIntent: AppIntent {
    static var title: LocalizedStringResource { "Porta la serie in testa" }
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Titolo")
    var titleId: String

    init() {
        titleId = ""
    }

    init(titleId: String) {
        self.titleId = titleId
    }

    func perform() async throws -> some IntentResult {
        let trimmed = titleId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .result() }
        WatchlistWidgetSelectionStore.set(trimmed)
        WidgetCenter.shared.reloadTimelines(ofKind: WatchlistWidgetSnapshotStore.widgetKind)
        WidgetCenter.shared.reloadTimelines(ofKind: WatchlistWidgetSnapshotStore.episodeWidgetKind)
        return .result()
    }
}

// MARK: - Widget

struct EpisodeCheckWidget: Widget {
    static let kind = WatchlistWidgetSnapshotStore.episodeWidgetKind

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: SelectSeriesIntent.self, provider: EpisodeCheckProvider()) { entry in
            EpisodeCheckWidgetView(entry: entry)
                .containerBackground(for: .widget) { TwoWatchTheme.screenGradient }
        }
        .configurationDisplayName("Segna episodio")
        .description("Scegli una serie: dal widget segni l'episodio appena visto.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Timeline

struct EpisodeCheckEntry: TimelineEntry {
    enum State: Sendable {
        case series(EpisodeCheckRow)
        /// Nessuna serie in corso, o nessun riassunto: in entrambi i casi non
        /// c'e' niente da segnare.
        case nothingToTrack
        case missing
    }

    let date: Date
    let state: State
}

struct EpisodeCheckRow: Sendable {
    let id: String
    let name: String
    let season: Int?
    let episode: Int?
    let episodesWatched: Int?
    let episodesTotal: Int?
    let pending: WatchlistWidgetPendingEntry?
    let deepLink: URL
    let posterData: Data?
}

struct EpisodeCheckProvider: AppIntentTimelineProvider {
    /// Il contenuto cambia quando l'app riscrive il riassunto o quando si tocca
    /// il bottone: entrambe le cose svegliano il widget da sole. Il risveglio
    /// periodico e' solo una rete di sicurezza.
    private static let refreshInterval: TimeInterval = 6 * 60 * 60
    private static let siteURL = "https://somto.it"

    func placeholder(in context: Context) -> EpisodeCheckEntry {
        EpisodeCheckEntry(date: Date(), state: .series(Self.placeholderRow()))
    }

    func snapshot(for configuration: SelectSeriesIntent, in context: Context) async -> EpisodeCheckEntry {
        if context.isPreview {
            return EpisodeCheckEntry(date: Date(), state: .series(Self.placeholderRow()))
        }
        return await Self.makeEntry(for: configuration)
    }

    func timeline(for configuration: SelectSeriesIntent, in context: Context) async -> Timeline<EpisodeCheckEntry> {
        let entry = await Self.makeEntry(for: configuration)
        return Timeline(
            entries: [entry],
            policy: .after(entry.date.addingTimeInterval(Self.refreshInterval))
        )
    }

    private static func makeEntry(for configuration: SelectSeriesIntent) async -> EpisodeCheckEntry {
        let now = Date()
        guard let snapshot = WatchlistWidgetSnapshotStore.read() else {
            return EpisodeCheckEntry(date: now, state: .missing)
        }

        let series = snapshot.rows.filter(\.isSeries)
        // La serie configurata, se c'e' ancora: una serie finita esce dal
        // riassunto, e il widget deve ripiegare invece di restare vuoto.
        // Ordine di precedenza: l'ultima toccata col cambio rapido, poi quella
        // configurata a mano, poi la prima in corso. Il tap e' piu' recente
        // della configurazione, quindi comanda.
        let pinned = WatchlistWidgetSelectionStore.read().flatMap { id in
            series.first { $0.id == id }
        }
        let chosen = pinned
            ?? configuration.series.flatMap { selected in series.first { $0.id == selected.id } }
            ?? series.first { $0.kind == .inProgress }
            ?? series.first

        guard let chosen, let deepLink = URL(string: "\(siteURL)\(chosen.path)") else {
            return EpisodeCheckEntry(date: now, state: .nothingToTrack)
        }

        let posterData: Data?
        if let posterUrl = chosen.posterUrl {
            posterData = await UpcomingReleasesFeedLoader.loadImageData(for: posterUrl)
        } else {
            posterData = nil
        }

        return EpisodeCheckEntry(date: now, state: .series(EpisodeCheckRow(
            id: chosen.id,
            name: chosen.name,
            season: chosen.season,
            episode: chosen.episode,
            episodesWatched: chosen.episodesWatched,
            episodesTotal: chosen.episodesTotal,
            pending: WatchlistWidgetPendingStore.read()[chosen.id],
            deepLink: deepLink,
            posterData: posterData
        )))
    }

    private static func placeholderRow() -> EpisodeCheckRow {
        EpisodeCheckRow(
            id: "placeholder",
            name: String(localized: "Serie in corso"),
            season: nil,
            episode: nil,
            episodesWatched: nil,
            episodesTotal: nil,
            pending: nil,
            deepLink: URL(string: siteURL) ?? URL(fileURLWithPath: "/"),
            posterData: nil
        )
    }
}

// MARK: - Vista

struct EpisodeCheckWidgetView: View {
    let entry: EpisodeCheckEntry

    var body: some View {
        switch entry.state {
        case let .series(row):
            EpisodeCheckContentView(row: row)
        case .nothingToTrack:
            WidgetMessageView(
                title: "Segna episodio",
                message: "Nessuna serie in watchlist. Aggiungine una in Somto.",
                opensGuide: true
            )
        case .missing:
            WidgetMessageView(
                title: "Segna episodio",
                message: "Apri Somto per caricare la tua watchlist.",
                opensGuide: true
            )
        }
    }
}

private struct EpisodeCheckContentView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .headline) private var posterWidth: CGFloat = 44

    let row: EpisodeCheckRow

    private var showsPoster: Bool { !dynamicTypeSize.isAccessibilitySize && family != .systemSmall }

    var body: some View {
        VStack(alignment: .leading, spacing: SomtoSpacing.s) {
            WidgetSectionHeader(title: "Segna episodio")

            HStack(alignment: .top, spacing: SomtoSpacing.ml) {
                if showsPoster {
                    WidgetPosterView(data: row.posterData, isSeries: true, width: posterWidth)
                }

                VStack(alignment: .leading, spacing: SomtoSpacing.xs) {
                    // Il nome apre la scheda, il bottone segna: due bersagli
                    // diversi nello stesso riquadro, ognuno con il suo gesto.
                    Link(destination: row.deepLink) {
                        Text(row.name)
                            .font(family == .systemSmall ? .subheadline : .headline)
                            .fontWeight(.semibold)
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                    }

                    Text(row.statusLabel)
                        .font(.caption)
                        .foregroundStyle(row.statusColor)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }

                Spacer(minLength: 0)
            }

            Spacer(minLength: 0)

            EpisodeCheckButton(row: row)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Il bottone, che c'e' sempre.
///
/// La prima versione dopo un tap diventava una conferma e spariva: sul device
/// il risultato era che l'episodio dopo non si poteva segnare, e bisognava
/// aprire l'app per rivedere il bottone. Ora il tap aggiorna il numero e il
/// bottone resta pronto per l'episodio successivo — mentre il doppio tap
/// accidentale lo ferma la guardia dentro l'intent, non l'UI.
private struct EpisodeCheckButton: View {
    let row: EpisodeCheckRow

    var body: some View {
        Button(intent: MarkEpisodeWatchedIntent(titleId: row.id)) {
            Label(row.buttonLabel, systemImage: "checkmark")
                .font(.caption)
                .fontWeight(.semibold)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .padding(.vertical, SomtoSpacing.s)
        }
        .buttonStyle(.plain)
        .foregroundStyle(TwoWatchTheme.textPrimary)
        .background(TwoWatchTheme.brandPrimary.opacity(0.22), in: RoundedRectangle(cornerRadius: SomtoRadius.s, style: .continuous))
    }
}

// MARK: - Copy

extension EpisodeCheckRow {
    /// La riga sotto al nome: dove sei.
    ///
    /// Dopo un tap riuscito il numero e' gia' quello nuovo (lo aggiorna
    /// l'intent con la risposta del server), quindi non serve nessuna conferma
    /// tipo "aggiornato": la conferma e' il numero cambiato. Resta solo da dire
    /// quando NON e' andata.
    var statusLabel: LocalizedStringKey {
        if pending?.state == .failed {
            return "Non riuscito, riprova"
        }
        if let season, let episode, season > 0, episode > 0 {
            return "Sei a S\(season)·E\(episode)"
        }
        if let episodesWatched, let episodesTotal, episodesTotal > 0 {
            return "\(episodesWatched)/\(episodesTotal) episodi"
        }
        return "In corso"
    }

    /// "Riprova" invece di "Episodio visto" quando l'ultimo tap non e' andato:
    /// e' la stessa azione, ma dice che si sta ritentando.
    var buttonLabel: LocalizedStringKey {
        pending?.state == .failed ? "Riprova" : "Episodio visto"
    }

    var statusColor: Color {
        pending?.state == .failed ? TwoWatchTheme.textSecondary : TwoWatchTheme.brandPrimary
    }
}
