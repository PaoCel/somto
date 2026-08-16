import Foundation

struct FirebaseConfig {
    let apiKey: String
    let projectID: String
    let googleAppID: String
    let gcmSenderID: String
    let storageBucket: String
    let functionsRegion: String
    let appCheckDebugProvider: Bool
    let useEmulators: Bool
    let emulatorHost: String
    let authPort: Int
    let firestorePort: Int
    let functionsPort: Int
    let storagePort: Int

    static func load() -> FirebaseConfig {
        guard let config = loadIfPresent() else {
            fatalError("FirebaseConfig.plist mancante nel bundle")
        }
        return config
    }

    static func loadIfPresent() -> FirebaseConfig? {
        guard
            let url = Bundle.main.url(forResource: "FirebaseConfig", withExtension: "plist"),
            let data = try? Data(contentsOf: url),
            let raw = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else {
            return nil
        }

        func requiredString(_ key: String) -> String {
            guard let value = raw[key] as? String, !value.isEmpty else {
                fatalError("FirebaseConfig.plist: chiave \(key) mancante")
            }
            return value
        }

        return FirebaseConfig(
            apiKey: requiredString("API_KEY"),
            projectID: requiredString("PROJECT_ID"),
            googleAppID: requiredString("GOOGLE_APP_ID"),
            gcmSenderID: requiredString("GCM_SENDER_ID"),
            storageBucket: requiredString("STORAGE_BUCKET"),
            functionsRegion: (raw["FUNCTIONS_REGION"] as? String) ?? "europe-west1",
            appCheckDebugProvider: (raw["APP_CHECK_DEBUG_PROVIDER"] as? Bool) ?? false,
            useEmulators: (raw["USE_EMULATORS"] as? Bool) ?? false,
            emulatorHost: (raw["EMULATOR_HOST"] as? String) ?? "127.0.0.1",
            authPort: (raw["AUTH_PORT"] as? Int) ?? 9099,
            firestorePort: (raw["FIRESTORE_PORT"] as? Int) ?? 8080,
            functionsPort: (raw["FUNCTIONS_PORT"] as? Int) ?? 5001,
            storagePort: (raw["STORAGE_PORT"] as? Int) ?? 9199
        )
    }
}
