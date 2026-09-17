import SwiftUI

// Sezione "Da vedere": barra filtri, toolbar, raggruppamento per
// piattaforma, stato vuoto. Estratti da WatchlistView.swift.

struct WatchlistToWatchFilterBar: View {
    @Binding var selectedFilter: WatchlistToWatchFilter
    let counts: [WatchlistToWatchFilter: Int]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(WatchlistToWatchFilter.allCases) { filter in
                    let isSelected = selectedFilter == filter
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            selectedFilter = filter
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(filter.label)
                                .font(.subheadline.weight(.semibold))
                            Text("\(counts[filter] ?? 0)")
                                .font(.caption.weight(.bold))
                                .monospacedDigit()
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(
                                    (isSelected ? Color.black.opacity(0.18) : TwoWatchTheme.panel),
                                    in: Capsule()
                                )
                        }
                        .foregroundStyle(isSelected ? Color.black : TwoWatchTheme.textPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(
                            isSelected
                                ? AnyShapeStyle(TwoWatchTheme.accent)
                                : AnyShapeStyle(TwoWatchTheme.panelStrong),
                            in: Capsule()
                        )
                        .overlay(
                            Capsule()
                                .stroke(isSelected ? Color.clear : TwoWatchTheme.border, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(filter.label), \(counts[filter] ?? 0) titoli")
                    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 1)
        }
        .scrollClipDisabled()
    }
}

struct WatchlistToWatchToolbar: View {
    @Binding var sort: WatchlistToWatchSort
    @Binding var layout: WatchlistToWatchLayout
    @Binding var groupByPlatform: Bool
    let canGroupByPlatform: Bool
    let visibleCount: Int

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Text("\(visibleCount) titoli")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(TwoWatchTheme.textSecondary)

            Spacer(minLength: 6)

            if canGroupByPlatform {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        groupByPlatform.toggle()
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "square.stack.3d.up.fill")
                            .font(.caption.weight(.bold))
                        Text("Raggruppa")
                            .font(.caption.weight(.semibold))
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .foregroundStyle(groupByPlatform ? Color.black : TwoWatchTheme.textPrimary)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
                    .background(
                        groupByPlatform
                            ? AnyShapeStyle(TwoWatchTheme.accent)
                            : AnyShapeStyle(Color.clear),
                        in: Capsule()
                    )
                    .overlay(Capsule().stroke(groupByPlatform ? Color.clear : TwoWatchTheme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Raggruppa per piattaforma")
                .accessibilityAddTraits(groupByPlatform ? [.isSelected] : [])
            }

            Menu {
                Picker("Ordina", selection: $sort) {
                    ForEach(WatchlistToWatchSort.allCases) { option in
                        Label(option.label, systemImage: option.systemImage).tag(option)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.arrow.down")
                        .font(.caption.weight(.bold))
                    Text(sort.label)
                        .font(.caption.weight(.semibold))
                        .fixedSize(horizontal: true, vertical: false)
                }
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background(Color.clear, in: Capsule())
                .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
            }
            .accessibilityLabel("Ordina per \(sort.label)")

            Picker("Visualizzazione", selection: $layout) {
                ForEach(WatchlistToWatchLayout.allCases) { option in
                    Image(systemName: option.systemImage)
                        .accessibilityLabel(option.accessibilityLabel)
                        .tag(option)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 92)
            .accessibilityLabel("Stile visualizzazione")
        }
    }
}

// MARK: - Platform filter / grouping

struct WatchlistPlatformGroup: Identifiable {
    let id: String
    let title: String
    let states: [TitlePersonalState]
}

struct WatchlistPlatformFilterBar: View {
    let platforms: [String]
    var logos: [String: URL] = [:]
    @Binding var selection: String?

    private let circleDiameter: CGFloat = 40

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                allChip
                ForEach(platforms, id: \.self) { platform in
                    logoChip(label: platform, logoURL: logos[platform])
                }
            }
            .padding(.horizontal, 1)
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
    }

    /// Chip testuale "Tutte" — resta una pill, invariata come stile.
    @ViewBuilder
    private var allChip: some View {
        let isSelected = selection == nil
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { selection = nil }
        } label: {
            Text("Tutte")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(isSelected ? Color.black : TwoWatchTheme.textPrimary)
                .padding(.horizontal, 14)
                .frame(height: circleDiameter)
                .background(
                    isSelected
                        ? AnyShapeStyle(TwoWatchTheme.accent)
                        : AnyShapeStyle(TwoWatchTheme.panelStrong),
                    in: Capsule()
                )
                .overlay(
                    Capsule()
                        .stroke(isSelected ? Color.clear : TwoWatchTheme.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Tutte le piattaforme")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    /// Chip circolare solo-logo per una piattaforma. Sfondo bianco per leggibilità
    /// dei marchi streaming sul tema scuro; selezione = ring accent + leggero scale.
    @ViewBuilder
    private func logoChip(label: String, logoURL: URL?) -> some View {
        let isSelected = selection == label
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { selection = label }
        } label: {
            ZStack {
                Circle()
                    .fill(Color.white)

                if logoURL != nil {
                    WatchlistProviderLogoView(
                        name: label,
                        logoURL: logoURL,
                        height: 22,
                        textColor: Color.black
                    )
                    .padding(6)
                } else {
                    Text(String(label.prefix(1)).uppercased())
                        .font(.headline.weight(.bold))
                        .foregroundStyle(Color.black)
                }
            }
            .frame(width: circleDiameter, height: circleDiameter)
            .clipShape(Circle())
            .overlay(
                Circle()
                    .stroke(isSelected ? TwoWatchTheme.accent : TwoWatchTheme.border,
                            lineWidth: isSelected ? 3 : 1)
            )
            .scaleEffect(isSelected ? 1.08 : 1.0)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Piattaforma \(label)")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

struct WatchlistPlatformGroupHeader: View {
    let title: String
    let count: Int
    var logoURL: URL? = nil

    var body: some View {
        HStack(spacing: 8) {
            if let logoURL {
                WatchlistProviderLogoView(name: title, logoURL: logoURL, height: 18)
                    .accessibilityHidden(true) // il testo accanto già porta il nome
            }
            Text(title)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text("\(count)")
                .font(.caption.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(TwoWatchTheme.panel, in: Capsule())
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(count) titoli")
    }
}

struct WatchlistToWatchEmptyState: View {
    let filter: WatchlistToWatchFilter
    let onExploreTitles: () -> Void

    private var title: String {
        switch filter {
        case .toWatch: return String(localized: "Niente da vedere ancora")
        case .inProgress: return String(localized: "Nessuna serie in corso")
        case .watched: return String(localized: "Nessun titolo visto")
        case .all: return String(localized: "La tua watchlist è vuota")
        }
    }

    private var message: String {
        switch filter {
        case .toWatch:
            return String(localized: "Salva film e serie che ti incuriosiscono: te li ritrovi qui pronti per stasera. Qui vive quello che devi ancora vedere. I titoli che segni come visti finiscono nel tuo Profilo, sotto «Visti».")
        case .inProgress:
            return String(localized: "Quando inizi una serie (o la rivedi da capo), la trovi qui finché non la finisci.")
        case .watched:
            return String(localized: "Quando segni un film come visto o completi una serie, la cronologia compare in questa scheda.")
        case .all:
            return String(localized: "Aggiungi qualcosa alla tua watchlist o scopri le uscite della settimana per partire.")
        }
    }

    var body: some View {
        GlassCard {
            VStack(spacing: 14) {
                Image(systemName: filter == .watched ? "checkmark.seal.fill" : (filter == .inProgress ? "play.circle.fill" : "bookmark.slash.fill"))
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.accent)

                Text(title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .multilineTextAlignment(.center)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                if filter != .watched {
                    VStack(spacing: 10) {
                        Button("Cerca un titolo", action: onExploreTitles)
                            .buttonStyle(PrimaryButtonStyle())
                    }
                    .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

// MARK: - Grid cell

/// Testo compatto per il badge piattaforma: prima piattaforma + "+N" se ce ne sono altre.
/// Condiviso da grid cell e list card della tab "Da vedere".
func watchlistPlatformBadgeText(_ names: [String]) -> String? {
    guard let first = names.first else { return nil }
    return names.count > 1 ? "\(first) +\(names.count - 1)" : first
}

/// Contenuto del badge piattaforma sulla card: mini-logo (h ~14pt) al posto del
/// nome testuale, resta il "+N" testuale se ci sono altre piattaforme. Fallback
/// testo se il logo non è (ancora) disponibile per quel nome.
struct WatchlistPlatformBadgeContent: View {
    let names: [String]
    var logos: [String: URL] = [:]
    var textColor: Color = .white

    var body: some View {
        if let first = names.first {
            HStack(spacing: 4) {
                WatchlistProviderLogoView(name: first, logoURL: logos[first], height: 14, textColor: textColor)
                    .accessibilityHidden(true) // il badge intero porta già la label
                if names.count > 1 {
                    Text("+\(names.count - 1)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(textColor)
                }
            }
        }
    }
}
