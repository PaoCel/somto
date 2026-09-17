import PhotosUI
import SwiftUI
import UIKit

// Sheet e prompt della scheda titolo, estratti da TitleDetailView.swift.
// Spostamento puro: nessuna riga di corpo cambiata.
//
// UNICA modifica semantica: sei tipi passano da `private` a internal, perche'
// in Swift `private` a livello di file significa "visibile a QUESTO file" e
// TitleDetailView.swift continua a referenziarli. Gli altri restano private,
// ora sul nuovo file.

struct FriendsTitleVotesSheet: View {
    let entries: [FriendVoteEntry]

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                if entries.isEmpty {
                    EmptyStateView(
                        title: "Nessun voto dal tuo giro",
                        message: "Quando le persone che segui voteranno questo titolo, le troverai qui.",
                        systemImage: "handshake.fill"
                    )
                    .padding(20)
                } else {
                    VStack(spacing: 12) {
                        ForEach(entries) { entry in
                            friendVoteRow(entry)
                        }
                    }
                    .padding(20)
                }
            }
            .background(TwoWatchBackground())
            .navigationTitle("Voti amici")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }

    private func friendVoteRow(_ entry: FriendVoteEntry) -> some View {
        HStack(spacing: 12) {
            SomtoAvatar(
                url: entry.friend.photoURL ?? entry.friend.avatarURL,
                name: entry.friend.displayName,
                size: 42
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.friend.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("@\(entry.friend.displayNameLower)")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            Spacer(minLength: 0)

            Text(TitleDetailFormatter.rating(entry.rating.rating))
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.warning)
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

}

struct RecommendationComposerSheet: View {
    let container: AppContainer
    let currentUserID: String
    let currentUserName: String
    let title: Title
    let initialHasAcceptedCommunitySafety: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var friends: [AppUser] = []
    @State private var selectedFriendID: String?
    @State private var friendSearchText = ""
    @State private var message = ""
    @State private var hasAcceptedCommunitySafety: Bool
    @State private var isAcceptingCommunitySafety = false
    @State private var isLoading = true
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var containsSpoiler: Bool = false
    @State private var spoilerTitleIDs: [String] = []

    init(
        container: AppContainer,
        currentUserID: String,
        currentUserName: String,
        title: Title,
        hasAcceptedCommunitySafety: Bool
    ) {
        self.container = container
        self.currentUserID = currentUserID
        self.currentUserName = currentUserName
        self.title = title
        initialHasAcceptedCommunitySafety = hasAcceptedCommunitySafety
        _hasAcceptedCommunitySafety = State(initialValue: hasAcceptedCommunitySafety)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Invia come suggerimento")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)

                            Text("Seleziona un amico e, se vuoi, aggiungi un messaggio. Il titolo resta collegato anche al thread DM.")
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                    }

                    if let errorMessage {
                        GlassCard {
                            Text(errorMessage)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }

                    if !hasAcceptedCommunitySafety {
                        communitySafetyCard(
                            title: String(localized: "Accetta i termini community per usare i DM"),
                            message: String(localized: "I suggerimenti via chat rispettano la policy di tolleranza zero di Somto: filtro automatico, segnalazioni e blocco utenti."),
                            buttonTitle: "Accetta e continua"
                        ) {
                            await acceptCommunitySafety()
                        }
                    } else if isLoading {
                        ProgressView()
                            .tint(TwoWatchTheme.textPrimary)
                            .frame(maxWidth: .infinity, minHeight: 160)
                    } else if friends.isEmpty {
                        EmptyStateView(
                            title: "Non segui ancora nessuno",
                            message: "Segui qualcuno per suggerirgli titoli dalla scheda.",
                            systemImage: "person.2.slash"
                        )
                    } else {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Chi segui")
                                .font(.headline)
                                .foregroundStyle(TwoWatchTheme.textPrimary)

                            TextField("Cerca tra chi segui", text: $friendSearchText)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .textFieldStyle(.roundedBorder)

                            if filteredFriends.isEmpty {
                                Text("Nessun seguito trovato con questa ricerca.")
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                            } else {
                                ForEach(filteredFriends) { friend in
                                    friendSelectionRow(friend, isSelected: selectedFriendID == friend.id) {
                                        selectedFriendID = friend.id
                                    }
                                }
                            }
                        }

                        GlassCard {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Messaggio")
                                    .font(.headline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)

                                TextEditor(text: $message)
                                    .frame(minHeight: 120)
                                    .scrollContentBackground(.hidden)
                                    .foregroundStyle(TwoWatchTheme.textPrimary)

                                Text("\(message.count)/500")
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                    .frame(maxWidth: .infinity, alignment: .trailing)

                                SpoilerComposerSection(
                                    containsSpoiler: $containsSpoiler,
                                    spoilerTitleIDs: $spoilerTitleIDs,
                                    candidateTitles: [title]
                                )
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(TwoWatchBackground())
            .navigationTitle(title.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(isSubmitting ? "Invio..." : "Invia") {
                        Task { await sendRecommendation() }
                    }
                    .disabled(selectedFriendID == nil || isSubmitting || friends.isEmpty || !hasAcceptedCommunitySafety)
                    .foregroundStyle(TwoWatchTheme.accent)
                }
            }
            .task {
                await loadFriends()
            }
        }
    }

    private func loadFriends() async {
        isLoading = true
        defer { isLoading = false }
        var latestUser: AppUser?
        do { latestUser = try await container.userRepository.fetchUser(uid: currentUserID) } catch { SilentFailure.record(error, context: "TitleShare.latestUser.people") }
        if let latestUser {
            hasAcceptedCommunitySafety = latestUser.hasAcceptedCommunitySafetyTerms
        }
        do { friends = try await container.userRepository.listFollowing(userID: currentUserID) } catch { SilentFailure.record(error, context: "TitleShare.following"); friends = [] }
        selectedFriendID = friends.first?.id
    }

    private var filteredFriends: [AppUser] {
        let query = friendSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return friends }
        return friends.filter { friend in
            friend.displayName.localizedCaseInsensitiveContains(query) ||
            friend.displayNameLower.localizedCaseInsensitiveContains(query)
        }
    }

    private func sendRecommendation() async {
        guard let selectedFriendID else { return }
        guard hasAcceptedCommunitySafety else {
            errorMessage = String(localized: "Accetta i termini community prima di usare la chat.")
            return
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let thread = try await container.threadsRepository.ensureDMThread(
                titleID: title.id,
                uidA: currentUserID,
                uidB: selectedFriendID,
                createdBy: currentUserID
            )

            _ = try await container.socialInboxRepository.createRecommendation(
                fromUid: currentUserID,
                toUid: selectedFriendID,
                titleID: title.id,
                message: String(message.prefix(500)),
                threadID: thread.id,
                containsSpoiler: containsSpoiler,
                spoilerTitleIDs: containsSpoiler ? spoilerTitleIDs : []
            )

            container.analytics.log(AnalyticsEvent.recommendationSent, [
                "title_id": title.id,
                "to_uid": selectedFriendID
            ])

            let cleanMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleanMessage.isEmpty {
                try await container.threadsRepository.sendMessage(
                    threadID: thread.id,
                    senderUID: currentUserID,
                    displayName: currentUserName,
                    text: cleanMessage,
                    containsSpoiler: containsSpoiler,
                    spoilerTitleIDs: containsSpoiler ? spoilerTitleIDs : []
                )
            }

            dismiss()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func acceptCommunitySafety() async {
        isAcceptingCommunitySafety = true
        errorMessage = nil
        defer { isAcceptingCommunitySafety = false }

        do {
            try await container.userRepository.acceptCommunitySafetyTerms(userID: currentUserID)
            hasAcceptedCommunitySafety = true
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    @ViewBuilder
    private func communitySafetyCard(
        title: String,
        message: String,
        buttonTitle: String,
        action: @escaping () async -> Void
    ) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                HStack(spacing: 12) {
                    Link("Termini", destination: CommunitySafetyPolicy.termsURL)
                    Link("Supporto", destination: CommunitySafetyPolicy.supportURL)
                }
                .font(.caption.weight(.semibold))

                Button {
                    Task { await action() }
                } label: {
                    if isAcceptingCommunitySafety {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text(buttonTitle)
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
    }

    private func friendSelectionRow(_ friend: AppUser, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                SomtoAvatar(
                    url: friend.photoURL ?? friend.avatarURL,
                    name: friend.displayName,
                    size: 40
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(friend.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("@\(friend.displayNameLower)")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                Spacer()

                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? TwoWatchTheme.accent : TwoWatchTheme.textMuted)
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(isSelected ? TwoWatchTheme.accent.opacity(0.12) : TwoWatchTheme.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(isSelected ? TwoWatchTheme.accent.opacity(0.35) : TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

}

struct GroupDiscussionSheet: View {
    let container: AppContainer
    let currentUserID: String
    let currentUserName: String
    let title: Title
    let initialHasAcceptedCommunitySafety: Bool
    let onOpenThread: (AppThread) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var existingGroups: [AppThread] = []
    @State private var friends: [AppUser] = []
    @State private var selectedFriendIDs: Set<String> = []
    @State private var groupName = ""
    @State private var hasAcceptedCommunitySafety: Bool
    @State private var isAcceptingCommunitySafety = false
    @State private var isLoading = true
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(
        container: AppContainer,
        currentUserID: String,
        currentUserName: String,
        title: Title,
        hasAcceptedCommunitySafety: Bool,
        onOpenThread: @escaping (AppThread) -> Void
    ) {
        self.container = container
        self.currentUserID = currentUserID
        self.currentUserName = currentUserName
        self.title = title
        initialHasAcceptedCommunitySafety = hasAcceptedCommunitySafety
        self.onOpenThread = onOpenThread
        _hasAcceptedCommunitySafety = State(initialValue: hasAcceptedCommunitySafety)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Apri discussione con un gruppo")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)

                            Text("Puoi inviare il titolo in un gruppo già esistente oppure crearne uno al volo e aprirlo subito.")
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                    }

                    if let errorMessage {
                        GlassCard {
                            Text(errorMessage)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }

                    if !hasAcceptedCommunitySafety {
                        communitySafetyCard(
                            title: String(localized: "Accetta i termini community per aprire gruppi"),
                            message: String(localized: "Le discussioni di gruppo seguono la policy anti-abusi di Somto: filtro automatico, segnalazione rapida e blocco utenti."),
                            buttonTitle: "Accetta e sblocca i gruppi"
                        ) {
                            await acceptCommunitySafety()
                        }
                    } else if isLoading {
                        ProgressView()
                            .tint(TwoWatchTheme.textPrimary)
                            .frame(maxWidth: .infinity, minHeight: 160)
                    } else {
                        if !existingGroups.isEmpty {
                            GlassCard {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text("Gruppi esistenti")
                                        .font(.headline.weight(.bold))
                                        .foregroundStyle(TwoWatchTheme.textPrimary)

                                    ForEach(existingGroups) { thread in
                                        Button {
                                            Task { await openExistingGroup(thread) }
                                        } label: {
                                            HStack {
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text(thread.displayName(currentUserID: currentUserID))
                                                        .font(.subheadline.weight(.semibold))
                                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                                    Text(thread.subtitle(currentUserID: currentUserID))
                                                        .font(.caption)
                                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                                        .lineLimit(2)
                                                }

                                                Spacer()

                                                Image(systemName: "arrow.up.right")
                                                    .foregroundStyle(TwoWatchTheme.accent)
                                                    // Decorativo: il bottone ha già testo descrittivo
                                                    .accessibilityHidden(true)
                                            }
                                            .padding(12)
                                            .background(
                                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                                    .fill(TwoWatchTheme.panel)
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }

                        GlassCard {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Nuovo gruppo")
                                    .font(.headline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)

                                TextField("Nome gruppo (facoltativo)", text: $groupName)
                                    .textFieldStyle(.roundedBorder)

                                if friends.isEmpty {
                                    Text("Segui qualcuno per creare un gruppo nuovo.")
                                        .font(.caption)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                } else {
                                    VStack(spacing: 10) {
                                        ForEach(friends) { friend in
                                            Toggle(isOn: Binding(
                                                get: { selectedFriendIDs.contains(friend.id) },
                                                set: { newValue in
                                                    if newValue {
                                                        selectedFriendIDs.insert(friend.id)
                                                    } else {
                                                        selectedFriendIDs.remove(friend.id)
                                                    }
                                                }
                                            )) {
                                                Text(friend.displayName)
                                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                            }
                                            .tint(TwoWatchTheme.accent)
                                        }
                                    }
                                }

                                Button(isSubmitting ? "Creazione..." : "Crea e apri") {
                                    Task { await createGroup() }
                                }
                                .buttonStyle(PrimaryButtonStyle())
                                .disabled(selectedFriendIDs.isEmpty || isSubmitting || !hasAcceptedCommunitySafety)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(TwoWatchBackground())
            .navigationTitle(title.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
            .task {
                await loadData()
            }
        }
    }

    private func loadData() async {
        isLoading = true
        defer { isLoading = false }

        var latestUser: AppUser?
        do { latestUser = try await container.userRepository.fetchUser(uid: currentUserID) } catch { SilentFailure.record(error, context: "TitleShare.latestUser.groups") }
        if let latestUser {
            hasAcceptedCommunitySafety = latestUser.hasAcceptedCommunitySafetyTerms
        }

        async let groupsTask = container.threadsRepository.listMyThreadsPage(uid: currentUserID)
        // Seguiti, non "amici": il grafo amici non esiste più nel prodotto.
        async let friendsTask = container.userRepository.listFollowing(userID: currentUserID)

        var groupPage: ThreadsRepository.ThreadPage?
        do { groupPage = try await groupsTask } catch { SilentFailure.record(error, context: "TitleShare.groups") }
        existingGroups = (groupPage?.items ?? []).filter { $0.contextType == .group && !$0.isPublic }
        do { friends = try await friendsTask } catch { SilentFailure.record(error, context: "TitleShare.friends"); friends = [] }
    }

    private func openExistingGroup(_ thread: AppThread) async {
        guard hasAcceptedCommunitySafety else {
            errorMessage = String(localized: "Accetta i termini community prima di usare la chat.")
            return
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            try await container.threadsRepository.sendMessage(
                threadID: thread.id,
                senderUID: currentUserID,
                displayName: currentUserName,
                text: introMessage
            )
            dismiss()
            onOpenThread(thread)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func createGroup() async {
        guard hasAcceptedCommunitySafety else {
            errorMessage = String(localized: "Accetta i termini community prima di usare la chat.")
            return
        }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let participants = ([currentUserID] + selectedFriendIDs.sorted())
            let thread = try await container.threadsRepository.ensureGroupThread(
                titleID: nil,
                participantUIDs: participants,
                groupName: groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? title.name : groupName,
                createdBy: currentUserID
            )

            try await container.threadsRepository.sendMessage(
                threadID: thread.id,
                senderUID: currentUserID,
                displayName: currentUserName,
                text: introMessage
            )

            dismiss()
            onOpenThread(thread)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private var introMessage: String {
        "Parliamo di #[\(title.name)](\(title.id))"
    }

    private func acceptCommunitySafety() async {
        isAcceptingCommunitySafety = true
        errorMessage = nil
        defer { isAcceptingCommunitySafety = false }

        do {
            try await container.userRepository.acceptCommunitySafetyTerms(userID: currentUserID)
            hasAcceptedCommunitySafety = true
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    @ViewBuilder
    private func communitySafetyCard(
        title: String,
        message: String,
        buttonTitle: String,
        action: @escaping () async -> Void
    ) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                HStack(spacing: 12) {
                    Link("Termini", destination: CommunitySafetyPolicy.termsURL)
                    Link("Supporto", destination: CommunitySafetyPolicy.supportURL)
                }
                .font(.caption.weight(.semibold))

                Button {
                    Task { await action() }
                } label: {
                    if isAcceptingCommunitySafety {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text(buttonTitle)
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
    }
}

/// Una riga taggata sotto "Con chi l'hai visto?": persona o, per i voti
/// storici, il gruppo scelto quando il composer aveva ancora il selettore.
private struct WatchedWithChip: Hashable {
    let id: String
    let label: String
    let isGroup: Bool
}

private struct RatingComposerAttachment: Identifiable {
    let id: String
    let remoteURL: URL?
    let image: UIImage?

    init(remoteURL: URL) {
        self.id = "remote:\(remoteURL.absoluteString)"
        self.remoteURL = remoteURL
        self.image = nil
    }

    init(image: UIImage) {
        self.id = UUID().uuidString
        self.remoteURL = nil
        self.image = image
    }
}

private enum RatingAttachmentSource: String, Identifiable {
    case camera
    case library

    var id: String { rawValue }

    var pickerSourceType: UIImagePickerController.SourceType {
        switch self {
        case .camera:
            return .camera
        case .library:
            return .photoLibrary
        }
    }
}

struct RatingPostComposerSheet: View {
    let container: AppContainer
    let currentUserID: String
    let currentUserName: String
    let title: Title
    let level: String
    let season: Int?
    let episode: Int?
    let existingRating: Rating?
    let initialHasAcceptedCommunitySafety: Bool
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    /// nil = nessun voto ancora. Il voto è facoltativo: senza voto si salvano
    /// solo le emozioni; review/tag/foto/thread richiedono il voto (il doc
    /// /ratings esiste solo con un rating 1–10, come sulla PWA).
    @State private var rating: Double?
    @State private var reviewText: String
    /// Chi hai taggato, in ordine di scelta. Nasce dal voto esistente, che i
    /// nomi ce li ha gia' dentro: le chip si vedono da subito, prima che i
    /// default (`CompanionDefaults`) o la ricerca rispondano.
    @State private var taggedPeople: [FeedTaggedUser]
    /// Gruppo taggato da una versione precedente del composer. Non se ne
    /// aggiungono piu' — il selettore persone/gruppo non esiste — ma non si
    /// cancella alle spalle di chi ce l'ha: resta una chip removibile.
    @State private var taggedGroup: FeedTaggedGroup?
    /// "Da solo" selezionato: non scrive nulla di suo (assenza di tag =
    /// gia' "da solo"), serve solo a mostrare la chip come attiva e a far
    /// capire che la scelta e' stata fatta, non dimenticata.
    @State private var isAloneSelected = false
    /// Diventa `true` al primo tocco manuale su "Da solo" o su un compagno:
    /// da quel momento i default async (`loadCompanionDefaults`) non
    /// sovrascrivono piu' la scelta dell'utente se arrivano in ritardo.
    @State private var hasAdjustedCompanionsManually = false
    /// Compagni frequenti proposti come chip veloci sotto "Da solo". Vuoto
    /// finche' `CompanionDefaults` non ha abbastanza voti recenti per dire
    /// qualcosa (vedi `loadCompanionDefaults`).
    @State private var companionDefaults: CompanionDefaultsResult = .empty
    @State private var isShowingCompanionSearch = false
    @State private var companionSearchText = ""
    @State private var companionSearchResults: [AppUser] = []
    @State private var isSearchingCompanions = false
    @State private var companionSearchTask: Task<Void, Never>?
    @State private var attachments: [RatingComposerAttachment]
    @State private var isShowingPhotoSourceDialog = false
    @State private var activeAttachmentSource: RatingAttachmentSource?
    @State private var hasAcceptedCommunitySafety: Bool
    @State private var isLoadingContext = true
    @State private var isSubmitting = false
    @State private var isRemovingRating = false
    @State private var isConfirmingRemoveRating = false
    @State private var errorMessage: String?
    @State private var selectedEmotions: Set<TitleEmotion> = []
    @State private var initialEmotions: Set<TitleEmotion> = []
    // "Chi ti ha conquistato?" — solo film a livello titolo (vedi
    // `showsCharacterStep`). Stesso pattern before/after delle emozioni: si
    // manda solo se cambiato, insieme al resto del form al tocco "Pubblica".
    @State private var characterCandidates: [CharacterCandidate] = []
    @State private var isLoadingCharacterCandidates = false
    @State private var characterPicks: [CharacterPick] = []
    @State private var initialCharacterPicks: [CharacterPick] = []

    init(
        container: AppContainer,
        currentUserID: String,
        currentUserName: String,
        title: Title,
        level: String = "title",
        season: Int? = nil,
        episode: Int? = nil,
        existingRating: Rating?,
        hasAcceptedCommunitySafety: Bool,
        initialRating: Double?,
        onSaved: @escaping () -> Void
    ) {
        self.container = container
        self.currentUserID = currentUserID
        self.currentUserName = currentUserName
        self.title = title
        self.level = level
        self.season = season
        self.episode = episode
        self.existingRating = existingRating
        initialHasAcceptedCommunitySafety = hasAcceptedCommunitySafety
        self.onSaved = onSaved
        _rating = State(initialValue: initialRating.map(Self.normalizedRating))
        _reviewText = State(initialValue: existingRating?.reviewText ?? "")
        _taggedPeople = State(initialValue: existingRating?.watchedWith ?? [])
        _taggedGroup = State(initialValue: existingRating?.watchedWithGroup)
        _attachments = State(initialValue: (existingRating?.mediaURLs ?? []).map(RatingComposerAttachment.init(remoteURL:)))
        _hasAcceptedCommunitySafety = State(initialValue: hasAcceptedCommunitySafety)
    }

    private var isSeasonLevel: Bool { level == "season" }
    private var isEpisodeLevel: Bool { level == "episode" }
    private var isTitleLevel: Bool { level == "title" }
    /// Solo film a livello titolo: le serie scelgono i personaggi per
    /// episodio (`EpisodeSeenSheet`), non nel voto generale.
    private var showsCharacterStep: Bool { isTitleLevel && title.type == .movie }

    private var composerContextLabel: String {
        if isSeasonLevel, let season {
            return "Stagione \(season)"
        }
        if isEpisodeLevel, let season, let episode {
            return "Stagione \(season) · Episodio \(episode)"
        }
        return "Voto generale"
    }

    private var composerSubtitleLabel: String {
        if isSeasonLevel {
            return String(localized: "Stai votando solo questa stagione. Il voto generale al titolo resta separato.")
        }
        if isEpisodeLevel {
            return String(localized: "Stai votando solo questo episodio.")
        }
        return String(localized: "Il voto è facoltativo: senza, salvi solo le impressioni. Col voto puoi arricchire il post con persone, review e immagini.")
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                if !isTitleLevel {
                    Section {
                        HStack(spacing: 8) {
                            Image(systemName: isEpisodeLevel ? "play.rectangle.fill" : "square.stack.3d.up.fill")
                                .foregroundStyle(TwoWatchTheme.accent)
                            Text(composerContextLabel)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                    }
                }

                Section("Voto") {
                    SomtoStarRatingRow(value: rating) { newValue in
                        rating = newValue
                    }
                    .padding(.vertical, 6)

                    Text(composerSubtitleLabel)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                if isTitleLevel {
                    Section("Che impressione hai avuto?") {
                        EmotionGridPicker(selection: $selectedEmotions)
                            .padding(.vertical, 6)

                        Text("Facoltativo, fino a 3. Aiuta la community a capire il tono del titolo.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                }

                if showsCharacterStep {
                    Section("Chi ti ha conquistato?") {
                        CharacterPickRow(
                            candidates: characterCandidates,
                            isLoading: isLoadingCharacterCandidates,
                            picks: $characterPicks
                        )
                        .padding(.vertical, 6)

                        Text("Scegline fino a 3. Facoltativo.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                }

                Section("Review") {
                    TextEditor(text: $reviewText)
                        .frame(minHeight: 140)

                    if isTitleLevel {
                        Text("La review va nella discussione pubblica del titolo.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                        if !hasAcceptedCommunitySafety {
                            // Accettazione implicita. Il consenso separato da
                            // dare a mano teneva la review fuori dalla
                            // discussione per quasi tutti: chi non ha mai
                            // aperto una chat non ha mai accettato niente.
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Pubblicando accetti i termini della community.")
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textSecondary)

                                HStack(spacing: 12) {
                                    Link("Termini", destination: CommunitySafetyPolicy.termsURL)
                                    Link("Supporto", destination: CommunitySafetyPolicy.supportURL)
                                }
                                .font(.caption.weight(.semibold))
                            }
                        }
                    }
                }

                Section("Con chi l'hai visto?") {
                    if !taggedChips.isEmpty {
                        FlowChips(items: taggedChips) { chip in
                            watchedWithChip(chip)
                        }
                        .padding(.vertical, 2)
                    }

                    if isLoadingContext {
                        ProgressView()
                            .tint(TwoWatchTheme.brandPrimary)
                    } else {
                        if showsAloneQuickPick {
                            aloneChip
                                .padding(.vertical, 2)
                        }

                        if !frequentCompanionCandidates.isEmpty {
                            Text("Persone frequenti")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textSecondary)

                            FlowChips(items: frequentCompanionCandidates) { person in
                                frequentCompanionChip(person)
                            }
                            .padding(.vertical, 2)
                        }

                        if taggedPeople.count >= Self.maxTaggedPeople {
                            Text("Puoi taggare al massimo 12 persone.")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        } else if isShowingCompanionSearch {
                            companionSearchField
                        } else {
                            Button {
                                isShowingCompanionSearch = true
                            } label: {
                                Label("Cerca una persona", systemImage: "magnifyingglass")
                                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                            }
                        }
                    }
                }

                Section("Immagini") {
                    let canAddMorePhotos = attachments.count < 2

                    if attachments.isEmpty {
                        Text("Puoi caricare fino a 2 immagini. Nel feed la locandina resta la prima slide.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(attachments) { attachment in
                                    ZStack(alignment: .topTrailing) {
                                        attachmentPreview(attachment)

                                        Button {
                                            attachments.removeAll { $0.id == attachment.id }
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .font(.title3)
                                                .foregroundStyle(.white, Color.black.opacity(0.6))
                                        }
                                        .accessibilityLabel("Rimuovi allegato")
                                        .offset(x: 6, y: -6)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }

                    Button {
                        isShowingPhotoSourceDialog = true
                    } label: {
                        Label(
                            canAddMorePhotos ? "Aggiungi foto" : "Limite raggiunto",
                            systemImage: "photo.on.rectangle.angled"
                        )
                        .foregroundStyle(canAddMorePhotos ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textMuted)
                    }
                    .disabled(!canAddMorePhotos)
                }

                if existingRating != nil {
                    Section {
                        Button(role: .destructive) {
                            isConfirmingRemoveRating = true
                        } label: {
                            if isRemovingRating {
                                HStack(spacing: 8) {
                                    ProgressView()
                                    Text("Rimozione...")
                                }
                                .frame(maxWidth: .infinity, alignment: .center)
                            } else {
                                Label("Rimuovi voto", systemImage: "star.slash.fill")
                                    .frame(maxWidth: .infinity, alignment: .center)
                            }
                        }
                        .disabled(isRemovingRating || isSubmitting)
                    } footer: {
                        Text(removeRatingFooter)
                    }
                }
            }
            .navigationTitle(title.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(isSubmitting ? "Salvataggio..." : "Pubblica") {
                        Task { await save() }
                    }
                    .disabled(isSubmitting)
                }
            }
            .task {
                await loadContext()
            }
            .task {
                await loadCompanionDefaults()
            }
            .confirmationDialog(
                "Rimuovere il voto?",
                isPresented: $isConfirmingRemoveRating,
                titleVisibility: .visible
            ) {
                Button("Rimuovi voto", role: .destructive) {
                    Task { await removeRating() }
                }
                Button("Annulla", role: .cancel) {}
            } message: {
                Text(removeRatingFooter)
            }
            .confirmationDialog(
                "Scegli come aggiungere la foto",
                isPresented: $isShowingPhotoSourceDialog,
                titleVisibility: .visible
            ) {
                let canAddMorePhotos = attachments.count < 2

                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button("Scatta foto") {
                        if canAddMorePhotos {
                            activeAttachmentSource = .camera
                        }
                    }
                }

                Button("Scegli dalla libreria") {
                    if canAddMorePhotos {
                        activeAttachmentSource = .library
                    }
                }
                .disabled(!canAddMorePhotos)

                Button("Annulla", role: .cancel) {}
            }
            .sheet(item: $activeAttachmentSource) { source in
                AttachmentImagePicker(source: source) { image in
                    guard let image else { return }
                    addPickedAttachment(image)
                }
                .ignoresSafeArea()
            }
        }
    }

    private func loadContext() async {
        isLoadingContext = true
        defer { isLoadingContext = false }

        var latestUser: AppUser?
        do { latestUser = try await container.userRepository.fetchUser(uid: currentUserID) } catch { SilentFailure.record(error, context: "TitleEmotions.latestUser") }
        if let latestUser {
            hasAcceptedCommunitySafety = latestUser.hasAcceptedCommunitySafetyTerms
        }

        if isTitleLevel {
var existing: [TitleEmotion] = []
do {
    existing = try await container.titleRepository.fetchMyTitleEmotions(
        userID: currentUserID,
        titleID: title.id
    )
} catch { SilentFailure.record(error, context: "TitleEmotions.mine") }
            selectedEmotions = Set(existing)
            initialEmotions = Set(existing)
        }

        if showsCharacterStep {
            isLoadingCharacterCandidates = true
            async let candidatesTask = container.titleRepository.fetchTitleCharacterCandidates(title: title)
            async let picksTask = container.titleRepository.fetchMyCharacterPicksForItem(
                titleID: title.id,
                level: "title",
                season: 0,
                episode: 0,
                uid: currentUserID
            )
            do { characterCandidates = try await candidatesTask } catch { SilentFailure.record(error, context: "TitleEmotions.characterCandidates"); characterCandidates = [] }
            var existingPicks: [CharacterPick] = []
            do { existingPicks = try await picksTask } catch { SilentFailure.record(error, context: "TitleEmotions.myPicks") }
            characterPicks = existingPicks
            initialCharacterPicks = existingPicks
            isLoadingCharacterCandidates = false
        }
    }

    /// Stesso tetto del web (`selectedReviewWatchedWith`): oltre non si tagga.
    private static let maxTaggedPeople = 12

    private var taggedChips: [WatchedWithChip] {
        var chips = taggedPeople.map {
            WatchedWithChip(id: $0.id, label: $0.displayName, isGroup: false)
        }
        if let taggedGroup {
            chips.append(WatchedWithChip(id: taggedGroup.id, label: taggedGroup.groupName, isGroup: true))
        }
        return chips
    }

    /// "Da solo" si mostra solo se `CompanionDefaults` ha abbastanza segnale
    /// (preselezione attiva, o almeno un compagno frequente da contrapporle)
    /// — niente chip finta in attesa, come da spec: default senza dati =
    /// nessuna chip.
    private var showsAloneQuickPick: Bool {
        companionDefaults.preselectAlone || !companionDefaults.frequentCompanions.isEmpty
    }

    /// Compagni frequenti non ancora taggati: si aggiornano da soli man mano
    /// che l'utente tagga qualcuno dalla lista.
    private var frequentCompanionCandidates: [FeedTaggedUser] {
        let taken = Set(taggedPeople.map(\.id))
        return companionDefaults.frequentCompanions.filter { !taken.contains($0.id) }
    }

    @ViewBuilder
    private var aloneChip: some View {
        Button {
            toggleAloneSelected()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "person.fill")
                    .font(.caption2)
                Text("Da solo")
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(isAloneSelected ? Color.white : TwoWatchTheme.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                isAloneSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.panelStrong,
                in: Capsule()
            )
            .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: isAloneSelected ? 0 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isAloneSelected ? [.isSelected] : [])
    }

    @ViewBuilder
    private func frequentCompanionChip(_ person: FeedTaggedUser) -> some View {
        Button {
            addTaggedPerson(person)
        } label: {
            Text(person.displayName)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(TwoWatchTheme.panelStrong, in: Capsule())
                .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var companionSearchField: some View {
        HStack(spacing: 8) {
            TextField("Cerca una persona", text: $companionSearchText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .onChange(of: companionSearchText) { _, newValue in
                    scheduleCompanionSearch(for: newValue)
                }

            Button {
                closeCompanionSearch()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .accessibilityLabel("Chiudi ricerca")
        }

        if isSearchingCompanions {
            ProgressView()
                .tint(TwoWatchTheme.brandPrimary)
        } else if !companionSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if companionSearchResults.isEmpty {
                Text("Nessuna persona trovata")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            } else {
                ForEach(companionSearchResults) { person in
                    Button {
                        addTaggedPerson(person)
                    } label: {
                        HStack(spacing: 10) {
                            SomtoAvatar(
                                url: person.photoURL ?? person.avatarURL,
                                name: person.displayName,
                                size: 30
                            )

                            VStack(alignment: .leading, spacing: 2) {
                                Text(person.displayName)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                Text("@\(person.displayNameLower)")
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                            }

                            Spacer(minLength: 8)

                            Image(systemName: "plus.circle.fill")
                                .foregroundStyle(TwoWatchTheme.accent)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private func watchedWithChip(_ chip: WatchedWithChip) -> some View {
        HStack(spacing: 6) {
            if chip.isGroup {
                Image(systemName: "person.3.fill")
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            Text(chip.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(1)

            Button {
                if chip.isGroup {
                    taggedGroup = nil
                } else {
                    taggedPeople.removeAll { $0.id == chip.id }
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Rimuovi \(chip.label)")
        }
        .padding(.leading, 12)
        .padding(.trailing, 2)
        .padding(.vertical, 5)
        .background(TwoWatchTheme.panelStrong, in: Capsule())
        .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private func addTaggedPerson(_ friend: AppUser) {
        addTaggedPerson(FeedTaggedUser(id: friend.id, displayName: friend.displayName))
    }

    /// Selezionare un compagno (chip frequente o risultato di ricerca)
    /// deseleziona "Da solo": non ha senso taggare qualcuno e restare
    /// segnati come "visto da solo".
    private func addTaggedPerson(_ person: FeedTaggedUser) {
        guard taggedPeople.count < Self.maxTaggedPeople else { return }
        guard !taggedPeople.contains(where: { $0.id == person.id }) else { return }
        hasAdjustedCompanionsManually = true
        isAloneSelected = false
        taggedPeople.append(person)
        closeCompanionSearch()
    }

    /// "Da solo" e compagni taggati sono a scelta esclusiva: selezionare
    /// "Da solo" svuota i tag, perche' non si puo' essere sia soli che
    /// accompagnati sullo stesso voto.
    private func toggleAloneSelected() {
        hasAdjustedCompanionsManually = true
        isAloneSelected.toggle()
        if isAloneSelected {
            taggedPeople.removeAll()
        }
    }

    private func closeCompanionSearch() {
        companionSearchTask?.cancel()
        companionSearchTask = nil
        isShowingCompanionSearch = false
        companionSearchText = ""
        companionSearchResults = []
        isSearchingCompanions = false
    }

    /// Debounce leggero: la ricerca gira su tutti gli utenti Somto (non solo
    /// i seguiti), quindi ogni carattere digitato e' una query di rete.
    private func scheduleCompanionSearch(for query: String) {
        companionSearchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            companionSearchResults = []
            isSearchingCompanions = false
            return
        }
        companionSearchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await runCompanionSearch(query: trimmed)
        }
    }

    private func runCompanionSearch(query: String) async {
        isSearchingCompanions = true
        defer { isSearchingCompanions = false }

        let excludedIDs = Set(taggedPeople.map(\.id) + [currentUserID])
        do {
            let results = try await container.userRepository.searchUsers(prefix: query, limit: 10)
            guard !Task.isCancelled else { return }
            companionSearchResults = results.filter { !excludedIDs.contains($0.id) }
        } catch {
            SilentFailure.record(error, context: "RatingComposer.companionSearch")
            companionSearchResults = []
        }
    }

    /// Ultimi voti dell'utente → default del picker (`CompanionDefaults`).
    /// Gira separata da `loadContext()`: e' la lettura piu' pesante (fino a
    /// ~90 doc + join sui titoli) e non deve tenere il resto del composer in
    /// caricamento. Se fallisce, default vuoti — nessuna chip, nessun
    /// preselezionato — silenziosamente (`SilentFailure`).
    private func loadCompanionDefaults() async {
        var samples: [CompanionRatingSample] = []
        do {
            samples = try await container.titleRepository.fetchRecentRatingsForCompanionDefaults(userID: currentUserID)
        } catch {
            SilentFailure.record(error, context: "RatingComposer.companionDefaults")
        }

        let result = CompanionDefaults.compute(recentRatings: samples, mediaType: title.type)
        companionDefaults = result

        // Non toccare la scelta dell'utente se ha gia' agito (a mano, o
        // partendo da un voto esistente con dei tag) mentre i default erano
        // ancora in volo.
        if !hasAdjustedCompanionsManually, taggedPeople.isEmpty, taggedGroup == nil {
            isAloneSelected = result.preselectAlone
        }
    }

    /// La review va nella discussione pubblica del titolo, senza toggle. Ma
    /// solo se e' NUOVA o CAMBIATA: se no ogni ritocco del voto — stelle, foto,
    /// un tag in piu' — sparava un altro messaggio nel thread.
    private func sharesReviewToPublicThread(review: String) -> Bool {
        guard isTitleLevel, !review.isEmpty else { return false }
        let previous = (existingRating?.reviewText ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return review != previous
    }

    private func shareReviewToPublicThread(ratingValue: Double, review: String) async {
        // Accettazione implicita dei termini community: il composer lo dice
        // prima del tocco. Chi non ha mai aperto una chat non li ha mai
        // accettati, ed e' esattamente chi scrive la prima review.
        if !hasAcceptedCommunitySafety {
            do {
                try await container.userRepository.acceptCommunitySafetyTerms(userID: currentUserID)
                hasAcceptedCommunitySafety = true
            } catch {
                SilentFailure.record(error, context: "RatingComposer.acceptTerms")
                return
            }
        }

        do {
            // Server-side auto-create avoids App Check enforcement on direct
            // Firestore writes (which fails on TestFlight builds).
            try await container.threadsRepository.sendMessage(
                threadID: "public_\(title.id)",
                senderUID: currentUserID,
                displayName: currentUserName,
                text: TitleDetailFormatter.publicReviewThreadMessage(
                    ratingValue: ratingValue,
                    reviewText: review
                ),
                ensurePublicForTitleID: title.id
            )
        } catch {
            // Il voto e' gia' salvato: un messaggio non partito non deve
            // tenere aperto il composer ne' far sembrare persa la review.
            SilentFailure.record(error, context: "RatingComposer.publicThread")
        }
    }

    private var removeRatingFooter: String {
        switch level {
        case "season":
            return String(localized: "Elimina il voto di questa stagione. Gli altri voti restano.")
        case "episode":
            return String(localized: "Elimina il voto di questo episodio. Gli altri voti restano.")
        default:
            return "Il titolo resta tra i visti, ma senza voto generale."
        }
    }

    private func removeRating() async {
        isRemovingRating = true
        errorMessage = nil
        defer { isRemovingRating = false }

        do {
            try await container.titleRepository.deleteRating(
                userID: currentUserID,
                titleID: title.id,
                level: level,
                season: season,
                episode: episode
            )
            dismiss()
            onSaved()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func save() async {
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let watchedWith = Array(taggedPeople.prefix(Self.maxTaggedPeople))
            let watchedWithGroup = taggedGroup

            let review = reviewText.trimmingCharacters(in: .whitespacesAndNewlines)

            // Senza voto: review/tag/foto/thread vivono sul doc rating (che
            // richiede un rating 1–10), quindi o si chiede il voto o — se c'è
            // solo l'impressione — si salvano le emozioni e basta.
            guard let ratingValue = rating.map(Self.normalizedRating) else {
                let needsRating = !review.isEmpty
                    || !watchedWith.isEmpty
                    || watchedWithGroup != nil
                    || !attachments.isEmpty
                if needsRating {
                    errorMessage = String(localized: "Per salvare review, tag, foto o condivisione serve un voto: tocca le stelle qui sopra.")
                    return
                }
                if isTitleLevel, selectedEmotions != initialEmotions {
                    try await container.titleRepository.submitTitleEmotions(
                        userID: currentUserID,
                        titleID: title.id,
                        emotions: Array(selectedEmotions)
                    )
                }
                if showsCharacterStep, characterPicks != initialCharacterPicks {
                    try await container.titleRepository.submitCharacterPicks(
                        titleID: title.id,
                        level: "title",
                        season: 0,
                        episode: 0,
                        picks: characterPicks,
                        userID: currentUserID
                    )
                }
                dismiss()
                onSaved()
                return
            }

            let remoteURLs = attachments.compactMap(\.remoteURL)
            let localImages = attachments.compactMap(\.image)
            let uploadedURLs = try await container.titleRepository.uploadRatingMedia(
                userID: currentUserID,
                titleID: title.id,
                images: localImages
            )

            try await container.titleRepository.submitRating(
                userID: currentUserID,
                titleID: title.id,
                level: level,
                season: season,
                episode: episode,
                value: ratingValue,
                reviewText: nil,
                details: RatingSocialDetails(
                    reviewText: review.isEmpty ? nil : review,
                    watchedWith: watchedWith,
                    watchedWithGroup: watchedWithGroup,
                    mediaURLs: Array((remoteURLs + uploadedURLs).prefix(2))
                )
            )

            if isTitleLevel, selectedEmotions != initialEmotions {
                // Non bloccante: il voto è già salvato, un errore qui non deve
                // impedire la chiusura del composer.
                do {
                    try await container.titleRepository.submitTitleEmotions(
                        userID: currentUserID,
                        titleID: title.id,
                        emotions: Array(selectedEmotions)
                    )
                } catch {
                    SilentFailure.record(error, context: "TitleEmotions.submitEmotions")
                }
            }

            if showsCharacterStep, characterPicks != initialCharacterPicks {
                // Non bloccante, stesso trattamento delle emozioni qui sopra.
                do {
                    try await container.titleRepository.submitCharacterPicks(
                        titleID: title.id,
                        level: "title",
                        season: 0,
                        episode: 0,
                        picks: characterPicks,
                        userID: currentUserID
                    )
                } catch {
                    SilentFailure.record(error, context: "TitleEmotions.submitPicks")
                }
            }

            if sharesReviewToPublicThread(review: review) {
                await shareReviewToPublicThread(ratingValue: ratingValue, review: review)
            }

            dismiss()
            onSaved()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    @ViewBuilder
    private func attachmentPreview(_ attachment: RatingComposerAttachment) -> some View {
        Group {
            if let image = attachment.image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if let remoteURL = attachment.remoteURL {
                CachedAsyncImage(url: remoteURL) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFill()
                    default:
                        ProgressView()
                            .tint(TwoWatchTheme.brandPrimary)
                    }
                }
            }
        }
        .frame(width: 94, height: 126)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private static func normalizedRating(_ value: Double) -> Double {
        max(1, min(10, (value * 4).rounded() / 4))
    }

    @MainActor
    private func addPickedAttachment(_ image: UIImage) {
        let remainingSlots = max(0, 2 - attachments.count)
        guard remainingSlots > 0 else { return }
        attachments.append(RatingComposerAttachment(image: image))
    }
}

private struct AttachmentImagePicker: UIViewControllerRepresentable {
    let source: RatingAttachmentSource
    let onImagePicked: (UIImage?) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator {
        Coordinator(onImagePicked: onImagePicked, dismiss: dismiss)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = source.pickerSourceType
        if source == .camera {
            picker.cameraCaptureMode = .photo
        }
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        private let onImagePicked: (UIImage?) -> Void
        private let dismiss: DismissAction

        init(onImagePicked: @escaping (UIImage?) -> Void, dismiss: DismissAction) {
            self.onImagePicked = onImagePicked
            self.dismiss = dismiss
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onImagePicked(nil)
            dismiss()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let image = info[.originalImage] as? UIImage
            onImagePicked(image)
            dismiss()
        }
    }
}

// MARK: - F-B — CTA quiz sul titolo + prompt post-visto

struct TitleQuizCTAButton: View {
    let titleName: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Image(systemName: "gamecontroller.fill")
                    .font(.headline)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Gioca il quiz")
                        .font(.headline.weight(.bold))
                    Text("Quanto conosci \(titleName)?")
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white.opacity(0.7))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [TwoWatchTheme.brandWarm, TwoWatchTheme.brandPrimary],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Gioca il quiz su \(titleName)")
    }
}

struct PostSeenQuizPromptView: View {
    let titleName: String
    let onPlay: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "gamecontroller.fill")
                .font(.system(size: 38))
                .foregroundStyle(TwoWatchTheme.brandPrimary)
                .padding(.top, 18)
            Text("Hai appena visto \(titleName)")
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .multilineTextAlignment(.center)
            Text("Quanto hai capito davvero? Mettiti alla prova con un quiz veloce.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)
            Button(action: onPlay) {
                Text("Gioca il quiz")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(.plain)
            Button("Più tardi") { dismiss() }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .background(TwoWatchTheme.background.ignoresSafeArea())
    }
}

/// Prompt compatto post "segna come visto"/"completato": "Che impressione ti
/// ha lasciato?" con la griglia emozioni + Salva/Non ora. Skippabile, non
/// blocca il flusso (il voto/mark è già stato salvato). Mostrato solo se
/// l'utente non ha già emozioni salvate per questo titolo (v. chiamante).
struct PostSeenEmotionPromptSheet: View {
    let container: AppContainer
    let userID: String
    let titleID: String
    let titleName: String

    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<TitleEmotion> = []
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 16) {
            Text("Che impressione ti ha lasciato?")
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .multilineTextAlignment(.center)

            Text("Hai appena finito \(titleName). Scegli fino a 3 emozioni, facoltativo.")
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
                    Text("Salva")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting || selection.isEmpty)
            .opacity(selection.isEmpty ? 0.5 : 1)

            Button("Non ora") { dismiss() }
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
            dismiss()
        } catch {
            errorMessage = "Impossibile salvare. Riprova."
        }
    }
}

/// Foglio "Vedi tutte" per i correlati: griglia fino a 40 titoli (stessa
/// `TitleRelatedCard` della corsia orizzontale) + CTA per proporre un
/// correlato mancante. Il CTA e' dietro auth gate: i guest finiscono su
/// `shell.presentAuth()`, come nel resto della scheda.
struct TitleRelatedGridSheet: View {
    let pageTitle: Title
    let relatedTitles: [Title]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @Environment(\.dismiss) private var dismiss
    @State private var isSuggestSheetPresented = false
    @State private var confirmationMessage: String?

    private let columns = [GridItem(.adaptive(minimum: 142), spacing: 14)]
    /// Stesso tetto di `RELATED_CANDIDATES_MAX` sul web
    /// (`public/js/api/titles.api.js`): la fetch unificata gia' non supera
    /// questo numero di candidati, il taglio qui e' solo difensivo.
    private let maxGridItems = 40

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Button {
                        if let uid = session.firebaseUser?.uid, !uid.isEmpty {
                            isSuggestSheetPresented = true
                        } else {
                            shell.presentAuth()
                        }
                    } label: {
                        Label("Suggerisci un titolo", systemImage: "plus.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.accent))

                    if relatedTitles.isEmpty {
                        EmptyStateView(
                            title: "Nessun correlato trovato",
                            message: "Quando il catalogo trova affinità forti, compariranno qui.",
                            systemImage: "square.stack.3d.forward.dottedline"
                        )
                    } else {
                        LazyVGrid(columns: columns, spacing: 14) {
                            ForEach(relatedTitles.prefix(maxGridItems)) { related in
                                NavigationLink {
                                    TitleDetailView(container: container, session: session, shell: shell, titleID: related.id)
                                } label: {
                                    TitleRelatedCard(title: related)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(TwoWatchBackground())
            .navigationTitle("Titoli correlati")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
            .sheet(isPresented: $isSuggestSheetPresented) {
                if let uid = session.firebaseUser?.uid {
                    TitleSuggestRelatedSheet(pageTitle: pageTitle, currentUserID: uid, container: container) { message in
                        confirmationMessage = message
                    }
                }
            }
            .alert(
                confirmationMessage ?? "",
                isPresented: Binding(
                    get: { confirmationMessage != nil },
                    set: { if !$0 { confirmationMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            }
        }
    }
}

/// Ricerca titoli + creazione di `titleRelatedSuggestions` (auto-approvata
/// server-side alla terza proposta utente distinta). Riusa
/// `searchTitlesForListBuilder` (stesso scoring del list builder watchlist)
/// invece di costruire un secondo indice di ricerca lato client.
struct TitleSuggestRelatedSheet: View {
    let pageTitle: Title
    let currentUserID: String
    let container: AppContainer
    /// Messaggio di conferma da mostrare nel foglio chiamante dopo il dismiss.
    let onSuggestionSent: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Title] = []
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var pendingSuggestionID: String?
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("Suggerisci un titolo")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text("Cerca il titolo da collegare a \(pageTitle.name). Con altre due proposte uguali, il collegamento diventa automatico.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                TextField("Cerca un titolo", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: query) { _, newValue in
                        scheduleSearch(for: newValue)
                    }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                if isSearching {
                    ProgressView()
                        .tint(TwoWatchTheme.textPrimary)
                        .frame(maxWidth: .infinity, minHeight: 80)
                } else if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, results.isEmpty {
                    Text("Nessun risultato")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                } else {
                    ScrollView {
                        VStack(spacing: 10) {
                            ForEach(results) { candidate in
                                Button {
                                    Task { await sendSuggestion(candidate) }
                                } label: {
                                    HStack(spacing: 12) {
                                        PosterImageView(url: candidate.posterPath, width: 44, height: 62, cornerRadius: 10)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(candidate.name)
                                                .font(.subheadline.weight(.semibold))
                                                .foregroundStyle(TwoWatchTheme.textPrimary)
                                                .lineLimit(2)
                                            Text(candidate.subtitle)
                                                .font(.caption)
                                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                        }
                                        Spacer(minLength: 0)
                                        if pendingSuggestionID == candidate.id {
                                            ProgressView()
                                        }
                                    }
                                    .padding(10)
                                    .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                }
                                .buttonStyle(.plain)
                                .disabled(pendingSuggestionID != nil)
                            }
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(20)
            .background(TwoWatchBackground())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }

    private func scheduleSearch(for rawQuery: String) {
        searchTask?.cancel()
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            results = []
            isSearching = false
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await runSearch(query: trimmed)
        }
    }

    private func runSearch(query: String) async {
        isSearching = true
        defer { isSearching = false }
        do {
            let found = try await container.titleRepository.searchTitlesForListBuilder(query, limit: 20)
            guard !Task.isCancelled else { return }
            results = found.filter { $0.id != pageTitle.id }
        } catch {
            SilentFailure.record(error, context: "TitleSuggestRelated.search")
            results = []
        }
    }

    private func sendSuggestion(_ candidate: Title) async {
        pendingSuggestionID = candidate.id
        defer { pendingSuggestionID = nil }
        do {
            try await container.titleRepository.createRelatedSuggestion(
                userID: currentUserID,
                titleID: pageTitle.id,
                suggestedTitleID: candidate.id
            )
            dismiss()
            onSuggestionSent(String(localized: "Grazie, suggerimento ricevuto."))
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

