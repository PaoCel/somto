import PhotosUI
import SwiftUI

/// Step "Segui qualcuno" dell'onboarding v2. Senza nessuno da seguire il feed
/// di Community nasce vuoto e la tab sembra rotta: qui l'utente ne segue
/// qualcuno davvero, con un tap, prima ancora di arrivarci.
///
/// I suggeriti arrivano da `UserRepository.suggestedProfilesToFollow`: prima
/// chi ha in libreria i titoli appena scelti, poi i profili più attivi.
struct OnboardingFollowView: View {
    let container: AppContainer
    let session: SessionStore
    let seedTitleIds: [String]
    var onContinue: () -> Void
    /// Nessun profilo da proporre: il coordinatore salta lo step invece di
    /// mostrare una schermata vuota.
    var onEmpty: () -> Void

    @State private var profiles: [SuggestedProfile] = []
    @State private var followedUids: Set<String> = []
    @State private var pendingUids: Set<String> = []
    @State private var phase: Phase = .loading

    // Avatar: richiesta leggera, qui e non in uno step suo. È il punto in cui
    // serve davvero — stai per seguire e commentare come qualcuno.
    @State private var avatarPickerItem: PhotosPickerItem?
    @State private var avatarPreview: UIImage?
    @State private var isUploadingAvatar = false

    private enum Phase {
        case loading
        case loaded
        case failed
    }

    var body: some View {
        ZStack {
            TwoWatchBackground()

            switch phase {
            case .loading:
                loadingState
            case .failed:
                failedState
            case .loaded:
                content
            }
        }
        .safeAreaInset(edge: .bottom) {
            if phase == .loaded {
                footer
            }
        }
        .task {
            await load()
        }
    }

    // MARK: - Stati

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(TwoWatchTheme.brandPrimary)
            Text("Cerco profili per te")
                .font(.footnote)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
    }

    private var failedState: some View {
        EmptyStateView(
            title: "Qualcosa e' andato storto",
            message: "Non siamo riusciti a caricare i profili. Riprova tra poco.",
            systemImage: "wifi.exclamationmark",
            actionTitle: "Riprova",
            action: { Task { await load() } }
        )
        .padding(.horizontal, 20)
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                avatarCard

                LazyVStack(spacing: 12) {
                    ForEach(profiles) { profile in
                        OnboardingFollowRow(
                            profile: profile,
                            isFollowing: followedUids.contains(profile.id),
                            isPending: pendingUids.contains(profile.id),
                            onToggle: { Task { await toggleFollow(profile) } }
                        )
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 8)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Segui qualcuno")
                .font(.largeTitle.weight(.bold))
                .fontDesign(.rounded)
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Text("Il feed di Community è fatto da chi segui: senza nessuno resta vuoto.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Sparisce appena c'è una foto: chiesta una volta, non un promemoria
    /// permanente. Chi la salta la trova in "Modifica profilo".
    @ViewBuilder
    private var avatarCard: some View {
        if !hasAvatar {
            HStack(spacing: 14) {
                avatarThumb

                VStack(alignment: .leading, spacing: 3) {
                    Text("Metti una foto")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text("Ti riconoscono quando commenti")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                PhotosPicker(selection: $avatarPickerItem, matching: .images) {
                    Text("Scegli")
                        .font(.footnote.weight(.bold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(Capsule(style: .continuous).fill(Color.white.opacity(0.14)))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                .disabled(isUploadingAvatar)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TwoWatchTheme.panelStrong)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .onChange(of: avatarPickerItem) { _, item in
                guard let item else { return }
                Task { await uploadAvatar(item) }
            }
        }
    }

    private var avatarThumb: some View {
        ZStack {
            if let avatarPreview {
                Image(uiImage: avatarPreview)
                    .resizable()
                    .scaledToFill()
            } else {
                TwoWatchTheme.panelStrong
                Image(systemName: "person.crop.circle.badge.plus")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            if isUploadingAvatar {
                Color.black.opacity(0.35)
                ProgressView().tint(.white)
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var hasAvatar: Bool {
        avatarPreview != nil || session.appUser?.avatarURL != nil || session.appUser?.photoURL != nil
    }

    private var footer: some View {
        VStack(spacing: 8) {
            Button("Continua", action: onContinue)
                .buttonStyle(PrimaryButtonStyle())
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .background(
            TwoWatchTheme.background
                .opacity(0.92)
                .background(.ultraThinMaterial)
                .ignoresSafeArea()
        )
        .overlay(alignment: .top) {
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    // MARK: - Dati

    private func load() async {
        phase = .loading
        guard let uid = session.firebaseUser?.uid else {
            onEmpty()
            return
        }

        // Esclusi: me stesso, chi ho bloccato e chi già seguo — quest'ultimo
        // è quasi sempre vuoto in onboarding, ma lo step può essere riaperto.
        var excluded = session.blockedUserIDs
        excluded.insert(uid)
        if let following = try? await container.userRepository.listFollowing(userID: uid, limit: 60) {
            following.forEach { excluded.insert($0.id) }
        }

        do {
            let suggested = try await container.userRepository.suggestedProfilesToFollow(
                seedTitleIds: seedTitleIds,
                excluding: excluded
            )
            guard !suggested.isEmpty else {
                onEmpty()
                return
            }
            profiles = suggested
            phase = .loaded
        } catch {
            phase = .failed
        }
    }

    /// Ritaglio automatico al centro e via: in onboarding l'avatar non merita
    /// un editor di ritaglio, chi vuole aggiustarlo lo rifà da "Modifica
    /// profilo". Un fallimento è silenzioso e reversibile — la card torna
    /// disponibile, lo step non si blocca per una foto.
    private func uploadAvatar(_ item: PhotosPickerItem) async {
        guard let uid = session.firebaseUser?.uid else { return }
        isUploadingAvatar = true
        defer {
            isUploadingAvatar = false
            avatarPickerItem = nil
        }

        guard let data = try? await item.loadTransferable(type: Data.self),
              let jpeg = AvatarImageEncoder.centerSquareJPEG(from: data) else { return }

        avatarPreview = UIImage(data: jpeg)
        do {
            try await container.userRepository.updateProfile(
                userID: uid,
                newDisplayName: nil,
                photoData: jpeg
            )
            container.analytics.log(AnalyticsEvent.onboardingAvatarSet)
            await session.refreshProfile()
        } catch {
            avatarPreview = nil
        }
    }

    /// Follow ottimistico: la riga cambia subito, e se la write fallisce
    /// torna indietro. Seguire è idempotente, non serve batchare a fine step.
    private func toggleFollow(_ profile: SuggestedProfile) async {
        guard let uid = session.firebaseUser?.uid, !pendingUids.contains(profile.id) else { return }

        let wasFollowing = followedUids.contains(profile.id)
        pendingUids.insert(profile.id)
        if wasFollowing {
            followedUids.remove(profile.id)
        } else {
            followedUids.insert(profile.id)
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }

        do {
            if wasFollowing {
                try await container.userRepository.unfollowUser(myUid: uid, targetUid: profile.id)
            } else {
                try await container.userRepository.followUser(myUid: uid, targetUid: profile.id)
                container.analytics.log(AnalyticsEvent.onboardingStepFollow, [
                    "shared_titles": profile.sharedTitleCount
                ])
            }
        } catch {
            if wasFollowing {
                followedUids.insert(profile.id)
            } else {
                followedUids.remove(profile.id)
            }
        }
        pendingUids.remove(profile.id)
    }
}

// MARK: - Riga profilo

private struct OnboardingFollowRow: View {
    let profile: SuggestedProfile
    let isFollowing: Bool
    let isPending: Bool
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            avatar

            VStack(alignment: .leading, spacing: 3) {
                Text(profile.user.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)

                Text(reason)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            followButton
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(TwoWatchTheme.panelStrong)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    /// Perché lo stiamo proponendo. Frasi costanti invece di un conteggio:
    /// niente plurali da gestire su due lingue per un sottotitolo.
    private var reason: String {
        profile.hasSharedTitles
            ? String(localized: "Avete gusti simili")
            : String(localized: "Tra i più attivi")
    }

    private var avatar: some View {
        Group {
            if let url = profile.user.avatarURL ?? profile.user.photoURL {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFill()
                    default:
                        initialsCircle
                    }
                }
            } else {
                initialsCircle
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var initialsCircle: some View {
        ZStack {
            TwoWatchTheme.brandGradient
            Text(initials)
                .font(.subheadline.weight(.black))
                .foregroundStyle(.white)
        }
    }

    private var initials: String {
        let parts = profile.user.displayName
            .split(separator: " ")
            .prefix(2)
            .compactMap { $0.first }
        return parts.isEmpty ? "?" : String(parts).uppercased()
    }

    private var followButton: some View {
        Button(action: onToggle) {
            Group {
                if isPending {
                    ProgressView()
                        .tint(isFollowing ? TwoWatchTheme.textPrimary : .white)
                } else {
                    Text(isFollowing ? "Seguito" : "Segui")
                        .font(.footnote.weight(.bold))
                }
            }
            .frame(minWidth: 76)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(
                Capsule(style: .continuous)
                    .fill(isFollowing ? Color.white.opacity(0.14) : TwoWatchTheme.brandPrimary)
            )
            .foregroundStyle(isFollowing ? TwoWatchTheme.textPrimary : .white)
        }
        .buttonStyle(.plain)
        .disabled(isPending)
        .accessibilityLabel(isFollowing
            ? "Smetti di seguire \(profile.user.displayName)"
            : "Segui \(profile.user.displayName)")
    }
}
