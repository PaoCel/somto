import SwiftUI

// Chip di stato, promemoria voto e sheet di voto rapido della Watchlist,
// estratti da WatchlistView.swift.

struct StatusChip: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tint.opacity(0.14), in: Capsule())
    }
}

struct WatchlistRatingReminderBanner: View {
    let title: Title
    let onOpenRating: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title.name)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                Button("Per votarlo clicca qui", action: onOpenRating)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .buttonStyle(.plain)
            }

            Spacer(minLength: 0)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.black))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .frame(width: 28, height: 28)
                    .background(TwoWatchTheme.panelStrong, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Chiudi promemoria voto")
        }
        .padding(14)
        .background(TwoWatchTheme.backgroundSecondary.opacity(0.96), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

struct QuickRatingSheet: View {
    let title: Title
    let onSubmit: (Double) -> Void
    let onMarkLater: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(title.name)
                .font(.title3.weight(.black))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text("Vota subito senza uscire dalla coda Da votare.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 5), spacing: 10) {
                ForEach(1...10, id: \.self) { value in
                    Button {
                        onSubmit(Double(value))
                        dismiss()
                    } label: {
                        Text("\(value)")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 16)
                            .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }

            Button("Vota più tardi") {
                onMarkLater()
                dismiss()
            }
            .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.textSecondary))
        }
        .padding(24)
        .background(TwoWatchBackground())
    }
}

/// Card a griglia per un titolo dentro una lista custom: locandina + logo
/// piattaforma streaming + badge Film/Serie, tre puntini per le azioni rapide
/// (avanza episodio, segna visto, rimuovi) e tap sulla card per aprire la scheda.
