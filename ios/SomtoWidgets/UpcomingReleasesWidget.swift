import SwiftUI
import UIKit
import WidgetKit

// MARK: - Widget

struct UpcomingReleasesWidget: Widget {
    static let kind = "SomtoUpcomingReleases"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: UpcomingReleasesProvider()) { entry in
            UpcomingReleasesWidgetView(entry: entry)
                .containerBackground(for: .widget) { TwoWatchTheme.screenGradient }
        }
        .configurationDisplayName("Prossime uscite")
        .description("I film e le serie in arrivo, con la data.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Radice

struct UpcomingReleasesWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UpcomingReleasesEntry

    var body: some View {
        switch entry.state {
        case let .releases(rows):
            if rows.isEmpty {
                WidgetMessageView(title: "Prossime uscite", message: "Nessuna uscita in arrivo")
            } else if let first = rows.first, family == .systemSmall {
                UpcomingReleasesSmallView(row: first)
            } else {
                UpcomingReleasesListView(rows: rows, isLarge: family == .systemLarge)
            }
        case .empty:
            WidgetMessageView(title: "Prossime uscite", message: "Nessuna uscita in arrivo")
        case .unavailable:
            // Frase gia' in uso su iOS e sul web: un guasto di rete si racconta
            // con le stesse parole ovunque.
            WidgetMessageView(title: "Prossime uscite", message: "Controlla la connessione e riprova.")
        }
    }
}

// MARK: - Intestazione

// MARK: - systemMedium e systemLarge

/// L'elenco. Una sola implementazione per le due misure: cambia quante righe
/// entrano e quanto sono comode, non cosa mostrano.
///
/// GERARCHIA VERTICALE — l'intestazione e' staccata dall'elenco piu' di quanto
/// le righe lo siano fra loro (`m`/`xxl` contro `s`/`ml`). Con lo stesso valore
/// dappertutto "Prossime uscite" sembrava la prima riga della lista.
private struct UpcomingReleasesListView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let rows: [UpcomingReleaseRow]
    let isLarge: Bool

    private var style: UpcomingReleaseRowStyle { isLarge ? .comfortable : .compact }

    /// Lo stacco fra intestazione ed elenco, e quello fra una riga e l'altra.
    private var headerSpacing: CGFloat { isLarge ? SomtoSpacing.xxl : SomtoSpacing.m }
    private var rowSpacing: CGFloat { isLarge ? SomtoSpacing.ml : SomtoSpacing.s }

    private var visibleRows: [UpcomingReleaseRow] {
        Array(rows.prefix(WidgetRowLayout.rowCount(isLarge: isLarge, dynamicTypeSize: dynamicTypeSize)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: headerSpacing) {
            WidgetSectionHeader(title: "Prossime uscite")

            // Le righe tengono la loro altezza e restano in alto: quando il
            // feed ne serve meno del previsto (ne manda al massimo dieci, e
            // vicino a fine stagione possono essere poche) lo spazio che avanza
            // resta in fondo invece di stirare le righe o spargerle.
            VStack(alignment: .leading, spacing: rowSpacing) {
                // Una riga = un titolo = un tap: `Link` apre direttamente quel
                // titolo, senza passare dalla home.
                ForEach(visibleRows) { row in
                    Link(destination: row.deepLink) {
                        UpcomingReleaseRowView(row: row, style: style)
                    }
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Quanto e' comoda una riga. `compact` sta in un medium, `comfortable` sfrutta
/// l'altezza della large: stessa struttura, misure diverse.
private enum UpcomingReleaseRowStyle {
    case compact
    case comfortable
}

private struct UpcomingReleaseRowView: View {
    /// Le due misure di locandina, entrambe legate al font della loro riga cosi'
    /// che crescano insieme al testo invece di restare indietro.
    @ScaledMetric(relativeTo: .subheadline) private var compactPosterWidth: CGFloat = 26
    @ScaledMetric(relativeTo: .body) private var comfortablePosterWidth: CGFloat = 30

    let row: UpcomingReleaseRow
    let style: UpcomingReleaseRowStyle

    private var isComfortable: Bool { style == .comfortable }
    private var posterWidth: CGFloat { isComfortable ? comfortablePosterWidth : compactPosterWidth }
    private var nameFont: Font { isComfortable ? .body : .subheadline }
    /// Nel medium le due righe di testo stanno attaccate: sono un blocco solo.
    /// Nella large lo spazio c'e', e l'aria si vede.
    private var textSpacing: CGFloat { isComfortable ? SomtoSpacing.xxs : 0 }

    var body: some View {
        HStack(spacing: SomtoSpacing.ml) {
            WidgetPosterView(data: row.posterData, isSeries: row.isSeries, width: posterWidth)

            // Nome ed etichetta sono un blocco solo: l'aria sta fra le righe
            // della lista, non dentro la riga.
            VStack(alignment: .leading, spacing: textSpacing) {
                Text(row.name)
                    .font(nameFont)
                    .fontWeight(.semibold)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                UpcomingReleaseSecondaryLine(row: row)
            }

            Spacer(minLength: SomtoSpacing.m)

            UpcomingReleaseDateLabel(date: row.releaseDate)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - systemSmall

/// Nel quadrato c'e' posto per una cosa sola, e quella cosa e' il titolo: la
/// locandina lo fa riconoscere prima di leggerlo, il nome dice quale e'. Stanno
/// affiancati perche' in colonna (locandina sopra, nome sotto) il nome sarebbe
/// rimasto a una riga sola, cioe' troncato quasi sempre.
private struct UpcomingReleasesSmallView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .headline) private var posterWidth: CGFloat = 54

    let row: UpcomingReleaseRow

    /// Alle taglie accessibility la locandina sparisce: la colonna del testo
    /// resterebbe sui 60pt con parole lunghe il doppio, e il nome — che e'
    /// l'informazione — finirebbe spezzato o rimpicciolito fino a non leggersi.
    private var showsPoster: Bool { !dynamicTypeSize.isAccessibilitySize }

    /// Tre righe di nome stanno solo quando sotto non c'e' altro. Senza
    /// locandina la colonna e' piu' larga ma i caratteri sono enormi: due.
    private var nameLineLimit: Int {
        guard showsPoster else { return 2 }
        return row.secondaryLabelIsWorthTheSpace ? 2 : 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SomtoSpacing.m) {
            WidgetSectionHeader(title: "Prossime uscite")

            HStack(alignment: .top, spacing: SomtoSpacing.ml) {
                if showsPoster {
                    WidgetPosterView(data: row.posterData, isSeries: row.isSeries, width: posterWidth)
                }

                VStack(alignment: .leading, spacing: SomtoSpacing.xs) {
                    // Il nome perde una riga quando sotto c'e' qualcosa da dire:
                    // la colonna e' larga ~70pt, e "Stagione 3" accanto alla
                    // data non ci starebbe su una riga sola senza rimpicciolire
                    // entrambe fino a non leggersi.
                    Text(row.name)
                        .font(.headline)
                        .fontWeight(.semibold)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(nameLineLimit)
                        .minimumScaleFactor(0.8)

                    if row.secondaryLabelIsWorthTheSpace {
                        // Cosa esce e su cosa si vede: la riga sopra la data.
                        UpcomingReleaseSecondaryLine(row: row)
                        UpcomingReleaseDateLabel(date: row.releaseDate)
                    } else {
                        // Niente da aggiungere alla locandina: il simbolo del
                        // tipo costa quasi niente e la data resta accanto.
                        HStack(spacing: SomtoSpacing.xs) {
                            Image(systemName: row.typeSymbol)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .accessibilityHidden(true)
                            UpcomingReleaseDateLabel(date: row.releaseDate)
                        }
                    }
                }

                Spacer(minLength: 0)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(row.deepLink)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Pezzi condivisi

extension UpcomingReleaseRow {
    /// La riga sotto al nome: cosa esce e dove, se lo sappiamo, altrimenti che
    /// cosa e'.
    ///
    /// "Al cinema" dice qualcosa che la data da sola non dice — se domani devo
    /// comprare un biglietto o aprire un'app — mentre "Film" ripete quello che
    /// la locandina mostra gia'. Per una serie vince la stagione: "Stagione 3"
    /// e' la notizia, "In TV" e' il contorno. Quando non sappiamo niente si
    /// torna alla vecchia etichetta: una riga muta sembrerebbe un dato mancante.
    var secondaryLabel: LocalizedStringKey {
        if occasion == .seasonPremiere {
            guard let season else { return "Nuova stagione" }
            return "Stagione \(season)"
        }
        switch kind {
        case .cinema: return "Al cinema"
        case .streaming: return "In streaming"
        case .tv: return "In TV"
        case nil: return isSeries ? "Serie TV" : "Film"
        }
    }

    /// Se l'etichetta vale i punti che occupa nel quadrato. "Stagione 3" e "Al
    /// cinema" si', "Film" no: quello lo dice gia' la locandina.
    var secondaryLabelIsWorthTheSpace: Bool { kind != nil || occasion == .seasonPremiere }

    /// Per VoiceOver il logo non esiste: il nome della piattaforma va detto.
    var accessibilityLabel: Text {
        guard let providerName else { return Text(secondaryLabel) }
        return Text(secondaryLabel) + Text(", \(providerName)")
    }

    /// Il ripiego della misura piccola quando non lo e': il simbolo del tipo
    /// costa pochi punti dove "Serie TV" non entrerebbe.
    var typeSymbol: String { isSeries ? "tv" : "film" }
}

/// La riga sotto al nome: il logo della piattaforma, quando c'e', e l'etichetta.
///
/// Il logo non sostituisce il testo, lo precede: "Netflix" da solo non dice che
/// e' la stagione 3, e "Stagione 3" da sola non dice dove. Per VoiceOver conta
/// solo il testo — il logo e' nascosto e il nome della piattaforma entra li'.
private struct UpcomingReleaseSecondaryLine: View {
    @ScaledMetric(relativeTo: .caption) private var logoSide: CGFloat = 16

    let row: UpcomingReleaseRow

    /// Il raggio segue il lato: `SomtoRadius.xs` (8) su un quadrato di 16pt e'
    /// mezzo cerchio. I logo TMDB hanno gia' i loro angoli dentro l'immagine,
    /// qui serve solo togliere lo spigolo.
    private var logoCornerRadius: CGFloat { logoSide / 4 }

    var body: some View {
        HStack(spacing: SomtoSpacing.xs) {
            if let data = row.providerLogoData, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: logoSide, height: logoSide)
                    .clipShape(RoundedRectangle(cornerRadius: logoCornerRadius, style: .continuous))
                    // Il contorno non e' decorazione: i logo TMDB sono JPEG
                    // opachi e diversi marchi (HBO Max, Apple TV) sono bianco su
                    // nero — su uno sfondo scuro il riquadro sparisce e resta
                    // una scritta che galleggia. Un filo di bordo lo ridisegna.
                    .overlay(
                        RoundedRectangle(cornerRadius: logoCornerRadius, style: .continuous)
                            // Piu' marcato di `TwoWatchTheme.border` (9%): quel
                            // token separa pannelli grandi, qui deve reggere su
                            // 16pt contro un nero quasi identico.
                            .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
                    )
                    .accessibilityHidden(true)
            }
            Text(row.secondaryLabel)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.accessibilityLabel)
    }
}

private struct UpcomingReleaseDateLabel: View {
    let date: Date

    var body: some View {
        // `format:` e non un formatter costruito a mano: mese e ordine dei
        // campi seguono il locale di chi guarda, non l'italiano.
        Text(date, format: .dateTime.day().month(.abbreviated))
            .font(.footnote)
            .fontWeight(.bold)
            .foregroundStyle(TwoWatchTheme.brandPrimary)
            .lineLimit(1)
    }
}
