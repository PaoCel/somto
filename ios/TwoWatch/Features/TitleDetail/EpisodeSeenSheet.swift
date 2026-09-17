import Observation
import SwiftUI
import UIKit

/// Episodio appena segnato come visto, con il contesto che serve al foglio.
struct EpisodeSeenTarget: Identifiable, Equatable {
    let titleID: String
    let titleName: String
    let season: Int
    let episode: Int
    let episodeName: String?
    /// True quando con questo episodio la serie risulta finita: cambia il
    /// copy della conferma ("Serie completata") e rende l'invito più forte.
    var completesSeries: Bool = false

    var id: String { "\(titleID)-s\(season)e\(episode)" }
}

struct EpisodeSeenPresentation: Identifiable {
    let id = UUID()
    let title: Title
    let target: EpisodeSeenTarget
    let source: String
    let existingEpisodeRating: Double?
    let shouldOfferTitleComposer: Bool
}

/// Decisione pura e testabile che separa la semantica dell'avanzamento dalla
/// presentazione SwiftUI. Tutti gli ingressi devono passare da questa guardia.
struct EpisodeSeenDecision: Equatable {
    let shouldPresent: Bool
    let shouldOfferTitleComposer: Bool

    static func evaluate(
        previousEpisodeCount: Int,
        updatedEpisodeCount: Int?,
        season: Int?,
        episode: Int?,
        completesSeries: Bool,
        hasTitleRating: Bool
    ) -> EpisodeSeenDecision {
        let isAtomicAdvance = updatedEpisodeCount == previousEpisodeCount + 1
        let hasValidCoordinates = (season ?? 0) > 0 && (episode ?? 0) > 0
        let shouldPresent = isAtomicAdvance && hasValidCoordinates
        return EpisodeSeenDecision(
            shouldPresent: shouldPresent,
            shouldOfferTitleComposer: shouldPresent && completesSeries && !hasTitleRating
        )
    }
}

/// Unico ingresso applicativo per il foglio post-episodio.
///
/// La guardia `after == before + 1` rende esplicita l'invariante prodotto:
/// catch-up bulk, completamento stagione/serie e passi indietro non presentano
/// il foglio, a prescindere dalla schermata che ha aggiornato il progresso.
@Observable
@MainActor
final class EpisodeSeenCoordinator {
    var presentation: EpisodeSeenPresentation?

    func presentAfterAtomicAdvance(
        title: Title,
        previousEpisodeCount: Int,
        updatedProgress: TitleSeriesProgress?,
        completesSeries: Bool,
        hasTitleRating: Bool,
        source: String,
        existingEpisodeRating: Double? = nil
    ) {
        guard let progress = updatedProgress else { return }
        let season = progress.lastWatchedSeasonNumber
        let episode = progress.lastWatchedEpisodeNumber
        let decision = EpisodeSeenDecision.evaluate(
            previousEpisodeCount: previousEpisodeCount,
            updatedEpisodeCount: progress.episodesWatchedCount,
            season: season,
            episode: episode,
            completesSeries: completesSeries,
            hasTitleRating: hasTitleRating
        )
        guard decision.shouldPresent, let season, let episode else { return }

        presentation = EpisodeSeenPresentation(
            title: title,
            target: EpisodeSeenTarget(
                titleID: title.id,
                titleName: title.name,
                season: season,
                episode: episode,
                episodeName: progress.lastWatchedEpisodeName,
                completesSeries: completesSeries
            ),
            source: source,
            existingEpisodeRating: existingEpisodeRating,
            shouldOfferTitleComposer: decision.shouldOfferTitleComposer
        )
    }

    func dismiss() {
        presentation = nil
    }
}

/// Foglio leggero dopo "segnato visto": conferma, poi invita a dire la propria.
///
/// Sostituisce il vecchio `EpisodeSeenNudge` (card da 170pt con auto-dismiss a
/// 6 secondi e due bottoni "Vota"/"Commenta" che aprivano un SECONDO foglio).
/// Tre problemi risolti:
/// 1. l'auto-dismiss rubava il tap mentre l'utente stava decidendo;
/// 2. votare richiedeva un rimbalzo tra due sheet — ora la fila di stelle è
///    dentro il foglio e salva al tocco;
/// 3. non diceva mai *di che serie* si stesse parlando né se qualcuno stesse
///    già commentando quell'episodio.
///
/// Non blocca niente: si chiude con "Non ora", con lo swipe o toccando fuori.
/// La parola "recensione" non compare: si commenta, non si recensisce.
struct EpisodeSeenSheet: View {
    let target: EpisodeSeenTarget
    /// Voto già dato a questo episodio (se c'è), per partire dallo stato reale.
    let existingRating: Double?
    /// Anteprima dell'ultimo messaggio nel thread dell'episodio, se già esiste.
    let threadPreview: String?
    /// Emozioni già salvate per questo episodio.
    let existingEmotions: [TitleEmotion]
    let isLoadingEmotions: Bool
    let emotionLoadFailed: Bool
    let onRetryLoadEmotions: () -> Void
    /// Cast di questo episodio (principale + guest star), per "Chi ti ha
    /// conquistato?". Caricato dal chiamante dopo l'apertura del foglio
    /// (come `threadPreview`/`existingEmotions`): finché non arriva,
    /// `isLoadingCharacterCandidates` tiene la riga in stato di caricamento.
    let characterCandidates: [CharacterCandidate]
    let isLoadingCharacterCandidates: Bool
    /// Pick già salvati per QUESTO episodio, se l'utente li aveva già scelti.
    let existingCharacterPicks: [CharacterPick]
    let onRate: (Double) -> Void
    let onSaveEmotions: ([TitleEmotion]) async -> Bool
    /// Salvataggio "al tocco". Il risultato pilota un feedback esplicito,
    /// senza bloccare le altre azioni del foglio.
    let onSaveCharacterPicks: ([CharacterPick]) async -> Bool
    let onOpenDiscussion: () -> Void
    let onDismiss: () -> Void

    @State private var localRating: Double?
    @State private var emotionSelection: Set<TitleEmotion> = []
    @State private var isEmotionStepOpen = false
    @State private var isSavingEmotions = false
    @State private var emotionsSaved = false
    @State private var emotionsFailed = false
    @State private var characterPicks: [CharacterPick]
    @State private var characterSaveState: CharacterSaveState = .idle
    @State private var characterSaveGeneration = UUID()
    @State private var hasEditedCharacterPicks = false
    @State private var hasEditedEmotions = false
    @State private var detent: PresentationDetent = .large

    private enum CharacterSaveState: Equatable {
        case idle
        case saving
        case saved
        case failed
    }

    init(
        target: EpisodeSeenTarget,
        existingRating: Double?,
        threadPreview: String?,
        existingEmotions: [TitleEmotion],
        isLoadingEmotions: Bool,
        emotionLoadFailed: Bool,
        onRetryLoadEmotions: @escaping () -> Void,
        characterCandidates: [CharacterCandidate],
        isLoadingCharacterCandidates: Bool,
        existingCharacterPicks: [CharacterPick],
        onRate: @escaping (Double) -> Void,
        onSaveEmotions: @escaping ([TitleEmotion]) async -> Bool,
        onSaveCharacterPicks: @escaping ([CharacterPick]) async -> Bool,
        onOpenDiscussion: @escaping () -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.target = target
        self.existingRating = existingRating
        self.threadPreview = threadPreview
        self.existingEmotions = existingEmotions
        self.isLoadingEmotions = isLoadingEmotions
        self.emotionLoadFailed = emotionLoadFailed
        self.onRetryLoadEmotions = onRetryLoadEmotions
        self.characterCandidates = characterCandidates
        self.isLoadingCharacterCandidates = isLoadingCharacterCandidates
        self.existingCharacterPicks = existingCharacterPicks
        self.onRate = onRate
        self.onSaveEmotions = onSaveEmotions
        self.onSaveCharacterPicks = onSaveCharacterPicks
        self.onOpenDiscussion = onOpenDiscussion
        self.onDismiss = onDismiss
        _localRating = State(initialValue: existingRating)
        _emotionSelection = State(initialValue: Set(existingEmotions))
        _characterPicks = State(initialValue: existingCharacterPicks)
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 18) {
                confirmationHeader
                ratingStep
                emotionStep
                characterStep
                discussionStep
                dismissButton
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 24)
        }
        .background(TwoWatchBackground())
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .onChange(of: existingEmotions) { _, updated in
            guard !hasEditedEmotions, !isSavingEmotions else { return }
            emotionSelection = Set(updated)
        }
        .onChange(of: existingCharacterPicks) { _, updated in
            // Il contesto arriva dopo l'apertura. Non sovrascrivere una scelta
            // già fatta dall'utente mentre il caricamento era in corso.
            guard !hasEditedCharacterPicks, characterSaveState != .saving else { return }
            characterPicks = updated
        }
    }

    // MARK: - Conferma

    private var confirmationHeader: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: target.completesSeries ? "checkmark.seal.fill" : "checkmark.circle.fill")
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(TwoWatchTheme.success)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(target.completesSeries ? "Serie completata" : "Segnato come visto")
                    .font(.system(size: 17, weight: .heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text(episodeLine)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)

                Text(target.titleName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .frame(width: 32, height: 32)
                    .background(TwoWatchTheme.panel, in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Chiudi")
        }
        .accessibilityElement(children: .contain)
    }

    private var episodeLine: String {
        let coordinates = "S\(target.season) · E\(target.episode)"
        guard let name = target.episodeName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty
        else { return coordinates }
        return "\(coordinates) — \(name)"
    }

    // MARK: - Voto (azione più leggera: un tocco)

    private var ratingStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(localRating == nil ? "Ti è piaciuto?" : "Il tuo voto")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Spacer(minLength: 0)

                if let localRating {
                    Text(RatingDisplayFormat.halfStep(localRating))
                        .font(.system(size: 20, weight: .heavy, design: .rounded))
                        .foregroundStyle(TwoWatchTheme.accent)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .accessibilityLabel("Voto \(RatingDisplayFormat.halfStep(localRating)) su 10")
                }
            }

            SomtoStarRatingRow(value: localRating, showsLabel: false) { value in
                withAnimation(.easeOut(duration: 0.18)) { localRating = value }
                onRate(value)
            }
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    // MARK: - Emozioni episodio

    private var emotionStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.22)) {
                    isEmotionStepOpen.toggle()
                    if isEmotionStepOpen { detent = .large }
                }
            } label: {
                HStack(spacing: 10) {
                    Text("😮")
                        .font(.system(size: 18))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(emotionsSaved ? "Grazie, salvato" : "Come ti ha fatto sentire?")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text("Fino a 3, per questo episodio")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: isEmotionStepOpen ? "chevron.up" : "chevron.down")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(emotionsSaved)

            if isEmotionStepOpen && !emotionsSaved {
                if isLoadingEmotions {
                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(TwoWatchTheme.accent)
                        Text("Carico le emozioni già scelte…")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 10)
                } else if emotionLoadFailed {
                    HStack(spacing: 8) {
                        Text("Non riesco a caricare le emozioni salvate.")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(TwoWatchTheme.warning)
                        Spacer(minLength: 0)
                        Button("Riprova", action: onRetryLoadEmotions)
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(TwoWatchTheme.accent)
                            .buttonStyle(.plain)
                    }
                } else {
                    EmotionGridPicker(selection: Binding(
                        get: { emotionSelection },
                        set: {
                            hasEditedEmotions = true
                            emotionSelection = $0
                        }
                    ))
                }

                if emotionsFailed {
                    Text("Non sono riuscito a salvare. Riprova.")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.red)
                }

                Button {
                    Task { await saveEmotions() }
                } label: {
                    Group {
                        if isSavingEmotions {
                            ProgressView().tint(.white)
                        } else {
                            Text("Salva emozioni")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(
                    emotionSelection.isEmpty
                        || isSavingEmotions
                        || isLoadingEmotions
                        || emotionLoadFailed
                )
                .opacity(
                    emotionSelection.isEmpty || isLoadingEmotions || emotionLoadFailed
                        ? 0.5
                        : 1
                )
            }
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func saveEmotions() async {
        guard !emotionSelection.isEmpty else { return }
        isSavingEmotions = true
        emotionsFailed = false
        let didSave = await onSaveEmotions(Array(emotionSelection))
        isSavingEmotions = false
        guard didSave else {
            emotionsFailed = true
            return
        }
        UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.6)
        withAnimation(.easeInOut(duration: 0.22)) {
            emotionsSaved = true
            isEmotionStepOpen = false
        }
    }

    // MARK: - Personaggi preferiti (riga compatta, sempre visibile)

    /// Emozioni e personaggi si propongono a ogni episodio. Nessun bottone
    /// Salva per i personaggi: ogni tap sulla riga salva subito.
    private var characterStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Chi ti ha conquistato?")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Scegline fino a 3")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            CharacterPickRow(
                candidates: characterCandidates,
                isLoading: isLoadingCharacterCandidates,
                picks: $characterPicks
            ) { updatedPicks in
                hasEditedCharacterPicks = true
                saveCharacterPicks(updatedPicks)
            }
            .disabled(characterSaveState == .saving)
            .opacity(characterSaveState == .saving ? 0.72 : 1)

            characterSaveFeedback
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var characterSaveFeedback: some View {
        switch characterSaveState {
        case .idle:
            EmptyView()
        case .saving:
            Label("Salvataggio…", systemImage: "arrow.triangle.2.circlepath")
                .foregroundStyle(TwoWatchTheme.textMuted)
                .font(.system(size: 11, weight: .semibold))
        case .saved:
            Label("Scelte salvate", systemImage: "checkmark.circle.fill")
                .foregroundStyle(TwoWatchTheme.success)
                .font(.system(size: 11, weight: .semibold))
        case .failed:
            HStack(spacing: 8) {
                Label("Salvataggio non riuscito", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(TwoWatchTheme.warning)
                    .font(.system(size: 11, weight: .semibold))
                Spacer(minLength: 0)
                Button("Riprova") {
                    saveCharacterPicks(characterPicks)
                }
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(TwoWatchTheme.accent)
                .buttonStyle(.plain)
            }
        }
    }

    private func saveCharacterPicks(_ picks: [CharacterPick]) {
        let generation = UUID()
        characterSaveGeneration = generation
        characterSaveState = .saving
        Task {
            let didSave = await onSaveCharacterPicks(picks)
            guard characterSaveGeneration == generation else { return }
            if didSave {
                characterSaveState = .saved
                UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.45)
            } else {
                characterSaveState = .failed
            }
        }
    }

    // MARK: - Discussione (azione principale)

    private var discussionStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let preview = threadPreview?.trimmingCharacters(in: .whitespacesAndNewlines),
               !preview.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Se ne sta già parlando")
                        .font(.system(size: 11, weight: .heavy))
                        .tracking(0.4)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                    Text(preview)
                        .font(.system(size: 13))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }

            Button(action: onOpenDiscussion) {
                HStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 14, weight: .bold))
                    Text(threadPreview?.isEmpty == false ? "Partecipa alla discussione" : "Dì la tua")
                        .font(.system(size: 15, weight: .heavy))
                }
                .foregroundStyle(Color.black)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(TwoWatchTheme.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityHint("Apre la discussione dell'episodio")
        }
    }

    private var dismissButton: some View {
        Button("Non ora", action: onDismiss)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(TwoWatchTheme.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
    }
}

/// Presenter applicativo del flusso post-episodio. È montato una sola volta
/// in `RootView`, così ogni superficie può limitarsi a notificare al
/// coordinatore una transizione atomica riuscita.
struct EpisodeSeenPresenterModifier: ViewModifier {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var threadPreview: String?
    @State private var episodeEmotions: [TitleEmotion] = []
    @State private var isLoadingEmotions = false
    @State private var emotionLoadFailed = false
    @State private var characterCandidates: [CharacterCandidate] = []
    @State private var characterPicks: [CharacterPick] = []
    @State private var isLoadingCharacters = false
    @State private var lastPresentation: EpisodeSeenPresentation?
    @State private var pendingDiscussion: EpisodeSeenPresentation?
    @State private var discussionPresentation: EpisodeSeenPresentation?
    @State private var shouldShowComposerAfterDiscussion = false
    @State private var isTitleComposerPresented = false

    func body(content: Content) -> some View {
        content
            .sheet(item: presentationBinding, onDismiss: runPendingFollowUp) { presentation in
                EpisodeSeenSheet(
                    target: presentation.target,
                    existingRating: presentation.existingEpisodeRating,
                    threadPreview: threadPreview,
                    existingEmotions: episodeEmotions,
                    isLoadingEmotions: isLoadingEmotions,
                    emotionLoadFailed: emotionLoadFailed,
                    onRetryLoadEmotions: {
                        Task { await loadEmotions(for: presentation) }
                    },
                    characterCandidates: characterCandidates,
                    isLoadingCharacterCandidates: isLoadingCharacters,
                    existingCharacterPicks: characterPicks,
                    onRate: { value in
                        saveRating(value, for: presentation)
                    },
                    onSaveEmotions: { emotions in
                        await saveEmotions(emotions, for: presentation)
                    },
                    onSaveCharacterPicks: { picks in
                        await saveCharacterPicks(picks, for: presentation)
                    },
                    onOpenDiscussion: {
                        pendingDiscussion = presentation
                        container.analytics.log(
                            AnalyticsEvent.episodeDiscussionOpened,
                            analyticsParameters(for: presentation)
                        )
                        container.episodeSeenCoordinator.dismiss()
                    },
                    onDismiss: {
                        container.episodeSeenCoordinator.dismiss()
                    }
                )
                .task(id: presentation.id) {
                    await loadContext(for: presentation)
                }
                .onAppear {
                    lastPresentation = presentation
                    container.analytics.log(
                        AnalyticsEvent.episodeSeenSheetShown,
                        analyticsParameters(for: presentation)
                    )
                }
            }
            .sheet(
                item: $discussionPresentation,
                onDismiss: presentComposerAfterDiscussionIfNeeded
            ) { presentation in
                NavigationStack {
                    ThreadDetailView(
                        container: container,
                        session: session,
                        shell: shell,
                        threadID: container.threadsRepository.threadIDForEpisode(
                            titleID: presentation.title.id,
                            season: presentation.target.season,
                            episode: presentation.target.episode
                        ),
                        publicThreadSeed: .episode(
                            titleID: presentation.title.id,
                            season: presentation.target.season,
                            episode: presentation.target.episode
                        )
                    )
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Chiudi") { discussionPresentation = nil }
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                    }
                }
            }
            .sheet(isPresented: $isTitleComposerPresented) {
                if let presentation = lastPresentation,
                   let uid = session.firebaseUser?.uid {
                    RatingPostComposerSheet(
                        container: container,
                        currentUserID: uid,
                        currentUserName: session.appUser?.displayName
                            ?? session.firebaseUser?.displayName
                            ?? "User",
                        title: presentation.title,
                        existingRating: nil,
                        hasAcceptedCommunitySafety: session.appUser?.hasAcceptedCommunitySafetyTerms == true,
                        initialRating: nil,
                        onSaved: {}
                    )
                }
            }
    }

    private var presentationBinding: Binding<EpisodeSeenPresentation?> {
        Binding(
            get: { container.episodeSeenCoordinator.presentation },
            set: { updated in
                if updated == nil {
                    lastPresentation = container.episodeSeenCoordinator.presentation ?? lastPresentation
                }
                container.episodeSeenCoordinator.presentation = updated
            }
        )
    }

    @MainActor
    private func loadContext(for presentation: EpisodeSeenPresentation) async {
        threadPreview = nil
        episodeEmotions = []
        isLoadingEmotions = true
        emotionLoadFailed = false
        characterCandidates = []
        characterPicks = []
        isLoadingCharacters = true

        guard let uid = session.firebaseUser?.uid else {
            isLoadingCharacters = false
            isLoadingEmotions = false
            emotionLoadFailed = true
            return
        }

        let target = presentation.target
        let threadID = container.threadsRepository.threadIDForEpisode(
            titleID: presentation.title.id,
            season: target.season,
            episode: target.episode
        )
        async let threadTask = container.threadsRepository.fetchThread(id: threadID)
        async let candidatesTask = container.titleRepository.fetchEpisodeCharacterCandidates(
            title: presentation.title,
            season: target.season,
            episode: target.episode
        )
        async let picksTask = container.titleRepository.fetchMyCharacterPicksForItem(
            titleID: presentation.title.id,
            level: "episode",
            season: target.season,
            episode: target.episode,
            uid: uid
        )

        var thread: AppThread?
        do { thread = try await threadTask } catch { SilentFailure.record(error, context: "EpisodeSeen.threadPreview") }
        await loadEmotions(for: presentation)
        var candidates: [CharacterCandidate] = []
        do { candidates = try await candidatesTask } catch { SilentFailure.record(error, context: "EpisodeSeen.characterCandidates") }
        var picks: [CharacterPick] = []
        do { picks = try await picksTask } catch { SilentFailure.record(error, context: "EpisodeSeen.myPicks") }
        guard container.episodeSeenCoordinator.presentation?.id == presentation.id else { return }
        threadPreview = thread?.previewSplit.text
        characterCandidates = candidates
        characterPicks = picks
        isLoadingCharacters = false
    }

    @MainActor
    private func loadEmotions(for presentation: EpisodeSeenPresentation) async {
        guard let uid = session.firebaseUser?.uid else {
            isLoadingEmotions = false
            emotionLoadFailed = true
            return
        }
        isLoadingEmotions = true
        emotionLoadFailed = false
        do {
            let loaded = try await container.titleRepository.fetchMyEpisodeEmotions(
                userID: uid,
                titleID: presentation.title.id,
                season: presentation.target.season,
                episode: presentation.target.episode
            )
            guard container.episodeSeenCoordinator.presentation?.id == presentation.id else { return }
            episodeEmotions = loaded
            isLoadingEmotions = false
        } catch {
            guard container.episodeSeenCoordinator.presentation?.id == presentation.id else { return }
            isLoadingEmotions = false
            emotionLoadFailed = true
        }
    }

    private func saveRating(_ value: Double, for presentation: EpisodeSeenPresentation) {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }
        Task {
            do {
                try await container.titleRepository.submitRating(
                    userID: uid,
                    titleID: presentation.title.id,
                    level: "episode",
                    season: presentation.target.season,
                    episode: presentation.target.episode,
                    value: value,
                    reviewText: nil
                )
            } catch {
                // Il voto episodio parte da uno sheet che si chiude subito: se
                // fallisce, oggi l'utente non lo sa. Vedi docs/PENDING.md.
                SilentFailure.record(error, context: "EpisodeSeen.submitRating")
            }
        }
    }

    @MainActor
    private func saveEmotions(
        _ emotions: [TitleEmotion],
        for presentation: EpisodeSeenPresentation
    ) async -> Bool {
        guard let uid = session.firebaseUser?.uid else { return false }
        do {
            try await container.titleRepository.submitEpisodeEmotions(
                userID: uid,
                titleID: presentation.title.id,
                season: presentation.target.season,
                episode: presentation.target.episode,
                emotions: emotions
            )
            episodeEmotions = emotions
            var params = analyticsParameters(for: presentation)
            params["selection_count"] = emotions.count
            container.analytics.log(AnalyticsEvent.episodeEmotionsSaved, params)
            return true
        } catch {
            container.analytics.log(
                AnalyticsEvent.episodeEmotionsFailed,
                analyticsParameters(for: presentation)
            )
            return false
        }
    }

    @MainActor
    private func saveCharacterPicks(
        _ picks: [CharacterPick],
        for presentation: EpisodeSeenPresentation
    ) async -> Bool {
        guard let uid = session.firebaseUser?.uid else { return false }
        do {
            try await container.titleRepository.submitCharacterPicks(
                titleID: presentation.title.id,
                level: "episode",
                season: presentation.target.season,
                episode: presentation.target.episode,
                picks: picks,
                userID: uid
            )
            characterPicks = picks
            var params = analyticsParameters(for: presentation)
            params["selection_count"] = picks.count
            container.analytics.log(AnalyticsEvent.episodeCharacterPicksSaved, params)
            return true
        } catch {
            container.analytics.log(
                AnalyticsEvent.episodeCharacterPicksFailed,
                analyticsParameters(for: presentation)
            )
            return false
        }
    }

    private func analyticsParameters(for presentation: EpisodeSeenPresentation) -> [String: Any] {
        [
            "platform": "ios",
            "source": presentation.source,
            "season": presentation.target.season,
            "episode": presentation.target.episode,
            "completed_series": presentation.target.completesSeries
        ]
    }

    private func runPendingFollowUp() {
        if let discussion = pendingDiscussion {
            pendingDiscussion = nil
            shouldShowComposerAfterDiscussion = discussion.shouldOfferTitleComposer
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 180_000_000)
                discussionPresentation = discussion
            }
            return
        }

        guard lastPresentation?.shouldOfferTitleComposer == true else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            isTitleComposerPresented = true
        }
    }

    private func presentComposerAfterDiscussionIfNeeded() {
        guard shouldShowComposerAfterDiscussion else { return }
        shouldShowComposerAfterDiscussion = false
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            isTitleComposerPresented = true
        }
    }
}
