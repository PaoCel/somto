import SwiftUI

// Emozioni della community e sheet di modifica delle proprie. Estratte da
// TitleDetailSections.swift.

struct TitleEmotionCommunitySection: View {
    let title: Title
    let container: AppContainer
    let session: SessionStore
    let personalState: TitlePersonalState?

    @State private var myEmotions: Set<TitleEmotion> = []
    @State private var isPickerPresented = false

    private var aggregate: TitleEmotionAggregate? {
        title.emotionAggregate
    }

    private var hasWatched: Bool {
        personalState?.seenAt != nil || personalState?.completedAt != nil
    }

    private var showsPercentages: Bool {
        (aggregate?.totalUsers ?? 0) >= 3
    }

    private var topEmotions: [(emotion: TitleEmotion, count: Int)] {
        Array((aggregate?.rankedEmotions ?? []).prefix(5))
    }

    var body: some View {
        Group {
            if let aggregate, aggregate.totalUsers > 0, !topEmotions.isEmpty {
                TitleCollapsibleSection(
                    title: String(localized: "Che impressione ha fatto"),
                    subtitle: String(localized: "\(aggregate.totalUsers) persone"),
                    accessibilityHintExpanded: String(localized: "Tocca per vedere le impressioni")
                ) {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(spacing: 10) {
                            ForEach(topEmotions, id: \.emotion) { entry in
                                emotionRow(entry)
                            }
                        }

                        yourImpressionButton
                    }
                }
            } else if hasWatched, session.firebaseUser?.uid != nil {
                TitleCollapsibleSection(
                    title: String(localized: "Che impressione ha fatto"),
                    subtitle: nil,
                    accessibilityHintExpanded: String(localized: "Tocca per lasciare la tua impressione")
                ) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Ancora nessuna impressione condivisa su questo titolo.")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                        yourImpressionButton
                    }
                }
            }
        }
        .task(id: session.firebaseUser?.uid) {
            await loadMyEmotions()
        }
        .sheet(isPresented: $isPickerPresented) {
            if let uid = session.firebaseUser?.uid {
                TitleEmotionEditSheet(
                    container: container,
                    userID: uid,
                    titleID: title.id,
                    initialSelection: myEmotions
                ) {
                    Task { await loadMyEmotions() }
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
        }
    }

    private var yourImpressionButton: some View {
        Button {
            guard session.firebaseUser?.uid != nil else { return }
            isPickerPresented = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: myEmotions.isEmpty ? "face.smiling" : "checkmark.circle.fill")
                    .font(.caption.weight(.bold))
                Text(myEmotions.isEmpty ? "La tua impressione" : "Modifica la tua impressione")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(TwoWatchTheme.accent)
        }
        .buttonStyle(.plain)
    }

    private func emotionRow(_ entry: (emotion: TitleEmotion, count: Int)) -> some View {
        let isMine = myEmotions.contains(entry.emotion)
        let fraction = aggregate?.percentage(for: entry.emotion) ?? 0

        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(entry.emotion.emoji)
                    .font(.subheadline)
                Text(entry.emotion.label)
                    .font(.subheadline.weight(isMine ? .bold : .semibold))
                    .foregroundStyle(isMine ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textPrimary)
                Spacer(minLength: 8)
                if showsPercentages {
                    Text("\(Int((fraction * 100).rounded()))%")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .monospacedDigit()
                }
            }

            if showsPercentages {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(TwoWatchTheme.panel)
                        Capsule()
                            .fill(TwoWatchTheme.brandGradient)
                            .frame(width: geo.size.width * max(0, min(1, fraction)))
                    }
                }
                .frame(height: 6)
            }
        }
    }

    private func loadMyEmotions() async {
        guard let uid = session.firebaseUser?.uid else {
            myEmotions = []
            return
        }
        let existing = (try? await container.titleRepository.fetchMyTitleEmotions(
            userID: uid,
            titleID: title.id
        )) ?? []
        myEmotions = Set(existing)
    }
}

/// Sheet di modifica emozioni riusato dalla sezione community (modalità
/// edit): stessa griglia del prompt post-visto, ma precaricata con la
/// selezione esistente e senza copy "hai appena finito".
struct TitleEmotionEditSheet: View {
    let container: AppContainer
    let userID: String
    let titleID: String
    let initialSelection: Set<TitleEmotion>
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<TitleEmotion>
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(
        container: AppContainer,
        userID: String,
        titleID: String,
        initialSelection: Set<TitleEmotion>,
        onSaved: @escaping () -> Void
    ) {
        self.container = container
        self.userID = userID
        self.titleID = titleID
        self.initialSelection = initialSelection
        self.onSaved = onSaved
        _selection = State(initialValue: initialSelection)
    }

    var body: some View {
        VStack(spacing: 16) {
            Text("La tua impressione")
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Text("Scegli fino a 3 emozioni. Deseleziona tutto per rimuovere la tua impressione.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)

            ScrollView(showsIndicators: false) {
                EmotionGridPicker(selection: $selection)
                    .padding(.top, 4)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }

            Button {
                Task { await save() }
            } label: {
                if isSubmitting {
                    ProgressView()
                        .tint(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                } else {
                    Text(selection.isEmpty ? "Rimuovi impressione" : "Salva")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting || selection == initialSelection)

            Button("Annulla") { dismiss() }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .disabled(isSubmitting)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .background(TwoWatchTheme.background.ignoresSafeArea())
    }

    private func save() async {
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await container.titleRepository.submitTitleEmotions(
                userID: userID,
                titleID: titleID,
                emotions: Array(selection)
            )
            onSaved()
            dismiss()
        } catch {
            errorMessage = "Impossibile salvare. Riprova."
        }
    }
}

/// Risultati community "Personaggi preferiti", gemella di
/// `TitleEmotionCommunitySection` (stesso posto in tab Social, stesso
/// `TitleCollapsibleSection`).
///
/// Anti-spoiler (obbligatorio, spec §5): i pick per episodio rivelano chi è
/// vivo/presente in quell'episodio — spoiler puro. L'aggregato `series`
/// somma TUTTI gli episodi di TUTTE le stagioni, quindi non basta "ha visto
/// l'episodio": la sezione resta bloccata finché `personalState.isCompleted`
/// non è vero (film visto / serie completata, lo stesso segnale già usato da
/// `EpisodeSeenCoordinator` per "completesSeries"). Sotto quella soglia non
/// facciamo NESSUNA fetch dei dati — a differenza di un blur, qui non c'è
/// nulla da bypassare: zero byte di risultati arrivano sul device.
