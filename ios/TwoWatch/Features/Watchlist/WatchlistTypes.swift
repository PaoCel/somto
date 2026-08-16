import SwiftUI

// Tipi di presentazione della Watchlist, estratti da WatchlistView.swift:
// l'area selezionata, la modalita' dell'editor di liste, il contesto dello
// sheet di voto, e le opzioni di filtro/ordinamento/layout di "Da vedere".
//
// Stanno qui e non in Domain/ perche' descrivono la navigazione di questa
// schermata, non il dominio.

enum WatchlistArea: String, CaseIterable, Identifiable {
    case home = "Home"
    case toWatch = "Da vedere"
    case shared = "Condivise"
    case forYou = "Per te"

    var id: String { rawValue }

    var subtitle: String {
        switch self {
        case .home:
            return "Percorsi, da vedere, condivise"
        case .toWatch:
            return "Solo titoli non ancora completati"
        case .shared:
            return String(localized: "Liste con amici e community")
        case .forYou:
            return String(localized: "Idee rapide per stasera")
        }
    }

    var symbolName: String {
        switch self {
        case .home: return "house.fill"
        case .toWatch: return "bookmark.fill"
        case .shared: return "person.2.fill"
        case .forYou: return "sparkles"
        }
    }
}

enum ListEditorMode {
    case create
    case edit(UserListDetail)

    var title: String {
        switch self {
        case .create:
            return "Nuova lista"
        case .edit:
            return "Modifica lista"
        }
    }
}

struct RatingSheetContext: Identifiable, Hashable {
    let title: Title
    var id: String { title.id }
}

extension Title {
    var watchlistArtworkURL: URL? {
        posterPath ?? backdropPath
    }

    func watchlistGenreText(using lookup: [String: String] = [:]) -> String {
        let cleanGenres = resolvedWatchlistGenres(using: lookup)
            .filter { !$0.isEmpty }

        if !cleanGenres.isEmpty {
            return cleanGenres.prefix(2).joined(separator: " • ")
        }

        return type.label
    }

    func resolvedWatchlistGenres(using lookup: [String: String] = [:]) -> [String] {
        GenreDisplay.labels(from: genres, lookup: lookup)
    }
}

enum WatchlistToWatchFilter: String, CaseIterable, Identifiable {
    case toWatch
    case inProgress
    case watched
    case all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .toWatch: return "Da vedere"
        case .inProgress: return "In corso"
        case .watched: return "Visti"
        case .all: return "Tutti"
        }
    }
}

enum WatchlistToWatchSort: String, CaseIterable, Identifiable {
    case recentlyAdded
    case title
    case year

    var id: String { rawValue }

    var label: String {
        switch self {
        case .recentlyAdded: return "Ultimi aggiunti"
        case .title: return "Titolo (A-Z)"
        case .year: return "Anno"
        }
    }

    var systemImage: String {
        switch self {
        case .recentlyAdded: return "clock.fill"
        case .title: return "textformat.abc"
        case .year: return "calendar"
        }
    }
}

enum WatchlistToWatchLayout: String, CaseIterable, Identifiable {
    case list
    case grid

    var id: String { rawValue }

    var systemImage: String {
        switch self {
        case .list: return "list.bullet"
        case .grid: return "square.grid.2x2.fill"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .list: return "Visualizzazione lista"
        case .grid: return "Visualizzazione griglia"
        }
    }
}

extension View {
    func watchlistActionFeedback(
        pendingMessage: String?,
        successMessage: String?
    ) -> some View {
        overlay {
            if let pendingMessage {
                ZStack {
                    Color.black.opacity(0.38)
                        .ignoresSafeArea()
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.large)
                            .tint(.white)
                        Text(pendingMessage)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                    }
                    .padding(24)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(pendingMessage)
                }
                .transition(.opacity)
                .allowsHitTesting(true)
                .zIndex(10)
            }
        }
        .overlay(alignment: .top) {
            if pendingMessage == nil, let successMessage {
                Label(successMessage, systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(TwoWatchTheme.success.opacity(0.96), in: Capsule())
                    .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
                    .padding(.top, 18)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .allowsHitTesting(false)
                    .accessibilityLabel(successMessage)
                    .zIndex(11)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: pendingMessage)
        .animation(.easeInOut(duration: 0.18), value: successMessage)
    }
}
