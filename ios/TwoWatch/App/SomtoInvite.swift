import Foundation

/// Link e testo condivisi per "Invita un amico". Allineato 1:1 alla web
/// (`public/js/utils/inviteShare.js`). L'URL `https://somto.it/` è un universal
/// link registrato in AASA (path "/"), quindi apre l'app se installata, altrimenti
/// il sito.
enum SomtoInvite {
    static let url = URL(string: "https://somto.it/")!

    static let message = String(localized: "Ti va di provare Somto con me? È il social per film e serie TV: watchlist, voti, quiz e consigli tra amici 🎬 Su iPhone è su App Store, su Android funziona come app direttamente dal sito.")
}
