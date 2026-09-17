import SwiftUI

// Font a dimensione fissa che RISPETTANO Dynamic Type.
//
// IL PROBLEMA — l'app usa 1.271 font semantici (`.caption`, `.subheadline`…),
// che scalano da soli: Dynamic Type e' gia' la norma. Ma restano **240**
// `.font(.system(size: N))` a dimensione fissa, e quelli non scalano affatto:
// chi ingrandisce il testo di sistema perche' altrimenti non legge, in quei
// punti non vede cambiare niente. Solo 24 punti in tutta l'app usano
// `@ScaledMetric`.
//
// PERCHE' NON BASTA SOSTITUIRLI CON FONT SEMANTICI — le dimensioni fisse
// esistono dove il carattere e' parte della composizione: il punteggio grande
// del quiz, le iniziali dentro un avatar tondo, i numeri di una statistica.
// Rimpiazzarli con `.caption` o `.title` cambierebbe la resa. Qui invece la
// dimensione resta quella scelta, ma diventa un punto di partenza che cresce
// con le impostazioni dell'utente.
//
// COME SI SCEGLIE `relativeTo` — indica rispetto a quale stile di testo la
// dimensione deve crescere. Un'etichetta piccola cresce come `.caption`, un
// numero grande come `.title`. Sbagliarlo non rompe niente, ma fa crescere il
// testo troppo o troppo poco rispetto a cio' che gli sta accanto.

private struct SomtoScaledFontModifier: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design, relativeTo textStyle: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: textStyle)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}

extension View {
    /// Font di sistema a dimensione data, che pero' cresce con Dynamic Type.
    ///
    /// Sostituisce `.font(.system(size:weight:design:))` dove la dimensione e'
    /// deliberata (numeri, iniziali, punteggi) e non si puo' passare a uno
    /// stile semantico senza cambiare la resa.
    ///
    /// - Parameter relativeTo: lo stile rispetto a cui scalare. Regola pratica:
    ///   sotto i 13pt `.caption`, fino a 20pt `.body`, sopra `.title`.
    func somtoScaledFont(
        size: CGFloat,
        weight: Font.Weight = .regular,
        design: Font.Design = .default,
        relativeTo textStyle: Font.TextStyle = .body
    ) -> some View {
        modifier(SomtoScaledFontModifier(
            size: size,
            weight: weight,
            design: design,
            relativeTo: textStyle
        ))
    }
}

#if DEBUG
#Preview("Dynamic Type — fisso vs scalato") {
    VStack(alignment: .leading, spacing: SomtoSpacing.xxl) {
        ForEach([DynamicTypeSize.large, .xxLarge, .accessibility2], id: \.self) { size in
            VStack(alignment: .leading, spacing: SomtoSpacing.s) {
                Text(String(describing: size))
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textMuted)

                HStack(spacing: SomtoSpacing.xxl) {
                    Text("8,5")
                        .font(.system(size: 22, weight: .black, design: .rounded))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    Text("8,5")
                        .somtoScaledFont(size: 22, weight: .black, design: .rounded, relativeTo: .title)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
            .environment(\.dynamicTypeSize, size)
        }
        Text("A sinistra il font fisso, a destra quello scalato.")
            .font(.caption)
            .foregroundStyle(TwoWatchTheme.textMuted)
    }
    .padding()
    .background(TwoWatchTheme.background)
}
#endif
