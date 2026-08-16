import SwiftUI
import WidgetKit

// Il widget "Watchlist": dove sei rimasto, e cosa c'e' dopo.
//
// NON PARLA CON FIREBASE, e qui non e' nemmeno una scelta di peso come per le
// prossime uscite: questi sono dati dell'utente, e in un'estensione non c'e'
// modo di autenticarsi (keychain non condiviso). Legge il riassunto che l'app
// lascia in un App Group — il perche' e il prezzo stanno in
// `WatchlistWidgetSnapshot.swift`.
//
// SOLO VISTA, nessun bottone: un bottone in un widget e' un App Intent, e
// segnare un episodio da li' vorrebbe dire scrivere su Firestore da un processo
// che non ha una sessione. Quello resta il widget dopo (docs/PENDING.md).

// MARK: - Widget

struct WatchlistWidget: Widget {
    static let kind = WatchlistWidgetSnapshotStore.widgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: WatchlistWidgetProvider()) { entry in
            WatchlistWidgetView(entry: entry)
                .containerBackground(for: .widget) { TwoWatchTheme.screenGradient }
        }
        .configurationDisplayName("La tua watchlist")
        .description("Le serie che stai guardando e cosa viene dopo.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Timeline

struct WatchlistWidgetEntry: TimelineEntry {
    enum State: Sendable {
        case rows([WatchlistWidgetRow])
        /// Watchlist vuota: l'app c'e' ed e' passata di qui, non c'e' niente da
        /// mostrare.
        case empty
        /// Nessun riassunto: l'app non e' mai stata aperta dopo l'accesso,
        /// oppure si e' usciti. Non e' un errore, ed e' l'unico caso in cui il
        /// widget chiede qualcosa a chi guarda.
        case missing
    }

    let date: Date
    let state: State
}

/// Una riga pronta da disegnare: come nel widget delle uscite, i byte della
/// locandina viaggiano dentro la timeline perche' la View non puo' fare rete.
struct WatchlistWidgetRow: Identifiable, Sendable {
    let id: String
    let name: String
    let isSeries: Bool
    let kind: WatchlistWidgetSnapshot.Row.Kind
    let season: Int?
    let episode: Int?
    let episodesWatched: Int?
    let episodesTotal: Int?
    let percentComplete: Double?
    let episodeMinutes: Int?
    let providerName: String?
    let providerLogoData: Data?
    /// Dove si guarda davvero: il link diretto se la fonte ce l'ha, altrimenti
    /// la ricerca dentro l'app della piattaforma. `nil` = non lo sappiamo, e il
    /// tasto non compare invece di promettere un salto che non avviene.
    let watchUrl: URL?
    let deepLink: URL
    let posterData: Data?
}

struct WatchlistWidgetProvider: TimelineProvider {
    /// Il riassunto lo cambia l'app, non il tempo: qui non si "scade" niente.
    /// Il risveglio ogni sei ore e' solo una rete di sicurezza per il caso in
    /// cui la sveglia di `reloadTimelines` si perda (app terminata dal sistema
    /// mentre scriveva, per esempio).
    private static let refreshInterval: TimeInterval = 6 * 60 * 60
    private static let siteURL = "https://somto.it"

    func placeholder(in context: Context) -> WatchlistWidgetEntry {
        WatchlistWidgetEntry(date: Date(), state: .rows(Self.placeholderRows()))
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (WatchlistWidgetEntry) -> Void) {
        if context.isPreview {
            completion(WatchlistWidgetEntry(date: Date(), state: .rows(Self.placeholderRows())))
            return
        }
        let family = context.family
        Task { completion(await Self.makeEntry(for: family)) }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<WatchlistWidgetEntry>) -> Void) {
        let family = context.family
        Task {
            let entry = await Self.makeEntry(for: family)
            completion(Timeline(
                entries: [entry],
                policy: .after(entry.date.addingTimeInterval(Self.refreshInterval))
            ))
        }
    }

    // MARK: - Costruzione dell'entry

    private static func makeEntry(for family: WidgetFamily) async -> WatchlistWidgetEntry {
        let now = Date()
        guard let snapshot = WatchlistWidgetSnapshotStore.read() else {
            return WatchlistWidgetEntry(date: now, state: .missing)
        }
        guard !snapshot.rows.isEmpty else {
            return WatchlistWidgetEntry(date: now, state: .empty)
        }

        // Si sceglie PRIMA quali righe servono e poi si scaricano le locandine:
        // ogni poster e' una richiesta, e quelle che non si disegnano sono byte
        // buttati dentro una timeline che il sistema deve archiviare.
        let planned = WatchlistWidgetRowPlan.rows(
            from: pinnedFirst(snapshot.rows),
            rowCount: rowBudget(for: family)
        )
        let rows = await makeRows(from: planned)
        return WatchlistWidgetEntry(date: now, state: rows.isEmpty ? .empty : .rows(rows))
    }

    /// La serie toccata col cambio rapido va in testa.
    ///
    /// Si riordina PRIMA della selezione delle righe, non dopo: se il tap
    /// finisse su una serie che il piano avrebbe tagliato, riordinare dopo non
    /// la farebbe comparire e il tap sembrerebbe ignorato.
    private static func pinnedFirst(_ rows: [WatchlistWidgetSnapshot.Row]) -> [WatchlistWidgetSnapshot.Row] {
        guard let pinned = WatchlistWidgetSelectionStore.read(),
              let index = rows.firstIndex(where: { $0.id == pinned })
        else {
            return rows
        }
        var reordered = rows
        reordered.insert(reordered.remove(at: index), at: 0)
        return reordered
    }

    /// Il tetto per famiglia e' quello massimo: la View poi ne mostra meno se la
    /// dimensione del testo lo impone.
    private static func rowBudget(for family: WidgetFamily) -> Int {
        switch family {
        case .systemSmall: return 1
        case .systemLarge: return WidgetRowLayout.largeRowCount
        default: return WidgetRowLayout.mediumRowCount
        }
    }

    private static func makeRows(from planned: [WatchlistWidgetSnapshot.Row]) async -> [WatchlistWidgetRow] {
        var rows: [WatchlistWidgetRow] = []
        // Le piattaforme si ripetono: tre serie Netflix non sono tre loghi.
        var logosByUrl: [URL: Data] = [:]
        for row in planned {
            guard let deepLink = URL(string: "\(siteURL)\(row.path)") else { continue }
            let posterData: Data?
            if let posterUrl = row.posterUrl {
                posterData = await UpcomingReleasesFeedLoader.loadImageData(for: posterUrl)
            } else {
                posterData = nil
            }
            var logoData: Data?
            if let logoUrl = row.providerLogoUrl {
                if let cached = logosByUrl[logoUrl] {
                    logoData = cached
                } else if let downloaded = await UpcomingReleasesFeedLoader.loadImageData(for: logoUrl) {
                    logosByUrl[logoUrl] = downloaded
                    logoData = downloaded
                }
            }

            rows.append(WatchlistWidgetRow(
                id: row.id,
                name: row.name,
                isSeries: row.isSeries,
                kind: row.kind,
                season: row.season,
                episode: row.episode,
                episodesWatched: row.episodesWatched,
                episodesTotal: row.episodesTotal,
                percentComplete: row.percentComplete,
                episodeMinutes: row.episodeMinutes,
                providerName: row.providerName,
                providerLogoData: logoData,
                // Il widget non decide dove si va: lo chiede al livello unico,
                // lo stesso che usa la scheda titolo.
                watchUrl: StreamingDestinationResolver.destination(
                    providerName: row.providerName ?? "",
                    deepLinks: row.watchUrl.map { [row.providerName ?? "": $0] } ?? [:],
                    titleName: row.name,
                    tmdbId: row.tmdbId,
                    isSeries: row.isSeries
                )?.url,
                deepLink: deepLink,
                posterData: posterData
            ))
        }
        return rows
    }

    /// Righe finte per lo scheletro di sistema e per l'anteprima in galleria.
    /// Nomi neutri: in galleria non si promette una serie che l'utente non ha.
    private static func placeholderRows() -> [WatchlistWidgetRow] {
        guard let fallbackURL = URL(string: siteURL) else { return [] }
        return (0..<WidgetRowLayout.largeRowCount).map { index in
            WatchlistWidgetRow(
                id: "placeholder-\(index)",
                name: String(localized: "Serie in corso"),
                isSeries: true,
                kind: index < WidgetRowLayout.largeRowCount - 1 ? .inProgress : .upNext,
                season: nil,
                episode: nil,
                episodesWatched: nil,
                episodesTotal: nil,
                // Nel segnaposto niente barra, niente piattaforma e niente
                // tasto guarda: in galleria non si promette un salto che con i
                // dati veri potrebbe non esserci.
                percentComplete: nil,
                episodeMinutes: nil,
                providerName: nil,
                providerLogoData: nil,
                watchUrl: nil,
                deepLink: fallbackURL,
                posterData: nil
            )
        }
    }
}

// MARK: - Radice

struct WatchlistWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchlistWidgetEntry

    var body: some View {
        switch entry.state {
        case let .rows(rows):
            if rows.isEmpty {
                WidgetMessageView(title: "La tua watchlist", message: "Non hai ancora niente in watchlist.")
            } else if let first = rows.first, family == .systemSmall {
                WatchlistWidgetSmallView(row: first)
            } else if let first = rows.first, family == .systemLarge {
                // La misura grande non e' un elenco piu' lungo: e' "riprendi da
                // qui". Una serie in evidenza con tutto quel che serve per
                // ripartire, e le altre come miniature da toccare per
                // sostituirla.
                WatchlistWidgetHeroView(hero: first, others: Array(rows.dropFirst()))
            } else {
                WatchlistWidgetListView(rows: rows, isLarge: false)
            }
        case .empty:
            WidgetMessageView(title: "La tua watchlist", message: "Non hai ancora niente in watchlist.")
        case .missing:
            WidgetMessageView(
                title: "La tua watchlist",
                message: "Apri Somto per caricare la tua watchlist.",
                opensGuide: true
            )
        }
    }
}


// MARK: - systemLarge: riprendi da qui

/// La misura grande: una serie in evidenza, e sotto le altre da toccare.
///
/// PERCHE' NON UN ELENCO — cinque righe uguali rispondono a "cosa ho in
/// watchlist"; questa risponde a "cosa riprendo adesso", che e' la domanda che
/// porta qualcuno a mettersi un widget in schermata Home. La serie in testa ha
/// il punto in cui sei, la barra, il tasto per guardare e quello per segnare;
/// le altre stanno sotto come locandine, e un tap le porta in testa — cioe' il
/// cambio serie senza passare da "Modifica widget", che nessuno trova.
private struct WatchlistWidgetHeroView: View {
    @ScaledMetric(relativeTo: .body) private var heroPosterWidth: CGFloat = 74
    @ScaledMetric(relativeTo: .caption) private var thumbWidth: CGFloat = 58
    @ScaledMetric(relativeTo: .caption) private var providerLogoSide: CGFloat = 18

    let hero: WatchlistWidgetRow
    let others: [WatchlistWidgetRow]

    var body: some View {
        VStack(alignment: .leading, spacing: SomtoSpacing.ml) {
            WidgetSectionHeader(title: "Riprendi da qui")

            HStack(alignment: .top, spacing: SomtoSpacing.ml) {
                Link(destination: hero.deepLink) {
                    WidgetPosterView(data: hero.posterData, isSeries: hero.isSeries, width: heroPosterWidth)
                }

                VStack(alignment: .leading, spacing: SomtoSpacing.xs) {
                    Link(destination: hero.deepLink) {
                        Text(hero.name)
                            .font(.headline)
                            .fontWeight(.semibold)
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                    }

                    HStack(spacing: SomtoSpacing.xs) {
                        if let data = hero.providerLogoData, let image = UIImage(data: data) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: providerLogoSide, height: providerLogoSide)
                                .clipShape(RoundedRectangle(cornerRadius: providerLogoSide / 4, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: providerLogoSide / 4, style: .continuous)
                                        .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
                                )
                                .accessibilityHidden(true)
                        }
                        Text(hero.progressLabel)
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }

                    if let percent = hero.percentComplete {
                        WatchlistWidgetProgressBar(percent: percent)
                    }

                    if let minutes = hero.episodeMinutes, minutes > 0 {
                        // Quanto dura un episodio, non "quanto ti manca": Somto
                        // sa quale episodio hai visto, non a che minuto sei
                        // dentro quello dopo.
                        Text("\(minutes) min a episodio")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 0)

                VStack(spacing: SomtoSpacing.m) {
                    if let watchUrl = hero.watchUrl {
                        Link(destination: watchUrl) {
                            WatchlistWidgetCircleIcon(systemName: "play.fill", isProminent: true)
                        }
                        .accessibilityLabel(hero.watchAccessibilityLabel)
                    }
                    if hero.kind == .inProgress || hero.isSeries {
                        Button(intent: MarkEpisodeWatchedIntent(titleId: hero.id)) {
                            WatchlistWidgetCircleIcon(systemName: "checkmark", isProminent: false)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Segna episodio visto")
                    }
                }
            }

            Spacer(minLength: 0)

            if !others.isEmpty {
                Divider().overlay(TwoWatchTheme.border)
                HStack(spacing: SomtoSpacing.m) {
                    ForEach(others.prefix(3)) { row in
                        // Un tap qui porta la serie in testa: e' il cambio
                        // rapido, e non apre l'app.
                        Button(intent: PinSeriesIntent(titleId: row.id)) {
                            VStack(spacing: SomtoSpacing.xs) {
                                WidgetPosterView(data: row.posterData, isSeries: row.isSeries, width: thumbWidth)
                                Text(row.name)
                                    .font(.caption2)
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                                    .frame(width: thumbWidth)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// La barra del progresso. Sottile e in due toni: dice a colpo d'occhio se sei
/// all'inizio o alla fine, che un "12/24" non dice altrettanto in fretta.
private struct WatchlistWidgetProgressBar: View {
    let percent: Double

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(TwoWatchTheme.panelStrong)
                Capsule()
                    .fill(TwoWatchTheme.brandPrimary)
                    .frame(width: max(3, geometry.size.width * max(0, min(1, percent))))
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

private struct WatchlistWidgetCircleIcon: View {
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 40

    let systemName: String
    let isProminent: Bool

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: side * 0.36, weight: .bold))
            .foregroundStyle(isProminent ? TwoWatchTheme.textPrimary : TwoWatchTheme.brandPrimary)
            .frame(width: side, height: side)
            .background(
                Circle().fill(
                    isProminent
                        ? TwoWatchTheme.brandPrimary.opacity(0.9)
                        : TwoWatchTheme.brandPrimary.opacity(0.16)
                )
            )
    }
}

// MARK: - systemMedium

private struct WatchlistWidgetListView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let rows: [WatchlistWidgetRow]
    let isLarge: Bool

    private var headerSpacing: CGFloat { isLarge ? SomtoSpacing.xxl : SomtoSpacing.m }
    private var rowSpacing: CGFloat { isLarge ? SomtoSpacing.ml : SomtoSpacing.s }

    private var visibleRows: [WatchlistWidgetRow] {
        Array(rows.prefix(WidgetRowLayout.rowCount(isLarge: isLarge, dynamicTypeSize: dynamicTypeSize)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: headerSpacing) {
            WidgetSectionHeader(title: "La tua watchlist")

            VStack(alignment: .leading, spacing: rowSpacing) {
                ForEach(visibleRows) { row in
                    // Una riga = un titolo = un tap, come nel widget delle
                    // uscite: si apre la scheda, non la home.
                    Link(destination: row.deepLink) {
                        WatchlistWidgetRowView(row: row, isLarge: isLarge)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WatchlistWidgetRowView: View {
    @ScaledMetric(relativeTo: .subheadline) private var compactPosterWidth: CGFloat = 26
    @ScaledMetric(relativeTo: .body) private var comfortablePosterWidth: CGFloat = 30

    let row: WatchlistWidgetRow
    let isLarge: Bool

    private var posterWidth: CGFloat { isLarge ? comfortablePosterWidth : compactPosterWidth }
    private var nameFont: Font { isLarge ? .body : .subheadline }

    var body: some View {
        HStack(spacing: SomtoSpacing.ml) {
            WidgetPosterView(data: row.posterData, isSeries: row.isSeries, width: posterWidth)

            VStack(alignment: .leading, spacing: isLarge ? SomtoSpacing.xxs : 0) {
                Text(row.name)
                    .font(nameFont)
                    .fontWeight(.semibold)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                Text(row.progressLabel)
                    .font(.caption)
                    .foregroundStyle(row.kind == .inProgress ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - systemSmall

private struct WatchlistWidgetSmallView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .headline) private var posterWidth: CGFloat = 54

    let row: WatchlistWidgetRow

    private var showsPoster: Bool { !dynamicTypeSize.isAccessibilitySize }

    var body: some View {
        VStack(alignment: .leading, spacing: SomtoSpacing.m) {
            WidgetSectionHeader(title: "La tua watchlist")

            HStack(alignment: .top, spacing: SomtoSpacing.ml) {
                if showsPoster {
                    WidgetPosterView(data: row.posterData, isSeries: row.isSeries, width: posterWidth)
                }

                VStack(alignment: .leading, spacing: SomtoSpacing.xs) {
                    Text(row.name)
                        .font(.headline)
                        .fontWeight(.semibold)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    Text(row.progressLabel)
                        .font(.caption)
                        .foregroundStyle(row.kind == .inProgress ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }

                Spacer(minLength: 0)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(row.deepLink)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Copy

extension WatchlistWidgetRow {
    /// Per VoiceOver il tasto play deve dire DOVE porta: un'icona sola non lo
    /// dice, e qui si esce dall'app.
    var watchAccessibilityLabel: Text {
        guard let providerName else { return Text("Guarda") }
        return Text("Guarda su \(providerName)")
    }

    /// La riga sotto al nome.
    ///
    /// "Sei a S3·E7" e' la stessa frase che la Home usa per la stessa cosa
    /// (`HomeView.resumeLabel`): un concetto, una formulazione. Quando il numero
    /// di episodio non c'e' si ripiega sul conteggio, e in ultimo su "In corso"
    /// — mai su una riga vuota, che sembrerebbe un dato perso.
    var progressLabel: LocalizedStringKey {
        guard kind == .inProgress else { return "Da guardare" }
        if let season, let episode, season > 0, episode > 0 {
            return "Sei a S\(season)·E\(episode)"
        }
        if let episodesWatched, let episodesTotal, episodesTotal > 0 {
            return "\(episodesWatched)/\(episodesTotal) episodi"
        }
        return "In corso"
    }
}
