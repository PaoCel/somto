import SwiftUI

/// Wrapper di rendering per contenuti social potenzialmente spoiler.
/// Mostra `content` in blur con overlay "Tocca per mostrare" finché il viewer
/// non ha completato TUTTI i titoli in `spoilerTitleIDs`. Il tap "Ho visto X"
/// invoca `onMarkSeen(titleID)` (il chiamante deve persistere il
/// completamento via WatchlistRepository + aggiornare la cache su SessionStore).
struct SpoilerGate<Content: View>: View {
    let containsSpoiler: Bool
    let spoilerTitleIDs: [String]
    let viewerCompletedTitleIDs: Set<String>
    /// Mappa opzionale `titleId -> displayName` per mostrare il nome del titolo
    /// nel bottone "Ho visto X" invece dell'ID raw.
    let titleNames: [String: String]
    let onMarkSeen: (String) async -> Void
    @ViewBuilder var content: () -> Content

    @State private var revealed = false
    @State private var markInFlight: String?

    private var missingTitleIDs: [String] {
        spoilerTitleIDs.filter { !viewerCompletedTitleIDs.contains($0) }
    }

    /// Il contenuto va nascosto se è flaggato spoiler, il viewer non ha
    /// completato tutti i titoli e non ha già toccato "mostra".
    private var isHidden: Bool {
        guard containsSpoiler else { return false }
        if revealed { return false }
        return !missingTitleIDs.isEmpty
    }

    var body: some View {
        ZStack(alignment: .center) {
            content()
                .blur(radius: isHidden ? 18 : 0)
                .allowsHitTesting(!isHidden)
                .accessibilityHidden(isHidden)

            if isHidden {
                overlay
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isHidden)
    }

    private var overlay: some View {
        VStack(spacing: 10) {
            Image(systemName: "eye.slash.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)

            Text("Contiene spoiler")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Text(subtitleText)
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(TwoWatchTheme.textSecondary)

            Button("Tocca per mostrare") {
                revealed = true
            }
            .buttonStyle(.borderedProminent)
            .tint(TwoWatchTheme.brandPrimary)

            if !missingTitleIDs.isEmpty {
                VStack(spacing: 6) {
                    ForEach(missingTitleIDs.prefix(3), id: \.self) { tid in
                        Button {
                            Task { await mark(tid) }
                        } label: {
                            HStack(spacing: 6) {
                                if markInFlight == tid {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "checkmark.circle")
                                        .font(.caption)
                                }
                                Text("Ho visto: \(displayName(for: tid))")
                                    .font(.caption.weight(.medium))
                                    .lineLimit(1)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                Capsule().fill(TwoWatchTheme.panel.opacity(0.85))
                            )
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        }
                        .buttonStyle(.plain)
                        .disabled(markInFlight != nil)
                    }
                    if missingTitleIDs.count > 3 {
                        Text("+\(missingTitleIDs.count - 3) altri titoli")
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .padding(8)
    }

    private var subtitleText: String {
        let count = missingTitleIDs.count
        if count == 1 {
            return String(localized: "Su un titolo che non hai ancora visto.")
        }
        return "Su \(count) titoli che non hai ancora visto."
    }

    private func displayName(for titleID: String) -> String {
        titleNames[titleID]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? titleNames[titleID]!
            : titleID
    }

    private func mark(_ titleID: String) async {
        markInFlight = titleID
        await onMarkSeen(titleID)
        markInFlight = nil
    }
}
