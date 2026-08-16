import SwiftUI

/// Contenuto condiviso per l'invito ad amici via `ShareLink` (menu laterale +
/// CTA empty-state connessioni in `ProfileComponents.swift`). Un'unica fonte
/// di verità: stesso URL/messaggio ovunque si inviti qualcuno su Somto.
enum SomtoInviteContent {
    static let url = URL(string: "https://somto.it/")!
    static let message = String(localized: "Ti va di provare Somto con me? È il social per film e serie TV: watchlist, voti, quiz e consigli tra amici 🎬 Su iPhone è su App Store, su Android funziona come app direttamente dal sito.")
}

struct AppMenuView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var errorMessage: String?
    @State private var isDeletingAccount = false
    @State private var showsDeleteAccountConfirmation = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                identityCard

                if session.isAuthenticated {
                    quickActionsRow
                }

                shortcutsList

                accountFooter
            }
            .padding(.horizontal, 18)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    shell.dismissMenu()
                } label: {
                    Image(systemName: "xmark")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(width: 38, height: 38)
                        .background(TwoWatchTheme.panel, in: Circle())
                        .overlay(Circle().stroke(TwoWatchTheme.border, lineWidth: 1))
                }
                .accessibilityLabel("Chiudi menu")
            }
            ToolbarItem(placement: .principal) {
                BrandWordmarkView(width: 96)
            }
        }
        .alert(
            "Errore",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { _ in errorMessage = nil }
            )
        ) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    // MARK: - Identity hero

    private var identityCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                avatar

                VStack(alignment: .leading, spacing: 3) {
                    Text(session.appUser?.displayName ?? "Ospite")
                        .font(.title3.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)

                    if let handle = session.appUser?.displayNameLower, session.isAuthenticated {
                        Text("@\(handle)")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineLimit(1)
                    } else {
                        Text("Non hai effettuato l'accesso")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 0)
            }

            if !session.isAuthenticated {
                Button {
                    presentAuth()
                } label: {
                    Text("Accedi a Somto")
                        .font(.subheadline.weight(.bold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
    }

    // MARK: - Quick actions

    private var quickActionsRow: some View {
        HStack(spacing: 10) {
            quickChip(label: "Cerca", systemImage: "magnifyingglass") {
                openSearch()
            }

            quickChip(label: "Notifiche", systemImage: "bell.fill") {
                shell.dismissMenu()
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    shell.presentNotifications()
                }
            }

        }
    }

    private func quickChip(label: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text(label)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(TwoWatchTheme.panel)
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: - Shortcuts list

    private var shortcutsList: some View {
        VStack(spacing: 4) {
            sectionTitle("Naviga")

            menuRow(
                title: "Community",
                subtitle: "Feed, post e discussioni",
                systemImage: "person.2.fill",
                tint: TwoWatchTheme.brandPrimary
            ) {
                switchTo(.community, requiresAuth: false)
            }

            menuRow(
                title: "Watchlist",
                subtitle: String(localized: "Da vedere, liste e Scopri per te"),
                systemImage: "bookmark.fill",
                tint: TwoWatchTheme.accent
            ) {
                switchTo(.watchlist, requiresAuth: true)
            }

            menuRow(
                title: "Quiz",
                subtitle: "Sfide e classifica",
                systemImage: "questionmark.circle.fill",
                tint: TwoWatchTheme.brandSecondary
            ) {
                switchTo(.quiz, requiresAuth: false)
            }

            if session.isAuthenticated {
                NavigationLink {
                    ThreadsListView(container: container, session: session, shell: shell)
                } label: {
                    menuRowContent(
                        title: "Threads",
                        subtitle: "DM, gruppi, pubblici",
                        systemImage: "bubble.left.and.bubble.right.fill",
                        tint: TwoWatchTheme.success,
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
            } else {
                menuRow(
                    title: "Threads",
                    subtitle: "Richiede accesso",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    tint: TwoWatchTheme.success
                ) {
                    presentAuth()
                }
            }

            sectionTitle("Scopri")
                .padding(.top, 14)

            menuRow(
                title: "Blog",
                subtitle: "Guide e consigli su cosa guardare",
                systemImage: "newspaper.fill",
                tint: TwoWatchTheme.brandWarm
            ) {
                openBlog()
            }

            ShareLink(
                item: SomtoInviteContent.url,
                message: Text(SomtoInviteContent.message)
            ) {
                menuRowContent(
                    title: String(localized: "Invita un amico"),
                    subtitle: String(localized: "Condividi Somto con chi vuoi"),
                    systemImage: "person.badge.plus",
                    tint: TwoWatchTheme.brandPrimary,
                    showsChevron: false
                )
            }
            .buttonStyle(.plain)

            menuRow(
                title: "Importa i tuoi dati",
                subtitle: "Da TV Time o Netflix",
                systemImage: "square.and.arrow.down.fill",
                tint: TwoWatchTheme.brandSecondary
            ) {
                openImport()
            }

            sectionTitle("Profilo")
                .padding(.top, 14)

            menuRow(
                title: "Profilo",
                subtitle: "Stats e account",
                systemImage: "person.crop.circle.fill",
                tint: TwoWatchTheme.brandPrimary
            ) {
                switchTo(.profile, requiresAuth: true)
            }

            if session.isAuthenticated {
                NavigationLink {
                    ProfileInboxView(container: container, session: session, shell: shell)
                } label: {
                    menuRowContent(
                        title: "Inbox",
                        subtitle: "Richieste e consigli",
                        systemImage: "tray.full.fill",
                        tint: TwoWatchTheme.warning,
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
            }

            NavigationLink {
                SettingsView(container: container, session: session, shell: shell)
            } label: {
                menuRowContent(
                    title: "Impostazioni",
                    subtitle: "Preferenze e privacy",
                    systemImage: "gearshape.fill",
                    tint: TwoWatchTheme.textSecondary,
                    showsChevron: true
                )
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Footer (account)

    @ViewBuilder
    private var accountFooter: some View {
        if session.isAuthenticated {
            VStack(spacing: 10) {
                Divider().overlay(TwoWatchTheme.border)
                    .padding(.vertical, 6)

                Button {
                    Task {
                        do {
                            try await container.signOutEverywhere()
                            shell.dismissMenu()
                        } catch {
                            errorMessage = UserFacingError.message(for: error)
                        }
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .frame(width: 28)
                        Text("Esci")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 50)
                    .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDeletingAccount)

                Button {
                    showsDeleteAccountConfirmation = true
                } label: {
                    HStack(spacing: 12) {
                        if isDeletingAccount {
                            ProgressView().tint(.red).frame(width: 28)
                        } else {
                            Image(systemName: "trash")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(.red)
                                .frame(width: 28)
                        }
                        Text(isDeletingAccount ? "Eliminazione account..." : "Elimina account")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.red)
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 50)
                    .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(Color.red.opacity(0.14), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(isDeletingAccount)
            }
            .confirmationDialog(
                "Eliminare definitivamente l'account?",
                isPresented: $showsDeleteAccountConfirmation,
                titleVisibility: .visible
            ) {
                Button("Elimina account", role: .destructive) {
                    Task { await deleteAccount() }
                }
                Button("Annulla", role: .cancel) {}
            } message: {
                Text("L'operazione elimina l'accesso e i dati privati principali associati al profilo.")
            }
        }
    }

    // MARK: - Building blocks

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.heavy))
            .tracking(0.8)
            .foregroundStyle(TwoWatchTheme.textMuted)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 4)
    }

    private func menuRow(
        title: String,
        subtitle: String,
        systemImage: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            menuRowContent(title: title, subtitle: subtitle, systemImage: systemImage, tint: tint, showsChevron: false)
        }
        .buttonStyle(.plain)
    }

    private func menuRowContent(
        title: String,
        subtitle: String,
        systemImage: String,
        tint: Color,
        showsChevron: Bool
    ) -> some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(tint.opacity(0.16))
                    .frame(width: 40, height: 40)
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(tint)
            }

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

            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // MARK: - Avatar

    @ViewBuilder
    private var avatar: some View {
        if let url = session.appUser?.avatarURL ?? session.appUser?.photoURL {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case let .success(image): image.resizable().scaledToFill()
                default: fallbackAvatar
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(Circle())
            .overlay(Circle().stroke(Color.white.opacity(0.6), lineWidth: 2))
        } else {
            fallbackAvatar
        }
    }

    private var fallbackAvatar: some View {
        SomtoAvatar(url: nil, name: session.appUser?.displayName ?? "Somto", size: 56)
            .overlay(Circle().stroke(Color.white.opacity(0.6), lineWidth: 2))
    }

    // MARK: - Helpers

    private func switchTo(_ tab: AppTab, requiresAuth: Bool) {
        guard !requiresAuth || session.isAuthenticated else {
            presentAuth()
            return
        }
        shell.selectedTab = tab
        shell.dismissMenu()
    }

    private func openSearch() {
        shell.dismissMenu()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 150_000_000)
            shell.presentSearch()
        }
    }

    private func presentAuth() {
        shell.dismissMenu()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 150_000_000)
            shell.presentAuth()
        }
    }

    private func openBlog() {
        shell.dismissMenu()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 150_000_000)
            shell.activePresentedDestination = .web(SomtoWebLinks.blogURL)
        }
    }

    private func openImport() {
        shell.dismissMenu()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 150_000_000)
            shell.activePresentedDestination = .titlesImport(importId: nil)
        }
    }

    private func deleteAccount() async {
        guard session.isAuthenticated else { return }
        isDeletingAccount = true
        defer { isDeletingAccount = false }

        do {
            try await container.authRepository.deleteCurrentAccount()
            shell.dismissMenu()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

}

struct AppMenuButton: View {
    let shell: AppShellStore

    var body: some View {
        Button {
            shell.presentMenu()
        } label: {
            Image(systemName: "line.3.horizontal")
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
        .accessibilityLabel("Apri menu")
    }
}

#if DEBUG
#Preview("Menu") {
    NavigationStack {
        AppMenuView(
            container: TwoWatchPreview.container,
            session: TwoWatchPreview.session(),
            shell: TwoWatchPreview.shell()
        )
    }
}
#endif
