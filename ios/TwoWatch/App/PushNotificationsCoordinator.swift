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

    func currentAuthorizationStatus() async -> UNAuthorizationStatus {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return settings.authorizationStatus
    }

    func requestAuthorizationFromUser() async -> Bool {
        guard await ensureAuthorizationAndRegisterIfPossible(requestIfNeeded: true) else {
            return false
        }

        await refreshRegistrationToken()

        if let userID = sessionStore?.firebaseUser?.uid,
           let cachedFCMToken {
            await saveToken(cachedFCMToken, for: userID)
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
