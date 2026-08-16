import Foundation
import WidgetKit

// MARK: - Riga pronta da disegnare

/// Una riga della timeline. Contiene SOLO cio' che serve a disegnare, poster
/// compreso: quando la View gira, la rete non e' piu' disponibile.
struct UpcomingReleaseRow: Identifiable, Sendable {
    let id: String
    let name: String
    let releaseDate: Date
    let isSeries: Bool
    /// Dove esce, quando il feed lo sa. `nil` = si dice solo che tipo di titolo
    /// e', come prima: meglio un'informazione in meno di una inventata.
    let kind: UpcomingReleaseKind?
    /// Cosa esce: un film, o una serie che torna con una stagione nuova.
    let occasion: UpcomingReleaseOccasion
    /// La stagione che comincia. `nil` per i film e per le premiere di cui TMDB
    /// non dichiara il numero — in quel caso si dice "Nuova stagione".
    let season: Int?
    /// Nome della piattaforma (per VoiceOver) e byte del suo logo.
    let providerName: String?
    let providerLogoData: Data?
    let deepLink: URL
    let posterData: Data?
}

// MARK: - Entry

struct UpcomingReleasesEntry: TimelineEntry {
    /// Cosa mostrare. Tre casi distinti perche' "non ho dati" e "non ho potuto
    /// chiedere" non sono la stessa cosa per chi guarda: il primo e' una
    /// risposta, il secondo un guasto.
    enum State: Sendable {
        case releases([UpcomingReleaseRow])
        case empty
        case unavailable
    }

    let date: Date
    let state: State
}

// MARK: - Provider

struct UpcomingReleasesProvider: TimelineProvider {
    /// Le uscite si muovono di rado e il feed e' cacheato un'ora sulla CDN:
    /// ripassare piu' spesso spenderebbe budget di refresh per niente.
    private static let refreshInterval: TimeInterval = 6 * 60 * 60

    func placeholder(in context: Context) -> UpcomingReleasesEntry {
        UpcomingReleasesEntry(date: Date(), state: .releases(Self.placeholderRows()))
    }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (UpcomingReleasesEntry) -> Void) {
        // In galleria non si fa rete: l'anteprima deve comparire subito, e una
        // richiesta lenta la lascerebbe vuota proprio mentre l'utente sceglie.
        if context.isPreview {
            completion(UpcomingReleasesEntry(date: Date(), state: .releases(Self.placeholderRows())))
            return
        }
        // `TimelineProviderContext` non e' Sendable: dentro il Task ci entra la
        // famiglia (che lo e'), non il contesto.
        let family = context.family
        Task {
            completion(await Self.makeEntry(for: family))
        }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<UpcomingReleasesEntry>) -> Void) {
        let family = context.family
        Task {
            let entry = await Self.makeEntry(for: family)
            completion(Timeline(entries: [entry], policy: .after(Self.nextRefreshDate(after: entry))))
        }
    }

    // MARK: - Costruzione dell'entry

    private static func makeEntry(for family: WidgetFamily) async -> UpcomingReleasesEntry {
        let now = Date()
        do {
            let releases = try await UpcomingReleasesFeedLoader.loadReleases()
            let rows = await makeRows(from: releases, limit: rowBudget(for: family))
            return UpcomingReleasesEntry(date: now, state: rows.isEmpty ? .empty : .releases(rows))
        } catch {
            // Nel widget l'errore non puo' finire in un log e sparire: qui non
            // c'e' SilentFailure, e una schermata vuota sarebbe indistinguibile
            // da "nessuna uscita". Diventa uno stato visibile.
            return UpcomingReleasesEntry(date: now, state: .unavailable)
        }
    }

    /// Quante righe scaricare davvero. I poster costano una richiesta ciascuno:
    /// si prendono solo quelli che quella famiglia puo' mostrare.
    private static func rowBudget(for family: WidgetFamily) -> Int {
        switch family {
        case .systemSmall:
            return 1
        case .systemLarge:
            return WidgetRowLayout.largeRowCount
        default:
            return WidgetRowLayout.mediumRowCount
        }
    }

    private static func makeRows(from releases: [UpcomingRelease], limit: Int) async -> [UpcomingReleaseRow] {
        var rows: [UpcomingReleaseRow] = []
        // Le piattaforme si ripetono — tre premiere Netflix nello stesso giro
        // non sono tre logo diversi. Si scarica una volta per URL.
        var logosByUrl: [URL: Data] = [:]
        for release in releases {
            guard rows.count < limit else { break }
            // Senza deep link la riga sarebbe un tap a vuoto: si salta.
            guard let deepLink = release.url else { continue }

            let posterData: Data?
            if let posterUrl = release.posterUrl {
                posterData = await UpcomingReleasesFeedLoader.loadImageData(for: posterUrl)
            } else {
                posterData = nil
            }

            var logoData: Data?
            if let logoUrl = release.provider?.logoUrl {
                if let cached = logosByUrl[logoUrl] {
                    logoData = cached
                } else if let downloaded = await UpcomingReleasesFeedLoader.loadImageData(for: logoUrl) {
                    logosByUrl[logoUrl] = downloaded
                    logoData = downloaded
                }
            }

            rows.append(UpcomingReleaseRow(
                id: release.id,
                name: release.name,
                releaseDate: release.releaseDate,
                isSeries: release.isSeries,
                kind: release.kind,
                occasion: release.occasionKind,
                season: release.season,
                providerName: release.provider?.name,
                providerLogoData: logoData,
                deepLink: deepLink,
                posterData: posterData
            ))
        }
        return rows
    }

    /// Il prossimo risveglio: fra sei ore, o quando esce il primo titolo se
    /// arriva prima — cosi' un film gia' uscito non resta in vetrina.
    private static func nextRefreshDate(after entry: UpcomingReleasesEntry) -> Date {
        let scheduled = entry.date.addingTimeInterval(refreshInterval)
        guard case let .releases(rows) = entry.state,
              let firstRelease = rows.map(\.releaseDate).min(),
              firstRelease > entry.date
        else {
            return scheduled
        }
        return min(scheduled, firstRelease)
    }

    // MARK: - Segnaposto

    /// Righe finte per lo scheletro di sistema e per l'anteprima in galleria.
    /// Nomi neutri di proposito: non si promette un titolo che poi non c'e'.
    ///
    /// Se ne generano quante ne mostra la misura piu' grande: le altre ne
    /// prendono le prime e basta, mentre generarne tre lascerebbe la large
    /// mezza vuota proprio in galleria, dove l'utente la sceglie.
    private static func placeholderRows() -> [UpcomingReleaseRow] {
        let now = Date()
        let oneWeek: TimeInterval = 7 * 24 * 60 * 60
        guard let fallbackURL = URL(string: "https://somto.it/") else { return [] }
        return (0..<WidgetRowLayout.largeRowCount).map { index in
            let offset = oneWeek * TimeInterval(index + 1)
            return UpcomingReleaseRow(
                id: "placeholder-\(index)",
                name: String(localized: "In uscita"),
                releaseDate: now.addingTimeInterval(offset),
                isSeries: !index.isMultiple(of: 2),
                // Nel segnaposto non si promette nemmeno il canale: in galleria
                // "Al cinema" su una riga finta e' una riga finta in piu'.
                kind: nil,
                occasion: .release,
                season: nil,
                providerName: nil,
                providerLogoData: nil,
                deepLink: fallbackURL,
                posterData: nil
            )
        }
    }
}
