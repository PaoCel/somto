@preconcurrency import FirebaseFirestore
@preconcurrency import FirebaseMessaging
import Foundation
import UIKit
import UserNotifications

@MainActor
final class PushNotificationsCoordinator {
    private let db = Firestore.firestore()
    private let notificationRepository: NotificationRepository
    private let analytics: AnalyticsLogging

    private weak var sessionStore: SessionStore?
    private weak var shellStore: AppShellStore?

    private var cachedFCMToken: String?
    private var registeredUserID: String?
    private var pendingDestination: AppDestination?
    private var lastHandledPayloadKey: String?
    /// Ultimo stato gia' riportato in questa sessione: evita di riscrivere lo
    /// stesso valore a ogni foreground. Il primo avvio dopo ogni apertura
    /// dell'app riporta comunque, cosi' `updatedAt` dice se un `denied` e'
    /// ancora vivo o e' il fossile di un utente sparito.
    private var lastReportedPermission: UNAuthorizationStatus?

    init(
        notificationRepository: NotificationRepository,
        analytics: AnalyticsLogging = NoopAnalyticsLogger()
    ) {
        self.notificationRepository = notificationRepository
        self.analytics = analytics
    }

    func bind(sessionStore: SessionStore, shellStore: AppShellStore) {
        self.sessionStore = sessionStore
        self.shellStore = shellStore
    }

    /// Sgancia il token push dall'utente corrente PRIMA del sign-out.
    ///
    /// Va chiamata mentre si e' ancora autenticati: la rule su
    /// `users/{uid}/notificationTokens` e' `isOwner(userId)`, quindi una
    /// cancellazione tentata DOPO il cambio di utente e' sempre negata.
    ///
    /// Non e' un dettaglio di pulizia: se il token resta, le push del vecchio
    /// account continuano ad arrivare su un dispositivo che nel frattempo usa
    /// un altro account. Su un telefono condiviso o rivenduto e' una fuga di
    /// dati, non un record stantio.
    func detachTokenBeforeSignOut() async {
        guard let userID = registeredUserID, let token = cachedFCMToken else { return }
        await removeToken(token, for: userID)
        registeredUserID = nil
    }

    func handleAuthenticationChange(to userID: String?) async {
        // Rete di sicurezza: se il sign-out e' passato da una via che non ha
        // chiamato `detachTokenBeforeSignOut()`, si prova comunque — ma solo
        // quando NON si e' gia' passati a un altro utente, perche' in quel caso
        // la scrittura sarebbe negata dalle rules e servirebbe solo a
        // sporcare i log.
        if let previousUserID = registeredUserID,
           previousUserID != userID,
           userID == nil,
           let cachedFCMToken {
            await removeToken(cachedFCMToken, for: previousUserID)
            registeredUserID = nil
        } else if let previousUserID = registeredUserID, previousUserID != userID {
            // Utente cambiato senza passare dal detach: il token del precedente
            // NON e' cancellabile da qui. Si azzera lo stato locale e si
            // segnala, cosi' il caso non resta invisibile.
            print("[push] token for \(previousUserID) was not detached before the user switch: it stays orphaned server-side")
            registeredUserID = nil
        }

        guard let userID else {
            await routePendingDestinationIfPossible()
            return
        }

        // PRIMA del guard qui sotto, non dopo: quel guard esce proprio quando
        // il permesso manca, cioe' nell'unico caso che vogliamo misurare.
        await reportAuthorizationStatus(for: userID)

        guard await ensureAuthorizationAndRegisterIfPossible(requestIfNeeded: false) else {
            await routePendingDestinationIfPossible()
            return
        }

        await refreshRegistrationToken()

        if let cachedFCMToken {
            await saveToken(cachedFCMToken, for: userID)
        }

        await routePendingDestinationIfPossible()
    }

    func handleAppBecomingActive(currentUserID: String?) async {
        guard let currentUserID, !currentUserID.isEmpty else { return }
        // Stesso motivo dell'avvio: il guard sotto esce quando il permesso
        // manca, quindi la misura va presa prima.
        await reportAuthorizationStatus(for: currentUserID)
        guard await ensureAuthorizationAndRegisterIfPossible(requestIfNeeded: false) else {
            await routePendingDestinationIfPossible()
            return
        }

        await refreshRegistrationToken()

        if let cachedFCMToken {
            await saveToken(cachedFCMToken, for: currentUserID)
        }

        await routePendingDestinationIfPossible()
    }

    func didReceiveRegistrationToken(_ token: String) async {
        guard !token.isEmpty else { return }

        let previousToken = cachedFCMToken
        cachedFCMToken = token

        guard let currentUserID = sessionStore?.firebaseUser?.uid else { return }

        if let previousToken,
           previousToken != token,
           registeredUserID == currentUserID {
            await removeToken(previousToken, for: currentUserID)
        }

        await saveToken(token, for: currentUserID)
    }

    func handleNotificationPayload(_ payload: [AnyHashable: Any]) async {
        let payloadKey = makePayloadKey(payload)
        guard payloadKey != lastHandledPayloadKey else { return }
        lastHandledPayloadKey = payloadKey

        analytics.log(AnalyticsEvent.notificationOpened, [
            "type": stringValue(payload["type"]),
            "target_id": notificationTargetID(payload)
        ])

        pendingDestination = notificationRepository.destinationForPushPayload(payload)
        await routePendingDestinationIfPossible()
    }

    private func notificationTargetID(_ payload: [AnyHashable: Any]) -> String {
        for key in ["threadId", "titleId", "postId", "fromUid", "newUserUid"] {
            let value = stringValue(payload[key])
            if !value.isEmpty { return value }
        }
        return ""
    }

    func routePendingDestinationIfPossible() async {
        guard let pendingDestination,
              let sessionStore,
              let shellStore,
              !sessionStore.isLoading
        else {
            return
        }

        let didRoute = shellStore.present(
            destination: pendingDestination,
            currentUserID: sessionStore.firebaseUser?.uid
        )

        if didRoute {
            self.pendingDestination = nil
        }
    }

    /// Nome stabile dello stato del permesso, per la telemetria su
    /// `usersPrivate`. Non usa `String(describing:)`: quello stampa il nome del
    /// case di `UNAuthorizationStatus` e cambierebbe sotto i piedi al primo
    /// rename di Apple, spezzando le serie storiche gia' raccolte.
    private static func permissionName(for status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }

    /// Riporta su `usersPrivate/{uid}.notificationPermission` lo stato del
    /// permesso notifiche di questo device.
    ///
    /// Perche' esiste: senza questo dato non sappiamo **perche'** un utente non
    /// ha le push, e le tre cause chiedono rimedi opposti — `denied` non si
    /// puo' piu' richiedere dal prompt di sistema (serve mandare l'utente in
    /// Impostazioni), `notDetermined` vuole solo un innesco, e `authorized`
    /// senza token e' un difetto di registrazione, non di UX. Al 2026-09-08:
    /// 273 utenti iOS, 43 con token, e nessun modo di dire in quale dei tre
    /// casi fossero gli altri 230.
    ///
    /// Va su `usersPrivate` (owner-only) e non su `users`, che invece e'
    /// leggibile da chiunque sia loggato: e' telemetria della persona, non
    /// contenuto del profilo. Nessuna modifica alle rules — la write su
    /// `usersPrivate` e' owner-only senza allowlist di campi.
    ///
    /// Scrive un OGGETTO annidato, non chiavi col punto: in `setData(merge:)`
    /// una chiave "a.b" e' un campo che si chiama letteralmente "a.b", non un
    /// path (footgun gia' costato tre cooldown morti, vedi CLAUDE.md).
    private func reportAuthorizationStatus(for userID: String) async {
        let status = await currentAuthorizationStatus()
        if lastReportedPermission == status { return }
        lastReportedPermission = status
        let payload: [String: Any] = [
            "notificationPermission": [
                "status": Self.permissionName(for: status),
                "platform": "ios",
                // Distingue il caso peggiore da diagnosticare: permesso
                // concesso ma nessun token registrato = problema di
                // registrazione APNs/FCM, che nessun banner puo' risolvere.
                "hasToken": cachedFCMToken != nil,
                "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
                "updatedAt": FieldValue.serverTimestamp()
            ]
        ]
        do {
            try await db.collection("usersPrivate").document(userID).setData(payload, merge: true)
        } catch {
            // Telemetria: non deve mai disturbare l'utente ne' bloccare il
            // flusso push. Si perde una misura, non una funzione.
            print("[push] Unable to report authorization status:", error.localizedDescription)
        }
    }

    func currentAuthorizationStatus() async -> UNAuthorizationStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus
    }

    func requestAuthorizationFromUser() async -> Bool {
        guard await ensureAuthorizationAndRegisterIfPossible(requestIfNeeded: true) else {
            // Il caso che conta: qui dentro c'e' il `denied` appena scelto, ed
            // e' l'unico momento in cui lo vediamo — dopo, il prompt di sistema
            // non si ripresenta piu' e lo stato resta invisibile all'app.
            if let userID = sessionStore?.firebaseUser?.uid {
                await reportAuthorizationStatus(for: userID)
            }
            return false
        }

        await refreshRegistrationToken()

        if let userID = sessionStore?.firebaseUser?.uid {
            if let cachedFCMToken {
                await saveToken(cachedFCMToken, for: userID)
            }
            await reportAuthorizationStatus(for: userID)
        }

        return true
    }

    private func ensureAuthorizationAndRegisterIfPossible(requestIfNeeded: Bool) async -> Bool {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()

        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
            return true
        case .notDetermined:
            guard requestIfNeeded else { return false }
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
                guard granted else { return false }
                UIApplication.shared.registerForRemoteNotifications()
                return true
            } catch {
                print("[push] Notification authorization failed:", error.localizedDescription)
                return false
            }
        case .denied:
            return false
        @unknown default:
            return false
        }
    }

    private func refreshRegistrationToken() async {
        do {
            let token = try await fetchMessagingToken()
            await didReceiveRegistrationToken(token)
        } catch {
            print("[push] Unable to refresh FCM token:", error.localizedDescription)
        }
    }

    private func fetchMessagingToken() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            Messaging.messaging().token { token, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let token, !token.isEmpty {
                    continuation.resume(returning: token)
                } else {
                    continuation.resume(throwing: PushNotificationCoordinatorError.missingFCMToken)
                }
            }
        }
    }

    private func saveToken(_ token: String, for userID: String) async {
        var payload: [String: Any] = [
            "token": token,
            "platform": "ios",
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "deviceModel": UIDevice.current.model,
            "deviceName": UIDevice.current.name,
            "systemVersion": UIDevice.current.systemVersion,
            "updatedAt": FieldValue.serverTimestamp()
        ]

        let document = db.collection("users")
            .document(userID)
            .collection("notificationTokens")
            .document(token)

        // updatedAt e' l'unico segnale che distingue un device vivo da un
        // fantasma: va aggiornato a ogni foreground. createdAt invece resta la
        // data di installazione, quindi lo scriviamo solo alla prima
        // registrazione (riscriverlo faceva fallire la update rule).
        // Su doc mancante la update rule non trova resource.data e risponde
        // permission-denied invece di not-found: qualunque errore ricade sulla
        // prima registrazione, che e' l'unico caso in cui createdAt e' lecito.
        do {
            try await document.updateData(payload)
            registeredUserID = userID
            return
        } catch {
            payload["createdAt"] = FieldValue.serverTimestamp()
        }

        do {
            try await document.setData(payload, merge: true)
            registeredUserID = userID
        } catch {
            print("[push] Failed to save FCM token:", error.localizedDescription)
        }
    }

    private func removeToken(_ token: String, for userID: String) async {
        do {
            try await db.collection("users")
                .document(userID)
                .collection("notificationTokens")
                .document(token)
                .delete()
        } catch {
            print("[push] Failed to delete stale FCM token:", error.localizedDescription)
        }
    }

    private func makePayloadKey(_ payload: [AnyHashable: Any]) -> String {
        let components = [
            stringValue(payload["gcm.message_id"]),
            stringValue(payload["type"]),
            stringValue(payload["url"]),
            stringValue(payload["threadId"]),
            stringValue(payload["titleId"]),
            stringValue(payload["postId"]),
            stringValue(payload["eventId"])
        ]
            .filter { !$0.isEmpty }

        return components.isEmpty ? UUID().uuidString : components.joined(separator: "|")
    }

    private func stringValue(_ value: Any?) -> String {
        switch value {
        case let value as String:
            return value
        case let value as NSString:
            return value as String
        default:
            return ""
        }
    }
}

private enum PushNotificationCoordinatorError: LocalizedError {
    case missingFCMToken

    var errorDescription: String? {
        switch self {
        case .missingFCMToken:
            return String(localized: "Firebase Messaging non ha restituito un token valido.")
        }
    }
}
