import SwiftUI

/// Scelta fatta nella schermata d'ingresso dell'onboarding v2.
///
/// Netflix non è una provenienza ma una funzione (`docs/ONBOARDING_V2.md`):
/// sta sotto una riga separatrice, non è pari a TV Time/Trakt/Letterboxd.
enum OnboardingSourceChoice: Equatable {
    /// Sorgente supportata nativamente dall'import iOS.
    case titlesImport(TitlesImportSource)
    /// Letterboxd: l'import nativo non esiste ancora su iOS, si passa da
    /// `/import.html` in-app (lavorazione manuale entro 24h).
    case letterboxdWeb
    /// "No, parto da zero" — nessun import, si va dritti agli step.
    case fromScratch

    /// Valore scritto in `usersPrivate/{uid}.onboardingStatus.source`.
    var analyticsValue: String {
        switch self {
        case let .titlesImport(source): return source.rawValue
        case .letterboxdWeb: return "letterboxd"
        case .fromScratch: return "none"
        }
    }
}

/// Prima schermata dell'onboarding: una domanda sola, "hai già una cronologia
/// da portare?". Sostituisce il carosello a 3 slide, che spiegava la tabbar
/// invece di far fare qualcosa.
struct OnboardingSourceView: View {
    var onChoose: (OnboardingSourceChoice) -> Void

    var body: some View {
        ZStack {
            TwoWatchBackground()

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    primarySources
                    secondarySource
                }
                .padding(.horizontal, 20)
                .padding(.top, 28)
                .padding(.bottom, 12)
            }
        }
        .safeAreaInset(edge: .bottom) { footer }
        .preferredColorScheme(.dark)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            BrandWordmarkView(width: 84)
                .accessibilityHidden(true)

            Text("Hai già una cronologia da portare?")
                .font(.system(size: 30, weight: .black, design: .rounded))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Text("La importiamo mentre prepari Somto.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Sorgenti

    /// Trakt per primo: è OAuth, nessun file da estrarre a mano.
    private var primarySources: some View {
        VStack(spacing: 12) {
            OnboardingSourceRow(
                label: "Trakt",
                hint: String(localized: "Ti colleghi e basta, nessun file"),
                monogram: TitlesImportSource.trakt.brandMonogram,
                brandColor: TitlesImportSource.trakt.brandColor
            ) {
                onChoose(.titlesImport(.trakt))
            }

            OnboardingSourceRow(
                label: "TV Time",
                hint: String(localized: "Serve l'export dei dati, ti spieghiamo come"),
                monogram: TitlesImportSource.tvTime.brandMonogram,
                brandColor: TitlesImportSource.tvTime.brandColor
            ) {
                onChoose(.titlesImport(.tvTime))
            }

            OnboardingSourceRow(
                label: "Letterboxd",
                hint: String(localized: "Per ora si fa dal sito"),
                monogram: "L",
                brandColor: Color(red: 0.078, green: 0.094, blue: 0.110) // Letterboxd #14181C
            ) {
                onChoose(.letterboxdWeb)
            }
        }
    }

    private var secondarySource: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Rectangle()
                    .fill(TwoWatchTheme.border)
                    .frame(height: 1)
                Text("oppure")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                Rectangle()
                    .fill(TwoWatchTheme.border)
                    .frame(height: 1)
            }

            OnboardingSourceRow(
                label: String(localized: "Ho un export Netflix"),
                hint: nil,
                monogram: TitlesImportSource.netflix.brandMonogram,
                brandColor: TitlesImportSource.netflix.brandColor,
                isCompact: true
            ) {
                onChoose(.titlesImport(.netflix))
            }
        }
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 0) {
            Button(action: { onChoose(.fromScratch) }) {
                Text("No, parto da zero")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .contentShape(Rectangle())
            }
            .accessibilityHint("Salta l'import e continua")
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .background(
            TwoWatchTheme.background
                .opacity(0.92)
                .background(.ultraThinMaterial)
                .ignoresSafeArea()
        )
    }
}

// MARK: - Riga sorgente

private struct OnboardingSourceRow: View {
    let label: String
    let hint: String?
    let monogram: String
    let brandColor: Color
    var isCompact: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                brandChip

                VStack(alignment: .leading, spacing: 3) {
                    Text(label)
                        .font(isCompact ? .subheadline.weight(.semibold) : .headline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    if let hint {
                        Text(hint)
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, isCompact ? 12 : 16)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TwoWatchTheme.panelStrong)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    private var brandChip: some View {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(brandColor)
            .frame(width: isCompact ? 32 : 40, height: isCompact ? 32 : 40)
            .overlay(
                Text(monogram)
                    .font(.system(size: isCompact ? 13 : 16, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
            )
            .accessibilityHidden(true)
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Onboarding — sorgente", traits: .fixedLayout(width: 393, height: 852)) {
    OnboardingSourceView(onChoose: { choice in print("scelta: \(choice)") })
}
#endif
