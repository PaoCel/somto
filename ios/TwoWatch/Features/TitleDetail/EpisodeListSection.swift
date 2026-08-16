import SwiftUI
import UIKit

// MARK: - Air date formatting

/// Formattazione data di messa in onda episodio: "yyyy-MM-dd" (TMDB) →
/// "24 set 2007" (IT breve). Restituisce nil se la data manca o non è valida,
/// così la riga episodio può nascondere del tutto la riga data.
enum EpisodeAirDate {
    private static let parser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let display: DateFormatter = {
        let formatter = DateFormatter()
        // Usava gia' l'API giusta, vanificata dal locale fisso.
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("d MMM yyyy")
        return formatter
    }()

    static func shortIT(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty, let date = parser.date(from: raw) else { return nil }
        return display.string(from: date)
    }

    /// True se la messa in onda è nel futuro (episodio/stagione non ancora
    /// usciti): il giorno stesso conta come uscito. Data assente o invalida →
    /// false (mai bloccare per dati mancanti).
    static func isFuture(_ raw: String?) -> Bool {
        guard let raw, !raw.isEmpty, let date = parser.date(from: raw) else { return false }
        return date > Date()
    }
}

// MARK: - Episode row

/// Riga episodio della lista per-stagione (redesign 2026-07-14). Layout pulito e
/// compatto, allineato per densità al resto dell'app: numero + nome + data a
/// sinistra, e a destra un cluster di controlli ad altezza fissa (mai stirati in
/// verticale) — voto (rosa), commenti (viola), pill visto/da vedere (verde
/// `success`, come il web). Riga vista = tinta verde tenue + bordo verde. Nessun
/// dato inventato: numero sulla stella solo con voto reale, pallino commenti solo
/// con discussione reale.
struct SomtoEpisodeRow: View {
    let number: Int
    let name: String
    let airDate: String?
    let isSeen: Bool
    /// Prossimo episodio da vedere (watermark + 1): evidenziazione leggera.
    let isNext: Bool
    /// Episodio non ancora andato in onda: non marcabile come visto (caso
    /// Reacher S4 pre-uscita). Il tap resta attivo solo per TOGLIERE un
    /// "visto" storico sbagliato.
    let isUnreleased: Bool
    /// Voto personale sull'episodio (0…10) se presente.
    let personalRating: Double?
    /// Media community dell'episodio (0…10) se presente.
    let communityRating: Double?
    /// True se l'episodio ha una discussione con messaggi (pallino viola).
    let hasComments: Bool
    let isAuthenticated: Bool
    /// Tap sulla pill "Da vedere": segna visto fino a qui.
    let onMarkSeen: () -> Void
    /// Tap sulla pill "Visto" / menu "Segna non visto": step back a N-1.
    let onUnsee: () -> Void
    let onOpenRating: () -> Void
    let onOpenComments: () -> Void
    let onDeleteRating: () -> Void
    let onRequestAuth: () -> Void

    private static let controlHeight: CGFloat = 32

    private var shortDate: String? { EpisodeAirDate.shortIT(airDate) }

    private var hasMenu: Bool { isSeen || personalRating != nil }

    /// Numero mostrato sulla stella: voto personale se c'è, altrimenti media
    /// community (1 dec), altrimenti niente.
    private var displayRatingValue: String? {
        if let personalRating { return RatingDisplayFormat.halfStep(personalRating) }
        if let communityRating { return String(format: "%.1f", communityRating) }
        return nil
    }

    private var hasRatingSignal: Bool { personalRating != nil || communityRating != nil }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(isSeen ? TwoWatchTheme.success : TwoWatchTheme.textMuted)
                .frame(width: 22, alignment: .center)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                if let shortDate {
                    Text(shortDate)
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }

            Spacer(minLength: 6)

            HStack(spacing: 6) {
                ratingControl
                commentControl
                seenControl
                if hasMenu { overflowMenu }
            }
        }
        .padding(.vertical, 9)
        .padding(.horizontal, 11)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(isSeen ? TwoWatchTheme.success.opacity(0.07) : TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(borderColor, lineWidth: 1)
        )
    }

    private var borderColor: Color {
        if isSeen { return TwoWatchTheme.success.opacity(0.45) }
        if isNext { return TwoWatchTheme.brandPrimary.opacity(0.4) }
        return TwoWatchTheme.border
    }

    // MARK: Controls

    private var ratingControl: some View {
        Button {
            if isAuthenticated { onOpenRating() } else { onRequestAuth() }
        } label: {
            HStack(spacing: 3) {
                Image(systemName: personalRating != nil ? "star.fill" : "star")
                    .font(.system(size: 12, weight: .semibold))
                if let displayRatingValue {
                    Text(displayRatingValue)
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                }
            }
            .foregroundStyle(hasRatingSignal ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textMuted)
            .padding(.horizontal, displayRatingValue != nil ? 9 : 0)
            .frame(width: displayRatingValue != nil ? nil : Self.controlHeight, height: Self.controlHeight)
            .background(
                Capsule().fill(personalRating != nil ? TwoWatchTheme.brandPrimary.opacity(0.16) : Color.clear)
            )
            .overlay(
                Capsule().stroke(
                    communityRating != nil && personalRating == nil ? TwoWatchTheme.brandPrimary.opacity(0.35) : Color.clear,
                    lineWidth: 1
                )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ratingAccessibilityLabel)
    }

    private var ratingAccessibilityLabel: String {
        if let personalRating { return "Il tuo voto: \(RatingDisplayFormat.halfStep(personalRating)). Tocca per modificare." }
        return "Vota l'episodio \(number)"
    }

    private var commentControl: some View {
        Button(action: onOpenComments) {
            Image(systemName: "bubble.left")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(hasComments ? TwoWatchTheme.brandSecondary : TwoWatchTheme.textMuted)
                .frame(width: Self.controlHeight, height: Self.controlHeight)
                .overlay(alignment: .topTrailing) {
                    if hasComments {
                        Circle()
                            .fill(TwoWatchTheme.brandSecondary)
                            .frame(width: 6, height: 6)
                            .offset(x: -3, y: 4)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(hasComments ? "Vedi i commenti dell'episodio \(number)" : "Commenta l'episodio \(number)")
    }

    /// Terzo tasto: solo il ✓. Sbiadito (muted) se non visto, verde pieno se
    /// visto. Coerente per peso con ★ e 💬, niente più pill testuale.
    private var seenControl: some View {
        Button {
            guard isAuthenticated else { onRequestAuth(); return }
            let generator = UIImpactFeedbackGenerator(style: .soft)
            generator.impactOccurred(intensity: 0.4)
            if isSeen { onUnsee() } else if !isUnreleased { onMarkSeen() }
        } label: {
            Image(systemName: isSeen ? "checkmark.circle.fill" : (isUnreleased ? "lock.circle" : "checkmark.circle"))
                .font(.system(size: 20, weight: isSeen ? .bold : .regular))
                .foregroundStyle(isSeen ? TwoWatchTheme.success : TwoWatchTheme.textMuted.opacity(isUnreleased ? 0.35 : 0.55))
                .frame(width: Self.controlHeight, height: Self.controlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(seenAccessibilityLabel)
    }

    private var seenAccessibilityLabel: String {
        if isSeen { return "Episodio \(number) visto. Tocca per segnare da vedere." }
        if isUnreleased { return "Episodio \(number) non ancora uscito." }
        return "Segna visto fino all'episodio \(number)"
    }

    private var overflowMenu: some View {
        Menu {
            if isSeen {
                Button {
                    onUnsee()
                } label: {
                    Label("Segna non visto", systemImage: "eye.slash")
                }
            }
            if personalRating != nil {
                Button(role: .destructive) {
                    onDeleteRating()
                } label: {
                    Label("Annulla voto", systemImage: "star.slash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .frame(width: 26, height: Self.controlHeight)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Altre azioni per l'episodio \(number)")
    }
}

// MARK: - Episode rating sheet

/// Sheet compatto per votare un singolo episodio. Riusa `SomtoStarRatingRow`
/// (stesso input del voto titolo/stagione). "Annulla voto" appare solo se
/// l'utente ha già votato l'episodio.
struct EpisodeRatingSheet: View {
    let season: Int
    let episode: Int
    let personalRating: Double?
    let communityAverage: Double?
    /// Async: il chiamante scrive su Firestore e riporta l'esito, cosi' il
    /// foglio puo' mostrare un errore invece di richiuderlo alla cieca.
    let onSelect: (Double) async -> Bool
    let onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss
    /// Stato ottimistico: senza, il rilascio del gesto su `SomtoStarRatingRow`
    /// ricade su `personalRating`, ancora nil finché il salvataggio non torna
    /// dal server, e le stelle sembrano svuotarsi. Stesso pattern di
    /// `EpisodeSeenSheet.localRating`.
    @State private var localRating: Double?
    @State private var saveState: RatingSaveState = .idle
    /// Ultimo valore tentato, per "Riprova" senza dover ritrascinare le stelle.
    @State private var pendingRetryValue: Double?

    private enum RatingSaveState: Equatable {
        case idle
        case saving
        case failed
    }

    init(
        season: Int,
        episode: Int,
        personalRating: Double?,
        communityAverage: Double?,
        onSelect: @escaping (Double) async -> Bool,
        onDelete: @escaping () -> Void
    ) {
        self.season = season
        self.episode = episode
        self.personalRating = personalRating
        self.communityAverage = communityAverage
        self.onSelect = onSelect
        self.onDelete = onDelete
        _localRating = State(initialValue: personalRating)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Voto episodio")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer()
                Text("S\(season)·E\(episode)")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .monospacedDigit()
            }

            SomtoStarRatingRow(value: localRating, showsLabel: true) { value in
                rate(value)
            }

            saveFeedback

            if let communityAverage {
                Label("Media community: \(String(format: "%.1f", communityAverage))", systemImage: "person.2.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            HStack(spacing: 10) {
                if localRating != nil {
                    Button(role: .destructive) {
                        onDelete()
                        dismiss()
                    } label: {
                        Label("Annulla voto", systemImage: "star.slash")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .tint(TwoWatchTheme.brandPrimary)
                }

                Spacer(minLength: 0)

                Button("Fatto") { dismiss() }
                    .font(.subheadline.weight(.bold))
                    .buttonStyle(.borderedProminent)
                    .tint(TwoWatchTheme.brandPrimary)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var saveFeedback: some View {
        switch saveState {
        case .idle:
            EmptyView()
        case .saving:
            Label("Salvataggio…", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(TwoWatchTheme.textMuted)
                .font(.system(size: 11, weight: .semibold))
        case .failed:
            HStack(spacing: 8) {
                Label("Voto non salvato", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(TwoWatchTheme.warning)
                    .font(.system(size: 11, weight: .semibold))
                Spacer(minLength: 0)
                Button("Riprova") {
                    if let pendingRetryValue { rate(pendingRetryValue) }
                }
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(TwoWatchTheme.accent)
                .buttonStyle(.plain)
            }
        }
    }

    private func rate(_ value: Double) {
        withAnimation(.easeOut(duration: 0.18)) { localRating = value }
        saveState = .saving
        pendingRetryValue = value
        Task {
            let didSave = await onSelect(value)
            saveState = didSave ? .idle : .failed
        }
    }
}

// Il vecchio `EpisodeSeenNudge` viveva qui: card da 170pt con auto-dismiss a
// 6 secondi. Sostituito da `EpisodeSeenSheet` (EpisodeSeenSheet.swift), che
// non scade da solo e porta voto, emozioni e discussione nello stesso foglio.
