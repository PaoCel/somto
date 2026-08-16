import SwiftUI

/// Stato dell'import in Home (docs/ONBOARDING_V2.md, fase 6).
///
/// Il momento in cui si perdono gli utenti che arrivano da TV Time o Trakt non
/// è l'onboarding: è l'attesa dopo. Chi importa esce dal funnel e trova una
/// Home che non gli dice niente mentre il job macina. Qui gliene parliamo.
///
/// La push di fine import esiste già server-side (`titles_import_completed`):
/// questo è il corrispettivo per chi ha l'app aperta o non ha mai concesso il
/// permesso notifiche — cioè la maggioranza.
struct HomeImportBanner: View {
    enum State {
        case running(TitlesImportJob)
        /// Reveal una-tantum: job finito + titoli agganciati alla libreria.
        case completed(TitlesImportJob, Int)
    }

    let state: State
    let onOpen: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        GlassCard(padding: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: iconName)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button(ctaTitle, action: onOpen)
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                        .padding(.top, 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .padding(6)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Chiudi")
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var iconName: String {
        switch state {
        case .running: return "hourglass"
        case .completed: return "checkmark.seal.fill"
        }
    }

    private var title: String {
        switch state {
        case .running: return String(localized: "Stiamo importando la tua cronologia")
        case .completed: return String(localized: "La tua libreria è pronta")
        }
    }

    private var message: String {
        switch state {
        case .running:
            return String(localized: "Ci pensiamo noi: ti avvisiamo appena la tua libreria è pronta.")
        case let .completed(_, count):
            return String(localized: "\(count) titoli sono nei tuoi Visti.")
        }
    }

    private var ctaTitle: String {
        switch state {
        case .running: return String(localized: "Vedi")
        case .completed: return String(localized: "Guarda")
        }
    }
}
