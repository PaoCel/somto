import SwiftUI

// Il tasto "vai a guardarlo", cioe' l'unica azione che porta fuori da Somto.
//
// PERCHE' ESISTE — fino a ieri l'unico modo per arrivare alla piattaforma era
// la fila di loghi dentro "Dove guardarlo": in fondo alla tab Panoramica, sotto
// la sinossi e i metadati. Chi apre una serie che sta guardando vuole quel salto
// come prima cosa, non come ultima. Il widget quel bottone ce l'ha da sempre; e'
// la scheda titolo che non lo aveva.
//
// COSA PROMETTE — solo cio' che sa mantenere. Con un link diretto dice "Guarda
// su Netflix" e apre la scheda del titolo dentro l'app; con una ricerca dice
// "Cerca su Netflix", perche' li' un tap non basta. Se non sappiamo aprire
// nessuna app (resta solo la pagina "dove guardare" di TMDB) il bottone NON
// compare: quel ripiego ce l'ha gia' la sezione con i loghi, e un bottone grosso
// che apre una pagina web di TMDB e' la promessa che fa dire "non funziona".
//
// DUE MISURE — `.prominent` e' il tasto della scheda titolo: tutta la
// larghezza, un'azione sola. `.compact` e' la pastiglia delle card del feed e
// della pagina del post: sta in una riga con altro, e non deve rubare la scena
// al post. Stessa promessa, stessa destinazione: la decide
// `TitleWatchNowDestination`, lo stesso livello del widget.
struct TitleWatchNowButton: View {
    enum Style {
        /// Il tasto grande della scheda titolo.
        case prominent
        /// La pastiglia delle card: feed e pagina del post.
        case compact
    }

    let title: Title
    /// I provider caricati dalla callable, quando ci sono. Possono mancare
    /// (rete lenta, primo caricamento, oppure una card del feed che la callable
    /// non la chiama): in quel caso si usano i nomi e i link gia' denormalizzati
    /// sul titolo, che l'app ha in mano da subito.
    let providers: TitleProviders?
    var style: Style = .prominent

    @ScaledMetric(relativeTo: .caption) private var compactLogoSide: CGFloat = 18

    var body: some View {
        if let destination {
            Link(destination: destination.url) {
                switch style {
                case .prominent:
                    prominentContent(destination: destination, logoURL: logoURL(for: destination.providerName))
                case .compact:
                    compactContent(destination: destination, logoURL: logoURL(for: destination.providerName))
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label(for: destination))
        }
    }

    private func prominentContent(destination: StreamingDestination, logoURL: URL?) -> some View {
        HStack(spacing: SomtoSpacing.l) {
            Image(systemName: "play.fill")
                .font(.subheadline.weight(.bold))

            Text(label(for: destination))
                .font(.headline.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.85)

            Spacer(minLength: 0)

            if let logoURL {
                providerLogo(logoURL, side: 26, cornerRadius: 6)
            }
        }
        .foregroundStyle(TwoWatchTheme.background)
        .padding(.horizontal, SomtoSpacing.xxl)
        .padding(.vertical, SomtoSpacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            TwoWatchTheme.textPrimary,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
    }

    /// La pastiglia: stessi colori del tasto grande, misura da riga. Il frame a
    /// 44 tiene l'area di tocco piena anche se la pastiglia e' piu' bassa.
    private func compactContent(destination: StreamingDestination, logoURL: URL?) -> some View {
        HStack(spacing: SomtoSpacing.m) {
            Image(systemName: "play.fill")
                .font(.caption.weight(.bold))

            Text(label(for: destination))
                .font(.caption.weight(.bold))
                .lineLimit(1)

            if let logoURL {
                providerLogo(logoURL, side: compactLogoSide, cornerRadius: 5)
            }
        }
        .foregroundStyle(TwoWatchTheme.background)
        .padding(.horizontal, SomtoSpacing.xl)
        .padding(.vertical, SomtoSpacing.m)
        .background(TwoWatchTheme.textPrimary, in: Capsule())
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// Logo nudo, senza pastiglia intorno: e' il marchio della piattaforma, non
    /// un bottone dentro il bottone.
    private func providerLogo(_ url: URL, side: CGFloat, cornerRadius: CGFloat) -> some View {
        CachedAsyncImage(url: url) { phase in
            if case let .success(image) = phase {
                image
                    .resizable()
                    .scaledToFit()
            } else {
                Color.clear
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .shadow(color: .black.opacity(0.18), radius: 3, y: 1)
    }

    // MARK: - Destinazione

    private var destination: StreamingDestination? {
        TitleWatchNowDestination.resolve(title: title, providers: providers)
    }

    private func logoURL(for providerName: String) -> URL? {
        TitleWatchNowDestination.logoURL(for: providerName, title: title, providers: providers)
    }

    // MARK: - Copy

    private func label(for destination: StreamingDestination) -> String {
        destination.isExact
            ? String(localized: "Guarda su \(destination.providerName)")
            : String(localized: "Cerca su \(destination.providerName)")
    }
}
