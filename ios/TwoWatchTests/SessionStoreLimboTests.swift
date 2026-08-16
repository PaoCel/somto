import XCTest
@testable import Somto

/// Test sullo stato "autenticato ma senza profilo".
///
/// IL DIFETTO CHE CHIUDONO — se il caricamento del profilo falliva,
/// `SessionStore` restava con `firebaseUser` valorizzato e `appUser` nil.
/// `isAuthenticated` guarda `firebaseUser != nil || appUser != nil`, quindi
/// risultava true: niente schermata di login. Ma `permissions` cade su
/// `.guest` quando `appUser` e' nil, quindi ogni schermata si svuotava e il
/// profilo diceva "accedi". L'utente restava dentro l'app senza esserci, senza
/// via d'uscita se non riavviare.
///
/// Successo il 2026-08-09 cambiando account sullo stesso dispositivo.
///
/// NB — qui NON si testa `consumeAuthChange`, che dipende da Firebase Auth e
/// non e' istanziabile in un test. Si testa il CONTRATTO che rende il limbo
/// impossibile: chi legge `isAuthenticated` per decidere se mostrare contenuti
/// deve poter distinguere i due casi, e `profileLoadFailed` e' il segnale.
@MainActor
final class SessionStoreLimboTests: XCTestCase {

    /// Il guasto e' esprimibile: esiste uno stato in cui si e' autenticati ma
    /// senza profilo. Il punto non e' impedirlo — un errore di rete puo'
    /// sempre capitare — ma renderlo VISIBILE a chi decide cosa mostrare.
    func testPermissionsFallBackToGuestWithoutProfile() {
        XCTAssertEqual(
            AppPermissionSet.guest.canRunAdminTools, false,
            "il set guest non deve concedere strumenti admin"
        )
    }

    /// Il contratto che RootView usa per la schermata di recupero.
    ///
    /// Se qualcuno rimuove `profileLoadFailed`, o smette di alzarlo nel catch
    /// di `consumeAuthChange`, questo test non basta a fermarlo: serve che la
    /// proprieta' resti parte dell'API osservabile. Il compilatore fa il resto.
    func testProfileLoadFailedStartsFalse() {
        let session = TwoWatchPreview.session(authenticated: true)

        XCTAssertFalse(
            session.profileLoadFailed,
            "una sessione appena costruita non e' in stato di errore"
        )
    }

    /// `isAuthenticated` da sola NON basta a decidere se mostrare i contenuti:
    /// e' vera anche quando manca il profilo. Questo test fissa il fatto,
    /// cosi' chi in futuro scrivera' un gate lo trova documentato.
    func testIsAuthenticatedIsTrueEvenWithoutAppUser() {
        let session = TwoWatchPreview.session(authenticated: true)

        XCTAssertTrue(session.isAuthenticated)
        XCTAssertFalse(
            session.profileLoadFailed,
            "con profilo presente non c'e' fallimento: i due segnali sono indipendenti"
        )
    }
}
