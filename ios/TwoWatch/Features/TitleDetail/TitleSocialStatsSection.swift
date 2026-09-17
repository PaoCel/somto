import SwiftUI

// Statistiche social della scheda titolo: anello del voto medio e barre
// della distribuzione. Estratte da TitleDetailSections.swift.

struct TitleSocialStatsSection: View {
    let viewModel: TitleDetailViewModel
    let isAuthenticated: Bool
    let isCompactWidth: Bool
    let onOpenFriendsVotes: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if viewModel.communityVotesCount > 0 {
                communityDistributionCard
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Medie voto")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .textCase(.uppercase)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        friendsCard
                        communityCard
                        expertsCard
                    }
                    .padding(.vertical, 1)
                }
                .scrollClipDisabled()
            }
        }
    }

    /// Card "Voto community": anello /10 (arco proporzionale al voto medio) +
    /// distribuzione a 5 fasce. Stesso dato reale delle chip, calcolato dai
    /// rating title-level caricati in memoria (nessuna read aggiuntiva).
    private var communityDistributionCard: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 16) {
                    TitleRatingRing(
                        average: viewModel.communityAverageValue,
                        text: viewModel.communityAverageText
                    )

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Voto community")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text(votesCaption)
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }

                    Spacer(minLength: 0)
                }

                TitleRatingDistributionBars(buckets: viewModel.titleRatingBuckets)

                if isSampleCaptionVisible {
                    Text("Distribuzione su un campione di \(viewModel.loadedTitleVotesCount) voti recenti.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var votesCaption: String {
        let count = viewModel.communityVotesCount
        return String(localized: "\(count) voti")
    }

    /// Il disclaimer campione compare solo se l'aggregato server (totale voti)
    /// supera i voti effettivamente caricati (cap 50 lato fetch), così è chiaro
    /// che le barre riflettono un sottoinsieme.
    private var isSampleCaptionVisible: Bool {
        viewModel.loadedTitleVotesCount > 0 && viewModel.communityVotesCount > viewModel.loadedTitleVotesCount
    }

    private var communityCard: some View {
        TitleAverageChip(
            title: "Community",
            value: viewModel.communityAverageText,
            caption: viewModel.communityVotesCount == 0
                ? String(localized: "Nessun voto per ora")
                : String(localized: "\(viewModel.communityVotesCount) voti"),
            tint: TwoWatchTheme.brandWarm,
            icon: "person.3.fill"
        )
    }

    private var friendsCard: some View {
        Button(action: onOpenFriendsVotes) {
            TitleAverageChip(
                title: "Chi segui",
                value: viewModel.friendsAverageText,
                caption: friendsCaption,
                tint: TwoWatchTheme.accent,
                icon: "person.2.fill"
            )
        }
        .buttonStyle(.plain)
        .disabled(viewModel.friendsVotesCount == 0)
    }

    private var expertsCard: some View {
        TitleAverageChip(
            title: "Esperti",
            value: viewModel.expertsAverageText,
            caption: "In arrivo",
            tint: TwoWatchTheme.success,
            icon: "graduationcap.fill"
        )
    }

    private var friendsCaption: String {
        if !isAuthenticated {
            return String(localized: "Accedi per confrontarti con chi segui")
        }
        if viewModel.friendIDs.isEmpty {
            return "Non segui ancora nessuno"
        }
        if viewModel.friendsVotesCount == 0 {
            return String(localized: "Gli amici non hanno votato ancora")
        }
        return String(localized: "\(viewModel.friendsVotesCount) voti")
    }
}

/// Anello del voto community: arco proporzionale al voto medio (avg/10),
/// che parte da ore 12 in senso orario, con il numero al centro. Sostituisce
/// il bordo pieno (uguale per tutti) con un dato reale, come sul web.
struct TitleRatingRing: View {
    let average: Double?
    let text: String

    private var fraction: Double {
        guard let average else { return 0 }
        return max(0, min(1, average / 10))
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(TwoWatchTheme.panelStrong, lineWidth: 6)

            Circle()
                .trim(from: 0, to: fraction)
                .stroke(
                    TwoWatchTheme.brandGradient,
                    style: StrokeStyle(lineWidth: 6, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.25), value: fraction)

            // Solo il numero: l'anello stesso comunica la proporzione su 10,
            // quindi il suffisso "/10" era ridondante.
            Text(text)
                .font(.system(size: 24, weight: .heavy, design: .rounded))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .monospacedDigit()
        }
        .frame(width: 76, height: 76)
        .accessibilityElement()
        .accessibilityLabel("Voto medio community")
        .accessibilityValue("\(text) su 10")
    }
}

/// Barre di distribuzione dei voti community su /10 a 5 fasce. Le larghezze
/// sono normalizzate sulla fascia più popolata (come il web), così anche una
/// distribuzione piatta resta leggibile. Riusa lo stesso pattern di barra
/// della sezione emozioni.
struct TitleRatingDistributionBars: View {
    let buckets: [TitleRatingBucket]

    private var maxFraction: Double {
        max(0.0001, buckets.map(\.fraction).max() ?? 0)
    }

    var body: some View {
        VStack(spacing: 8) {
            ForEach(buckets) { bucket in
                row(bucket)
            }
        }
    }

    private func row(_ bucket: TitleRatingBucket) -> some View {
        HStack(spacing: 10) {
            Text(bucket.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .monospacedDigit()
                .frame(width: 40, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(TwoWatchTheme.panel)
                    Capsule()
                        .fill(TwoWatchTheme.brandGradient)
                        .frame(width: geo.size.width * relativeWidth(bucket))
                }
            }
            .frame(height: 8)

            Text(bucket.count > 0 ? "\(Int((bucket.fraction * 100).rounded()))%" : "—")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .monospacedDigit()
                .frame(width: 40, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Voti \(bucket.label)")
        .accessibilityValue(bucket.count > 0 ? "\(Int((bucket.fraction * 100).rounded())) percento" : "nessun voto")
    }

    private func relativeWidth(_ bucket: TitleRatingBucket) -> Double {
        max(0, min(1, bucket.fraction / maxFraction))
    }
}

/// Sezione community String(localized: "Che impressione ha fatto") — top 5 emozioni per count
/// con barra percentuale. Se `totalUsers < 3` le percentuali sono nascoste
/// (numeri piccoli fuorvianti), solo emoji+label. Se l'utente ha selezioni
/// proprie, sono evidenziate. Empty state: se l'utente ha visto il titolo,
/// CTA per lasciare la propria impressione; altrimenti la sezione non appare.
