import SwiftUI
import UIKit

// I pezzi che i widget di Somto hanno in comune: quante righe entrano in una
// misura, l'intestazione, la locandina, la schermata di una frase sola.
//
// Sono nati dentro "Prossime uscite" e sono usciti di li' quando e' arrivato il
// secondo widget: due elenchi di titoli con la locandina a sinistra non devono
// essere due implementazioni, se no la prossima misura giusta la si azzecca in
// un file e la si sbaglia nell'altro.

enum WidgetRowLayout {
    /// Quante righe entrano in un `systemMedium` senza comprimere il testo.
    ///
    /// La misura viene dall'altezza utile: un medium sul telefono piu' piccolo
    /// e' ~155pt, meno i 16pt di margine per lato ne restano ~123. Intestazione
    /// (~13) piu' stacco (12) fanno 25, e ne avanzano ~98. Con la locandina a
    /// 26pt di larghezza una riga e' alta 39 (2:3), quindi due righe piu' l'aria
    /// in mezzo fanno 86: entrano. Tre no — erano 3 finche' la locandina stava a
    /// 20pt e il nome a `caption`, cioe' finche' il widget si leggeva stringendo
    /// gli occhi. Alzare questo numero non aggiunge righe: fa uscire l'ultima
    /// dal riquadro, che non scorre.
    static let mediumRowCount = 2

    /// Quante ne entrano in un `systemLarge` (~345pt, ~313 utili).
    ///
    /// Con locandina a 30pt la riga e' alta 45: cinque righe piu' l'aria fanno
    /// 273 dei ~280 disponibili sotto l'intestazione.
    static let largeRowCount = 5

    /// Proporzione standard di un poster (2:3), la stessa di `PosterImageView`.
    static let posterAspectRatio: CGFloat = 2.0 / 3.0

    /// Quante righe disegnare davvero alla dimensione di testo scelta.
    ///
    /// Un widget non scorre e non si allunga: se il testo cresce, l'unica scelta
    /// e' mostrarne meno. Comprimendolo si otterrebbe l'ultima riga tagliata a
    /// meta' dal bordo, che e' il difetto peggiore dei due.
    static func rowCount(isLarge: Bool, dynamicTypeSize: DynamicTypeSize) -> Int {
        if dynamicTypeSize.isAccessibilitySize {
            return isLarge ? 2 : 1
        }
        if dynamicTypeSize >= .xxLarge {
            return isLarge ? 3 : 1
        }
        if dynamicTypeSize >= .xLarge {
            return isLarge ? 4 : 1
        }
        return isLarge ? largeRowCount : mediumRowCount
    }
}

/// Il titolo del widget. Piccolo e in secondario: dice di cosa e' questo
/// riquadro, non e' la prima riga dell'elenco.
struct WidgetSectionHeader: View {
    let title: LocalizedStringKey

    var body: some View {
        Text(title)
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundStyle(TwoWatchTheme.textSecondary)
            .lineLimit(1)
    }
}

/// La locandina di una riga. I byte arrivano gia' scaricati dentro la timeline:
/// una View di widget non puo' fare rete.
struct WidgetPosterView: View {
    let data: Data?
    let isSeries: Bool
    let width: CGFloat

    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .frame(width: width, height: width / WidgetRowLayout.posterAspectRatio)
        .clipShape(RoundedRectangle(cornerRadius: SomtoRadius.xs, style: .continuous))
        .accessibilityHidden(true)
    }

    private var placeholder: some View {
        ZStack {
            TwoWatchTheme.panelStrong
            Image(systemName: isSeries ? "tv" : "film")
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
    }
}

/// Stato vuoto e stato di errore condividono la forma: intestazione, una frase,
/// niente altro.
///
/// `opensGuide` c'e' perche' un widget che dice "apri Somto" e poi apre la Home
/// lascia la persona esattamente dov'era: sul device il riassunto e' comparso
/// solo dopo un passaggio dalla tab Watchlist, e nessuno poteva saperlo. Con
/// `/widget` il tap apre la spiegazione, che e' la risposta alla domanda che ha
/// fatto toccare il riquadro.
struct WidgetMessageView: View {
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    var opensGuide = false

    private var guideURL: URL? {
        opensGuide ? URL(string: "https://somto.it/widget") : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SomtoSpacing.s) {
            WidgetSectionHeader(title: title)
            Spacer(minLength: 0)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineLimit(4)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(guideURL)
    }
}
