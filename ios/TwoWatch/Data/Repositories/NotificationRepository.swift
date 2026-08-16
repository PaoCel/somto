@preconcurrency import FirebaseFirestore
import Foundation

@MainActor
final class NotificationRepository {
    private let db = Firestore.firestore()
    private let userRepository: UserRepository

    init(userRepository: UserRepository) {
        self.userRepository = userRepository
    }

    func fetchNotifications(userID: String, limit: Int = 60) async throws -> [AppNotification] {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("notifications")
            .order(by: "createdAt", descending: true)
            .limit(to: limit)
            .getDocuments()

        let fromUids = Array(Set(snapshot.documents.compactMap { document in
            FirestoreValueReader.string(document.data(), key: "fromUid")
        }))
        let users = try await userRepository.listUsers(ids: fromUids)
        let userMap = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })

        return snapshot.documents.compactMap { document in
            mapNotification(document: document, users: userMap)
        }
    }

    func markAsRead(userID: String, notificationID: String) async throws {
        try await db.collection("users")
            .document(userID)
            .collection("notifications")
            .document(notificationID)
            .setData(["read": true], merge: true)
    }

    func markAllAsRead(userID: String) async throws {
        let snapshot = try await db.collection("users")
            .document(userID)
            .collection("notifications")
            .whereField("read", isEqualTo: false)
            .limit(to: 200)
            .getDocuments()

        guard !snapshot.documents.isEmpty else { return }

        let batch = db.batch()
        for document in snapshot.documents {
            batch.setData(["read": true], forDocument: document.reference, merge: true)
        }
        try await batch.commit()
    }

    func destinationForPushPayload(_ payload: [AnyHashable: Any]) -> AppDestination {
        let type = payloadString(payload["type"])
        let payloadURL = payloadString(payload["url"]) ?? payloadString(payload["ctaUrl"])

        switch type {
        // friend_request/friend_accept sono legacy (grafo amicizie dismesso):
        // le notifiche già a DB portano al profilo di chi le ha generate.
        case "follow", "friend_request", "friend_accept", "new_user":
            if let uid = payloadString(payload["fromUid"]) ?? payloadString(payload["newUserUid"]) {
                return .profile(uid: uid)
            }
        case "thread_message", "thread_mention":
            if let threadID = payloadString(payload["threadId"]) {
                return .thread(id: threadID)
            }
            return .threads
        case "quiz_challenge", "quiz_challenge_completed":
            return .quizChallenges
        case "recommendation", "rating_like", "rating_comment":
            if let titleID = payloadString(payload["titleId"]) {
                return .title(id: titleID, focus: nil)
            }
        case "watched_with_tag":
            if let titleID = payloadString(payload["titleId"]) {
                return .title(id: titleID, focus: "rating")
            }
        case "comment_like":
            if let threadID = payloadString(payload["threadId"]) {
                return .thread(id: threadID)
            }
            if let postID = payloadString(payload["postId"]) ?? payloadString(payload["eventId"]) {
                return .post(id: postID)
            }
        case "post_mention", "post_like", "post_comment", "comment_reply", "official_update", "friend_post":
            if let postID = payloadString(payload["postId"]) ?? payloadString(payload["eventId"]) {
                return .post(id: postID)
            }
        case "admin_import_started":
            if let uid = payloadString(payload["importUid"]) ?? payloadString(payload["fromUid"]) {
                return .profile(uid: uid)
            }
        case "comment_review_pending":
            return webDestination(path: payloadURL ?? "/admin-import-comments.html")
        case "engagement_friend_watched":
            if let titleID = payloadString(payload["titleId"]) {
                return .title(id: titleID, focus: nil)
            }
        case "new_season_available":
            if let titleID = payloadString(payload["titleId"]) {
                return .title(id: titleID, focus: nil)
            }
        case "title_update":
            if let titleID = payloadString(payload["titleId"]) {
                let focus = TitleUpdateSupport.deepLinkFocus(
                    focus: "updates",
                    eventID: payloadString(payload["eventId"])
                )
                return .title(id: titleID, focus: focus)
            }
        case "titles_import_needs_review":
            return .titlesImport(importId: payloadString(payload["importId"]))
        case "titles_import_completed":
            return .watchlist
        case "titles_import_failed":
            return .titlesImport(importId: payloadString(payload["importId"]))
        case "engagement_watchlist_reminder":
            return .watchlist
        case "engagement_friend_activity":
            return .notifications
        default:
            break
        }

        if let payloadURL, let nativeDestination = nativeDestination(path: payloadURL) {
            return nativeDestination
        }

        guard let fallbackURL = makeURL(path: payloadURL ?? "/account.html?tab=activity") else {
            return .notifications
        }
        return .web(fallbackURL)
    }

    func destinationForURL(_ url: URL) -> AppDestination? {
        if let nativeDestination = nativeDestination(path: url.absoluteString) {
            return nativeDestination
        }

        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }

        return .web(url)
    }

    private func mapNotification(document: QueryDocumentSnapshot, users: [String: AppUser]) -> AppNotification? {
        let data = document.data()
        let nested = FirestoreValueReader.map(data["data"])
        let type = FirestoreValueReader.string(data, key: "type") ?? "generic"
        let fromUid = FirestoreValueReader.string(data, key: "fromUid")
        let toUid = FirestoreValueReader.string(data, key: "toUid")
        let fromUser = fromUid.flatMap { users[$0] }
        let fromName = FirestoreValueReader.string(nested["fromName"])
            ?? fromUser?.displayName
            ?? "Qualcuno"
        let preview = FirestoreValueReader.string(nested["preview"])
        let titleId = FirestoreValueReader.string(nested["titleId"])
        let postId = FirestoreValueReader.string(nested["postId"]) ?? FirestoreValueReader.string(nested["eventId"])
        let threadId = FirestoreValueReader.string(nested["threadId"])
        let titleName = FirestoreValueReader.string(nested["titleName"]) ?? String(localized: "un titolo")
        let context = FirestoreValueReader.string(nested["context"]) ?? ""
        let reaction = FirestoreValueReader.string(nested["reaction"])
        let ctaURL = FirestoreValueReader.string(nested["ctaUrl"])
        let createdAt = FirestoreValueReader.date(data["createdAt"])
        let importLabel = Self.importSourceLabel(FirestoreValueReader.string(nested["source"]))

        let icon: String
        let title: String
        let text: String?
        let destination: AppDestination

        switch type {
        case "recommendation":
            icon = "🎬"
            title = "\(fromName) ti ha consigliato un titolo"
            destination = .profileInbox
            text = nil
        case "follow":
            icon = "👀"
            title = "\(fromName) ha iniziato a seguirti"
            destination = destinationForProfile(fromUid)
            text = nil
        case "friend_request":
            icon = "🤝"
            title = "\(fromName) ti ha inviato una richiesta"
            destination = destinationForProfile(fromUid)
            text = nil
        case "friend_accept":
            icon = "✅"
            title = "\(fromName) ha accettato la richiesta"
            destination = destinationForProfile(fromUid)
            text = nil
        case "thread_message":
            icon = "💬"
            title = "\(fromName) ha scritto nel thread"
            text = preview?.prefix(100).description
            if let threadId {
                destination = .thread(id: threadId)
            } else {
                destination = .threads
            }
        case "thread_mention":
            icon = "@"
            title = "\(fromName) ti ha menzionato in un thread"
            text = preview?.prefix(100).description
            if let threadId {
                destination = .thread(id: threadId)
            } else {
                destination = .threads
            }
        case "quiz_challenge":
            icon = "🎯"
            let n = FirestoreValueReader.int(nested["numQuestions"]) ?? 0
            title = "\(fromName) ti ha sfidato a un quiz"
            text = n > 0 ? "\(n) domande da rispondere" : String(localized: "Apri la sfida nella sezione Quiz")
            destination = .quizChallenges
        case "quiz_challenge_completed":
            icon = "🏆"
            title = "\(fromName) ha completato la sfida"
            text = String(localized: "Vedi chi ha vinto e rivedi le risposte")
            destination = .quizChallenges
        case "post_mention":
            icon = "@"
            title = context == "rating_comment"
                ? "\(fromName) ti ha menzionato su un voto"
                : "\(fromName) ti ha menzionato"
            text = preview?.prefix(100).description
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        case "post_like":
            icon = "❤️"
            title = "\(fromName) ha messo like al tuo post"
            text = nil
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        case "post_comment":
            icon = "💬"
            title = "\(fromName) ha commentato il tuo post"
            text = preview?.prefix(100).description
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        case "comment_reply":
            icon = "↩️"
            title = "\(fromName) ha risposto al tuo commento"
            text = preview?.prefix(100).description
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        case "comment_like":
            if let threadId {
                icon = reaction ?? "👍"
                title = "\(fromName) ha reagito al tuo commento"
                text = reaction
                destination = .thread(id: threadId)
            } else {
                icon = "👍"
                title = "\(fromName) ha messo like al tuo commento"
                text = nil
                destination = destinationForHomePost(postId, fallbackTitleID: titleId)
            }
        case "rating_like":
            icon = "⭐"
            title = "\(fromName) ha reagito al tuo voto"
            text = nil
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        case "rating_comment":
            icon = "🗨️"
            title = "\(fromName) ha commentato la tua recensione"
            text = preview?.prefix(100).description
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        case "watched_with_tag":
            icon = "🍿"
            title = "\(fromName) ti ha taggato in una visione"
            text = "Hai visto \(titleName) insieme. Ti va di votarlo?"
            destination = destinationForTitle(titleId, focus: "rating")
        case "engagement_nudge":
            icon = "✨"
            title = FirestoreValueReader.string(nested["message"]) ?? "Nuovi titoli ti aspettano su Somto"
            text = nil
            destination = destinationForCTA(ctaURL)
        case "engagement_friend_watched":
            icon = "👁️"
            title = FirestoreValueReader.string(nested["message"]) ?? "\(fromName) ha visto \(titleName)"
            text = "Potrebbe interessarti!"
            destination = destinationForTitle(titleId, focus: nil)
        case "engagement_watchlist_reminder":
            icon = "📋"
            let count = FirestoreValueReader.int(nested["count"]) ?? 0
            title = count > 0
                ? "Hai \(count)+ titoli in watchlist da recuperare"
                : (FirestoreValueReader.string(nested["message"]) ?? String(localized: "Hai titoli in watchlist da recuperare"))
            text = String(localized: "Trova il momento giusto per il prossimo titolo.")
            destination = .watchlist
        case "engagement_friend_activity":
            icon = "👥"
            let count = FirestoreValueReader.int(nested["count"]) ?? 0
            title = count > 0
                ? "\(count) nuove attività dai tuoi amici"
                : (FirestoreValueReader.string(nested["message"]) ?? String(localized: "I tuoi amici sono stati attivi"))
            text = "Scopri cosa hanno visto e recensito."
            destination = destinationForCTA(ctaURL)
        case "moderation_pending":
            icon = "🛡️"
            title = FirestoreValueReader.string(nested["message"]) ?? String(localized: "C'è una nuova attività di moderazione")
            text = nil
            destination = webDestination(path: "/moderation.html")
        case "new_user":
            icon = "🆕"
            title = FirestoreValueReader.string(nested["message"]) ?? "\(fromName) si è appena registrato"
            text = nil
            destination = destinationForProfile(fromUid)
        case "new_season_available":
            icon = "🆕"
            let seasonNumber = FirestoreValueReader.int(nested["latestSeasonNumber"]) ?? 0
            let seriesName = FirestoreValueReader.string(nested["titleName"]) ?? String(localized: "una serie")
            title = seasonNumber > 0
                ? "Stagione \(seasonNumber) di \(seriesName) disponibile"
                : "\(seriesName) ha nuovi episodi"
            text = String(localized: "Riprendi a guardare quando vuoi.")
            destination = destinationForTitle(titleId, focus: nil)
        case "title_update":
            icon = "🎞️"
            let localizedMessage = localizedNotificationText(nested["messageByLocale"])
            let localizedHeadline = localizedNotificationText(nested["headlineByLocale"])
            title = localizedMessage
                ?? FirestoreValueReader.string(nested["preview"])
                ?? String(localized: "Aggiornamento titolo")
            text = localizedHeadline
            let focus = TitleUpdateSupport.deepLinkFocus(
                focus: "updates",
                eventID: FirestoreValueReader.string(nested["eventId"])
            )
            destination = destinationForTitle(titleId, focus: focus)
        case "official_update":
            icon = "✓"
            title = FirestoreValueReader.string(nested["title"]) ?? "Aggiornamento Somto"
            text = preview?.prefix(100).description
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        case "titles_import_completed":
            icon = "✅"
            title = "\(importLabel) completato"
            text = FirestoreValueReader.string(nested["message"]) ?? String(localized: "I risultati sono nella tua libreria.")
            destination = .watchlist
        case "titles_import_needs_review":
            icon = "🧩"
            title = "\(importLabel) da controllare"
            text = FirestoreValueReader.string(nested["message"]) ?? String(localized: "Alcuni titoli richiedono una conferma.")
            destination = .titlesImport(importId: FirestoreValueReader.string(nested["importId"]))
        case "titles_import_failed":
            icon = "⚠️"
            title = "\(importLabel) non riuscito"
            text = FirestoreValueReader.string(nested["message"]) ?? String(localized: "Puoi riprovare quando vuoi.")
            destination = .titlesImport(importId: FirestoreValueReader.string(nested["importId"]))
        case "admin_import_started":
            // Notifica agli admin quando un utente avvia un import.
            // Tap → profilo dell'utente che ha importato (importUid, fallback fromUid).
            icon = "📥"
            let importSource = FirestoreValueReader.string(nested["source"]) ?? ""
            let sourceLabel: String
            switch importSource {
            case "netflix_csv": sourceLabel = "Netflix"
            case "tvtime_gdpr", "tvtime_refract": sourceLabel = "TV Time"
            case "trakt": sourceLabel = "Trakt"
            default: sourceLabel = String(localized: "un servizio")
            }
            let rows = FirestoreValueReader.int(nested["totalRows"]) ?? 0
            title = "\(fromName) ha avviato un import \(sourceLabel)"
            text = rows > 0 ? "\(rows) righe da elaborare — apri il profilo" : String(localized: "Apri il profilo di chi ha importato")
            destination = destinationForProfile(FirestoreValueReader.string(nested["importUid"]) ?? fromUid)
        case "comment_review_pending":
            icon = "🗨️"
            let eligible = max(0, FirestoreValueReader.int(nested["eligible"]) ?? 0)
            let resolved = min(eligible, max(0, FirestoreValueReader.int(nested["resolved"]) ?? 0))
            title = eligible == 1
                ? "1 commento TV Time da revisionare"
                : "\(eligible) commenti TV Time da revisionare"
            text = resolved == eligible
                ? "\(fromName): tutti pronti per la revisione."
                : "\(fromName): \(resolved) di \(eligible) già associati ai titoli."
            destination = webDestination(path: ctaURL ?? "/admin-import-comments.html")
        case "friend_post":
            // Un utente che segui (o un amico) ha pubblicato un post a mano.
            icon = "📝"
            title = "\(fromName) ha pubblicato un post"
            text = preview?.prefix(100).description
            destination = destinationForHomePost(postId, fallbackTitleID: titleId)
        default:
            icon = "🔔"
            title = FirestoreValueReader.string(nested["message"])
                ?? FirestoreValueReader.string(nested["body"])
                ?? String(localized: "Nuova attività")
            text = preview
            destination = destinationForCTA(ctaURL)
        }

        let avatarURL = fromUser?.photoURL ?? fromUser?.avatarURL
        let avatarText = avatarURL == nil ? avatarText(for: fromName, icon: icon) : ""

        return AppNotification(
            id: document.documentID,
            type: type,
            fromUid: fromUid,
            toUid: toUid,
            read: FirestoreValueReader.bool(data, key: "read") ?? false,
            createdAt: createdAt,
            title: title,
            text: text,
            icon: icon,
            avatarURL: avatarURL,
            avatarText: avatarText,
            destination: destination
        )
    }

    private static func importSourceLabel(_ source: String?) -> String {
        switch source {
        case "netflix_csv":
            return "Import Netflix"
        case "tvtime_gdpr", "tvtime_refract":
            return "Import TV Time"
        case "trakt":
            return "Import Trakt"
        default:
            return "Import"
        }
    }

    private func avatarText(for name: String, icon: String) -> String {
        if icon == "@" {
            return "@"
        }

        let parts = name
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: \.isWhitespace)
        let first = parts.first?.first.map(String.init) ?? String(name.prefix(1))
        let last = parts.count > 1 ? parts.last?.first.map(String.init) ?? "" : ""
        let initials = (first + last).trimmingCharacters(in: .whitespacesAndNewlines)
        return initials.isEmpty ? icon : initials.uppercased()
    }

    private func destinationForProfile(_ uid: String?) -> AppDestination {
        guard let uid, !uid.isEmpty else { return .notifications }
        return .profile(uid: uid)
    }

    private func destinationForTitle(_ titleID: String?, focus: String?) -> AppDestination {
        guard let titleID, !titleID.isEmpty else { return .notifications }
        return .title(id: titleID, focus: focus)
    }

    private func localizedNotificationText(_ value: Any?) -> String? {
        let locale = (Bundle.main.preferredLocalizations.first ?? "it").lowercased()
        return TitleUpdateSupport.localizedText(value, preferredLocalization: locale)
    }

    private func destinationForHomePost(_ postID: String?, fallbackTitleID: String?) -> AppDestination {
        if let postID, !postID.isEmpty {
            return .post(id: postID)
        }
        return destinationForTitle(fallbackTitleID, focus: nil)
    }

    private func destinationForCTA(_ path: String?) -> AppDestination {
        let candidate = path ?? "/"
        if let nativeDestination = nativeDestination(path: candidate) {
            return nativeDestination
        }

        guard let url = makeURL(path: candidate) else { return .notifications }
        return .web(url)
    }

    private func webDestination(path: String) -> AppDestination {
        if let nativeDestination = nativeDestination(path: path) {
            return nativeDestination
        }

        guard let url = makeURL(path: path) else { return .notifications }
        return .web(url)
    }

    private func nativeDestination(path: String) -> AppDestination? {
        guard let url = makeURL(path: path),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            return nil
        }

        let queryItems = components.queryItems ?? []
        func queryValue(_ name: String) -> String? {
            queryItems.first(where: { $0.name == name })?.value
        }
        func titleFocus() -> String? {
            TitleUpdateSupport.deepLinkFocus(focus: queryValue("focus"), eventID: queryValue("event"))
        }

        switch components.path {
        case "/", "/home.html", "/index.html", "/community.html":
            if let postID = queryValue("post"), !postID.isEmpty {
                return .post(id: postID)
            }
            return nil
        // Pagine pubbliche degli aggiornamenti editoriali (`/novita/<slug>`,
        // funzione SSR `officialUpdatePage`). Sono l'URL che si condivide su
        // WhatsApp, quindi il link deve aprire l'app e non lasciare l'utente
        // nel browser.
        //
        // Lo slug e' il doc id del post senza il prefisso `official_`: la
        // stessa corrispondenza che usa la pagina web, quindi qui basta
        // rimetterlo senza risolvere niente in rete.
        case let path where path.hasPrefix("/novita/"):
            let slug = path
                .replacingOccurrences(of: "/novita/", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard !slug.isEmpty else { return nil }
            return .post(id: slug.hasPrefix("official_") ? slug : "official_\(slug)")
        // Il tap sul widget quando non c'e' ancora niente da mostrare, o sul
        // suo stato di errore. Non e' una pagina web che esiste: e' il modo che
        // ha il widget di dire all'app "spiegami".
        case "/widget", "/widget.html":
            return .widgetGuide
        case let path where path.hasPrefix("/share/title/"):
            let titleID = path
                .replacingOccurrences(of: "/share/title/", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !titleID.isEmpty {
                return .title(id: titleID, focus: titleFocus())
            }
            return nil
        // Pagine titolo pubbliche SSR: sono la superficie SEO principale
        // (chi arriva da Google atterra qui) ma portano lo slug leggibile,
        // non il doc id — la risoluzione avviene in `handleIncomingURL`.
        case let path where path.hasPrefix("/film/") || path.hasPrefix("/serie/"):
            let slug = path
                .replacingOccurrences(of: "/film/", with: "")
                .replacingOccurrences(of: "/serie/", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !slug.isEmpty {
                return .titleSlug(slug: slug, focus: queryValue("focus"))
            }
            return nil
        case let path where path.hasPrefix("/quiz/invite/"):
            let token = path
                .replacingOccurrences(of: "/quiz/invite/", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !token.isEmpty {
                return .quizInvite(token: token)
            }
            return nil
        case let path where path.hasPrefix("/lista/"):
            let slug = path
                .replacingOccurrences(of: "/lista/", with: "")
                .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if !slug.isEmpty {
                return .publicList(slug: slug)
            }
            return nil
        case "/threads.html":
            return .threads
        case "/thread.html":
            if let threadID = queryValue("tid") ?? queryValue("id"), !threadID.isEmpty {
                return .thread(id: threadID)
            }
            return .threads
        case "/account.html":
            if queryValue("tab") == "activity" {
                return .notifications
            }
            return nil
        case "/watchlist.html":
            return .watchlist
        case "/import.html":
            return .titlesImport(importId: queryValue("id"))
        case "/user.html":
            if let uid = queryValue("uid"), !uid.isEmpty {
                return .profile(uid: uid)
            }
            return nil
        case "/title.html":
            if let titleID = queryValue("id"), !titleID.isEmpty {
                return .title(id: titleID, focus: titleFocus())
            }
            return nil
        default:
            return nil
        }
    }

    private func makeURL(path: String) -> URL? {
        if let directURL = URL(string: path), directURL.scheme != nil {
            return directURL
        }

        guard var components = URLComponents(string: "https://somto.it") else {
            return nil
        }

        if path.hasPrefix("/") {
            if let relative = URLComponents(string: path) {
                components.path = relative.path
                components.query = relative.query
                components.fragment = relative.fragment
            } else {
                components.path = path
            }
        } else {
            components.path = "/" + path
        }

        return components.url
    }

    private func payloadString(_ value: Any?) -> String? {
        switch value {
        case let string as String where !string.isEmpty:
            return string
        case let string as NSString where string.length > 0:
            return string as String
        default:
            return nil
        }
    }
}
