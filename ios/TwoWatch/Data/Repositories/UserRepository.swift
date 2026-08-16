@preconcurrency import FirebaseAuth
@preconcurrency import FirebaseFirestore
@preconcurrency import FirebaseStorage
import Foundation

/// Stato dei doc legacy `users/{uid}/friends/{uid}`. Il grafo amicizie è in
/// dismissione (fase 1, 2026-07-29): l'app non crea né modifica più questi doc,
/// resta solo la lettura `listAcceptedFriends` finché i suoi caller non passano
/// a `following` (fase 2).
enum FriendshipStatus: String, Hashable {
    case accepted
}

struct UserRelationshipState: Hashable {
    let isFollowing: Bool
    let isBlockedByViewer: Bool

    var isBlocked: Bool {
        isBlockedByViewer
    }
}

@MainActor
final class UserRepository {
    private let db = Firestore.firestore()

    func ensureUserDocument(for authUser: User, preferredDisplayName: String?) async throws {
        let userRef = db.collection("users").document(authUser.uid)
        let snapshot = try await userRef.getDocument()

        if snapshot.exists {
            try await userRef.setData(["lastActiveAt": FieldValue.serverTimestamp()], merge: true)
            if let email = authUser.email, !email.isEmpty {
                try await db.collection("usersPrivate").document(authUser.uid).setData([
                    "email": email,
                    "updatedAt": FieldValue.serverTimestamp()
                ], merge: true)
            }
            return
        }

        let displayName = validatedDisplayName(
            preferredDisplayName ??
                authUser.displayName ??
                authUser.email?.components(separatedBy: "@").first ??
                "User"
        )
        let normalizedDisplayName = normalizeDisplayName(displayName)
        let photo = authUser.photoURL?.absoluteString ?? ""

        try await userRef.setData([
            "displayName": displayName,
            "displayNameLower": normalizedDisplayName,
            "photoURL": photo,
            "avatarURL": photo,
            "createdAt": FieldValue.serverTimestamp(),
            "lastActiveAt": FieldValue.serverTimestamp(),
            "privacyDefault": "public",
            "trusted": false,
            "isAdmin": false,
            "level": UserLevel.base.rawValue,
            "favoriteGenres": [],
            "communitySafetyAcceptedAt": NSNull(),
            "communitySafetyVersion": 0,
            "stats": [
                "ratingsCount": 0,
                "reviewsCount": 0,
                "watchedCount": 0,
                "totalWatchMinutes": 0,
                "rewatchCount": 0
            ]
        ])

        var privatePayload: [String: Any] = [
            "onboardingStatus": defaultOnboardingStatus(),
            "tasteProfile": defaultTasteProfile(),
            "updatedAt": FieldValue.serverTimestamp()
        ]
        if let email = authUser.email, !email.isEmpty {
            privatePayload["email"] = email
        }
        try await db.collection("usersPrivate").document(authUser.uid).setData(privatePayload, merge: true)
    }

    func fetchUser(uid: String) async throws -> AppUser? {
        let snapshot = try await db.collection("users").document(uid).getDocument()
        return snapshotToUser(snapshot)
    }

    func fetchRelationshipState(myUid: String, otherUid: String) async throws -> UserRelationshipState {
        guard !myUid.isEmpty, !otherUid.isEmpty, myUid != otherUid else {
            return UserRelationshipState(isFollowing: false, isBlockedByViewer: false)
        }

        async let followingSnap = db.collection("users")
            .document(myUid)
            .collection("following")
            .document(otherUid)
            .getDocument()

        async let blockedSnap = db.collection("users")
            .document(myUid)
            .collection("blockedUsers")
            .document(otherUid)
            .getDocument()

        let (followSnapshot, blockedSnapshot) = try await (followingSnap, blockedSnap)
        return UserRelationshipState(
            isFollowing: followSnapshot.exists,
            isBlockedByViewer: blockedSnapshot.exists
        )
    }

    /// Updates the user's display name and/or photo URL. The new display
    /// name is validated and normalized so the `displayNameLower` field
    /// used by search stays in sync.
    ///
    /// If `photoData` is provided it is uploaded to Storage at
    /// `users/{uid}/avatar.jpg` and the resulting download URL is written
    /// to `photoURL`. To clear the photo, pass `clearPhoto: true`.
    func updateProfile(
        userID: String,
        newDisplayName: String?,
        photoData: Data?,
        clearPhoto: Bool = false
    ) async throws {
        guard !userID.isEmpty else {
            throw NSError(domain: "TwoWatch.UserRepository", code: 400, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Sessione non valida.")
            ])
        }

        // Il nome pubblico passa per la reservation atomica (usernames + user
        // doc nella stessa transazione), come la PWA: evita lo split-brain in
        // cui un rename iOS lasciava l'handle non riservato.
        if let newDisplayName {
            try await reserveDisplayName(userID: userID, desiredName: newDisplayName)
        }

        // Foto / bump attivita'. Quando cambia solo il nome la transazione ha
        // gia' aggiornato lastActiveAt, quindi non riscriviamo a vuoto.
        var fields: [String: Any] = [:]

        if let photoData {
            let url = try await uploadAvatar(userID: userID, data: photoData)
            fields["photoURL"] = url.absoluteString
            fields["avatarURL"] = url.absoluteString
        } else if clearPhoto {
            fields["photoURL"] = FieldValue.delete()
            fields["avatarURL"] = FieldValue.delete()
        }

        if !fields.isEmpty {
            fields["lastActiveAt"] = FieldValue.serverTimestamp()
            try await db.collection("users").document(userID).setData(fields, merge: true)
        } else if newDisplayName == nil {
            try await db.collection("users").document(userID).setData([
                "lastActiveAt": FieldValue.serverTimestamp()
            ], merge: true)
        }
    }

    /// Riserva atomicamente l'handle pubblico in `usernames/{lower}` e scrive
    /// `displayName`/`displayNameLower` sul doc utente nella stessa transazione,
    /// cancellando la vecchia chiave. Specchio del `reserveDisplayNameCandidate`
    /// della PWA (`public/js/api/onboarding.api.js`) e conforme alle
    /// `firestore.rules` per `usernames` (write client-side, niente admin SDK).
    /// Lancia un errore localizzato se il nome e' gia' preso da un altro utente.
    private func reserveDisplayName(userID: String, desiredName: String) async throws {
        let validated = validatedDisplayName(desiredName)
        let normalized = normalizeDisplayName(validated)
        try await Self.commitDisplayNameReservation(
            db: db,
            userID: userID,
            validated: validated,
            normalized: normalized
        )
    }

    /// Transazione di reservation vera e propria. `nonisolated static` come
    /// `RateLimitedCreate`: il blocco di `runTransaction` non eredita
    /// l'isolamento `@MainActor` (Swift 6 lo rifiuterebbe come closure
    /// non-Sendable inviata a un metodo nonisolated). Riceve nome gia'
    /// validato/normalizzato dal chiamante MainActor.
    private nonisolated static func commitDisplayNameReservation(
        db: Firestore,
        userID: String,
        validated: String,
        normalized: String
    ) async throws {
        let userRef = db.collection("users").document(userID)
        let usernamesCol = db.collection("usernames")
        let newUsernameRef = usernamesCol.document(normalized)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            db.runTransaction({ (txn, errPtr) -> Any? in
                // Tutte le letture prima di qualsiasi scrittura (vincolo Firestore).
                let userSnap: DocumentSnapshot
                do {
                    userSnap = try txn.getDocument(userRef)
                } catch {
                    errPtr?.pointee = error as NSError
                    return nil
                }

                guard userSnap.exists else {
                    errPtr?.pointee = NSError(
                        domain: "TwoWatch.UserRepository",
                        code: 404,
                        userInfo: [NSLocalizedDescriptionKey: String(localized: "Profilo non trovato.")]
                    )
                    return nil
                }

                // La vecchia chiave e' gia' normalizzata (campo stored).
                let oldKey = (userSnap.get("displayNameLower") as? String) ?? ""

                let newUsernameSnap: DocumentSnapshot
                do {
                    newUsernameSnap = try txn.getDocument(newUsernameRef)
                } catch {
                    errPtr?.pointee = error as NSError
                    return nil
                }

                var oldRef: DocumentReference?
                if !oldKey.isEmpty, oldKey != normalized {
                    let ref = usernamesCol.document(oldKey)
                    let oldSnap: DocumentSnapshot
                    do {
                        oldSnap = try txn.getDocument(ref)
                    } catch {
                        errPtr?.pointee = error as NSError
                        return nil
                    }
                    if oldSnap.exists, (oldSnap.get("uid") as? String) == userID {
                        oldRef = ref
                    }
                }

                // Handle gia' di un altro utente → rifiuta.
                if newUsernameSnap.exists, (newUsernameSnap.get("uid") as? String) != userID {
                    errPtr?.pointee = NSError(
                        domain: "TwoWatch.UserRepository",
                        code: 409,
                        userInfo: [NSLocalizedDescriptionKey: String(localized: "Questo nome è già in uso. Scegline un altro.")]
                    )
                    return nil
                }

                let preservedCreatedAt = newUsernameSnap.exists
                    ? newUsernameSnap.get("createdAt")
                    : nil

                txn.setData([
                    "uid": userID,
                    "displayName": validated,
                    "displayNameLower": normalized,
                    "createdAt": preservedCreatedAt ?? FieldValue.serverTimestamp(),
                    "updatedAt": FieldValue.serverTimestamp()
                ], forDocument: newUsernameRef, merge: true)

                txn.setData([
                    "displayName": validated,
                    "displayNameLower": normalized,
                    "lastActiveAt": FieldValue.serverTimestamp()
                ], forDocument: userRef, merge: true)

                if let oldRef {
                    txn.deleteDocument(oldRef)
                }

                return nil
            }) { (_, error) in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func uploadAvatar(userID: String, data: Data) async throws -> URL {
        let path = "users/\(userID)/avatar.jpg"
        let ref = Storage.storage().reference(withPath: path)
        let metadata = StorageMetadata()
        metadata.contentType = "image/jpeg"
        _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<StorageMetadata, Error>) in
            ref.putData(data, metadata: metadata) { returned, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let returned {
                    continuation.resume(returning: returned)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "TwoWatch.UserRepository",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: "Upload immagine fallito."]
                    ))
                }
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            ref.downloadURL { url, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "TwoWatch.UserRepository",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: String(localized: "Download URL non disponibile.")]
                    ))
                }
            }
        }
    }

    func listUsers(ids: [String]) async throws -> [AppUser] {
        let uniqueIDs = Array(Set(ids.filter { !$0.isEmpty }))
        guard !uniqueIDs.isEmpty else { return [] }

        // Chunk in parallelo (max 30 id per query `in`, limite Firestore): prima
        // erano N/30 round-trip seriali, ora concorrenti via task group (velocizza
        // transitivamente listAcceptedFriends/listFollowers/listFollowing). Un
        // chunk che fallisce non deve far fallire l'intera lista → ritorna [] per
        // quel chunk. I task catturano solo `db` (Firestore, `@preconcurrency`) +
        // `chunk` ([String], Sendable), non `self`; il decode (`snapshotToUser`,
        // isolato al MainActor) resta fuori dai child task.
        let db = db
        var allDocuments: [QueryDocumentSnapshot] = []
        try await withThrowingTaskGroup(of: [QueryDocumentSnapshot].self) { group in
            for chunk in uniqueIDs.chunked(into: 30) {
                group.addTask {
                    do {
                        let snapshot = try await db.collection("users")
                            .whereField(FieldPath.documentID(), in: chunk)
                            .getDocuments()
                        return snapshot.documents
                    } catch {
                        return []
                    }
                }
            }
            for try await documents in group {
                allDocuments.append(contentsOf: documents)
            }
        }

        var usersByID: [String: AppUser] = [:]
        for document in allDocuments {
            if let user = snapshotToUser(document) {
                usersByID[user.id] = user
            }
        }

        return uniqueIDs.compactMap { usersByID[$0] }
    }

    func searchUsers(prefix: String, limit: Int = 20) async throws -> [AppUser] {
        let normalized = normalizeDisplayName(prefix)
        guard !normalized.isEmpty else { return [] }

        let snapshot = try await db.collection("users")
            .order(by: "displayNameLower")
            .start(at: [normalized])
            .end(at: [normalized + "\u{f8ff}"])
            .limit(to: limit)
            .getDocuments()

        return snapshot.documents.compactMap(snapshotToUser)
    }

    func listAcceptedFriends(userID: String, limit: Int = 120) async throws -> [AppUser] {
        guard !userID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }

        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("friends")
            .whereField("status", isEqualTo: FriendshipStatus.accepted.rawValue)
            .limit(to: limit)
            .getDocuments()

        return try await listUsers(ids: snapshot.documents.map(\.documentID))
    }

    func listFollowers(userID: String, limit: Int = 120) async throws -> [AppUser] {
        try await listUsersInSubcollection(userID: userID, subcollection: "followers", limit: limit)
    }

    func listFollowing(userID: String, limit: Int = 120) async throws -> [AppUser] {
        try await listUsersInSubcollection(userID: userID, subcollection: "following", limit: limit)
    }

    func followUser(myUid: String, targetUid: String) async throws {
        guard !myUid.isEmpty, !targetUid.isEmpty, myUid != targetUid else { return }

        let batch = db.batch()
        let now = FieldValue.serverTimestamp()

        batch.setData([
            "createdAt": now
        ], forDocument: db.collection("users").document(myUid).collection("following").document(targetUid), merge: true)

        batch.setData([
            "createdAt": now
        ], forDocument: db.collection("users").document(targetUid).collection("followers").document(myUid), merge: true)

        try await batch.commit()
    }

    func unfollowUser(myUid: String, targetUid: String) async throws {
        try await deleteFollowEdge(myUid: myUid, targetUid: targetUid)
    }


    func acceptCommunitySafetyTerms(userID: String) async throws {
        guard !userID.isEmpty else { return }

        try await db.collection("users")
            .document(userID)
            .setData([
                "communitySafetyAcceptedAt": FieldValue.serverTimestamp(),
                "communitySafetyVersion": CommunitySafetyPolicy.currentVersion,
                "communitySafetyAcceptedSource": CommunitySafetyPolicy.acceptanceSource,
                "lastActiveAt": FieldValue.serverTimestamp()
            ], merge: true)
    }

    func fetchBlockedUserIDs(userID: String, limit: Int = 300) async throws -> [String] {
        guard !userID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }

        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("blockedUsers")
            .limit(to: limit)
            .getDocuments()

        return snapshot.documents.map(\.documentID)
    }

    func blockUser(myUid: String, targetUid: String, source: String = "ios_chat") async throws {
        guard !myUid.isEmpty, !targetUid.isEmpty, myUid != targetUid else { return }

        let now = FieldValue.serverTimestamp()
        let batch = db.batch()

        batch.setData([
            "blockedUid": targetUid,
            "source": source,
            "createdAt": now,
            "updatedAt": now
        ], forDocument: db.collection("users").document(myUid).collection("blockedUsers").document(targetUid), merge: true)

        batch.deleteDocument(db.collection("users").document(myUid).collection("following").document(targetUid))
        batch.deleteDocument(db.collection("users").document(targetUid).collection("followers").document(myUid))
        batch.deleteDocument(db.collection("users").document(myUid).collection("friends").document(targetUid))
        batch.deleteDocument(db.collection("users").document(targetUid).collection("friends").document(myUid))

        try await batch.commit()
    }

    func unblockUser(myUid: String, targetUid: String) async throws {
        guard !myUid.isEmpty, !targetUid.isEmpty, myUid != targetUid else { return }

        try await db.collection("users")
            .document(myUid)
            .collection("blockedUsers")
            .document(targetUid)
            .delete()
    }

    /// ID degli utenti bloccati dal viewer. Alimenta la cache
    /// `SessionStore.blockedUserIDs` usata da feed e commenti per la
    /// rimozione immediata dei contenuti (Guideline 1.2).
    func listBlockedUserIDs(myUid: String) async throws -> Set<String> {
        guard !myUid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }

        let snapshot = try await db.collection("users")
            .document(myUid)
            .collection("blockedUsers")
            .getDocuments()

        return Set(snapshot.documents.map(\.documentID))
    }

    /// Crea un report `reports/{id}` passando per il rate-limit helper: le
    /// rules richiedono che `users/{uid}/rateLimits/reports` sia incrementato
    /// atomicamente con la create (cap 20/24h). La rule impone anche
    /// `createdAt == request.time`, quindi `createdAt` è un Timestamp
    /// corrente (non `serverTimestamp()` che non sarebbe ancora risolto al
    /// check).
    func submitModerationReport(
        fromUid: String,
        type: String,
        targetId: String,
        reason: String,
        metadata: sending [String: Any] = [:]
    ) async throws {
        let normalizedFromUid = fromUid.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedType = type.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedTargetID = targetId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalizedFromUid.isEmpty, !normalizedType.isEmpty, !normalizedTargetID.isEmpty, !normalizedReason.isEmpty else {
            throw NSError(domain: "TwoWatch", code: 422, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Impossibile inviare la segnalazione.")
            ])
        }

        let ref = db.collection("reports").document()
        var payload: [String: Any] = [
            "fromUid": normalizedFromUid,
            "type": normalizedType,
            "targetId": normalizedTargetID,
            "reason": String(normalizedReason.prefix(240)),
            "status": "pending",
            // serverTimestamp: in rules il transform vale `request.time` — un
            // Timestamp client non passa mai `createdAt == request.time`.
            "createdAt": FieldValue.serverTimestamp(),
            "updatedAt": FieldValue.serverTimestamp()
        ]

        for (key, value) in metadata {
            payload[key] = value
        }

        _ = try await RateLimitedCreate.createWithRateLimit(
            uid: normalizedFromUid,
            action: .reports,
            targetRef: ref,
            payload: payload
        )
    }

    func reportUser(fromUid: String, targetUid: String, reason: String = "Profilo segnalato per comportamento abusivo.") async throws {
        try await submitModerationReport(
            fromUid: fromUid,
            type: "user",
            targetId: targetUid,
            reason: reason,
            metadata: [
                "source": "ios_profile"
            ]
        )
    }

    private func snapshotToUser(_ snapshot: DocumentSnapshot) -> AppUser? {
        guard let data = snapshot.data() else { return nil }
        let stats = FirestoreValueReader.map(data["stats"])
        let level = UserLevel(rawValue: FirestoreValueReader.string(data, key: "level") ?? "") ?? .base

        return AppUser(
            id: snapshot.documentID,
            displayName: FirestoreValueReader.string(data, key: "displayName") ?? "Utente",
            displayNameLower: FirestoreValueReader.string(data, key: "displayNameLower") ?? "",
            photoURL: URL(string: FirestoreValueReader.string(data, key: "photoURL") ?? ""),
            avatarURL: URL(string: FirestoreValueReader.string(data, key: "avatarURL") ?? ""),
            trusted: FirestoreValueReader.bool(data, key: "trusted") ?? false,
            isAdmin: FirestoreValueReader.bool(data, key: "isAdmin") ?? false,
            level: level,
            stats: UserStats(
                ratingsCount: FirestoreValueReader.int(stats, key: "ratingsCount") ?? 0,
                reviewsCount: FirestoreValueReader.int(stats, key: "reviewsCount") ?? 0,
                watchedCount: FirestoreValueReader.int(stats, key: "watchedCount") ?? 0,
                totalWatchMinutes: FirestoreValueReader.int(stats, key: "totalWatchMinutes") ?? 0,
                rewatchCount: FirestoreValueReader.int(stats, key: "rewatchCount") ?? 0,
                derivedRatingsCount: FirestoreValueReader.int(stats, key: "derivedRatingsCount") ?? 0,
                byCategory: CategoryActivity.breakdown(from: stats["byCategory"])
            ),
            favoriteGenres: FirestoreValueReader.stringArray(data["favoriteGenres"]),
            communitySafetyAcceptedAt: FirestoreValueReader.date(data["communitySafetyAcceptedAt"]),
            communitySafetyVersion: FirestoreValueReader.int(data, key: "communitySafetyVersion") ?? 0,
            accountType: FirestoreValueReader.string(data, key: "accountType") ?? "real_user",
            isSynthetic: FirestoreValueReader.bool(data, key: "isSynthetic") ?? false,
            bio: FirestoreValueReader.string(data, key: "bio") ?? "",
            verified: FirestoreValueReader.bool(data, key: "verified") ?? false
        )
    }

    /// Profili suggeriti per lo step "Segui qualcuno" dell'onboarding v2.
    ///
    /// Primario: chi ha in libreria i titoli appena scelti dall'utente
    /// (collectionGroup su `library`), ordinato per quanti titoli in comune —
    /// è il segnale più rilevante che abbiamo al primo minuto. Fallback quando
    /// la coincidenza rende poco (catalogo grande, base utenti piccola): i
    /// profili con più titoli visti.
    ///
    /// La libreria è già contenuto pubblico del profilo (tab "Visti"), quindi
    /// la query non espone niente che il profilo non mostri già; serve però la
    /// rule collection-group e il `fieldOverride` su `titleId`.
    func suggestedProfilesToFollow(
        seedTitleIds: [String],
        excluding excludedUids: Set<String>,
        limit: Int = 8
    ) async throws -> [SuggestedProfile] {
        var sharedTitleCount: [String: Int] = [:]

        // Cappato a 4 titoli: con 3 seed sono 3 query, e il costo di lettura
        // resta lineare e prevedibile anche se un giorno i seed crescono.
        for titleID in seedTitleIds.prefix(4) {
            let snapshot = try? await db.collectionGroup("library")
                .whereField("titleId", isEqualTo: titleID)
                .limit(to: 30)
                .getDocuments()

            for document in snapshot?.documents ?? [] {
                // path: users/{uid}/library/{titleId}
                guard let ownerUid = document.reference.parent.parent?.documentID,
                      !excludedUids.contains(ownerUid) else { continue }
                sharedTitleCount[ownerUid, default: 0] += 1
            }
        }

        // A parità di titoli in comune l'ordine dei dizionari non è stabile:
        // spareggio sull'uid così la lista non balla tra due aperture.
        var rankedUids = sharedTitleCount
            .sorted { ($0.value, $1.key) > ($1.value, $0.key) }
            .map(\.key)

        if rankedUids.count < limit {
            let fallback = try? await db.collection("users")
                .order(by: "stats.watchedCount", descending: true)
                .limit(to: limit * 3)
                .getDocuments()

            let seen = Set(rankedUids)
            for document in fallback?.documents ?? [] {
                let uid = document.documentID
                guard !excludedUids.contains(uid), !seen.contains(uid) else { continue }
                rankedUids.append(uid)
                if rankedUids.count >= limit { break }
            }
        }

        let selected = Array(rankedUids.prefix(limit))
        let users = try await listUsers(ids: selected)

        // `listUsers` non conserva l'ordine (query `in` a chunk): riordino sul
        // ranking, e scarto i profili senza nome pubblico — una riga "Segui"
        // senza nome non è seguibile in modo sensato.
        let byID = Dictionary(users.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return selected.compactMap { uid in
            guard let user = byID[uid],
                  !user.displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            return SuggestedProfile(user: user, sharedTitleCount: sharedTitleCount[uid] ?? 0)
        }
    }

    private func listUsersInSubcollection(userID: String, subcollection: String, limit: Int) async throws -> [AppUser] {
        guard !userID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }

        let snapshot = try await db.collection("users")
            .document(userID)
            .collection(subcollection)
            .limit(to: limit)
            .getDocuments()

        return try await listUsers(ids: snapshot.documents.map(\.documentID))
    }

    private func deleteFollowEdge(myUid: String, targetUid: String) async throws {
        guard !myUid.isEmpty, !targetUid.isEmpty, myUid != targetUid else { return }

        let batch = db.batch()
        batch.deleteDocument(db.collection("users").document(myUid).collection("following").document(targetUid))
        batch.deleteDocument(db.collection("users").document(targetUid).collection("followers").document(myUid))
        try await batch.commit()
    }

    private func validatedDisplayName(_ value: String) -> String {
        let folded = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.diacriticInsensitive], locale: .current)

        var normalized = ""
        normalized.reserveCapacity(min(folded.count, 24))
        var lastWasSeparator = false

        for scalar in folded.unicodeScalars {
            let value = scalar.value
            let isASCIIAlphanumeric =
                (value >= 48 && value <= 57)
                || (value >= 65 && value <= 90)
                || (value >= 97 && value <= 122)

            if isASCIIAlphanumeric {
                normalized.unicodeScalars.append(scalar)
                lastWasSeparator = false
            } else if normalized.isEmpty == false && lastWasSeparator == false {
                normalized.append("_")
                lastWasSeparator = true
            }

            if normalized.count >= 24 {
                break
            }
        }

        let trimmed = normalized.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        if trimmed.count >= 3 {
            return trimmed
        }
        if trimmed.isEmpty {
            return "User"
        }
        return String((trimmed + "000").prefix(3))
    }

    private func normalizeDisplayName(_ value: String) -> String {
        validatedDisplayName(value).lowercased()
    }

    private func defaultOnboardingStatus() -> [String: Any] {
        [
            "version": 1,
            "startedAt": NSNull(),
            "completedAt": NSNull(),
            "completedLevel": 0,
            "lastPromptAt": NSNull(),
            "dismissedAt": NSNull(),
            "confidenceScore": 0
        ]
    }

    private func defaultTasteProfile() -> [String: Any] {
        [
            "seedTitleIds": [],
            "seedLikedTitleIds": [],
            "vibe": [],
            "filmVsSeries": "mix",
            "mainstream": "mix",
            "era": NSNull(),
            "context": [],
            "dislikes": [],
            "favoriteTitleText": NSNull(),
            "contentTolerance": NSNull(),
            "updatedAt": FieldValue.serverTimestamp()
        ]
    }

    // MARK: - Onboarding

    /// True se l'utente non ha ancora visto l'onboarding a tutto schermo:
    /// livello non completato e mai mostrato. Specchio della logica
    /// `shouldShowFullscreen` dell'onboarding della PWA.
    ///
    /// `tourSeenVersion` non viene più letto (il tour a slide è morto con
    /// l'onboarding v2) ma resta sui doc esistenti: nessuna migrazione
    /// distruttiva, vedi `docs/ONBOARDING_V2.md`.
    func fetchOnboardingNeedsPrompt(uid: String) async throws -> Bool {
        let snapshot = try await db.collection("usersPrivate").document(uid).getDocument()
        guard let status = snapshot.data()?["onboardingStatus"] as? [String: Any] else {
            return true
        }
        let completedLevel = (status["completedLevel"] as? Int) ?? 0
        let alreadyPrompted = (status["lastPromptAt"] as? Timestamp) != nil
        return completedLevel < 1 && !alreadyPrompted
    }

    /// Onboarding completato (livello 1): salva i titoli seme nel taste
    /// profile e marca lo stato. Scrive su `usersPrivate`, come la PWA.
    func completeOnboarding(uid: String, seedTitleIds: [String]) async throws {
        let seeds = Array(seedTitleIds.prefix(24))
        let confidenceScore = 30 + min(22, seeds.count * 2)
        try await db.collection("usersPrivate").document(uid).setData([
            "onboardingStatus": [
                "version": 1,
                "completedLevel": 1,
                "completedAt": FieldValue.serverTimestamp(),
                "lastPromptAt": FieldValue.serverTimestamp(),
                "confidenceScore": confidenceScore
            ],
            "tasteProfile": [
                "seedTitleIds": seeds,
                "updatedAt": FieldValue.serverTimestamp()
            ],
            "updatedAt": FieldValue.serverTimestamp()
        ], merge: true)
    }

    /// Timbra la risposta alla domanda d'ingresso dell'onboarding v2 ("hai già
    /// una cronologia da portare?"). `source` è `trakt | tvtime_gdpr |
    /// netflix_csv | letterboxd | none`. Nessuna modifica alle rules: la write
    /// su `usersPrivate` è owner-only senza allowlist di campi.
    func markOnboardingSource(uid: String, source: String) async throws {
        try await db.collection("usersPrivate").document(uid).setData([
            "onboardingStatus": [
                "flowVersion": 2,
                "source": source,
                "startedAt": FieldValue.serverTimestamp()
            ],
            "updatedAt": FieldValue.serverTimestamp()
        ], merge: true)
    }

    /// Onboarding saltato: marca solo che è stato mostrato, senza completarlo.
    func markOnboardingSkipped(uid: String) async throws {
        try await db.collection("usersPrivate").document(uid).setData([
            "onboardingStatus": [
                "lastPromptAt": FieldValue.serverTimestamp(),
                "dismissedAt": FieldValue.serverTimestamp()
            ],
            "updatedAt": FieldValue.serverTimestamp()
        ], merge: true)
    }
}
