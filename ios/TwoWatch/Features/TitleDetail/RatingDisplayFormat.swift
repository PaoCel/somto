import Foundation

/// Formattazione condivisa dei voti (scala 0–10) in tutta l'app.
///
/// Il web (redesign confermato in prod) mostra il voto in formato italiano
/// a mezzo punto: "7" oppure "7,5" (separatore decimale virgola, snap al più
/// vicino 0,5, massimo 1 cifra decimale). Questa utility centralizza quella
/// logica così da non duplicare la configurazione del `NumberFormatter` nei
/// vari punti di visualizzazione (star row, season inline, episode grid…).
///
/// La scala è 0–10 ovunque nel prodotto, quindi il suffisso "/10" non viene
/// mai mostrato: il numero da solo è già inequivocabile. Resta nelle
/// `accessibilityLabel` ("7,5 su 10") dove leggere solo il numero sarebbe
/// ambiguo a voce.
///
/// IMPORTANTE: formatta solo la stringa mostrata. La matematica sottostante
/// resta sempre `Double` (nessuno snap distruttivo sui valori persistiti).
enum RatingDisplayFormat {
    /// Locale italiano fisso per garantire la virgola come separatore decimale
    /// indipendentemente dalla lingua di sistema.
    private static let italianLocale = Locale(identifier: "it_IT")

    private static let formatter: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = italianLocale
        f.numberStyle = .decimal
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = 1
        f.usesGroupingSeparator = false
        return f
    }()

    /// Snap al più vicino 0,5 dentro l'intervallo 1...10.
    static func snappedHalfStep(_ value: Double) -> Double {
        let clamped = max(1, min(10, value))
        return (clamped * 2).rounded() / 2
    }

    /// Voto formattato in italiano a mezzo punto: "7" oppure "7,5".
    static func halfStep(_ value: Double) -> String {
        let snapped = snappedHalfStep(value)
        return formatter.string(from: NSNumber(value: snapped)) ?? String(format: "%.1f", snapped)
    }

    /// Variante opzionale: nil → trattino em.
    static func halfStep(_ value: Double?) -> String {
        guard let value else { return "—" }
        return halfStep(value)
    }

    // MARK: - Prefisso voto nei testi salvati

    /// Un messaggio/anteprima che inizia col voto, già separato nelle sue parti.
    struct RatingPrefixedText: Equatable {
        /// Voto pronto da mostrare (senza "/10"): es. "7,5", "8½", "7+", "9-".
        let score: String
        /// "con Anna, Marco" quando il voto porta con sé le persone con cui si
        /// è guardato; stringa vuota altrimenti.
        let people: String
        /// Il testo dopo il prefisso; vuoto per il voto secco.
        let body: String
    }

    /// I messaggi pubblicati da un voto sono salvati come
    /// `"8½/10 · con Anna — testo"` (vedi
    /// `TitleDetailFormatter.publicReviewThreadMessage` e l'equivalente web) e
    /// quel formato è anche il `lastMessagePreview` del thread. È **wire
    /// format**: resta invariato sul database, ma non va mai mostrato così.
    ///
    /// Questa funzione è l'unico punto che lo interpreta.
    ///
    /// Il voto **non è sempre un numero puro**: il web lo formatta a quarti di
    /// punto con dei modificatori (`formatMaskedRating`), quindi esistono
    /// messaggi reali che iniziano con `8½/10`, `7+/10`, `9-/10`. La versione
    /// precedente di questo pattern accettava solo cifre ed eventuale decimale,
    /// così quei messaggi non venivano riconosciuti e finivano a schermo con il
    /// "/10" grezzo dentro il testo (visto su Pluribus).
    /// `[+½-]` copre i tre modificatori a quarti di punto prodotti dal web.
    private static let ratingPrefixRegex = try! NSRegularExpression(
        pattern: "^\\s*(\\d{1,2}(?:[.,]\\d+)?[+\u{00BD}-]?)\\s*/\\s*10\\b"
    )

    static func splitRatingPrefix(_ text: String) -> RatingPrefixedText? {
        let ns = text as NSString
        guard let match = ratingPrefixRegex.firstMatch(
            in: text,
            range: NSRange(location: 0, length: ns.length)
        ) else { return nil }

        let rawScore = ns.substring(with: match.range(at: 1))
        var rest = ns.substring(from: match.range.location + match.range.length)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        // Segmento opzionale "· con Anna, Marco" prima del testo vero.
        var people = ""
        if rest.hasPrefix("·") {
            let afterDot = rest.dropFirst().trimmingCharacters(in: .whitespaces)
            if let dash = afterDot.firstIndex(where: { $0 == "—" || $0 == "–" }) {
                people = String(afterDot[..<dash]).trimmingCharacters(in: .whitespacesAndNewlines)
                rest = String(afterDot[afterDot.index(after: dash)...])
            } else {
                people = afterDot.trimmingCharacters(in: .whitespacesAndNewlines)
                rest = ""
            }
        }

        let body = rest
            .trimmingCharacters(in: CharacterSet(charactersIn: " —–:.-\n\t"))
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return RatingPrefixedText(
            score: rawScore.replacingOccurrences(of: ".", with: ","),
            people: people,
            body: body
        )
    }
}
