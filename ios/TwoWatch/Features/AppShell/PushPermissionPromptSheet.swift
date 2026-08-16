import SwiftUI
import UserNotifications

/// Pre-prompt Somto per le notifiche push, mostrato UNA VOLTA (gate
/// `PushPromptService`/`pushPromptSeenV1`) in due punti: dopo l'onboarding/tour
/// (`RootView`) e dopo l'avvio di un import (`TitlesImportView`). Spiega il
/// valore prima di far comparire il prompt di sistema, cosa che alza
/// sensibilmente l'accept-rate rispetto a chiedere subito senza contesto —
/// solo 4/94 utenti avevano le notifiche attive prima di questo fix.
struct PushPermissionPromptSheet: View {
    @Environment(\.dismiss) private var dismiss

    let onEnable: () async -> Void
    let onDismiss: () -> Void

    @State private var isRequesting = false

    var body: some View {
        ZStack {
            TwoWatchBackground()

            VStack {
                Spacer(minLength: 24)
                GlassCard {
                    content
                }
                .padding(.horizontal, 20)
                Spacer(minLength: 24)
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "bell.badge.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandGradient)
                Text("Attiva le notifiche")
                    .font(.title3.weight(.heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }

            Text("Ti avvisiamo per sfide quiz, consigli degli amici e quando il tuo import è pronto. Niente spam.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 10) {
                Button {
                    Task {
                        isRequesting = true
                        await onEnable()
                        isRequesting = false
                        dismiss()
                    }
                } label: {
                    if isRequesting {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Attiva")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isRequesting)

                Button("Più tardi") {
                    onDismiss()
                    dismiss()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .disabled(isRequesting)
            }
        }
        .padding(.vertical, 4)
    }
}
