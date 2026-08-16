import SafariServices
import SwiftUI
import UIKit
import WebKit

// Componenti riutilizzabili della scheda titolo, estratti da
// TitleDetailView.swift: skeleton, stati di errore/vuoto, card e header di
// sezione, tab bar, badge, chip, avatar, card persona, trailer, Safari.
// Spostamento puro: nessuna riga di corpo cambiata.
//
// Unica modifica semantica: i tipi ancora referenziati da TitleDetailView.swift
// passano da `private` (che in Swift a livello di file vuol dire "questo file")
// a internal. Molti di questi sono candidati naturali per il design system
// della Fase 2 — TitleSectionCard, TitleBadge, TitleAverageChip e i tre
// skeleton in particolare.

struct TitleLoadingSkeletonView: View {
    let topSafeArea: CGFloat

    var body: some View {
        VStack(spacing: 24) {
            ZStack(alignment: .bottomLeading) {
                TitleSkeletonBlock(height: max(404, topSafeArea + 356), cornerRadius: 34)

                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 8) {
                        TitleSkeletonBlock(width: 62, height: 26, cornerRadius: 13)
                        TitleSkeletonBlock(width: 78, height: 26, cornerRadius: 13)
                        TitleSkeletonBlock(width: 52, height: 26, cornerRadius: 13)
                    }
                    .padding(.top, topSafeArea + 26)

                    Spacer(minLength: 0)

                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 10) {
                            TitleSkeletonBlock(width: 84, height: 30, cornerRadius: 15)
                            TitleSkeletonBlock(width: 108, height: 30, cornerRadius: 15)
                        }

                        TitleSkeletonBlock(width: 240, height: 36, cornerRadius: 12)
                        TitleSkeletonBlock(width: 186, height: 18, cornerRadius: 10)
                        TitleSkeletonBlock(width: 152, height: 18, cornerRadius: 10)

                        HStack(spacing: 12) {
                            TitleSkeletonBlock(height: 74, cornerRadius: 22)
                            TitleSkeletonBlock(height: 74, cornerRadius: 22)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .padding(.horizontal, 28)
                .padding(.bottom, 36)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 10) {
                    TitleSkeletonBlock(height: 38, cornerRadius: 19)
                    TitleSkeletonBlock(height: 38, cornerRadius: 19)
                    TitleSkeletonBlock(height: 38, cornerRadius: 19)
                    TitleSkeletonBlock(height: 38, cornerRadius: 19)
                }

                TitleSectionCard {
                    VStack(alignment: .leading, spacing: 12) {
                        TitleSkeletonBlock(width: 170, height: 22, cornerRadius: 10)
                        TitleSkeletonBlock(width: 260, height: 16, cornerRadius: 8)
                        TitleSkeletonBlock(height: 16, cornerRadius: 8)
                        TitleSkeletonBlock(height: 16, cornerRadius: 8)
                        TitleSkeletonBlock(width: 214, height: 16, cornerRadius: 8)
                        TitleSkeletonBlock(height: 208, cornerRadius: 24)
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    TitleSkeletonBlock(width: 152, height: 22, cornerRadius: 10)
                    metadataRow(width: 188)
                    metadataRow(width: 176)
                    metadataRow(width: 202)
                    metadataRow(width: 168)
                }

                VStack(alignment: .leading, spacing: 12) {
                    TitleSkeletonBlock(width: 146, height: 22, cornerRadius: 10)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(0 ..< 6, id: \.self) { _ in
                                TitleSkeletonBlock(width: 56, height: 56, cornerRadius: 18)
                            }
                        }
                    }
                }

                TitleSectionCard {
                    VStack(alignment: .leading, spacing: 14) {
                        TitleSkeletonBlock(width: 164, height: 22, cornerRadius: 10)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(0 ..< 4, id: \.self) { _ in
                                    VStack(alignment: .leading, spacing: 10) {
                                        TitleSkeletonBlock(width: 104, height: 136, cornerRadius: 22)
                                        TitleSkeletonBlock(width: 96, height: 16, cornerRadius: 8)
                                        TitleSkeletonBlock(width: 68, height: 14, cornerRadius: 8)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
    }

    private func metadataRow(width: CGFloat) -> some View {
        HStack(spacing: 8) {
            TitleSkeletonBlock(width: 14, height: 14, cornerRadius: 7)
            TitleSkeletonBlock(width: width, height: 16, cornerRadius: 8)
        }
    }
}

/// Segnaposto di "Dove guardarlo" mentre i provider arrivano dalla CF.
/// Ricalca l'ingombro reale della sezione: titolo in chiaro (l'utente sa già
/// cosa sta caricando) e una riga di loghi.
struct TitleWatchProvidersSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Dove guardarlo")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            HStack(spacing: 12) {
                ForEach(0 ..< 4, id: \.self) { _ in
                    TitleSkeletonBlock(width: 56, height: 56, cornerRadius: 18)
                }
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Carico dove guardarlo…"))
    }
}

/// Segnaposto di "Crediti principali": stessa card e stesse misure delle
/// TitlePersonCard, così quando il cast arriva la pagina non salta.
struct TitleCreditsSkeleton: View {
    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSkeletonBlock(width: 170, height: 22, cornerRadius: 10)
                TitleSkeletonBlock(width: 240, height: 14, cornerRadius: 8)

                TitleSkeletonBlock(width: 48, height: 16, cornerRadius: 8)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(0 ..< 4, id: \.self) { _ in
                            VStack(alignment: .leading, spacing: 12) {
                                TitleSkeletonBlock(width: 96, height: 112, cornerRadius: 20)
                                TitleSkeletonBlock(width: 88, height: 16, cornerRadius: 8)
                                TitleSkeletonBlock(width: 64, height: 13, cornerRadius: 7)
                            }
                            .frame(width: 104, alignment: .leading)
                            .padding(12)
                            .background(
                                TwoWatchTheme.panelStrong,
                                in: RoundedRectangle(cornerRadius: 22, style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                    .stroke(TwoWatchTheme.border, lineWidth: 1)
                            )
                        }
                    }
                    .padding(.vertical, 2)
                }
                .scrollDisabled(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Carico il cast…"))
    }
}

struct TitleErrorStateView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 40)

            Image(systemName: "film.stack.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(TwoWatchTheme.brandWarm)

            Text("Scheda non disponibile")
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)

            Button("Riprova", action: retry)
                .buttonStyle(PrimaryButtonStyle())
                .padding(.top, 4)

            Spacer(minLength: 40)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(.ultraThinMaterial.opacity(0.92))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

struct SectionEmptyStateView: View {
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    let systemImage: String
    var actionTitle: LocalizedStringKey?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(TwoWatchTheme.accent)

            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .multilineTextAlignment(.center)

            Text(message)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.accent))
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 18)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

struct TitleSectionCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        GlassCard {
            content
        }
    }
}

struct TitleSectionHeader: View {
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Card comprimibile per le sezioni social secondarie (emozioni, watchers,
/// liste). Riusa `TitleSectionCard` (GlassCard) + `TitleSectionHeader` e
/// aggiunge un header toccabile con chevron. Collassata di default per tenere
/// la tab Social calma: il contenuto pesante appare solo su richiesta.
/// Il chiamante decide se mostrare la card (hide-if-empty resta suo).
struct TitleCollapsibleSection<Content: View>: View {
    let title: String
    let subtitle: String?
    let accessibilityHintExpanded: String
    @ViewBuilder var content: Content

    @State private var expanded = false

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                Button {
                    withAnimation(.easeOut(duration: 0.22)) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        TitleSectionHeader(title: title, subtitle: subtitle)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.down")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                            .padding(.top, 2)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title)
                .accessibilityValue(expanded ? "Espansa" : "Compressa")
                .accessibilityHint(expanded ? String(localized: "Tocca per comprimere") : accessibilityHintExpanded)
                .accessibilityAddTraits(.isButton)

                if expanded {
                    content
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }
}

struct TitleDetailTabBar: View {
    let tabs: [TitleDetailTab]
    let selectedTab: TitleDetailTab
    let onSelectTab: (TitleDetailTab) -> Void

    var body: some View {
        HStack(spacing: 7) {
            ForEach(tabs) { tab in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        onSelectTab(tab)
                    }
                } label: {
                    Text(tab.rawValue)
                        .font(.caption2.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                        .foregroundStyle(selectedTab == tab ? TwoWatchTheme.background : TwoWatchTheme.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(
                            Capsule()
                                .fill(selectedTab == tab ? TwoWatchTheme.textPrimary : TwoWatchTheme.panelStrong)
                        )
                        .overlay(
                            Capsule()
                                .stroke(selectedTab == tab ? Color.clear : TwoWatchTheme.border, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.rawValue)
                .accessibilityAddTraits(selectedTab == tab ? [.isButton, .isSelected] : .isButton)
                .accessibilityHint("Passa alla sezione \(tab.rawValue)")
            }
        }
        .padding(.vertical, 2)
    }
}

struct TitleBackdropImage: View {
    let title: Title

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                if let url = title.backdropPath ?? title.posterPath {
                    CachedAsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFill()
                                .frame(width: proxy.size.width, height: proxy.size.height)
                                .clipped()
                        default:
                            TwoWatchTheme.brandGradient
                        }
                    }
                } else {
                    TwoWatchTheme.brandGradient
                }
            }
        }
        .clipped()
    }
}

struct TitleBadge: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tint.opacity(0.9), in: Capsule())
    }
}

struct TitleCapsuleLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white.opacity(0.92))
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color.white.opacity(0.14), in: Capsule())
    }
}

struct TitleHeroIconButton: View {
    let systemName: String
    var title: String? = nil
    let tint: Color
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if let title {
                    HStack(spacing: 6) {
                        Image(systemName: systemName)
                            .font(.caption.weight(.bold))
                        Text(title)
                            .font(.caption.weight(.bold))
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Color.black.opacity(0.32), in: Capsule())
                    .overlay(
                        Capsule()
                            .stroke(Color.white.opacity(0.14), lineWidth: 1)
                    )
                } else {
                    Image(systemName: systemName)
                        .frame(width: 44, height: 44)
                        .background(Color.black.opacity(0.32), in: Circle())
                        .overlay(
                            Circle()
                                .stroke(Color.white.opacity(0.14), lineWidth: 1)
                        )
                }
            }
            .font(.headline.weight(.bold))
            .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

struct TitleHeroStat: View {
    let systemName: String
    let value: String
    let tint: Color
    let isEnabled: Bool
    /// Di che media si tratta. Prima c'erano solo tre icone e tre numeri:
    /// impossibile capire quale fosse quale senza toccarli a caso.
    var caption: String = ""

    var body: some View {
        VStack(spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: systemName)
                    .font(.system(size: 10, weight: .bold))
                Text(value)
                    .font(.caption.weight(.bold))
                    .lineLimit(1)
                    .monospacedDigit()
            }

            if !caption.isEmpty {
                Text(caption)
                    .font(.system(size: 9, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .opacity(0.85)
            }
        }
        .foregroundStyle(isEnabled ? tint : TwoWatchTheme.textMuted)
        .frame(minWidth: 52)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke((isEnabled ? tint : TwoWatchTheme.textMuted).opacity(0.18), lineWidth: 1)
        )
    }
}

struct TitleAverageChip: View {
    let title: String
    let value: String
    let caption: String
    let tint: Color
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(tint)

                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                Spacer(minLength: 0)
            }

            Text(value)
                .font(.system(size: 20, weight: .black, design: .rounded))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .monospacedDigit()

            Text(caption)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textMuted)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(width: 132, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(tint.opacity(0.1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(tint.opacity(0.18), lineWidth: 1)
        )
    }
}

struct TitleMetadataItem: Identifiable {
    let label: String
    let value: String
    let systemName: String

    var id: String { label }
}

struct TitleProviderGroup: View {
    let title: String?
    /// Dove porta OGNI logo: la calcola il chiamante, che sa se per quella
    /// piattaforma esiste un link diretto.
    let destination: (StreamingProvider) -> URL?
    let providers: [StreamingProvider]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(providers) { provider in
                        TitleProviderChip(provider: provider, link: destination(provider))
                    }
                }
            }
        }
    }
}

private struct TitleProviderChip: View {
    let provider: StreamingProvider
    let link: URL?

    var body: some View {
        Group {
            if let link {
                Link(destination: link) {
                    logoContent
                }
            } else {
                logoContent
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(provider.name)
    }

    private var logoContent: some View {
        ZStack {
            Circle()
                .fill(TwoWatchTheme.panelStrong)

            Circle()
                .stroke(TwoWatchTheme.border, lineWidth: 1)

            if let logoURL = provider.logoURL {
                CachedAsyncImage(url: logoURL) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFit()
                            .frame(width: 34, height: 34)
                    default:
                        fallbackBadge
                    }
                }
            } else {
                fallbackBadge
            }
        }
        .frame(width: 56, height: 56)
        .contentShape(Circle())
    }

    private var fallbackBadge: some View {
        Text(String(provider.name.prefix(1)).uppercased())
            .font(.headline.weight(.bold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
    }
}

/// Posizione di un personaggio nella classifica dei pick community, con la
/// quota di votanti. Diverso da `CharacterAppreciation`: quella ha una soglia
/// di 5 votanti perché è un giudizio ("Amato"), questa è solo il dato grezzo
/// che motiva l'ordine dell'anteprima, e senza il dato non c'è ordine da
/// spiegare.
struct CastVoteHighlight: Equatable {
    let rank: Int
    let percent: Int
}

struct TitlePersonCard: View {
    let person: TitleCreditPerson
    /// Grado di apprezzamento del PERSONAGGIO dai pick community. Solo
    /// positivo: non è un giudizio sull'attore (docs/CHARACTER_VOTES_SPEC.md).
    var appreciation: CharacterAppreciation? = nil
    /// Presente solo nell'anteprima riordinata: è l'evidenza del perché questa
    /// card sta prima delle altre.
    var voteHighlight: CastVoteHighlight? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TwoWatchTheme.panelStrong)

                if let avatarURL = person.avatarURL {
                    CachedAsyncImage(url: avatarURL) { phase in
                        switch phase {
                        case let .success(image):
                            image
                                .resizable()
                                .scaledToFill()
                        default:
                            initialsPlaceholder
                        }
                    }
                } else {
                    initialsPlaceholder
                }
            }
            .frame(width: 96, height: 112)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

            Text(person.name)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(2)

            // La quota ha la precedenza sull'etichetta: porta lo stesso senso
            // ma col numero, e due pastiglie sulla stessa card sono rumore.
            if let voteHighlight {
                HStack(spacing: 4) {
                    Image(systemName: voteHighlight.rank == 1 ? "crown.fill" : "star.fill")
                        .font(.system(size: 9, weight: .black))
                    Text("\(voteHighlight.percent)%")
                        .font(.caption2.weight(.black))
                        .monospacedDigit()
                }
                .foregroundStyle(highlightTint)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    Capsule(style: .continuous)
                        .fill(highlightTint.opacity(0.16))
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(voteHighlightLabel))
            } else if let appreciation {
                Text(appreciation.label)
                    .font(.caption2.weight(.black))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(
                        Capsule(style: .continuous)
                            .fill(TwoWatchTheme.brandPrimary.opacity(0.16))
                    )
            }

            if let character = person.character, !character.isEmpty {
                Text(character)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .lineLimit(2)
            } else {
                Text(person.roleLabel)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
        }
        .frame(width: 104, alignment: .leading)
        .padding(12)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private var highlightTint: Color {
        voteHighlight?.rank == 1 ? TwoWatchTheme.warning : TwoWatchTheme.brandPrimary
    }

    /// La quota entra come stringa già formattata: interpolare un Int e poi un
    /// `%` letterale dentro una chiave localizzata la trasformerebbe in un
    /// format specifier monco.
    private var voteHighlightLabel: String {
        guard let voteHighlight else { return "" }
        let share = "\(voteHighlight.percent)%"
        return voteHighlight.rank == 1
            ? String(localized: "Il più votato, \(share)")
            : String(localized: "Votato dal \(share) della community")
    }

    private var initials: String {
        let components = person.name.split(whereSeparator: \.isWhitespace)
        let first = components.first?.first.map(String.init) ?? "?"
        let last = components.count > 1 ? components.last?.first.map(String.init) ?? "" : ""
        return (first + last).uppercased()
    }

    private var initialsPlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(TwoWatchTheme.panelStrong)
            Text(initials)
                .font(.title3.weight(.black))
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
    }
}

private enum TitleQuarterRatingVariant {
    case none
    case exact
    case quarterMinus
    case quarterPlus
    case half

    var isActive: Bool {
        self != .none
    }
}

private struct TitleQuarterRatingButton: View {
    let baseValue: Int
    let selectedValue: Double?
    var compact = false
    let onSelect: (Double) -> Void

    var body: some View {
        Button {
            onSelect(Double(baseValue))
        } label: {
            Text(label)
                .font((compact ? Font.caption : Font.headline).weight(.bold))
                .foregroundStyle(variant.isActive ? TwoWatchTheme.background : TwoWatchTheme.textPrimary)
                .frame(maxWidth: compact ? nil : .infinity)
                .frame(width: compact ? 36 : nil, height: compact ? 36 : 48)
                .background(backgroundShape)
                .overlay(borderShape)
        }
        .buttonStyle(.plain)
        .contextMenu {
            ForEach(options, id: \.value) { option in
                Button(option.label) {
                    onSelect(option.value)
                }
            }
        }
    }

    private var variant: TitleQuarterRatingVariant {
        guard let selectedValue else { return .none }
        let normalized = max(1, min(10, (selectedValue * 4).rounded() / 4))
        let base = Double(baseValue)

        if abs(normalized - base) < 0.001 { return .exact }
        if baseValue > 1, abs(normalized - (base - 0.25)) < 0.001 { return .quarterMinus }
        if baseValue < 10, abs(normalized - (base + 0.25)) < 0.001 { return .quarterPlus }
        if baseValue < 10, abs(normalized - (base + 0.5)) < 0.001 { return .half }
        return .none
    }

    private var label: String {
        switch variant {
        case .quarterMinus:
            return "\(baseValue)-"
        case .quarterPlus:
            return "\(baseValue)+"
        case .half:
            return "\(baseValue).5"
        case .exact, .none:
            return "\(baseValue)"
        }
    }

    private var options: [(value: Double, label: String)] {
        let base = Double(baseValue)
        var values: [(value: Double, label: String)] = []

        if baseValue > 1 {
            values.append((base - 0.25, "\(baseValue)-"))
        }
        values.append((base, "\(baseValue)"))
        if baseValue < 10 {
            values.append((base + 0.25, "\(baseValue)+"))
            values.append((base + 0.5, "\(baseValue).5"))
        }

        return values
    }

    @ViewBuilder
    private var backgroundShape: some View {
        if compact {
            Circle()
                .fill(
                    variant.isActive
                        ? AnyShapeStyle(TwoWatchTheme.brandGradient)
                        : AnyShapeStyle(TwoWatchTheme.panelStrong)
                )
        } else {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(
                    variant.isActive
                        ? AnyShapeStyle(TwoWatchTheme.brandGradient)
                        : AnyShapeStyle(TwoWatchTheme.panelStrong)
                )
        }
    }

    @ViewBuilder
    private var borderShape: some View {
        if compact {
            Circle()
                .stroke(variant.isActive ? Color.clear : TwoWatchTheme.border, lineWidth: 1)
        } else {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(variant.isActive ? Color.clear : TwoWatchTheme.border, lineWidth: 1)
        }
    }
}

private struct TitleRatingGrid: View {
    let selectedValue: Double?
    let onSelect: (Double) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 5)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(1 ... 10, id: \.self) { value in
                TitleQuarterRatingButton(
                    baseValue: value,
                    selectedValue: selectedValue,
                    onSelect: onSelect
                )
            }
        }
    }
}

/// Coordinate della discussione episodio aperta come sheet dal tab Episodi.
struct EpisodeThreadTarget: Identifiable {
    let season: Int
    let episode: Int
    var id: String { "s\(season)e\(episode)" }
}

/// Coordinate dell'episodio aperto nel voto sheet (riga episodio o nudge).
struct EpisodeRatingTarget: Identifiable {
    let season: Int
    let episode: Int
    var id: String { "s\(season)e\(episode)" }
}

private struct TitleCompactRatingStrip: View {
    let selectedValue: Double?
    var compact = false
    let onSelect: (Double) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: compact ? 6 : 8) {
                ForEach(1 ... 10, id: \.self) { value in
                    TitleQuarterRatingButton(
                        baseValue: value,
                        selectedValue: selectedValue,
                        compact: true,
                        onSelect: onSelect
                    )
                }
            }
            .padding(.vertical, 2)
        }
    }
}

struct TitleCommunityReviewCard: View {
    let review: Rating
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    private var reviewText: String {
        (review.reviewText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var author: UserSummary {
        review.author ?? UserSummary(id: review.uid, displayName: "User", photoURL: nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                NavigationLink {
                    UserProfileDetailView(container: container, session: session, shell: shell, userID: author.id)
                } label: {
                    SomtoAvatar(url: author.photoURL, name: author.displayName, size: 44, showsBorder: true)
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 10) {
                    TitleReviewAttributionText(
                        author: author,
                        watchedWith: review.watchedWith,
                        container: container,
                        session: session,
                        shell: shell
                    )

                    HStack(spacing: 8) {
                        TitleBadge(text: TitleDetailFormatter.rating(review.rating), tint: TwoWatchTheme.warning)

                        if let updated = TitleDetailFormatter.date(review.updatedAt) {
                            Text(updated)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }
                    }

                    ExpandableTextBlock(
                        isExpandable: ExpandableTextHeuristics.needsExpansion(for: reviewText, threshold: 220),
                        collapsedLineLimit: 5
                    ) { lineLimit in
                        InteractiveTaggedText(
                            source: reviewText,
                            font: .subheadline,
                            textColor: TwoWatchTheme.textSecondary,
                            lineLimit: lineLimit,
                            container: container,
                            session: session,
                            shell: shell
                        )
                        .lineSpacing(2)
                    }
                }
            }
        }
        .padding(16)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

struct TitleReviewThreadCTA: View {
    let titleID: String
    let isAuthenticated: Bool
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let onRequestAuth: () -> Void

    var body: some View {
        if isAuthenticated {
            NavigationLink {
                ThreadDetailView(
                    container: container,
                    session: session,
                    shell: shell,
                    threadID: container.threadsRepository.threadIDForPublic(titleID: titleID),
                    publicThreadSeed: .title(titleID)
                )
            } label: {
                Label("Continua nella discussione della serie", systemImage: "arrow.right.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        } else {
            Button("Accedi per vedere tutte le review") {
                onRequestAuth()
            }
            .buttonStyle(.plain)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.brandPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct TitleReviewProfileDestination: Hashable, Identifiable {
    let uid: String

    var id: String { uid }
}

private struct TitleReviewAttributionText: View {
    let author: UserSummary
    let watchedWith: [FeedTaggedUser]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var destination: TitleReviewProfileDestination?

    var body: some View {
        Text(attributedText)
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                handleOpenURL(url)
            })
            .navigationDestination(item: $destination) { target in
                UserProfileDetailView(container: container, session: session, shell: shell, userID: target.uid)
            }
    }

    private var attributedText: AttributedString {
        var output = linkedSegment(label: author.displayName, uid: author.id)

        if watchedWith.isEmpty {
            output.append(plainSegment(" ha scritto:"))
            return output
        }

        output.append(plainSegment(String(localized: " ha visto con ")))

        for (index, person) in watchedWith.enumerated() {
            if index > 0 {
                let separator = index == watchedWith.count - 1 ? " e " : ", "
                output.append(plainSegment(separator))
            }
            output.append(linkedSegment(label: person.displayName, uid: person.id))
        }

        output.append(plainSegment("."))
        return output
    }

    private func linkedSegment(label: String, uid: String) -> AttributedString {
        var segment = AttributedString(label)
        segment.foregroundColor = TwoWatchTheme.brandPrimary
        segment.link = titleReviewProfileURL(uid: uid)
        return segment
    }

    private func plainSegment(_ text: String) -> AttributedString {
        var segment = AttributedString(text)
        segment.foregroundColor = TwoWatchTheme.textPrimary
        return segment
    }

    private func handleOpenURL(_ url: URL) -> OpenURLAction.Result {
        guard url.scheme == "twowatch-review-profile" else { return .systemAction }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        guard let uid = components?.queryItems?.first(where: { $0.name == "uid" })?.value,
              !uid.isEmpty
        else {
            return .discarded
        }

        destination = TitleReviewProfileDestination(uid: uid)
        return .handled
    }
}

private func titleReviewProfileURL(uid: String) -> URL? {
    var components = URLComponents()
    components.scheme = "twowatch-review-profile"
    components.host = "user"
    components.queryItems = [URLQueryItem(name: "uid", value: uid)]
    return components.url
}

struct TitleRelatedCard: View {
    let title: Title

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PosterImageView(url: title.posterPath, width: 142, height: 212, cornerRadius: 22)

            Text(title.name)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(2)

            Text(TitleDetailFormatter.subtitle(for: title, seasons: []))
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineLimit(2)
        }
        .frame(width: 142, alignment: .leading)
        .padding(12)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

struct TitleSocialActionRow: View {
    let title: String
    let subtitle: String
    let systemName: String
    let tint: Color

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: systemName)
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 46, height: 46)
                .background(tint, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                // Decorativo: il titolo e il sottotitolo descrivono già l'azione
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                // Indicatore di navigazione decorativo
                .accessibilityHidden(true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

struct TitleOutlineButtonStyle: PrimitiveButtonStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        Button(action: configuration.trigger) {
            configuration.label
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(maxWidth: .infinity)
                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(tint.opacity(0.25), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

struct TitleSkeletonBlock: View {
    var width: CGFloat?
    let height: CGFloat
    var cornerRadius: CGFloat = 18
    @State private var isAnimating = false

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color.white.opacity(isAnimating ? 0.1 : 0.16))
            .frame(width: width, height: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .onAppear {
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                    isAnimating = true
                }
            }
    }
}

struct TitleDetailScrollOffsetReader: View {
    var body: some View {
        GeometryReader { proxy in
            Color.clear
                .preference(
                    key: TitleDetailScrollOffsetKey.self,
                    value: proxy.frame(in: .named(TitleDetailScrollSpace.name)).minY
                )
        }
        .frame(height: 0)
    }
}

enum TitleDetailScrollSpace {
    static let name = "TitleDetailScrollSpace"
}

struct TitleDetailScrollOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct EmbeddedTrailerView: UIViewRepresentable {
    let trailerURL: URL
    var onPlaybackUnavailable: (() -> Void)? = nil

    private let referrerURL = URL(string: "https://somto.it/title.html")
    private let referrerOrigin = "https://somto.it"

    func makeCoordinator() -> Coordinator {
        Coordinator(onPlaybackUnavailable: onPlaybackUnavailable)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.allowsLinkPreview = false
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let requestURL = embedURL(from: trailerURL) else { return }
        guard context.coordinator.loadedEmbedURL != requestURL else { return }

        var request = URLRequest(url: requestURL)
        if let referrerURL {
            request.setValue(referrerURL.absoluteString, forHTTPHeaderField: "Referer")
        }
        request.setValue(referrerOrigin, forHTTPHeaderField: "Origin")
        webView.load(request)
        context.coordinator.loadedEmbedURL = requestURL
        context.coordinator.hasReportedPlaybackIssue = false
    }

    private func videoID(from url: URL) -> String? {
        if url.path.contains("/embed/") {
            let candidate = url.lastPathComponent.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return candidate.isEmpty ? nil : candidate
        }

        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let videoID = components.queryItems?.first(where: { $0.name == "v" })?.value,
           !videoID.isEmpty {
            return videoID
        }

        if url.host?.contains("youtu.be") == true {
            let videoID = url.lastPathComponent.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !videoID.isEmpty {
                return videoID
            }
        }

        return nil
    }

    private func embedURL(from trailerURL: URL) -> URL? {
        guard let videoID = videoID(from: trailerURL) else { return nil }
        var components = URLComponents(string: "https://www.youtube.com/embed/\(videoID)")
        components?.queryItems = [
            URLQueryItem(name: "playsinline", value: "1"),
            URLQueryItem(name: "rel", value: "0"),
            URLQueryItem(name: "modestbranding", value: "1"),
            URLQueryItem(name: "controls", value: "1"),
            URLQueryItem(name: "origin", value: referrerOrigin),
            URLQueryItem(name: "widget_referrer", value: referrerURL?.absoluteString)
        ]
        return components?.url
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedEmbedURL: URL?
        var hasReportedPlaybackIssue = false
        private let onPlaybackUnavailable: (() -> Void)?

        init(onPlaybackUnavailable: (() -> Void)?) {
            self.onPlaybackUnavailable = onPlaybackUnavailable
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            detectPlaybackIssue(in: webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            reportPlaybackIssue()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            reportPlaybackIssue()
        }

        private func detectPlaybackIssue(in webView: WKWebView) {
            let script = "document.body ? document.body.innerText : '';"
            webView.evaluateJavaScript(script) { result, _ in
                guard let text = result as? String else { return }
                let normalized = text
                    .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
                    .lowercased()

                let markers = [
                    "error code: 152",
                    "error code: 153",
                    String(localized: "video non e disponibile"),
                    "this video is unavailable",
                    "playback on other websites has been disabled"
                ]

                if markers.contains(where: { normalized.contains($0) }) {
                    self.reportPlaybackIssue()
                }
            }
        }

        private func reportPlaybackIssue() {
            guard !hasReportedPlaybackIssue else { return }
            hasReportedPlaybackIssue = true
            DispatchQueue.main.async {
                self.onPlaybackUnavailable?()
            }
        }
    }
}

struct TitleSafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.dismissButtonStyle = .close
        return controller
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

