import XCTest
@testable import Somto

/// Le FORME di documento che il catalogo contiene davvero.
///
/// PERCHE' — `title(from:documentID:)` ha otto rami di fallback. Ognuno esiste
/// perche' una forma diversa di documento e' stata scritta, in qualche momento,
/// da uno dei quattro produttori (iOS, web, Cloud Functions, importer). Finora
/// quei rami erano difesi solo dalla speranza: la funzione era `private` dentro
/// una classe che parla con Firestore, e nessun test poteva costruirle un input.
///
/// Qui ogni forma ha il suo test. Da adesso, chi tocca il parser sa subito
/// quale forma rompe — e quando i dati saranno normalizzati, si cancella il
/// test insieme al ramo.
///
/// NB — le fixture sono costruite dai rami del parser, non pescate da
/// produzione (non ho accesso al catalogo). Descrivono cio' che il codice
/// dichiara di dover gestire. Il passo successivo, quando ci saranno i numeri
/// di `FallbackProbe`, e' sostituirle con documenti veri anonimizzati.
final class TitleShapesTests: XCTestCase {

    override func setUp() {
        super.setUp()
        FallbackProbe.resetForTesting()
    }

    // MARK: - Forma moderna

    /// Come scrive oggi il backend: tutto al suo posto, nessun fallback.
    func testModernShapeNeedsNoFallback() {
        let title = TitleParsing.title(
            from: [
                "name": "Dune: Parte Due",
                "nameLower": "dune parte due",
                "type": "movie",
                "year": 2024,
                "tmdbId": 693_134,
                "meta": ["mediaType": "movie", "language": "it"],
                "search": ["searchableText": "dune parte due", "dedupeKey": "movie_693134"]
            ],
            documentID: "title-dune-2"
        )

        XCTAssertEqual(title.name, "Dune: Parte Due")
        XCTAssertEqual(title.type, .movie)
        XCTAssertEqual(title.metadata.tmdbId, 693_134)
        XCTAssertTrue(
            FallbackProbe.observedKeys.isEmpty,
            "un documento moderno non deve attivare nessun fallback: invece ha attivato \(FallbackProbe.observedKeys)"
        )
    }

    // MARK: - Forme legacy, una per ramo

    /// `tmdbId` dentro `meta` invece che al root.
    func testTMDBIdInsideMeta() {
        let title = TitleParsing.title(
            from: ["name": "X", "type": "tv", "meta": ["tmdbId": 1399]],
            documentID: "qualcosa"
        )

        XCTAssertEqual(title.metadata.tmdbId, 1399)
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.tmdbId.fromMeta"))
    }

    /// Nessun `tmdbId` da nessuna parte: si ricava dal doc id canonico.
    func testTMDBIdDerivedFromDocumentID() {
        let title = TitleParsing.title(from: ["name": "X"], documentID: "tmdb_movie_603")

        XCTAssertEqual(title.metadata.tmdbId, 603)
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.tmdbId.fromDocID"))
    }

    /// Nessun campo `type`: si deduce dal doc id.
    func testTypeDerivedFromDocumentID() {
        let title = TitleParsing.title(from: ["name": "X"], documentID: "tmdb_tv_1399")

        XCTAssertEqual(title.type, .tv)
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.type.fromDocID"))
    }

    /// Ne' `type` ne' doc id canonico: default a film.
    ///
    /// E' il ramo piu' pericoloso dei nove: una serie senza `type` e con un id
    /// non canonico viene letta come FILM, e nell'app si comporta di
    /// conseguenza (niente stagioni, niente progresso episodi). Se `FallbackProbe`
    /// lo trova vivo in produzione, e' un bug di dati da riparare, non un ramo
    /// da conservare.
    func testTypeFallsBackToMovieWhenUndeterminable() {
        let title = TitleParsing.title(from: ["name": "X"], documentID: "id-non-canonico")

        XCTAssertEqual(title.type, .movie)
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.type.defaultMovie"))
    }

    /// `originalLanguage` al root invece che in `meta`.
    func testOriginalLanguageAtRoot() {
        let title = TitleParsing.title(
            from: ["name": "X", "type": "movie", "originalLanguage": "en"],
            documentID: "x"
        )

        XCTAssertEqual(title.metadata.originalLanguage, "en")
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.originalLanguage.fromRoot"))
    }

    /// Dati collection al root invece che in `meta`.
    func testCollectionFieldsAtRoot() {
        let title = TitleParsing.title(
            from: [
                "name": "X", "type": "movie",
                "collectionId": 726_871,
                "collectionName": "Dune Collection"
            ],
            documentID: "x"
        )

        XCTAssertEqual(title.metadata.collectionId, 726_871)
        XCTAssertEqual(title.collectionName, "Dune Collection")
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.collectionId.fromRoot"))
    }

    /// `searchableText` al root invece che dentro `search`.
    func testSearchableTextAtRoot() {
        let title = TitleParsing.title(
            from: ["name": "X", "type": "movie", "searchableText": "gia calcolato"],
            documentID: "x"
        )

        XCTAssertEqual(title.searchableText, "gia calcolato")
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.searchableText.fromRoot"))
    }

    /// Nessun `searchableText` salvato: viene ricomposto a runtime dai campi.
    ///
    /// Se questo ramo e' vivo, la ricerca su quei documenti dipende da una
    /// stringa che il server non ha mai visto — quindi il client e il backend
    /// possono cercare cose diverse.
    func testSearchableTextRecomputedFromFields() {
        let title = TitleParsing.title(
            from: [
                "name": "Interstellar",
                "type": "movie",
                "originalName": "Interstellar",
                "keywords": ["spazio", "tempo"]
            ],
            documentID: "x"
        )

        XCTAssertTrue(title.searchableText.contains("Interstellar"))
        XCTAssertTrue(title.searchableText.contains("spazio"))
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.searchableText.recomputed"))
    }

    /// Scadenza refresh TMDB salvata in millisecondi invece che come timestamp.
    func testNextCheckAtFromMilliseconds() {
        let millis = 1_735_689_600_000.0   // 2025-01-01
        let title = TitleParsing.title(
            from: ["name": "X", "type": "movie", "tmdbSync": ["nextCheckAtMs": millis]],
            documentID: "x"
        )

        XCTAssertNotNil(title.tmdbNextRefreshAt)
        XCTAssertTrue(FallbackProbe.observedKeys.contains("Title.nextCheckAt.fromMillis"))
    }

    // MARK: - Robustezza

    /// Un documento vuoto non deve far crollare niente: e' il caso che una
    /// migrazione andata storta potrebbe produrre.
    func testEmptyDocumentDoesNotCrash() {
        let title = TitleParsing.title(from: [:], documentID: "vuoto")

        XCTAssertEqual(title.id, "vuoto")
        XCTAssertEqual(title.name, "Senza titolo")
        XCTAssertEqual(title.status, "approved")
    }

    /// `originCountry` puo' stare in ENTRAMBI i posti: il parser li concatena,
    /// non ne sceglie uno. Fissato perche' non e' ovvio leggendo il codice.
    func testOriginCountryIsConcatenatedNotChosen() {
        let title = TitleParsing.title(
            from: [
                "name": "X", "type": "tv",
                "originCountry": ["US"],
                "meta": ["originCountry": ["GB"]]
            ],
            documentID: "x"
        )

        XCTAssertEqual(Set(title.metadata.originCountry), ["US", "GB"])
    }
}
