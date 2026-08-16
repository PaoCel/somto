import SwiftUI

struct QuizLeaderboardView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var scope: QuizLeaderboardScope = .weekly
    @State private var entries: [QuizLeaderboardEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var myScore: Double = 0
    @State private var myRank: Int?

    private var currentUid: String? { session.appUser?.id }

    var body: some View {
        VStack(spacing: 14) {
            scopePicker
                .padding(.horizontal, 16)
                .padding(.top, 8)

            content
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Classifica")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scope) { await load() }
        .refreshable { await load() }
    }

    // MARK: - Premium segmented control

    private var scopePicker: some View {
        HStack(spacing: 4) {
            ForEach(QuizLeaderboardScope.allCases, id: \.self) { option in
                let isActive = scope == option
                Button {
                    guard scope != option else { return }
                    withAnimation(.easeOut(duration: 0.2)) { scope = option }
                } label: {
                    Text(option.italianLabel)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(isActive ? .white : TwoWatchTheme.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(
                            ZStack {
                                if isActive {
                                    Capsule(style: .continuous)
                                        .fill(TwoWatchTheme.brandGradient)
                                        .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.4), radius: 8, y: 3)
                                }
                            }
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.italianLabel)
                // isButton sempre; isSelected solo quando attivo
                .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
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

    @ViewBuilder
    private var content: some View {
        if isLoading && entries.isEmpty {
            ProgressView().tint(TwoWatchTheme.brandPrimary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage {
            ScrollView {
                EmptyStateView(
                    title: "Classifica non disponibile",
                    message: LocalizedStringKey(errorMessage),
                    systemImage: "exclamationmark.triangle",
                    actionTitle: "Riprova",
                    action: { Task { await load() } }
                )
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
            .scrollIndicators(.hidden)
        } else if entries.isEmpty {
            ScrollView {
                EmptyStateView(
                    title: "Classifica vuota",
                    message: scope == .weekly
                        ? "Nessuno ha ancora giocato questa settimana. Sii il primo a comparire qui."
                        : "Nessun punteggio registrato. Inizia un quiz per scalare la classifica.",
                    systemImage: "trophy"
                )
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
            .scrollIndicators(.hidden)
        } else {
            ScrollView {
                LazyVStack(spacing: 8) {
                    QuizPodiumView(entries: Array(entries.prefix(3)), currentUid: currentUid)
                        .padding(.bottom, 6)

                    if entries.count > 3 {
                        ForEach(Array(entries.dropFirst(3).enumerated()), id: \.element.id) { idx, entry in
                            QuizLeaderboardRow(
                                rank: idx + 4,
                                entry: entry,
                                isCurrentUser: entry.uid == currentUid
                            )
                        }
                    }

                    footer
                        .padding(.top, 8)
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .safeAreaInset(edge: .bottom) {
                if session.appUser != nil {
                    myRankBar
                }
            }
        }
    }

    private var myRankBar: some View {
        HStack(spacing: 10) {
            Image(systemName: myRank != nil ? "trophy.fill" : "person.circle")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(myRank != nil ? TwoWatchTheme.brandWarm : TwoWatchTheme.textMuted)
            if let myRank {
                Text("La tua posizione")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Text("#\(myRank)")
                    .font(.system(.subheadline, design: .rounded, weight: .heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .monospacedDigit()
            } else {
                Text("Non sei ancora in classifica")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            Spacer()
            Text("\(QuizScore.format(myScore)) punti")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.accent)
                .monospacedDigit()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel({
            if let myRank {
                return "La tua posizione: #\(myRank), \(QuizScore.format(myScore)) punti."
            }
            return "Non sei ancora in classifica. \(QuizScore.format(myScore)) punti."
        }())
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.caption2.weight(.semibold))
            Text("La classifica si aggiorna ogni lunedì alle 00:00")
                .font(.caption2)
        }
        .foregroundStyle(TwoWatchTheme.textMuted)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            entries = try await container.quizRepository.fetchLeaderboard(scope: scope, limit: 100)
            if let uid = currentUid {
                if let idx = entries.firstIndex(where: { $0.uid == uid }) {
                    myRank = idx + 1
                    myScore = entries[idx].score
                } else {
                    let stats = try await container.quizRepository.fetchUserStats(uid: uid)
                    myScore = (scope == .weekly) ? stats.weeklyScore : stats.totalScore
                    myRank = nil
                }
            }
            errorMessage = nil
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

}

// MARK: - Podium (top 3)
// A 3-pedestal stage: #1 centered and raised, #2 left, #3 right. Each pedestal
// carries an avatar with a colored ring + glow, the player's name and score.

private struct QuizPodiumView: View {
    let entries: [QuizLeaderboardEntry]
    let currentUid: String?

    private func entry(at rank: Int) -> QuizLeaderboardEntry? {
        guard rank - 1 < entries.count else { return nil }
        return entries[rank - 1]
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            pedestal(rank: 2)
            pedestal(rank: 1)
            pedestal(rank: 3)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 6)
    }

    @ViewBuilder
    private func pedestal(rank: Int) -> some View {
        if let entry = entry(at: rank) {
            let isFirst = rank == 1
            let color = QuizPodium.color(forRank: rank)
            let isMe = entry.uid == currentUid
            let avatarSize: CGFloat = isFirst ? 76 : 58
            let pedestalHeight: CGFloat = isFirst ? 96 : 64

            VStack(spacing: 6) {
                if isFirst {
                    Image(systemName: "crown.fill")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(QuizPodium.gold)
                        .shadow(color: QuizPodium.gold.opacity(0.6), radius: 8)
                        .accessibilityHidden(true)
                }

                podiumAvatar(entry: entry, size: avatarSize, ring: color, isFirst: isFirst)

                VStack(spacing: 2) {
                    Text(entry.displayName)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    if isMe {
                        QuizStatusPill(label: "Tu", tint: TwoWatchTheme.brandPrimary, filled: true)
                    }
                }
                .frame(maxWidth: .infinity)

                // Pedestal block.
                ZStack(alignment: .top) {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [color.opacity(0.32), color.opacity(0.12)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(color.opacity(0.5), lineWidth: 1)
                        )

                    VStack(spacing: 3) {
                        Text("\(rank)")
                            .font(.system(size: isFirst ? 30 : 24, weight: .black, design: .rounded))
                            .foregroundStyle(color)
                            .monospacedDigit()
                        Text(QuizScore.format(entry.score))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .monospacedDigit()
                    }
                    .padding(.top, isFirst ? 14 : 9)
                }
                .frame(height: pedestalHeight)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Posizione \(rank). \(entry.displayName)\(isMe ? ", tu" : ""). \(QuizScore.format(entry.score)) punti.")
        } else {
            // Empty slot keeps the 3-column stage balanced.
            VStack(spacing: 6) {
                Circle()
                    .fill(TwoWatchTheme.panel)
                    .frame(width: rank == 1 ? 76 : 58, height: rank == 1 ? 76 : 58)
                    .overlay(Image(systemName: "person.fill").foregroundStyle(TwoWatchTheme.textMuted))
                Text("—")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(TwoWatchTheme.panel)
                    .frame(height: rank == 1 ? 96 : 64)
            }
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
        }
    }

    private func podiumAvatar(entry: QuizLeaderboardEntry, size: CGFloat, ring: Color, isFirst: Bool) -> some View {
        // .single: una lettera, come prima. Il fondo ora e' il gradiente brand
        // ovunque (decisione 2026-08-09). L'anello
        // colorato per posizione resta qui, e' specifico della classifica.
        SomtoAvatar(
            url: entry.photoURL,
            name: entry.displayName,
            size: size,
            initialsStyle: .single
        )
        .overlay(Circle().stroke(ring, lineWidth: isFirst ? 3 : 2))
        .shadow(color: ring.opacity(isFirst ? 0.6 : 0.4), radius: isFirst ? 14 : 8)
    }

}

// MARK: - List row (ranks 4+)

private struct QuizLeaderboardRow: View {
    let rank: Int
    let entry: QuizLeaderboardEntry
    let isCurrentUser: Bool

    var body: some View {
        HStack(spacing: 12) {
            Text("\(rank)")
                .font(.footnote.weight(.heavy))
                .foregroundStyle(isCurrentUser ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                .frame(width: 30, height: 30)
                .background(
                    Circle().fill(isCurrentUser
                        ? TwoWatchTheme.brandPrimary.opacity(0.2)
                        : TwoWatchTheme.panelStrong)
                )
                .monospacedDigit()

            avatar

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(entry.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                    if isCurrentUser {
                        QuizStatusPill(label: "Tu", tint: TwoWatchTheme.brandPrimary, filled: true)
                    }
                }
                Text("\(entry.attemptsCount) partite")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .monospacedDigit()
            }
            Spacer()
            Text(QuizScore.format(entry.score))
                .font(.system(.subheadline, design: .rounded, weight: .heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .monospacedDigit()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isCurrentUser ? TwoWatchTheme.brandPrimary.opacity(0.14) : TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isCurrentUser ? TwoWatchTheme.brandPrimary.opacity(0.6) : TwoWatchTheme.border,
                        lineWidth: isCurrentUser ? 1.4 : 1)
        )
        .shadow(color: isCurrentUser ? TwoWatchTheme.brandPrimary.opacity(0.25) : .clear, radius: 10, y: 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Posizione \(rank). \(entry.displayName)\(isCurrentUser ? ", tu" : ""). \(QuizScore.format(entry.score)) punti, \(entry.attemptsCount) partite.")
    }

    @ViewBuilder
    private var avatar: some View {
        Group {
            if let url = entry.photoURL {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFill()
                    default: Color.white.opacity(0.08)
                    }
                }
            } else {
                ZStack {
                    Circle().fill(TwoWatchTheme.panelStrong)
                    Text(entry.displayName.prefix(1).uppercased())
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
        .frame(width: 38, height: 38)
        .clipShape(Circle())
        .overlay(
            Circle().stroke(isCurrentUser ? TwoWatchTheme.brandPrimary.opacity(0.6) : TwoWatchTheme.border, lineWidth: 1)
        )
    }

}
