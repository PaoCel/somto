@preconcurrency import FirebaseAppCheck
@preconcurrency import FirebaseCore
import Foundation

final class SomtoAppCheckProviderFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
        if #available(iOS 14.0, *) {
            return AppAttestProvider(app: app)
        }
        return DeviceCheckProvider(app: app)
    }
}

enum SomtoAppCheckBootstrap {
    static func configure(using config: FirebaseConfig?) {
        let providerFactory: AppCheckProviderFactory = shouldUseDebugProvider(config: config)
            ? AppCheckDebugProviderFactory()
            : SomtoAppCheckProviderFactory()
        AppCheck.setAppCheckProviderFactory(providerFactory)
    }

    private static func shouldUseDebugProvider(config: FirebaseConfig?) -> Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return (config?.useEmulators == true) || (config?.appCheckDebugProvider == true)
        #endif
    }
}
