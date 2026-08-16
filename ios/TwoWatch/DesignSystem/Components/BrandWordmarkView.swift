import SwiftUI

struct BrandWordmarkView: View {
    let width: CGFloat

    init(width: CGFloat = 120) {
        self.width = width
    }

    var body: some View {
        Image("SomtoWordmark")
            .resizable()
            .scaledToFit()
            .frame(width: width)
            .accessibilityLabel("Somto")
    }
}

struct ChromeBarCompactPreferenceKey: PreferenceKey {
    static let defaultValue: Bool = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

struct ChromeBarMinimalPreferenceKey: PreferenceKey {
    static let defaultValue: Bool = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

struct ChromeBarHiddenPreferenceKey: PreferenceKey {
    static let defaultValue: Bool = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

// Feedback al tap per i tasti header: al tocco il tasto si ingrigisce
// (cerchio grigio) così si capisce che il tap è stato registrato.
private struct ChromeButtonPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay(
                Circle()
                    .fill(Color.black.opacity(configuration.isPressed ? 0.16 : 0))
            )
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct BrandChromeBar: View {
    var wordmarkWidth: CGFloat = 112
    var buttonSize: CGFloat = 36
    var isCompact: Bool = false
    var showButtons: Bool = true
    var hasUnreadThreads: Bool = false
    var threadUnreadCount: Int = 0
    var unreadNotifications: Int = 0
    var onMenuTap: () -> Void
    var onSearchTap: () -> Void
    var onWordmarkTap: () -> Void
    var onChatTap: () -> Void
    var onNotificationsTap: () -> Void

    private let dropBounce: Animation = .spring(response: 0.5, dampingFraction: 0.55)

    var body: some View {
        ZStack {
            Button(action: onWordmarkTap) {
                BrandWordmarkView(width: wordmarkWidth)
                    .accessibilityHidden(true)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(
                        Capsule()
                            .fill(Color.white)
                            .shadow(color: .black.opacity(0.12), radius: 6, x: 0, y: 3)
                            .scaleEffect(isCompact ? 1 : 0.85)
                            .opacity(isCompact ? 1 : 0)
                    )
            }
            .buttonStyle(ChromeButtonPressStyle())
            .accessibilityLabel("Vai alla Home")

            HStack(spacing: 8) {
                dropButton(delay: 0.12) {
                    chromeButtonContent(systemName: "line.3.horizontal", action: onMenuTap)
                        .accessibilityLabel("Apri menu")
                }
                dropButton(delay: 0.08) {
                    chromeButtonContent(systemName: "magnifyingglass", action: onSearchTap)
                        .accessibilityLabel("Apri ricerca")
                }
                Spacer(minLength: 0)
                dropButton(delay: 0.08) {
                    chatButtonContent()
                }
                dropButton(delay: 0.12) {
                    notificationsButtonContent()
                }
            }
        }
        .frame(height: buttonSize)
        .padding(.vertical, 4)
        .background(
            Capsule()
                .fill(Color.white)
                .shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 4)
                .scaleEffect(isCompact ? 1.03 : 1)
                .opacity(isCompact ? 0 : 1)
        )
        .animation(.spring(response: 0.4, dampingFraction: 0.75), value: isCompact)
    }

    @ViewBuilder
    private func dropButton<Content: View>(delay: Double, @ViewBuilder content: () -> Content) -> some View {
        content()
            .scaleEffect(showButtons ? 1 : 0.01)
            .offset(y: showButtons ? 0 : -12)
            .opacity(showButtons ? 1 : 0)
            .animation(dropBounce.delay(showButtons ? delay : 0), value: showButtons)
    }

    // Sfondo dei tasti header: chip bianca con ombra, visibile solo in compatto
    // (quando l'header non è più un pill pieno).
    private func chromeButtonBackground() -> some View {
        Circle()
            .fill(Color.white)
            .shadow(color: .black.opacity(0.12), radius: 6, x: 0, y: 3)
            .scaleEffect(isCompact ? 1 : 0.6)
            .opacity(isCompact ? 1 : 0)
    }

    private func chromeButtonContent(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.black)
                .frame(width: buttonSize, height: buttonSize)
                .background(chromeButtonBackground())
        }
        .buttonStyle(ChromeButtonPressStyle())
    }

    private func chatButtonContent() -> some View {
        Button(action: onChatTap) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "message.fill")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.black)
                    .frame(width: buttonSize, height: buttonSize)
                    .background(chromeButtonBackground())
                if threadUnreadCount > 0 {
                    Text("\(min(threadUnreadCount, 99))")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(TwoWatchTheme.accent, in: Capsule())
                        .overlay(Capsule().stroke(Color.white, lineWidth: 1.5))
                        .offset(x: 4, y: -4)
                }
            }
        }
        .buttonStyle(ChromeButtonPressStyle())
        .accessibilityLabel(threadUnreadCount > 0 ? "Apri chat (\(threadUnreadCount) non letti)" : "Apri chat")
    }

    private func notificationsButtonContent() -> some View {
        Button(action: onNotificationsTap) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell.fill")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.black)
                    .frame(width: buttonSize, height: buttonSize)
                    .background(chromeButtonBackground())
                if unreadNotifications > 0 {
                    Text("\(min(unreadNotifications, 99))")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(TwoWatchTheme.brandPrimary, in: Capsule())
                        .overlay(Capsule().stroke(Color.white, lineWidth: 1.5))
                        .offset(x: 4, y: -4)
                }
            }
        }
        .buttonStyle(ChromeButtonPressStyle())
        .accessibilityLabel(unreadNotifications > 0 ? "Notifiche (\(unreadNotifications) non lette)" : "Notifiche")
    }
}

struct BrandChromePill: View {
    let shell: AppShellStore
    var isCompact: Bool = false
    var showButtons: Bool = true
    var horizontalPadding: CGFloat = 14
    var bottomPadding: CGFloat = 16

    var body: some View {
        BrandChromeBar(
            isCompact: isCompact,
            showButtons: showButtons,
            hasUnreadThreads: shell.threadUnreadCount > 0,
            threadUnreadCount: shell.threadUnreadCount,
            unreadNotifications: shell.notificationUnreadCount,
            onMenuTap: { shell.presentMenu() },
            onSearchTap: { shell.presentSearch() },
            onWordmarkTap: {
                if shell.selectedTab == .home {
                    shell.homeRefreshToken = UUID()
                } else {
                    shell.selectedTab = .home
                }
            },
            onChatTap: { shell.presentThreads() },
            onNotificationsTap: { shell.presentNotifications() }
        )
        .padding(.horizontal, horizontalPadding)
        .padding(.top, 2)
        .padding(.bottom, bottomPadding)
    }
}

private struct BrandChromePillWrapper<Content: View>: View {
    let shell: AppShellStore
    let isVisible: Bool
    let content: Content
    @State private var isCompact = false
    @State private var isMinimal = false
    @State private var isHidden = false

    init(shell: AppShellStore, isVisible: Bool, @ViewBuilder content: () -> Content) {
        self.shell = shell
        self.isVisible = isVisible
        self.content = content()
    }

    var body: some View {
        content
            .onPreferenceChange(ChromeBarCompactPreferenceKey.self) { value in
                isCompact = value
            }
            .onPreferenceChange(ChromeBarMinimalPreferenceKey.self) { value in
                isMinimal = value
            }
            .onPreferenceChange(ChromeBarHiddenPreferenceKey.self) { value in
                isHidden = value
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if isVisible && !isHidden {
                    BrandChromePill(shell: shell, isCompact: isCompact, showButtons: !isMinimal)
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.25), value: isHidden)
    }
}

extension View {
    @MainActor
    func brandChromePill(shell: AppShellStore, isVisible: Bool = true) -> some View {
        BrandChromePillWrapper(shell: shell, isVisible: isVisible) {
            self
        }
    }
}
