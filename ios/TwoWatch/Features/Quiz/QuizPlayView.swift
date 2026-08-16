import SwiftUI

@Observable
@MainActor
final class QuizPlayViewModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case ready
        case finished
        case error(String)
    }

    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let mode: QuizMode
    let challenge: QuizChallenge?
    /// When set (solo path), restricts the question pool to this single title.
    /// `nil` means "Tutti i titoli" → random across the whole playable pool.
    let selectedTitleId: String?
    /// How many questions this run should serve. Ignored on the challenge path,
    /// where the count is fixed by the challenge's saved `questionIds`.
    let questionCount: Int

    var state: LoadState = .idle
    var questions: [QuizQuestion] = []
    var currentIndex: Int = 0
    var selectedAnswerIndex: Int?
    var answers: [QuizAttemptAnswer] = []
    var lastAttempt: QuizAttempt?
    /// Challenge re-fetched after `finish()` so the result screen can offer a
    /// head-to-head comparison the moment both players have played.
    var resolvedChallenge: QuizChallenge?

    /// XP / streak / daily-bonus reward earned by finishing this game,
    /// surfaced on the result screen.
    var gamificationReward: QuizGamificationReward = .none

    /// When `true` the player is showing the outcome of the current question
    /// (with the correct answer highlighted). The user must tap "Continua"
    /// to advance to the next question. When `false` the player is taking
    /// input.
    var isRevealing: Bool = false
    /// Outcome of the answer being revealed (nil when not revealing).
    var revealedOutcome: QuizAnswerOutcome?
    /// Selected answer captured at confirm time, kept so the UI can still
    /// render the chosen pill after the answers array is mutated.
    var revealedSelectedIndex: Int?
    /// True briefly when the user reports a problem on the current question,
    /// used to show a confirmation toast.
    var lastReportConfirmation: String?

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        mode: QuizMode,
        challenge: QuizChallenge?,
        selectedTitleId: String? = nil,
        questionCount: Int = 10
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.mode = mode
        self.challenge = challenge
        self.selectedTitleId = selectedTitleId
        self.questionCount = questionCount
    }

    var currentQuestion: QuizQuestion? {
        guard currentIndex < questions.count else { return nil }
        return questions[currentIndex]
    }

    var progress: Double {
        guard !questions.isEmpty else { return 0 }
        return Double(currentIndex) / Double(questions.count)
    }

    var liveScore: Double {
        QuizScoring.score(for: answers)
    }

    /// Current consecutive-correct streak ending at the latest answer.
    /// Resets on wrong or skipped. Used to keep players motivated.
    var currentStreak: Int {
        var streak = 0
        for answer in answers.reversed() {
            if answer.outcome == .correct { streak += 1 } else { break }
        }
        return streak
    }

    /// Best streak achieved during the run (max consecutive corrects).
    var bestStreak: Int {
        var best = 0
        var running = 0
        for answer in answers {
            if answer.outcome == .correct {
                running += 1
                best = max(best, running)
            } else {
                running = 0
            }
        }
        return best
    }

    /// Correct / answered (non-skipped). 0.0 ... 1.0. Returns nil if nothing
    /// was answered (only skips).
    var liveAccuracy: Double? {
        let answered = answers.filter { $0.outcome != .skipped }.count
        guard answered > 0 else { return nil }
        let correct = answers.filter { $0.outcome == .correct }.count
        return Double(correct) / Double(answered)
    }

    func start() async {
        state = .loading
        do {
            let qs: [QuizQuestion]
            if let challenge {
                // Load by challenge questionIds order
                qs = try await fetchByIds(challenge.questionIds)
            } else if let selectedTitleId {
                // Solo run on a specific theme/title chosen in the setup step.
                qs = try await container.quizRepository.fetchPlayableQuestions(
                    titleIds: [selectedTitleId],
                    count: questionCount
                )
            } else {
                // Solo run across the whole playable pool ("Tutti i titoli").
                qs = try await container.quizRepository.fetchPlayableQuestions(count: questionCount)
            }
            guard !qs.isEmpty else {
                state = .error(selectedTitleId != nil
                    ? String(localized: "Per questo titolo non ci sono ancora domande disponibili. Prova con un altro tema.")
                    : String(localized: "Nessuna domanda disponibile al momento."))
                return
            }
            questions = qs
            currentIndex = 0
            selectedAnswerIndex = nil
            answers = []
            state = .ready
        } catch {
            state = .error(UserFacingError.message(for: error))
        }
    }

    private func fetchByIds(_ ids: [String]) async throws -> [QuizQuestion] {
        // Direct read by document id so both opponents see the exact set
        // saved in `quizChallenges/{id}.questionIds`, in the same order.
        try await container.quizRepository.fetchQuestions(byIds: ids)
    }

    func confirmCurrent() {
        guard let q = currentQuestion else { return }
        guard let selected = selectedAnswerIndex else { return }
        let outcome: QuizAnswerOutcome = (selected == q.correctAnswerIndex) ? .correct : .wrong
        answers.append(QuizAttemptAnswer(questionId: q.questionId, selectedIndex: selected, outcome: outcome, timeMs: nil))
        revealedOutcome = outcome
        revealedSelectedIndex = selected
        isRevealing = true
    }

    func skipCurrent() {
        guard let q = currentQuestion else { return }
        answers.append(QuizAttemptAnswer(questionId: q.questionId, selectedIndex: nil, outcome: .skipped, timeMs: nil))
        revealedOutcome = .skipped
        revealedSelectedIndex = nil
        isRevealing = true
    }

    /// Advances to the next question after a reveal. Called when the user
    /// taps "Continua".
    func continueFromReveal() {
        isRevealing = false
        revealedOutcome = nil
        revealedSelectedIndex = nil
        selectedAnswerIndex = nil
        lastReportConfirmation = nil
        currentIndex += 1
        if currentIndex >= questions.count {
            Task { await finish() }
        }
    }

    /// Reports a problem on the currently revealed question. Persists a
    /// document under `quizQuestionReports/{auto}` so admins can review.
    func reportCurrentProblem(reason: String) async {
        guard let q = currentQuestion else { return }
        guard let uid = session.appUser?.id else { return }
        do {
            try await container.quizRepository.reportQuestionProblem(
                questionId: q.questionId,
                reportedBy: uid,
                reason: reason,
                attemptOutcome: revealedOutcome
            )
            lastReportConfirmation = "Segnalazione inviata. Grazie."
        } catch {
            lastReportConfirmation = String(localized: "Impossibile inviare la segnalazione.")
        }
    }

    private func finish() async {
        guard let uid = session.appUser?.id else {
            state = .finished
            return
        }
        let correctCount = answers.filter { $0.outcome == .correct }.count
        let wrongCount = answers.filter { $0.outcome == .wrong }.count
        let skippedCount = answers.filter { $0.outcome == .skipped }.count
        let attempt = QuizAttempt(
            attemptId: UUID().uuidString,
            uid: uid,
            mode: mode,
            challengeId: challenge?.challengeId,
            questionIds: questions.map(\.questionId),
            answers: answers,
            score: QuizScoring.score(for: answers),
            correctCount: correctCount,
            wrongCount: wrongCount,
            skippedCount: skippedCount,
            createdAt: Date()
        )
        do {
            var reward = try await container.quizRepository.submitAttempt(attempt)
            if let challenge {
                let side: QuizRepository.ChallengeSide = (challenge.fromUid == uid) ? .from : .to
                reward = try await container.quizRepository.recordChallengePlay(
                    challengeId: challenge.challengeId,
                    side: side,
                    playerUid: uid,
                    score: attempt.score,
                    correctCount: correctCount,
                    answers: answers
                )
                resolvedChallenge = try? await container.quizRepository.fetchChallenge(id: challenge.challengeId)
            }
            gamificationReward = reward
            lastAttempt = attempt
        } catch {
            lastAttempt = attempt
        }
        state = .finished
    }
}

struct QuizPlayView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let mode: QuizMode
    let challenge: QuizChallenge?
    /// Solo-only: restricts the run to a single title. `nil` = whole pool.
    var selectedTitleId: String? = nil
    /// Solo-only: number of questions to serve. Defaults to 10 for backward
    /// compatibility (challenge path ignores it).
    var questionCount: Int = 10

    @State private var viewModel: QuizPlayViewModel?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if let viewModel {
                switch viewModel.state {
                case .idle, .loading:
                    QuizLoadingOverlay()
                case let .error(message):
                    QuizErrorView(message: message) {
                        Task { await viewModel.start() }
                    }
                case .ready:
                    if viewModel.currentQuestion != nil {
                        QuizPlayContent(viewModel: viewModel)
                    } else {
                        QuizLoadingOverlay()
                    }
                case .finished:
                    QuizResultView(viewModel: viewModel) {
                        dismiss()
                    }
                }
            } else {
                QuizLoadingOverlay()
            }
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Quiz")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(TwoWatchTheme.background.opacity(0.95), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            if viewModel == nil {
                let vm = QuizPlayViewModel(
                    container: container,
                    session: session,
                    shell: shell,
                    mode: mode,
                    challenge: challenge,
                    selectedTitleId: selectedTitleId,
                    questionCount: questionCount
                )
                viewModel = vm
                await vm.start()
            }
        }
    }
}

private struct QuizPlayContent: View {
    @Bindable var viewModel: QuizPlayViewModel
    @State private var showReportSheet: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                progressHeader

                scoreBadge

                if let q = viewModel.currentQuestion {
                    questionBody(q)
                    answerOptions(q)
                    if viewModel.isRevealing {
                        outcomeBanner(q)
                            .transition(.scale(scale: 0.85, anchor: .top).combined(with: .opacity))
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 24)
            .animation(.spring(response: 0.35, dampingFraction: 0.78), value: viewModel.isRevealing)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        // Haptics: success on correct, error on wrong, soft impact on skip.
        // Fires only when isRevealing flips true so each outcome gives one tick.
        .sensoryFeedback(.success, trigger: viewModel.isRevealing) { _, newValue in
            newValue && viewModel.revealedOutcome == .correct
        }
        .sensoryFeedback(.error, trigger: viewModel.isRevealing) { _, newValue in
            newValue && viewModel.revealedOutcome == .wrong
        }
        .sensoryFeedback(.impact(weight: .light), trigger: viewModel.isRevealing) { _, newValue in
            newValue && viewModel.revealedOutcome == .skipped
        }
        // Extra celebratory thump when the streak reaches a milestone (3 or
        // every 2 after). Kept distinct from the `.success` tick so that
        // streaking feels physically different from "just got one right".
        .sensoryFeedback(.impact(weight: .heavy), trigger: viewModel.isRevealing) { _, newValue in
            guard newValue, viewModel.revealedOutcome == .correct else { return false }
            let s = viewModel.currentStreak
            return s == 3 || (s >= 5 && s % 2 == 1)
        }
        // Subtle tick when the user picks an option (only on actual selection,
        // not when we reset to nil between questions).
        .sensoryFeedback(.selection, trigger: viewModel.selectedAnswerIndex) { oldValue, newValue in
            newValue != nil && oldValue != newValue
        }
        .safeAreaInset(edge: .bottom) {
            actionBar
                .padding(.horizontal, 18)
                .padding(.top, 10)
                .padding(.bottom, 12)
                .background(.ultraThinMaterial)
        }
        .overlay(alignment: .bottom) {
            if let toast = viewModel.lastReportConfirmation {
                Text(toast)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(TwoWatchTheme.brandPrimary.opacity(0.9), in: Capsule())
                    .padding(.bottom, 110)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: viewModel.lastReportConfirmation)
        .sheet(isPresented: $showReportSheet) {
            ReportProblemSheet { reason in
                Task { await viewModel.reportCurrentProblem(reason: reason) }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    private func outcomeBanner(_ q: QuizQuestion) -> some View {
        let outcome = viewModel.revealedOutcome ?? .skipped
        let (icon, color, title): (String, Color, String) = {
            switch outcome {
            case .correct:
                let streak = viewModel.currentStreak
                let suffix: String = {
                    switch streak {
                    case ..<2: return ""
                    case 2: return " · 2 di fila"
                    case 3: return " · 3 di fila!"
                    case 4: return String(localized: " · 4 di fila, sei in fiamme!")
                    default: return " · \(streak) di fila!"
                    }
                }()
                return ("checkmark.circle.fill", TwoWatchTheme.success, "Risposta corretta!\(suffix)")
            case .wrong: return ("xmark.circle.fill", TwoWatchTheme.brandPrimary, "Risposta sbagliata")
            case .skipped: return ("forward.end.circle.fill", TwoWatchTheme.textMuted, "Domanda saltata")
            }
        }()
        let correctText = q.answers[safeQuiz: q.correctAnswerIndex] ?? ""

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.title.weight(.bold))
                    .foregroundStyle(color)
                    .symbolEffect(.bounce, value: viewModel.isRevealing)
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button {
                    showReportSheet = true
                } label: {
                    Label("Segnala", systemImage: "exclamationmark.bubble")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Segnala problema su questa domanda")
            }
            if outcome != .correct {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Risposta corretta")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .textCase(.uppercase)
                    Text(correctText)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let explanation = q.explanation, !explanation.isEmpty {
                Text(explanation)
                    .font(.footnote)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(color.opacity(0.18))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(color.opacity(0.5), lineWidth: 1))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(outcome != .correct ? "Risposta corretta: \(correctText)." : "")")
    }

    private var progressHeader: some View {
        let current = min(viewModel.currentIndex + 1, viewModel.questions.count)
        let total = viewModel.questions.count
        let remaining = max(total - current, 0)
        // Fill reflects answered questions, not just current index, so the bar
        // visibly grows on each "Continua" rather than only between questions.
        let filled = Double(viewModel.answers.count) / Double(max(total, 1))
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Domanda \(current) di \(total)")
                    .font(.subheadline.weight(.heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .monospacedDigit()
                Spacer()
                if remaining > 0 {
                    Text("\(remaining) restanti")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .monospacedDigit()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Domanda \(current) di \(total). \(remaining) restanti.")

            QuizProgressBar(value: filled, height: 10)
        }
    }

    private var scoreBadge: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "star.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Punteggio")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .textCase(.uppercase)
                    Text(QuizScore.format(viewModel.liveScore))
                        .font(.system(.headline, design: .rounded, weight: .heavy))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .monospacedDigit()
                        .contentTransition(.numericText(value: viewModel.liveScore))
                        .animation(.snappy, value: viewModel.liveScore)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                Capsule(style: .continuous)
                    .fill(TwoWatchTheme.panel)
            )
            .overlay(
                Capsule(style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Punteggio \(QuizScore.format(viewModel.liveScore))")

            if viewModel.currentStreak >= 2 {
                QuizStreakChip(count: viewModel.currentStreak, isDaily: false, animate: true)
                    .transition(.scale.combined(with: .opacity))
            }

            Spacer()

            if let q = viewModel.currentQuestion {
                let color = difficultyColor(q.difficulty)
                QuizStatusPill(label: q.difficulty.italianLabel, tint: color, systemImage: "speedometer")
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.7), value: viewModel.currentStreak)
    }

    private func questionBody(_ q: QuizQuestion) -> some View {
        ZStack(alignment: .topTrailing) {
            // Decorative movie-reel art in the corner.
            Image(systemName: "film.stack")
                .font(.system(size: 64, weight: .bold))
                .foregroundStyle(TwoWatchTheme.brandPrimary.opacity(0.1))
                .offset(x: 14, y: -10)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 14) {
                // Title chip — film/tv icon + the title name.
                HStack(spacing: 6) {
                    Image(systemName: q.mediaType == .tv ? "tv.fill" : "film.fill")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                    Text(q.title)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                        .lineLimit(1)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    Capsule(style: .continuous)
                        .fill(TwoWatchTheme.accent.opacity(0.14))
                )
                .overlay(
                    Capsule(style: .continuous)
                        .stroke(TwoWatchTheme.accent.opacity(0.32), lineWidth: 1)
                )

                Text(q.questionText)
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(TwoWatchTheme.backgroundSecondary)
        )
        .overlay(
            // Left edge magenta accent glow.
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(TwoWatchTheme.brandGradient)
                    .frame(width: 4)
                    .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.6), radius: 6)
                Spacer()
            }
            .padding(.vertical, 16)
            .padding(.leading, 2)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.brandPrimary.opacity(0.22), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.35), radius: 14, y: 8)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func answerOptions(_ q: QuizQuestion) -> some View {
        VStack(spacing: 10) {
            ForEach(Array(q.answers.enumerated()), id: \.offset) { idx, answer in
                Button {
                    guard !viewModel.isRevealing else { return }
                    viewModel.selectedAnswerIndex = idx
                } label: {
                    answerRow(idx: idx, answer: answer, correctIndex: q.correctAnswerIndex)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isRevealing)
                .accessibilityLabel("Risposta \(letter(idx)): \(answer)")
                .accessibilityHint(viewModel.isRevealing ? "" : "Doppio tap per selezionare")
                .accessibilityAddTraits(viewModel.selectedAnswerIndex == idx ? .isSelected : [])
            }
        }
    }

    @ViewBuilder
    private func answerRow(idx: Int, answer: String, correctIndex: Int) -> some View {
        let isSelected = viewModel.selectedAnswerIndex == idx
        let revealing = viewModel.isRevealing
        let isCorrectChoice = idx == correctIndex
        let isPickedDuringReveal = viewModel.revealedSelectedIndex == idx

        // Style during reveal: correct = green outline; user's pick (if wrong) = red outline.
        let strokeColor: Color = {
            if revealing {
                if isCorrectChoice { return TwoWatchTheme.success }
                if isPickedDuringReveal { return TwoWatchTheme.brandPrimary }
                return TwoWatchTheme.border
            }
            return isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border
        }()
        let strokeWidth: CGFloat = {
            if revealing && (isCorrectChoice || isPickedDuringReveal) { return 1.6 }
            return isSelected ? 1.4 : 1
        }()
        let badgeFill: Color = {
            if revealing && isCorrectChoice { return TwoWatchTheme.success.opacity(0.35) }
            if revealing && isPickedDuringReveal { return TwoWatchTheme.brandPrimary.opacity(0.35) }
            return isSelected ? TwoWatchTheme.brandPrimary.opacity(0.35) : TwoWatchTheme.panel
        }()

        HStack(alignment: .center, spacing: 14) {
            Text(letter(idx))
                .font(.system(.subheadline, design: .rounded, weight: .heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(badgeFill))
                .overlay(
                    Circle()
                        .stroke(strokeColor.opacity(0.4), lineWidth: 1)
                )
            Text(answer)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
            if revealing && isCorrectChoice {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(TwoWatchTheme.success)
                    .symbolEffect(.bounce, value: viewModel.isRevealing)
            } else if revealing && isPickedDuringReveal {
                Image(systemName: "xmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
            } else if isSelected && !revealing {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
            }
        }
        .padding(14)
        .frame(minHeight: 56, alignment: .leading)
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(TwoWatchTheme.panel)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(strokeColor, lineWidth: strokeWidth)
                )
        )
    }

    @ViewBuilder
    private var actionBar: some View {
        if viewModel.isRevealing {
            Button {
                viewModel.continueFromReveal()
            } label: {
                Text(viewModel.currentIndex + 1 >= viewModel.questions.count ? "Vedi risultato" : "Continua")
            }
            .buttonStyle(PrimaryButtonStyle())
            .accessibilityLabel(viewModel.currentIndex + 1 >= viewModel.questions.count ? "Vedi risultato finale" : "Continua alla prossima domanda")
        } else {
            HStack(spacing: 12) {
                Button {
                    viewModel.skipCurrent()
                } label: {
                    Text("Salta")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(minHeight: 26)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 14)
                        .background(
                            Capsule().stroke(TwoWatchTheme.border, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Salta domanda")
                .accessibilityHint("Non assegna punti")

                Button {
                    viewModel.confirmCurrent()
                } label: {
                    Text("Conferma")
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(viewModel.selectedAnswerIndex == nil)
                .opacity(viewModel.selectedAnswerIndex == nil ? 0.55 : 1)
                .accessibilityLabel("Conferma risposta")
            }
        }
    }

    private func letter(_ idx: Int) -> String {
        let letters = ["A", "B", "C", "D"]
        return idx < letters.count ? letters[idx] : "?"
    }

    private func difficultyColor(_ d: QuizDifficulty) -> Color {
        switch d {
        case .easy: return TwoWatchTheme.success
        case .medium: return TwoWatchTheme.accent
        case .hard: return TwoWatchTheme.warning
        }
    }

}

private struct ReportProblemSheet: View {
    let onSubmit: (String) -> Void
    @State private var selectedReason: String = "Risposta errata"
    @State private var note: String = ""
    @Environment(\.dismiss) private var dismiss

    private let reasons = [
        "Risposta errata",
        "Domanda ambigua",
        String(localized: "Più risposte plausibili"),
        String(localized: "Spoiler non segnalato"),
        "Errore di battitura",
        "Altro"
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Cosa non torna?")
                        .font(.headline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(reasons, id: \.self) { reason in
                            Button {
                                selectedReason = reason
                            } label: {
                                HStack {
                                    Image(systemName: selectedReason == reason ? "largecircle.fill.circle" : "circle")
                                        .foregroundStyle(selectedReason == reason ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textMuted)
                                    Text(reason)
                                        .font(.subheadline)
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                    Spacer()
                                }
                                .padding(.vertical, 8)
                                .padding(.horizontal, 12)
                                .background(
                                    RoundedRectangle(cornerRadius: 10)
                                        .fill(TwoWatchTheme.panel.opacity(0.6))
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    Text("Nota (opzionale)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    TextEditor(text: $note)
                        .frame(minHeight: 90)
                        .padding(8)
                        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(TwoWatchTheme.border, lineWidth: 1))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .scrollContentBackground(.hidden)
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                Button {
                    let combined = note.isEmpty ? selectedReason : "\(selectedReason): \(note)"
                    onSubmit(combined)
                    dismiss()
                } label: {
                    Text("Invia segnalazione")
                }
                .buttonStyle(PrimaryButtonStyle())
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
                .padding(.top, 8)
                .background(.ultraThinMaterial)
            }
            .background(TwoWatchTheme.background.ignoresSafeArea())
            .navigationTitle("Segnala problema")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Annulla") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }
}

private extension Array {
    subscript(safeQuiz idx: Int) -> Element? {
        indices.contains(idx) ? self[idx] : nil
    }
}

private struct QuizErrorView: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(TwoWatchTheme.warning)
            Text("Qualcosa è andato storto")
                .font(.headline)
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(message)
                .font(.footnote)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
            Button("Riprova", action: onRetry)
                .buttonStyle(PrimaryButtonStyle())
                .frame(maxWidth: 220)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct QuizResultView: View {
    @Bindable var viewModel: QuizPlayViewModel
    let onDone: () -> Void

    @State private var confettiTrigger = 0
    @State private var xpBadgePop = false

    // @ScaledMetric: punteggio eroe — default 60pt invariato, scala con size category
    @ScaledMetric(relativeTo: .largeTitle) private var scoreFontSize: CGFloat = 60

    private var correctCount: Int { viewModel.answers.filter { $0.outcome == .correct }.count }
    private var wrongCount: Int { viewModel.answers.filter { $0.outcome == .wrong }.count }
    private var skippedCount: Int { viewModel.answers.filter { $0.outcome == .skipped }.count }

    private var accuracyPct: Int? {
        let answered = correctCount + wrongCount
        guard answered > 0 else { return nil }
        return Int((Double(correctCount) / Double(answered) * 100).rounded())
    }

    private var reward: QuizGamificationReward { viewModel.gamificationReward }

    /// Confetti only celebrates a genuinely good run.
    private var deservesConfetti: Bool { (accuracyPct ?? 0) >= 50 }

    private var summaryHeadline: (icon: String, color: Color, title: String, subtitle: String) {
        let pct = accuracyPct ?? 0
        switch pct {
        case 90...:
            return ("crown.fill", TwoWatchTheme.brandWarm, String(localized: "Sei un fuoriclasse"), "Risultato eccellente.")
        case 70..<90:
            return ("trophy.fill", TwoWatchTheme.brandWarm, "Ottimo lavoro", "Conosci bene i tuoi titoli.")
        case 50..<70:
            return ("star.fill", TwoWatchTheme.accent, "Buon risultato", String(localized: "C'è ancora margine per migliorare."))
        case 1..<50:
            return ("flag.fill", TwoWatchTheme.brandPrimary, String(localized: "Si può fare di meglio"), String(localized: "Riprova con un altro round."))
        default:
            return ("flag.fill", TwoWatchTheme.textMuted, String(localized: "Hai saltato tutto"), String(localized: "Tenta una risposta al prossimo round."))
        }
    }

    var body: some View {
        let headline = summaryHeadline
        ScrollView {
            VStack(spacing: 18) {
                // Headline.
                VStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(headline.color.opacity(0.18))
                            .frame(width: 96, height: 96)
                        Circle()
                            .fill(headline.color.opacity(0.12))
                            .frame(width: 96, height: 96)
                            .blur(radius: 22)
                        Image(systemName: headline.icon)
                            .font(.system(size: 44, weight: .bold))
                            .foregroundStyle(headline.color)
                            .symbolEffect(.bounce, value: viewModel.state)
                    }
                    Text(headline.title)
                        .font(.system(.title, design: .rounded, weight: .heavy))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .multilineTextAlignment(.center)
                    Text(headline.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 16)

                // Big score — hero glow card.
                VStack(spacing: 4) {
                    Text("PUNTEGGIO")
                        .font(.caption.weight(.bold))
                        .tracking(2)
                        .foregroundStyle(.white.opacity(0.85))
                    Text(QuizScore.format(viewModel.liveScore))
                        .font(.system(size: scoreFontSize, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                        .monospacedDigit()
                        .contentTransition(.numericText(value: viewModel.liveScore))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 22)
                .quizGlowCard(
                    cornerRadius: 24,
                    gradient: LinearGradient(
                        colors: [TwoWatchTheme.brandPrimary, TwoWatchTheme.brandSecondary],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    glowColor: TwoWatchTheme.brandPrimary
                )

                // Gamification reward block (XP / streak / bonus).
                rewardBlock

                // Accuracy / best-streak stat tiles.
                HStack(spacing: 10) {
                    QuizStatTile(
                        label: "Accuratezza",
                        value: accuracyPct.map { "\($0)%" } ?? "—",
                        icon: "scope",
                        accent: TwoWatchTheme.accent,
                        sublabel: "risposte giuste"
                    )
                    QuizStatTile(
                        label: "Miglior serie",
                        value: "\(viewModel.bestStreak)",
                        icon: "flame.fill",
                        accent: TwoWatchTheme.brandWarm,
                        sublabel: "di fila"
                    )
                }

                // Breakdown.
                VStack(spacing: 8) {
                    breakdownRow(label: "Corrette", value: correctCount, color: TwoWatchTheme.success, icon: "checkmark.circle.fill")
                    breakdownRow(label: "Errate", value: wrongCount, color: TwoWatchTheme.brandPrimary, icon: "xmark.circle.fill")
                    breakdownRow(label: "Saltate", value: skippedCount, color: TwoWatchTheme.textMuted, icon: "forward.end.circle.fill")
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .overlay(alignment: .top) {
            QuizConfettiView(trigger: confettiTrigger)
                .frame(maxHeight: .infinity)
                .ignoresSafeArea()
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 10) {
                if let challenge = viewModel.resolvedChallenge, challenge.isComplete {
                    NavigationLink {
                        QuizChallengeResultView(
                            container: viewModel.container,
                            session: viewModel.session,
                            shell: viewModel.shell,
                            challenge: challenge
                        )
                    } label: {
                        Label("Vedi confronto sfida", systemImage: "person.2.fill")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityLabel("Vedi il confronto della sfida")
                } else {
                    Button {
                        Task { await viewModel.start() }
                    } label: {
                        Label("Rigioca", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityLabel("Rigioca un nuovo quiz")
                }

                Button("Chiudi") {
                    maybeTriggerRatingPrompt()
                    onDone()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .accessibilityLabel("Torna alla home Quiz")
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
            .padding(.top, 8)
            .background(.ultraThinMaterial)
        }
        .sensoryFeedback(.success, trigger: viewModel.state == .finished)
        .task {
            // Confetti + XP pop on entry, once.
            if deservesConfetti { confettiTrigger += 1 }
            try? await Task.sleep(for: .milliseconds(180))
            withAnimation(.spring(response: 0.4, dampingFraction: 0.55)) {
                xpBadgePop = true
            }
        }
    }

    // MARK: Gamification reward block

    @ViewBuilder
    private var rewardBlock: some View {
        if reward.xpAwarded > 0 || reward.dailyStreak > 0 {
            VStack(spacing: 12) {
                HStack {
                    Text("Ricompense")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Spacer()
                    if reward.dailyBonusActive {
                        QuizStatusPill(
                            label: "Bonus +20% attivo",
                            tint: TwoWatchTheme.success,
                            systemImage: "gift.fill"
                        )
                    }
                }

                HStack(spacing: 12) {
                    if reward.xpAwarded > 0 {
                        QuizXPBadge(xp: reward.xpAwarded, showsPlus: true)
                            .scaleEffect(xpBadgePop ? 1 : 0.4)
                            .opacity(xpBadgePop ? 1 : 0)
                    }
                    if reward.dailyStreak > 0 {
                        QuizStreakChip(count: reward.dailyStreak, isDaily: true, animate: true)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TwoWatchTheme.brandWarm.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TwoWatchTheme.brandWarm.opacity(0.28), lineWidth: 1)
            )
            .accessibilityElement(children: .combine)
        }
    }

    private func breakdownRow(label: String, value: Int, color: Color, icon: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(color)
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Spacer()
            Text("\(value)")
                .font(.system(.subheadline, design: .rounded, weight: .heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private func maybeTriggerRatingPrompt() {
        let service = viewModel.container.ratingPromptService
        let version = RatingPromptService.currentAppVersion
        if (accuracyPct ?? 0) >= 50 {
            service.recordQualifyingEvent()
        }
        guard service.shouldPresentPrompt(currentVersion: version) else { return }
        service.recordPromptShown(version: version)
        viewModel.shell.isRatingPromptPresented = true
    }
}
