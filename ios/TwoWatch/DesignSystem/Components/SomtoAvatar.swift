import SwiftUI

// Avatar di Somto: UNA implementazione.
//
// PERCHE' — al 2026-08-08 l'app aveva 6 View avatar distinte
// (MentionSuggestionAvatarView, PostCommentAvatarView, PostDetailAvatarView,
// RatingAuthorAvatarView, TitleReviewAvatar, e l'avatar dentro CharacterPickRow)
// piu' 19 funzioni fra `initials(for:)` (10 copie) e `avatarFallback(...)`
// (9 copie), sparse su Quiz, TitleDetail, Community, Search, Threads, Profile
// e AppMenu. Tutte facevano la stessa cosa con dettagli leggermente diversi:
// alcune mostravano una lettera, altre due; alcune ripiegavano su "?", altre
// su "S".
//
// Questo tipo e' un wrapper View e non un modificatore, al contrario di
// `somtoCard`: qui il contenuto lo produce il componente stesso (immagine o
// iniziali), non lo si sta decorando.

/// Iniziali da un nome, con la regola unica del prodotto: prima lettera del
/// primo e dell'ultimo token. Estratta perche' serve anche fuori dall'avatar
/// (menzioni, elenchi testuali).
enum SomtoInitials {
    /// Quante lettere mostrare.
    ///
    /// NB — l'app oggi NON e' coerente: le 10 copie di `initials(for:)` ne
    /// mostrano due, le 9 di `avatarFallback` una sola. Le due varianti
    /// esistono qui per poter migrare i call site **senza cambiare l'aspetto**
    /// di nessuno: unificarle e' una decisione di prodotto, non di refactoring,
    /// e va presa a parte.
    enum Style {
        /// Iniziale del primo e dell'ultimo token: "Paolo Celestini" -> "PC".
        case double
        /// Solo la prima lettera: "Paolo Celestini" -> "P".
        case single
    }

    /// Regola a due lettere: prima lettera della prima parola + prima
    /// dell'ultima; per i nomi a parola SINGOLA, la seconda lettera della
    /// stessa parola ("Cher" -> "CH").
    ///
    /// E' la regola del web, ed e' quella scelta come unica: la parita' di
    /// resa fra PWA e iOS e' un vincolo di prodotto, non un dettaglio. Fra le
    /// implementazioni trovate nell'app ne convivevano due — l'altra restituiva
    /// "C" per i nomi a parola singola — ma solo questa portava il commento
    /// "Come sul web", cioe' era deliberata.
    ///
    /// - Parameter fallback: cosa mostrare quando il nome e' vuoto o illeggibile.
    static func from(_ name: String?, style: Style = .double, fallback: String = "?") -> String {
        let parts = (name ?? "").split(whereSeparator: \.isWhitespace)
        guard let firstWord = parts.first, let firstChar = firstWord.first else { return fallback }
        guard style == .double else { return String(firstChar).uppercased() }
        let second = parts.count > 1
            ? (parts.last?.first.map(String.init) ?? "")
            : (firstWord.dropFirst().first.map(String.init) ?? "")
        return (String(firstChar) + second).uppercased()
    }
}

struct SomtoAvatar: View {
    let url: URL?
    let name: String?
    var size: CGFloat = 40
    /// Bordo sottile: serve quando l'avatar sta su una superficie dello stesso
    /// tono dell'immagine e altrimenti ci si confonde.
    var showsBorder: Bool = false
    /// Default a due lettere. I call site che oggi ne mostrano una passano
    /// `.single`, cosi' la migrazione non cambia cosa vede l'utente.
    var initialsStyle: SomtoInitials.Style = .double
    private var initials: String { SomtoInitials.from(name, style: initialsStyle) }

    /// Le iniziali devono scalare con l'avatar: a 24pt il font della title
    /// sbordava, a 96pt spariva. 0,38 e' il rapporto che regge su tutte le
    /// taglie in uso (24, 32, 40, 48, 64, 96).
    /// NB — qui la dimensione dipende dal diametro dell'avatar, che e' fisso:
    /// scalarla con Dynamic Type farebbe uscire le iniziali dal cerchio.
    /// Il testo resta leggibile perche' il cerchio stesso e' grande abbastanza,
    /// e c'e' `minimumScaleFactor` sotto. E' l'eccezione motivata alla regola.
    private var initialsFont: Font {
        .system(size: size * 0.38, weight: .heavy)
    }

    var body: some View {
        Group {
            if let url {
                // API phase-based, come `AsyncImage` e come il resto dei
                // call site (PosterImageView, CharacterPickRow).
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFill()
                    case .failure:
                        // Immagine rotta o offline: le iniziali sono meglio di
                        // un riquadro vuoto.
                        fallback
                    case .empty:
                        fallback
                    @unknown default:
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay {
            if showsBorder {
                Circle().stroke(TwoWatchTheme.border, lineWidth: 1)
            }
        }
        .accessibilityLabel(name.map { Text($0) } ?? Text("Avatar"))
    }

    private var fallback: some View {
        ZStack {
            TwoWatchTheme.brandGradient
            Text(initials)
                .font(initialsFont)
                .foregroundStyle(.white)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
        }
    }
}

#if DEBUG
#Preview("SomtoAvatar") {
    VStack(spacing: SomtoSpacing.xxl) {
        HStack(spacing: SomtoSpacing.l) {
            SomtoAvatar(url: nil, name: "Paolo Celestini", size: 24)
            SomtoAvatar(url: nil, name: "Paolo Celestini", size: 40)
            SomtoAvatar(url: nil, name: "Paolo Celestini", size: 64)
            SomtoAvatar(url: nil, name: "Paolo Celestini", size: 96)
        }
        HStack(spacing: SomtoSpacing.l) {
            SomtoAvatar(url: nil, name: "Cher", size: 48)
            SomtoAvatar(url: nil, name: nil, size: 48)
            SomtoAvatar(url: nil, name: "  ", size: 48)
            SomtoAvatar(url: nil, name: "Ada Lovelace", size: 48, showsBorder: true)
        }
        HStack(spacing: SomtoSpacing.l) {
            SomtoAvatar(url: nil, name: "Paolo Celestini", size: 48, initialsStyle: .single)
        }
    }
    .padding()
    .background(TwoWatchTheme.background)
}
#endif
