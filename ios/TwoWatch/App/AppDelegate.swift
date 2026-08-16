@preconcurrency import FirebaseMessaging
import UIKit
@preconcurrency import UserNotifications

final class SomtoAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate, @preconcurrency MessagingDelegate {
    private weak var pushCoordinator: PushNotificationsCoordinator?
    private var pendingFCMToken: String?
    private var pendingNotificationPayload: [AnyHashable: Any]?

    func bind(pushCoordinator: PushNotificationsCoordinator) {
        self.pushCoordinator = pushCoordinator

        if let pendingFCMToken {
            self.pendingFCMToken = nil
            Task { @MainActor in
                await pushCoordinator.didReceiveRegistrationToken(pendingFCMToken)
            }
        }

        if let pendingNotificationPayload {
            self.pendingNotificationPayload = nil
            Task { @MainActor in
                await pushCoordinator.handleNotificationPayload(pendingNotificationPayload)
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        FirebaseBootstrap.configureIfNeeded()
        UNUserNotificationCenter.current().delegate = self
        Messaging.messaging().delegate = self

        if let notificationPayload = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            pendingNotificationPayload = notificationPayload
        }

        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[push] APNs registration failed:", error.localizedDescription)
    }

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken, !fcmToken.isEmpty else { return }

        if let pushCoordinator {
            Task { @MainActor in
                await pushCoordinator.didReceiveRegistrationToken(fcmToken)
            }
        } else {
            pendingFCMToken = fcmToken
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = response.notification.request.content.userInfo

        if let pushCoordinator {
            Task { @MainActor in
                await pushCoordinator.handleNotificationPayload(payload)
            }
        } else {
            pendingNotificationPayload = payload
        }

        completionHandler()
    }
}
