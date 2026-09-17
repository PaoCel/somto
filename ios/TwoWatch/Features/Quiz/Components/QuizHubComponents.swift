import SwiftUI

// MARK: - Hero Play Tile
// Big primary CTA: starts a solo run. Owns the most visual weight on the hub.
// Rich magenta→purple gradient, real outer glow, trophy decorative art, a play
// button on the left and a row of run-info chips.

struct QuizHeroPlayTile: View {
    var subtitle: LocalizedStringKey = "Casuale o titolo specifico"
    /// Daily streak; when > 0 a small flame chip rides in the top-right corner
    /// so the streak no longer needs an orphan pill below the hero.
    var streak: Int = 0

    // @ScaledMetric: default 26pt invariato, scala con la size category
    @ScaledMetric(relativeTo: .title2) private var giocaFontSize: CGFloat = 26

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Decorative trophy art — clipped by the card.
            Image(systemName: "trophy.fill")
                .font(.system(size: 130, weight: .bold))
                .foregroundStyle(Color.white.opacity(0.12))
                .rotationEffect(.degrees(-8))
                .offset(x: 40, y: 18)
                .accessibilityHidden(true)

            if streak > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "flame.fill")
                        .font(.caption2.weight(.bold))
                    Text("\(streak)")
                        .font(.caption.weight(.bold))
                        .monospacedDigit()
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Capsule().fill(Color.black.opacity(0.28)))
                .padding(14)
                .accessibilityLabel("\(streak) giorni di fila")
            }

            HStack(spacing: 14) {
                // Circular pink play button.
                Image(systemName: "play.fill")
                    .font(.system(size: 22, weight: .black))
                    .foregroundStyle(.white)
                    .offset(x: 2)
                    .frame(width: 56, height: 56)
                    .background(
                        Circle()
                            .fill(TwoWatchTheme.brandPrimary)
                            .overlay(
                                Circle().fill(
                                    LinearGradient(
                                        colors: [Color.white.opacity(0.35), .clear],
                                        startPoint: .top,
                                        endPoint: .center
                                    )
                                )
                            )
                    )
                    .overlay(Circle().stroke(Color.white.opacity(0.4), lineWidth: 1.5))
                    .shadow(color: .black.opacity(0.3), radius: 8, y: 4)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text("Gioca")
                            .font(.system(size: giocaFontSize, weight: .black, design: .rounded))
                            .foregroundStyle(.white)
                        QuizStatusPill(label: "Beta", tint: .white)
                    }
                    Text(subtitle)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.9))
                }
                Spacer(minLength: 0)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, minHeight: 116)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .quizGlowCard(
            cornerRadius: 26,
            gradient: LinearGradient(
                colors: [TwoWatchTheme.brandPrimary, TwoWatchTheme.brandSecondary],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            glowColor: TwoWatchTheme.brandPrimary
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Gioca una partita di quiz, in beta. Scegli casuale o un titolo specifico.")
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Compact stat strip
// One slim card replacing the four big stat tiles: three inline metrics so the
// hub reads as a menu, not a dashboard dump.

struct QuizStatStrip: View {
    let score: String
    let accuracy: String
    let attempts: String

    var body: some View {
        HStack(spacing: 0) {
            cell(value: score, label: "Punteggio")
            divider
            cell(value: accuracy, label: "Giuste")
            divider
            cell(value: attempts, label: "Partite")
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Statistiche. Punteggio \(score), risposte giuste \(accuracy), partite \(attempts).")
    }

    private func cell(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .monospacedDigit()
            Text(label)
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var divider: some View {
        Rectangle()
            .fill(TwoWatchTheme.border)
            .frame(width: 1, height: 30)
    }
}

// MARK: - Menu row
// Full-width navigable row — Sfide / Classifica read as a real menu instead of
// square tiles.

struct QuizMenuRow: View {
    let icon: String
    let title: String
    let subtitle: String
    let accent: Color
    var badgeCount: Int = 0

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(accent.opacity(0.2))
                Image(systemName: icon)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(accent)
            }
            .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if badgeCount > 0 {
                Text("\(badgeCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(TwoWatchTheme.brandPrimary, in: Capsule())
                    .monospacedDigit()
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 60)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

// MARK: - Thin daily-bonus bar

struct QuizBonusBar: View {
    let progress: Int
    let goal: Int
    let isActive: Bool

    private var fraction: CGFloat {
        guard goal > 0 else { return 0 }
        return min(1, CGFloat(progress) / CGFloat(goal))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(isActive ? TwoWatchTheme.brandWarm : TwoWatchTheme.textSecondary)
                Text(isActive ? "Bonus giornaliero attivo" : "Bonus giornaliero")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Spacer(minLength: 0)
                Text("\(min(progress, goal)) / \(goal)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .monospacedDigit()
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(TwoWatchTheme.panelStrong)
                    Capsule()
                        .fill(LinearGradient(
                            colors: [TwoWatchTheme.brandWarm, TwoWatchTheme.brandPrimary],
                            startPoint: .leading,
                            endPoint: .trailing
                        ))
                        .frame(width: max(6, geo.size.width * fraction))
                }
            }
            .frame(height: 7)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Bonus giornaliero, \(min(progress, goal)) di \(goal) partite.")
    }
}

#if DEBUG
#Preview("Hub Components") {
    ScrollView {
        VStack(spacing: 16) {
            QuizHeroPlayTile()
            HStack(spacing: 10) {
                QuizStatTile(label: "Punteggio", value: "47", icon: "star.fill", accent: TwoWatchTheme.brandWarm, sublabel: "totale")
                QuizStatTile(label: "Accuratezza", value: "82%", icon: "scope", accent: TwoWatchTheme.accent, sublabel: "media")
            }
            QuizMenuRow(icon: "person.2.fill", title: "Sfide", subtitle: String(localized: "Sfida un amico"), accent: TwoWatchTheme.brandSecondary, badgeCount: 2)
            QuizMenuRow(icon: "trophy.fill", title: "Classifica", subtitle: "Scopri i migliori", accent: TwoWatchTheme.brandWarm)
            QuizStreakChip(count: 4, isDaily: true)
        }
        .padding(16)
    }
    .background(TwoWatchTheme.background.ignoresSafeArea())
}
#endif
