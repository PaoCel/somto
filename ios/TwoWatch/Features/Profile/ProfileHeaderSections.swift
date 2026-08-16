import SwiftUI

// Testa del profilo: hero identita' e header con azioni. Estratti da
// ProfileComponents.swift.

struct ProfileIdentityHero: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let user: AppUser
    let followers: [AppUser]
    let following: [AppUser]
    // Default a 0: la #Preview in fondo al file non li passa.
    var watchedCount: Int = 0
    var reviewCount: Int = 0
    var showsBrandWordmark = false
    var supportingText: String?

    @State private var activeTab: ProfileConnectionsTab?

    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#5F6777")

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                avatar
                    .frame(width: 64, height: 64)
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .stroke(Color.white.opacity(0.88), lineWidth: 2.5)
                    )
                    .avatarZoomable(url: user.avatarURL ?? user.photoURL, initials: initials)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .center, spacing: 6) {
                        Text(user.displayName)
                            .font(.title3.weight(.black))
                            .foregroundStyle(textPrimary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)

                        if user.verified {
                            Image(systemName: "checkmark.seal.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.brandPrimary)
                                .accessibilityLabel("Profilo verificato")
                        }
                    }

                    Text("@\(user.displayNameLower)")
                        .font(.caption)
                        .foregroundStyle(textSecondary)
                }

                Spacer(minLength: 0)
            }

            if let supportingText, supportingText.isEmpty == false {
                Text(supportingText)
                    .font(.subheadline)
                    .foregroundStyle(textSecondary)
            }

            // Stesse quattro metriche del profilo pubblico
            // (UserProfileDetailView.publicProfileMetrics): prima qui c'era
            // "Amici", che contava users/{uid}/friends — il grafo delle
            // richieste di amicizia, dismesso in favore dei soli follower.
            HStack(spacing: 12) {
                ProfileStaticInlineMetric(
                    title: String(localized: "Visti"),
                    value: "\(watchedCount)"
                )

                ProfileMetricDivider()

                // "Voti", non "Review": il numero conta i titoli votati
                // (stats.ratingsCount), mentre il tab Review elenca solo i voti
                // con testo — due numeri diversi sotto la stessa parola.
                ProfileStaticInlineMetric(
                    title: String(localized: "Voti"),
                    value: "\(reviewCount)"
                )

                ProfileMetricDivider()

                ProfileConnectionsInlineMetric(
                    title: "Follower",
                    count: followers.count
                ) {
                    activeTab = .followers
                }

                ProfileMetricDivider()

                ProfileConnectionsInlineMetric(
                    title: "Seguiti",
                    count: following.count
                ) {
                    activeTab = .following
                }
            }
        }
        .sheet(item: $activeTab) { tab in
            NavigationStack {
                ProfileConnectionsSheet(
                    container: container,
                    session: session,
                    shell: shell,
                    title: tab.title,
                    systemImage: tab.systemImage,
                    users: users(for: tab)
                )
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    private func users(for tab: ProfileConnectionsTab) -> [AppUser] {
        switch tab {
        case .followers:
            return followers
        case .following:
            return following
        }
    }

    private var avatar: some View {
        CachedAsyncImage(url: user.avatarURL ?? user.photoURL) { phase in
            switch phase {
            case let .success(image):
                image
                    .resizable()
                    .scaledToFill()
            default:
                ZStack {
                    TwoWatchTheme.brandGradient
                    Text(initials)
                        .font(.title.bold())
                        .foregroundStyle(.white)
                }
            }
        }
    }

    private var initials: String {
        let parts = user.displayName.split(whereSeparator: \.isWhitespace)
        let first = parts.first?.first.map(String.init) ?? "?"
        let last = parts.count > 1 ? parts.last?.first.map(String.init) ?? "" : ""
        return (first + last).uppercased()
    }

}

struct ProfileTopHeader: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let user: AppUser
    let followers: [AppUser]
    let following: [AppUser]
    var watchedCount: Int = 0
    var reviewCount: Int = 0
    @State private var showsDeleteConfirmation = false
    @State private var showsLogoutConfirmation = false
    @State private var deletionErrorMessage: String?
    @State private var isDeletingAccount = false
    @State private var showsEditProfile = false

    var body: some View {
        // Identità+metriche in flow normale, poi la riga di azioni (condividi/modifica/menu)
        // SOTTO, non più in overlay assoluto: così il nome ha sempre tutto lo spazio della
        // card e non rischia mai di finire sotto ai tasti.
        VStack(alignment: .leading, spacing: 14) {
            ProfileIdentityHero(
                container: container,
                session: session,
                shell: shell,
                user: user,
                followers: followers,
                following: following,
                watchedCount: watchedCount,
                reviewCount: reviewCount
            )
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 6) {
                Spacer(minLength: 0)

                if let shareURL = profileShareURL(forUserID: user.id) {
                    ShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(.black)
                            .frame(width: 32, height: 32)
                            .background(Color.black.opacity(0.06), in: Circle())
                    }
                    // Area tocco ≥44pt; chip visivo resta 32pt
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Condividi profilo")
                }

                Button {
                    showsEditProfile = true
                } label: {
                    Image(systemName: "pencil")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.black)
                        .frame(width: 32, height: 32)
                        .background(Color.black.opacity(0.06), in: Circle())
                }
                .buttonStyle(.plain)
                // Area tocco ≥44pt; chip visivo resta 32pt
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .accessibilityLabel("Modifica profilo")

                if session.isAuthenticated {
                    Menu {
                        Button(role: .destructive) {
                            showsLogoutConfirmation = true
                        } label: {
                            Label("Logout", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                        Button(role: .destructive) {
                            showsDeleteConfirmation = true
                        } label: {
                            Label("Elimina account", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(.black)
                            .frame(width: 32, height: 32)
                            .background(Color.black.opacity(0.06), in: Circle())
                    }
                    // Area tocco ≥44pt; chip visivo resta 32pt
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Altre azioni account")
                }
            }
        }
        .padding(16)
        .background(Color(hex: "#FCFBF6"), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(Color.black.opacity(0.06), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.12), radius: 16, y: 8)
        .alert("Eliminare l'account?", isPresented: $showsDeleteConfirmation) {
            Button("Annulla", role: .cancel) {}
            Button(isDeletingAccount ? "Eliminazione..." : "Elimina account", role: .destructive) {
                guard !isDeletingAccount else { return }
                    isDeletingAccount = true
                    Task {
                        defer { isDeletingAccount = false }
                        do {
                            try await container.authRepository.deleteCurrentAccount()
                        } catch {
                            deletionErrorMessage = UserFacingError.message(for: error)
                        }
                    }
            }
        } message: {
            Text("L'accesso verrà revocato subito. I dati principali del profilo e le relazioni private verranno rimossi; alcuni contenuti pubblici potrebbero essere trattenuti o anonimizzati per motivi legali, sicurezza o integrità del servizio.")
        }
        .alert("Uscire dall'account?", isPresented: $showsLogoutConfirmation) {
            Button("Annulla", role: .cancel) {}
            Button("Logout", role: .destructive) {
                Task { try? await container.signOutEverywhere() }
            }
        } message: {
            Text("Dovrai accedere di nuovo per usare watchlist, quiz e profilo.")
        }
        .alert("Impossibile eliminare l'account", isPresented: Binding(
            get: { deletionErrorMessage != nil },
            set: { if !$0 { deletionErrorMessage = nil } }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(deletionErrorMessage ?? "")
        }
        .sheet(isPresented: $showsEditProfile) {
            NavigationStack {
                EditProfileView(
                    container: container,
                    session: session,
                    currentUser: user
                )
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

}

/// Unità di visualizzazione del tempo di visione, ciclabile con un tap sul blocco
/// numerico. `dhm` mantiene l'aspetto storico a 3 blocchi (giorni:ore:min);
/// le altre modalità mostrano un unico valore+unità.

#if DEBUG
#Preview("Hero profilo") {
    ScrollView {
        ProfileIdentityHero(
            container: TwoWatchPreview.container,
            session: TwoWatchPreview.session(),
            shell: TwoWatchPreview.shell(selectedTab: .profile),
            user: TwoWatchPreview.currentUser,
            followers: [TwoWatchPreview.friendUser],
            following: [TwoWatchPreview.friendUser],
            showsBrandWordmark: true,
            supportingText: String(localized: "Anteprima dedicata per iterare rapidamente sul layout del profilo.")
        )
        .padding(20)
    }
    .background(TwoWatchBackground())
}
#endif
