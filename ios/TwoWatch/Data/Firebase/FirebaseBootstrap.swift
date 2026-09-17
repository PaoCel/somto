@preconcurrency import FirebaseAuth
@preconcurrency import FirebaseAppCheck
@preconcurrency import FirebaseCore
@preconcurrency import FirebaseCrashlytics
@preconcurrency import FirebaseFirestore
@preconcurrency import FirebaseFunctions
@preconcurrency import FirebaseStorage
import Foundation

enum FirebaseBootstrap {
    static func configureIfNeeded() {
        guard FirebaseApp.app() == nil else { return }

        configureSharedURLCache()

        let runtimeConfig = FirebaseConfig.loadIfPresent()
        SomtoAppCheckBootstrap.configure(using: runtimeConfig)

        if let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
           let options = FirebaseOptions(contentsOfFile: path) {
            FirebaseApp.configure(options: options)
        } else if let config = runtimeConfig {
            let options = FirebaseOptions(googleAppID: config.googleAppID, gcmSenderID: config.gcmSenderID)
            options.apiKey = config.apiKey
            options.projectID = config.projectID
            options.storageBucket = config.storageBucket
            FirebaseApp.configure(options: options)
        } else {
            fatalError(String(localized: "Manca una configurazione Firebase valida nel bundle"))
        }

        configureCrashlyticsMetadata()

        guard let config = runtimeConfig, config.useEmulators else { return }

        let auth = Auth.auth()
        auth.useEmulator(withHost: config.emulatorHost, port: config.authPort)

        let firestore = Firestore.firestore()
        firestore.useEmulator(withHost: config.emulatorHost, port: config.firestorePort)

        let functions = Functions.functions(region: config.functionsRegion)
        functions.useEmulator(withHost: config.emulatorHost, port: config.functionsPort)

        let storage = Storage.storage()
        storage.useEmulator(withHost: config.emulatorHost, port: config.storagePort)
    }

    /// Cache condivisa per le poster (e altre immagini remote): 50 MB in memoria,
    /// 200 MB su disco. Va impostata prima del primo `URLSession.shared` per
    /// avere effetto.
    private static func configureSharedURLCache() {
        URLCache.shared = URLCache(
            memoryCapacity: 50 * 1024 * 1024,
            diskCapacity: 200 * 1024 * 1024,
            diskPath: "PosterCache"
        )
    }

    private static func configureCrashlyticsMetadata() {
        #if !DEBUG
        let info = Bundle.main.infoDictionary
        Crashlytics.crashlytics().setCustomValue(
            info?["CFBundleShortVersionString"] ?? "?",
            forKey: "app_version"
        )
        Crashlytics.crashlytics().setCustomValue(
            info?["CFBundleVersion"] ?? "?",
            forKey: "build_number"
        )
        #endif
    }
}
