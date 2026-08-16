import SwiftUI

// Token di layout di Somto.
//
// PERCHE' — `TwoWatchTheme` copriva solo i colori. Spaziature, raggi e ombre
// erano numeri scritti a mano nei file delle feature: 476 `RoundedRectangle`
// inline, 26 valori distinti di `cornerRadius`, 15+ di `spacing`. Non e' un
// problema estetico: significa che "la card di Somto" non esiste come oggetto,
// e cambiarne il raggio e' un lavoro manuale su decine di file.
//
// NON E' UN REDESIGN — i valori qui sotto sono quelli GIA' dominanti nel
// codice, non nuovi. Migrare un call site ai token deve lasciare i pixel dove
// sono. Se una schermata cambia aspetto durante la migrazione, e' un errore
// di migrazione, non un miglioramento.
//
// Misure su 7bb33c0, in ordine di frequenza reale:
//   cornerRadius  18 (109), 14 (86), 16 (85), 22 (48), 20 (43), 12 (36), 24 (25)
//   spacing       10 (258), 12 (228), 8 (169), 6 (131), 14 (107), 4 (82), 16 (64)

// MARK: - Spaziature

/// Scala di spaziatura. Non e' una griglia 4/8 pura: il codice usa
/// massicciamente 10, 6 e 14, e forzarli a 8/16 sposterebbe pixel ovunque.
/// I nomi seguono la frequenza d'uso, non un ideale astratto.
enum SomtoSpacing {
    /// 2 — separazione minima fra elementi legati (label e sua icona).
    static let xxs: CGFloat = 2
    /// 4 — dentro un chip, fra glifo e testo.
    static let xs: CGFloat = 4
    /// 6 — righe di una lista densa.
    static let s: CGFloat = 6
    /// 8 — spaziatura interna standard dei componenti piccoli.
    static let m: CGFloat = 8
    /// 10 — il valore piu' usato dell'app: elementi dentro una sezione.
    static let ml: CGFloat = 10
    /// 12 — fra blocchi dentro una card.
    static let l: CGFloat = 12
    /// 14 — padding orizzontale delle card compatte.
    static let xl: CGFloat = 14
    /// 16 — padding standard delle card e margine di schermata compatta.
    static let xxl: CGFloat = 16
    /// 20 — margine di schermata su larghezze regular.
    static let xxxl: CGFloat = 20
    /// 24 — fra sezioni diverse della stessa schermata.
    static let section: CGFloat = 24
}

// MARK: - Raggi

/// Raggi degli angoli. Da 26 valori distinti a 6: le occorrenze fuori scala
/// (19, 13, 11, 9, 7, 3, 2, 1) erano una manciata ciascuna e cadono nel
/// vicino piu' prossimo senza differenza percepibile.
enum SomtoRadius {
    /// 8 — badge e chip piccoli.
    static let xs: CGFloat = 8
    /// 12 — controlli e pill.
    static let s: CGFloat = 12
    /// 14 — card compatte (86 occorrenze).
    static let m: CGFloat = 14
    /// 18 — il raggio piu' usato dell'app (109 occorrenze): card di sezione.
    static let l: CGFloat = 18
    /// 24 — contenitori grandi, fogli, `GlassCard`.
    static let xl: CGFloat = 24
    /// Capsula piena. Da usare al posto di `cornerRadius: 999`.
    static let pill: CGFloat = 999
}

// MARK: - Elevazione

/// Le tre ombre in uso, al posto di 47 `.shadow(...)` con parametri a mano.
enum SomtoElevation {
    case none
    /// Distacco appena percettibile: righe e chip sollevati.
    case low
    /// Card che galleggiano sul fondo.
    case medium
    /// Fogli e overlay modali.
    case high

    var radius: CGFloat {
        switch self {
        case .none: 0
        case .low: 6
        case .medium: 18
        case .high: 28
        }
    }

    var opacity: Double {
        switch self {
        case .none: 0
        case .low: 0.18
        case .medium: 0.32
        case .high: 0.42
        }
    }

    var offsetY: CGFloat {
        switch self {
        case .none: 0
        case .low: 3
        case .medium: 10
        case .high: 16
        }
    }
}

extension View {
    /// Ombra coerente col livello di elevazione.
    func somtoElevation(_ level: SomtoElevation) -> some View {
        shadow(
            color: .black.opacity(level.opacity),
            radius: level.radius,
            y: level.offsetY
        )
    }
}

// MARK: - Card

/// Le varianti di superficie realmente presenti nel prodotto.
enum SomtoSurface {
    /// Materiale traslucido con bordo: la card storica (`GlassCard`).
    case glass
    /// Pannello pieno, leggermente piu' chiaro del fondo.
    case panel
    /// Nessun fondo: solo padding e raggio, per contenuti gia' su una superficie.
    case plain
}

/// Card di Somto come MODIFICATORE, non come View che avvolge.
///
/// Perche' un `ViewModifier` e non un wrapper: un wrapper aggiunge un livello
/// alla gerarchia e obbliga a propagare i generics del contenuto. Un
/// modificatore decora quello che c'e' gia' e resta componibile con il resto
/// della catena — `.somtoCard()` si legge dove prima c'era `.background(...)`,
/// senza reindentare il blocco.
struct SomtoCardModifier: ViewModifier {
    var surface: SomtoSurface = .glass
    var radius: CGFloat = SomtoRadius.xl
    var padding: CGFloat = SomtoSpacing.xxl
    var elevation: SomtoElevation = .medium

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: surface == .plain ? 0 : 1)
            )
            .somtoElevation(elevation)
    }

    @ViewBuilder
    private var background: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        switch surface {
        case .glass:
            shape.fill(.ultraThinMaterial.opacity(0.92))
        case .panel:
            shape.fill(TwoWatchTheme.panel)
        case .plain:
            shape.fill(Color.clear)
        }
    }
}

extension View {
    /// Applica la card di Somto. I default riproducono `GlassCard`, che resta
    /// valida: i suoi 62 call site migrano quando si tocca il file, non tutti
    /// insieme.
    func somtoCard(
        _ surface: SomtoSurface = .glass,
        radius: CGFloat = SomtoRadius.xl,
        padding: CGFloat = SomtoSpacing.xxl,
        elevation: SomtoElevation = .medium
    ) -> some View {
        modifier(SomtoCardModifier(
            surface: surface,
            radius: radius,
            padding: padding,
            elevation: elevation
        ))
    }
}
