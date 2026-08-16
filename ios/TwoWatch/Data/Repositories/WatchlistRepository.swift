@preconcurrency import FirebaseFirestore
@preconcurrency import FirebaseStorage
import Foundation
import UIKit

@MainActor
final class WatchlistRepository {
    static let generalWatchlistListID = "__general_watchlist__"

    private let db = Firestore.firestore()
    private let titleRepository: TitleRepository
    private let userRepository: UserRepository
    private var migrationCache: [String: UserMigrationResult] = [:]
    private var migrationTasks: [String: Task<UserMigrationResult, Error>] = [:]
    /// Solo richieste **in volo**, nessuna cache nel tempo: vedi
    /// `fetchTitleStates(userID:)`.
    private var titleStatesTasks: [String: Task<[TitlePersonalState], Error>] = [:]

    init(titleRepository: TitleRepository, userRepository: UserRepository) {
        self.titleRepository = titleRepository
        self.userRepository = userRepository
    }

    // MARK: - Dashboard

    func ensureUserMigration(userID: String, force: Bool = false) async throws -> UserMigrationResult {
        let normalizedUserID = userID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedUserID.isEmpty else {
            return UserMigrationResult(migratedCount: 0, skippedCount: 0, alreadyMigrated: true)
        }

        if force {
            migrationCache.removeValue(forKey: normalizedUserID)
            migrationTasks.removeValue(forKey: normalizedUserID)
        } else if let cached = migrationCache[normalizedUserID] {
            return cached
        } else if let inFlight = migrationTasks[normalizedUserID] {
            return try await inFlight.value
        }

        let task = Task<UserMigrationResult, Error> {
            let response = try await self.invokeCallable(name: "migrateUserWatchlistV2", payload: [
                "force": force,
                "uid": normalizedUserID
            ])
            let data = response.data as? [String: Any] ?? [:]

            return UserMigrationResult(
                migratedCount: FirestoreValueReader.int(data, key: "migratedCount") ?? 0,
                skippedCount: FirestoreValueReader.int(data, key: "skippedCount") ?? 0,
                alreadyMigrated: FirestoreValueReader.bool(data, key: "alreadyMigrated") ?? false
            )
        }

        migrationTasks[normalizedUserID] = task

        do {
            let result = try await task.value
            migrationTasks.removeValue(forKey: normalizedUserID)
            migrationCache[normalizedUserID] = result
            return result
        } catch {
            migrationTasks.removeValue(forKey: normalizedUserID)
            throw error
        }
    }

    /// Variante non-throwing di `ensureUserMigration`: assorbe gli errori (come il
    /// vecchio `try?`) così può essere avviata via `async let` in parallelo alle query.
    private func ensureUserMigrationOptional(userID: String) async -> UserMigrationResult? {
        try? await ensureUserMigration(userID: userID)
    }

    func fetchWatchlistDashboard(userID: String) async throws -> WatchlistDashboard {
        // La migrazione parte IN PARALLELO alle query, non più prima come blocco
        // sequenziale. Se una migrazione reale avviene (non `alreadyMigrated`),
        // rileggiamo i titleStates una volta perché possono essere cambiati.
        async let migrationTask: UserMigrationResult? = ensureUserMigrationOptional(userID: userID)
        async let titleStatesTask = fetchTitleStates(userID: userID)
        async let memberListsTask = fetchMemberLists(userID: userID)
        async let publicListsTask = fetchPublicLists(currentUserID: userID)
        async let pinnedPublicListIDsTask = fetchPinnedPublicListIDs(userID: userID)
        async let publicListProgressEntriesTask = fetchPublicListProgressEntries(userID: userID)

        let (fetchedTitleStates, memberLists, publicLists, pinnedPublicListIDs, publicListProgressEntries) = try await (
            titleStatesTask,
            memberListsTask,
            publicListsTask,
            pinnedPublicListIDsTask,
            publicListProgressEntriesTask
        )

        let migrationResult = await migrationTask
        // Se la migrazione ha effettivamente spostato dati, i titleStati letti in
        // parallelo potrebbero essere pre-migrazione → rileggili una volta sola.
        let titleStates: [TitlePersonalState]
        if let migrationResult, !migrationResult.alreadyMigrated {
            titleStates = try await fetchTitleStates(userID: userID)
        } else {
            titleStates = fetchedTitleStates
        }

        let stateMap = Dictionary(uniqueKeysWithValues: titleStates.map { ($0.titleId, $0) })
        let publicListProgressMap = Dictionary(grouping: publicListProgressEntries, by: \.listId)

        let enrichedMemberLists = memberLists.map { list in
            hydrateListProgressCounts(
                list,
                using: stateMap,
                publicListProgressMap: publicListProgressMap,
                pinnedPublicListIDs: pinnedPublicListIDs
            )
        }
        let enrichedPublicLists = publicLists.map { list in
            hydrateListProgressCounts(
                list,
                using: stateMap,
                publicListProgressMap: publicListProgressMap,
                pinnedPublicListIDs: pinnedPublicListIDs
            )
        }

        let general = titleStates
            .filter(\.isInToWatchQueue)
            .sorted(by: sortPersonalStates)

        let rewatch = titleStates
            .filter(\.isInRewatch)
            .sorted(by: sortRewatchStates)

        let toRate = titleStates
            .filter(\.isAwaitingRating)
            .sorted(by: sortPersonalStates)

        let toResume = titleStates
            .filter(\.canResumeFromNewContent)
            .sorted(by: sortPersonalStates)

        // Da TUTTI i titleStates (non solo `generalWatchlist`), così cattura anche
        // il rewatch-in-corso: il server spegne `generalWatchlist` quando parte un
        // rewatch, ma `seriesStatus` resta `.inProgress` — la serie non deve sparire
        // da "in corso" solo perché è un rewatch.
        let inProgressSeries = titleStates
            .filter(\.isInProgressSeries)
            .sorted(by: sortPersonalStates)

        let defaultWatchlist = makeGeneralWatchlistSummary(
            userID: userID,
            titleStates: general
        )

        let myLists = [defaultWatchlist] + enrichedMemberLists
            .filter(\.isOwnedByCurrentUser)
            .sorted(by: sortLists)

        let sharedLists = enrichedMemberLists
            .filter { !$0.isOwnedByCurrentUser || $0.visibility == .shared }
            .sorted(by: sortLists)

        return WatchlistDashboard(
            generalWatchlist: general,
            rewatch: rewatch,
            toRate: toRate,
            toResume: toResume,
            inProgressSeries: inProgressSeries,
            myLists: myLists,
            sharedLists: sharedLists,
            publicLists: enrichedPublicLists.sorted(by: sortLists)
        )
    }

    func fetchEditableListSummaries(userID: String, limit: Int = 80) async throws -> [UserListSummary] {
        _ = try? await ensureUserMigration(userID: userID)

        let snapshot = try await db.collection("userLists")
            .whereField("memberUids", arrayContains: userID)
            .order(by: "updatedAt", descending: true)
            .limit(to: limit)
            .getDocuments()

        let summaries = try await buildEditableListSummaries(from: snapshot.documents, currentUserID: userID)
        return summaries
            .filter(\.canEdit)
            .sorted(by: sortLists)
    }

    func fetchTitleState(userID: String, title: Title) async throws -> TitlePersonalState {
        _ = try? await ensureUserMigration(userID: userID)

        let snapshot = try await titleStateRef(userID: userID, titleID: title.id).getDocument()
        if let parsed = snapshotToPersonalState(snapshot, titleLookup: [title.id: title]) {
            return parsed
        }
        return defaultPersonalState(for: title)
    }

    func updateGeneralWatchlist(
        userID: String,
        title: Title,
        isIncluded: Bool,
        source: String = "ios_title_detail"
    ) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "toggle_watchlist",
            source: source,
            extra: ["enabled": isIncluded]
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func updateRewatchIntent(
        userID: String,
        title: Title,
        isIncluded: Bool,
        source: String = "ios_title_detail_rewatch"
    ) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: isIncluded ? "set_rewatch_intent" : "clear_rewatch_intent",
            source: source
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func markMovieSeen(userID: String, title: Title) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "mark_movie_seen",
            source: "movie_seen"
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func markMovieUnseen(userID: String, title: Title) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "mark_movie_unseen",
            source: "movie_unseen"
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func markSeriesUnstarted(userID: String, title: Title) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "mark_series_unstarted",
            source: "series_unstarted"
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func acknowledgeNewContent(userID: String, title: Title) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "acknowledge_new_content",
            source: "ack_new_content"
        )
        return next
    }

    func detectNewSeasonsForUser(userID: String) async throws -> NewSeasonDetectionResult {
        let response = try await invokeCallable(name: "detectNewSeasonsForUser", payload: [:])
        let data = response.data as? [String: Any] ?? [:]
        let scanned = FirestoreValueReader.int(data, key: "scanned") ?? 0
        let rawDetected = data["detected"] as? [[String: Any]] ?? []
        let items: [NewSeasonDetectionItem] = rawDetected.compactMap { row in
            guard let titleId = FirestoreValueReader.string(row, key: "titleId"), !titleId.isEmpty else { return nil }
            return NewSeasonDetectionItem(
                titleId: titleId,
                titleName: FirestoreValueReader.string(row, key: "titleName") ?? "una serie",
                latestSeasonNumber: FirestoreValueReader.int(row, key: "latestSeasonNumber"),
                notified: FirestoreValueReader.bool(row, key: "notified") ?? false
            )
        }
        return NewSeasonDetectionResult(scanned: scanned, detected: items)
    }

    func markRatingDeferred(userID: String, title: Title) async throws -> TitlePersonalState {
        switch title.type {
        case .movie:
            return try await markMovieSeen(userID: userID, title: title)
        case .tv:
            return try await markSeriesCompleted(userID: userID, title: title)
        }
    }

    /// Convenience usata dal gate anti-spoiler: dato solo l'id del titolo
    /// (l'unico dato noto al renderer), risolve il `Title` e applica
    /// `mark_movie_seen` o `mark_series_completed` come "rating deferred".
    func markTitleCompletedByID(userID: String, titleID: String) async throws -> TitlePersonalState? {
        let trimmed = titleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let title = try await titleRepository.fetchTitle(id: trimmed) else { return nil }
        return try await markRatingDeferred(userID: userID, title: title)
    }

    func markSeriesEpisodeWatched(userID: String, title: Title) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "mark_series_episode",
            source: "series_episode"
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func markSeriesSeasonWatched(userID: String, title: Title) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "mark_series_season",
            source: "series_season"
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func markSeriesCompleted(userID: String, title: Title) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "mark_series_completed",
            source: "series_completed"
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func setSeriesProgress(
        userID: String,
        title: Title,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?,
        source: String
    ) async throws -> TitlePersonalState {
        let next = try await applyCanonicalTitleStateAction(
            userID: userID,
            title: title,
            action: "set_series_progress",
            source: source,
            extra: [
                "episodesWatchedCount": watchedEpisodesCount,
                "seasonsCompletedCount": completedSeasonsCount,
                "lastWatchedSeasonNumber": lastWatchedSeasonNumber as Any,
                "lastWatchedEpisodeNumber": lastWatchedEpisodeNumber as Any
            ]
        )
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return next
    }

    func syncPersonalStateAfterRating(userID: String, title: Title, ratingValue: Double) async throws -> TitlePersonalState {
        for attempt in 0 ..< 4 {
            let state = try await fetchTitleState(userID: userID, title: title)
            if state.hasTitleRating, abs((state.ratingValue ?? ratingValue) - ratingValue) < 0.001 {
                try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
                return state
            }
            if attempt < 3 {
                try await Task.sleep(nanoseconds: 250_000_000)
            }
        }

        let fallback = try await fetchTitleState(userID: userID, title: title)
        try await syncListProgressAfterTitleChange(userID: userID, titleID: title.id)
        return fallback
    }

    // MARK: - Lists

    func fetchListDetail(userID: String, listID: String) async throws -> UserListDetail {
        if listID == Self.generalWatchlistListID {
            return try await fetchGeneralWatchlistDetail(userID: userID)
        }

        _ = try? await recomputeListProgress(listID: listID)

        let rootSnapshot = try? await db.collection("userLists").document(listID).getDocument()
        let listSnapshot: DocumentSnapshot
        let canReadPrivateSubdocs: Bool
        if let rootSnapshot, rootSnapshot.exists {
            listSnapshot = rootSnapshot
            canReadPrivateSubdocs = true
        } else {
            let publicSnapshot = try await db.collection("publicUserLists").document(listID).getDocument()
            guard publicSnapshot.exists else {
                throw NSError(domain: "TwoWatch", code: 404, userInfo: [NSLocalizedDescriptionKey: String(localized: "Lista non trovata.")])
            }
            listSnapshot = publicSnapshot
            canReadPrivateSubdocs = false
        }
        let listData = listSnapshot.data() ?? [:]
        let isPublicList = UserListVisibility(rawValue: FirestoreValueReader.string(listData, key: "visibility") ?? "") == .public

        let titleStates = try await fetchTitleStates(userID: userID)
        let titleStateMap = Dictionary(uniqueKeysWithValues: titleStates.map { ($0.titleId, $0) })

        let itemSnapshots = try await db.collection("userLists")
            .document(listID)
            .collection("items")
            .order(by: "orderIndex")
            .getDocuments()

        let itemRows = itemSnapshots.documents.map { ($0.documentID, $0.data()) }
        let titleIDs = itemRows.map(\.0)
        let titles = try await titleRepository.listTitles(ids: titleIDs)
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })

        let memberDocuments: [QueryDocumentSnapshot]
        let progressDocuments: [QueryDocumentSnapshot]
        if canReadPrivateSubdocs {
            memberDocuments = try await db.collection("userLists")
                .document(listID)
                .collection("members")
                .getDocuments()
                .documents
            progressDocuments = try await db.collection("userLists")
                .document(listID)
                .collection("progress")
                .getDocuments()
                .documents
        } else {
            memberDocuments = []
            progressDocuments = []
        }

        let publicProgressEntries = isPublicList
            ? try await fetchPublicListProgressEntries(userID: userID, listID: listID)
            : []
        let publicProgressMap = Dictionary(publicProgressEntries.map { ($0.titleId, $0) }, uniquingKeysWith: { first, _ in first })
        let pinnedPublicListIDs: Set<String> = isPublicList
            ? try await fetchPinnedPublicListIDs(userID: userID)
            : []

        let userIDs = Set(memberDocuments.map(\.documentID) + progressDocuments.map(\.documentID))
        let users = try await userRepository.listUsers(ids: Array(userIDs))
        let userMap = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })

        guard let list = snapshotToUserListSummary(
            listSnapshot,
            currentUserID: userID,
            titleLookup: titleMap,
            personalStates: titleStateMap,
            publicProgressEntries: publicProgressEntries,
            pinnedPublicListIDs: pinnedPublicListIDs
        ) else {
            throw NSError(domain: "TwoWatch", code: 500, userInfo: [NSLocalizedDescriptionKey: String(localized: "Impossibile leggere la lista.")])
        }

        let items = itemRows.map { row in
            UserListItem(
                id: row.0,
                titleId: row.0,
                orderIndex: FirestoreValueReader.int(row.1, key: "orderIndex") ?? 0,
                addedByUid: FirestoreValueReader.string(row.1, key: "addedByUid"),
                note: FirestoreValueReader.string(row.1, key: "note"),
                addedAt: FirestoreValueReader.date(row.1["addedAt"]),
                updatedAt: FirestoreValueReader.date(row.1["updatedAt"]),
                title: titleMap[row.0],
                personalState: isPublicList ? nil : titleStateMap[row.0],
                publicProgress: isPublicList
                    ? (publicProgressMap[row.0] ?? titleMap[row.0].map { defaultPublicListProgress(for: $0, listID: listID) })
                    : nil
            )
        }
        .sorted { lhs, rhs in
            if lhs.orderIndex != rhs.orderIndex { return lhs.orderIndex < rhs.orderIndex }
            return lhs.titleId < rhs.titleId
        }

        let members = memberDocuments.map { document in
            let data = document.data()
            let user = userMap[document.documentID]
            return UserListMember(
                id: document.documentID,
                displayName: user?.displayName ?? FirestoreValueReader.string(data, key: "displayName") ?? "User",
                photoURL: user?.photoURL ?? user?.avatarURL,
                role: UserListMemberRole(rawValue: FirestoreValueReader.string(data, key: "role") ?? "") ?? .viewer,
                joinedAt: FirestoreValueReader.date(data["joinedAt"])
            )
        }
        .sorted { lhs, rhs in
            if lhs.role == .owner && rhs.role != .owner { return true }
            if rhs.role == .owner && lhs.role != .owner { return false }
            return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
        }

        let progress: [UserListProgressSummary]
        if isPublicList {
            progress = []
        } else {
            progress = progressDocuments.map { document in
                let data = document.data()
                let user = userMap[document.documentID]
                return UserListProgressSummary(
                    id: document.documentID,
                    uid: document.documentID,
                    displayName: user?.displayName ?? FirestoreValueReader.string(data, key: "displayName") ?? "User",
                    photoURL: user?.photoURL ?? user?.avatarURL,
                    completedCount: FirestoreValueReader.int(data, key: "completedCount") ?? 0,
                    totalCount: FirestoreValueReader.int(data, key: "totalCount") ?? 0,
                    percentComplete: FirestoreValueReader.double(data, key: "percentComplete") ?? 0,
                    lastCompletedTitleId: FirestoreValueReader.string(data, key: "lastCompletedTitleId"),
                    lastCompletedTitleName: FirestoreValueReader.string(data, key: "lastCompletedTitleName"),
                    lastCompletedAt: FirestoreValueReader.date(data["lastCompletedAt"]),
                    inProgressTitleId: FirestoreValueReader.string(data, key: "inProgressTitleId"),
                    inProgressTitleName: FirestoreValueReader.string(data, key: "inProgressTitleName"),
                    updatedAt: FirestoreValueReader.date(data["updatedAt"])
                )
            }
            .sorted { lhs, rhs in
                if lhs.percentComplete != rhs.percentComplete { return lhs.percentComplete > rhs.percentComplete }
                return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
            }
        }

        return UserListDetail(list: list, members: members, items: items, progress: progress)
    }

    func createList(
        userID: String,
        owner: AppUser?,
        draft: UserListEditorDraft,
        collaborators: [AppUser]
    ) async throws -> UserListDetail {
        let listID = db.collection("userLists").document().documentID
        try await upsertList(userID: userID, owner: owner, listID: listID, previousList: nil, draft: draft, collaborators: collaborators)
        return try await fetchListDetail(userID: userID, listID: listID)
    }

    func updateList(
        userID: String,
        listID: String,
        draft: UserListEditorDraft,
        collaborators: [AppUser]
    ) async throws -> UserListDetail {
        let snapshot = try await db.collection("userLists").document(listID).getDocument()
        guard snapshot.exists else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [NSLocalizedDescriptionKey: String(localized: "Lista non trovata.")])
        }
        let previous = snapshot.data() ?? [:]
        let ownerUserID = FirestoreValueReader.string(previous, key: "ownerUid") ?? userID
        let owner = try? await userRepository.fetchUser(uid: ownerUserID)
        try await upsertList(userID: userID, owner: owner, listID: listID, previousList: previous, draft: draft, collaborators: collaborators)
        return try await fetchListDetail(userID: userID, listID: listID)
    }

    func deleteList(userID: String, listID: String) async throws {
        try await db.collection("userLists").document(listID).delete()
    }

    func addTitleToList(userID: String, listID: String, title: Title) async throws {
        let snapshot = try await db.collection("userLists").document(listID).getDocument()
        guard snapshot.exists else { return }
        let data = snapshot.data() ?? [:]
        var itemIDs = FirestoreValueReader.stringArray(data["itemTitleIds"])
        guard !itemIDs.contains(title.id) else { return }
        itemIDs.append(title.id)

        let persistedCover = coverFields(from: data)
        let nextDraft = UserListEditorDraft(
            title: FirestoreValueReader.string(data, key: "title") ?? "",
            description: FirestoreValueReader.string(data, key: "description") ?? "",
            visibility: UserListVisibility(rawValue: FirestoreValueReader.string(data, key: "visibility") ?? "") ?? .private,
            kind: UserListKind(rawValue: FirestoreValueReader.string(data, key: "kind") ?? "") ?? .collection,
            coverImageURL: persistedCover.imageURL,
            coverStoragePath: persistedCover.storagePath,
            collaboratorIDs: FirestoreValueReader.stringArray(data["editorUids"]),
            selectedTitleIDs: itemIDs,
            naturalPrompt: ""
        )
        let collaborators = try await userRepository.listUsers(ids: nextDraft.collaboratorIDs)
        try await upsertList(
            userID: userID,
            owner: try await userRepository.fetchUser(uid: FirestoreValueReader.string(data, key: "ownerUid") ?? userID),
            listID: listID,
            previousList: data,
            draft: nextDraft,
            collaborators: collaborators
        )
        try await recomputeListProgress(listID: listID)
    }

    func removeTitleFromList(userID: String, listID: String, titleID: String) async throws {
        let snapshot = try await db.collection("userLists").document(listID).getDocument()
        guard snapshot.exists else { return }
        let data = snapshot.data() ?? [:]
        let itemIDs = FirestoreValueReader.stringArray(data["itemTitleIds"]).filter { $0 != titleID }

        let persistedCover = coverFields(from: data)
        let nextDraft = UserListEditorDraft(
            title: FirestoreValueReader.string(data, key: "title") ?? "",
            description: FirestoreValueReader.string(data, key: "description") ?? "",
            visibility: UserListVisibility(rawValue: FirestoreValueReader.string(data, key: "visibility") ?? "") ?? .private,
            kind: UserListKind(rawValue: FirestoreValueReader.string(data, key: "kind") ?? "") ?? .collection,
            coverImageURL: persistedCover.imageURL,
            coverStoragePath: persistedCover.storagePath,
            collaboratorIDs: FirestoreValueReader.stringArray(data["editorUids"]),
            selectedTitleIDs: itemIDs,
            naturalPrompt: ""
        )
        let collaborators = try await userRepository.listUsers(ids: nextDraft.collaboratorIDs)
        try await upsertList(
            userID: userID,
            owner: try await userRepository.fetchUser(uid: FirestoreValueReader.string(data, key: "ownerUid") ?? userID),
            listID: listID,
            previousList: data,
            draft: nextDraft,
            collaborators: collaborators
        )
        try await recomputeListProgress(listID: listID)
    }

    func reorderListItems(userID: String, listID: String, itemIDs: [String]) async throws {
        let listRef = db.collection("userLists").document(listID)
        let batch = db.batch()
        batch.setData([
            "updatedAt": FieldValue.serverTimestamp()
        ], forDocument: listRef, merge: true)

        for (index, itemID) in itemIDs.enumerated() {
            batch.setData([
                "titleId": itemID,
                "orderIndex": (index + 1) * 1_000,
                "updatedAt": FieldValue.serverTimestamp()
            ], forDocument: listRef.collection("items").document(itemID), merge: true)
        }

        try await batch.commit()
        try await recomputeListProgress(listID: listID)
    }

    func duplicateList(userID: String, sourceListID: String, owner: AppUser?) async throws -> UserListDetail {
        let snapshot = try await db.collection("userLists").document(sourceListID).getDocument()
        guard snapshot.exists else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [NSLocalizedDescriptionKey: String(localized: "Lista sorgente non trovata.")])
        }
        let data = snapshot.data() ?? [:]
        let originalTitle = FirestoreValueReader.string(data, key: "title") ?? "Lista"
        let draft = UserListEditorDraft(
            title: "\(originalTitle) Copy",
            description: FirestoreValueReader.string(data, key: "description") ?? "",
            visibility: .private,
            kind: UserListKind(rawValue: FirestoreValueReader.string(data, key: "kind") ?? "") ?? .collection,
            coverImageURL: nil,
            coverStoragePath: nil,
            collaboratorIDs: [],
            selectedTitleIDs: FirestoreValueReader.stringArray(data["itemTitleIds"]),
            naturalPrompt: ""
        )
        return try await createList(userID: userID, owner: owner, draft: draft, collaborators: [])
    }

    func uploadListCover(userID: String, listID: String, image: UIImage) async throws {
        let prepared = image.prepareForListCoverUpload()
        guard let data = prepared.jpegData(compressionQuality: 0.86) else {
            throw NSError(domain: "TwoWatch", code: 500, userInfo: [NSLocalizedDescriptionKey: String(localized: "Impossibile preparare la cover.")])
        }

        _ = userID
        _ = try await invokeCallable(name: "uploadUserListCover", payload: [
            "listId": listID,
            "imageBase64": data.base64EncodedString()
        ])
    }

    func buildNaturalListPreview(_ phrase: String) async throws -> NaturalListPreview {
        let normalized = SearchNormalizer.normalize(phrase)
        guard !normalized.isEmpty else {
            return NaturalListPreview(suggestedName: "Nuova lista", suggestedDescription: nil, suggestedKind: .collection, candidates: [])
        }

        let suggestedKind: UserListKind = isOrderedPrompt(normalized) ? .orderedPath : .collection
        let seed = naturalPromptSeed(from: normalized)
        var results = try await titleRepository.searchTitlesForListBuilder(seed, limit: 36)

        if normalized.contains("film") {
            results = results.filter { $0.type == .movie }
        } else if normalized.contains("serie") || normalized.contains("show") {
            results = results.filter { $0.type == .tv }
        }

        let scored = results.map { title -> (Title, String, Int) in
            let reason = naturalReason(for: title, prompt: normalized)
            let score = naturalCandidateScore(for: title, prompt: normalized)
            return (title, reason, score)
        }
        .filter { $0.2 > 0 }
        .sorted { lhs, rhs in
            if lhs.2 != rhs.2 { return lhs.2 > rhs.2 }
            if lhs.0.ratingCount != rhs.0.ratingCount { return lhs.0.ratingCount > rhs.0.ratingCount }
            return lhs.0.nameLower < rhs.0.nameLower
        }

        let candidates = scored.prefix(18).map { row in
            NaturalListCandidate(id: row.0.id, title: row.0, reason: row.1)
        }

        let suggestedName = suggestedListName(for: phrase, candidates: candidates)
        let description = normalized.contains("cronologic")
            ? "Bozza generata da input naturale. Conferma i titoli e riordinali se serve."
            : "Bozza generata da input naturale. Rivedi i titoli prima di confermare."

        return NaturalListPreview(
            suggestedName: suggestedName,
            suggestedDescription: description,
            suggestedKind: suggestedKind,
            candidates: candidates
        )
    }

    func searchCollaborators(query: String, userID: String, excluding excludedIDs: [String]) async throws -> [AppUser] {
        let users = try await userRepository.searchUsers(prefix: query)
        let excluded = Set(excludedIDs + [userID])
        return users.filter { !excluded.contains($0.id) }
    }

    // MARK: - Admin

    func runAdminTitleBackfill(limit: Int, startAfterID: String?, forceAll: Bool) async throws -> AdminBackfillResult {
        let response = try await invokeCallable(name: "adminBackfillTitleMetadata", payload: [
            "limit": limit,
            "startAfterId": startAfterID ?? "",
            "forceAll": forceAll
        ])
        let data = response.data as? [String: Any] ?? [:]

        return AdminBackfillResult(
            scannedCount: FirestoreValueReader.int(data, key: "scannedCount") ?? 0,
            updatedCount: FirestoreValueReader.int(data, key: "updatedCount") ?? 0,
            skippedCount: FirestoreValueReader.int(data, key: "skippedCount") ?? 0,
            nextCursor: FirestoreValueReader.string(data, key: "nextCursor"),
            message: FirestoreValueReader.string(data, key: "message")
        )
    }

    // MARK: - Legacy Compatibility

    func isInWatchlist(userID: String, titleID: String) async throws -> Bool {
        let snapshot = try await titleStateRef(userID: userID, titleID: titleID).getDocument()
        if snapshot.exists, let data = snapshot.data() {
            let generalWatchlist = FirestoreValueReader.bool(data, key: "generalWatchlist") ?? false
            let rewatchIntent = FirestoreValueReader.bool(data, key: "rewatchIntent") ?? false
            let stateValue = FirestoreValueReader.string(data, key: "state")
                ?? FirestoreValueReader.string(data, key: "status")
                ?? ""
            let hasStartedWatching = !stateValue.isEmpty
                && stateValue != MoviePersonalStatus.unseen.rawValue
                && stateValue != SeriesPersonalStatus.notStarted.rawValue
            return (generalWatchlist && !hasStartedWatching) || (rewatchIntent && hasStartedWatching)
        }
        let legacy = try await db.collection("users").document(userID).collection("watchlist").document(titleID).getDocument()
        return legacy.exists
    }

    func toggleWatchlist(userID: String, titleID: String, source: String = "ios_title_detail") async throws -> Bool {
        guard let title = try await titleRepository.fetchTitle(id: titleID) else {
            let legacyRef = db.collection("users").document(userID).collection("watchlist").document(titleID)
            let snapshot = try await legacyRef.getDocument()
            if snapshot.exists {
                try await legacyRef.delete()
                return false
            }
            try await legacyRef.setData([
                "titleId": titleID,
                "addedAt": FieldValue.serverTimestamp(),
                "watchState": "to_watch",
                "addedFrom": source,
                "updatedAt": FieldValue.serverTimestamp()
            ], merge: true)
            return true
        }

        let state = try await fetchTitleState(userID: userID, title: title)
        if state.isInRewatch {
            let next = try await updateRewatchIntent(
                userID: userID,
                title: title,
                isIncluded: false,
                source: source
            )
            return next.isInToWatchQueue || next.isInRewatch
        }

        if state.hasStartedWatching {
            let next = try await updateRewatchIntent(
                userID: userID,
                title: title,
                isIncluded: true,
                source: source
            )
            return next.isInToWatchQueue || next.isInRewatch
        }

        let next = try await updateGeneralWatchlist(
            userID: userID,
            title: title,
            isIncluded: !state.generalWatchlist,
            source: source
        )
        return next.isInToWatchQueue || next.isInRewatch
    }

    func fetchWatchlist(userID: String, limit: Int = 200) async throws -> [WatchlistEntry] {
        let dashboard = try await fetchWatchlistDashboard(userID: userID)
        return Array(dashboard.generalWatchlist.prefix(limit)).map { state in
            WatchlistEntry(
                id: state.id,
                titleId: state.titleId,
                watchState: state.statusValue,
                priority: "normal",
                addedAt: state.createdAt,
                title: state.title
            )
        }
    }

    func removeEntry(userID: String, entryID: String) async throws {
        if let title = try await titleRepository.fetchTitle(id: entryID) {
            _ = try await updateGeneralWatchlist(userID: userID, title: title, isIncluded: false)
            return
        }
        try await db.collection("users").document(userID).collection("watchlist").document(entryID).delete()
    }

    func togglePublicListPin(userID: String, listID: String, isPinned: Bool) async throws {
        let ref = savedListRef(userID: userID, listID: listID)
        if isPinned {
            try await ref.setData([
                "listId": listID,
                "isPinned": true,
                "pinnedAt": FieldValue.serverTimestamp(),
                "updatedAt": FieldValue.serverTimestamp()
            ], merge: true)
        } else {
            try await ref.delete()
        }
    }

    func setPublicListMovieSeen(
        userID: String,
        listID: String,
        title: Title,
        isSeen: Bool
    ) async throws -> PublicListItemProgress {
        let nextState = PublicListItemProgress(
            listId: listID,
            titleId: title.id,
            mediaType: .movie,
            status: isSeen ? .completed : .notStarted,
            seriesProgress: nil,
            completedAt: isSeen ? .now : nil,
            updatedAt: .now,
            lastInteractionAt: .now,
            watchMinutesContribution: isSeen ? estimatedWatchMinutes(for: title) : 0
        )

        try await persistPublicListProgress(userID: userID, state: nextState)
        return nextState
    }

    func setPublicListSeriesProgress(
        userID: String,
        listID: String,
        title: Title,
        watchedEpisodesCount: Int,
        completedSeasonsCount: Int,
        lastWatchedSeasonNumber: Int?,
        lastWatchedEpisodeNumber: Int?
    ) async throws -> PublicListItemProgress {
        let current = try await fetchPublicListProgress(userID: userID, listID: listID, title: title)
        guard title.type == .tv else { return current }

        let currentProgress = current.seriesProgress ?? defaultSeriesProgress(for: title)
        let totalEpisodes = currentProgress.totalEpisodeCount ?? estimateTotalEpisodes(for: title)
        let totalSeasons = currentProgress.totalSeasonCount ?? title.metadata.seasonsCount
        let nextEpisodeCount = max(0, min(totalEpisodes ?? watchedEpisodesCount, watchedEpisodesCount))
        let nextSeasonCount = max(0, min(totalSeasons ?? completedSeasonsCount, completedSeasonsCount))
        let hasProgress = nextEpisodeCount > 0 || nextSeasonCount > 0
        let percent = progressPercent(
            completedEpisodes: nextEpisodeCount,
            totalEpisodes: totalEpisodes,
            completedSeasons: nextSeasonCount,
            totalSeasons: totalSeasons
        )
        let isCompleted = (totalEpisodes != nil && nextEpisodeCount >= (totalEpisodes ?? 0) && (totalEpisodes ?? 0) > 0)
            || (totalSeasons != nil && nextSeasonCount >= (totalSeasons ?? 0) && (totalSeasons ?? 0) > 0)

        let resolvedSeasonNumber = hasProgress ? lastWatchedSeasonNumber : nil
        let resolvedEpisodeNumber = hasProgress ? lastWatchedEpisodeNumber : nil
        let nextProgress = TitleSeriesProgress(
            episodesWatchedCount: nextEpisodeCount,
            seasonsCompletedCount: nextSeasonCount,
            totalEpisodeCount: totalEpisodes,
            totalSeasonCount: totalSeasons,
            lastWatchedEpisodeId: episodeIdentifier(season: resolvedSeasonNumber, episode: resolvedEpisodeNumber),
            lastWatchedEpisodeName: episodeName(season: resolvedSeasonNumber, episode: resolvedEpisodeNumber),
            lastWatchedSeasonNumber: resolvedSeasonNumber,
            lastWatchedEpisodeNumber: resolvedEpisodeNumber,
            lastWatchedAt: hasProgress ? .now : nil,
            percentComplete: hasProgress ? percent : 0
        )

        let nextState = PublicListItemProgress(
            listId: listID,
            titleId: title.id,
            mediaType: .tv,
            status: isCompleted ? .completed : (hasProgress ? .inProgress : .notStarted),
            seriesProgress: nextProgress,
            completedAt: isCompleted ? (current.completedAt ?? .now) : nil,
            updatedAt: .now,
            lastInteractionAt: .now,
            watchMinutesContribution: isCompleted ? estimatedWatchMinutes(for: title) : 0
        )

        try await persistPublicListProgress(userID: userID, state: nextState)
        return nextState
    }

    // MARK: - Profile Legacy

    func fetchLibrary(userID: String, limit: Int = 400) async throws -> [LibraryEntry] {
        // Cap: le librerie grandi (import TV Time, migliaia di doc) scaricavano
        // tutto a ogni apertura profilo. Ordina per `updatedAt` desc → il limit
        // taglia i titoli meno recenti. `updatedAt` è sempre presente sui doc
        // library: lo scrivono sia la proiezione server (`buildLegacyLibraryProjection`,
        // chiave sempre inclusa, al peggio null → ordinato per ultimo) sia il
        // client (`persistPersonalState`, serverTimestamp). `createdAt` invece
        // NON è garantito (il client lo omette quando il titleState esiste già).
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("library")
            .order(by: "updatedAt", descending: true)
            .limit(to: limit)
            .getDocuments()

        let rawEntries: [(id: String, data: [String: Any])] = snapshot.documents.map {
            ($0.documentID, $0.data())
        }
        let titleIDs = rawEntries.compactMap { entry in
            let storedTitleID = FirestoreValueReader.string(entry.data, key: "titleId")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return storedTitleID.isEmpty ? entry.id : storedTitleID
        }
        let titles = try await titleRepository.listTitles(ids: titleIDs)
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })

        return rawEntries.compactMap { entry in
            let storedTitleID = FirestoreValueReader.string(entry.data, key: "titleId")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let titleID = storedTitleID.isEmpty ? entry.id : storedTitleID
            guard !titleID.isEmpty else { return nil }

            return LibraryEntry(
                id: entry.id,
                titleId: titleID,
                lastRating: FirestoreValueReader.double(entry.data, key: "lastRating"),
                ratedAt: FirestoreValueReader.date(entry.data["ratedAt"]),
                seenAt: FirestoreValueReader.date(entry.data["seenAt"]),
                updatedAt: FirestoreValueReader.date(entry.data["updatedAt"]),
                createdAt: FirestoreValueReader.date(entry.data["createdAt"]),
                state: FirestoreValueReader.string(entry.data, key: "state"),
                completedCount: FirestoreValueReader.int(entry.data, key: "completedCount") ?? 0,
                title: titleMap[titleID]
            )
        }
    }

    /// Own-profile activity summary. Reads the cached `stats` counters on the user
    /// doc — kept fresh server-side by the incremental titleStates / listProgressEntries
    /// Cloud Functions triggers — instead of rescanning the whole library on every open.
    /// `preloadedUser`: evita una seconda lettura di `users/{uid}` quando il
    /// chiamante ha già il doc (apertura profilo).
    func fetchProfileActivitySummary(userID: String, preloadedUser: AppUser? = nil) async throws -> ProfileActivitySummary {
        let stats: UserStats?
        if let preloadedUser {
            stats = preloadedUser.stats
        } else {
            stats = try await userRepository.fetchUser(uid: userID)?.stats
        }
        return ProfileActivitySummary(
            ratedTitlesCount: stats?.ratingsCount ?? 0,
            watchedTitlesCount: stats?.watchedCount ?? 0,
            totalWatchMinutes: stats?.totalWatchMinutes ?? 0,
            derivedRatingsCount: stats?.derivedRatingsCount ?? 0,
            byCategory: stats?.byCategory ?? [:]
        )
    }

    func fetchPublicProfileActivitySummary(userID: String) async throws -> ProfileActivitySummary {
        let response = try await invokeCallable(name: "getPublicProfileActivitySummary", payload: [
            "userId": userID,
        ])
        let data = response.data as? [String: Any] ?? [:]

        return ProfileActivitySummary(
            ratedTitlesCount: FirestoreValueReader.int(data, key: "ratedTitlesCount") ?? 0,
            watchedTitlesCount: FirestoreValueReader.int(data, key: "watchedTitlesCount") ?? 0,
            totalWatchMinutes: FirestoreValueReader.int(data, key: "totalWatchMinutes") ?? 0,
            byCategory: CategoryActivity.breakdown(from: data["byCategory"])
        )
    }

    /// Avanzamento per serie di un profilo (anche altrui) — solo le serie che
    /// l'utente ha effettivamente iniziato o finito sono presenti. Sorgente:
    /// callable `getPublicProfileSeriesProgress` → `{ ok, progress: { <titleId>: {...} } }`.
    /// Tollerante a payload mancanti/malformati: ritorna mappa vuota.
    func fetchPublicProfileSeriesProgress(userID: String) async throws -> [String: TitleSeriesProgress] {
        let response = try await invokeCallable(name: "getPublicProfileSeriesProgress", payload: [
            "userId": userID,
        ])
        let data = response.data as? [String: Any] ?? [:]
        let progressMap = FirestoreValueReader.map(data["progress"])

        var result: [String: TitleSeriesProgress] = [:]
        for (titleID, value) in progressMap {
            guard !titleID.isEmpty, let entry = value as? [String: Any] else { continue }
            result[titleID] = TitleSeriesProgress.fromMap(entry)
        }
        return result
    }

    /// Spettatori (amici + seguiti del viewer) che stanno guardando una serie,
    /// con il loro avanzamento. Pre-ordinati server-side (in corso prima),
    /// cap 60. Sorgente: callable `getTitleWatchersProgress` →
    /// `{ ok, watchers: [ {...} ] }`. Tollerante a payload mancanti: ritorna [].
    func fetchTitleWatchersProgress(titleID: String) async throws -> [TitleWatcher] {
        let response = try await invokeCallable(name: "getTitleWatchersProgress", payload: [
            "titleId": titleID,
        ])
        let data = response.data as? [String: Any] ?? [:]
        let rawWatchers = (data["watchers"] as? [Any]) ?? []

        return rawWatchers.compactMap { element -> TitleWatcher? in
            guard let map = element as? [String: Any],
                  let uid = FirestoreValueReader.string(map, key: "uid"),
                  !uid.isEmpty
            else { return nil }

            let progressMap = map["seriesProgress"]
            let progress: TitleSeriesProgress?
            if let progressDict = progressMap as? [String: Any] {
                progress = TitleSeriesProgress.fromMap(progressDict)
            } else {
                progress = nil
            }

            return TitleWatcher(
                uid: uid,
                displayName: FirestoreValueReader.string(map, key: "displayName") ?? "Utente",
                photoURL: FirestoreValueReader.string(map, key: "photoURL"),
                isSynthetic: FirestoreValueReader.bool(map, key: "isSynthetic") ?? false,
                state: FirestoreValueReader.string(map, key: "state") ?? "",
                progress: progress
            )
        }
    }

    /// Conta le review dell'utente (rating con `reviewText` non vuoto). Usa il
    /// counter cached `users/{uid}.stats.reviewsCount` (mantenuto server-side
    /// dai trigger Cloud Functions). Se manca o vale 0 fa fallback a un count
    /// aggregation server-side, evitando di scaricare l'intera collection
    /// `ratings`.
    /// `preloadedUser`: evita una seconda lettura di `users/{uid}` quando il
    /// chiamante ha già il doc (apertura profilo).
    /// Titoli votati dall'utente.
    ///
    /// Fonte: `stats.ratingsCount`, mantenuto server-side sui titleStates e
    /// riconciliato ogni settimana — conta i TITOLI votati, non i doc `ratings`.
    /// Contare i doc (comportamento precedente) gonfiava il numero quando un
    /// titolo veniva accorpato e restava un rating con il vecchio id (4 casi in
    /// prod al 2026-08-05). `stats.reviewsCount` invece non lo aggiorna
    /// nessuno: nasce 0 e resta 0, non va usato come fonte.
    func fetchReviewCount(userID: String, preloadedUser: AppUser? = nil) async throws -> Int {
        let cachedCount: Int
        if let preloadedUser {
            cachedCount = preloadedUser.stats.ratingsCount
        } else {
            cachedCount = try await userRepository.fetchUser(uid: userID)?.stats.ratingsCount ?? 0
        }
        if cachedCount > 0 {
            return cachedCount
        }

        let aggregate = try await db.collection("ratings")
            .whereField("uid", isEqualTo: userID)
            .whereField("level", isEqualTo: "title")
            .count
            .getAggregation(source: .server)

        return aggregate.count.intValue
    }

    /// Review dell'utente (rating con `reviewText` non vuoto), su qualunque
    /// livello (title/season/episode).
    ///
    /// FIX 2026-07: la query filtrava anche `level=="title"` + ordinava
    /// server-side per `updatedAt desc`, ma l'unico indice composito esistente
    /// è (uid, level) — 2 uguaglianze + orderBy su un terzo campo richiede
    /// (uid, level, updatedAt), che non esiste → `FAILED_PRECONDITION`
    /// silenziosamente ingoiato a monte, risultato sempre vuoto. Ora filtra
    /// solo su `uid` (indice automatico a singolo campo, nessun composito
    /// necessario), cappa la query, e fa filtro reviewText + sort updatedAt
    /// client-side. Include anche le review a livello stagione/episodio.
    /// Nota: senza orderBy server-side non c'è cursore di paginazione
    /// affidabile oltre `limit` — accettabile finché il volume di review per
    /// utente resta ben sotto il cap.
    func fetchProfileReviewsPage(
        userID: String,
        limit: Int = 300
    ) async throws -> (reviews: [ProfileReviewEntry], next: DocumentSnapshot?) {
        let snapshot = try await db.collection("ratings")
            .whereField("uid", isEqualTo: userID)
            .limit(to: limit)
            .getDocuments()

        let rawEntries: [(id: String, data: [String: Any])] = snapshot.documents.compactMap { document in
            let reviewText = (FirestoreValueReader.string(document.data(), key: "reviewText") ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard reviewText.isEmpty == false else { return nil }
            return (document.documentID, document.data())
        }

        let titleIDs = rawEntries.compactMap { FirestoreValueReader.string($0.data, key: "titleId") }
        let titles = try await titleRepository.listTitles(ids: titleIDs)
        let titleMap = Dictionary(titles.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        let entries = rawEntries.compactMap { entry -> ProfileReviewEntry? in
            guard let titleID = FirestoreValueReader.string(entry.data, key: "titleId"),
                  let rating = FirestoreValueReader.double(entry.data, key: "rating")
            else {
                return nil
            }

            let reviewText = (FirestoreValueReader.string(entry.data, key: "reviewText") ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            return ProfileReviewEntry(
                id: entry.id,
                titleId: titleID,
                rating: rating,
                reviewText: reviewText,
                updatedAt: FirestoreValueReader.date(entry.data["updatedAt"]),
                title: titleMap[titleID],
                level: FirestoreValueReader.string(entry.data, key: "level") ?? "title",
                season: FirestoreValueReader.int(entry.data, key: "season"),
                episode: FirestoreValueReader.int(entry.data, key: "episode")
            )
        }
        .sorted { $0.sortDate > $1.sortDate }

        return (entries, nil)
    }

    /// Backward-compat thin wrapper for call sites that still want a single array.
    /// Cap 300 review. Vedi `fetchProfileReviewsPage` per i dettagli della fix.
    func fetchProfileReviews(userID: String) async throws -> [ProfileReviewEntry] {
        try await fetchProfileReviewsPage(userID: userID).reviews
    }

    /// Post pubblici dell'utente (tab Community/Attività del profilo). Nota:
    /// questo metodo vive qui (non in `PostsRepository`) perché la ownership
    /// dei file di questo task era ristretta ai repository Title/User/Watchlist
    /// + ai model — spostarlo nel repo dei post è un follow-up naturale se si
    /// vuole consolidare tutta la logica `posts` in un unico posto.
    ///
    /// Query `where authorUid==userID && visibility=="public"` `order(by:
    /// createdAt desc)`: richiede l'indice composito `posts(authorUid,
    /// visibility, createdAt)` — già presente in `firestore.indexes.json`
    /// (aggiunto lato web). Tollerante a `FAILED_PRECONDITION` (indice non
    /// ancora propagato) o qualunque altro errore: ritorna `[]` invece di far
    /// fallire l'intero tab (che deve comunque mostrare review + emozioni).
    func fetchPublicPostsByAuthor(userID: String, limit: Int = 50) async throws -> [AppPost] {
        let trimmedUserID = userID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUserID.isEmpty else { return [] }

        let snapshot: QuerySnapshot
        do {
            snapshot = try await db.collection("posts")
                .whereField("authorUid", isEqualTo: trimmedUserID)
                .whereField("visibility", isEqualTo: PostVisibility.public.rawValue)
                .order(by: "createdAt", descending: true)
                .limit(to: limit)
                .getDocuments()
        } catch {
            return []
        }

        guard !snapshot.documents.isEmpty else { return [] }

        let author = try? await userRepository.fetchUser(uid: trimmedUserID)
        let authorSummary = UserSummary(
            id: trimmedUserID,
            displayName: author?.displayName ?? "User",
            photoURL: author?.photoURL
        )

        let rawEntries: [(id: String, data: [String: Any])] = snapshot.documents.map { ($0.documentID, $0.data()) }
        let taggedTitleIDsByDoc: [[String]] = rawEntries.map { _, data in
            TaggedTextFormatter.taggedTitleIDs(in: [
                FirestoreValueReader.string(data, key: "reviewText"),
                FirestoreValueReader.string(data, key: "text")
            ])
        }

        var allTitleIDs: [String] = []
        for (index, entry) in rawEntries.enumerated() {
            if let titleID = FirestoreValueReader.string(entry.data, key: "titleId") {
                allTitleIDs.append(titleID)
            }
            allTitleIDs.append(contentsOf: taggedTitleIDsByDoc[index])
        }
        let titles = try await titleRepository.listTitles(ids: allTitleIDs)
        let titleMap = Dictionary(titles.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        return rawEntries.enumerated().map { index, entry -> AppPost in
            let (id, data) = entry
            let titleID = FirestoreValueReader.string(data, key: "titleId")
            let taggedTitleIDs = taggedTitleIDsByDoc[index]
            let resolvedTaggedTitles = !taggedTitleIDs.isEmpty
                ? taggedTitleIDs.compactMap { titleMap[$0] }
                : titleID.flatMap { titleMap[$0] }.map { [$0] } ?? []
            let mediaURLs = postMediaURLs(from: data)

            return AppPost(
                id: id,
                kind: PostKind(rawValue: FirestoreValueReader.string(data, key: "kind") ?? "") ?? .post,
                author: authorSummary,
                titleId: titleID,
                title: titleID.flatMap { titleMap[$0] },
                text: FirestoreValueReader.string(data, key: "text"),
                sharedPost: nil,
                visibility: PostVisibility(rawValue: FirestoreValueReader.string(data, key: "visibility") ?? "") ?? .public,
                rating: FirestoreValueReader.double(data, key: "rating"),
                reviewText: FirestoreValueReader.string(data, key: "reviewText"),
                taggedTitles: resolvedTaggedTitles,
                mediaURL: mediaURLs.first,
                mediaURLs: mediaURLs,
                watchedWith: [],
                watchedWithGroup: nil,
                createdAt: FirestoreValueReader.date(data["createdAt"]),
                updatedAt: FirestoreValueReader.date(data["updatedAt"]),
                containsSpoiler: FirestoreValueReader.bool(data, key: "containsSpoiler") ?? false,
                spoilerTitleIds: FirestoreValueReader.stringArray(data["spoilerTitleIds"])
            )
        }
    }

    private func postMediaURLs(from data: [String: Any]) -> [URL] {
        let rawArray = FirestoreValueReader.stringArray(data["mediaUrls"])
        if !rawArray.isEmpty {
            return rawArray.compactMap(URL.init(string:))
        }
        return FirestoreValueReader.string(data, key: "mediaUrl").flatMap(URL.init(string:)).map { [$0] } ?? []
    }

    // MARK: - Helpers

    /// Versione "leggera" usata da componenti UI (anti-spoiler gate) per
    /// sapere SOLO se un titolo è completato, senza idratare i Title.
    /// Mappa `titleId -> isCompleted` per i `titleStates` recenti dell'utente.
    func fetchCompletedTitleIDs(userID: String, limit: Int = 400) async throws -> Set<String> {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("titleStates")
            .order(by: "updatedAt", descending: true)
            .limit(to: limit)
            .getDocuments()

        var ids: Set<String> = []
        for doc in snapshot.documents {
            let data = doc.data()
            let mediaType = MediaType(rawValue: FirestoreValueReader.string(data, key: "mediaType") ?? "") ?? .movie
            // Il doc Firestore ha UN solo campo `state`; `movieStatus`/`seriesStatus`
            // sono proprietà del modello, non chiavi salvate. Leggendo quei nomi
            // il set usciva sempre vuoto e il gate anti-spoiler non si sbloccava
            // mai, nemmeno sui titoli completati.
            let state = FirestoreValueReader.string(data, key: "state") ?? ""
            let isCompleted: Bool = {
                switch mediaType {
                case .movie:
                    return MoviePersonalStatus(rawValue: state) == .seenUnrated
                        || MoviePersonalStatus(rawValue: state) == .rated
                case .tv:
                    return SeriesPersonalStatus(rawValue: state) == .completedUnrated
                        || SeriesPersonalStatus(rawValue: state) == .rated
                }
            }()
            if isCompleted {
                ids.insert(doc.documentID)
            }
        }
        return ids
    }

    /// Progresso del viewer sui SOLI titoli richiesti, `titleId -> stato`.
    ///
    /// Letture mirate (chunk da 30 su `documentID`), non l'intera collection:
    /// il gate anti-spoiler per progresso serve solo i titoli a schermo, quindi
    /// una pagina di feed costa 1-2 query invece di centinaia di doc. I titoli
    /// assenti dalla mappa non sono in libreria → contenuto bloccato.
    /// Nessuna idratazione dei `Title`: al gate serve solo lo stato.
    func fetchTitleStates(userID: String, titleIDs: [String]) async throws -> [String: TitlePersonalState] {
        let ids = Array(Set(titleIDs.filter { !$0.isEmpty })).prefix(120)
        guard !userID.isEmpty, !ids.isEmpty else { return [:] }

        var result: [String: TitlePersonalState] = [:]
        for chunk in Array(ids).chunked(into: 30) {
            let snapshot = try await db.collection("users")
                .document(userID)
                .collection("titleStates")
                .whereField(FieldPath.documentID(), in: chunk)
                .getDocuments()
            for document in snapshot.documents {
                if let state = snapshotToPersonalState(document, titleLookup: [:]) {
                    result[document.documentID] = state
                }
            }
        }
        return result
    }

    /// Gli stati personali dell'utente, con le chiamate **concorrenti**
    /// coalizzate in una sola query.
    ///
    /// PERCHE' — `fetchWatchlistDashboard` lancia `fetchTitleStates` via
    /// `async let` e insieme `fetchMemberLists` e `fetchPublicLists`, che
    /// dentro `buildListSummaries` la richiamano una ciascuna: **tre query
    /// identiche in volo insieme**, cioe' fino a 1.200 letture di `titleStates`
    /// (400 doc × 3) piu' i `listTitles` corrispondenti, a ogni apertura della
    /// watchlist. Non e' un costo dei widget: e' quello che l'app paga oggi.
    ///
    /// E' lo stesso rimedio di `migrationTasks`, ma **senza** la meta' cache:
    /// qui si condivide solo un task gia' in volo, e appena finisce la voce
    /// sparisce. Un `titleStates` tenuto nel tempo farebbe sparire gli
    /// aggiornamenti subito dopo una modifica — il difetto sarebbe peggiore del
    /// costo che risolve.
    private func fetchTitleStates(userID: String) async throws -> [TitlePersonalState] {
        let normalizedUserID = userID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedUserID.isEmpty else { return [] }

        if let inFlight = titleStatesTasks[normalizedUserID] {
            return try await inFlight.value
        }

        let task = Task<[TitlePersonalState], Error> {
            try await self.loadTitleStates(userID: normalizedUserID)
        }
        titleStatesTasks[normalizedUserID] = task

        defer { titleStatesTasks.removeValue(forKey: normalizedUserID) }
        return try await task.value
    }

    private func loadTitleStates(userID: String) async throws -> [TitlePersonalState] {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("titleStates")
            .order(by: "updatedAt", descending: true)
            .limit(to: 400)
            .getDocuments()

        let titleIDs = snapshot.documents.map(\.documentID)
        let titles = try await titleRepository.listTitles(ids: titleIDs)
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })

        var states: [TitlePersonalState] = []
        for document in snapshot.documents {
            if let state = snapshotToPersonalState(document, titleLookup: titleMap) {
                states.append(state)
            }
        }
        return states
    }

    private func fetchMemberLists(userID: String) async throws -> [UserListSummary] {
        let snapshot = try await db.collection("userLists")
            .whereField("memberUids", arrayContains: userID)
            .order(by: "updatedAt", descending: true)
            .limit(to: 80)
            .getDocuments()

        return try await buildListSummaries(from: snapshot.documents, currentUserID: userID)
    }

    private func fetchPublicLists(currentUserID: String) async throws -> [UserListSummary] {
        let snapshot = try await db.collection("publicUserLists")
            .order(by: "updatedAt", descending: true)
            .limit(to: 120)
            .getDocuments()

        return try await buildListSummaries(from: snapshot.documents, currentUserID: currentUserID)
    }

    // MARK: - Public list deep-link / discovery

    /// Resolves a public-list deep link (`/lista/{slug}`) to its list id.
    /// Queries the server-owned public projection by `slug`, with a fallback on
    /// the legacy `editorialSlug` field. Returns `nil` if no public list matches.
    func fetchPublicListBySlug(_ slug: String, currentUserID: String) async throws -> UserListSummary? {
        let trimmed = slug.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        guard !trimmed.isEmpty else { return nil }

        // Primary: match the modern `slug` field.
        let bySlug = try await db.collection("publicUserLists")
            .whereField("slug", isEqualTo: trimmed)
            .limit(to: 1)
            .getDocuments()
        if let document = bySlug.documents.first {
            return try await buildListSummaries(from: [document], currentUserID: currentUserID).first
        }

        // Fallback: editorial lists stored only the legacy `editorialSlug`.
        let byEditorialSlug = try await db.collection("publicUserLists")
            .whereField("editorialSlug", isEqualTo: trimmed)
            .limit(to: 1)
            .getDocuments()
        if let document = byEditorialSlug.documents.first {
            return try await buildListSummaries(from: [document], currentUserID: currentUserID).first
        }

        return nil
    }

    /// Public lists that include a given title (`itemTitleIds array-contains`),
    /// surfaced on the title detail screen. Ordered by followers then recency.
    func fetchPublicListsContainingTitle(titleID: String, currentUserID: String, limit: Int = 12) async throws -> [UserListSummary] {
        let trimmed = titleID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        let snapshot = try await db.collection("publicUserLists")
            .whereField("itemTitleIds", arrayContains: trimmed)
            .order(by: "followersCount", descending: true)
            .limit(to: max(1, limit))
            .getDocuments()

        let summaries = try await buildListSummaries(from: snapshot.documents, currentUserID: currentUserID)
        return summaries.sorted { lhs, rhs in
            if lhs.followersCount != rhs.followersCount {
                return lhs.followersCount > rhs.followersCount
            }
            let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? .distantPast
            let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? .distantPast
            if lhsDate != rhsDate { return lhsDate > rhsDate }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    private func fetchPinnedPublicListIDs(userID: String) async throws -> Set<String> {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("savedLists")
            .whereField("isPinned", isEqualTo: true)
            .getDocuments()

        return Set(snapshot.documents.compactMap { document in
            FirestoreValueReader.string(document.data(), key: "listId") ?? document.documentID
        })
    }

    private func fetchPublicListProgressEntries(
        userID: String,
        listID: String? = nil
    ) async throws -> [PublicListItemProgress] {
        var query: Query = db.collection("users")
            .document(userID)
            .collection("listProgressEntries")

        if let listID, !listID.isEmpty {
            query = query.whereField("listId", isEqualTo: listID)
        }

        let snapshot = try await query.getDocuments()
        return snapshot.documents.compactMap(snapshotToPublicListProgress)
    }

    private func buildListSummaries(
        from snapshots: [QueryDocumentSnapshot],
        currentUserID: String
    ) async throws -> [UserListSummary] {
        let previewTitleIDs = snapshots.flatMap { document in
            FirestoreValueReader.stringArray(document.data()["previewTitleIds"])
        }
        let ownerIDs = snapshots.compactMap { FirestoreValueReader.string($0.data(), key: "ownerUid") }

        let titles = try await titleRepository.listTitles(ids: previewTitleIDs)
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })
        let owners = try await userRepository.listUsers(ids: ownerIDs)
        let ownerMap = Dictionary(uniqueKeysWithValues: owners.map { ($0.id, $0) })

        let titleStates = try await fetchTitleStates(userID: currentUserID)
        let titleStateMap = Dictionary(uniqueKeysWithValues: titleStates.map { ($0.titleId, $0) })

        return snapshots.compactMap { document in
            snapshotToUserListSummary(document, currentUserID: currentUserID, titleLookup: titleMap, personalStates: titleStateMap, ownerLookup: ownerMap)
        }
    }

    private func buildEditableListSummaries(
        from snapshots: [QueryDocumentSnapshot],
        currentUserID: String
    ) async throws -> [UserListSummary] {
        let previewTitleIDs = snapshots.flatMap { document in
            FirestoreValueReader.stringArray(document.data()["previewTitleIds"])
        }
        let ownerIDs = snapshots.compactMap { FirestoreValueReader.string($0.data(), key: "ownerUid") }

        let titles = try await titleRepository.listTitles(ids: previewTitleIDs)
        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })
        let owners = try await userRepository.listUsers(ids: ownerIDs)
        let ownerMap = Dictionary(uniqueKeysWithValues: owners.map { ($0.id, $0) })

        return snapshots.compactMap { document in
            snapshotToUserListSummary(
                document,
                currentUserID: currentUserID,
                titleLookup: titleMap,
                personalStates: [:],
                ownerLookup: ownerMap,
                preferStoredCompletedCount: true
            )
        }
    }

    private func snapshotToPersonalState(
        _ snapshot: DocumentSnapshot,
        titleLookup: [String: Title]
    ) -> TitlePersonalState? {
        guard snapshot.exists, let data = snapshot.data() else { return nil }

        let title = titleLookup[snapshot.documentID]
        let mediaType = MediaType(rawValue: FirestoreValueReader.string(data, key: "mediaType") ?? "") ?? title?.type ?? .movie
        let stateValue = FirestoreValueReader.string(data, key: "state")
            ?? (mediaType == .movie ? MoviePersonalStatus.unseen.rawValue : SeriesPersonalStatus.notStarted.rawValue)

        let progressData = FirestoreValueReader.map(data["seriesProgress"])
        let reminderData = FirestoreValueReader.map(data["reminders"])
        let seriesProgress = mediaType == .tv
            ? TitleSeriesProgress(
                episodesWatchedCount: FirestoreValueReader.int(progressData, key: "episodesWatchedCount") ?? 0,
                seasonsCompletedCount: FirestoreValueReader.int(progressData, key: "seasonsCompletedCount") ?? 0,
                totalEpisodeCount: FirestoreValueReader.int(progressData, key: "totalEpisodeCount"),
                totalSeasonCount: FirestoreValueReader.int(progressData, key: "totalSeasonCount"),
                lastWatchedEpisodeId: FirestoreValueReader.string(progressData, key: "lastWatchedEpisodeId"),
                lastWatchedEpisodeName: FirestoreValueReader.string(progressData, key: "lastWatchedEpisodeName"),
                lastWatchedSeasonNumber: FirestoreValueReader.int(progressData, key: "lastWatchedSeasonNumber"),
                lastWatchedEpisodeNumber: FirestoreValueReader.int(progressData, key: "lastWatchedEpisodeNumber"),
                lastWatchedAt: FirestoreValueReader.date(progressData["lastWatchedAt"]),
                percentComplete: FirestoreValueReader.double(progressData, key: "percentComplete")
            )
            : nil

        return TitlePersonalState(
            id: snapshot.documentID,
            titleId: snapshot.documentID,
            mediaType: mediaType,
            generalWatchlist: FirestoreValueReader.bool(data, key: "generalWatchlist") ?? false,
            rewatchIntent: FirestoreValueReader.bool(data, key: "rewatchIntent") ?? false,
            movieStatus: mediaType == .movie ? (MoviePersonalStatus(rawValue: stateValue) ?? .unseen) : nil,
            seriesStatus: mediaType == .tv ? (SeriesPersonalStatus(rawValue: stateValue) ?? .notStarted) : nil,
            seriesProgress: seriesProgress,
            ratingValue: FirestoreValueReader.double(data, key: "ratingValue") ?? FirestoreValueReader.double(data, key: "lastRating"),
            hasTitleRating: FirestoreValueReader.bool(data, key: "hasTitleRating") ?? false,
            seenAt: FirestoreValueReader.date(data["seenAt"]),
            completedAt: FirestoreValueReader.date(data["completedAt"]),
            ratedAt: FirestoreValueReader.date(data["ratedAt"]),
            rewatchAddedAt: FirestoreValueReader.date(data["rewatchAddedAt"]),
            createdAt: FirestoreValueReader.date(data["createdAt"]),
            updatedAt: FirestoreValueReader.date(data["updatedAt"]),
            lastInteractionAt: FirestoreValueReader.date(data["lastInteractionAt"]),
            source: FirestoreValueReader.string(data, key: "source"),
            reminderHints: TitleReminderHints(
                ratingReminderEligible: FirestoreValueReader.bool(reminderData, key: "ratingReminderEligible") ?? false,
                resumeReminderEligible: FirestoreValueReader.bool(reminderData, key: "resumeReminderEligible") ?? false,
                lastProgressAt: FirestoreValueReader.date(reminderData["lastProgressAt"]),
                suggestedReminderAt: FirestoreValueReader.date(reminderData["suggestedReminderAt"])
            ),
            completedCount: FirestoreValueReader.int(data, key: "completedCount") ?? 0,
            watchMinutesContribution: FirestoreValueReader.int(data, key: "watchMinutesContribution") ?? 0,
            completedAtTotalEpisodes: FirestoreValueReader.int(data, key: "completedAtTotalEpisodes"),
            completedAtTotalSeasons: FirestoreValueReader.int(data, key: "completedAtTotalSeasons"),
            hasNewContent: FirestoreValueReader.bool(data, key: "hasNewContent") ?? false,
            latestSeasonNumber: FirestoreValueReader.int(data, key: "latestSeasonNumber"),
            latestSeasonAirDate: FirestoreValueReader.string(data, key: "latestSeasonAirDate"),
            newContentDetectedAt: FirestoreValueReader.date(data["newContentDetectedAt"]),
            title: title
        )
    }

    private func defaultPersonalState(for title: Title) -> TitlePersonalState {
        let progress = title.type == .tv ? defaultSeriesProgress(for: title) : nil
        return TitlePersonalState(
            id: title.id,
            titleId: title.id,
            mediaType: title.type,
            generalWatchlist: false,
            rewatchIntent: false,
            movieStatus: title.type == .movie ? .unseen : nil,
            seriesStatus: title.type == .tv ? .notStarted : nil,
            seriesProgress: progress,
            ratingValue: nil,
            hasTitleRating: false,
            seenAt: nil,
            completedAt: nil,
            ratedAt: nil,
            rewatchAddedAt: nil,
            createdAt: nil,
            updatedAt: nil,
            lastInteractionAt: nil,
            source: nil,
            reminderHints: reminderHints(for: title, stateValue: title.type == .movie ? MoviePersonalStatus.unseen.rawValue : SeriesPersonalStatus.notStarted.rawValue, progress: progress, isInGeneralWatchlist: false),
            title: title
        )
    }

    private func defaultSeriesProgress(for title: Title) -> TitleSeriesProgress {
        TitleSeriesProgress(
            episodesWatchedCount: 0,
            seasonsCompletedCount: 0,
            totalEpisodeCount: estimateTotalEpisodes(for: title),
            totalSeasonCount: title.metadata.seasonsCount,
            lastWatchedEpisodeId: nil,
            lastWatchedEpisodeName: nil,
            lastWatchedSeasonNumber: nil,
            lastWatchedEpisodeNumber: nil,
            lastWatchedAt: nil,
            percentComplete: 0
        )
    }

    private func withGeneralWatchlist(
        _ state: TitlePersonalState,
        enabled: Bool,
        title: Title,
        source: String
    ) -> TitlePersonalState {
        TitlePersonalState(
            id: state.id,
            titleId: state.titleId,
            mediaType: state.mediaType,
            generalWatchlist: enabled,
            rewatchIntent: enabled ? false : state.rewatchIntent,
            movieStatus: state.movieStatus,
            seriesStatus: state.seriesStatus,
            seriesProgress: state.seriesProgress,
            ratingValue: state.ratingValue,
            hasTitleRating: state.hasTitleRating,
            seenAt: state.seenAt,
            completedAt: state.completedAt,
            ratedAt: state.ratedAt,
            rewatchAddedAt: enabled ? nil : state.rewatchAddedAt,
            createdAt: state.createdAt,
            updatedAt: .now,
            lastInteractionAt: .now,
            source: source,
            reminderHints: reminderHints(for: title, stateValue: state.statusValue, progress: state.seriesProgress, isInGeneralWatchlist: enabled),
            title: title
        )
    }

    private func withRewatchIntent(
        _ state: TitlePersonalState,
        enabled: Bool,
        title: Title,
        source: String
    ) -> TitlePersonalState {
        TitlePersonalState(
            id: state.id,
            titleId: state.titleId,
            mediaType: state.mediaType,
            generalWatchlist: false,
            rewatchIntent: enabled,
            movieStatus: state.movieStatus,
            seriesStatus: state.seriesStatus,
            seriesProgress: state.seriesProgress,
            ratingValue: state.ratingValue,
            hasTitleRating: state.hasTitleRating,
            seenAt: state.seenAt,
            completedAt: state.completedAt,
            ratedAt: state.ratedAt,
            rewatchAddedAt: enabled ? (state.rewatchAddedAt ?? .now) : nil,
            createdAt: state.createdAt,
            updatedAt: .now,
            lastInteractionAt: .now,
            source: source,
            reminderHints: reminderHints(
                for: title,
                stateValue: state.statusValue,
                progress: state.seriesProgress,
                isInGeneralWatchlist: false
            ),
            title: title
        )
    }

    private func persistPersonalState(userID: String, title: Title, state: TitlePersonalState) async throws {
        let stateRef = titleStateRef(userID: userID, titleID: title.id)
        let legacyWatchlistRef = db.collection("users").document(userID).collection("watchlist").document(title.id)
        let libraryRef = db.collection("users").document(userID).collection("library").document(title.id)

        let snapshot = try await stateRef.getDocument()
        let batch = db.batch()

        batch.setData(titleStatePayload(for: state, title: title, isNew: !snapshot.exists), forDocument: stateRef, merge: true)

        if state.generalWatchlist {
            batch.setData([
                "titleId": title.id,
                "addedAt": FieldValue.serverTimestamp(),
                "pendingTitle": NSNull(),
                "notes": NSNull(),
                "priority": "normal",
                "watchState": "to_watch",
                "addedFrom": state.source ?? "watchlist_v2",
                "updatedAt": FieldValue.serverTimestamp()
            ], forDocument: legacyWatchlistRef, merge: true)
        } else {
            batch.deleteDocument(legacyWatchlistRef)
        }

        if state.isCompleted || state.isRated {
            var libraryPayload: [String: Any] = [
                "titleId": title.id,
                "seenAt": state.seenAt.map { _ in FieldValue.serverTimestamp() } ?? FieldValue.serverTimestamp(),
                "updatedAt": FieldValue.serverTimestamp()
            ]
            // createdAt solo alla creazione: con merge:true ometterlo preserva il valore
            // esistente (prima il ternario aveva due rami identici → lo riscriveva sempre).
            if !snapshot.exists {
                libraryPayload["createdAt"] = FieldValue.serverTimestamp()
            }
            if state.isRated, let ratingValue = state.ratingValue {
                libraryPayload["lastRating"] = ratingValue
                libraryPayload["ratedAt"] = FieldValue.serverTimestamp()
            }
            batch.setData(libraryPayload, forDocument: libraryRef, merge: true)
        } else {
            batch.deleteDocument(libraryRef)
        }

        try await batch.commit()
    }

    private func applyCanonicalTitleStateAction(
        userID: String,
        title: Title,
        action: String,
        source: String,
        extra: [String: Any?] = [:]
    ) async throws -> TitlePersonalState {
        var payload: [String: Any] = [
            "titleId": title.id,
            "action": action,
            "source": source
        ]

        extra.forEach { key, value in
            if let value {
                payload[key] = value
            }
        }

        _ = try await invokeCallable(name: "applyTitleStateAction", payload: payload)
        return try await fetchTitleState(userID: userID, title: title)
    }

    private func titleStatePayload(for state: TitlePersonalState, title: Title, isNew: Bool) -> [String: Any] {
        let progress = state.seriesProgress
        let reminders = state.reminderHints
        var payload: [String: Any] = [
            "titleId": state.titleId,
            "mediaType": state.mediaType.rawValue,
            "state": state.statusValue,
            "generalWatchlist": state.generalWatchlist,
            "rewatchIntent": state.rewatchIntent,
            "hasTitleRating": state.hasTitleRating || state.isRated,
            "ratingValue": state.ratingValue as Any,
            "seenAt": state.seenAt as Any,
            "completedAt": state.completedAt as Any,
            "ratedAt": state.ratedAt as Any,
            "rewatchAddedAt": state.rewatchAddedAt as Any,
            "source": state.source as Any,
            "completedCount": state.completedCount,
            "watchMinutesContribution": state.watchMinutesContribution,
            "updatedAt": FieldValue.serverTimestamp(),
            "lastInteractionAt": FieldValue.serverTimestamp(),
            "seriesProgress": [
                "episodesWatchedCount": progress?.episodesWatchedCount ?? 0,
                "seasonsCompletedCount": progress?.seasonsCompletedCount ?? 0,
                "totalEpisodeCount": progress?.totalEpisodeCount as Any,
                "totalSeasonCount": progress?.totalSeasonCount as Any,
                "lastWatchedEpisodeId": progress?.lastWatchedEpisodeId as Any,
                "lastWatchedEpisodeName": progress?.lastWatchedEpisodeName as Any,
                "lastWatchedSeasonNumber": progress?.lastWatchedSeasonNumber as Any,
                "lastWatchedEpisodeNumber": progress?.lastWatchedEpisodeNumber as Any,
                "lastWatchedAt": progress?.lastWatchedAt as Any,
                "percentComplete": progress?.percentComplete as Any
            ],
            "reminders": [
                "ratingReminderEligible": reminders.ratingReminderEligible,
                "resumeReminderEligible": reminders.resumeReminderEligible,
                "lastProgressAt": reminders.lastProgressAt as Any,
                "suggestedReminderAt": reminders.suggestedReminderAt as Any
            ],
            "titleSnapshot": [
                "titleId": title.id,
                "name": title.name,
                "posterPath": title.posterPath?.absoluteString as Any,
                "mediaType": title.type.rawValue
            ]
        ]

        payload["schemaVersion"] = 3

        if isNew {
            payload["createdAt"] = FieldValue.serverTimestamp()
        }

        return payload
    }

    private func titleStateRef(userID: String, titleID: String) -> DocumentReference {
        db.collection("users").document(userID).collection("titleStates").document(titleID)
    }

    private func savedListRef(userID: String, listID: String) -> DocumentReference {
        db.collection("users").document(userID).collection("savedLists").document(listID)
    }

    private func publicListProgressRef(userID: String, listID: String, titleID: String) -> DocumentReference {
        db.collection("users")
            .document(userID)
            .collection("listProgressEntries")
            .document("\(listID)__\(titleID)")
    }

    private func fetchPublicListProgress(
        userID: String,
        listID: String,
        title: Title
    ) async throws -> PublicListItemProgress {
        let snapshot = try await publicListProgressRef(userID: userID, listID: listID, titleID: title.id).getDocument()
        if let parsed = snapshotToPublicListProgress(snapshot) {
            return parsed
        }
        return defaultPublicListProgress(for: title, listID: listID)
    }

    private func defaultPublicListProgress(for title: Title, listID: String) -> PublicListItemProgress {
        PublicListItemProgress(
            listId: listID,
            titleId: title.id,
            mediaType: title.type,
            status: .notStarted,
            seriesProgress: title.type == .tv ? defaultSeriesProgress(for: title) : nil,
            completedAt: nil,
            updatedAt: nil,
            lastInteractionAt: nil,
            watchMinutesContribution: 0
        )
    }

    private func persistPublicListProgress(userID: String, state: PublicListItemProgress) async throws {
        let ref = publicListProgressRef(userID: userID, listID: state.listId, titleID: state.titleId)
        try await ref.setData(publicListProgressPayload(for: state), merge: true)
    }

    private func publicListProgressPayload(for state: PublicListItemProgress) -> [String: Any] {
        let progress = state.seriesProgress
        return [
            "listId": state.listId,
            "titleId": state.titleId,
            "mediaType": state.mediaType.rawValue,
            "state": state.status.rawValue,
            "seriesProgress": [
                "episodesWatchedCount": progress?.episodesWatchedCount ?? 0,
                "seasonsCompletedCount": progress?.seasonsCompletedCount ?? 0,
                "totalEpisodeCount": progress?.totalEpisodeCount as Any,
                "totalSeasonCount": progress?.totalSeasonCount as Any,
                "lastWatchedEpisodeId": progress?.lastWatchedEpisodeId as Any,
                "lastWatchedEpisodeName": progress?.lastWatchedEpisodeName as Any,
                "lastWatchedSeasonNumber": progress?.lastWatchedSeasonNumber as Any,
                "lastWatchedEpisodeNumber": progress?.lastWatchedEpisodeNumber as Any,
                "lastWatchedAt": progress?.lastWatchedAt as Any,
                "percentComplete": progress?.percentComplete as Any
            ],
            "completedAt": state.completedAt as Any,
            "updatedAt": FieldValue.serverTimestamp(),
            "lastInteractionAt": FieldValue.serverTimestamp(),
            "watchMinutesContribution": max(0, state.watchMinutesContribution)
        ]
    }

    private func snapshotToPublicListProgress(_ snapshot: DocumentSnapshot) -> PublicListItemProgress? {
        guard snapshot.exists, let data = snapshot.data() else { return nil }
        let listID = FirestoreValueReader.string(data, key: "listId") ?? ""
        let titleID = FirestoreValueReader.string(data, key: "titleId") ?? ""
        guard !listID.isEmpty, !titleID.isEmpty else { return nil }

        let mediaType = MediaType(rawValue: FirestoreValueReader.string(data, key: "mediaType") ?? "") ?? .movie
        let stateValue = PublicListProgressStatus(rawValue: FirestoreValueReader.string(data, key: "state") ?? "") ?? .notStarted
        let progressData = FirestoreValueReader.map(data["seriesProgress"])
        let seriesProgress = mediaType == .tv
            ? TitleSeriesProgress(
                episodesWatchedCount: FirestoreValueReader.int(progressData, key: "episodesWatchedCount") ?? 0,
                seasonsCompletedCount: FirestoreValueReader.int(progressData, key: "seasonsCompletedCount") ?? 0,
                totalEpisodeCount: FirestoreValueReader.int(progressData, key: "totalEpisodeCount"),
                totalSeasonCount: FirestoreValueReader.int(progressData, key: "totalSeasonCount"),
                lastWatchedEpisodeId: FirestoreValueReader.string(progressData, key: "lastWatchedEpisodeId"),
                lastWatchedEpisodeName: FirestoreValueReader.string(progressData, key: "lastWatchedEpisodeName"),
                lastWatchedSeasonNumber: FirestoreValueReader.int(progressData, key: "lastWatchedSeasonNumber"),
                lastWatchedEpisodeNumber: FirestoreValueReader.int(progressData, key: "lastWatchedEpisodeNumber"),
                lastWatchedAt: FirestoreValueReader.date(progressData["lastWatchedAt"]),
                percentComplete: FirestoreValueReader.double(progressData, key: "percentComplete")
            )
            : nil

        return PublicListItemProgress(
            listId: listID,
            titleId: titleID,
            mediaType: mediaType,
            status: stateValue,
            seriesProgress: seriesProgress,
            completedAt: FirestoreValueReader.date(data["completedAt"]),
            updatedAt: FirestoreValueReader.date(data["updatedAt"]),
            lastInteractionAt: FirestoreValueReader.date(data["lastInteractionAt"]),
            watchMinutesContribution: FirestoreValueReader.int(data, key: "watchMinutesContribution") ?? 0
        )
    }

    private func fetchGeneralWatchlistDetail(userID: String) async throws -> UserListDetail {
        let titleStates = try await fetchTitleStates(userID: userID)
        let general = titleStates
            .filter(\.isInToWatchQueue)
            .sorted(by: sortPersonalStates)

        let owner = try? await userRepository.fetchUser(uid: userID)
        let ownerSummary = owner.map {
            UserSummary(id: $0.id, displayName: $0.displayName, photoURL: $0.photoURL ?? $0.avatarURL)
        }

        let list = makeGeneralWatchlistSummary(
            userID: userID,
            titleStates: general,
            owner: ownerSummary
        )

        let items = general.enumerated().map { index, state in
            UserListItem(
                id: state.titleId,
                titleId: state.titleId,
                orderIndex: index,
                addedByUid: userID,
                note: nil,
                addedAt: state.createdAt,
                updatedAt: state.updatedAt ?? state.lastInteractionAt,
                title: state.title,
                personalState: state,
                publicProgress: nil
            )
        }

        let members = [
            UserListMember(
                id: userID,
                displayName: owner?.displayName ?? "Tu",
                photoURL: owner?.photoURL ?? owner?.avatarURL,
                role: .owner,
                joinedAt: list.createdAt
            )
        ]

        return UserListDetail(list: list, members: members, items: items, progress: [])
    }

    private func makeGeneralWatchlistSummary(
        userID: String,
        titleStates: [TitlePersonalState],
        owner: UserSummary? = nil
    ) -> UserListSummary {
        let previewTitles = generalWatchlistPreviewTitles(from: titleStates)
        let latestActivity = titleStates
            .compactMap { $0.updatedAt ?? $0.lastInteractionAt ?? $0.createdAt }
            .max()
        let firstSavedAt = titleStates
            .compactMap(\.createdAt)
            .min()

        return UserListSummary(
            id: Self.generalWatchlistListID,
            title: "Tutti i titoli da vedere",
            description: "I titoli che hai segnato da vedere, sempre pronti da riprendere.",
            visibility: .private,
            kind: .collection,
            ownerUid: userID,
            owner: owner,
            memberUids: [userID],
            editorUids: [],
            cover: UserListCover(
                imageURL: nil,
                storagePath: nil,
                fallbackTitleIds: previewTitles.map(\.id),
                accentHex: nil
            ),
            itemCount: titleStates.count,
            completedCount: titleStates.filter(\.isCompleted).count,
            followersCount: 0,
            createdAt: firstSavedAt,
            updatedAt: latestActivity,
            isOwnedByCurrentUser: true,
            canEdit: false,
            isSavedByCurrentUser: true,
            previewTitles: previewTitles
        )
    }

    private func generalWatchlistPreviewTitles(from titleStates: [TitlePersonalState], limit: Int = 10) -> [Title] {
        let titles = titleStates.compactMap(\.title)
        guard titles.count > limit else { return titles }

        let seed = max(titleStates.count, 1)
        return titles
            .sorted { lhs, rhs in
                previewRank(for: lhs.id, seed: seed) < previewRank(for: rhs.id, seed: seed)
            }
            .prefix(limit)
            .map { $0 }
    }

    private func previewRank(for id: String, seed: Int) -> Int {
        id.unicodeScalars.reduce(seed * 97) { partialResult, scalar in
            ((partialResult * 131) + Int(scalar.value)) % 1_000_003
        }
    }

    private func hydrateListProgressCounts(
        _ list: UserListSummary,
        using stateMap: [String: TitlePersonalState],
        publicListProgressMap: [String: [PublicListItemProgress]],
        pinnedPublicListIDs: Set<String>
    ) -> UserListSummary {
        let completedCount: Int
        if list.visibility == .public {
            completedCount = publicListProgressMap[list.id, default: []].reduce(into: 0) { partialResult, entry in
                if entry.isCompleted {
                    partialResult += 1
                }
            }
        } else {
            completedCount = list.previewTitles.isEmpty
                ? list.completedCount
                : list.previewTitles.reduce(into: 0) { partialResult, title in
                    if stateMap[title.id]?.isCompleted == true {
                        partialResult += 1
                    }
                }
        }

        return UserListSummary(
            id: list.id,
            title: list.title,
            description: list.description,
            visibility: list.visibility,
            kind: list.kind,
            ownerUid: list.ownerUid,
            owner: list.owner,
            memberUids: list.memberUids,
            editorUids: list.editorUids,
            cover: list.cover,
            itemCount: list.itemCount,
            completedCount: max(list.completedCount, completedCount),
            followersCount: list.followersCount,
            createdAt: list.createdAt,
            updatedAt: list.updatedAt,
            isOwnedByCurrentUser: list.isOwnedByCurrentUser,
            canEdit: list.canEdit,
            isSavedByCurrentUser: list.isSavedByCurrentUser || pinnedPublicListIDs.contains(list.id),
            previewTitles: list.previewTitles,
            slug: list.slug,
            editorialSlug: list.editorialSlug
        )
    }

    private func snapshotToUserListSummary(
        _ snapshot: DocumentSnapshot,
        currentUserID: String,
        titleLookup: [String: Title],
        personalStates: [String: TitlePersonalState],
        ownerLookup: [String: AppUser] = [:],
        preferStoredCompletedCount: Bool = false,
        publicProgressEntries: [PublicListItemProgress] = [],
        pinnedPublicListIDs: Set<String> = []
    ) -> UserListSummary? {
        guard snapshot.exists, let data = snapshot.data() else { return nil }

        let ownerUid = FirestoreValueReader.string(data, key: "ownerUid") ?? ""
        let ownerUser = ownerLookup[ownerUid]
        let memberUids = FirestoreValueReader.stringArray(data["memberUids"])
        let editorUids = FirestoreValueReader.stringArray(data["editorUids"])
        let previewIDs = FirestoreValueReader.stringArray(data["previewTitleIds"])
        let titleIDs = FirestoreValueReader.stringArray(data["itemTitleIds"])
        let previewTitles = previewIDs.compactMap { titleLookup[$0] }
        let visibility = UserListVisibility(rawValue: FirestoreValueReader.string(data, key: "visibility") ?? "") ?? .private
        let completedCount: Int
        if preferStoredCompletedCount {
            completedCount = FirestoreValueReader.int(data, key: "completedCount") ?? 0
        } else if visibility == .public {
            completedCount = publicProgressEntries.reduce(into: 0) { partialResult, entry in
                if entry.isCompleted {
                    partialResult += 1
                }
            }
        } else {
            completedCount = titleIDs.reduce(into: 0) { partialResult, titleID in
                if personalStates[titleID]?.isCompleted == true {
                    partialResult += 1
                }
            }
        }

        let persistedCover = coverFields(from: data)
        return UserListSummary(
            id: snapshot.documentID,
            title: FirestoreValueReader.string(data, key: "title") ?? "Lista",
            description: FirestoreValueReader.string(data, key: "description"),
            visibility: visibility,
            kind: UserListKind(rawValue: FirestoreValueReader.string(data, key: "kind") ?? "") ?? .collection,
            ownerUid: ownerUid,
            owner: ownerUser.map {
                UserSummary(id: $0.id, displayName: $0.displayName, photoURL: $0.photoURL ?? $0.avatarURL)
            },
            memberUids: memberUids,
            editorUids: editorUids,
            cover: UserListCover(
                imageURL: persistedCover.imageURL,
                storagePath: persistedCover.storagePath,
                fallbackTitleIds: persistedCover.fallbackTitleIds,
                accentHex: persistedCover.accentHex
            ),
            itemCount: FirestoreValueReader.int(data, key: "itemCount") ?? titleIDs.count,
            completedCount: completedCount,
            followersCount: FirestoreValueReader.int(data, key: "followersCount") ?? 0,
            createdAt: FirestoreValueReader.date(data["createdAt"]),
            updatedAt: FirestoreValueReader.date(data["updatedAt"]),
            isOwnedByCurrentUser: ownerUid == currentUserID,
            canEdit: ownerUid == currentUserID || editorUids.contains(currentUserID),
            isSavedByCurrentUser: pinnedPublicListIDs.contains(snapshot.documentID) || FirestoreValueReader.stringArray(data["savedByUids"]).contains(currentUserID),
            previewTitles: previewTitles,
            slug: FirestoreValueReader.string(data, key: "slug"),
            editorialSlug: FirestoreValueReader.string(data, key: "editorialSlug")
        )
    }

    private func upsertList(
        userID: String,
        owner: AppUser?,
        listID: String,
        previousList: [String: Any]?,
        draft: UserListEditorDraft,
        collaborators: [AppUser]
    ) async throws {
        let trimmedTitle = draft.trimmedTitle
        guard trimmedTitle.count >= 2 else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [NSLocalizedDescriptionKey: String(localized: "Dai un nome alla lista.")])
        }

        let listRef = db.collection("userLists").document(listID)
        let isCreate = (previousList == nil)
        let previousItemIDs = previousList.map { FirestoreValueReader.stringArray($0["itemTitleIds"]) } ?? []
        let nextItemIDs = uniqueIDs(draft.selectedTitleIDs)
        let collaboratorIDs = draft.visibility == .shared ? uniqueIDs(collaborators.map(\.id)) : []
        let ownerID = owner?.id ?? FirestoreValueReader.string(previousList ?? [:], key: "ownerUid") ?? userID
        let previousEditorIDs = uniqueIDs(FirestoreValueReader.stringArray(previousList?["editorUids"]))
        if isCreate && !collaboratorIDs.isEmpty {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [NSLocalizedDescriptionKey: String(localized: "Inviti collaboratori non ancora disponibili: serve accettazione esplicita.")])
        }
        if !isCreate && draft.visibility == .shared && Set(collaboratorIDs) != Set(previousEditorIDs) {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [NSLocalizedDescriptionKey: String(localized: "Modifica collaboratori non ancora disponibile: serve accettazione esplicita.")])
        }
        let ownerUser: AppUser?
        if let owner {
            ownerUser = owner
        } else {
            ownerUser = try await userRepository.fetchUser(uid: ownerID)
        }

        let batch = db.batch()

        var listPayload: [String: Any] = [
            "title": trimmedTitle,
            "description": sanitizedOptionalText(draft.description, maxLength: 280) as Any,
            "visibility": draft.visibility.rawValue,
            "kind": draft.kind.rawValue,
            "updatedAt": FieldValue.serverTimestamp()
        ]
        if isCreate {
            listPayload.merge([
            "ownerUid": ownerID,
            "ownerDisplayName": ownerUser?.displayName ?? "User",
            "memberUids": [ownerID],
            "editorUids": [],
            "viewerUids": [],
            "itemTitleIds": [],
            "previewTitleIds": [],
            "itemCount": 0,
            "completedCount": 0,
            "followersCount": 0,
            "cover": [
                "imageUrl": NSNull(),
                "storagePath": NSNull(),
                "fallbackTitleIds": [],
                "accentHex": NSNull()
            ]
            ]) { _, new in new }
            listPayload["createdAt"] = FieldValue.serverTimestamp()
        }

        batch.setData(listPayload, forDocument: listRef, merge: true)

        for (index, titleID) in nextItemIDs.enumerated() {
            var itemPayload: [String: Any] = [
                "titleId": titleID,
                "orderIndex": (index + 1) * 1_000,
                "updatedAt": FieldValue.serverTimestamp()
            ]
            if !previousItemIDs.contains(titleID) {
                itemPayload["addedByUid"] = userID
                itemPayload["addedAt"] = FieldValue.serverTimestamp()
            }
            batch.setData(itemPayload, forDocument: listRef.collection("items").document(titleID), merge: true)
        }

        for removedID in previousItemIDs where !nextItemIDs.contains(removedID) {
            batch.deleteDocument(listRef.collection("items").document(removedID))
        }

        if isCreate {
            batch.setData([
                "uid": ownerID,
                "displayName": ownerUser?.displayName ?? "User",
                "role": UserListMemberRole.owner.rawValue,
                "joinedAt": FieldValue.serverTimestamp()
            ], forDocument: listRef.collection("members").document(ownerID), merge: true)
        }

        try await batch.commit()

        try await recomputeListProgress(listID: listID)
    }

    private func coverFields(from data: [String: Any]) -> (imageURL: URL?, storagePath: String?, fallbackTitleIds: [String], accentHex: String?) {
        let coverData = FirestoreValueReader.map(data["cover"])
        let storagePath = FirestoreValueReader.string(coverData, key: "storagePath")
        let persistedURL = URL(string: FirestoreValueReader.string(coverData, key: "imageUrl") ?? "")

        return (
            imageURL: persistedURL,
            storagePath: storagePath,
            fallbackTitleIds: FirestoreValueReader.stringArray(coverData["fallbackTitleIds"]),
            accentHex: FirestoreValueReader.string(coverData, key: "accentHex")
        )
    }

    private func recomputeListProgress(listID: String) async throws {
        _ = try await invokeCallable(name: "recomputeListProgress", payload: [
            "listId": listID
        ])
    }

    private func syncListProgressAfterTitleChange(userID: String, titleID: String) async throws {
        let snapshot = try await db.collection("userLists")
            .whereField("memberUids", arrayContains: userID)
            .limit(to: 80)
            .getDocuments()

        let impactedListIDs = snapshot.documents.compactMap { document -> String? in
            let itemIDs = FirestoreValueReader.stringArray(document.data()["itemTitleIds"])
            return itemIDs.contains(titleID) ? document.documentID : nil
        }

        for listID in impactedListIDs {
            try? await recomputeListProgress(listID: listID)
        }
    }

    private func reminderHints(
        for title: Title,
        stateValue: String,
        progress: TitleSeriesProgress?,
        isInGeneralWatchlist: Bool
    ) -> TitleReminderHints {
        let isToRate = stateValue == MoviePersonalStatus.seenUnrated.rawValue
            || stateValue == SeriesPersonalStatus.completedUnrated.rawValue
        let isResumeCandidate = title.type == .tv && isInGeneralWatchlist && stateValue == SeriesPersonalStatus.inProgress.rawValue
        let nextReminderAt = (isToRate || isResumeCandidate) ? Calendar.current.date(byAdding: .day, value: 3, to: .now) : nil

        return TitleReminderHints(
            ratingReminderEligible: isToRate,
            resumeReminderEligible: isResumeCandidate,
            lastProgressAt: progress?.lastWatchedAt,
            suggestedReminderAt: nextReminderAt
        )
    }

    private func estimateTotalEpisodes(for title: Title) -> Int? {
        guard title.type == .tv else { return nil }
        guard let seasons = title.metadata.seasonsCount, seasons > 0 else { return nil }
        guard let perSeason = title.metadata.episodesPerSeason, perSeason > 0 else { return nil }
        return seasons * perSeason
    }

    private func progressPercent(
        completedEpisodes: Int,
        totalEpisodes: Int?,
        completedSeasons: Int,
        totalSeasons: Int?
    ) -> Double {
        if let totalEpisodes, totalEpisodes > 0 {
            return min(1, max(0, Double(completedEpisodes) / Double(totalEpisodes)))
        }
        if let totalSeasons, totalSeasons > 0 {
            return min(1, max(0, Double(completedSeasons) / Double(totalSeasons)))
        }
        return 0
    }

    private func episodeIdentifier(season: Int?, episode: Int?) -> String? {
        guard let season, let episode else { return nil }
        return "s\(season)e\(episode)"
    }

    private func episodeName(season: Int?, episode: Int?) -> String? {
        guard let season, let episode else { return nil }
        return "Stagione \(season), episodio \(episode)"
    }

    private func sortPersonalStates(lhs: TitlePersonalState, rhs: TitlePersonalState) -> Bool {
        if lhs.isInProgressSeries != rhs.isInProgressSeries {
            return lhs.isInProgressSeries && !rhs.isInProgressSeries
        }
        let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? .distantPast
        let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? .distantPast
        if lhsDate != rhsDate { return lhsDate > rhsDate }
        return lhs.title?.name ?? lhs.titleId < rhs.title?.name ?? rhs.titleId
    }

    private func sortLists(lhs: UserListSummary, rhs: UserListSummary) -> Bool {
        let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? .distantPast
        let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? .distantPast
        if lhsDate != rhsDate { return lhsDate > rhsDate }
        return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
    }

    private func sortRewatchStates(lhs: TitlePersonalState, rhs: TitlePersonalState) -> Bool {
        let lhsDate = lhs.rewatchAddedAt ?? lhs.updatedAt ?? lhs.completedAt ?? lhs.seenAt ?? lhs.createdAt ?? .distantPast
        let rhsDate = rhs.rewatchAddedAt ?? rhs.updatedAt ?? rhs.completedAt ?? rhs.seenAt ?? rhs.createdAt ?? .distantPast
        if lhsDate != rhsDate { return lhsDate > rhsDate }
        return lhs.title?.name ?? lhs.titleId < rhs.title?.name ?? rhs.titleId
    }

    private func naturalPromptSeed(from normalizedPrompt: String) -> String {
        let replacements = [
            String(localized: "tutti i film del "),
            "tutti i film di ",
            String(localized: "tutte le serie di "),
            "film di ",
            "serie di ",
            "film ",
            "serie "
        ]
        for replacement in replacements where normalizedPrompt.hasPrefix(replacement) {
            let remainder = String(normalizedPrompt.dropFirst(replacement.count))
            if !remainder.isEmpty {
                return remainder
            }
        }
        return normalizedPrompt
    }

    private func isOrderedPrompt(_ normalizedPrompt: String) -> Bool {
        normalizedPrompt.contains("ordine cronologic")
            || normalizedPrompt.contains("ordine di visione")
            || normalizedPrompt.contains("percorso")
    }

    private func naturalReason(for title: Title, prompt: String) -> String {
        let normalizedCollection = SearchNormalizer.normalize(title.collectionName ?? "")
        if !normalizedCollection.isEmpty, prompt.contains(normalizedCollection) {
            return "Collection \(title.collectionName ?? "")"
        }
        if title.keywords.contains(where: { prompt.contains(SearchNormalizer.normalize($0)) }) {
            return "Match su keyword"
        }
        if title.aliases.contains(where: { prompt.contains(SearchNormalizer.normalize($0)) }) {
            return "Match su titolo alternativo"
        }
        if prompt.contains(title.nameLower) || title.nameLower.contains(prompt) {
            return "Match sul titolo"
        }
        return String(localized: "Compatibile con la frase")
    }

    private func naturalCandidateScore(for title: Title, prompt: String) -> Int {
        var score = 0
        let collectionName = SearchNormalizer.normalize(title.collectionName ?? "")

        if prompt == title.nameLower { score += 30 }
        if title.nameLower.hasPrefix(prompt) || prompt.hasPrefix(title.nameLower) { score += 18 }
        if !collectionName.isEmpty, prompt.contains(collectionName) || collectionName.contains(prompt) { score += 16 }
        if title.aliases.contains(where: { prompt.contains(SearchNormalizer.normalize($0)) }) { score += 12 }
        if title.keywords.contains(where: { prompt.contains(SearchNormalizer.normalize($0)) }) { score += 10 }
        if SearchNormalizer.normalize(title.searchableText).contains(prompt) { score += 6 }
        return score
    }

    private func suggestedListName(for phrase: String, candidates: [NaturalListCandidate]) -> String {
        let trimmed = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
        if let firstCollection = candidates.first?.title.collectionName, !firstCollection.isEmpty {
            return firstCollection
        }
        guard !trimmed.isEmpty else { return "Nuova lista" }

        return trimmed
            .split(separator: " ")
            .map { token in
                token.prefix(1).uppercased() + token.dropFirst()
            }
            .joined(separator: " ")
    }

    private func uniqueIDs(_ values: [String]) -> [String] {
        var output: [String] = []
        var seen: Set<String> = []

        for value in values {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { continue }
            output.append(trimmed)
        }

        return output
    }

    private func sanitizedOptionalText(_ value: String, maxLength: Int) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxLength))
    }

    private func estimatedWatchMinutes(for title: Title?) -> Int {
        guard let title else { return 0 }

        switch title.type {
        case .movie:
            return max(0, title.metadata.durationMovie ?? 0)
        case .tv:
            let durationPerEpisode = max(0, title.metadata.durationEpisode ?? 0)
            let seasonsCount = max(0, title.metadata.seasonsCount ?? 0)
            let episodesPerSeason = max(0, title.metadata.episodesPerSeason ?? 0)
            guard durationPerEpisode > 0, seasonsCount > 0, episodesPerSeason > 0 else { return 0 }
            return durationPerEpisode * seasonsCount * episodesPerSeason
        }
    }

    private func invokeCallable(name: String, payload: [String: Any]) async throws -> CloudFunctionsCaller.CallableResult {
        try await CloudFunctionsCaller.call(name: name, data: payload)
    }

    private func putImageData(_ data: Data, metadata: StorageMetadata, in reference: StorageReference) async throws -> StorageMetadata {
        try await withCheckedThrowingContinuation { continuation in
            reference.putData(data, metadata: metadata) { returnedMetadata, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let returnedMetadata {
                    continuation.resume(returning: returnedMetadata)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "TwoWatch.WatchlistRepository",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: String(localized: "Metadata upload non disponibile.")]
                    ))
                }
            }
        }
    }

    private func deleteStorageObject(at path: String) async throws {
        let reference = Storage.storage().reference(withPath: path)
        try await reference.delete()
    }

    private func downloadURL(for reference: StorageReference) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            reference.downloadURL { url, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "TwoWatch.WatchlistRepository",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: String(localized: "Download URL non disponibile.")]
                    ))
                }
            }
        }
    }
}

private extension UIImage {
    func prepareForListCoverUpload(maxDimension: CGFloat = 1_500) -> UIImage {
        let currentMaxDimension = max(size.width, size.height)
        guard currentMaxDimension > maxDimension else { return self }

        let scale = maxDimension / currentMaxDimension
        let targetSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        return renderer.image { _ in
            draw(in: CGRect(origin: .zero, size: targetSize))
        }
    }
}
