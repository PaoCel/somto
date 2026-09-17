import SwiftUI

/// "Persone da seguire": riga orizzontale di card sopra il feed di Community.
///
/// Stessa sezione del web (`#peopleSuggest` in community.html), stesse
/// motivazioni: chi ha votato i tuoi stessi titoli, con il numero di voti in
/// comune e un paio di titoli citati.
struct PeopleToFollowSection: View {
    let viewModel: PeopleToFollowViewModel
    let myUserID: String?
    let onOpenProfile: (String) -> Void

    var body: some View {
        // Niente skeleton: la sezione o ha persone da mostrare o non esiste.
        // Un placeholder in cima al feed sposterebbe il contenuto sotto ogni
        // volta che la chiamata torna vuota, che e' il caso piu' probabile per
        // chi ha pochi voti.
        if !viewModel.people.isEmpty {
            VStack(alignment: .leading, spacing: SomtoSpacing.l) {
                VStack(alignment: .leading, spacing: SomtoSpacing.xxs) {
                    Text("Persone da seguire")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Il feed si riempie quando segui qualcuno")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: SomtoSpacing.l) {
                        ForEach(viewModel.people) { person in
                            PersonSuggestionCard(
                                person: person,
                                isFollowed: viewModel.isFollowed(person),
                                onOpenProfile: { onOpenProfile(person.id) },
                                onFollow: {
                                    Task { await viewModel.follow(person, myUserID: myUserID) }
                                }
                            )
                        }
                    }
                    // Il padding sta dentro lo ScrollView, non fuori: la riga
                    // deve poter scorrere fino al bordo dello schermo.
                    .padding(.horizontal, 14)
                }
                .scrollClipDisabled()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct PersonSuggestionCard: View {
    let person: PersonSuggestion
    let isFollowed: Bool
    let onOpenProfile: () -> Void
    let onFollow: () -> Void

    /// La card ha larghezza fissa per far intravedere la successiva, ma il
    /// testo dentro deve poter crescere con Dynamic Type: da qui il
    /// `fixedSize` verticale sulle due righe di testo.
    private let cardWidth: CGFloat = 150

    var body: some View {
        VStack(spacing: SomtoSpacing.m) {
            Button(action: onOpenProfile) {
                VStack(spacing: SomtoSpacing.m) {
                    SomtoAvatar(url: person.photoURL, name: person.displayName, size: 52)

                    Text(person.displayName)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)

                    if person.kind == .page {
                        Text("Pagina")
                            .font(.system(size: 10, weight: .bold))
                            .textCase(.uppercase)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .padding(.horizontal, SomtoSpacing.s)
                            .padding(.vertical, SomtoSpacing.xxs)
                            .overlay(
                                Capsule().stroke(TwoWatchTheme.border, lineWidth: 1)
                            )
                    }

                    Text(reasonText)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("\(person.displayName). \(reasonText)"))
            .accessibilityHint(Text("Apre il profilo"))

            Button(action: onFollow) {
                Text(isFollowed ? "Seguito" : "Segui")
                    .font(.system(size: 13, weight: .bold))
                    .frame(maxWidth: .infinity)
                    // 44pt: minimo HIG per un bersaglio tattile.
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(isFollowed ? TwoWatchTheme.textSecondary : Color.white)
            .background(
                RoundedRectangle(cornerRadius: SomtoRadius.s, style: .continuous)
                    .fill(isFollowed ? Color.clear : TwoWatchTheme.brandPrimary)
            )
            .overlay(
                RoundedRectangle(cornerRadius: SomtoRadius.s, style: .continuous)
                    .stroke(isFollowed ? TwoWatchTheme.border : Color.clear, lineWidth: 1)
            )
            .disabled(isFollowed)
        }
        .padding(SomtoSpacing.xl)
        .frame(width: cardWidth)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: SomtoRadius.l, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SomtoRadius.l, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    /// Per una persona: "3 voti in comune, tra cui Dune e Severance" — i titoli
    /// arrivano dal server solo quando entrambi li hanno votati, quindi sono
    /// gia' pubblici. Per una pagina: la prima frase della sua descrizione, il
    /// resto sta sul profilo.
    private var reasonText: String {
        if person.kind == .page {
            let firstSentence = person.bio.split(separator: ".", maxSplits: 1).first.map(String.init) ?? ""
            let trimmed = firstSentence.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? String(localized: "Canale editoriale di Somto") : "\(trimmed)."
        }

        let head = person.sharedCount == 1
            ? String(localized: "1 voto in comune")
            : String(localized: "\(person.sharedCount) voti in comune")

        guard !person.sharedTitleNames.isEmpty else { return head }
        let names = ListFormatter.localizedString(byJoining: person.sharedTitleNames)
        return "\(head), " + String(localized: "tra cui \(names)")
    }
}
