import SwiftUI

// Feedback al tap identico a quello dei tasti dell'header (`BrandChromeBar`):
// il tasto si ingrigisce e rientra, così il tocco si vede prima ancora che la
// ricerca si apra.
private struct FloatingSearchButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay(
                Circle()
                    .fill(Color.black.opacity(configuration.isPressed ? 0.16 : 0))
            )
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Lente di ricerca ancorata in basso a destra, appena sopra la tab bar.
///
/// PERCHE' IN BASSO — la ricerca era un chip nell'angolo in alto a sinistra,
/// cioè il punto più lontano dal pollice su un iPhone da 6,7". È l'azione più
/// frequente dopo lo scroll: sta dove stanno già le tab. Staccarla dalla tab
/// bar invece di aggiungere una sesta voce tiene leggibili le cinque
/// destinazioni e dice che la ricerca è un'azione, non un posto dove si va —
/// lo stesso schema di Foto, Mappe e App Store su iOS 26.
struct FloatingSearchButton: View {
    /// 52pt: sopra i 44 minimi HIG e in scala con la tab bar sotto.
    var diameter: CGFloat = 52
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "magnifyingglass")
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .frame(width: diameter, height: diameter)
                // Stesso materiale della tab bar (`TwoWatchTheme.tabMaterial`):
                // deve leggersi come un pezzo della barra accanto, non come un
                // disco pieno appoggiato sopra al contenuto.
                .background(
                    Circle()
                        .fill(TwoWatchTheme.tabMaterial)
                        .overlay(Circle().strokeBorder(TwoWatchTheme.border, lineWidth: 1))
                        .somtoElevation(.low)
                )
        }
        .buttonStyle(FloatingSearchButtonStyle())
        .accessibilityLabel("Apri ricerca")
    }
}

#if DEBUG
#Preview {
    ZStack {
        TwoWatchBackground()
        FloatingSearchButton {}
    }
}
#endif
