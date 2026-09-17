import Foundation

// Le locandine del widget, tenute su disco.
//
// PERCHE' ESISTE — ogni ricostruzione della timeline riscaricava ogni immagine:
// cambiare serie col tap sulla miniatura voleva dire quattro richieste di rete
// prima di ridisegnare, cioe' un tap che per un paio di secondi non sembra aver
// fatto niente (constatato sul device). Le URL delle locandine TMDB sono
// immutabili — lo stesso path serve sempre lo stesso file — quindi la cache
// puo' essere aggressiva senza rischio di mostrare un'immagine vecchia.
//
// Sta nell'App Group e non nella cartella Caches dell'estensione: i widget sono
// processi che nascono e muoiono di continuo, e la loro Caches viene svuotata
// dal sistema molto prima di quanto duri una locandina.
enum WidgetImageCache {
    private static let folderName = "widget-images"
    /// Tetto in numero di file: le locandine pesano poche decine di KB, e oltre
    /// questa soglia si sta conservando roba che nessun widget disegna piu'.
    private static let maxEntries = 80
    private static let maxAge: TimeInterval = 30 * 24 * 60 * 60

    private static var folderURL: URL? {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: WatchlistWidgetSnapshotStore.appGroup)
        else { return nil }
        let folder = container.appendingPathComponent(folderName, isDirectory: true)
        if !FileManager.default.fileExists(atPath: folder.path) {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        return folder
    }

    static func data(for url: URL) -> Data? {
        guard let fileURL = fileURL(for: url) else { return nil }
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let modified = attributes[.modificationDate] as? Date,
              Date().timeIntervalSince(modified) < maxAge
        else {
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }
        return try? Data(contentsOf: fileURL)
    }

    static func store(_ data: Data, for url: URL) {
        guard !data.isEmpty, let fileURL = fileURL(for: url) else { return }
        // Stessa classe del riassunto (`UntilFirstUserAuthentication`): il
        // widget si ridisegna anche a telefono bloccato, e `UnlessOpen` rendeva
        // le immagini illeggibili proprio allora (vedi WatchlistWidgetSnapshot).
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        prune()
    }

    private static func fileURL(for url: URL) -> URL? {
        folderURL?.appendingPathComponent(fileName(for: url))
    }

    /// Nome file stabile e senza collisioni pratiche: FNV-1a a 64 bit
    /// sull'URL completo. Niente CryptoKit per una chiave di cache.
    private static func fileName(for url: URL) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in Array(url.absoluteString.utf8) {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(format: "%016llx.img", hash)
    }

    /// Tiene la cartella entro il tetto buttando i file toccati meno di
    /// recente. Gira solo dopo una scrittura, quindi al massimo una volta per
    /// immagine nuova.
    private static func prune() {
        guard let folderURL else { return }
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: folderURL,
            includingPropertiesForKeys: keys
        ), files.count > maxEntries else { return }

        let sorted = files.sorted { left, right in
            let leftDate = (try? left.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast
            let rightDate = (try? right.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast
            return leftDate > rightDate
        }
        for file in sorted.dropFirst(maxEntries) {
            try? FileManager.default.removeItem(at: file)
        }
    }
}
