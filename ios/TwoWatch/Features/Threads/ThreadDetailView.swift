@preconcurrency import FirebaseFirestore
import Observation
import SwiftUI
import UIKit
import UserNotifications

/// Origine del thread pubblico da inizializzare al primo accesso.
/// - `title`: discussione a livello titolo (comportamento storico).
/// - `season`: discussione di una stagione.
/// - `episode`: discussione di un singolo episodio (gate spoiler d'ingresso,
///   nessun blur per messaggio).
enum PublicThreadSeed {
    case title(String)
    case season(titleID: String, season: Int)
    case episode(titleID: String, season: Int, episode: Int)

    /// True per le discussioni episodio: la view usa questo flag per il gate
    /// d'ingresso e per bypassare il blur per-messaggio.
    var isEpisode: Bool {
        if case .episode = self { return true }
        return false
    }

    /// True per stagione ed episodio: entrambe hanno un gate spoiler
    /// d'ingresso (entrare nella discussione della stagione 4 espone al
    /// finale di stagione tanto quanto quella dell'ultimo episodio).
    var needsSpoilerEntryGate: Bool {
        switch self {
        case .title: return false
        case .season, .episode: return true
        }
    }
}

@Observable
@MainActor
final class ThreadDetailViewModel {
    private let threadID: String
    private let publicThreadSeed: PublicThreadSeed?
    private let repository: ThreadsRepository
    private let userRepository: UserRepository

    @ObservationIgnored private var messagesListener: ListenerRegistration?
    @ObservationIgnored private var typingListener: ListenerRegistration?
    @ObservationIgnored private var allMessages: [ThreadMessage] = []
    @ObservationIgnored private var blockedUserIDs: Set<String> = []
    @ObservationIgnored private var currentUserID: String?

    var thread: AppThread?
    var messages: [ThreadMessage] = []
    var typingUsers: [ThreadTypingUser] = []
    var isLoading = false
    var isSending = false
    var isAcceptingSafetyTerms = false
    var requiresSafetyAcceptance = false
    var errorMessage: String?
    var successMessage: String?
    var reactionOperations: Set<String> = []
    var moderationMessageIDs: Set<String> = []
    var blockingUserIDs: Set<String> = []
    var isReportingThread = false

    init(threadID: String, publicThreadSeed: PublicThreadSeed?, repository: ThreadsRepository, userRepository: UserRepository) {
        self.threadID = threadID
        self.publicThreadSeed = publicThreadSeed
        self.repository = repository
        self.userRepository = userRepository
    }

    /// True quando la discussione è a livello stagione o episodio: la view
    /// mostra il gate spoiler d'ingresso e non applica il blur per singolo
    /// messaggio (il gate ha già avvisato per tutto il thread).
    var isScopedThread: Bool {
        publicThreadSeed?.needsSpoilerEntryGate ?? false
    }

    /// Ambito della discussione: prima dal seed, poi (fallback) dal thread
    /// caricato. Così l'intestazione dice cosa si sta commentando anche quando
    /// il thread è aperto da una lista, senza seed.
    var scope: ThreadScope {
        switch publicThreadSeed {
        case .title:
            return .title
        case .season(_, let season):
            return .season(season)
        case .episode(_, let season, let episode):
            return .episode(season: season, episode: episode)
        case .none:
            guard let thread else { return .title }
            return thread.scope
        }
    }

    /// Coordinate stagione/episodio, quando l'ambito le ha.
    var scopeCoordinates: (season: Int, episode: Int?)? {
        scope.coordinates
    }

    var isConversationBlocked: Bool {
        guard let thread, !thread.isPublic, let currentUserID else { return false }
        return thread.participants.contains { participantID in
            participantID != currentUserID && blockedUserIDs.contains(participantID)
        }
    }

    /// In una DM 1:1 restituisce l'altro partecipante se è un profilo guidato (sintetico),
    /// così la UI può mostrare la disclosure e disabilitare l'invio di messaggi personali.
    var guidedDirectMessagePartner: AppUser? {
        guard let thread, thread.contextType == .dm else { return nil }
        return thread.participantUsers.first { participant in
            participant.id != currentUserID && participant.isGuidedProfile
        }
    }

    var isGuidedDirectMessage: Bool {
        guidedDirectMessagePartner != nil
    }

    /// True quando la view è stata aperta con un seed pubblico: serve alla UI
    /// per scegliere il layout board già al primo frame, prima che il documento
    /// del thread arrivi da Firestore.
    var publicThreadSeedExists: Bool {
        publicThreadSeed != nil
    }

    /// Numero di persone distinte che hanno scritto nel thread: dato reale,
    /// calcolato sui messaggi già in memoria (nessuna query extra).
    var participantCount: Int {
        Set(messages.map(\.uid)).count
    }

    func load(currentUserID: String, currentUserName: String, currentUser: AppUser?) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            self.currentUserID = currentUserID
            let resolvedUser = try? await userRepository.fetchUser(uid: currentUserID)
            requiresSafetyAcceptance = !((resolvedUser ?? currentUser)?.hasAcceptedCommunitySafetyTerms ?? false)
            blockedUserIDs = Set((try? await userRepository.fetchBlockedUserIDs(userID: currentUserID)) ?? [])

            switch publicThreadSeed {
            case .title(let titleID):
                _ = try await repository.ensurePublicThread(titleID: titleID, createdBy: currentUserID)
            case .season(let titleID, let season):
                _ = try await repository.ensureSeasonPublicThread(
                    titleID: titleID,
                    season: season,
                    createdBy: currentUserID
                )
            case .episode(let titleID, let season, let episode):
                _ = try await repository.ensureEpisodePublicThread(
                    titleID: titleID,
                    season: season,
                    episode: episode,
                    createdBy: currentUserID
                )
            case .none:
                break
            }

            thread = try await repository.fetchThread(id: threadID)
            guard thread != nil else {
                errorMessage = "Thread non trovato."
                return
            }

            subscribeMessages()
            subscribeTyping(currentUserID: currentUserID)
            applyMessageVisibility()
            repository.markThreadRead(threadID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func syncCommunitySafety(currentUser: AppUser?) {
        requiresSafetyAcceptance = !(currentUser?.hasAcceptedCommunitySafetyTerms ?? false)
    }

    func handleDraftChange(currentUserID: String, currentUserName: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requiresSafetyAcceptance, !isConversationBlocked else { return }
        Task {
            if trimmed.isEmpty {
                await repository.clearTyping(threadID: threadID, uid: currentUserID)
            } else {
                try? await repository.setTyping(threadID: threadID, uid: currentUserID, displayName: currentUserName)
            }
        }
    }

    func send(
        currentUserID: String,
        currentUserName: String,
        text: String,
        containsSpoiler: Bool = false,
        spoilerTitleIDs: [String] = []
    ) async -> Bool {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return false }
        guard !requiresSafetyAcceptance, !isConversationBlocked else { return false }

        isSending = true
        errorMessage = nil
        defer { isSending = false }

        do {
            try await repository.sendMessage(
                threadID: threadID,
                senderUID: currentUserID,
                displayName: currentUserName,
                text: body,
                containsSpoiler: containsSpoiler,
                spoilerTitleIDs: spoilerTitleIDs
            )
            await repository.clearTyping(threadID: threadID, uid: currentUserID)
            repository.markThreadRead(threadID)
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return false
        }
    }

    /// Invia una GIF (type "gif"). Il corpo testuale resta vuoto; il flag
    /// spoiler del composer viene propagato come per un messaggio normale.
    func sendGif(
        currentUserID: String,
        currentUserName: String,
        gifURL: String,
        containsSpoiler: Bool = false,
        spoilerTitleIDs: [String] = []
    ) async -> Bool {
        let url = gifURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return false }
        guard !requiresSafetyAcceptance, !isConversationBlocked else { return false }

        isSending = true
        errorMessage = nil
        defer { isSending = false }

        do {
            try await repository.sendMessage(
                threadID: threadID,
                senderUID: currentUserID,
                displayName: currentUserName,
                text: "",
                containsSpoiler: containsSpoiler,
                spoilerTitleIDs: spoilerTitleIDs,
                gifURL: url
            )
            await repository.clearTyping(threadID: threadID, uid: currentUserID)
            repository.markThreadRead(threadID)
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return false
        }
    }

    func toggleReaction(message: ThreadMessage, emoji: String, currentUserID: String) async {
        let operationID = "\(message.id)|\(emoji)"
        guard !reactionOperations.contains(operationID) else { return }
        reactionOperations.insert(operationID)
        defer { reactionOperations.remove(operationID) }
        let alreadyReacted = message.reactions[emoji]?.contains(currentUserID) ?? false
        do {
            try await repository.toggleReaction(
                threadID: threadID,
                messageID: message.id,
                emoji: emoji,
                uid: currentUserID,
                isAdding: !alreadyReacted
            )
            // L'aggiornamento della UI arriva dal listener sui messaggi (come la web).
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func acceptCommunitySafety(currentUserID: String) async -> Bool {
        isAcceptingSafetyTerms = true
        errorMessage = nil
        defer { isAcceptingSafetyTerms = false }

        do {
            try await userRepository.acceptCommunitySafetyTerms(userID: currentUserID)
            requiresSafetyAcceptance = false
            successMessage = "Termini community accettati. Ora puoi usare la chat."
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return false
        }
    }

    func reportThread(from currentUserID: String) async {
        guard !isReportingThread else { return }
        isReportingThread = true
        defer { isReportingThread = false }
        do {
            try await userRepository.submitModerationReport(
                fromUid: currentUserID,
                type: "thread",
                targetId: threadID,
                reason: "Discussione segnalata per verifica moderazione.",
                metadata: [
                    "threadId": threadID,
                    "source": "ios_thread_header"
                ]
            )
            successMessage = "Segnalazione inviata al team di moderazione."
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func reportMessage(_ message: ThreadMessage, from currentUserID: String) async {
        guard !moderationMessageIDs.contains(message.id) else { return }
        moderationMessageIDs.insert(message.id)
        defer { moderationMessageIDs.remove(message.id) }
        do {
            try await userRepository.submitModerationReport(
                fromUid: currentUserID,
                type: "thread",
                targetId: threadID,
                reason: "Messaggio segnalato per contenuto o comportamento inappropriato.",
                metadata: [
                    "threadId": threadID,
                    "messageId": message.id,
                    "reportedUid": message.uid,
                    "preview": String(message.displayText.prefix(160)),
                    "source": "ios_thread_message"
                ]
            )
            successMessage = "Messaggio segnalato correttamente."
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func blockUser(_ targetUserID: String, from currentUserID: String) async {
        guard !blockingUserIDs.contains(targetUserID) else { return }
        blockingUserIDs.insert(targetUserID)
        defer { blockingUserIDs.remove(targetUserID) }
        do {
            try await userRepository.blockUser(myUid: currentUserID, targetUid: targetUserID)
            blockedUserIDs.insert(targetUserID)
            applyMessageVisibility()
            successMessage = "Utente bloccato. I suoi messaggi non saranno più mostrati."
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markRead() {
        repository.markThreadRead(threadID)
    }

    func handleDisappear(currentUserID: String) {
        Task {
            await repository.clearTyping(threadID: threadID, uid: currentUserID)
        }
    }

    deinit {
        messagesListener?.remove()
        typingListener?.remove()
    }

    private func subscribeMessages() {
        messagesListener?.remove()
        messagesListener = repository.listenMessages(threadID: threadID) { [weak self] items in
            guard let self else { return }
            Task { @MainActor in
                self.allMessages = items
                self.applyMessageVisibility()
            }
        }
    }

    private func subscribeTyping(currentUserID: String) {
        typingListener?.remove()
        typingListener = repository.listenTyping(threadID: threadID, currentUserID: currentUserID) { [weak self] users in
            guard let self else { return }
            Task { @MainActor in
                self.typingUsers = users
            }
        }
    }

    private func applyMessageVisibility() {
        messages = allMessages.filter { !blockedUserIDs.contains($0.uid) }
    }
}

struct ThreadDetailView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let threadID: String
    let publicThreadSeed: PublicThreadSeed?

    @State private var viewModel: ThreadDetailViewModel
    @State private var messageComposer: SocialComposerViewModel
    @State private var composerContainsSpoiler: Bool = false
    @State private var composerSpoilerTitleIDs: [String] = []
    @State private var isGifPickerPresented = false

    // Chat assistenza: pre-prompt inline per attivare le notifiche push, così
    // l'utente sa subito quando arriva la risposta senza riaprire l'app.
    @State private var pushAuthStatus: UNAuthorizationStatus = .notDetermined
    @State private var isRequestingPush = false
    @State private var supportBannerDismissed = false
    @Environment(\.openURL) private var openURL
    // Gate spoiler d'ingresso: solo per le discussioni episodio. Superato il
    // gate, i messaggi si mostrano senza blur per-messaggio (il gate ha già
    // fatto da avviso spoiler per l'intero thread).
    @State private var spoilerGatePassed = false

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        threadID: String,
        publicThreadSeed: PublicThreadSeed? = nil
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.threadID = threadID
        self.publicThreadSeed = publicThreadSeed
        _viewModel = State(initialValue: ThreadDetailViewModel(
            threadID: threadID,
            publicThreadSeed: publicThreadSeed,
            repository: container.threadsRepository,
            userRepository: container.userRepository
        ))
        _messageComposer = State(initialValue: SocialComposerViewModel(
            titleRepository: container.titleRepository,
            userRepository: container.userRepository,
            topicScope: .titlesAndPeople,
            characterLimit: 5000
        ))
    }

    var body: some View {
        @Bindable var viewModel = viewModel

        VStack(spacing: 0) {
            if !session.isAuthenticated {
                EmptyStateView(
                    title: "Accedi per aprire il thread",
                    message: "Le discussioni del catalogo sono disponibili solo agli utenti autenticati.",
                    systemImage: "bubble.left.and.exclamationmark.bubble.right.fill",
                    actionTitle: "Accedi"
                ) {
                    shell.presentAuth()
                }
                .padding(20)
            } else {
                threadBody
            }
        }
        .background(TwoWatchBackground())
        .navigationTitle(navigationTitleText)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: session.firebaseUser?.uid) {
            if let currentUserID = session.firebaseUser?.uid {
                let currentUserName = session.appUser?.displayName
                    ?? session.firebaseUser?.displayName
                    ?? "User"
                await viewModel.load(
                    currentUserID: currentUserID,
                    currentUserName: currentUserName,
                    currentUser: session.appUser
                )
                pushAuthStatus = await container.pushNotifications.currentAuthorizationStatus()
            }
        }
        .onChange(of: session.appUser?.hasAcceptedCommunitySafetyTerms) { _, _ in
            viewModel.syncCommunitySafety(currentUser: session.appUser)
        }
        .onDisappear {
            if let currentUserID = session.firebaseUser?.uid {
                viewModel.handleDisappear(currentUserID: currentUserID)
            }
        }
        .alert("Errore", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { _ in viewModel.errorMessage = nil }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    private var threadBody: some View {
        VStack(spacing: 0) {
            if let thread = viewModel.thread {
                threadHeader(thread)
            }

            if showSupportPushBanner {
                supportPushBanner()
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
            }

            if let successMessage = viewModel.successMessage {
                successBanner(successMessage) {
                    viewModel.successMessage = nil
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
            }

            if viewModel.requiresSafetyAcceptance {
                safetyGate
            } else if viewModel.isScopedThread && !spoilerGatePassed {
                episodeSpoilerEntryGate
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        // Board: interventi impilati con separatori sottili, non
                        // bolle affiancate. `spacing: 0` perché ogni riga porta
                        // il proprio padding + divider (vedi `MessageRow`).
                        LazyVStack(spacing: isBoardLayout ? 0 : 6) {
                            if viewModel.messages.isEmpty && !viewModel.isLoading {
                                EmptyStateView(
                                    title: "Ancora nessun messaggio",
                                    message: isBoardLayout
                                        ? "Apri tu la discussione: scrivi cosa ne pensi."
                                        : "Apri tu la conversazione: il primo messaggio popolerà il thread in tempo reale.",
                                    systemImage: "bubble.left.circle.fill"
                                )
                            } else {
                                ForEach(Array(viewModel.messages.enumerated()), id: \.element.id) { index, message in
                                    let previous = index > 0 ? viewModel.messages[index - 1] : nil
                                    MessageRow(
                                        message: message,
                                        isMine: message.uid == session.firebaseUser?.uid,
                                        // Discussione pubblica → board compatto;
                                        // DM e gruppi restano bolle di chat.
                                        usesBoardLayout: isBoardLayout,
                                        // Consecutivi dello stesso autore: header
                                        // ripetuto solo se cambia autore o passa
                                        // più di 10 minuti.
                                        isGroupedWithPrevious: isBoardLayout && Self.isGrouped(message, after: previous),
                                        isFirstRow: index == 0,
                                        // Nei thread scoped il gate d'ingresso ha già
                                        // avvisato: niente blur per singolo messaggio.
                                        bypassPerMessageSpoiler: viewModel.isScopedThread,
                                        onOpenProfile: {
                                            shell.activePresentedDestination = .profile(uid: message.uid)
                                        },
                                        onReport: {
                                            guard let currentUserID = session.firebaseUser?.uid else { return }
                                            Task { await viewModel.reportMessage(message, from: currentUserID) }
                                        },
                                        onBlock: {
                                            guard let currentUserID = session.firebaseUser?.uid else { return }
                                            Task { await viewModel.blockUser(message.uid, from: currentUserID) }
                                        },
                                        onToggleReaction: { emoji in
                                            guard let currentUserID = session.firebaseUser?.uid else { return }
                                            Task { await viewModel.toggleReaction(message: message, emoji: emoji, currentUserID: currentUserID) }
                                        },
                                        isReactionPending: viewModel.reactionOperations.contains { $0.hasPrefix("\(message.id)|") },
                                        isModerationPending: viewModel.moderationMessageIDs.contains(message.id)
                                            || viewModel.blockingUserIDs.contains(message.uid)
                                    )
                                    .id(message.id)
                                }
                            }
                        }
                        .padding(.horizontal, isBoardLayout ? 16 : 20)
                        .padding(.top, isBoardLayout ? 6 : 18)
                        .padding(.bottom, 12)
                    }
                    .onChange(of: viewModel.messages.count) { _, _ in
                        if let lastID = viewModel.messages.last?.id {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(lastID, anchor: .bottom)
                            }
                        }
                        viewModel.markRead()
                    }
                    .scrollDismissesKeyboard(.interactively)
                    // Tap sull'area messaggi = chiudi tastiera. NON sul body intero:
                    // altrimenti ogni tap nella casella di testo (spostare cursore,
                    // selezionare/copiare) chiudeva la tastiera e bloccava l'input.
                    .simultaneousGesture(TapGesture().onEnded { dismissKeyboard() })
                }

                if viewModel.isConversationBlocked {
                    blockedConversationNotice
                } else if viewModel.isGuidedDirectMessage {
                    guidedProfileDirectMessageNotice
                } else {
                    if !viewModel.typingUsers.isEmpty {
                        Text(typingText)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 6)
                    }

                    composer
                }
            }
        }
    }

    /// Le discussioni pubbliche usano il layout "board" (interventi impilati,
    /// separatori sottili). DM e gruppi restano bolle di chat: lì la metafora
    /// della conversazione a due è quella giusta.
    private var isBoardLayout: Bool {
        viewModel.thread?.isPublic ?? (viewModel.publicThreadSeedExists)
    }

    /// Due messaggi consecutivi dello stesso autore entro 10 minuti si
    /// raggruppano: l'header (avatar + nome + ora) non si ripete. È ciò che
    /// permette di leggere molti più interventi a schermo.
    static func isGrouped(_ message: ThreadMessage, after previous: ThreadMessage?) -> Bool {
        guard let previous, previous.uid == message.uid else { return false }
        guard let current = message.createdAt, let earlier = previous.createdAt else { return false }
        return current.timeIntervalSince(earlier) < 600
    }

    /// Titolo nav: nome (serie/DM) + coordinate se la discussione è di stagione
    /// o episodio, così anche la barra dice su cosa si sta commentando.
    private var navigationTitleText: String {
        let base = viewModel.thread?.displayName(currentUserID: session.firebaseUser?.uid) ?? "Thread"
        guard let coords = viewModel.scopeCoordinates else { return base }
        if let episode = coords.episode {
            return "\(base) · S\(coords.season)E\(episode)"
        }
        return "\(base) · Stagione \(coords.season)"
    }

    /// Intestazione della discussione: **sempre** la barra compatta —
    /// locandina piccola, nome del titolo (tap → scheda), ambito e menu.
    /// Con la tastiera aperta la card alta delle chat private non lasciava
    /// spazio ai messaggi (feedback di Paolo 2026-07-30), quindi la card è
    /// stata ritirata anche lì.
    @ViewBuilder
    private func threadHeader(_ thread: AppThread) -> some View {
        publicThreadHeaderBar(thread)
    }

    @ViewBuilder
    private func publicThreadHeaderBar(_ thread: AppThread) -> some View {
        HStack(alignment: .center, spacing: 10) {
            if let title = thread.title {
                NavigationLink {
                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                } label: {
                    HStack(alignment: .center, spacing: 10) {
                        PosterImageView(url: title.posterPath, width: 34, height: 50, cornerRadius: 8)
                        headerTextStack(name: title.name)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                headerTextStack(name: thread.displayName(currentUserID: session.firebaseUser?.uid))
            }

            Spacer(minLength: 0)

            threadOverflowMenu
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(TwoWatchTheme.panel.opacity(0.9))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    private func headerTextStack(name: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(name)
                .font(.system(size: 14, weight: .heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(1)

            HStack(spacing: 6) {
                ThreadScopeBadge(scope: viewModel.scope, compact: true)
                if let activity = headerActivityText {
                    Text(activity)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .monospacedDigit()
                }
            }
        }
    }

    /// "12 commenti · 4 persone": dato reale sui messaggi già caricati.
    private var headerActivityText: String? {
        // "N commenti" ha senso solo sulle bacheche pubbliche: in una chat
        // privata la conta dei messaggi è rumore.
        guard isBoardLayout else { return nil }
        let messages = viewModel.messages.count
        guard messages > 0 else { return nil }
        let people = viewModel.participantCount
        let commentsText = String(localized: "\(messages) commenti")
        guard people > 1 else { return commentsText }
        return "\(commentsText) · \(people) persone"
    }

    private var threadOverflowMenu: some View {
        Menu {
            Button {
                shell.activePresentedDestination = .web(CommunitySafetyPolicy.termsURL)
            } label: {
                Label("Termini community", systemImage: "doc.text")
            }

            Button {
                shell.activePresentedDestination = .web(CommunitySafetyPolicy.supportURL)
            } label: {
                Label("Supporto e moderazione", systemImage: "shield")
            }

            Button(role: .destructive) {
                guard let currentUserID = session.firebaseUser?.uid else { return }
                Task { await viewModel.reportThread(from: currentUserID) }
            } label: {
                Label(viewModel.isReportingThread ? "Invio…" : "Segnala discussione", systemImage: "flag.fill")
            }
            .disabled(viewModel.isReportingThread)
        } label: {
            Group {
                if viewModel.isReportingThread {
                    ProgressView()
                        .tint(TwoWatchTheme.textSecondary)
                } else {
                    Image(systemName: "ellipsis.circle.fill")
                }
            }
            .font(.title3.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.textSecondary, Color.white)
        }
        .disabled(viewModel.isReportingThread)
        .accessibilityLabel("Azioni discussione")
    }

    @ViewBuilder

    private var safetyGate: some View {
        VStack(spacing: 16) {
            GlassCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Accetta i termini community per usare la chat", systemImage: "checkmark.shield.fill")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text("Somto applica una policy di tolleranza zero verso contenuti offensivi, spam e utenti abusivi. I messaggi vengono filtrati automaticamente, possono essere segnalati e i profili possono essere bloccati.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)

                    HStack(spacing: 12) {
                        Button("Termini") {
                            shell.activePresentedDestination = .web(CommunitySafetyPolicy.termsURL)
                        }
                        .buttonStyle(.bordered)
                        .tint(TwoWatchTheme.textSecondary)

                        Button("Supporto") {
                            shell.activePresentedDestination = .web(CommunitySafetyPolicy.supportURL)
                        }
                        .buttonStyle(.bordered)
                        .tint(TwoWatchTheme.textSecondary)

                        Spacer(minLength: 0)
                    }

                    Button {
                        guard let currentUserID = session.firebaseUser?.uid else {
                            shell.presentAuth()
                            return
                        }
                        Task {
                            let didAccept = await viewModel.acceptCommunitySafety(currentUserID: currentUserID)
                            if didAccept {
                                await session.refreshProfile()
                            }
                        }
                    } label: {
                        if viewModel.isAcceptingSafetyTerms {
                            ProgressView()
                                .tint(.white)
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Accetta e continua")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(.horizontal, 20)

            Spacer(minLength: 0)
        }
        .padding(.top, 20)
    }

    /// Avviso spoiler d'ingresso (una tantum) per le discussioni di stagione o
    /// episodio. Serve da unico gate spoiler del thread: superato, i messaggi si
    /// mostrano senza blur per-messaggio.
    private var episodeSpoilerEntryGate: some View {
        let coords = viewModel.scopeCoordinates
        return VStack(spacing: 16) {
            GlassCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Attenzione spoiler", systemImage: "eye.trianglebadge.exclamationmark.fill")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text(spoilerGateMessage(coords: coords))
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button {
                        withAnimation(.easeOut(duration: 0.2)) {
                            spoilerGatePassed = true
                        }
                    } label: {
                        Text("Entra")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityHint("Mostra i messaggi della discussione")
                }
            }
            .padding(.horizontal, 20)

            Spacer(minLength: 0)
        }
        .padding(.top, 20)
    }

    private func spoilerGateMessage(coords: (season: Int, episode: Int?)?) -> String {
        guard let coords else { return String(localized: "Contiene spoiler su questo contenuto. Procedi?") }
        if let episode = coords.episode {
            return "Contiene spoiler fino a S\(coords.season)·E\(episode). Procedi?"
        }
        return String(localized: "Contiene spoiler su tutta la stagione \(coords.season). Procedi?")
    }

    private var blockedConversationNotice: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Conversazione limitata", systemImage: "hand.raised.fill")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text("Hai bloccato almeno un partecipante di questo thread. I suoi messaggi vengono nascosti e l'invio di nuovi messaggi è disattivato finché non lo sblocchi dal profilo.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 16)
    }

    private var guidedProfileDirectMessageNotice: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Profilo guidato", systemImage: "sparkles")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text("Questo è un profilo guidato da Somto e non riceve messaggi personali.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 16)
    }

    private var composer: some View {
        @Bindable var messageComposer = messageComposer
        // La casella cresce con il testo fino a `editorMaxHeight`, poi scrolla
        // internamente (con inseguimento del cursore in `ComposerTextView`).
        // Prima era bloccata a 60 mentre lo scroll interno partiva solo a 72 →
        // banda morta: il testo veniva tagliato e il cursore spariva.
        let editorMaxHeight: CGFloat = 120
        let clampedComposerHeight = min(editorMaxHeight, max(22, messageComposer.editorHeight))

        // Candidati per il picker spoiler: prima il titolo del thread se c'è,
        // poi (best-effort) i titoli di cui il viewer è autore — qui usiamo
        // semplicemente il titolo del thread come opzione iniziale; il pool
        // più ampio è gestito da UI dedicate (post composer).
        let candidates: [Title] = {
            if let t = viewModel.thread?.title {
                return [t]
            }
            return []
        }()

        return VStack(spacing: 10) {
            Divider()
                .overlay(TwoWatchTheme.border)

            // Discussione pubblica: da quando i commenti diventano card nel feed
            // Community (functions/lib/commentEcho.js), chi scrive qui deve
            // saperlo PRIMA di scrivere. DM e gruppi restano privati.
            if viewModel.thread?.visibility == .publicThread {
                Text("Quello che scrivi qui compare anche nel feed Community.")
                    .font(.system(size: 11))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
            }

            if !isSupportThread {
                SpoilerComposerSection(
                    containsSpoiler: $composerContainsSpoiler,
                    spoilerTitleIDs: $composerSpoilerTitleIDs,
                    candidateTitles: candidates
                )
                .padding(.horizontal, 20)
            }

            VStack(spacing: 10) {
                AutocompleteSuggestionsList(
                    composer: messageComposer,
                    subtitleColor: TwoWatchTheme.textSecondary,
                    dividerColor: TwoWatchTheme.border,
                    backgroundColor: TwoWatchTheme.backgroundSecondary.opacity(0.92)
                )

                HStack(alignment: .bottom, spacing: 10) {
                    Button {
                        dismissKeyboard()
                        isGifPickerPresented = true
                    } label: {
                        Text("GIF")
                            .font(.caption.weight(.heavy))
                            .foregroundStyle(TwoWatchTheme.brandSecondary)
                            .frame(width: 44, height: 40)
                            .background(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(TwoWatchTheme.brandSecondary.opacity(0.14))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(TwoWatchTheme.brandSecondary.opacity(0.35), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Aggiungi una GIF")

                    ZStack(alignment: .topLeading) {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(TwoWatchTheme.panel)

                        if messageComposer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("Scrivi un messaggio... usa @ e #")
                                .font(.body)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .allowsHitTesting(false)
                        }

                        ComposerTextView(
                            text: $messageComposer.text,
                            selectedRange: $messageComposer.selectedRange,
                            dynamicHeight: $messageComposer.editorHeight,
                            shouldBecomeFirstResponder: $messageComposer.shouldRefocusEditor,
                            textColor: .white,
                            keyboardAppearance: .dark,
                            minHeight: 22,
                            maxHeight: editorMaxHeight,
                            onTextEvent: { text, selection in
                                messageComposer.handleEditorChange(
                                    text,
                                    selection: selection,
                                    currentUserID: session.firebaseUser?.uid,
                                    canSearchUsers: session.permissions.canSearchUsers
                                )

                                if let currentUserID = session.firebaseUser?.uid {
                                    let currentUserName = session.appUser?.displayName
                                        ?? session.firebaseUser?.displayName
                                        ?? "User"
                                    viewModel.handleDraftChange(
                                        currentUserID: currentUserID,
                                        currentUserName: currentUserName,
                                        text: text
                                    )
                                }
                            },
                            onReturnKey: {
                                if messageComposer.acceptHighlightedSuggestion() {
                                    return true
                                }
                                guard messageComposer.canSubmit, !viewModel.isSending else { return false }
                                Task { await submitMessage() }
                                return true
                            }
                        )
                        .frame(height: clampedComposerHeight)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .frame(minHeight: 38, maxHeight: clampedComposerHeight + 14, alignment: .bottom)

                    Button {
                        Task { await submitMessage() }
                    } label: {
                        if viewModel.isSending {
                            ProgressView()
                                .tint(.white)
                                .frame(width: 40, height: 40)
                        } else {
                            Image(systemName: "paperplane.fill")
                                .font(.headline.weight(.bold))
                                .frame(width: 40, height: 40)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(TwoWatchTheme.brandPrimary)
                    .disabled(!messageComposer.canSubmit || viewModel.isSending)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
            .padding(.top, 6)
        }
        .background(.ultraThinMaterial)
        .sheet(isPresented: $isGifPickerPresented) {
            GifPickerSheet(repository: container.threadsRepository) { gif in
                Task { await submitGif(gifURL: gif.gifUrl) }
            }
            .presentationDetents([.large, .medium])
            .presentationDragIndicator(.visible)
        }
    }

    private var typingText: String {
        let names = viewModel.typingUsers.map(\.displayName)
        if names.count == 1 {
            return "\(names[0]) sta scrivendo…"
        }
        return "Stanno scrivendo…"
    }

    private func submitMessage() async {
        guard let currentUserID = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }

        let currentUserName = session.appUser?.displayName
            ?? session.firebaseUser?.displayName
            ?? "User"
        let rawText = messageComposer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawText.isEmpty, !viewModel.requiresSafetyAcceptance, !viewModel.isConversationBlocked else { return }

        let resolvedText = messageComposer.resolvedTextForSubmission(rawText)
        let didSend = await viewModel.send(
            currentUserID: currentUserID,
            currentUserName: currentUserName,
            text: resolvedText,
            containsSpoiler: !isSupportThread && composerContainsSpoiler,
            spoilerTitleIDs: !isSupportThread && composerContainsSpoiler ? composerSpoilerTitleIDs : []
        )

        if didSend {
            messageComposer.reset()
            composerContainsSpoiler = false
            composerSpoilerTitleIDs = []
        }
    }

    /// Invia la GIF scelta dal picker come nuovo messaggio (testo vuoto),
    /// propagando lo stato spoiler del composer se attivo.
    private func submitGif(gifURL: String) async {
        guard let currentUserID = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }
        let currentUserName = session.appUser?.displayName
            ?? session.firebaseUser?.displayName
            ?? "User"
        guard !viewModel.requiresSafetyAcceptance, !viewModel.isConversationBlocked else { return }

        let didSend = await viewModel.sendGif(
            currentUserID: currentUserID,
            currentUserName: currentUserName,
            gifURL: gifURL,
            containsSpoiler: !isSupportThread && composerContainsSpoiler,
            spoilerTitleIDs: !isSupportThread && composerContainsSpoiler ? composerSpoilerTitleIDs : []
        )

        if didSend {
            composerContainsSpoiler = false
            composerSpoilerTitleIDs = []
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()
        }
    }

    /// True se il thread aperto è la chat di assistenza (`support_*`).
    private var isSupportThread: Bool {
        guard let thread = viewModel.thread else { return false }
        return thread.contextType == .group && (thread.contextId ?? "").hasPrefix("support_")
    }

    /// Mostra il banner notifiche solo nella chat assistenza, se non dismesso e
    /// se il permesso non è già concesso (notDetermined = mai chiesto, denied =
    /// spento → rimanda a Impostazioni).
    private var showSupportPushBanner: Bool {
        guard isSupportThread, !supportBannerDismissed else { return false }
        return pushAuthStatus == .notDetermined || pushAuthStatus == .denied
    }

    private func supportPushBanner() -> some View {
        GlassCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "bell.badge.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandGradient)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Attiva le notifiche")
                        .font(.subheadline.weight(.heavy))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text(pushAuthStatus == .denied
                         ? "Le notifiche sono disattivate. Attivale in Impostazioni per sapere subito quando ti rispondiamo."
                         : "Così sai subito quando ti rispondiamo, senza dover riaprire l'app.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button {
                        if pushAuthStatus == .denied {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                openURL(url)
                            }
                        } else {
                            Task {
                                isRequestingPush = true
                                let granted = await container.pushNotifications.requestAuthorizationFromUser()
                                container.pushPromptService.markPromptSeen()
                                container.analytics.log(AnalyticsEvent.pushPromptEnabled, [
                                    "source": "support_chat",
                                    "granted": granted
                                ])
                                pushAuthStatus = await container.pushNotifications.currentAuthorizationStatus()
                                isRequestingPush = false
                            }
                        }
                    } label: {
                        if isRequestingPush {
                            ProgressView().tint(.white)
                        } else {
                            Text(pushAuthStatus == .denied ? "Apri Impostazioni" : "Attiva")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isRequestingPush)
                }

                Button {
                    supportBannerDismissed = true
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .frame(width: 24, height: 24)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(isRequestingPush)
            }
        }
    }

    private func successBanner(_ message: String, onDismiss: @escaping () -> Void) -> some View {
        GlassCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.success)

                Text(message)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .frame(width: 24, height: 24)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// Un intervento nel thread.
///
/// Due layout, stesso contenuto e stesse azioni:
/// - **board** (discussioni pubbliche): riga piena, avatar 26pt, nome + ora
///   sulla stessa riga, testo senza bolla, separatore sottile. Gli interventi
///   consecutivi dello stesso autore non ripetono l'header. Serve a leggerne
///   molti insieme: prima ogni messaggio era una bolla larga al massimo 92%
///   con margini da chat 1:1, e in una schermata ci stavano 3-4 commenti.
/// - **chat** (DM e gruppi): le bolle di sempre, allineate a destra/sinistra.
private struct MessageRow: View {
    let message: ThreadMessage
    let isMine: Bool
    var usesBoardLayout: Bool = false
    var isGroupedWithPrevious: Bool = false
    var isFirstRow: Bool = false
    /// Nei thread di stagione/episodio il gate spoiler d'ingresso copre tutto
    /// il thread: in quel contesto si salta il blur per singolo messaggio. Per
    /// i thread a livello titolo resta false → SpoilerGate invariato.
    var bypassPerMessageSpoiler: Bool = false
    let onOpenProfile: () -> Void
    let onReport: () -> Void
    let onBlock: () -> Void
    let onToggleReaction: (String) -> Void
    var isReactionPending = false
    var isModerationPending = false
    @Environment(AppContainer.self) private var container
    @Environment(SessionStore.self) private var session
    @Environment(AppShellStore.self) private var shell

    private var myUID: String? { session.firebaseUser?.uid }

    var body: some View {
        if usesBoardLayout {
            boardRow
        } else {
            chatBubble
        }
    }

    // MARK: - Board (discussioni pubbliche)

    private var boardRow: some View {
        VStack(spacing: 0) {
            if !isFirstRow && !isGroupedWithPrevious {
                Rectangle()
                    .fill(TwoWatchTheme.border.opacity(0.6))
                    .frame(height: 1)
                    .padding(.leading, 36)
            }

            HStack(alignment: .top, spacing: 10) {
                // L'avatar sparisce sui messaggi raggruppati: la colonna resta
                // allineata, ma senza ripetere lo stesso volto tre volte.
                Group {
                    if isGroupedWithPrevious {
                        Color.clear
                    } else {
                        Button(action: onOpenProfile) {
                            SomtoAvatar(url: nil, name: message.displayName, size: 26)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Profilo di \(message.displayName)")
                    }
                }
                .frame(width: 26, height: 26)

                VStack(alignment: .leading, spacing: 4) {
                    if !isGroupedWithPrevious {
                        boardHeader
                    }

                    boardContent

                    if !orderedReactions.isEmpty {
                        reactionsRow
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 0) {
                    reactionMenu
                    if !isMine { moderationMenu }
                }
                .padding(.top, isGroupedWithPrevious ? 0 : 1)
            }
            .padding(.vertical, isGroupedWithPrevious ? 3 : 8)
        }
    }

    private var boardHeader: some View {
        HStack(spacing: 6) {
            Button(action: onOpenProfile) {
                Text(message.displayName)
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(isMine ? TwoWatchTheme.accent : TwoWatchTheme.textPrimary)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)

            if let createdAt = message.createdAt {
                Text(createdAt.formatted(.relative(presentation: .numeric, unitsStyle: .narrow)))
                    .font(.system(size: 11))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            Spacer(minLength: 0)
        }
    }

    /// Contenuto senza bolla: il testo è l'elemento principale della riga.
    /// Il voto, quando c'è, diventa un badge davanti al commento invece di un
    /// numero gigante in fondo a una bolla.
    @ViewBuilder
    private var boardContent: some View {
        if message.isGif, let gifURL = URL(string: message.gifUrl ?? "") {
            SpoilerGate(
                containsSpoiler: bypassPerMessageSpoiler ? false : message.containsSpoiler,
                spoilerTitleIDs: bypassPerMessageSpoiler ? [] : message.spoilerTitleIds,
                viewerCompletedTitleIDs: session.completedTitleIDs,
                titleNames: [:],
                onMarkSeen: { titleID in await markTitleCompleted(titleID) }
            ) {
                VStack(alignment: .leading, spacing: 6) {
                    AnimatedGIFView(url: gifURL, targetWidth: 200, cornerRadius: 12)
                    if !message.displayText.isEmpty {
                        boardText(source: message.text)
                    }
                }
            }
        } else if let rating = RatingReviewMessage.parse(message.text) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    ThreadRatingBadge(score: rating.score)
                    if !rating.people.isEmpty {
                        Text(rating.people)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                if !rating.review.isEmpty {
                    SpoilerGate(
                        containsSpoiler: bypassPerMessageSpoiler ? false : message.containsSpoiler,
                        spoilerTitleIDs: bypassPerMessageSpoiler ? [] : message.spoilerTitleIds,
                        viewerCompletedTitleIDs: session.completedTitleIDs,
                        titleNames: [:],
                        onMarkSeen: { titleID in await markTitleCompleted(titleID) }
                    ) {
                        boardText(source: rating.review)
                    }
                }
            }
        } else {
            SpoilerGate(
                containsSpoiler: bypassPerMessageSpoiler ? false : message.containsSpoiler,
                spoilerTitleIDs: bypassPerMessageSpoiler ? [] : message.spoilerTitleIds,
                viewerCompletedTitleIDs: session.completedTitleIDs,
                titleNames: [:],
                onMarkSeen: { titleID in await markTitleCompleted(titleID) }
            ) {
                boardText(source: message.text)
            }
        }
    }

    private func boardText(source: String) -> some View {
        InteractiveTaggedText(
            source: source,
            font: .system(size: 15),
            textColor: TwoWatchTheme.textPrimary,
            container: container,
            session: session,
            shell: shell
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Chat (DM e gruppi) — layout storico invariato

    private var chatBubble: some View {
        HStack(alignment: .top, spacing: 6) {
            if isMine {
                reactionMenu
                    .padding(.top, 14)
            }

            VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
                if message.isGif, let gifURL = URL(string: message.gifUrl ?? "") {
                    // Bolla GIF: stesso gate spoiler del testo — una GIF flaggata
                    // resta in blur finché il viewer non ha visto i titoli.
                    messageHeader
                    SpoilerGate(
                        containsSpoiler: bypassPerMessageSpoiler ? false : message.containsSpoiler,
                        spoilerTitleIDs: bypassPerMessageSpoiler ? [] : message.spoilerTitleIds,
                        viewerCompletedTitleIDs: session.completedTitleIDs,
                        titleNames: [:],
                        onMarkSeen: { titleID in await markTitleCompleted(titleID) }
                    ) {
                        gifBubble(gifURL)
                    }
                } else if let rating = RatingReviewMessage.parse(message.text) {
                    // Card voto+recensione: i messaggi "N/10 — …" (sincronizzati
                    // da un voto) sono resi come sul web (thread.page.js): persona
                    // cliccabile + voto in gradiente dentro la bolla, senza "/10".
                    ratingAuthorHeader
                    ratingBubble(rating)
                } else {
                    // Header compatto: nome + ora sulla STESSA riga (prima erano
                    // due righe separate → ogni messaggio troppo alto).
                    messageHeader

                    SpoilerGate(
                        containsSpoiler: bypassPerMessageSpoiler ? false : message.containsSpoiler,
                        spoilerTitleIDs: bypassPerMessageSpoiler ? [] : message.spoilerTitleIds,
                        viewerCompletedTitleIDs: session.completedTitleIDs,
                        titleNames: [:],
                        onMarkSeen: { titleID in await markTitleCompleted(titleID) }
                    ) {
                        InteractiveTaggedText(
                            source: message.text,
                            font: .body,
                            textColor: TwoWatchTheme.textPrimary,
                            container: container,
                            session: session,
                            shell: shell
                        )
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(isMine ? TwoWatchTheme.brandPrimary.opacity(0.28) : TwoWatchTheme.panel)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(TwoWatchTheme.border, lineWidth: isMine ? 0 : 1)
                        )
                    }
                }

                if !orderedReactions.isEmpty {
                    reactionsRow
                }
            }

            if !isMine {
                HStack(spacing: 2) {
                    reactionMenu
                    moderationMenu
                }
                .padding(.top, 14)
            }
        }
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
    }

    /// Header compatto: nome autore + ora sulla stessa riga. Condiviso da bolla
    /// testo e bolla GIF.
    private var messageHeader: some View {
        HStack(spacing: 6) {
            Text(message.displayName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(isMine ? TwoWatchTheme.accent : TwoWatchTheme.textSecondary)
                .lineLimit(1)
            if let createdAt = message.createdAt {
                Text(createdAt.formatted(date: .omitted, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
        }
    }

    /// Bolla GIF animata (max 220pt, angoli 14). Se il messaggio ha anche una
    /// caption testuale, la mostra sotto la GIF nello stesso stile della bolla.
    @ViewBuilder
    private func gifBubble(_ url: URL) -> some View {
        VStack(alignment: isMine ? .trailing : .leading, spacing: 6) {
            AnimatedGIFView(url: url, targetWidth: 220, cornerRadius: 14)

            if !message.displayText.isEmpty {
                InteractiveTaggedText(
                    source: message.text,
                    font: .body,
                    textColor: TwoWatchTheme.textPrimary,
                    container: container,
                    session: session,
                    shell: shell
                )
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(isMine ? TwoWatchTheme.brandPrimary.opacity(0.28) : TwoWatchTheme.panel)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(TwoWatchTheme.border, lineWidth: isMine ? 0 : 1)
                )
                .frame(maxWidth: 220, alignment: isMine ? .trailing : .leading)
            }
        }
    }

    /// Marca un titolo come completato (usato dal gate spoiler delle bolle).
    private func markTitleCompleted(_ titleID: String) async {
        guard let uid = session.firebaseUser?.uid,
              let repo = container.watchlistRepository as WatchlistRepository?
        else { return }
        do {
            _ = try await repo.markTitleCompletedByID(userID: uid, titleID: titleID)
            session.markTitleCompletedLocally(titleID)
        } catch {
            // Silenzioso: il gate resta in stato corrente.
        }
    }

    private struct ReactionEntry: Identifiable {
        let emoji: String
        let count: Int
        let mine: Bool
        var id: String { emoji }
    }

    /// Reactions con almeno 1 uid, nell'ordine canonico (👍 ❤️ 😮 🤯) + eventuali altre.
    private var orderedReactions: [ReactionEntry] {
        var seen = Set<String>()
        var result: [ReactionEntry] = []
        for emoji in ThreadReactionOptions.emojis {
            guard let uids = message.reactions[emoji], !uids.isEmpty else { continue }
            result.append(ReactionEntry(emoji: emoji, count: uids.count, mine: myUID.map { uids.contains($0) } ?? false))
            seen.insert(emoji)
        }
        for (emoji, uids) in message.reactions where !seen.contains(emoji) && !uids.isEmpty {
            result.append(ReactionEntry(emoji: emoji, count: uids.count, mine: myUID.map { uids.contains($0) } ?? false))
        }
        return result
    }

    private var reactionsRow: some View {
        HStack(spacing: 6) {
            ForEach(orderedReactions) { entry in
                Button {
                    onToggleReaction(entry.emoji)
                } label: {
                    HStack(spacing: 3) {
                        Text(entry.emoji)
                            .font(.caption)
                        Text("\(entry.count)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(entry.mine ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(entry.mine ? TwoWatchTheme.brandPrimary.opacity(0.16) : TwoWatchTheme.panel)
                    )
                    .overlay(
                        Capsule().stroke(entry.mine ? TwoWatchTheme.brandPrimary.opacity(0.55) : TwoWatchTheme.border, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .disabled(isReactionPending)
                .accessibilityLabel("\(entry.emoji) \(entry.count)\(entry.mine ? String(localized: ", la tua reaction") : "")")
            }
        }
    }

    private var reactionMenu: some View {
        Menu {
            ForEach(ThreadReactionOptions.emojis, id: \.self) { emoji in
                let mine = myUID.map { message.reactions[emoji]?.contains($0) ?? false } ?? false
                Button {
                    onToggleReaction(emoji)
                } label: {
                    if mine {
                        Label(emoji, systemImage: "checkmark")
                    } else {
                        Text(emoji)
                    }
                }
            }
        } label: {
            Group {
                if isReactionPending {
                    ProgressView()
                } else {
                    Image(systemName: "face.smiling")
                }
            }
            .font(.subheadline)
            .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .disabled(isReactionPending)
        .accessibilityLabel("Aggiungi reaction")
    }

    private var moderationMenu: some View {
        Menu {
            Button {
                onOpenProfile()
            } label: {
                Label("Apri profilo", systemImage: "person.crop.circle")
            }

            Button(role: .destructive) {
                onReport()
            } label: {
                Label("Segnala messaggio", systemImage: "flag.fill")
            }
            .disabled(isModerationPending)

            Button(role: .destructive) {
                onBlock()
            } label: {
                Label("Blocca utente", systemImage: "hand.raised.fill")
            }
            .disabled(isModerationPending)
        } label: {
            Group {
                if isModerationPending {
                    ProgressView()
                } else {
                    Image(systemName: "ellipsis.circle")
                }
            }
            .font(.headline)
            .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .disabled(isModerationPending)
        .accessibilityLabel("Azioni messaggio")
    }

    /// Header della card voto: avatar a iniziali + nome autore, entrambi
    /// tappabili verso il profilo (stesso percorso del menu "Apri profilo").
    private var ratingAuthorHeader: some View {
        Button(action: onOpenProfile) {
            HStack(spacing: 8) {
                SomtoAvatar(url: nil, name: message.displayName, size: 34)
                Text(message.displayName)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }

    /// Bolla della card voto: corpo recensione (soggetto al gate spoiler come
    /// ogni messaggio) + numero voto in gradiente brand in basso a destra,
    /// DENTRO la bolla. Il numero resta fuori dal gate: il voto in sé non è
    /// uno spoiler (parità col web).
    private func ratingBubble(_ rating: RatingReviewMessage) -> some View {
        ZStack(alignment: .bottomTrailing) {
            if !rating.review.isEmpty {
                SpoilerGate(
                    containsSpoiler: bypassPerMessageSpoiler ? false : message.containsSpoiler,
                    spoilerTitleIDs: bypassPerMessageSpoiler ? [] : message.spoilerTitleIds,
                    viewerCompletedTitleIDs: session.completedTitleIDs,
                    titleNames: [:],
                    onMarkSeen: { titleID in
                        guard let uid = session.firebaseUser?.uid,
                              let repo = container.watchlistRepository as WatchlistRepository?
                        else { return }
                        do {
                            _ = try await repo.markTitleCompletedByID(userID: uid, titleID: titleID)
                            session.markTitleCompletedLocally(titleID)
                        } catch {
                            // Silenzioso: il gate resta in stato corrente.
                        }
                    }
                ) {
                    InteractiveTaggedText(
                        source: rating.review,
                        font: .body,
                        textColor: TwoWatchTheme.textPrimary,
                        container: container,
                        session: session,
                        shell: shell
                    )
                    // Banda inferiore riservata al numero (≈ line-height del
                    // voto): il testo non si sovrappone mai al voto.
                    .padding(.bottom, 26)
                }
            }

            Text(rating.score)
                .font(.system(size: 22, weight: .heavy))
                .kerning(-1)
                .foregroundStyle(TwoWatchTheme.brandGradient)
                .accessibilityLabel("Voto \(rating.score) su 10")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        // Voto secco (recensione vuota): la bolla non collassa sul numero.
        .frame(minHeight: 40, alignment: .bottomTrailing)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isMine ? TwoWatchTheme.brandPrimary.opacity(0.28) : TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: isMine ? 0 : 1)
        )
    }
}

/// Messaggio voto+commento: testo che inizia con "N/10 — …" (pubblicato nel
/// thread pubblico del titolo quando un utente vota). Il riconoscimento del
/// prefisso vive in `RatingDisplayFormat.splitRatingPrefix`, condiviso con le
/// card di Community e Messaggi: prima ogni superficie aveva la sua regex e
/// solo questa toglieva il "/10".
private struct RatingReviewMessage {
    /// Voto già pronto per il display, senza "/10" (es. "7,5", "8½", "7+").
    let score: String
    /// "con Anna, Marco" quando il voto porta con sé le persone; vuoto altrimenti.
    let people: String
    /// Corpo del commento dopo il prefisso; vuoto per il voto secco.
    let review: String

    static func parse(_ text: String) -> RatingReviewMessage? {
        guard let split = RatingDisplayFormat.splitRatingPrefix(text) else { return nil }
        return RatingReviewMessage(score: split.score, people: split.people, review: split.body)
    }
}

private enum ThreadReactionOptions {
    /// Stesso set della web (`thread.page.js#REACTION_EMOJIS`).
    static let emojis = ["👍", "❤️", "😮", "🤯"]
}
