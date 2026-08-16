import SwiftUI

@Observable
@MainActor
final class QuizChallengeComposerViewModel {
    let container: AppContainer
    let session: SessionStore

    /// The two ways to start a challenge: pick a Somto friend, or generate a
    /// share link for someone not on Somto yet.
    enum Path: String, CaseIterable, Hashable {
        case friend = "Amico Somto"
        case external = "Invita esterno"
    }

    var path: Path = .friend

    // MARK: Friend path
    var friends: [AppUser] = []
    var selectedFriend: AppUser?
    var isLoadingFriends = false

    // MARK: Question source (friend path)
    /// Casuale (random from archive) vs. titolo specifico (a chosen title).
    var questionMode: QuizSetupMode = .random
    var selectedTitleId: String?
    /// Backs the "titolo specifico" vetrina; loads lazily on first use.
    let catalog: QuizTitleCatalogStore

    // MARK: External path
    var externalName: String = ""
    var inviteResult: QuizExternalInviteResult?

    // MARK: Shared
    var numQuestions: Int = 5
    var isSending = false
    var errorMessage: String?
    var sentChallengeId: String?

    init(container: AppContainer, session: SessionStore) {
        self.container = container
        self.session = session
        self.catalog = QuizTitleCatalogStore(
            container: container,
            seenTitleIds: session.completedTitleIDs
        )
    }

    var selectedTheme: QuizTheme? {
        guard let selectedTitleId else { return nil }
        return catalog.themes.first { $0.titleId == selectedTitleId }
    }

    /// Friend challenge is sendable only when the source is decided: random is
    /// always valid, a specific title needs a selection.
    var canSendFriend: Bool {
        selectedFriend != nil && (questionMode == .random || selectedTitleId != nil)
    }

    func loadFriends() async {
        guard let uid = session.appUser?.id else { return }
        isLoadingFriends = true
        defer { isLoadingFriends = false }
        do {
            friends = try await container.userRepository.listAcceptedFriends(userID: uid)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func selectFriend(_ user: AppUser) async {
        selectedFriend = user
        errorMessage = nil
    }

    // MARK: - Send (friend path)

    func send() async {
        guard let from = session.appUser?.id, let to = selectedFriend?.id else { return }
        isSending = true
        defer { isSending = false }
        do {
            let titleIds = (questionMode == .specific ? selectedTitleId.map { [$0] } : nil) ?? []
            let questions: [QuizQuestion]
            if titleIds.isEmpty {
                questions = try await container.quizRepository.fetchPlayableQuestions(count: numQuestions)
            } else {
                questions = try await container.quizRepository.fetchPlayableQuestions(titleIds: titleIds, count: numQuestions)
            }
            guard !questions.isEmpty else {
                errorMessage = String(localized: "Non ho trovato domande disponibili.")
                return
            }
            let challengeId = UUID().uuidString
            let challenge = QuizChallenge(
                challengeId: challengeId,
                fromUid: from,
                toUid: to,
                questionIds: questions.map(\.questionId),
                numQuestions: questions.count,
                status: .pending,
                fromScore: nil,
                toScore: nil,
                createdAt: Date(),
                completedAt: nil,
                sharedTitleIds: titleIds
            )
            try await container.quizRepository.sendChallenge(challenge)
            sentChallengeId = challengeId
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    // MARK: - Create external invite

    /// Titles the inviter has marked as seen — sent to the backend so the
    /// invitee gets pre-filled common ground in the onboarding screen.
    /// Sourced from the user's library via `WatchlistRepository.fetchLibrary`.
    private func fetchOwnSeenTitleIds() async -> [String] {
        guard let uid = session.appUser?.id else { return [] }
        do {
            let library = try await container.watchlistRepository.fetchLibrary(userID: uid)
            return Array(library.map(\.titleId).prefix(60))
        } catch {
            return []
        }
    }

    func createExternalInvite() async {
        guard session.appUser?.id != nil else { return }
        isSending = true
        defer { isSending = false }
        do {
            let seenIds = await fetchOwnSeenTitleIds()
            let trimmed = externalName.trimmingCharacters(in: .whitespacesAndNewlines)
            let result = try await container.quizRepository.createExternalInvite(
                placeholderName: trimmed.isEmpty ? nil : trimmed,
                numQuestions: numQuestions,
                inviterSeenTitleIds: seenIds
            )
            inviteResult = result
            sentChallengeId = result.challengeId
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

struct QuizChallengeComposerView: View {
    let container: AppContainer
    let session: SessionStore

    @State private var viewModel: QuizChallengeComposerViewModel?
    @State private var showSuccessBanner = false
    @Environment(\.dismiss) private var dismiss

    /// Message used by the share sheet for external invites.
    private static let shareMessage = String(localized: "Ti ho sfidato su Somto Quiz 🎬🔥 Registrati e giochiamo una sfida su film e serie!")

    var body: some View {
        Group {
            if let viewModel {
                content(viewModel)
            } else {
                ProgressView().tint(TwoWatchTheme.brandPrimary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Nuova sfida")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Chiudi") { dismiss() }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .accessibilityLabel("Chiudi composer sfida")
            }
        }
        .overlay(alignment: .top) {
            if showSuccessBanner {
                successBanner
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.78), value: showSuccessBanner)
        .sensoryFeedback(.success, trigger: showSuccessBanner)
        .task {
            if viewModel == nil {
                let vm = QuizChallengeComposerViewModel(container: container, session: session)
                viewModel = vm
                await vm.loadFriends()
            }
        }
    }

    private var successBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 2) {
                Text("Sfida inviata!")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                Text("La trovi nelle sfide inviate.")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.85))
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(TwoWatchTheme.success.opacity(0.92), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Sfida inviata con successo")
    }

    @ViewBuilder
    private func content(_ vm: QuizChallengeComposerViewModel) -> some View {
        @Bindable var vm = vm
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                challengeExplainerCard

                pathPicker(vm: vm)

                switch vm.path {
                case .friend:
                    friendPathBody(vm: vm)
                case .external:
                    externalPathBody(vm: vm)
                }

                if let err = vm.errorMessage {
                    errorBox(err)
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            friendSendBar(vm: vm)
        }
    }

    // MARK: - What is a challenge?

    /// Short intro so first-timers immediately understand the game: same
    /// questions for both players, highest score wins.
    private var challengeExplainerCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.2.fill")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Come funziona una sfida")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Rispondete alle stesse domande: vince chi fa più punti.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .quizGlowCard(cornerRadius: 18, glowStrength: 0)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Come funziona una sfida. Rispondete alle stesse domande: vince chi fa più punti.")
    }

    // MARK: - Path picker

    private func pathPicker(vm: QuizChallengeComposerViewModel) -> some View {
        @Bindable var vm = vm
        return VStack(alignment: .leading, spacing: 8) {
            Text("Come vuoi sfidare?")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            QuizSegmentedControl(
                options: QuizChallengeComposerViewModel.Path.allCases,
                selection: $vm.path,
                label: { $0.rawValue }
            )
        }
    }

    // MARK: - Friend path

    @ViewBuilder
    private func friendPathBody(vm: QuizChallengeComposerViewModel) -> some View {
        if vm.selectedFriend != nil {
            selectedFriendBlock(vm: vm, friend: vm.selectedFriend!)
            questionSourceSection(vm: vm)
            questionCountPicker(vm: vm)
            // The "Invia sfida" action lives in a pinned bottom bar
            // (`friendSendBar`) so it stays visible while the long "titolo
            // specifico" vetrina is scrolled.
        } else {
            friendPicker(vm: vm)
        }
    }

    /// Pinned bottom action bar for the friend path — always visible above the
    /// scroll so the send button never disappears under the title vetrina.
    @ViewBuilder
    private func friendSendBar(vm: QuizChallengeComposerViewModel) -> some View {
        if vm.path == .friend, vm.selectedFriend != nil {
            Button {
                Task {
                    await vm.send()
                    if vm.sentChallengeId != nil {
                        showSuccessBanner = true
                        try? await Task.sleep(nanoseconds: 1_200_000_000)
                        dismiss()
                    }
                }
            } label: {
                primaryLabel(
                    isBusy: vm.isSending,
                    busyText: "Invio…",
                    idleIcon: "paperplane.fill",
                    idleText: vm.questionMode == .specific && vm.selectedTitleId == nil ? "Scegli un titolo" : "Invia sfida"
                )
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(vm.isSending || !vm.canSendFriend)
            .opacity(vm.canSendFriend ? 1 : 0.5)
            .accessibilityLabel(vm.isSending ? "Invio sfida in corso" : "Invia sfida")
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .background(.ultraThinMaterial)
        }
    }

    // MARK: - Question source fork (casuale vs titolo specifico)

    @ViewBuilder
    private func questionSourceSection(vm: QuizChallengeComposerViewModel) -> some View {
        @Bindable var vm = vm
        VStack(alignment: .leading, spacing: 10) {
            Text("Da dove arrivano le domande?")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            QuizSegmentedControl(
                options: QuizSetupMode.allCases,
                selection: $vm.questionMode,
                label: { $0.label }
            )

            switch vm.questionMode {
            case .random:
                randomSourceCard
            case .specific:
                QuizTitlePickerView(store: vm.catalog, selectedTitleId: $vm.selectedTitleId)
            }
        }
        .task(id: vm.questionMode) {
            if vm.questionMode == .specific {
                await vm.catalog.loadIfNeeded()
            }
        }
    }

    private var randomSourceCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "shuffle")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)
                .frame(width: 38, height: 38)
                .background(TwoWatchTheme.brandPrimary.opacity(0.18), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Tema a sorpresa")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Le domande arrivano a caso dall'intero archivio, uguali per entrambi.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .quizGlowCard(cornerRadius: 18, glowColor: TwoWatchTheme.brandPrimary, glowStrength: 0)
    }

    private func friendPicker(vm: QuizChallengeComposerViewModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Scegli un amico")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            if vm.isLoadingFriends {
                HStack {
                    Spacer()
                    ProgressView().tint(TwoWatchTheme.brandPrimary).padding(.vertical, 24)
                    Spacer()
                }
            } else if vm.friends.isEmpty {
                EmptyStateView(
                    title: "Nessun amico ancora",
                    message: "Aggiungi qualcuno dal profilo, oppure invita un amico esterno con un link.",
                    systemImage: "person.2.slash",
                    actionTitle: "Invita un amico esterno",
                    action: { vm.path = .external }
                )
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(vm.friends, id: \.id) { friend in
                        Button {
                            Task { await vm.selectFriend(friend) }
                        } label: {
                            HStack(spacing: 12) {
                                friendAvatar(friend, size: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(friend.displayName)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                    Text("@\(friend.displayNameLower)")
                                        .font(.caption)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                            }
                            .padding(12)
                            .frame(minHeight: 44)
                            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .quizGlowCard(cornerRadius: 16, glowStrength: 0)
                        }
                        .buttonStyle(QuizPressableStyle())
                        .accessibilityLabel("Seleziona amico \(friend.displayName)")
                    }
                }
            }
        }
    }

    private func selectedFriendBlock(vm: QuizChallengeComposerViewModel, friend: AppUser) -> some View {
        HStack(spacing: 12) {
            friendAvatar(friend, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text("AVVERSARIO")
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(TwoWatchTheme.accent)
                Text(friend.displayName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }
            Spacer()
            Button {
                vm.selectedFriend = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cambia avversario")
        }
        .padding(14)
        .quizGlowCard(cornerRadius: 18, glowColor: TwoWatchTheme.accent, glowStrength: 0)
    }

    // MARK: - External path

    @ViewBuilder
    private func externalPathBody(vm: QuizChallengeComposerViewModel) -> some View {
        @Bindable var vm = vm

        externalIntroCard

        VStack(alignment: .leading, spacing: 8) {
            Text("Nome (facoltativo)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            TextField("Es. Marco", text: $vm.externalName)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
                .padding(.horizontal, 14)
                .frame(height: 48)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(TwoWatchTheme.panel)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                )
                .accessibilityLabel("Nome dell'amico da invitare")
            Text("Aiuta a riconoscere l'invito mentre aspetti che si registri.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textMuted)
        }

        questionCountPicker(vm: vm)

        if let result = vm.inviteResult {
            externalReadyBlock(result: result)
        } else {
            Button {
                Task { await vm.createExternalInvite() }
            } label: {
                primaryLabel(
                    isBusy: vm.isSending,
                    busyText: "Creo l'invito…",
                    idleIcon: "link.badge.plus",
                    idleText: "Crea invito"
                )
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(vm.isSending)
            .accessibilityLabel(vm.isSending ? "Creazione invito in corso" : "Crea invito")
        }
    }

    private var externalIntroCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "paperplane.fill")
                .font(.title3.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Invita chi non è su Somto")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Crei un link da condividere: chi lo apre si registra e gioca la sfida con te.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .quizGlowCard(cornerRadius: 18, glowStrength: 0)
    }

    private func externalReadyBlock(result: QuizExternalInviteResult) -> some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.success)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Invito pronto!")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Condividilo per far partire la sfida.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                Spacer(minLength: 0)
            }

            ShareLink(
                item: result.inviteURL,
                message: Text(Self.shareMessage)
            ) {
                HStack(spacing: 10) {
                    Image(systemName: "square.and.arrow.up")
                    Text("Condividi invito")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityLabel("Condividi il link dell'invito")

            Button {
                dismiss()
            } label: {
                Text("Fatto")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, minHeight: 44)
            .accessibilityLabel("Chiudi, torna alle sfide")
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .quizGlowCard(cornerRadius: 20, glowColor: TwoWatchTheme.success, glowStrength: 0.5)
    }

    // MARK: - Shared bits

    private func questionCountPicker(vm: QuizChallengeComposerViewModel) -> some View {
        @Bindable var vm = vm
        return VStack(alignment: .leading, spacing: 8) {
            Text("Numero domande")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            QuizSegmentedControl(
                options: [5, 10],
                selection: $vm.numQuestions,
                label: { "\($0) domande" }
            )
        }
    }

    private func primaryLabel(isBusy: Bool, busyText: String, idleIcon: String, idleText: String) -> some View {
        HStack(spacing: 10) {
            if isBusy {
                ProgressView()
                    .tint(.white)
                    .controlSize(.small)
                Text(busyText)
            } else {
                Image(systemName: idleIcon)
                Text(idleText)
            }
        }
    }

    private func errorBox(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            Text(message)
                .font(.footnote)
                .foregroundStyle(TwoWatchTheme.brandPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(TwoWatchTheme.brandPrimary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func friendAvatar(_ user: AppUser, size: CGFloat) -> some View {
        // .brand + .single: la resa gia' in uso qui.
        SomtoAvatar(
            url: user.photoURL ?? user.avatarURL,
            name: user.displayName,
            size: size,
            initialsStyle: .single
        )
    }
}

// MARK: - Quiz segmented control
//
// Premium pill segmented control for the Quiz section: the active segment is
// filled with the brand gradient and glows, the rest stay translucent. Kept
// Quiz-local so the global look is untouched.

struct QuizSegmentedControl<Option: Hashable>: View {
    let options: [Option]
    @Binding var selection: Option
    let label: (Option) -> String

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let isSelected = option == selection
                Button {
                    if !isSelected {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.easeOut(duration: 0.2)) { selection = option }
                    }
                } label: {
                    Text(label(option))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(isSelected ? .white : TwoWatchTheme.textSecondary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 40)
                        .background {
                            if isSelected {
                                Capsule(style: .continuous)
                                    .fill(TwoWatchTheme.brandGradient)
                                    .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.45), radius: 10, y: 4)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label(option))
                .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(4)
        .background(
            Capsule(style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}
