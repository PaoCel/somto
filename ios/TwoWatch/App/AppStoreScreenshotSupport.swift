#if DEBUG
import SwiftUI

enum AppStoreScreenshotScene: String, CaseIterable {
    case home
    case match
    case watchlist
    case search
    case title
    case notifications
    case profile

    static var current: AppStoreScreenshotScene? {
        let rawValue = ProcessInfo.processInfo.environment["APP_STORE_SCREENSHOT_SCENE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return rawValue.flatMap(Self.init(rawValue:))
    }

    var selectedTab: AppTab? {
        switch self {
        case .home:
            return .home
        case .watchlist:
            return .watchlist
        case .match, .notifications:
            // Match is no longer a tab (it lives inside Watchlist → "Scopri per
            // te"); notifications was never a tab either. Both scenes render as
            // standalone NavigationStacks.
            return nil
        case .profile:
            return .profile
        case .search, .title:
            return nil
        }
    }
}

struct AppStoreScreenshotRoot: View {
    let scene: AppStoreScreenshotScene
    private let session = TwoWatchPreview.session()

    var body: some View {
        Group {
            switch scene {
            case .home:
                tabbedShell(selectedTab: .home) { shell in
                    NavigationStack {
                        HomeView(
                            container: TwoWatchPreview.container,
                            session: session,
                            shell: shell,
                            previewViewModel: TwoWatchPreview.homeViewModel(),
                            previewScrollOffset: 140
                        )
                    }
                }
            case .match:
                // Match is no longer a tab; render it standalone for screenshots.
                NavigationStack {
                    MatchView(
                        container: TwoWatchPreview.container,
                        session: session,
                        shell: TwoWatchPreview.shell(),
                        previewViewModel: TwoWatchPreview.matchViewModel()
                    )
                }
            case .watchlist:
                tabbedShell(selectedTab: .watchlist) { shell in
                    NavigationStack {
                        WatchlistView(
                            container: TwoWatchPreview.container,
                            session: session,
                            shell: shell,
                            previewViewModel: TwoWatchPreview.watchlistViewModel()
                        )
                    }
                }
            case .profile:
                tabbedShell(selectedTab: .profile) { shell in
                    NavigationStack {
                        ProfileView(
                            container: TwoWatchPreview.container,
                            session: session,
                            shell: shell,
                            previewViewModel: TwoWatchPreview.profileViewModel(),
                            previewSelectedTab: .reviews
                        )
                    }
                }
            case .notifications:
                NavigationStack {
                    NotificationsView(
                        container: TwoWatchPreview.container,
                        session: session,
                        shell: TwoWatchPreview.shell(),
                        previewViewModel: TwoWatchPreview.notificationsViewModel()
                    )
                }
            case .search:
                NavigationStack {
                    SearchView(
                        container: TwoWatchPreview.container,
                        session: session,
                        shell: TwoWatchPreview.shell(),
                        previewViewModel: TwoWatchPreview.searchViewModel()
                    )
                }
            case .title:
                NavigationStack {
                    TitleDetailView(
                        container: TwoWatchPreview.container,
                        session: session,
                        shell: TwoWatchPreview.shell(),
                        titleID: TwoWatchPreview.secondTitle.id,
                        previewViewModel: TwoWatchPreview.titleDetailViewModel()
                    )
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func tabbedShell<Content: View>(
        selectedTab: AppTab,
        @ViewBuilder content: @escaping (AppShellStore) -> Content
    ) -> some View {
        ScreenshotTabShell(selectedTab: selectedTab, content: content)
    }
}

private struct ScreenshotTabShell<Content: View>: View {
    let selectedTab: AppTab
    let content: (AppShellStore) -> Content
    @State private var shell: AppShellStore

    init(selectedTab: AppTab, @ViewBuilder content: @escaping (AppShellStore) -> Content) {
        self.selectedTab = selectedTab
        self.content = content
        _shell = State(initialValue: TwoWatchPreview.shell(selectedTab: selectedTab))
    }

    var body: some View {
        TabView(selection: $shell.selectedTab) {
            tabItem(.home, label: "Home", systemImage: "house.fill")
            tabItem(.community, label: "Community", systemImage: "person.2.fill")
            tabItem(.watchlist, label: "Watchlist", systemImage: "bookmark.fill")
            tabItem(.quiz, label: "Quiz", systemImage: "questionmark.circle.fill")
            tabItem(.profile, label: "Profilo", systemImage: "person.crop.circle.fill")
        }
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarBackground(TwoWatchTheme.tabMaterial, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
    }

    @ViewBuilder
    private func tabItem(_ tab: AppTab, label: String, systemImage: String) -> some View {
        Group {
            if tab == selectedTab {
                content(shell)
            } else {
                Color.clear
            }
        }
        .tabItem {
            Label(label, systemImage: systemImage)
        }
        .tag(tab)
    }
}
#endif
