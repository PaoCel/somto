import Compression
import Foundation

/// Mini-unzip per gli export ZIP di TV Time (GDPR "Richiedi i tuoi dati" + Refract
/// "TV Time Out"). Port 1:1 della web (`public/js/utils/tvTimeZip.js`): legge la
/// End Of Central Directory + Central Directory dello ZIP e decomprime SOLO le
/// entry richieste (STORED o DEFLATE), senza librerie esterne.
///
/// DEFLATE grezzo (RFC 1951, come lo memorizza lo ZIP) via `Compression`:
/// `COMPRESSION_ZLIB` su Apple è raw-deflate (nessun header zlib), l'equivalente
/// del `DecompressionStream('deflate-raw')` usato sul web.
///
/// Estrae solo i file di dati che servono, MAI l'intero ZIP (che nel GDPR contiene
/// PII: email, hash password, IP…): quelli restano nello ZIP e non vengono caricati.
enum TVTimeZip {
    enum ZipError: LocalizedError {
        case notZip
        case malformed
        case unsupportedCompression(Int)
        case inflateFailed

        var errorDescription: String? {
            switch self {
            case .notZip: return String(localized: "Il file non sembra uno ZIP valido.")
            case .malformed: return String(localized: "Lo ZIP è danneggiato o in un formato non gestito.")
            case .unsupportedCompression(let m): return "Metodo di compressione ZIP non supportato (\(m))."
            case .inflateFailed: return String(localized: "Impossibile decomprimere un file dentro lo ZIP.")
            }
        }
    }

    private struct Entry {
        let name: String
        let method: Int
        let compressedSize: Int
        let uncompressedSize: Int
        let localHeaderOffset: Int
    }

    private static func b(_ d: Data, _ off: Int) -> Int { Int(d[d.startIndex + off]) }
    private static func u16(_ d: Data, _ off: Int) -> Int { b(d, off) | (b(d, off + 1) << 8) }
    private static func u32(_ d: Data, _ off: Int) -> Int {
        b(d, off) | (b(d, off + 1) << 8) | (b(d, off + 2) << 16) | (b(d, off + 3) << 24)
    }

    /// EOCD è a fine file, eventualmente seguito da un commento (max 65535 byte):
    /// scandiamo all'indietro cercando la firma invece di assumere zero commento.
    private static func findEndOfCentralDirectory(_ d: Data) -> Int? {
        let n = d.count
        guard n >= 22 else { return nil }
        let maxScan = min(n, 22 + 65535)
        let start = n - maxScan
        var i = n - 22
        while i >= start {
            if u32(d, i) == 0x06054b50 { return i }
            i -= 1
        }
        return nil
    }

    private static func readCentralDirectory(_ d: Data) throws -> [Entry] {
        guard let eocd = findEndOfCentralDirectory(d) else { throw ZipError.notZip }
        let total = u16(d, eocd + 10)
        var offset = u32(d, eocd + 16)
        var entries: [Entry] = []
        for _ in 0..<total {
            guard offset + 46 <= d.count, u32(d, offset) == 0x02014b50 else { throw ZipError.malformed }
            let method = u16(d, offset + 10)
            let compSize = u32(d, offset + 20)
            let uncompSize = u32(d, offset + 24)
            let nameLen = u16(d, offset + 28)
            let extraLen = u16(d, offset + 30)
            let commentLen = u16(d, offset + 32)
            let localOff = u32(d, offset + 42)
            let nameStart = offset + 46
            guard nameStart + nameLen <= d.count else { throw ZipError.malformed }
            let nameData = d.subdata(in: (d.startIndex + nameStart)..<(d.startIndex + nameStart + nameLen))
            let name = String(data: nameData, encoding: .utf8) ?? ""
            entries.append(Entry(
                name: name,
                method: method,
                compressedSize: compSize,
                uncompressedSize: uncompSize,
                localHeaderOffset: localOff
            ))
            offset = nameStart + nameLen + extraLen + commentLen
        }
        return entries
    }

    /// Il local file header precede i dati: le sue lunghezze nome/extra (che in
    /// pratica possono differire da quelle della central dir) determinano dove
    /// iniziano i dati.
    private static func extractData(_ d: Data, _ entry: Entry) throws -> Data {
        let lh = entry.localHeaderOffset
        guard lh + 30 <= d.count, u32(d, lh) == 0x04034b50 else { throw ZipError.malformed }
        let nameLen = u16(d, lh + 26)
        let extraLen = u16(d, lh + 28)
        let dataStart = lh + 30 + nameLen + extraLen
        guard dataStart + entry.compressedSize <= d.count else { throw ZipError.malformed }
        let comp = d.subdata(in: (d.startIndex + dataStart)..<(d.startIndex + dataStart + entry.compressedSize))
        switch entry.method {
        case 0: return comp                                  // STORED
        case 8: return try inflate(comp, expectedSize: entry.uncompressedSize)  // DEFLATE
        default: throw ZipError.unsupportedCompression(entry.method)
        }
    }

    private static func inflate(_ compressed: Data, expectedSize: Int) throws -> Data {
        guard expectedSize > 0 else { return Data() }
        var dst = [UInt8](repeating: 0, count: expectedSize)
        let produced = compressed.withUnsafeBytes { srcRaw -> Int in
            guard let src = srcRaw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return dst.withUnsafeMutableBufferPointer { dstBuf in
                compression_decode_buffer(dstBuf.baseAddress!, expectedSize, src, compressed.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard produced == expectedSize else { throw ZipError.inflateFailed }
        return Data(dst)
    }

    /// Estrae dallo ZIP le entry il cui BASENAME (non il path) è mappato da
    /// `keyFor` a una chiave non-nil; ritorna `chiave → contenuto testuale`.
    /// Le entry sotto una cartella top-level matchano comunque sul basename.
    static func extract(from data: Data, keyFor: (String) -> String?) throws -> [String: String] {
        let entries = try readCentralDirectory(data)
        var result: [String: String] = [:]
        for entry in entries {
            let base = entry.name.split(separator: "/").last.map(String.init) ?? entry.name
            guard let key = keyFor(base) else { continue }
            let bytes = try extractData(data, entry)
            result[key] = String(data: bytes, encoding: .utf8)
                ?? String(data: bytes, encoding: .isoLatin1)
                ?? ""
        }
        return result
    }
}
