import SwiftUI

// Sheet delle connessioni e il layout a capo dei chip. Estratti da
// ProfileComponents.swift.

struct ProfileConnectionsSheet: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let title: String
    let systemImage: String
    let users: [AppUser]

    @State private var searchText = ""

    private var filteredUsers: [AppUser] {
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return users }
        let query = searchText.lowercased()
        return users.filter {
            $0.displayName.lowercased().contains(query) || $0.displayNameLower.lowercased().contains(query)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Label(title, systemImage: systemImage)
                        .font(.headline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("\(filteredUsers.count) contatti")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(TwoWatchTheme.textMuted)
                    TextField("Cerca...", text: $searchText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
                .padding(12)
                .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                if filteredUsers.isEmpty {
                    if users.isEmpty {
                        // Lista vuota (non una ricerca senza esito): mostra la CTA di invito.
                        VStack(spacing: 14) {
                            EmptyStateView(
                                title: "Ancora nessun contatto",
                                message: "Invita chi conosci a unirsi a Somto.",
                                systemImage: "person.slash"
                            )

                            ShareLink(
                                item: SomtoInviteContent.url,
                                message: Text(SomtoInviteContent.message)
                            ) {
                                HStack(spacing: 8) {
                                    Image(systemName: "person.badge.plus")
                                    Text("Invita chi non è ancora su Somto")
                                }
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 44)
                            }
                            .buttonStyle(PrimaryButtonStyle())
                        }
                    } else {
                        EmptyStateView(
                            title: "Nessun risultato",
                            message: "Prova con un altro nome.",
                            systemImage: "person.slash"
                        )
                    }
                } else {
                    VStack(spacing: 10) {
                        ForEach(filteredUsers) { user in
                            NavigationLink {
                                UserProfileDetailView(container: container, session: session, shell: shell, userID: user.id)
                            } label: {
                                ProfileConnectionRow(user: user)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(TwoWatchBackground())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ProfileConnectionRow: View {
    let user: AppUser

    var body: some View {
        HStack(spacing: 12) {
            avatar
                .frame(width: 46, height: 46)
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                Text(user.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)

                Text("@\(user.displayNameLower)")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(.vertical, 2)
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
                        .font(.subheadline.weight(.bold))
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


// MARK: - Avatar zoom

/// Overlay a schermo intero: mostra la foto profilo ingrandita dentro un cerchio.
/// Tap ovunque (o sulla X) per chiudere.
