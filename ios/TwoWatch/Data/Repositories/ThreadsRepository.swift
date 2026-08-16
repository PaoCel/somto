@preconcurrency import FirebaseFirestore
import Foundation

@MainActor
final class ThreadsRepository {
    struct ThreadPage {
        let items: [AppThread]
        let nextCursor: DocumentSnapshot?
        let hasMore: Bool
    }

    private let db = Firestore.firestore()
    private let titleRepository: TitleRepository
    private let userRepository: UserRepository
    var analytics: AnalyticsLogging = NoopAnalyticsLogger()

    init(titleRepository: TitleRepository, userRepository: UserRepository) {
        self.titleRepository = titleRepository
        self.userRepository = userRepository
    }

    func threadIDForPublic(titleID: String) -> String {
        "public_\(titleID)"
    }

    /// ID deterministico del thread pubblico di un singolo episodio.
    /// Formato `public_<titleID>_s<season>e<episode>` → matcha `^public_.+`
    /// nelle rules, quindi accettato come thread pubblico senza modifiche.
    func threadIDForEpisode(titleID: String, season: Int, episode: Int) -> String {
        "public_\(titleID)_s\(season)e\(episode)"
    }

    /// ID deterministico del thread pubblico di una stagione.
    /// Formato `public_<titleID>_s<season>` → stesso schema dell'episodio senza
    /// la parte `e<n>`, quindi matcha `^public_.+` nelle rules ed è accettato
    /// come thread pubblico **senza modifiche a `firestore.rules`**.
    func threadIDForSeason(titleID: String, season: Int) -> String {
        "public_\(titleID)_s\(season)"
    }

    func threadIDForDM(titleID: String, uidA: String, uidB: String) -> String {
        let pair = [uidA, uidB].sorted()
        return "dm_\(titleID)_\(pair[0])_\(pair[1])"
    }

    func threadIDForDirect(uidA: String, uidB: String) -> String {
        let pair = [uidA, uidB].sorted()
        return "direct_\(pair[0])_\(pair[1])"
    }

    func threadIDForGroup(titleID: String? = nil, participantUIDs: [String]) -> String {
        let sorted = participantUIDs.sorted()
        let hash = stableHash(sorted.joined(separator: "_"))
        if let titleID, !titleID.isEmpty {
            return "group_\(titleID)_\(hash)"
        }
        return "group__\(hash)"
    }

    func ensureMySupportThread() async throws -> String {
        let result = try await CloudFunctionsCaller.call(name: "ensureMySupportThread", data: [:])
        guard
            let data = result.data as? [String: Any],
            let threadID = data["threadId"] as? String,
            !threadID.isEmpty
        else {
            throw NSError(domain: "TwoWatch", code: 500, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Chat di supporto non disponibile.")
            ])
        }
        return threadID
    }

    func ensurePublicThread(titleID: String, createdBy: String) async throws -> AppThread {
        let threadID = threadIDForPublic(titleID: titleID)
        let threadRef = db.collection("threads").document(threadID)
        let snapshot = try await readThreadSnapshotIfAuthorized(threadRef)

        if snapshot?.exists != true {
            try await threadRef.setData([
                "titleId": titleID,
                "visibility": "public",
                "contextType": "public",
                "contextId": "global",
                "participants": [],
                "groupName": "Discussione pubblica",
                "createdBy": createdBy,
                "createdAt": FieldValue.serverTimestamp(),
                "lastMessageAt": NSNull(),
                "lastMessagePreview": "",
                "lastSenderUid": NSNull(),
                "lastMessageId": NSNull()
            ])
        }

        guard let thread = try await fetchThread(id: threadID) else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Thread pubblico non disponibile.")
            ])
        }
        return thread
    }

    /// Crea (o recupera) il thread pubblico di un singolo episodio. Specchio di
    /// `ensurePublicThread` ma con id episode-scoped e `contextId: "s<n>e<m>"`.
    /// Scrittura client pura: le rules accettano id `^public_.+` con contextId
    /// stringa non vuota arbitrario (nessuna modifica alle rules necessaria).
    func ensureEpisodePublicThread(
        titleID: String,
        season: Int,
        episode: Int,
        createdBy: String
    ) async throws -> AppThread {
        let threadID = threadIDForEpisode(titleID: titleID, season: season, episode: episode)
        let threadRef = db.collection("threads").document(threadID)
        let snapshot = try await readThreadSnapshotIfAuthorized(threadRef)

        if snapshot?.exists != true {
            try await threadRef.setData([
                "titleId": titleID,
                "visibility": "public",
                "contextType": "public",
                "contextId": "s\(season)e\(episode)",
                "participants": [],
                "groupName": "Discussione episodio",
                "createdBy": createdBy,
                "createdAt": FieldValue.serverTimestamp(),
                "lastMessageAt": NSNull(),
                "lastMessagePreview": "",
                "lastSenderUid": NSNull(),
                "lastMessageId": NSNull()
            ])
        }

        guard let thread = try await fetchThread(id: threadID) else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Thread episodio non disponibile.")
            ])
        }
        return thread
    }

    /// Crea (o recupera) il thread pubblico di una stagione. Specchio di
    /// `ensureEpisodePublicThread` con `contextId: "s<n>"`. Completa la scala
    /// titolo → stagione → episodio: prima esistevano solo il primo e il terzo
    /// livello, quindi "parliamo della stagione 2" non aveva un posto dove
    /// stare e finiva nel thread generale della serie (spoiler inclusi).
    func ensureSeasonPublicThread(
        titleID: String,
        season: Int,
        createdBy: String
    ) async throws -> AppThread {
        let threadID = threadIDForSeason(titleID: titleID, season: season)
        let threadRef = db.collection("threads").document(threadID)
        let snapshot = try await readThreadSnapshotIfAuthorized(threadRef)

        if snapshot?.exists != true {
            try await threadRef.setData([
                "titleId": titleID,
                "visibility": "public",
                "contextType": "public",
                "contextId": "s\(season)",
                "participants": [],
                "groupName": "Discussione stagione",
                "createdBy": createdBy,
                "createdAt": FieldValue.serverTimestamp(),
                "lastMessageAt": NSNull(),
                "lastMessagePreview": "",
                "lastSenderUid": NSNull(),
                "lastMessageId": NSNull()
            ])
        }

        guard let thread = try await fetchThread(id: threadID) else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Thread stagione non disponibile.")
            ])
        }
        return thread
    }

    /// Crea (o recupera) un thread DM 1:1 NON legato a un titolo, usato dal bottone
    /// "Invia messaggio" del profilo utente. L'ID è deterministico (`direct_<min>_<max>`),
    /// così evitiamo duplicati tra gli stessi due utenti.
    func ensureDirectThread(uidA: String, uidB: String, createdBy: String) async throws -> AppThread {
        guard !uidA.isEmpty, !uidB.isEmpty, uidA != uidB else {
            throw NSError(domain: "TwoWatch", code: 400, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Impossibile aprire una chat con questo utente.")
            ])
        }

        let pair = [uidA, uidB].sorted()
        let threadID = threadIDForDirect(uidA: uidA, uidB: uidB)
        let threadRef = db.collection("threads").document(threadID)
        let snapshot = try await readThreadSnapshotIfAuthorized(threadRef)

        if snapshot?.exists != true {
            try await threadRef.setData([
                "titleId": NSNull(),
                "visibility": "private",
                "contextType": "dm",
                "contextId": "\(pair[0])_\(pair[1])",
                "participants": pair,
                "groupName": "",
                "createdBy": createdBy,
                "createdAt": FieldValue.serverTimestamp(),
                "lastMessageAt": NSNull(),
                "lastMessagePreview": "",
                "lastSenderUid": NSNull(),
                "lastMessageId": NSNull()
            ])
        }

        guard let thread = try await fetchThread(id: threadID) else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Chat non disponibile.")
            ])
        }
        return thread
    }

    func ensureDMThread(titleID: String, uidA: String, uidB: String, createdBy: String) async throws -> AppThread {
        guard !titleID.isEmpty, !uidA.isEmpty, !uidB.isEmpty, uidA != uidB else {
            throw NSError(domain: "TwoWatch", code: 400, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Parametri DM non validi.")
            ])
        }

        let pair = [uidA, uidB].sorted()
        let threadID = threadIDForDM(titleID: titleID, uidA: uidA, uidB: uidB)
        let threadRef = db.collection("threads").document(threadID)
        let snapshot = try await readThreadSnapshotIfAuthorized(threadRef)

        if snapshot?.exists != true {
            try await threadRef.setData([
                "titleId": titleID,
                "visibility": "private",
                "contextType": "dm",
                "contextId": "\(pair[0])_\(pair[1])",
                "participants": pair,
                "groupName": "",
                "createdBy": createdBy,
                "createdAt": FieldValue.serverTimestamp(),
                "lastMessageAt": NSNull(),
                "lastMessagePreview": "",
                "lastSenderUid": NSNull(),
                "lastMessageId": NSNull()
            ])
        }

        guard let thread = try await fetchThread(id: threadID) else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Thread DM non disponibile.")
            ])
        }
        return thread
    }

    func ensureGroupThread(
        titleID: String? = nil,
        participantUIDs: [String],
        groupName: String,
        createdBy: String
    ) async throws -> AppThread {
        let participants = Array(Set(participantUIDs.filter { !$0.isEmpty })).sorted()
        guard participants.count >= 2 else {
            throw NSError(domain: "TwoWatch", code: 400, userInfo: [
                NSLocalizedDescriptionKey: "Servono almeno 2 partecipanti."
            ])
        }

        let threadID = threadIDForGroup(titleID: titleID, participantUIDs: participants)
        let threadRef = db.collection("threads").document(threadID)
        let snapshot = try await readThreadSnapshotIfAuthorized(threadRef)

        if snapshot?.exists != true {
            try await threadRef.setData([
                "titleId": titleID.map { $0 as Any } ?? NSNull(),
                "visibility": "private",
                "contextType": "group",
                "contextId": stableHash(participants.joined(separator: "_")),
                "participants": participants,
                "groupName": groupName.isEmpty ? "Gruppo" : groupName,
                "createdBy": createdBy,
                "createdAt": FieldValue.serverTimestamp(),
                "lastMessageAt": NSNull(),
                "lastMessagePreview": "",
                "lastSenderUid": NSNull(),
                "lastMessageId": NSNull()
            ])
        }

        guard let thread = try await fetchThread(id: threadID) else {
            throw NSError(domain: "TwoWatch", code: 404, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Thread di gruppo non disponibile.")
            ])
        }
        return thread
    }

    func fetchThread(id: String) async throws -> AppThread? {
        let snapshot = try await db.collection("threads").document(id).getDocument()
        return try await hydrateThreadSnapshots([snapshot]).first
    }

    func listMyThreadsPage(uid: String, pageSize: Int = 40, after cursor: DocumentSnapshot? = nil) async throws -> ThreadPage {
        var query: Query = db.collection("threads")
            .whereField("participants", arrayContains: uid)
            .order(by: "lastMessageAt", descending: true)
            .limit(to: pageSize)

        if let cursor {
            query = query.start(afterDocument: cursor)
        }

        return try await loadPage(query: query, pageSize: pageSize)
    }

    func listPublicThreadsPage(pageSize: Int = 40, after cursor: DocumentSnapshot? = nil) async throws -> ThreadPage {
        var query: Query = db.collection("threads")
            .whereField("visibility", isEqualTo: "public")
            .order(by: "lastMessageAt", descending: true)
            .limit(to: pageSize)

        if let cursor {
            query = query.start(afterDocument: cursor)
        }

        return try await loadPage(query: query, pageSize: pageSize)
    }

    /// Thread pubblici sui titoli passati, **senza ordinamento per recency**, per
    /// "Discussioni per te". Serve a far emergere le discussioni sui titoli che
    /// l'utente guarda anche quando `lastMessageAt` è vecchio — es. i thread
    /// creati dall'import dei commenti-episodio TV Time, che nascono con la data
    /// originale del commento e affondano sotto i 40 più recenti della
    /// `listPublicThreadsPage`. Query per `titleId in` (chunk da 30) +
    /// `visibility == public` (indice composito threads visibility+titleId; il
    /// filtro visibility è anche necessario a soddisfare le rules di lettura).
    func listPublicThreadsByTitleIDs(_ titleIDs: [String], inputCap: Int = 60) async throws -> [AppThread] {
        let ids = Array(Set(titleIDs.filter { !$0.isEmpty })).prefix(inputCap)
        guard !ids.isEmpty else { return [] }

        let chunks = stride(from: 0, to: ids.count, by: 30).map { start in
            Array(ids[start..<min(start + 30, ids.count)])
        }

        var snapshots: [DocumentSnapshot] = []
        for chunk in chunks {
            let snap = try await db.collection("threads")
                .whereField("visibility", isEqualTo: "public")
                .whereField("titleId", in: chunk)
                .getDocuments()
            snapshots.append(contentsOf: snap.documents.map { $0 as DocumentSnapshot })
        }
        guard !snapshots.isEmpty else { return [] }
        return try await hydrateThreadSnapshots(snapshots)
    }

    /// Thread pubblici di **un solo** titolo, per l'esploratore delle
    /// discussioni. Nessun ordinamento per recency: servono TUTTI i thread di
    /// quel titolo (serie + stagioni + episodi), che la view raggruppa poi per
    /// ambito. Stesso indice composito `visibility + titleId` già usato da
    /// `listPublicThreadsByTitleIDs`.
    func listPublicThreadsForTitle(_ titleID: String) async throws -> [AppThread] {
        guard !titleID.isEmpty else { return [] }
        let snapshot = try await db.collection("threads")
            .whereField("visibility", isEqualTo: "public")
            .whereField("titleId", isEqualTo: titleID)
            .getDocuments()
        guard !snapshot.documents.isEmpty else { return [] }
        return try await hydrateThreadSnapshots(snapshot.documents.map { $0 as DocumentSnapshot })
    }

    /// Discussioni **pubbliche** recuperate per id. Usato da "Messaggi" per
    /// ricaricare quelle che l'utente ha davvero aperto: i thread pubblici
    /// hanno `participants: []`, quindi non sono raggiungibili con la query
    /// per partecipante.
    ///
    /// Filtra sul prefisso `public_` prima di interrogare: in Firestore una
    /// query fallisce **per intero** se anche un solo documento restituito non
    /// passa le rules, e fra gli id noti localmente può esserci un gruppo da
    /// cui l'utente è stato rimosso. I thread privati arrivano comunque da
    /// `listMyThreadsPage`, quindi qui non servono.
    func listPublicThreadsByIDs(_ ids: [String], inputCap: Int = 60) async throws -> [AppThread] {
        let unique = Array(Set(ids.filter { $0.hasPrefix("public_") })).prefix(inputCap)
        guard !unique.isEmpty else { return [] }

        let chunks = stride(from: 0, to: unique.count, by: 30).map { start in
            Array(unique[start..<min(start + 30, unique.count)])
        }

        var snapshots: [DocumentSnapshot] = []
        for chunk in chunks {
            // Un chunk che fallisce non deve azzerare tutta la sezione.
            guard let snap = try? await db.collection("threads")
                .whereField(FieldPath.documentID(), in: chunk)
                .getDocuments()
            else { continue }
            snapshots.append(contentsOf: snap.documents.map { $0 as DocumentSnapshot })
        }
        guard !snapshots.isEmpty else { return [] }
        return try await hydrateThreadSnapshots(snapshots)
    }

    /// Gli id dei thread che questo dispositivo ha già aperto (registrati da
    /// `markThreadRead`). È il segnale locale di "discussioni che seguo":
    /// non richiede nuovi campi né query server.
    func knownThreadIDs() -> [String] {
        let reads = UserDefaults.standard.dictionary(forKey: SomtoDefaultsKey.threadReads) as? [String: Double] ?? [:]
        return reads
            .sorted { $0.value > $1.value }
            .map(\.key)
    }

    func listenMessages(threadID: String, limit: Int = 500, onChange: @escaping ([ThreadMessage]) -> Void) -> ListenerRegistration {
        db.collection("threads")
            .document(threadID)
            .collection("messages")
            .order(by: "createdAt", descending: false)
            .limit(to: limit)
            .addSnapshotListener { snapshot, _ in
                let documents = snapshot?.documents ?? []
                let messages = documents.compactMap(self.snapshotToMessage)
                onChange(messages)
            }
    }

    func listenTyping(threadID: String, currentUserID: String, onChange: @escaping ([ThreadTypingUser]) -> Void) -> ListenerRegistration {
        db.collection("threads")
            .document(threadID)
            .collection("typing")
            .addSnapshotListener { snapshot, _ in
                let now = Date()
                let typingUsers = (snapshot?.documents ?? []).compactMap { document -> ThreadTypingUser? in
                    guard document.documentID != currentUserID else { return nil }
                    let data = document.data()
                    guard
                        let displayName = FirestoreValueReader.string(data, key: "displayName"),
                        let timestamp = FirestoreValueReader.date(data["timestamp"]),
                        now.timeIntervalSince(timestamp) < 8
                    else {
                        return nil
                    }

                    return ThreadTypingUser(id: document.documentID, displayName: displayName)
                }
                onChange(typingUsers)
            }
    }

    func sendMessage(
        threadID: String,
        senderUID: String,
        displayName: String,
        text: String,
        ensurePublicForTitleID: String? = nil,
        containsSpoiler: Bool = false,
        spoilerTitleIDs: [String] = [],
        gifURL: String? = nil
    ) async throws {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let gif = gifURL?.trimmingCharacters(in: .whitespacesAndNewlines)
        let isGif = !(gif ?? "").isEmpty
        guard !threadID.isEmpty, !senderUID.isEmpty else { return }
        // Per una GIF il corpo testuale può essere vuoto (caption opzionale).
        if !isGif {
            guard !body.isEmpty else { return }
        }

        _ = displayName

        var payload: [String: any Sendable] = [
            "threadId": threadID,
            "text": body
        ]
        if isGif, let gif {
            payload["type"] = "gif"
            payload["gifUrl"] = gif
        }
        if let titleID = ensurePublicForTitleID, !titleID.isEmpty {
            payload["ensurePublicForTitleId"] = titleID
        }
        if containsSpoiler {
            payload["containsSpoiler"] = true
            // Cap a 5 + filtra vuoti per allinearsi alle rules.
            let cleaned = spoilerTitleIDs
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            payload["spoilerTitleIds"] = Array(cleaned.prefix(5))
        }

        _ = try await invokeCallable(name: "sendThreadMessage", payload: payload)

        analytics.log(AnalyticsEvent.threadMessageSent, [
            "thread_id": threadID
        ])
    }

    /// Cerca GIF via callable `gifSearch` (backend Giphy). Query vuota → trending.
    /// La `offset` serve alla paginazione. Il backend può lanciare
    /// `failed-precondition` se la GIPHY_API_KEY non è configurata: l'errore
    /// risale al chiamante che mostra uno stato "GIF non disponibili".
    func searchGifs(query: String, offset: Int) async throws -> [GifResult] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = try await invokeCallable(name: "gifSearch", payload: [
            "action": trimmed.isEmpty ? "trending" : "search",
            "query": trimmed,
            "limit": 24,
            "offset": max(0, offset)
        ])

        guard let data = result.data as? [String: Any] else { return [] }
        let rawResults = data["results"] as? [Any] ?? []
        return rawResults.compactMap { item -> GifResult? in
            guard
                let dict = item as? [String: Any],
                let id = FirestoreValueReader.string(dict, key: "id"),
                let gifUrl = FirestoreValueReader.string(dict, key: "gifUrl"),
                !gifUrl.isEmpty
            else { return nil }

            let previewUrl = FirestoreValueReader.string(dict, key: "previewUrl") ?? gifUrl
            return GifResult(
                id: id,
                gifUrl: gifUrl,
                previewUrl: previewUrl.isEmpty ? gifUrl : previewUrl,
                width: FirestoreValueReader.int(dict, key: "width") ?? 0,
                height: FirestoreValueReader.int(dict, key: "height") ?? 0
            )
        }
    }

    /// Aggiunge o rimuove la reaction dell'utente su un messaggio, scrivendo
    /// direttamente il campo `reactions.<emoji>` (arrayUnion/arrayRemove), come la
    /// web (`threads.api.js#toggleReaction`). Le rules consentono ai client l'update
    /// del solo campo `reactions` su un messaggio di un thread accessibile.
    func toggleReaction(
        threadID: String,
        messageID: String,
        emoji: String,
        uid: String,
        isAdding: Bool
    ) async throws {
        guard !threadID.isEmpty, !messageID.isEmpty, !emoji.isEmpty, !uid.isEmpty else { return }
        let messageRef = db.collection("threads")
            .document(threadID)
            .collection("messages")
            .document(messageID)
        // FieldPath (segmenti letterali) evita l'interpretazione dei punti/caratteri
        // speciali che l'emoji non ha, ma è comunque il modo robusto per un campo annidato.
        let field = FieldPath(["reactions", emoji])
        try await messageRef.updateData([
            field: isAdding ? FieldValue.arrayUnion([uid]) : FieldValue.arrayRemove([uid])
        ])
    }

    func setTyping(threadID: String, uid: String, displayName: String) async throws {
        try await db.collection("threads")
            .document(threadID)
            .collection("typing")
            .document(uid)
            .setData([
                "displayName": displayName,
                "timestamp": FieldValue.serverTimestamp()
            ], merge: true)
    }

    func clearTyping(threadID: String, uid: String) async {
        try? await db.collection("threads")
            .document(threadID)
            .collection("typing")
            .document(uid)
            .delete()
    }

    func markThreadRead(_ threadID: String) {
        var reads = UserDefaults.standard.dictionary(forKey: SomtoDefaultsKey.threadReads) as? [String: Double] ?? [:]
        reads[threadID] = Date().timeIntervalSince1970
        UserDefaults.standard.set(reads, forKey: SomtoDefaultsKey.threadReads)
    }

    func lastReadAt(for threadID: String) -> Date? {
        let reads = UserDefaults.standard.dictionary(forKey: SomtoDefaultsKey.threadReads) as? [String: Double] ?? [:]
        guard let timestamp = reads[threadID] else { return nil }
        return Date(timeIntervalSince1970: timestamp)
    }

    func isUnread(_ thread: AppThread) -> Bool {
        guard let lastMessageAt = thread.lastMessageAt else { return false }
        guard let lastReadAt = lastReadAt(for: thread.id) else { return true }
        return lastMessageAt > lastReadAt
    }

    /// Conta i messaggi non letti (DM + gruppi) dell'utente, per il badge in header
    /// e sull'icona app. Usa la stessa logica di `isUnread` (lastReadAt su UserDefaults).
    func fetchInboxUnreadCount(currentUserID uid: String) async -> Int {
        guard let page = try? await listMyThreadsPage(uid: uid) else { return 0 }
        return page.items.filter { !$0.isPublic && ($0.contextType == .dm || $0.contextType == .group) && isUnread($0) }.count
    }

    private func loadPage(query: Query, pageSize: Int) async throws -> ThreadPage {
        let snapshot = try await query.getDocuments()
        let items = try await hydrateThreadSnapshots(snapshot.documents.map { $0 as DocumentSnapshot })
        return ThreadPage(
            items: items,
            nextCursor: snapshot.documents.last,
            hasMore: snapshot.documents.count >= pageSize
        )
    }

    private func hydrateThreadSnapshots(_ snapshots: [DocumentSnapshot]) async throws -> [AppThread] {
        let titleIDs = Array(Set(snapshots.compactMap { snapshot in
            snapshot.data().flatMap { FirestoreValueReader.string($0, key: "titleId") }
        }))

        let participantIDs = Array(Set(snapshots.flatMap { snapshot -> [String] in
            FirestoreValueReader.stringArray(snapshot.data()?["participants"])
        }))

        async let titlesTask = titleRepository.listTitles(ids: titleIDs)
        async let usersTask = userRepository.listUsers(ids: participantIDs)
        let (titles, users) = try await (titlesTask, usersTask)

        let titleMap = Dictionary(uniqueKeysWithValues: titles.map { ($0.id, $0) })
        let userMap = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })

        return snapshots.compactMap { snapshot in
            snapshotToThread(snapshot, titles: titleMap, users: userMap)
        }
    }

    private func snapshotToThread(
        _ snapshot: DocumentSnapshot,
        titles: [String: Title],
        users: [String: AppUser]
    ) -> AppThread? {
        guard let data = snapshot.data() else { return nil }

        let titleID = FirestoreValueReader.string(data, key: "titleId")
        let participantIDs = FirestoreValueReader.stringArray(data["participants"])
        let visibility = ThreadVisibility(rawValue: FirestoreValueReader.string(data, key: "visibility") ?? "") ?? .privateThread
        let contextType = ThreadContextType(rawValue: FirestoreValueReader.string(data, key: "contextType") ?? "")
            ?? (visibility == .publicThread ? .public : .dm)

        return AppThread(
            id: snapshot.documentID,
            titleId: titleID,
            visibility: visibility,
            contextType: contextType,
            contextId: FirestoreValueReader.string(data, key: "contextId"),
            participants: participantIDs,
            groupName: FirestoreValueReader.string(data, key: "groupName") ?? "",
            createdBy: FirestoreValueReader.string(data, key: "createdBy") ?? "",
            createdAt: FirestoreValueReader.date(data["createdAt"]),
            lastMessageAt: FirestoreValueReader.date(data["lastMessageAt"]),
            lastMessagePreview: FirestoreValueReader.string(data, key: "lastMessagePreview") ?? "",
            lastSenderUid: FirestoreValueReader.string(data, key: "lastSenderUid"),
            title: titleID.flatMap { titles[$0] },
            participantUsers: participantIDs.compactMap { users[$0] }
        )
    }

    private func snapshotToMessage(_ snapshot: QueryDocumentSnapshot) -> ThreadMessage? {
        let data = snapshot.data()
        guard let uid = FirestoreValueReader.string(data, key: "uid") else { return nil }

        let rawReactions = FirestoreValueReader.map(data["reactions"])
        let reactions = rawReactions.reduce(into: [String: [String]]()) { partialResult, entry in
            partialResult[entry.key] = FirestoreValueReader.stringArray(entry.value)
        }

        let containsSpoiler = (data["containsSpoiler"] as? Bool) ?? false
        let spoilerTitleIDs = FirestoreValueReader.stringArray(data["spoilerTitleIds"])
        let gifUrl = FirestoreValueReader.string(data, key: "gifUrl")

        return ThreadMessage(
            id: snapshot.documentID,
            uid: uid,
            displayName: FirestoreValueReader.string(data, key: "displayName") ?? "Utente",
            text: FirestoreValueReader.string(data, key: "text") ?? "",
            type: FirestoreValueReader.string(data, key: "type") ?? "text",
            createdAt: FirestoreValueReader.date(data["createdAt"]),
            reactions: reactions,
            containsSpoiler: containsSpoiler,
            spoilerTitleIds: spoilerTitleIDs,
            gifUrl: (gifUrl?.isEmpty == false) ? gifUrl : nil
        )
    }

    private func readThreadSnapshotIfAuthorized(_ reference: DocumentReference) async throws -> DocumentSnapshot? {
        do {
            return try await reference.getDocument()
        } catch let error as NSError {
            let firestoreDenied = FirestoreErrorCode.Code(rawValue: error.code) == .permissionDenied
            if firestoreDenied {
                return nil
            }
            throw error
        }
    }

    private func stableHash(_ value: String) -> String {
        let hashed = value.unicodeScalars.reduce(UInt32(5381)) { partialResult, scalar in
            ((partialResult << 5) &+ partialResult) ^ UInt32(scalar.value)
        }
        return String(hashed, radix: 36, uppercase: false)
    }

    private func invokeCallable(name: String, payload: [String: any Sendable]) async throws -> CloudFunctionsCaller.CallableResult {
        try await CloudFunctionsCaller.call(name: name, data: payload)
    }

}
