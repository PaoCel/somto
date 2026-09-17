import SwiftUI

/// Card "Verifica consigliata" in cima alla Home.
///
/// Era un overlay al top dello ZStack di `RootView`: le tab ignorano gli inset
/// dello shell e si posizionano a mano sotto l'header, quindi copriva i titoli
/// di ogni schermata (setup quiz, player, classifica, inbox sfide). Come
/// contenuto scorre via da sola e non nasconde niente.
struct HomeEmailVerificationBanner: View {
    enum State {
        case idle
        case sending
        /// Link partito: la card resta finche' l'utente non la chiude, se no
        /// la conferma se ne andrebbe insieme al flag di sessione.
        case sent
    }

    let state: State
    let onSendLink: () -> Void
    let onDismiss: () -> Void

    // @ScaledMetric size-preserving: default invariato, scala con Dynamic Type.
    @ScaledMetric(relativeTo: .footnote) private var closeIconSize: CGFloat = 13

    var body: some View {
        GlassCard(padding: 14) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Verifica consigliata")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text(message)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    action
                }

                Spacer(minLength: 0)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: closeIconSize, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(dismissLabel)
            }
        }
    }

    private var message: LocalizedStringKey {
        switch state {
        case .idle, .sending: "Verifica l'email appena puoi per proteggere il tuo account."
        case .sent: "Link inviato. Controlla anche lo spam."
        }
    }

    private var dismissLabel: LocalizedStringKey {
        switch state {
        case .idle, .sending: "Non ora"
        case .sent: "Chiudi il messaggio"
        }
    }

    @ViewBuilder
    private var action: some View {
        switch state {
        case .idle:
            Button("Invia link", action: onSendLink)
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)
        case .sending:
            Text("Invio…")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        case .sent:
            EmptyView()
        }
    }
}
