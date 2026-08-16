import SwiftUI

struct QuizChallengeInboxView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var received: [QuizChallenge] = []
    @State private var sent: [QuizChallenge] = []
    @State private var usersByUid: [String: AppUser] = [:]
    @State private var selectedSection: Section = .received
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showComposer = false

    enum Section: String, CaseIterable, Hashable {
        case received = "Ricevute"
        case sent = "Inviate"
    }

    var body: some View {
        VStack(spacing: 14) {
            QuizSegmentedControl(
                options: Section.allCases,
                selection: $selectedSection,
                label: { $0.rawValue }
            )
            .padding(.horizontal, 16)
            .padding(.top, 8)

            content
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Sfide")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showComposer = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.title3)
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
                .accessibilityLabel("Nuova sfida")
            }
        }
        .sheet(isPresented: $showComposer, onDismiss: { Task { await load() } }) {
            QuizChallengeComposerView(container: container, session: session)
                .presentationDetents([.large])
        }
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private var content: some View {
        let list = selectedSection == .received ? received : sent
        if isLoading && list.isEmpty {
            ProgressView().tint(TwoWatchTheme.brandPrimary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage {
            errorState(errorMessage)
        } else if list.isEmpty {
            ScrollView {
                VStack(spacing: 16) {
                    EmptyStateView(
                        title: selectedSection == .received ? "Nessuna sfida ricevuta" : "Nessuna sfida inviata",
                        message: selectedSection == .received
                            ? "Quando un amico ti sfiderà sui titoli che avete visto entrambi, la trovi qui."
                            : "Sfida un amico Somto o invita qualcuno con un link: la sfida comparirà qui.",
                        systemImage: "flag.checkered",
                        actionTitle: "Crea una sfida",
                        action: { showComposer = true }
                    )
                    inviteFriendCard
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
            .refreshable { await load() }
        } else {
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(list, id: \.id) { challenge in
                        QuizChallengeRow(
                            challenge: challenge,
                            currentUid: session.appUser?.id,
                            otherUser: otherUser(for: challenge),
                            container: container,
                            session: session,
                            shell: shell
                        )
                    }
                    inviteFriendCard
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
    }

    // MARK: - Invite-a-friend CTA

    private var inviteFriendCard: some View {
        Button {
            showComposer = true
        } label: {
            VStack(spacing: 10) {
                Image(systemName: "person.2.badge.plus.fill")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                Text("Invita un amico a sfidarti!")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Più amici, più divertimento.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Text("Invita")
                    .font(.caption.weight(.heavy))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                    .background(TwoWatchTheme.brandGradient, in: Capsule(style: .continuous))
                    .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.4), radius: 8, y: 3)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 20)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TwoWatchTheme.brandPrimary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(
                        TwoWatchTheme.brandPrimary.opacity(0.4),
                        style: StrokeStyle(lineWidth: 1.5, dash: [7, 5])
                    )
            )
        }
        .buttonStyle(QuizPressableStyle())
        .accessibilityLabel("Invita un amico a sfidarti")
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
            Text("Impossibile caricare le sfide")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(message)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                Task { await load() }
            } label: {
                Label("Riprova", systemImage: "arrow.clockwise")
                    .font(.subheadline.weight(.bold))
            }
            .buttonStyle(.bordered)
            .tint(TwoWatchTheme.brandPrimary)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func load() async {
        guard let uid = session.appUser?.id else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let rec = container.quizRepository.fetchReceivedChallenges(uid: uid)
            async let snt = container.quizRepository.fetchSentChallenges(uid: uid)
            received = try await rec
            sent = try await snt
            errorMessage = nil
            await loadCounterparts(currentUid: uid)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func loadCounterparts(currentUid: String) async {
        let uids = Set(
            (received + sent).flatMap { [$0.fromUid, $0.toUid] }.compactMap { $0 }
        ).subtracting([currentUid]).subtracting(usersByUid.keys)
        guard !uids.isEmpty else { return }
        let users = (try? await container.userRepository.listUsers(ids: Array(uids))) ?? []
        for user in users {
            usersByUid[user.id] = user
        }
    }

    private func otherUser(for challenge: QuizChallenge) -> AppUser? {
        let otherUid = challenge.fromUid == session.appUser?.id ? challenge.toUid : challenge.fromUid
        guard let otherUid else { return nil }
        return usersByUid[otherUid]
    }
}

// MARK: - Challenge row

private struct QuizChallengeRow: View {
    let challenge: QuizChallenge
    let currentUid: String?
    let otherUser: AppUser?
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    private var isReceived: Bool { challenge.toUid == currentUid }
    private var myScore: Double? { isReceived ? challenge.toScore : challenge.fromScore }
    private var theirScore: Double? { isReceived ? challenge.fromScore : challenge.toScore }
    private var hasPlayed: Bool { myScore != nil }

    /// Playable when there is a question set and the current user has not
    /// recorded their score yet. External pre-play states have no questions
    /// so they are never playable here.
    private var canPlay: Bool {
        guard currentUid != nil, !challenge.questionIds.isEmpty, !hasPlayed else { return false }
        switch challenge.status {
        case .pending, .pendingOpponentPlay, .inProgress, .played:
            return true
        default:
            return false
        }
    }

    var body: some View {
        Group {
            if canPlay {
                NavigationLink {
                    QuizPlayView(container: container, session: session, shell: shell, mode: .challenge, challenge: challenge)
                } label: {
                    rowBody(interactive: true)
                }
                .buttonStyle(QuizPressableStyle())
            } else if challenge.isComplete {
                NavigationLink {
                    QuizChallengeResultView(container: container, session: session, shell: shell, challenge: challenge)
                } label: {
                    rowBody(interactive: true)
                }
                .buttonStyle(QuizPressableStyle())
            } else {
                rowBody(interactive: false)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits((canPlay || challenge.isComplete) ? .isButton : [])
    }

    private func rowBody(interactive: Bool) -> some View {
        HStack(spacing: 12) {
            opponentAvatar

            VStack(alignment: .leading, spacing: 5) {
                Text(headerLine)
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .lineLimit(1)

                Text(challenge.opponentLabel)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    QuizState.pill(for: challenge, isReceived: isReceived, hasPlayed: hasPlayed)
                    Label("\(challenge.numQuestions)", systemImage: "list.number")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .monospacedDigit()
                }

                if challenge.isComplete {
                    scoreLine
                } else if hasPlayed {
                    Text("Hai già giocato. In attesa dell'avversario.")
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)

            if canPlay {
                playGlyph
            } else if interactive {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
        }
        .padding(14)
        .quizGlowCard(
            cornerRadius: 20,
            glowColor: canPlay ? TwoWatchTheme.brandPrimary : TwoWatchTheme.brandPrimary,
            glowStrength: canPlay ? 0.5 : 0
        )
        .opacity(interactive ? 1 : 0.92)
    }

    private var playGlyph: some View {
        Image(systemName: "play.fill")
            .font(.subheadline.weight(.black))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(TwoWatchTheme.brandGradient, in: Circle())
            .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.5), radius: 8, y: 3)
    }

    private var headerLine: String {
        isReceived ? "SFIDA DA" : "SFIDA A"
    }

    // MARK: Avatar

    @ViewBuilder
    private var opponentAvatar: some View {
        ZStack {
            if let user = otherUser, let url = user.photoURL ?? user.avatarURL {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image): image.resizable().scaledToFill()
                    default: avatarFallback
                    }
                }
            } else {
                avatarFallback
            }
        }
        .frame(width: 46, height: 46)
        .clipShape(Circle())
        .overlay(
            Circle().stroke(QuizState.tint(for: challenge).opacity(0.55), lineWidth: 1.5)
        )
    }

    private var avatarFallback: some View {
        ZStack {
            TwoWatchTheme.brandGradient
            let label = challenge.opponentLabel
            if let initial = label.first, label != "Invito esterno", label != "Avversario" {
                Text(String(initial).uppercased())
                    .font(.headline.weight(.heavy))
                    .foregroundStyle(.white)
            } else {
                Image(systemName: challenge.inviteType == .external ? "link" : "person.fill")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
            }
        }
    }

    // MARK: Score line

    @ViewBuilder
    private var scoreLine: some View {
        if let mine = myScore, let theirs = theirScore {
            let total = max(mine + theirs, 0.001)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("Tu \(QuizScore.format(mine))")
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(mine >= theirs ? TwoWatchTheme.success : TwoWatchTheme.textSecondary)
                        .monospacedDigit()
                    Text("vs")
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                    Text(QuizScore.format(theirs))
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(theirs > mine ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                        .monospacedDigit()
                }
                GeometryReader { proxy in
                    Capsule()
                        .fill(TwoWatchTheme.brandPrimary.opacity(0.25))
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(TwoWatchTheme.success)
                                .frame(width: proxy.size.width * CGFloat(max(mine, 0) / total))
                        }
                }
                .frame(height: 4)
            }
        }
    }

    private var accessibilityLabel: String {
        "\(isReceived ? "Sfida da" : "Sfida a") \(challenge.opponentLabel), \(challenge.numQuestions) domande, \(QuizState.label(for: challenge, isReceived: isReceived, hasPlayed: hasPlayed))"
    }

}

// MARK: - Shared challenge-state mapping
//
// Maps a `QuizChallenge` to the right status pill / label / tint. Kept in one
// place so the inbox and result screens stay consistent.

enum QuizState {
    static func label(for challenge: QuizChallenge, isReceived: Bool, hasPlayed: Bool) -> String {
        if challenge.isComplete {
            switch viewerOutcome(for: challenge, isReceived: isReceived) {
            case .win: return "Vittoria"
            case .loss: return "Sconfitta"
            case .draw: return "Pareggio"
            case .none: return "Completata"
            }
        }
        if challenge.isAwaitingExternalSignup { return "In attesa registrazione" }
        switch challenge.status {
        case .pendingOpponentTitles: return "In attesa titoli"
        case .expired: return "Scaduta"
        case .cancelled: return "Annullata"
        default: break
        }
        if hasPlayed { return "In attesa avversario" }
        if !challenge.questionIds.isEmpty { return "Gioca ora" }
        return "In preparazione"
    }

    static func tint(for challenge: QuizChallenge) -> Color {
        if challenge.isComplete {
            switch challenge.creatorOutcome {
            case .some: return TwoWatchTheme.brandPrimary
            case .none: return TwoWatchTheme.success
            }
        }
        if challenge.isAwaitingExternalSignup { return TwoWatchTheme.warning }
        switch challenge.status {
        case .pendingOpponentTitles: return TwoWatchTheme.warning
        case .expired, .cancelled: return TwoWatchTheme.textMuted
        default: return TwoWatchTheme.brandPrimary
        }
    }

    /// Outcome from the perspective of the viewer (flips `creatorOutcome` when
    /// the viewer is the `to` side of the challenge).
    static func viewerOutcome(for challenge: QuizChallenge, isReceived: Bool) -> QuizChallengeOutcome? {
        guard let creator = challenge.creatorOutcome else { return nil }
        guard isReceived else { return creator }
        switch creator {
        case .win: return .loss
        case .loss: return .win
        case .draw: return .draw
        }
    }

    @ViewBuilder
    static func pill(for challenge: QuizChallenge, isReceived: Bool, hasPlayed: Bool) -> some View {
        if challenge.isComplete {
            switch viewerOutcome(for: challenge, isReceived: isReceived) {
            case .win:
                QuizStatusPill(label: "Vittoria", tint: TwoWatchTheme.success, systemImage: "crown.fill")
            case .loss:
                QuizStatusPill(label: "Sconfitta", tint: TwoWatchTheme.brandPrimary, systemImage: "flag.checkered")
            case .draw:
                QuizStatusPill(label: "Pareggio", tint: TwoWatchTheme.accent, systemImage: "equal")
            case .none:
                QuizStatusPill(label: "Completata", tint: TwoWatchTheme.success, systemImage: "checkmark")
            }
        } else if challenge.isAwaitingExternalSignup {
            QuizStatusPill(label: "In attesa registrazione", tint: TwoWatchTheme.warning, systemImage: "hourglass")
        } else if challenge.status == .pendingOpponentTitles {
            QuizStatusPill(label: "In attesa titoli", tint: TwoWatchTheme.warning, systemImage: "film")
        } else if challenge.status == .expired {
            QuizStatusPill(label: "Scaduta", tint: TwoWatchTheme.textMuted, systemImage: "clock.badge.xmark")
        } else if challenge.status == .cancelled {
            QuizStatusPill(label: "Annullata", tint: TwoWatchTheme.textMuted, systemImage: "xmark")
        } else if hasPlayed {
            QuizStatusPill(label: "In attesa avversario", tint: TwoWatchTheme.textMuted, systemImage: "hourglass")
        } else if !challenge.questionIds.isEmpty {
            QuizStatusPill(label: "Gioca ora", tint: TwoWatchTheme.brandPrimary, systemImage: "play.fill", filled: true)
        } else {
            QuizStatusPill(label: "In preparazione", tint: TwoWatchTheme.textMuted, systemImage: "hourglass")
        }
    }
}
