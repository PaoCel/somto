import SwiftUI

// Card di ripresa: "riprendi da dove eri", rewatch, invito a creare una
// lista. Estratte da WatchlistView.swift.

struct WatchlistResumeCard: View {
    let state: TitlePersonalState
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    private var headlineText: String {
        if let n = state.latestSeasonNumber, n > 0 {
            return "Stagione \(n) disponibile"
        }
        return "Nuovi episodi disponibili"
    }

    private var sublineText: String? {
        guard let air = state.latestSeasonAirDate, !air.isEmpty else { return nil }
        return "In onda dal \(air)"
    }

    var body: some View {
        if let title = state.title {
            NavigationLink {
                TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
            } label: {
                HStack(alignment: .top, spacing: 14) {
                    PosterImageView(url: title.watchlistArtworkURL, width: 72, height: 108, cornerRadius: 18)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(title.name)
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        Label(headlineText, systemImage: "sparkles.tv.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.brandWarm)
                        if let sublineText {
                            Text(sublineText)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .padding(.top, 6)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(TwoWatchTheme.brandWarm.opacity(0.10))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(TwoWatchTheme.brandWarm.opacity(0.42), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
        }
    }
}

struct WatchlistRewatchCard: View {
    let state: TitlePersonalState
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let onRemoveFromRewatch: () -> Void
    let onAddToList: () -> Void

    private var previousRatingText: String? {
        guard let value = state.ratingValue else { return nil }
        return String(format: String(localized: "Il tuo voto: %.1f"), value)
    }

    private var lastSeenText: String? {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateStyle = .medium
        formatter.timeStyle = .none

        if let completedAt = state.completedAt {
            return "Ultima visione \(formatter.string(from: completedAt))"
        }
        if let seenAt = state.seenAt {
            return "Ultima visione \(formatter.string(from: seenAt))"
        }
        return nil
    }

    var body: some View {
        if let title = state.title {
            VStack(alignment: .leading, spacing: 16) {
                NavigationLink {
                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                } label: {
                    HStack(alignment: .top, spacing: 14) {
                        PosterImageView(url: title.watchlistArtworkURL, width: 88, height: 132, cornerRadius: 22)

                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .top, spacing: 10) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(title.name)
                                        .font(.headline.weight(.bold))
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                        .multilineTextAlignment(.leading)
                                        .fixedSize(horizontal: false, vertical: true)

                                    Text(title.subtitle)
                                        .font(.subheadline)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                        .lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                }

                                Spacer(minLength: 8)

                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.black))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                    .padding(.top, 4)
                            }

                            HStack(spacing: 8) {
                                StatusChip(text: "Rewatch", tint: TwoWatchTheme.brandWarm)
                                if state.isRated {
                                    StatusChip(text: "Gia visto", tint: TwoWatchTheme.success)
                                }
                            }

                            if let previousRatingText {
                                Label(previousRatingText, systemImage: "star.fill")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.warning)
                            }

                            if let lastSeenText {
                                Label(lastSeenText, systemImage: "clock.arrow.circlepath")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)

                HStack(spacing: 12) {
                    WatchlistIconActionButton(
                        systemName: "arrow.counterclockwise.circle",
                        accessibilityLabel: "Rimuovi da rewatch",
                        tint: TwoWatchTheme.brandWarm,
                        fillOpacity: 0.14,
                        action: onRemoveFromRewatch
                    )

                    WatchlistIconActionButton(
                        systemName: "rectangle.stack.badge.plus",
                        accessibilityLabel: "Aggiungi a una lista",
                        tint: TwoWatchTheme.accent,
                        fillOpacity: 0.14,
                        action: onAddToList
                    )
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TwoWatchTheme.backgroundSecondary.opacity(0.96), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.18), radius: 18, x: 0, y: 10)
        }
    }
}

struct WatchlistCreateListEntryCard: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: "plus.circle.fill")
                    .font(.title2.weight(.black))
                    .foregroundStyle(.black)
                    .frame(width: 54, height: 54)
                    .background(Color.white, in: Circle())

                VStack(alignment: .leading, spacing: 4) {
                    Text("Crea nuova lista")
                        .font(.headline.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Raccogli titoli, percorsi o rewatch in una lista dedicata.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)

                Image(systemName: "arrow.right")
                    .font(.subheadline.weight(.black))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }
            .padding(18)
            .background(
                LinearGradient(
                    colors: [
                        TwoWatchTheme.backgroundSecondary.opacity(0.98),
                        TwoWatchTheme.brandPrimary.opacity(0.18)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: 26, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}
