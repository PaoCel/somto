import SwiftUI

/// Action sheet per un singolo episodio (PART B del redesign, allineata al web).
/// Tap sul cerchio episodio la apre: 3 azioni — Segna visto (toggle), Vota
/// (star row inline), Commenti (apre la discussione di episodio). Header
/// "S{n}·E{m}" + riga di contesto (visto / tuo voto / media community /
/// commenti) senza read aggiuntive (usa i dati già in memoria).
///
/// Il catalogo Somto non ha oggi titolo/sinossi per singolo episodio, quindi
/// niente dato inventato: mostriamo solo la sigla. Chrome mutuata da
/// `TitleWatchActionsSheet` (NavigationStack + toolbar "Chiudi").
struct EpisodeActionSheet: View {
    let seasonNumber: Int
    let episodeNumber: Int
    let isSeen: Bool
    let personalRating: Double?
    let communityRating: Double?
    let hasComments: Bool
    /// Toggle "segna visto/non visto". `true` = segna visto (progress fino a
    /// questo episodio); `false` = un-see (progress all'episodio precedente).
    let onToggleSeen: (Bool) -> Void
    let onSelectRating: (Double) -> Void
    let onOpenComments: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showsRatingRow = false

    private var episodeLabel: String {
        "S\(seasonNumber)·E\(episodeNumber)"
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    headerCard
                    statsRow
                    actionsCard
                    if showsRatingRow {
                        ratingCard
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 28)
            }
            .background(TwoWatchBackground())
            .navigationTitle("Episodio \(episodeNumber)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }

    private var headerCard: some View {
        GlassCard {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle()
                        .fill(isSeen ? AnyShapeStyle(TwoWatchTheme.accent) : AnyShapeStyle(TwoWatchTheme.panelStrong))
                        .frame(width: 52, height: 52)
                    Text("\(episodeNumber)")
                        .font(.title3.weight(.heavy))
                        .foregroundStyle(isSeen ? Color.white : TwoWatchTheme.textPrimary)
                        .monospacedDigit()
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(episodeLabel)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .monospacedDigit()
                    Text(isSeen ? "Segnato come visto" : "Non ancora visto")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                Spacer(minLength: 0)
            }
        }
    }

    private var statsRow: some View {
        HStack(spacing: 10) {
            statTile(value: isSeen ? "Sì" : "No", label: "Visto")
            statTile(value: personalRating.map { RatingDisplayFormat.halfStep($0) } ?? "—", label: "Tuo voto")
            statTile(value: communityRating.map { RatingDisplayFormat.halfStep($0) } ?? "—", label: "Community")
            statTile(value: hasComments ? "Sì" : "—", label: "Commenti")
        }
    }

    private func statTile(value: String, label: String) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private var actionsCard: some View {
        GlassCard {
            VStack(spacing: 10) {
                actionRow(
                    icon: isSeen ? "eye.slash.fill" : "checkmark.circle.fill",
                    label: isSeen ? "Segna come non visto" : "Segna visto",
                    tint: TwoWatchTheme.accent,
                    isProminent: !isSeen
                ) {
                    let generator = UIImpactFeedbackGenerator(style: .soft)
                    generator.impactOccurred(intensity: 0.6)
                    onToggleSeen(!isSeen)
                    dismiss()
                }

                actionRow(
                    icon: "star.fill",
                    label: personalRating == nil ? "Vota" : "Aggiorna voto (\(RatingDisplayFormat.halfStep(personalRating)))",
                    tint: TwoWatchTheme.warning,
                    isProminent: false
                ) {
                    withAnimation(.easeOut(duration: 0.2)) { showsRatingRow.toggle() }
                }

                actionRow(
                    icon: "bubble.left.and.bubble.right.fill",
                    label: hasComments ? "Vedi commenti" : "Commenti",
                    tint: TwoWatchTheme.brandWarm,
                    isProminent: false
                ) {
                    onOpenComments()
                }
            }
        }
    }

    private func actionRow(
        icon: String,
        label: String,
        tint: Color,
        isProminent: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(isProminent ? Color.black : tint)
                    .frame(width: 34, height: 34)
                    .background(isProminent ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.16)), in: Circle())

                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .monospacedDigit()

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var ratingCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Il tuo voto per l'episodio \(episodeNumber)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                SomtoStarRatingRow(value: personalRating, showsLabel: true) { selected in
                    onSelectRating(selected)
                }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}
