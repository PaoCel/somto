import XCTest
@testable import Somto

/// Quando il tasto "guarda su …" compare su un titolo, e dove porta.
///
/// Il resolver puro (`StreamingDestinationResolver`) e' coperto in
/// `WatchlistWidgetSnapshotTests`; qui si copre lo strato sopra, quello che
/// decide con i dati che l'app ha davvero in mano — i campi denormalizzati sul
/// `Title` e la risposta della callable — se il bottone c'e'. E' lo stesso
/// strato per scheda titolo, card del feed e pagina del post: se qui compare,
/// compare in tutti e tre.
final class TitleWatchNowDestinationTests: XCTestCase {

    // MARK: - Con i soli dati del titolo (il caso del feed)

    func testConUnLinkDirettoSulTitoloIlTastoCompare() {
        let title = Self.title(
            providerNames: ["Netflix"],
            deepLinks: ["Netflix": "https://www.netflix.com/title/81234567"]
        )

        let destination = TitleWatchNowDestination.resolve(title: title, providers: nil)

        XCTAssertEqual(destination?.providerName, "Netflix")
        XCTAssertEqual(destination?.source, .direct)
        XCTAssertEqual(destination?.url.absoluteString, "https://www.netflix.com/title/81234567")
    }

    func testSenzaLinkMaConUnaRicercaIlTastoCompareComeCerca() {
        let title = Self.title(providerNames: ["Netflix"], deepLinks: [:])

        let destination = TitleWatchNowDestination.resolve(title: title, providers: nil)

        XCTAssertEqual(destination?.source, .providerSearch)
        XCTAssertFalse(destination?.isExact ?? true)
    }

    func testSenzaPiattaformeIlTastoNonCompare() {
        let title = Self.title(providerNames: [], deepLinks: [:])

        XCTAssertNil(TitleWatchNowDestination.resolve(title: title, providers: nil))
    }

    func testSeRestaSoloLaPaginaTmdbIlTastoNonCompare() {
        // Disney+ non ha una ricerca che si possa aprire (404 verificato
        // l'8/9/2026) e qui non c'e' il link diretto: l'unico ripiego sarebbe la
        // pagina "dove guardare" di TMDB, che non e' un'app.
        let title = Self.title(providerNames: ["Disney Plus"], deepLinks: [:], tmdbId: 999)

        XCTAssertNil(TitleWatchNowDestination.resolve(title: title, providers: nil))
    }

    // MARK: - Con la risposta della callable (il caso della scheda titolo)

    func testLaCallableAggiornaLePiattaformeDelTitolo() {
        // Sul titolo c'e' ancora Prime (catalogo vecchio); la callable dice che
        // adesso sta su Netflix con la scheda esatta.
        let title = Self.title(providerNames: ["Amazon Prime Video"], deepLinks: [:])
        let netflix = URL(string: "https://www.netflix.com/title/81234567")!
        let providers = TitleProviders(
            region: "IT",
            link: nil,
            providers: [Self.provider("Netflix", type: "flatrate")],
            customProviders: [],
            deepLinks: ["Netflix": netflix]
        )

        let destination = TitleWatchNowDestination.resolve(title: title, providers: providers)

        XCTAssertEqual(destination?.providerName, "Netflix")
        XCTAssertEqual(destination?.url, netflix)
    }

    func testNoleggioEAcquistoNonFannoComparireIlTasto() {
        // "Guarda su Rakuten TV" su un titolo da noleggiare e' la promessa
        // sbagliata: se la callable ha solo rent/buy, si ricade sul titolo, che
        // qui non ha piattaforme.
        let title = Self.title(providerNames: [], deepLinks: [:])
        let providers = TitleProviders(
            region: "IT",
            link: nil,
            providers: [Self.provider("Rakuten TV", type: "rent"), Self.provider("Apple TV", type: "buy")],
            customProviders: [],
            deepLinks: [:]
        )

        XCTAssertNil(TitleWatchNowDestination.resolve(title: title, providers: providers))
    }

    func testILinkDelTitoloEDellaCallableSiUniscono() {
        // Il titolo conosce il link Netflix, la callable (piu' fresca) ha
        // risolto Apple TV: si uniscono, e il link diretto batte l'ordine.
        let apple = URL(string: "https://tv.apple.com/it/show/ted-lasso/umc.cmc.1")!
        let title = Self.title(
            providerNames: ["Netflix"],
            deepLinks: ["Netflix": "https://www.netflix.com/title/81234567"]
        )
        let providers = TitleProviders(
            region: "IT",
            link: nil,
            providers: [Self.provider("Apple TV", type: "flatrate")],
            customProviders: [],
            deepLinks: ["Apple TV": apple]
        )

        let destination = TitleWatchNowDestination.resolve(title: title, providers: providers)

        XCTAssertEqual(destination?.providerName, "Apple TV")
        XCTAssertEqual(destination?.url, apple)
    }

    // MARK: - Il logo

    func testIlLogoSiTrovaAncheColNomeCollassato() {
        let logo = URL(string: "https://image.tmdb.org/t/p/w154/apple.png")!
        let title = TitleParsing.title(
            from: [
                "name": "Un titolo",
                "type": "tv",
                "watchProviderNames": ["Apple TV Amazon Channel"],
                "watchProviderLogos": [["name": "Apple TV Amazon Channel", "logoUrl": logo.absoluteString]],
            ],
            documentID: "titolo"
        )

        // Il bottone mostra il nome collassato ("Apple TV"): il logo deve
        // trovarsi lo stesso.
        XCTAssertEqual(TitleWatchNowDestination.logoURL(for: "Apple TV", title: title, providers: nil), logo)
    }

    // MARK: - Helpers

    private static func title(
        providerNames: [String],
        deepLinks: [String: String],
        tmdbId: Int? = nil
    ) -> Title {
        var data: [String: Any] = [
            "name": "Un titolo",
            "type": "tv",
            "watchProviderNames": providerNames,
            "watchDeepLinks": deepLinks,
        ]
        if let tmdbId {
            data["tmdbId"] = tmdbId
        }
        return TitleParsing.title(from: data, documentID: "titolo")
    }

    private static func provider(_ name: String, type: String) -> StreamingProvider {
        StreamingProvider(id: name.lowercased(), name: name, logoURL: nil, type: type)
    }
}
