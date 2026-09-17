import SwiftUI

struct AdminQuizEditorView: View {
    let container: AppContainer
    let session: SessionStore
    let question: QuizQuestion
    let onChange: () -> Void

    @State private var questionText: String
    @State private var answers: [String]
    @State private var correctAnswerIndex: Int
    @State private var difficulty: QuizDifficulty
    @State private var spoilerLevel: QuizSpoilerLevel
    @State private var saving = false
    @State private var pendingStatus: QuizQuestionStatus?
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    init(container: AppContainer, session: SessionStore, question: QuizQuestion, onChange: @escaping () -> Void) {
        self.container = container
        self.session = session
        self.question = question
        self.onChange = onChange
        _questionText = State(initialValue: question.questionText)
        _answers = State(initialValue: question.answers)
        _correctAnswerIndex = State(initialValue: question.correctAnswerIndex)
        _difficulty = State(initialValue: question.difficulty)
        _spoilerLevel = State(initialValue: question.spoilerLevel)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                titleHeader

                fieldBlock(label: "Domanda") {
                    TextEditor(text: $questionText)
                        .frame(minHeight: 96)
                        .padding(8)
                        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(TwoWatchTheme.border, lineWidth: 1))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .scrollContentBackground(.hidden)
                }

                answersEditor

                pickers

                actionsRow

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
            }
            .padding(16)
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Domanda")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var titleHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(question.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.accent)
                .textCase(.uppercase)
            Text("ID \(question.questionId)")
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
    }

    private func fieldBlock<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
            content()
        }
    }

    private var answersEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Risposte")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
            ForEach(0..<4, id: \.self) { idx in
                HStack(spacing: 10) {
                    Button {
                        correctAnswerIndex = idx
                    } label: {
                        Image(systemName: correctAnswerIndex == idx ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(correctAnswerIndex == idx ? TwoWatchTheme.success : TwoWatchTheme.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(correctAnswerIndex == idx
                        ? "Risposta \(letter(idx)) corretta (selezionata)"
                        : "Segna risposta \(letter(idx)) come corretta")
                    .accessibilityAddTraits(correctAnswerIndex == idx ? [.isButton, .isSelected] : .isButton)
                    Text(letter(idx))
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(width: 18)
                    TextField("Risposta \(letter(idx))", text: Binding(
                        get: { answers[idx] },
                        set: { answers[idx] = $0 }
                    ), axis: .vertical)
                    .textFieldStyle(.plain)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .padding(10)
                    .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(TwoWatchTheme.border, lineWidth: 1))
                }
            }
        }
    }

    private var pickers: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Difficoltà")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Spacer()
                Picker("Difficoltà", selection: $difficulty) {
                    ForEach(QuizDifficulty.allCases, id: \.self) { d in
                        Text(d.italianLabel).tag(d)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 240)
            }
            HStack {
                Text("Spoiler")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Spacer()
                Picker("Spoiler", selection: $spoilerLevel) {
                    ForEach(QuizSpoilerLevel.allCases, id: \.self) { s in
                        Text(s.italianLabel).tag(s)
                    }
                }
                .pickerStyle(.menu)
                .tint(TwoWatchTheme.textPrimary)
            }
        }
    }

    private var actionsRow: some View {
        VStack(spacing: 10) {
            Button {
                Task { await save() }
            } label: {
                if saving {
                    ProgressView().tint(.white)
                } else {
                    Text("Salva modifiche")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(saving)

            HStack(spacing: 10) {
                Button {
                    Task { await setStatus(.approved) }
                } label: {
                    if pendingStatus == .approved {
                        ProgressView().tint(TwoWatchTheme.success)
                    } else {
                        Text("Approva")
                    }
                }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(TwoWatchTheme.success.opacity(0.2), in: Capsule())
                    .foregroundStyle(TwoWatchTheme.success)
                    .disabled(saving)

                Button {
                    Task { await setStatus(.discarded) }
                } label: {
                    if pendingStatus == .discarded {
                        ProgressView().tint(TwoWatchTheme.brandPrimary)
                    } else {
                        Text("Scarta")
                    }
                }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(TwoWatchTheme.brandPrimary.opacity(0.2), in: Capsule())
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .disabled(saving)
            }
        }
    }

    private func letter(_ idx: Int) -> String {
        ["A", "B", "C", "D"][safe: idx] ?? "?"
    }

    @MainActor
    private func save() async {
        guard let uid = session.appUser?.id else { return }
        saving = true
        defer { saving = false }
        do {
            try await container.quizRepository.saveAdminEdit(
                questionId: question.questionId,
                questionText: questionText,
                answers: answers,
                correctAnswerIndex: correctAnswerIndex,
                difficulty: difficulty,
                spoilerLevel: spoilerLevel,
                editedBy: uid
            )
            onChange()
            dismiss()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    @MainActor
    private func setStatus(_ status: QuizQuestionStatus) async {
        guard let uid = session.appUser?.id, !saving else { return }
        saving = true
        pendingStatus = status
        defer {
            saving = false
            pendingStatus = nil
        }
        do {
            try await container.quizRepository.setQuestionStatus(status, questionId: question.questionId, by: uid)
            onChange()
            dismiss()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

private extension Array {
    subscript(safe idx: Int) -> Element? {
        indices.contains(idx) ? self[idx] : nil
    }
}
