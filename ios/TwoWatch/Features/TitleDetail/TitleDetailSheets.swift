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

private enum RatingShareSelectionMode: String, CaseIterable, Identifiable {
    case people = "Utenti"
    case group = "Gruppo"

    var id: String { rawValue }
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
    @State private var shareMode: RatingShareSelectionMode
    @State private var friends: [AppUser] = []
    @State private var groups: [AppThread] = []
    @State private var selectedFriendIDs: Set<String>
    @State private var selectedGroupID: String?
    @State private var friendSearchText = ""
    @State private var attachments: [RatingComposerAttachment]
    @State private var isShowingPhotoSourceDialog = false
    @State private var activeAttachmentSource: RatingAttachmentSource?
    @State private var postToPublicThread = false
    @State private var hasAcceptedCommunitySafety: Bool
    @State private var isAcceptingCommunitySafety = false
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
        _shareMode = State(initialValue: existingRating?.watchedWithGroup == nil ? .people : .group)
        _selectedFriendIDs = State(initialValue: Set(existingRating?.watchedWith.map(\.id) ?? []))
        _selectedGroupID = State(initialValue: existingRating?.watchedWithGroup?.id)
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
                }

                Section("Con chi l'hai visto") {
                    if !groups.isEmpty {
                        Picker("Modalita", selection: $shareMode) {
                            ForEach(RatingShareSelectionMode.allCases) { mode in
                                Text(LocalizedStringKey(mode.rawValue)).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    if isLoadingContext {
                        ProgressView()
                            .tint(TwoWatchTheme.brandPrimary)
                    } else if shareMode == .group, !groups.isEmpty {
                        ForEach(groups) { group in
                            Button {
                                selectedGroupID = selectedGroupID == group.id ? nil : group.id
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(group.displayName(currentUserID: currentUserID))
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(TwoWatchTheme.textPrimary)

                                        Text(groupParticipantsLine(group))
                                            .font(.caption)
                                            .foregroundStyle(TwoWatchTheme.textSecondary)
                                            .lineLimit(2)
                                    }

                                    Spacer()

                                    Image(systemName: selectedGroupID == group.id ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(selectedGroupID == group.id ? TwoWatchTheme.accent : TwoWatchTheme.textMuted)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    } else if friends.isEmpty {
                        Text("Non segui ancora nessuno da taggare. Puoi comunque salvare review e immagini.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    } else {
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
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(friend.displayName)
                                            .foregroundStyle(TwoWatchTheme.textPrimary)
                                        Text("@\(friend.displayNameLower)")
                                            .font(.caption)
                                            .foregroundStyle(TwoWatchTheme.textSecondary)
                                    }
                                }
                                .tint(TwoWatchTheme.accent)
                            }
                        }
                    }

                    Text("Facoltativo. Se scegli un gruppo, nel feed useremo i membri del gruppo per costruire il post.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
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

                if isTitleLevel {
                Section("Thread pubblico") {
                    if hasAcceptedCommunitySafety {
                        Toggle("Invia anche nel thread pubblico del titolo", isOn: $postToPublicThread)
                        Text("Opzionale: oltre al feed, puoi mandare la stessa review anche nella discussione pubblica del titolo.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    } else {
                        Text("Per pubblicare anche nel thread pubblico devi prima accettare i termini community della chat.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                        HStack(spacing: 12) {
                            Link("Termini", destination: CommunitySafetyPolicy.termsURL)
                            Link("Supporto", destination: CommunitySafetyPolicy.supportURL)
                        }
                        .font(.caption.weight(.semibold))

                        Button {
                            Task { await acceptCommunitySafety() }
                        } label: {
                            if isAcceptingCommunitySafety {
                                ProgressView()
                                    .tint(.white)
                                    .frame(maxWidth: .infinity)
                            } else {
                                Text("Accetta e abilita il thread pubblico")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                }
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

        async let groupsTask = container.threadsRepository.listMyThreadsPage(uid: currentUserID)
        // Seguiti, non "amici": il grafo amici non esiste più nel prodotto.
        async let friendsTask = container.userRepository.listFollowing(userID: currentUserID)

        var groupPage: ThreadsRepository.ThreadPage?
        do { groupPage = try await groupsTask } catch { SilentFailure.record(error, context: "TitleEmotions.groups") }
        groups = (groupPage?.items ?? []).filter { $0.contextType == .group && !$0.isPublic }
        do { friends = try await friendsTask } catch { SilentFailure.record(error, context: "TitleEmotions.friends"); friends = [] }

        if groups.isEmpty {
            shareMode = .people
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

    private var filteredFriends: [AppUser] {
        let query = friendSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return friends }
        return friends.filter { friend in
            friend.displayName.localizedCaseInsensitiveContains(query) ||
            friend.displayNameLower.localizedCaseInsensitiveContains(query)
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
        if postToPublicThread && !hasAcceptedCommunitySafety {
            errorMessage = String(localized: "Accetta i termini community prima di pubblicare nel thread.")
            return
        }

        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        do {
            let selectedGroup = groups.first(where: { $0.id == selectedGroupID })
            let watchedWith = buildWatchedWith(selectedGroup: selectedGroup)
            let watchedWithGroup = shareMode == .group ? selectedGroup.map {
                FeedTaggedGroup(
                    id: $0.id,
                    groupName: $0.groupName.isEmpty ? $0.displayName(currentUserID: currentUserID) : $0.groupName
                )
            } : nil

            let review = reviewText.trimmingCharacters(in: .whitespacesAndNewlines)

            // Senza voto: review/tag/foto/thread vivono sul doc rating (che
            // richiede un rating 1–10), quindi o si chiede il voto o — se c'è
            // solo l'impressione — si salvano le emozioni e basta.
            guard let ratingValue = rating.map(Self.normalizedRating) else {
                let needsRating = !review.isEmpty
                    || !watchedWith.isEmpty
                    || watchedWithGroup != nil
                    || !attachments.isEmpty
                    || postToPublicThread
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

            if postToPublicThread && isTitleLevel {
                // Server-side auto-create avoids App Check enforcement on direct
                // Firestore writes (which fails on TestFlight builds).
                let publicThreadID = "public_\(title.id)"
                try await container.threadsRepository.sendMessage(
                    threadID: publicThreadID,
                    senderUID: currentUserID,
                    displayName: currentUserName,
                    text: TitleDetailFormatter.publicReviewThreadMessage(
                        ratingValue: ratingValue,
                        reviewText: review.isEmpty ? nil : review
                    ),
                    ensurePublicForTitleID: title.id
                )
            }

            dismiss()
            onSaved()
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

    private func buildWatchedWith(selectedGroup: AppThread?) -> [FeedTaggedUser] {
        switch shareMode {
        case .people:
            return friends
                .filter { selectedFriendIDs.contains($0.id) }
                .map { FeedTaggedUser(id: $0.id, displayName: $0.displayName) }
        case .group:
            guard let selectedGroup else { return [] }
            let participants = !selectedGroup.participantUsers.isEmpty
                ? selectedGroup.participantUsers
                : selectedGroup.participants.map { uid in
                    AppUser(
                        id: uid,
                        displayName: "Amico",
                        displayNameLower: "amico",
                        photoURL: nil,
                        avatarURL: nil,
                        trusted: false,
                        isAdmin: false,
                        level: .base,
                        stats: UserStats(ratingsCount: 0, reviewsCount: 0, watchedCount: 0, totalWatchMinutes: 0),
                        favoriteGenres: [],
                        communitySafetyAcceptedAt: nil,
                        communitySafetyVersion: 0
                    )
                }

            return participants
                .filter { $0.id != currentUserID }
                .map { FeedTaggedUser(id: $0.id, displayName: $0.displayName) }
        }
    }

    private func groupParticipantsLine(_ group: AppThread) -> String {
        let names = group.participantUsers
            .filter { $0.id != currentUserID }
            .map(\.displayName)

        if names.isEmpty {
            return String(localized: "Nessun partecipante disponibile")
        }
        return names.prefix(3).joined(separator: ", ")
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

