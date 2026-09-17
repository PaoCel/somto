import SwiftUI

/// Ambito di una conversazione: cosa si sta commentando, esattamente.
///
/// Non è un campo nuovo su Firestore: si deriva dal `contextType` e dal
/// `contextId` che `ThreadsRepository` scrive già oggi —
/// `"global"` (titolo intero), `"s3"` (stagione), `"s3e7"` (episodio).
/// Serve a dare a Community, Messaggi e alla schermata thread **lo stesso**
/// vocabolario: prima ogni superficie diceva "Discussione" e basta, quindi
/// un thread di episodio sembrava identico a una chat privata.
enum ThreadScope: Hashable {
    case title
    case season(Int)
    case episode(season: Int, episode: Int)
    case directMessage
    case group

    /// Ricava l'ambito da un thread già caricato.
    static func resolve(for thread: AppThread) -> ThreadScope {
        switch thread.contextType {
        case .dm:
            return .directMessage
        case .group:
            return .group
        case .public:
            return parseContextID(thread.contextId) ?? .title
        }
    }

    /// Interpreta il `contextId` delle discussioni pubbliche: `"s3e7"` →
    /// episodio, `"s3"` → stagione, tutto il resto (incluso `"global"`) → nil,
    /// che i chiamanti trattano come discussione del titolo.
    static func parseContextID(_ raw: String?) -> ThreadScope? {
        guard let raw, raw.hasPrefix("s") else { return nil }
        let afterS = raw.index(after: raw.startIndex)

        if let eIndex = raw.firstIndex(of: "e") {
            guard let season = Int(raw[afterS..<eIndex]),
                  let episode = Int(raw[raw.index(after: eIndex)...]),
                  season > 0, episode > 0
            else { return nil }
            return .episode(season: season, episode: episode)
        }

        guard let season = Int(raw[afterS...]), season > 0 else { return nil }
        return .season(season)
    }

    /// Etichetta compatta per i badge nelle card ("S3 · E7").
    var shortLabel: String {
        switch self {
        case .title: return "Serie"
        case .season(let season): return "Stagione \(season)"
        case .episode(let season, let episode): return "S\(season) · E\(episode)"
        case .directMessage: return "Chat"
        case .group: return "Gruppo"
        }
    }

    /// Etichetta estesa, per l'intestazione del thread e le liste raggruppate.
    var longLabel: String {
        switch self {
        case .title: return "Discussione generale"
        case .season(let season): return "Discussione della stagione \(season)"
        case .episode(let season, let episode): return "Discussione dell'episodio S\(season)E\(episode)"
        case .directMessage: return "Messaggio diretto"
        case .group: return "Gruppo"
        }
    }

    var symbolName: String {
        switch self {
        case .title: return "film.stack"
        case .season: return "rectangle.stack"
        case .episode: return "tv"
        case .directMessage: return "message.fill"
        case .group: return "person.2.fill"
        }
    }

    var tint: Color {
        switch self {
        case .title: return TwoWatchTheme.accent
        case .season: return TwoWatchTheme.brandWarm
        case .episode: return TwoWatchTheme.brandSecondary
        case .directMessage: return TwoWatchTheme.brandSecondary
        case .group: return TwoWatchTheme.accent
        }
    }

    var isPublicDiscussion: Bool {
        switch self {
        case .title, .season, .episode: return true
        case .directMessage, .group: return false
        }
    }

    /// Coordinate stagione/episodio quando l'ambito le ha.
    var coordinates: (season: Int, episode: Int?)? {
        switch self {
        case .season(let season): return (season, nil)
        case .episode(let season, let episode): return (season, episode)
        case .title, .directMessage, .group: return nil
        }
    }

    /// Ordinamento gerarchico dentro un titolo: prima la serie, poi le
    /// stagioni, poi gli episodi (in ordine naturale).
    var hierarchyKey: (Int, Int, Int) {
        switch self {
        case .title: return (0, 0, 0)
        case .season(let season): return (1, season, 0)
        case .episode(let season, let episode): return (2, season, episode)
        case .directMessage: return (3, 0, 0)
        case .group: return (4, 0, 0)
        }
    }
}

extension AppThread {
    /// Ambito della conversazione, derivato da `contextType`/`contextId`.
    var scope: ThreadScope { ThreadScope.resolve(for: self) }

    /// Anteprima dell'ultimo messaggio già separata dal voto: i messaggi
    /// pubblicati da un voto sono salvati come `"7.5/10 — testo"`, che nelle
    /// card va mostrato come badge ★ 7,5 + testo pulito (come sul web).
    var previewSplit: (score: String?, text: String) {
        let raw = lastMessagePreview.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return (nil, "") }
        guard let split = RatingDisplayFormat.splitRatingPrefix(raw) else {
            return (nil, TaggedTextFormatter.plainText(from: raw) ?? raw)
        }
        let body = split.body.isEmpty
            ? ""
            : (TaggedTextFormatter.plainText(from: split.body) ?? split.body)
        return (split.score, body)
    }
}

/// Badge compatto che dice **che tipo** di discussione è (serie / stagione /
/// episodio / chat / gruppo). Un solo componente per Community, Messaggi ed
/// esploratore, così l'etichetta non diverge tra le superfici.
struct ThreadScopeBadge: View {
    let scope: ThreadScope
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: scope.symbolName)
                .font(.system(size: compact ? 9 : 10, weight: .bold))
            Text(scope.shortLabel)
                .font(.system(size: compact ? 10 : 11, weight: .bold))
                .monospacedDigit()
        }
        .foregroundStyle(scope.tint)
        .padding(.horizontal, compact ? 7 : 8)
        .padding(.vertical, compact ? 3 : 4)
        .background(scope.tint.opacity(0.14), in: Capsule())
        .overlay(Capsule().stroke(scope.tint.opacity(0.32), lineWidth: 1))
        .accessibilityLabel(scope.longLabel)
    }
}

/// Badge del voto per le anteprime: "★ 7,5", senza "/10". Stesso principio
/// visivo di `.threadcard-vote` sul web, adattato alle capsule di Somto.
/// Il voto come pastiglia tonda, mai come testo "7,5/10".
///
/// Il "/10" resta nel wire format del messaggio (`RatingDisplayFormat`), ma a
/// schermo non ci va: la scala si capisce da sola e scritta per esteso dentro
/// una frase è solo rumore. Un solo componente per tutte le superfici, così
/// il voto ha sempre la stessa faccia.
struct ThreadRatingBadge: View {
    let score: String
    /// `.inline` per le righe dense (accanto al badge di scope), `.prominent`
    /// quando il voto è l'elemento di testa di una card.
    var size: Size = .inline

    enum Size {
        case inline
        case prominent

        var diameter: CGFloat { self == .inline ? 30 : 38 }
        var fontSize: CGFloat { self == .inline ? 12 : 15 }
    }

    var body: some View {
        Text(score)
            .font(.system(size: size.fontSize, weight: .heavy, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(TwoWatchTheme.warning)
            .frame(width: size.diameter, height: size.diameter)
            .background(
                Circle()
                    .fill(TwoWatchTheme.warning.opacity(0.16))
            )
            .overlay(
                Circle()
                    .stroke(TwoWatchTheme.warning.opacity(0.38), lineWidth: 1.5)
            )
            .accessibilityLabel("Voto \(score) su 10")
    }
}
