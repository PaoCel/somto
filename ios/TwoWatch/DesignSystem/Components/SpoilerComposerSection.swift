import SwiftUI

/// Toggle "Contiene spoiler" + multi-pick titoli per composer di
/// `threads.messages`, `posts`, `posts.comments`, `recommendations`.
/// Massimo 5 titoli selezionabili (allineato alle Firestore rules).
struct SpoilerComposerSection: View {
    @Binding var containsSpoiler: Bool
    @Binding var spoilerTitleIDs: [String]

    /// Pool di titoli proponibili. In genere: il titolo del thread (se DM su
    /// titolo), o i titoli completati dall'utente. Se vuoto, il picker mostra
    /// un fallback testuale e disabilita la selezione.
    let candidateTitles: [Title]

    /// Limite hard allineato alle Firestore rules (`spoilerTitleIds.size() <= 5`).
    private let maxSelection = 5

    private var selectionSet: Set<String> {
        Set(spoilerTitleIDs)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: $containsSpoiler) {
                Label("Contiene spoiler", systemImage: "eye.slash.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }
            .toggleStyle(.switch)
            .tint(TwoWatchTheme.brandPrimary)

            if containsSpoiler {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Su quali titoli?")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)

                    if candidateTitles.isEmpty {
                        Text("Nessun titolo selezionabile. Verrà mostrato come spoiler a chi non l'ha visto.")
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(candidateTitles) { title in
                                    let isSelected = selectionSet.contains(title.id)
                                    let isAtCap = !isSelected && spoilerTitleIDs.count >= maxSelection
                                    Button {
                                        toggle(title.id)
                                    } label: {
                                        HStack(spacing: 6) {
                                            Image(systemName: isSelected ? "checkmark.circle.fill" : "plus.circle")
                                                .font(.caption.weight(.bold))
                                            Text(title.name)
                                                .lineLimit(1)
                                                .font(.caption.weight(.medium))
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .background(
                                            Capsule(style: .continuous)
                                                .fill(isSelected
                                                    ? TwoWatchTheme.brandPrimary.opacity(0.22)
                                                    : TwoWatchTheme.panel.opacity(0.7))
                                        )
                                        .overlay(
                                            Capsule(style: .continuous)
                                                .stroke(isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border, lineWidth: 1)
                                        )
                                        .foregroundStyle(isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textPrimary)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(isAtCap)
                                    .opacity(isAtCap ? 0.45 : 1)
                                }
                            }
                        }
                    }

                    Text("Massimo \(maxSelection) titoli. Verrà mostrato in chiaro solo a chi li ha già completati.")
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: containsSpoiler)
    }

    private func toggle(_ id: String) {
        if let idx = spoilerTitleIDs.firstIndex(of: id) {
            spoilerTitleIDs.remove(at: idx)
        } else if spoilerTitleIDs.count < maxSelection {
            spoilerTitleIDs.append(id)
        }
    }
}
