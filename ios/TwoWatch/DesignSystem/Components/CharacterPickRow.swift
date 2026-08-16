import SwiftUI
import UIKit

/// Riga orizzontale compatta per scegliere fino a 3 personaggi preferiti
/// ("Chi ti ha conquistato?"). Vive dentro un flusso già esistente (foglio
/// post-visione, composer voto) — **mai** una schermata a sé: vincolo di
/// prodotto non negoziabile (v. `docs/CHARACTER_VOTES_SPEC.md` §7).
///
/// Interazione:
/// - primo tap su un volto libero → selezione, badge numerico 1-3 in ordine
///   di scelta;
/// - secondo tap sullo STESSO volto già scelto → apre una striscia di
///   reazioni opzionali inline (le 12 emozioni di `EmotionGridPicker`, stesse
///   chiavi/etichette), da cui si può anche rimuovere il pick;
/// - al cap di 3, i volti non scelti si affievoliscono + haptic leggero,
///   stessa grammatica visiva di `EmotionGridPicker`.
///
/// Componente "dumb": nessun networking. Il chiamante passa i candidati già
/// caricati e riceve `onChange` a ogni mutazione — chi salva "al tocco"
/// (`EpisodeSeenSheet`) lo usa per un submit silenzioso in background; chi
/// salva in blocco col resto del form (`RatingPostComposerSheet`) legge la
/// `Binding` al momento della pubblicazione e ignora `onChange`.
struct CharacterPickRow: View {
    let candidates: [CharacterCandidate]
    var isLoading: Bool = false
    @Binding var picks: [CharacterPick]
    /// Chiamato dopo ogni mutazione (selezione, rimozione, reazione) con
    /// l'elenco aggiornato. Facoltativo: chi salva in blocco a fine form non
    /// lo passa.
    var onChange: (([CharacterPick]) -> Void)?

    init(
        candidates: [CharacterCandidate],
        isLoading: Bool = false,
        picks: Binding<[CharacterPick]>,
        onChange: (([CharacterPick]) -> Void)? = nil
    ) {
        self.candidates = candidates
        self.isLoading = isLoading
        self._picks = picks
        self.onChange = onChange
    }

    @State private var reactionTargetPersonId: String?

    private let maxSelection = 3
    private let avatarSize: CGFloat = 56
    private let cellWidth: CGFloat = 70
    private let rowMinHeight: CGFloat = 90

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Group {
                if isLoading {
                    loadingRow
                } else if candidates.isEmpty {
                    emptyRow
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(candidates) { candidate in
                                faceCell(candidate)
                            }
                        }
                        .padding(.horizontal, 2)
                        .padding(.vertical, 2)
                    }
                }
            }
            .frame(minHeight: rowMinHeight)

            if let reactionTargetPersonId, let idx = indexOfPick(for: reactionTargetPersonId) {
                reactionPanel(personId: reactionTargetPersonId, pickIndex: idx)
            }
        }
    }

    // MARK: - Stati vuoto/caricamento

    private var loadingRow: some View {
        HStack {
            Spacer(minLength: 0)
            ProgressView().tint(TwoWatchTheme.brandPrimary)
            Spacer(minLength: 0)
        }
        .accessibilityLabel("Carico il cast")
    }

    private var emptyRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .somtoScaledFont(size: 18, weight: .semibold, relativeTo: .body)
                .foregroundStyle(TwoWatchTheme.textMuted)
            Text("Cast non disponibile per questo titolo.")
                .somtoScaledFont(size: 12, weight: .medium, relativeTo: .caption)
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Volto

    private func faceCell(_ candidate: CharacterCandidate) -> some View {
        let order = indexOfPick(for: candidate.personId)
        let isSelected = order != nil
        let isAtCap = !isSelected && picks.count >= maxSelection
        let reaction = order.flatMap { picks[$0].reaction }.flatMap(TitleEmotion.init(rawValue:))

        return Button {
            handleTap(on: candidate)
        } label: {
            VStack(spacing: 6) {
                avatar(candidate, order: order, reaction: reaction)

                VStack(spacing: 1) {
                    Text(candidate.name)
                        .somtoScaledFont(size: 11, weight: .semibold, relativeTo: .caption)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)

                    if let character = candidate.character, !character.isEmpty {
                        Text(character)
                            .somtoScaledFont(size: 9.5, weight: .medium, relativeTo: .caption)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    }
                }
            }
            .frame(width: cellWidth)
            .opacity(isAtCap ? 0.4 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityDescription(for: candidate, order: order, reaction: reaction))
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityHint(isSelected ? "Tocca di nuovo per una reazione facoltativa" : "Tocca per scegliere come preferito")
    }

    private func avatar(_ candidate: CharacterCandidate, order: Int?, reaction: TitleEmotion?) -> some View {
        ZStack {
            Circle().fill(TwoWatchTheme.panelStrong)

            if let url = candidate.profileURL {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFill()
                    default:
                        initials(candidate.name)
                    }
                }
            } else {
                initials(candidate.name)
            }
        }
        .frame(width: avatarSize, height: avatarSize)
        .clipShape(Circle())
        .overlay(
            Circle().stroke(order != nil ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border, lineWidth: order != nil ? 2.5 : 1)
        )
        .overlay(alignment: .topLeading) {
            if let order {
                Text("\(order + 1)")
                    .somtoScaledFont(size: 11, weight: .heavy, design: .rounded, relativeTo: .caption)
                    .foregroundStyle(.white)
                    .frame(width: 20, height: 20)
                    .background(TwoWatchTheme.brandGradient, in: Circle())
                    .overlay(Circle().stroke(TwoWatchTheme.background, lineWidth: 1.5))
                    .offset(x: -4, y: -4)
            }
        }
        .overlay(alignment: .topTrailing) {
            if candidate.isGuest {
                Text("Guest")
                    .somtoScaledFont(size: 7.5, weight: .heavy, relativeTo: .caption)
                    .tracking(0.2)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(TwoWatchTheme.panelStrong, in: Capsule())
                    .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 0.5))
                    .offset(x: 10, y: -6)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let reaction {
                Text(reaction.emoji)
                    .somtoScaledFont(size: 10, relativeTo: .caption)
                    .frame(width: 18, height: 18)
                    .background(TwoWatchTheme.panelStrong, in: Circle())
                    .overlay(Circle().stroke(TwoWatchTheme.background, lineWidth: 1.5))
                    .offset(x: 3, y: 3)
            }
        }
    }

    private func initials(_ name: String) -> some View {
        let parts = name.split(separator: " ")
        let letters = parts.prefix(2).compactMap { $0.first }.map(String.init).joined()
        return Text(letters.isEmpty ? "?" : letters.uppercased())
            .somtoScaledFont(size: 15, weight: .bold, design: .rounded, relativeTo: .body)
            .foregroundStyle(TwoWatchTheme.textSecondary)
    }

    // MARK: - Reazione inline (secondo tap su un volto già scelto)

    private func reactionPanel(personId: String, pickIndex: Int) -> some View {
        let name = candidates.first(where: { $0.personId == personId })?.name ?? String(localized: "questo personaggio")
        let currentReaction = picks[pickIndex].reaction

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Reazione per \(name)")
                    .somtoScaledFont(size: 11, weight: .semibold, relativeTo: .caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)

                Spacer(minLength: 8)

                Button {
                    removePick(personId)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "xmark.circle.fill")
                        Text("Rimuovi")
                    }
                    .somtoScaledFont(size: 11, weight: .semibold, relativeTo: .caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Rimuovi \(name) dai preferiti")
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(TitleEmotion.allCases) { emotion in
                        reactionChip(emotion, currentReaction: currentReaction, personId: personId)
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .padding(10)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func reactionChip(_ emotion: TitleEmotion, currentReaction: String?, personId: String) -> some View {
        let isSelected = currentReaction == emotion.rawValue

        return Button {
            setReaction(isSelected ? nil : emotion, personId: personId)
        } label: {
            HStack(spacing: 4) {
                Text(emotion.emoji).somtoScaledFont(size: 13, relativeTo: .body)
                Text(emotion.label)
                    .somtoScaledFont(size: 10.5, weight: .semibold, relativeTo: .caption)
                    .foregroundStyle(isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                Capsule().fill(isSelected ? TwoWatchTheme.brandPrimary.opacity(0.16) : TwoWatchTheme.panel)
            )
            .overlay(
                Capsule().stroke(isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border, lineWidth: isSelected ? 1.5 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(emotion.label) \(emotion.emoji)")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    // MARK: - Interazione

    private func indexOfPick(for personId: String) -> Int? {
        picks.firstIndex { $0.personId == personId }
    }

    private func handleTap(on candidate: CharacterCandidate) {
        let generator = UIImpactFeedbackGenerator(style: .soft)

        if indexOfPick(for: candidate.personId) != nil {
            generator.impactOccurred(intensity: 0.5)
            withAnimation(.easeOut(duration: 0.2)) {
                reactionTargetPersonId = (reactionTargetPersonId == candidate.personId) ? nil : candidate.personId
            }
            return
        }

        guard picks.count < maxSelection else {
            generator.impactOccurred(intensity: 0.3)
            return
        }

        picks.append(CharacterPick(personId: candidate.personId, character: candidate.character, reaction: nil))
        generator.impactOccurred(intensity: 0.6)
        onChange?(picks)
    }

    private func removePick(_ personId: String) {
        picks.removeAll { $0.personId == personId }
        UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.4)
        withAnimation(.easeOut(duration: 0.2)) {
            if reactionTargetPersonId == personId { reactionTargetPersonId = nil }
        }
        onChange?(picks)
    }

    private func setReaction(_ emotion: TitleEmotion?, personId: String) {
        guard let idx = indexOfPick(for: personId) else { return }
        let current = picks[idx]
        picks[idx] = CharacterPick(personId: current.personId, character: current.character, reaction: emotion?.rawValue)
        UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.5)
        onChange?(picks)
        withAnimation(.easeOut(duration: 0.2)) {
            reactionTargetPersonId = nil
        }
    }

    private func accessibilityDescription(for candidate: CharacterCandidate, order: Int?, reaction: TitleEmotion?) -> String {
        var parts = [candidate.name]
        if let character = candidate.character, !character.isEmpty { parts.append(character) }
        if candidate.isGuest { parts.append("guest") }
        if let order { parts.append("scelto come preferito numero \(order + 1)") }
        if let reaction { parts.append("reazione \(reaction.label)") }
        return parts.joined(separator: ", ")
    }
}

#if DEBUG
#Preview("Character Pick Row") {
    struct PreviewHost: View {
        @State private var picks: [CharacterPick] = [
            CharacterPick(personId: "1", character: "Joel Miller", reaction: "touched")
        ]

        private let candidates: [CharacterCandidate] = [
            CharacterCandidate(personId: "1", name: "Pedro Pascal", character: "Joel Miller", profileURL: nil, order: 0, isGuest: false),
            CharacterCandidate(personId: "2", name: "Bella Ramsey", character: "Ellie Williams", profileURL: nil, order: 1, isGuest: false),
            CharacterCandidate(personId: "3", name: "Nico Parker", character: "Sarah Miller", profileURL: nil, order: 2, isGuest: true),
            CharacterCandidate(personId: "4", name: "Gabriel Luna", character: "Tommy Miller", profileURL: nil, order: 3, isGuest: false)
        ]

        var body: some View {
            VStack(alignment: .leading, spacing: 24) {
                CharacterPickRow(candidates: candidates, picks: $picks)
                Divider()
                CharacterPickRow(candidates: [], isLoading: true, picks: .constant([]))
                Divider()
                CharacterPickRow(candidates: [], picks: .constant([]))
            }
            .padding(20)
            .background(TwoWatchTheme.background)
        }
    }
    return PreviewHost()
}
#endif
