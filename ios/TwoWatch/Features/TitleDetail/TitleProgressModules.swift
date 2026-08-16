import SwiftUI
import UIKit

// MARK: - "Nuovo" badge (contenuti appena usciti)

/// Logica condivisa per capire se un contenuto è "appena uscito" e merita il
/// badge "Nuovo": stagioni (data di messa in onda recente) e film (anno corrente).
enum TitleReleaseFreshness {
    /// Finestra entro cui una stagione è considerata "appena uscita".
    static let recentSeasonWindowDays = 30

    private static let airDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// True se la data "yyyy-MM-dd" è già passata ma entro `withinDays` giorni.
    static func isRecent(airDate raw: String?, withinDays: Int = recentSeasonWindowDays) -> Bool {
        guard let raw, !raw.isEmpty, let date = airDateFormatter.date(from: raw) else { return false }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let day = calendar.startOfDay(for: date)
        guard day <= today,
              let cutoff = calendar.date(byAdding: .day, value: -withinDays, to: today)
        else { return false }
        return day >= cutoff
    }

    /// True se il film è uscito nell'anno solare corrente.
    static func isRecent(movieYear year: Int?) -> Bool {
        guard let year else { return false }
        return year == Calendar.current.component(.year, from: Date())
    }
}

/// Pill compatta "NUOVO" per contenuti appena usciti (stagioni, film).
struct NewReleaseBadge: View {
    var text: String = "NUOVO"

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .tracking(0.5)
            .foregroundStyle(Color.black)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(TwoWatchTheme.accent, in: Capsule())
            .accessibilityLabel("Appena uscito")
    }
}

// MARK: - Compact "Il tuo percorso" module for series

struct SomtoSeriesProgressModule: View {
    let personalState: TitlePersonalState?
    let seriesProgress: TitleSeriesProgress?
    let isAuthenticated: Bool
    let onRequireAuth: () -> Void
    let onMarkEpisode: () -> Void
    let onOpenMoreActions: () -> Void

    var body: some View {
        // Hierarchy: meta row (chips + %) → label (where you are) → bar → micro actions.
        // Keep total height ≈ 110pt: deliberately compact, never dominates the screen.
        VStack(alignment: .leading, spacing: 10) {
            metaRow
            mainStatementRow
            SomtoThinProgressBar(fraction: progressFraction, tint: TwoWatchTheme.accent)
            actionsRow
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private var metaRow: some View {
        HStack(spacing: 6) {
            statusChip
            if rewatchIndex > 0 { rewatchChip }
            Spacer(minLength: 4)
            Text(percentText)
                .font(.system(size: 13, weight: .heavy, design: .rounded))
                .foregroundStyle(TwoWatchTheme.accent)
                .monospacedDigit()
                .accessibilityLabel("\(percentText) completato")
        }
    }

    @ViewBuilder
    private var mainStatementRow: some View {
        if let last = lastSE {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Sei a")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Text("S\(last.season)")
                    .font(.system(size: 17, weight: .heavy, design: .rounded))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .monospacedDigit()
                Text("·")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                Text("E\(last.episode)")
                    .font(.system(size: 17, weight: .heavy, design: .rounded))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .monospacedDigit()
                Spacer(minLength: 0)
                Text(secondaryLine)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        } else {
            Text(emptyHeadline)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
    }

    private var actionsRow: some View {
        HStack(spacing: 6) {
            Button {
                if isAuthenticated { onMarkEpisode() } else { onRequireAuth() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .heavy))
                    Text("1 episodio")
                        .font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(Color.black)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(TwoWatchTheme.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Segna un episodio in più come visto")

            Button(action: onOpenMoreActions) {
                Text("Altre azioni")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        Capsule().stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
    }

    private var rewatchIndex: Int {
        guard let personalState else { return 0 }
        if personalState.isInRewatch {
            return max(1, personalState.completedCount)
        }
        if personalState.completedCount > 1 {
            return personalState.completedCount - 1
        }
        return 0
    }

    private var statusChip: some View {
        let label = statusLabel
        let tint = statusTint
        return Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tint.opacity(0.16), in: Capsule())
    }

    private var rewatchChip: some View {
        Label("Rewatch \(rewatchIndex)x", systemImage: "arrow.counterclockwise")
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(TwoWatchTheme.panelStrong, in: Capsule())
            .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private var statusLabel: String {
        guard let personalState else { return "Da vedere" }
        // In rewatch la label primaria esplicita lo stato invece di un generico
        // "In corso" / "In pari" (che confondeva: sembrava una prima visione).
        if personalState.isInRewatch {
            return personalState.seriesSegmentedStatus == .inProgress ? "Rewatch in corso" : "Da rivedere"
        }
        switch personalState.seriesSegmentedStatus {
        case .notStarted: return "Da vedere"
        case .inProgress: return "In corso"
        case .completedUnrated, .rated: return "In pari"
        }
    }

    private var statusTint: Color {
        guard let personalState else { return TwoWatchTheme.textSecondary }
        if personalState.isInRewatch { return TwoWatchTheme.brandWarm }
        switch personalState.seriesSegmentedStatus {
        case .notStarted: return TwoWatchTheme.textSecondary
        case .inProgress: return TwoWatchTheme.accent
        case .completedUnrated, .rated: return TwoWatchTheme.success
        }
    }

    private var emptyHeadline: String {
        guard let personalState else { return String(localized: "Inizia il percorso") }
        switch personalState.seriesSegmentedStatus {
        case .notStarted: return String(localized: "Inizia il percorso")
        case .inProgress: return String(localized: "Continua il percorso")
        case .completedUnrated, .rated:
            return personalState.isInRewatch ? "Rewatch in corso" : String(localized: "Hai finito")
        }
    }

    private var lastSE: (season: Int, episode: Int)? {
        guard let p = seriesProgress,
              let s = p.lastWatchedSeasonNumber,
              let e = p.lastWatchedEpisodeNumber,
              s > 0, e > 0 else { return nil }
        return (s, e)
    }

    private var watchedCount: Int {
        max(0, seriesProgress?.episodesWatchedCount ?? 0)
    }

    private var totalCount: Int {
        max(0, seriesProgress?.totalEpisodeCount ?? 0)
    }

    private var secondaryLine: String {
        if totalCount > 0 {
            return "\(watchedCount) di \(totalCount) episodi visti"
        }
        if watchedCount > 0 {
            return "\(watchedCount) episodi visti"
        }
        return String(localized: "Nessun episodio segnato")
    }

    private var progressFraction: Double {
        if let p = seriesProgress?.percentComplete {
            return max(0, min(1, p))
        }
        guard totalCount > 0 else { return 0 }
        return max(0, min(1, Double(watchedCount) / Double(totalCount)))
    }

    private var percentText: String {
        "\(Int((progressFraction * 100).rounded()))%"
    }
}

// MARK: - Compact "Il tuo percorso" module for movies

struct SomtoMovieProgressModule: View {
    let personalState: TitlePersonalState?
    let runtimeMinutes: Int?
    let watchedMinutes: Int?
    let isAuthenticated: Bool
    let onRequireAuth: () -> Void
    let onMarkSeen: () -> Void
    let onMarkUnseen: () -> Void
    let onOpenMoreActions: () -> Void

    var body: some View {
        // Mirror the series module layout: meta row → main statement →
        // (optional) progress bar → micro actions. Same paddings/corner
        // radius so movie & series cards read as one component family.
        VStack(alignment: .leading, spacing: 10) {
            metaRow
            mainStatementRow
            if hasRuntimeProgress {
                SomtoThinProgressBar(fraction: progressFraction, tint: TwoWatchTheme.accent)
            }
            actionsRow
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private var metaRow: some View {
        HStack(spacing: 6) {
            statusChip
            if rewatchIndex > 0 { rewatchChip }
            Spacer(minLength: 4)
            if hasRuntimeProgress {
                Text(percentText)
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .monospacedDigit()
                    .accessibilityLabel("\(percentText) completato")
            }
        }
    }

    private var rewatchChip: some View {
        Label("Rewatch \(rewatchIndex)x", systemImage: "arrow.counterclockwise")
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(TwoWatchTheme.panelStrong, in: Capsule())
            .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    @ViewBuilder
    private var mainStatementRow: some View {
        if hasRuntimeProgress {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(runtimeProgressHeadline)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer(minLength: 0)
                if let remaining = remainingMinutesText {
                    Text(remaining)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        } else {
            Text(headlineCopy)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actionsRow: some View {
        HStack(spacing: 6) {
            Button {
                if !isAuthenticated { onRequireAuth(); return }
                if isSeen { onMarkUnseen() } else { onMarkSeen() }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: isSeen ? "checkmark" : "eye.fill")
                        .font(.system(size: 11, weight: .heavy))
                    Text(isSeen ? "Visto" : "Segna visto")
                        .font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(Color.black)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(TwoWatchTheme.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isSeen ? "Visto, tocca per togliere" : "Segna come visto")

            Button(action: onOpenMoreActions) {
                Text("Altre azioni")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        Capsule().stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
    }

    private var isSeen: Bool { personalState?.isCompleted == true }

    private var rewatchIndex: Int {
        guard let p = personalState else { return 0 }
        if p.isInRewatch { return max(1, p.completedCount) }
        if p.completedCount > 1 { return p.completedCount - 1 }
        return 0
    }

    private var statusChip: some View {
        let (label, tint): (String, Color) = {
            guard let p = personalState else { return ("Da vedere", TwoWatchTheme.textSecondary) }
            if p.isCompleted { return ("Visto", TwoWatchTheme.success) }
            if p.generalWatchlist { return ("Da vedere", TwoWatchTheme.accent) }
            return ("Da vedere", TwoWatchTheme.textSecondary)
        }()
        return Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tint.opacity(0.16), in: Capsule())
    }

    private var hasRuntimeProgress: Bool {
        guard let total = runtimeMinutes, total > 0,
              let watched = watchedMinutes, watched > 0 else { return false }
        return watched < total
    }

    private var progressFraction: Double {
        guard let total = runtimeMinutes, total > 0 else { return isSeen ? 1 : 0 }
        let w = max(0, watchedMinutes ?? 0)
        return max(0, min(1, Double(w) / Double(total)))
    }

    private var percentText: String {
        "\(Int((progressFraction * 100).rounded()))%"
    }

    private var runtimeProgressHeadline: String {
        let watched = humanMinutes(watchedMinutes ?? 0)
        if let total = runtimeMinutes, total > 0 {
            return "\(watched) di \(humanMinutes(total))"
        }
        return watched
    }

    private var remainingMinutesText: String? {
        guard let total = runtimeMinutes, total > 0,
              let w = watchedMinutes, w >= 0, w < total else { return nil }
        let remaining = total - w
        return "Mancano \(humanMinutes(remaining))"
    }

    private var headlineCopy: String {
        if isSeen { return String(localized: "Visto. Il voto resta separato dal progresso.") }
        if personalState?.generalWatchlist == true { return "Salvato in 'Da vedere'." }
        return String(localized: "Per i film il voto resta separato dal progresso.")
    }

    private func humanMinutes(_ m: Int) -> String {
        let mins = max(0, m)
        let h = mins / 60
        let r = mins % 60
        if h > 0 && r > 0 { return "\(h)h \(r)m" }
        if h > 0 { return "\(h)h" }
        return "\(r)m"
    }
}

// MARK: - Compact inline rating row Serie | Stagione | Episodio

struct SomtoSeasonInlineRatingRow: View {
    let seriesRating: Double?
    let seasonRating: Double?
    let episodeRating: Double?
    let onTapSeries: () -> Void
    let onTapSeason: () -> Void
    let onTapEpisode: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            cell(label: "Serie", value: seriesRating, action: onTapSeries)
            divider
            cell(label: "Stagione", value: seasonRating, action: onTapSeason)
            divider
            cell(label: "Episodio", value: episodeRating, action: onTapEpisode)
        }
        .padding(.vertical, 10)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private var divider: some View {
        Rectangle()
            .fill(TwoWatchTheme.border)
            .frame(width: 1, height: 28)
    }

    private func cell(label: String, value: Double?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Text(formatted(value))
                    .font(.headline.weight(.bold))
                    .foregroundStyle(value == nil ? TwoWatchTheme.textMuted : TwoWatchTheme.accent)
                    .monospacedDigit()
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func formatted(_ v: Double?) -> String {
        RatingDisplayFormat.halfStep(v)
    }
}

// MARK: - Star rating row (replaces slider/quarter-button grid)

struct SomtoStarRatingRow: View {
    /// Voto corrente in scala 0...10. nil = nessun voto.
    let value: Double?
    /// Step minimo del gesto sulle stelle (0.5 di default → mezza stella).
    var step: Double = 0.5
    /// Mostra il valore numerico grande sopra le stelle.
    var showsLabel: Bool = true
    let onChange: (Double) -> Void

    @State private var liveValue: Double?
    @State private var lastHapticBucket: Int?
    /// True quando il gesto in corso è chiaramente uno scroll verticale:
    /// in quel caso NON si registra alcun voto (evita voti accidentali mentre
    /// si scorre la lista stagioni/episodi).
    @State private var gestureIsScrolling: Bool = false

    private var displayValue: Double {
        liveValue ?? value ?? 0
    }

    /// Un movimento è considerato scroll se è prevalentemente verticale.
    private func isVerticalScroll(_ translation: CGSize) -> Bool {
        let dx = abs(translation.width)
        let dy = abs(translation.height)
        return dy > 10 && dy > dx
    }

    var body: some View {
        VStack(spacing: 14) {
            if showsLabel { numericLabel }
            starsRow
            scaleHint
        }
    }

    // MARK: - Pieces

    /// Solo il numero: la scala di Somto è sempre 0–10, quindi "/10" era
    /// rumore. Il valore resta leggibile a voce grazie all'accessibilityLabel.
    private var numericLabel: some View {
        Text(displayValue > 0 ? formatted(displayValue) : "—")
            .font(.system(size: 44, weight: .heavy, design: .rounded))
            .foregroundStyle(displayValue > 0 ? TwoWatchTheme.accent : TwoWatchTheme.textMuted)
            .monospacedDigit()
            .contentTransition(.numericText())
            .animation(.easeOut(duration: 0.18), value: displayValue)
            .accessibilityLabel(
                displayValue > 0 ? "Voto \(formatted(displayValue)) su 10" : "Nessun voto"
            )
    }

    private var starsRow: some View {
        GeometryReader { geo in
            let starWidth = geo.size.width / 10
            ZStack(alignment: .leading) {
                // Empty layer
                HStack(spacing: 0) {
                    ForEach(1 ... 10, id: \.self) { _ in
                        starShape(filled: false).frame(width: starWidth)
                    }
                }
                // Filled layer, masked horizontally to displayValue
                HStack(spacing: 0) {
                    ForEach(1 ... 10, id: \.self) { _ in
                        starShape(filled: true).frame(width: starWidth)
                    }
                }
                .mask(
                    HStack(spacing: 0) {
                        Rectangle()
                            .frame(width: filledWidth(totalWidth: geo.size.width))
                        Spacer(minLength: 0)
                    }
                )
            }
            .frame(height: starWidth)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in
                        // Nuovo gesto (touch-down, translation zero): azzera lo
                        // stato di scroll così un gesto interrotto non lascia il
                        // flag bloccato impedendo i voti successivi.
                        if gesture.translation == .zero {
                            gestureIsScrolling = false
                        }
                        guard !gestureIsScrolling else { return }
                        // Se il dito parte sulle stelle ma poi scorre in verticale,
                        // trattalo come scroll: niente anteprima, niente voto.
                        if isVerticalScroll(gesture.translation) {
                            gestureIsScrolling = true
                            liveValue = nil
                            lastHapticBucket = nil
                            return
                        }
                        let raw = max(0, min(geo.size.width, gesture.location.x)) / starWidth
                        let snapped = roundedValue(raw)
                        liveValue = snapped
                        triggerHapticIfNeeded(value: snapped)
                    }
                    .onEnded { gesture in
                        defer {
                            liveValue = nil
                            lastHapticBucket = nil
                            gestureIsScrolling = false
                        }
                        // Non registrare un voto se il gesto era uno scroll verticale.
                        guard !gestureIsScrolling, !isVerticalScroll(gesture.translation) else { return }
                        let raw = max(0, min(geo.size.width, gesture.location.x)) / starWidth
                        let final = roundedValue(raw)
                        onChange(final)
                    }
            )
            .accessibilityElement()
            .accessibilityLabel("Voto da 0 a 10")
            .accessibilityValue(formatted(displayValue))
            .accessibilityAdjustableAction { dir in
                let current = value ?? 0
                let next: Double
                switch dir {
                case .increment: next = min(10, max(1, current + step))
                case .decrement: next = max(1, current - step)
                @unknown default: next = current
                }
                onChange(next)
            }
        }
        .frame(height: 30)
    }

    private var scaleHint: some View {
        HStack {
            Text("Scarso")
                .font(.caption2.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textMuted)
            Spacer()
            Text("Trascina per votare")
                .font(.caption2.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textMuted)
            Spacer()
            Text("Capolavoro")
                .font(.caption2.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .lineLimit(1)
    }

    // MARK: - Math

    private func roundedValue(_ raw: Double) -> Double {
        let clamped = max(0, min(10, raw))
        let rounded = (clamped / step).rounded() * step
        // Il voto valido è 1...10 (vincolo Firestore rules): un tap all'estrema
        // sinistra della riga stelle non deve mai produrre 0.5.
        return max(1, min(10, rounded))
    }

    private func filledWidth(totalWidth: CGFloat) -> CGFloat {
        let fraction = max(0, min(1, displayValue / 10))
        return totalWidth * fraction
    }

    @ViewBuilder
    private func starShape(filled: Bool) -> some View {
        Image(systemName: filled ? "star.fill" : "star")
            .resizable()
            .scaledToFit()
            .padding(2)
            .foregroundStyle(filled ? TwoWatchTheme.accent : TwoWatchTheme.textMuted.opacity(0.55))
    }

    private func triggerHapticIfNeeded(value: Double) {
        let bucket = Int((value / step).rounded())
        guard bucket != lastHapticBucket else { return }
        lastHapticBucket = bucket
        let generator = UIImpactFeedbackGenerator(style: .soft)
        generator.impactOccurred(intensity: 0.55)
    }

    private func formatted(_ v: Double) -> String {
        RatingDisplayFormat.halfStep(v)
    }
}

// MARK: - Shared visual helpers

struct SomtoThinProgressBar: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(TwoWatchTheme.panelStrong)
                Capsule()
                    .fill(tint)
                    .frame(width: max(0, min(1, fraction)) * geo.size.width)
            }
        }
        .frame(height: 6)
        .accessibilityValue(Text("\(Int((max(0, min(1, fraction)) * 100).rounded())) percento"))
    }
}

struct SomtoCyanButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Color.black)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(TwoWatchTheme.accent)
                    .opacity(configuration.isPressed ? 0.78 : 1)
            )
    }
}

struct SomtoOutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
                    .background(TwoWatchTheme.panelStrong.opacity(configuration.isPressed ? 0.6 : 1))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            )
    }
}
