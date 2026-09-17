import StoreKit
import SwiftUI
import UIKit

struct RatingPromptSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.requestReview) private var requestReview

    let service: RatingPromptService

    @State private var step: Step = .askingLove

    private enum Step {
        case askingLove
        case offeringFeedback
        case thankYou
    }

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
        .interactiveDismissDisabled(false)
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .askingLove:
            askingLoveContent
        case .offeringFeedback:
            feedbackContent
        case .thankYou:
            thankYouContent
        }
    }

    private var askingLoveContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                Text("Ti sta piacendo Somto?")
                    .font(.title3.weight(.heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }

            Text("Faccelo sapere in due secondi: ci aiuta a migliorare l'app.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 10) {
                Button {
                    handleLoved()
                } label: {
                    Label("Sì, mi piace", systemImage: "hand.thumbsup.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())

                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        step = .offeringFeedback
                    }
                } label: {
                    Text("Si può migliorare")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(TwoWatchTheme.textSecondary)

                Button("Più tardi") {
                    service.recordOutcome(.postponed, version: RatingPromptService.currentAppVersion)
                    dismiss()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
    }

    private var feedbackContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "ear.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                Text("Cosa possiamo migliorare?")
                    .font(.title3.weight(.heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }

            Text("Scrivici due righe: leggiamo davvero ogni messaggio e useremo le tue idee per le prossime release.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 10) {
                Button {
                    openFeedbackMail()
                } label: {
                    Label("Mandaci un'idea", systemImage: "envelope.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())

                Button("Chiudi") {
                    service.recordOutcome(.complained, version: RatingPromptService.currentAppVersion)
                    dismiss()
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
    }

    private var thankYouContent: some View {
        VStack(spacing: 14) {
            Image(systemName: "heart.fill")
                .font(.system(size: 38, weight: .bold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            Text("Grazie davvero")
                .font(.title3.weight(.heavy))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text("Se ti va, lascia una recensione: ci aiuta tantissimo a far conoscere Somto.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .multilineTextAlignment(.center)

            Button("Chiudi") { dismiss() }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .padding(.top, 4)
        }
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
    }

    private func handleLoved() {
        let version = RatingPromptService.currentAppVersion
        service.recordOutcome(.loved, version: version)
        requestReview()
        withAnimation(.easeInOut(duration: 0.2)) {
            step = .thankYou
        }
    }

    private func openFeedbackMail() {
        service.recordOutcome(.complained, version: RatingPromptService.currentAppVersion)
        let subject = "Feedback Somto v\(RatingPromptService.currentAppVersion)".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "Feedback%20Somto"
        let urlString = "mailto:support@somto.it?subject=\(subject)"
        if let url = URL(string: urlString) {
            UIApplication.shared.open(url)
        }
        dismiss()
    }
}
