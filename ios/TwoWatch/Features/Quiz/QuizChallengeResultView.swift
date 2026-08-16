import SwiftUI

/// Head-to-head result of a quiz challenge: who won, key stats, plus a
/// per-question comparison of both players' answers. Reachable from the
/// challenge inbox and right after finishing a challenge whose opponent
/// already played.
struct QuizChallengeResultView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let challenge: QuizChallenge

    @State private var questions: [QuizQuestion] = []
    @State private var otherUser: AppUser?
    @State private var isLoading = true
    @State private var confettiTrigger = 0

    private enum Outcome { case win, loss, tie, pending }

    private var currentUid: String? { session.appUser?.id }
    private var isFromMe: Bool { challenge.fromUid == currentUid }
    private var myScore: Double? { isFromMe ? challenge.fromScore : challenge.toScore }
    private var theirScore: Double? { isFromMe ? challenge.toScore : challenge.fromScore }
    private var myAnswers: [QuizAttemptAnswer] { isFromMe ? challenge.fromAnswers : challenge.toAnswers }
    private var theirAnswers: [QuizAttemptAnswer] { isFromMe ? challenge.toAnswers : challenge.fromAnswers }
    private var otherName: String { challenge.opponentLabel }

    private var outcome: Outcome {
        guard let mine = myScore, let theirs = theirScore else { return .pending }
        if mine > theirs { return .win }
        if mine < theirs { return .loss }
        return .tie
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                opponentHeader

                scoreboardCard

                if challenge.isComplete {
                    infoRows

                    if !myAnswers.isEmpty {
                        performanceSection
                    }
                }

                if challenge.isComplete {
                    if myAnswers.isEmpty || theirAnswers.isEmpty {
                        unavailableNotice
                    } else {
                        reviewSection
                    }
                } else {
                    waitingNotice
                }

                actionButtons
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 28)
        }
        .scrollIndicators(.hidden)
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .overlay(alignment: .top) {
            QuizConfettiView(trigger: confettiTrigger)
                .frame(height: 360)
                .allowsHitTesting(false)
        }
        .navigationTitle("Risultato sfida")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        let otherUid = isFromMe ? challenge.toUid : challenge.fromUid
        async let usersTask = container.userRepository.listUsers(ids: [otherUid].compactMap { $0 })
        async let questionsTask = container.quizRepository.fetchQuestions(byIds: challenge.questionIds)
        otherUser = (try? await usersTask)?.first
        questions = (try? await questionsTask) ?? []
        if outcome == .win {
            confettiTrigger += 1
        }
    }

    // MARK: - Opponent header

    private var opponentHeader: some View {
        VStack(spacing: 10) {
            opponentAvatar
            Text("SFIDA A \(otherName.uppercased())")
                .font(.caption.weight(.heavy))
                .foregroundStyle(TwoWatchTheme.accent)
                .lineLimit(1)
            QuizState.pill(for: challenge, isReceived: !isFromMe, hasPlayed: myScore != nil)
        }
        .frame(maxWidth: .infinity)
    }

    private var opponentAvatar: some View {
        // .single: questo punto mostrava UNA lettera. Il bordo colorato per
        // esito e la sua ombra restano qui, sono specifici della schermata.
        SomtoAvatar(
            url: otherUser?.photoURL ?? otherUser?.avatarURL,
            name: otherName,
            size: 72,
            initialsStyle: .single
        )
        .overlay(Circle().stroke(outcomeColor.opacity(0.7), lineWidth: 3))
        .shadow(color: outcomeColor.opacity(0.55), radius: 16, y: 6)
    }

    // MARK: - Scoreboard

    private var scoreboardCard: some View {
        VStack(spacing: 16) {
            HStack(alignment: .center, spacing: 8) {
                scoreColumn(
                    name: "Tu",
                    score: myScore,
                    isWinner: outcome == .win
                )
                VStack(spacing: 6) {
                    Text("VS")
                        .font(.system(size: 18, weight: .black, design: .rounded))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                    Image(systemName: "bolt.fill")
                        .font(.caption2.weight(.black))
                        .foregroundStyle(TwoWatchTheme.brandWarm)
                }
                scoreColumn(
                    name: otherName,
                    score: theirScore,
                    isWinner: outcome == .loss
                )
            }

            outcomePill
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .quizGlowCard(cornerRadius: 22, glowColor: outcomeColor, glowStrength: outcome == .pending ? 0 : 0.6)
        // Legge l'esito complessivo (Tu X – Avversario Y)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel({
            let me = myScore.map(QuizScore.format) ?? "—"
            let them = theirScore.map(QuizScore.format) ?? "—"
            let outcomeText: String = {
                switch outcome {
                case .win: return "Vittoria"
                case .loss: return "Sconfitta"
                case .tie: return "Pareggio"
                case .pending: return "Sfida in corso"
                }
            }()
            return "Tu \(me) punti contro \(otherName) \(them) punti. \(outcomeText)."
        }())
    }

    private func scoreColumn(name: String, score: Double?, isWinner: Bool) -> some View {
        VStack(spacing: 4) {
            Text(name)
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineLimit(1)
            Text(score.map(QuizScore.format) ?? "—")
                // font fisso: @ScaledMetric non applicabile (func non-struct).
                // Skippato: size 44pt dentro func scoreColumn, non un View struct.
                .font(.system(size: 44, weight: .black, design: .rounded))
                .foregroundStyle(isWinner ? outcomeColor : TwoWatchTheme.textPrimary)
                .monospacedDigit()
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Text("PUNTI")
                .font(.caption2.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true) // coperto dall'elemento padre (scoreboardCard)
    }

    private var outcomePill: some View {
        let (icon, label): (String, String) = {
            switch outcome {
            case .win: return ("crown.fill", "Vittoria")
            case .loss: return ("flag.checkered", "Sconfitta")
            case .tie: return ("equal.circle.fill", "Pareggio")
            case .pending: return ("hourglass", "Sfida in corso")
            }
        }()
        return HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.headline.weight(.bold))
            Text(label)
                .font(.system(.headline, design: .rounded, weight: .heavy))
        }
        .foregroundStyle(outcome == .pending ? TwoWatchTheme.textPrimary : .white)
        .padding(.horizontal, 18)
        .padding(.vertical, 9)
        .background {
            if outcome == .pending {
                Capsule().fill(TwoWatchTheme.panel)
            } else {
                Capsule().fill(outcomeColor)
            }
        }
        .overlay(Capsule().stroke(outcomeColor.opacity(outcome == .pending ? 0.4 : 0), lineWidth: 1))
        .accessibilityHidden(true) // coperto dall'etichetta del scoreboardCard
    }

    private var outcomeColor: Color {
        switch outcome {
        case .win: return TwoWatchTheme.success
        case .loss: return TwoWatchTheme.brandPrimary
        case .tie: return TwoWatchTheme.accent
        case .pending: return TwoWatchTheme.textMuted
        }
    }

    // MARK: - Info rows

    private var infoRows: some View {
        VStack(spacing: 0) {
            infoRow(icon: "list.number", label: "Domande", value: "\(challenge.numQuestions)")
            divider
            infoRow(
                icon: "calendar",
                label: String(localized: "Completata il"),
                value: challenge.completedAt.map(formatDate) ?? "—"
            )
            divider
            infoRow(
                icon: challenge.inviteType == .external ? "link" : "person.2.fill",
                label: "Modalità",
                value: challenge.inviteType == .external ? "Invito esterno" : "Sfida amico"
            )
            divider
            infoRow(
                icon: "film.stack",
                label: "Categoria",
                value: categoryLabel
            )
        }
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func infoRow(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.accent)
                .frame(width: 22)
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textSecondary)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .monospacedDigit()
                .lineLimit(1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private var divider: some View {
        Rectangle()
            .fill(TwoWatchTheme.border)
            .frame(height: 1)
            .padding(.leading, 48)
    }

    private var categoryLabel: String {
        // Most-common category across the challenge questions.
        let cats = questions.compactMap { $0.category }
        guard !cats.isEmpty else { return "Mista" }
        let counts = Dictionary(grouping: cats, by: { $0 }).mapValues(\.count)
        let unique = Set(cats)
        if unique.count > 1 { return "Mista" }
        return counts.keys.first.map(categoryItalianLabel) ?? "Mista"
    }

    private func categoryItalianLabel(_ category: QuizCategory) -> String {
        switch category {
        case .anagraphic: return "Anagrafica"
        case .character: return "Personaggi"
        case .plot: return "Trama"
        case .scene: return "Scene"
        case .relationship: return "Relazioni"
        case .object: return "Oggetti"
        case .motivation: return "Motivazioni"
        case .consequence: return "Conseguenze"
        case .episode: return "Episodi"
        case .quotePAraphrase: return "Citazioni"
        case .chronology: return "Cronologia"
        case .trivia: return "Curiosità"
        }
    }

    // MARK: - Performance

    private var performanceSection: some View {
        let correct = myAnswers.filter { $0.outcome == .correct }.count
        let answeredCount = max(myAnswers.count, 1)
        let accuracy = Int((Double(correct) / Double(answeredCount) * 100).rounded())
        let times = myAnswers.compactMap { $0.timeMs }
        let avgTime: String = times.isEmpty
            ? "—"
            : String(format: "%.1fs", Double(times.reduce(0, +)) / Double(times.count) / 1000)
        let bestStreak = longestCorrectStreak(myAnswers)

        return VStack(alignment: .leading, spacing: 10) {
            Text("Le tue prestazioni")
                .font(.system(.headline, design: .rounded, weight: .heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 10) {
                QuizStatTile(
                    label: "Corrette",
                    value: "\(accuracy)%",
                    icon: "scope",
                    accent: TwoWatchTheme.success,
                    sublabel: "\(correct)/\(myAnswers.count)"
                )
                QuizStatTile(
                    label: "Tempo medio",
                    value: avgTime,
                    icon: "timer",
                    accent: TwoWatchTheme.accent,
                    sublabel: "per domanda"
                )
                QuizStatTile(
                    label: "Serie",
                    value: "\(bestStreak)",
                    icon: "flame.fill",
                    accent: TwoWatchTheme.brandWarm,
                    sublabel: "migliore"
                )
            }
        }
    }

    private func longestCorrectStreak(_ answers: [QuizAttemptAnswer]) -> Int {
        var best = 0, current = 0
        for answer in answers {
            if answer.outcome == .correct {
                current += 1
                best = max(best, current)
            } else {
                current = 0
            }
        }
        return best
    }

    // MARK: - Notices

    private var waitingNotice: some View {
        VStack(spacing: 10) {
            Image(systemName: "hourglass")
                .font(.title)
                .foregroundStyle(TwoWatchTheme.accent)
            Text(myScore == nil
                ? "Devi ancora giocare questa sfida."
                : "\(otherName) non ha ancora giocato.")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .multilineTextAlignment(.center)
            Text("Il confronto delle risposte è disponibile quando entrambi avete finito.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .quizGlowCard(cornerRadius: 18, glowColor: TwoWatchTheme.accent, glowStrength: 0)
    }

    private var unavailableNotice: some View {
        VStack(spacing: 8) {
            Image(systemName: "doc.questionmark")
                .font(.title2)
                .foregroundStyle(TwoWatchTheme.textMuted)
            Text("Il confronto delle risposte non è disponibile per questa sfida.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.panel.opacity(0.6))
        )
    }

    // MARK: - Per-question review

    private var reviewSection: some View {
        let mineByQuestion = Dictionary(myAnswers.map { ($0.questionId, $0) }, uniquingKeysWith: { first, _ in first })
        let theirsByQuestion = Dictionary(theirAnswers.map { ($0.questionId, $0) }, uniquingKeysWith: { first, _ in first })

        return VStack(alignment: .leading, spacing: 12) {
            Text("Confronto risposte")
                .font(.system(.headline, design: .rounded, weight: .heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if questions.isEmpty {
                if isLoading {
                    ProgressView()
                        .tint(TwoWatchTheme.brandPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                } else {
                    Text("Impossibile caricare le domande della sfida.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
            } else {
                ForEach(Array(questions.enumerated()), id: \.element.id) { index, question in
                    questionReviewCard(
                        index: index + 1,
                        question: question,
                        mine: mineByQuestion[question.questionId],
                        theirs: theirsByQuestion[question.questionId]
                    )
                }
            }
        }
    }

    private func questionReviewCard(
        index: Int,
        question: QuizQuestion,
        mine: QuizAttemptAnswer?,
        theirs: QuizAttemptAnswer?
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("DOMANDA \(index)")
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .monospacedDigit()
                Spacer()
                HStack(spacing: 5) {
                    Image(systemName: "film.fill")
                        .font(.caption2.weight(.bold))
                    Text(question.title)
                        .font(.caption.weight(.bold))
                        .lineLimit(1)
                }
                .foregroundStyle(TwoWatchTheme.accent)
            }

            Text(question.questionText)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.success)
                Text(correctAnswerText(question))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 6) {
                answerComparisonRow(label: "Tu", answer: mine, question: question)
                answerComparisonRow(label: otherName, answer: theirs, question: question)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func answerComparisonRow(
        label: String,
        answer: QuizAttemptAnswer?,
        question: QuizQuestion
    ) -> some View {
        let outcome = answer?.outcome ?? .skipped
        let (icon, color): (String, Color) = {
            switch outcome {
            case .correct: return ("checkmark.circle.fill", TwoWatchTheme.success)
            case .wrong: return ("xmark.circle.fill", TwoWatchTheme.brandPrimary)
            case .skipped: return ("minus.circle.fill", TwoWatchTheme.textMuted)
            }
        }()
        return HStack(spacing: 10) {
            Text(label)
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .frame(width: 66, alignment: .leading)
                .lineLimit(1)
            Text(answerText(answer, question: question))
                .font(.caption.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(color.opacity(0.10))
        )
    }

    // MARK: - Actions

    private var actionButtons: some View {
        VStack(spacing: 10) {
            NavigationLink {
                QuizChallengeComposerView(container: container, session: session)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                    Text("Sfida di nuovo")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityLabel("Crea una nuova sfida")

            NavigationLink {
                QuizChallengeInboxView(container: container, session: session, shell: shell)
            } label: {
                Text("Vedi tutte le sfide")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Vedi tutte le sfide")
        }
        .padding(.top, 4)
    }

    // MARK: - Helpers

    private func correctAnswerText(_ question: QuizQuestion) -> String {
        guard question.answers.indices.contains(question.correctAnswerIndex) else { return "—" }
        return question.answers[question.correctAnswerIndex]
    }

    private func answerText(_ answer: QuizAttemptAnswer?, question: QuizQuestion) -> String {
        guard let answer else { return String(localized: "Nessuna risposta") }
        guard let index = answer.selectedIndex, question.answers.indices.contains(index) else {
            return "Saltata"
        }
        return question.answers[index]
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        // Locale corrente, non it_IT fisso: la data deve seguire la lingua
        // dell'app. E template invece di dateFormat, perche' l'ORDINE dei
        // componenti cambia per lingua ("5 gen 2026" vs "Jan 5, 2026").
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("d MMM yyyy")
        return formatter.string(from: date)
    }
}
