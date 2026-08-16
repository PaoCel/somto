import SwiftUI

// MARK: - QuizGamingKit
//
// Shared "gaming" component library for the Somto Quiz section. Everything
// here is dark-theme native, reuses `TwoWatchTheme` tokens, and is built to be
// reused across solo play, leaderboard, challenges and the result screen.
//
// Design intent: push harder on gradients / glow / badges than the rest of the
// app — but only INSIDE Quiz — so the section reads as a real game without
// touching Somto's global identity.

// MARK: - Podium palette
//
// Gold / silver / bronze constants for the leaderboard podium. Kept Quiz-local
// (not added to `TwoWatchTheme`) so the global palette stays untouched.

enum QuizPodium {
    static let gold = Color(hex: "#FFCB45")
    static let silver = Color(hex: "#C9D2DC")
    static let bronze = Color(hex: "#E08A4B")

    /// Ring / accent color for a given 1-based rank (1...3). Falls back to the
    /// brand accent for ranks outside the podium.
    static func color(forRank rank: Int) -> Color {
        switch rank {
        case 1: return gold
        case 2: return silver
        case 3: return bronze
        default: return TwoWatchTheme.accent
        }
    }
}

// MARK: - Pressable style
//
// Subtle scale-down on press. Used on every tappable card in the Quiz section
// so taps feel physical without a heavy spring.

struct QuizPressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.18), value: configuration.isPressed)
    }
}

// MARK: - Glow card modifier
//
// Gives a card the consistent "hero glow" look: a continuous rounded shape, an
// optional gradient or solid fill, a 1pt inner highlight stroke, and a real
// soft outer glow shadow. Use it for hero / featured surfaces inside Quiz.

struct QuizGlowCardModifier: ViewModifier {
    var cornerRadius: CGFloat = 24
    /// When non-nil, fills the card with this gradient (hero look). When nil,
    /// falls back to a translucent panel fill (calmer featured look).
    var gradient: LinearGradient?
    /// Color of the outer glow shadow.
    var glowColor: Color = TwoWatchTheme.brandPrimary
    /// Glow strength 0...1 — drives shadow opacity + radius.
    var glowStrength: Double = 1

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(fillStyle)
            )
            .overlay(
                // Inner highlight: brighter at the top, fades down — reads as a
                // soft light source above the card.
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(gradient != nil ? 0.34 : 0.12),
                                Color.white.opacity(0.04)
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
            )
            .shadow(
                color: glowColor.opacity(0.42 * glowStrength),
                radius: 26 * glowStrength,
                y: 14 * glowStrength
            )
            .shadow(color: .black.opacity(0.35), radius: 12, y: 6)
    }

    private var fillStyle: AnyShapeStyle {
        if let gradient {
            return AnyShapeStyle(gradient)
        }
        return AnyShapeStyle(TwoWatchTheme.panel)
    }
}

extension View {
    /// Applies the Quiz "hero glow" look (see `QuizGlowCardModifier`).
    func quizGlowCard(
        cornerRadius: CGFloat = 24,
        gradient: LinearGradient? = nil,
        glowColor: Color = TwoWatchTheme.brandPrimary,
        glowStrength: Double = 1
    ) -> some View {
        modifier(QuizGlowCardModifier(
            cornerRadius: cornerRadius,
            gradient: gradient,
            glowColor: glowColor,
            glowStrength: glowStrength
        ))
    }
}

// MARK: - Progress bar
//
// Premium gradient progress bar: rounded translucent track + brand gradient
// fill with a subtle glow. Animates smoothly when `value` changes.

struct QuizProgressBar: View {
    /// 0.0 ... 1.0
    var value: Double
    var height: CGFloat = 10
    /// Fill gradient — defaults to the brand gradient.
    var gradient: LinearGradient = TwoWatchTheme.brandGradient
    /// Glow color under the fill.
    var glowColor: Color = TwoWatchTheme.brandPrimary

    private var clamped: Double { min(max(value, 0), 1) }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        Capsule(style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )

                Capsule(style: .continuous)
                    .fill(gradient)
                    .overlay(
                        // Inner top highlight on the fill.
                        Capsule(style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [Color.white.opacity(0.32), .clear],
                                    startPoint: .top,
                                    endPoint: .center
                                )
                            )
                    )
                    .frame(width: max(height, proxy.size.width * CGFloat(clamped)))
                    .shadow(color: glowColor.opacity(0.55), radius: 6, y: 0)
                    .opacity(clamped > 0 ? 1 : 0)
            }
        }
        .frame(height: height)
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: clamped)
        .accessibilityHidden(true)
    }
}

// MARK: - Status pill
//
// Colored status pill for challenge / quiz states (Completata, Gioca ora,
// Vittoria, Sconfitta, Pareggio, In attesa, ...). Clean tinted capsule.

struct QuizStatusPill: View {
    let label: String
    var tint: Color = TwoWatchTheme.accent
    var systemImage: String?
    /// When true the pill is filled with the tint (used for "live" / call to
    /// action states). When false it uses a soft tinted background.
    var filled: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2.weight(.bold))
            }
            Text(label)
                .font(.caption2.weight(.bold))
                .lineLimit(1)
        }
        .foregroundStyle(filled ? .white : tint)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(
            Capsule(style: .continuous)
                .fill(filled ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.16)))
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(tint.opacity(filled ? 0 : 0.4), lineWidth: 1)
        )
        .accessibilityLabel(label)
    }
}

// MARK: - Stat tile
//
// Icon + value + label + optional sublabel tile used in stat grids. Colored
// icon chip, big monospaced value, soft tinted background + thin border.

struct QuizStatTile: View {
    let label: LocalizedStringKey
    let value: String
    let icon: String
    var accent: Color = TwoWatchTheme.accent
    var sublabel: LocalizedStringKey?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(accent.opacity(0.18))
                    Image(systemName: icon)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(accent)
                        .accessibilityHidden(true) // decorativo
                }
                .frame(width: 34, height: 34)
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 1) {
                Text(value)
                    .font(.system(size: 26, weight: .heavy, design: .rounded))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)

                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)

                if let sublabel {
                    Text(sublabel)
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(accent.opacity(0.07))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(accent.opacity(0.22), lineWidth: 1)
        )
        // Combina icona+valore+etichetta in un unico elemento leggibile
        .accessibilityElement(children: .ignore)
        .accessibilityLabel({
            let base = "\(label): \(value)"
            if let sub = sublabel { return "\(base), \(sub)" }
            return base
        }())
    }
}

// MARK: - XP badge
//
// Compact "+N XP" / "N XP" badge. Amber-warm, faintly glowing. Used on the
// result screen and anywhere XP is surfaced.

struct QuizXPBadge: View {
    let xp: Int
    /// When true renders as a gained reward ("+N XP"), otherwise a total.
    var showsPlus: Bool = true
    var size: Size = .regular

    enum Size { case compact, regular }

    // @ScaledMetric: valori default invariati (13/16pt), scalano con la size category
    @ScaledMetric(relativeTo: .caption2) private var compactFontSize: CGFloat = 13
    @ScaledMetric(relativeTo: .callout) private var regularFontSize: CGFloat = 16

    private var valueFont: Font {
        size == .compact
            ? .system(size: compactFontSize, weight: .heavy, design: .rounded)
            : .system(size: regularFontSize, weight: .heavy, design: .rounded)
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "bolt.fill")
                .font(size == .compact ? .caption2.weight(.bold) : .caption.weight(.bold))
            Text(showsPlus ? "+\(xp) XP" : "\(xp) XP")
                .font(valueFont)
                .monospacedDigit()
        }
        .foregroundStyle(.white)
        .padding(.horizontal, size == .compact ? 9 : 12)
        .padding(.vertical, size == .compact ? 5 : 7)
        .background(
            Capsule(style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [TwoWatchTheme.warning, TwoWatchTheme.brandWarm],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .shadow(color: TwoWatchTheme.brandWarm.opacity(0.5), radius: 10, y: 4)
        .accessibilityLabel(showsPlus ? "Hai guadagnato \(xp) punti esperienza" : "\(xp) punti esperienza")
    }
}

// MARK: - Streak chip
//
// Flame + streak count. Warm tinted capsule. `daysLabel` switches the wording
// between "di fila" (consecutive corrects) and "giorni di fila" (daily streak).

struct QuizStreakChip: View {
    let count: Int
    /// When true the wording is "{n} giorni di fila" (daily streak). When
    /// false it's "{n} di fila" (in-run consecutive corrects).
    var isDaily: Bool = true
    var animate: Bool = false

    private var text: String {
        isDaily ? "\(count) giorni di fila" : "\(count) di fila"
    }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "flame.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.brandWarm)
                .symbolEffect(.bounce, value: animate ? count : 0)
            Text(text)
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.brandWarm)
                .monospacedDigit()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            Capsule(style: .continuous)
                .fill(TwoWatchTheme.brandWarm.opacity(0.16))
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(TwoWatchTheme.brandWarm.opacity(0.42), lineWidth: 1)
        )
        .accessibilityLabel(isDaily
            ? "Striscia di \(count) giorni consecutivi"
            : "\(count) risposte corrette di fila")
    }
}

// MARK: - Daily bonus card
//
// Surfaces the daily-bonus loop: gift icon, headline, a premium progress bar
// toward `goal` games, and a clear active/inactive state.

struct QuizDailyBonusCard: View {
    /// 0 ... goal
    let progress: Int
    let goal: Int
    let isActive: Bool

    private var remaining: Int { max(goal - progress, 0) }

    private var headline: String {
        isActive ? "Bonus giornaliero attivo!" : "Bonus giornaliero +20% XP"
    }

    private var subtitle: String {
        if isActive {
            return String(localized: "Stai guadagnando il 20% di XP in più su ogni partita.")
        }
        if remaining == 1 {
            return String(localized: "Gioca ancora 1 partita per attivare il bonus.")
        }
        return "Gioca \(remaining) partite per attivare il bonus."
    }

    private var accent: Color {
        isActive ? TwoWatchTheme.success : TwoWatchTheme.brandWarm
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(accent.opacity(0.2))
                    Image(systemName: isActive ? "gift.fill" : "gift")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(accent)
                        .symbolEffect(.bounce, value: isActive)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(headline)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                QuizProgressBar(
                    value: goal > 0 ? Double(progress) / Double(goal) : 0,
                    height: 9,
                    gradient: LinearGradient(
                        colors: isActive
                            ? [TwoWatchTheme.success, TwoWatchTheme.accent]
                            : [TwoWatchTheme.brandWarm, TwoWatchTheme.brandPrimary],
                        startPoint: .leading,
                        endPoint: .trailing
                    ),
                    glowColor: accent
                )
                Text("\(progress)/\(goal)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(accent)
                    .monospacedDigit()
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(accent.opacity(0.09))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(accent.opacity(0.3), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isActive
            ? "Bonus giornaliero attivo. \(subtitle)"
            : "\(headline). \(subtitle). Progresso \(progress) su \(goal).")
    }
}

// MARK: - Confetti
//
// Lightweight native confetti burst. ~36 small brand-colored pieces that fall,
// drift, rotate and fade over ~1.6s. Driven by a `trigger` value: change it
// (e.g. `trigger += 1`) to fire / re-fire the burst. No external dependency.

struct QuizConfettiView: View {
    /// Change this value to fire (or replay) the burst.
    var trigger: Int
    /// Number of pieces. Kept modest so it stays smooth on older devices.
    var pieceCount: Int = 36

    @State private var pieces: [ConfettiPiece] = []
    @State private var animate = false

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                ForEach(pieces) { piece in
                    Rectangle()
                        .fill(piece.color)
                        .frame(width: piece.size.width, height: piece.size.height)
                        .rotationEffect(.degrees(animate ? piece.spin : 0))
                        .scaleEffect(animate ? 0.85 : 1)
                        .offset(
                            x: piece.startX * proxy.size.width + (animate ? piece.drift : 0),
                            y: animate ? proxy.size.height + 60 : -50
                        )
                        .opacity(animate ? 0 : 1)
                        .animation(
                            .easeOut(duration: piece.duration).delay(piece.delay),
                            value: animate
                        )
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: trigger) { _, _ in fire() }
        .onAppear { if trigger > 0 { fire() } }
    }

    private func fire() {
        pieces = (0..<pieceCount).map { _ in ConfettiPiece.random() }
        animate = false
        // Next runloop tick so SwiftUI registers the reset before animating.
        DispatchQueue.main.async {
            withAnimation { animate = true }
        }
    }

    struct ConfettiPiece: Identifiable {
        let id = UUID()
        let color: Color
        let size: CGSize
        let startX: CGFloat
        let drift: CGFloat
        let spin: Double
        let duration: Double
        let delay: Double

        static func random() -> ConfettiPiece {
            let palette: [Color] = [
                TwoWatchTheme.brandPrimary,
                TwoWatchTheme.brandSecondary,
                TwoWatchTheme.brandWarm,
                TwoWatchTheme.accent,
                TwoWatchTheme.warning,
                TwoWatchTheme.success
            ]
            let side = CGFloat.random(in: 5...10)
            return ConfettiPiece(
                color: palette.randomElement() ?? TwoWatchTheme.brandPrimary,
                size: CGSize(width: side, height: side * CGFloat.random(in: 0.55...1.0)),
                startX: CGFloat.random(in: 0.05...0.95),
                drift: CGFloat.random(in: -90...90),
                spin: Double.random(in: -540...540),
                duration: Double.random(in: 1.2...1.9),
                delay: Double.random(in: 0...0.22)
            )
        }
    }
}

#if DEBUG
#Preview("Quiz Gaming Kit") {
    ScrollView {
        VStack(spacing: 18) {
            QuizProgressBar(value: 0.62)
            HStack(spacing: 8) {
                QuizStatusPill(label: "Completata", tint: TwoWatchTheme.success, systemImage: "checkmark")
                QuizStatusPill(label: "Gioca ora", tint: TwoWatchTheme.brandPrimary, systemImage: "play.fill", filled: true)
                QuizStatusPill(label: "In attesa", tint: TwoWatchTheme.warning, systemImage: "hourglass")
            }
            HStack(spacing: 10) {
                QuizStatTile(label: "Punteggio", value: "47", icon: "star.fill", accent: TwoWatchTheme.brandWarm, sublabel: "totale")
                QuizStatTile(label: "Accuratezza", value: "82%", icon: "scope", accent: TwoWatchTheme.accent, sublabel: "media")
            }
            HStack(spacing: 10) {
                QuizXPBadge(xp: 24)
                QuizStreakChip(count: 5, isDaily: true)
            }
            QuizDailyBonusCard(progress: 1, goal: 3, isActive: false)
            QuizDailyBonusCard(progress: 3, goal: 3, isActive: true)
        }
        .padding(16)
    }
    .background(TwoWatchTheme.background.ignoresSafeArea())
}
#endif
