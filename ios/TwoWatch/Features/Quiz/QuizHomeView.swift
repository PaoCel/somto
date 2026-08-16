import SwiftUI

struct QuizHomeView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var pendingChallengeCount: Int = 0
    @State private var userStats: QuizUserStats = .zero
    @State private var loadingError: String?
    @State private var isLoading = false

    // MARK: External-invite claim
    /// Set once `claimExternalInvite` succeeds — drives the onboarding cover.
    @State private var pendingClaim: QuizClaimResult?
    /// Set when the claimed challenge is already finalized (re-entry) — skips
    /// the titles onboarding and goes straight to the player.
    @State private var readyChallengeFromClaim: QuizChallenge?
    @State private var claimErrorMessage: String?
    @State private var isClaimingInvite = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                heroPlay

                statStrip

                betaCaption

                VStack(spacing: 10) {
                    sfideRow
                    classificaRow
                }

                QuizBonusBar(
                    progress: userStats.dailyBonusProgress,
                    goal: QuizXP.dailyBonusGamesRequired,
                    isActive: userStats.isDailyBonusActive
                )
                .padding(.top, 2)

                if isAdmin {
                    adminEntryCard
                }

                Spacer(minLength: 8)
            }
            .padding(.horizontal, 16)
            .padding(.top, 64)
            .padding(.bottom, 32)
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationBarHidden(true)
        .task {
            await loadStats()
        }
        .refreshable {
            await loadStats()
        }
        // Consume an external quiz-invite deep link. `pendingQuizInviteToken`
        // is set by AppShellStore and survives a sign-up detour. The id also
        // tracks the auth state so the claim re-fires once an unauthenticated
        // invitee finishes signing up.
        .task(id: invitePendingKey) {
            await handlePendingInvite()
        }
        // Player loading overlay while the invite token is being claimed.
        .overlay {
            if isClaimingInvite {
                ZStack {
                    Color.black.opacity(0.55).ignoresSafeArea()
                    VStack(spacing: 12) {
                        ProgressView().tint(TwoWatchTheme.brandPrimary)
                        Text("Apro la sfida…")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .padding(24)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(TwoWatchTheme.backgroundSecondary)
                    )
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: isClaimingInvite)
        // Titles-onboarding for a freshly claimed external invite.
        .fullScreenCover(item: $pendingClaim) { claim in
            QuizInviteOnboardingView(
                container: container,
                session: session,
                shell: shell,
                claim: claim,
                onClose: { pendingClaim = nil }
            )
        }
        // Re-entry: the claimed challenge is already finalized — play directly.
        .navigationDestination(item: $readyChallengeFromClaim) { challenge in
            QuizPlayView(
                container: container,
                session: session,
                shell: shell,
                mode: .challenge,
                challenge: challenge
            )
        }
        .alert(
            "Invito non valido",
            isPresented: Binding(
                get: { claimErrorMessage != nil },
                set: { if !$0 { claimErrorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { claimErrorMessage = nil }
        } message: {
            Text(claimErrorMessage ?? "")
        }
    }

    /// Re-fires `handlePendingInvite` when either the invite token or the
    /// auth state changes — an invitee who arrives unauthenticated must be
    /// able to claim once sign-up completes.
    private var invitePendingKey: String {
        "\(shell.pendingQuizInviteToken ?? "none")|\(session.appUser?.id ?? "anon")"
    }

    /// Claims a pending external-invite token: if the challenge is already
    /// finalized it pushes the player, otherwise it opens the titles
    /// onboarding. Always clears the token so it cannot re-fire.
    @MainActor
    private func handlePendingInvite() async {
        guard let token = shell.pendingQuizInviteToken else { return }
        guard session.appUser?.id != nil else { return }
        isClaimingInvite = true
        defer {
            isClaimingInvite = false
            shell.pendingQuizInviteToken = nil
        }
        do {
            let claim = try await container.quizRepository.claimExternalInvite(token: token)
            // If the challenge already has a question set the onboarding was
            // completed before — go straight to the player.
            if let challenge = try? await container.quizRepository.fetchChallenge(id: claim.challengeId),
               !challenge.questionIds.isEmpty {
                readyChallengeFromClaim = challenge
            } else {
                pendingClaim = claim
            }
        } catch {
            claimErrorMessage = UserFacingError.message(for: error)
        }
    }

    // MARK: - Sections

    private var heroPlay: some View {
        NavigationLink {
            QuizGameSetupView(container: container, session: session, shell: shell)
        } label: {
            QuizHeroPlayTile(streak: userStats.dailyStreak)
        }
        .buttonStyle(QuizPressableStyle())
        .accessibilityLabel("Gioca. Scegli casuale o un titolo specifico.")
    }

    private var statStrip: some View {
        QuizStatStrip(
            score: QuizScore.format(userStats.totalScore),
            accuracy: userStats.accuracyPct.map { String(format: "%.0f%%", $0) } ?? "—",
            attempts: "\(userStats.attemptsCount)"
        )
    }

    private var betaCaption: some View {
        Text("Il Quiz è in beta: le domande crescono e migliorano ogni settimana. Trovi un errore? Segnalalo dal player.")
            .font(.caption)
            .foregroundStyle(TwoWatchTheme.textMuted)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Il Quiz è in beta. Le domande crescono e migliorano ogni settimana. Trovi un errore? Segnalalo dal player.")
    }

    private var sfideRow: some View {
        NavigationLink {
            QuizChallengeInboxView(container: container, session: session, shell: shell)
        } label: {
            QuizMenuRow(
                icon: "person.2.fill",
                title: "Sfide",
                subtitle: pendingChallengeCount > 0 ? "\(pendingChallengeCount) in attesa" : String(localized: "Sfida un amico"),
                accent: TwoWatchTheme.brandSecondary,
                badgeCount: pendingChallengeCount
            )
        }
        .buttonStyle(QuizPressableStyle())
        .accessibilityLabel(pendingChallengeCount > 0
            ? "Sfide. \(pendingChallengeCount) in attesa."
            : "Sfide. Sfida un amico.")
    }

    private var classificaRow: some View {
        NavigationLink {
            QuizLeaderboardView(container: container, session: session, shell: shell)
        } label: {
            QuizMenuRow(
                icon: "trophy.fill",
                title: "Classifica",
                subtitle: "Scopri i migliori",
                accent: TwoWatchTheme.brandWarm
            )
        }
        .buttonStyle(QuizPressableStyle())
        .accessibilityLabel("Classifica. Scopri i migliori.")
    }

    private var adminEntryCard: some View {
        NavigationLink {
            AdminQuizListView(container: container, session: session)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "shield.lefthalf.filled")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .frame(width: 38, height: 38)
                    .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 10))

                VStack(alignment: .leading, spacing: 2) {
                    Text("Admin Quiz")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Revisiona, modifica, approva domande.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(TwoWatchTheme.panel)
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(QuizPressableStyle())
    }

    // MARK: - Helpers

    private var isAdmin: Bool {
        session.appUser?.permissions.canRunAdminTools == true
    }

    @MainActor
    private func loadStats() async {
        guard let uid = session.appUser?.id else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let stats = container.quizRepository.fetchUserStats(uid: uid)
            async let inbox = container.quizRepository.fetchReceivedChallenges(uid: uid)
            let resolvedStats = try await stats
            let resolvedInbox = try await inbox
            userStats = resolvedStats
            pendingChallengeCount = resolvedInbox.filter { $0.status == .pending }.count
        } catch {
            loadingError = UserFacingError.message(for: error)
        }
    }
}

#if DEBUG
private struct QuizHomeViewRuntimePreview: View {
    let session: SessionStore
    @State private var shell = TwoWatchPreview.shell(selectedTab: .quiz)

    var body: some View {
        TabView(selection: $shell.selectedTab) {
            Color.clear
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(AppTab.home)

            Color.clear
                .tabItem { Label("Community", systemImage: "person.2.fill") }
                .tag(AppTab.community)

            Color.clear
                .tabItem { Label("Watchlist", systemImage: "bookmark.fill") }
                .tag(AppTab.watchlist)

            NavigationStack {
                QuizHomeView(
                    container: TwoWatchPreview.container,
                    session: session,
                    shell: shell
                )
            }
            .brandChromePill(shell: shell)
            .tabItem { Label("Quiz", systemImage: "questionmark.circle.fill") }
            .tag(AppTab.quiz)

            Color.clear
                .tabItem { Label("Profilo", systemImage: "person.crop.circle.fill") }
                .tag(AppTab.profile)
        }
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarBackground(TwoWatchTheme.tabMaterial, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
    }
}

#Preview("Quiz Home", traits: .fixedLayout(width: 393, height: 852)) {
    QuizHomeViewRuntimePreview(session: TwoWatchPreview.session())
}
#endif
