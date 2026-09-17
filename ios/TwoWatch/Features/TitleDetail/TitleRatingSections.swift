import SwiftUI

// Voto: composer, riepilogo dei propri voti, voti derivati e lo skeleton
// delle stagioni. Estratti da TitleDetailSections.swift.

struct TitleRatingComposerSection: View {
    let viewModel: TitleDetailViewModel
    let titleID: String
    let isAuthenticated: Bool
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let onSelectRating: (Double) -> Void
    let onOpenReview: () -> Void
    let onRequestAuth: () -> Void

    var body: some View {
        let hasReview = (viewModel.currentUserTitleRating?.reviewText ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty == false
        let hasPostExtras = hasReview
            || !(viewModel.currentUserTitleRating?.watchedWith.isEmpty ?? true)
            || !(viewModel.currentUserTitleRating?.mediaURLs.isEmpty ?? true)

        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Il tuo voto",
                    subtitle: String(localized: "Tocca una stella o trascina per affinare a mezzo punto.")
                )

                if isAuthenticated {
                    SomtoStarRatingRow(
                        value: viewModel.currentUserTitleRatingValue,
                        showsLabel: true,
                        onChange: onSelectRating
                    )
                    .padding(.vertical, 6)
                } else {
                    SectionEmptyStateView(
                        title: "Accedi per votare",
                        message: "Salva il tuo voto e aggiungi una review personale in pochi tocchi.",
                        systemImage: "person.crop.circle.badge.plus",
                        actionTitle: "Accedi",
                        action: onRequestAuth
                    )
                }

                if isAuthenticated {
                    Button(hasPostExtras ? "Modifica post voto" : "Aggiungi review e condivisione", action: onOpenReview)
                        .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.brandPrimary))
                }

                if !viewModel.communityReviewPreview.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("La community si sta muovendo")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                        ForEach(viewModel.communityReviewPreview) { review in
                            TitleCommunityReviewCard(
                                review: review,
                                container: container,
                                session: session,
                                shell: shell
                            )
                        }

                        TitleReviewThreadCTA(
                            titleID: titleID,
                            isAuthenticated: isAuthenticated,
                            container: container,
                            session: session,
                            shell: shell,
                            onRequestAuth: onRequestAuth
                        )
                    }
                }
            }
        }
    }
}

/// Breakdown dei voti dell'utente per una serie:
///   - lista dei voti dati per ogni stagione (con CTA per votarla/modificarla)
///   - media calcolata dalle stagioni
///   - voto generale (title-level) con menù "Sposta su stagione…" per
///     migrare 1-tap il voto a un livello più specifico
struct MyRatingsBreakdownView: View {
    let titleLevelRating: Rating?
    let seasonRatings: [Int: Rating]
    let availableSeasons: [Int]
    var derivedRating: DerivedRating? = nil
    let onTapSeasonRating: (Int) -> Void
    let onMigrateToSeason: (Int) -> Void
    let onAddSeasonRating: (Int) -> Void
    let onRemoveTitleRating: () -> Void
    let onRemoveSeasonRating: (Int) -> Void

    /// Stagione per cui è aperta la conferma di rimozione; `nil` = nessuna.
    @State private var pendingSeasonRemoval: Int?
    @State private var isConfirmingTitleRemoval = false

    private var avgFromSeasons: Double? {
        guard !seasonRatings.isEmpty else { return nil }
        let sum = seasonRatings.values.reduce(0.0) { $0 + Double($1.rating) }
        return sum / Double(seasonRatings.count)
    }

    /// Stagioni derivate dai voti episodio, escluse quelle con voto ESPLICITO
    /// (l'esplicito vince). Ordinate per numero stagione.
    private var derivedSeasonRows: [(season: Int, avg: Double)] {
        guard let derived = derivedRating else { return [] }
        return derived.seasonAvgs
            .filter { seasonRatings[$0.key] == nil }
            .sorted { $0.key < $1.key }
            .map { (season: $0.key, avg: $0.value) }
    }

    private var migrationTargets: [Int] {
        // Mostra solo stagioni per cui l'utente non ha già votato.
        availableSeasons.filter { seasonRatings[$0] == nil }
    }

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "I tuoi voti",
                    subtitle: String(localized: "Voto generale e voti per stagione restano separati. Puoi spostare il voto generale su una stagione specifica.")
                )

                if !seasonRatings.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Le tue stagioni")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                        ForEach(seasonRatings.keys.sorted(), id: \.self) { s in
                            if let r = seasonRatings[s] {
                                Button {
                                    onTapSeasonRating(s)
                                } label: {
                                    HStack {
                                        Text("Stagione \(s)")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(TwoWatchTheme.textPrimary)
                                        Spacer()
                                        Text(TitleDetailFormatter.rating(r.rating))
                                            .font(.subheadline.weight(.bold))
                                            .foregroundStyle(TwoWatchTheme.accent)
                                            .monospacedDigit()
                                        Image(systemName: "chevron.right")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(TwoWatchTheme.textMuted)
                                            // Indicatore di navigazione decorativo
                                            .accessibilityHidden(true)
                                    }
                                }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("Modifica voto") { onTapSeasonRating(s) }
                                    Button("Rimuovi voto", role: .destructive) {
                                        pendingSeasonRemoval = s
                                    }
                                }
                            }
                        }

                        if let avg = avgFromSeasons {
                            HStack {
                                Text("Media stagioni")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                                Spacer()
                                Text(String(format: "%.1f", avg))
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                    .monospacedDigit()
                            }
                            .padding(.top, 2)
                        }
                    }
                }

                if !migrationTargets.isEmpty, !availableSeasons.isEmpty {
                    Menu {
                        ForEach(migrationTargets, id: \.self) { s in
                            Button("Stagione \(s)") { onAddSeasonRating(s) }
                        }
                    } label: {
                        Label("Aggiungi voto per stagione", systemImage: "plus.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                    }
                }

                if let tl = titleLevelRating {
                    Divider().background(TwoWatchTheme.border)
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Voto generale")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                            Text(TitleDetailFormatter.rating(tl.rating))
                                .font(.title3.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.accent)
                                .monospacedDigit()
                        }
                        Spacer()
                        Menu {
                            ForEach(migrationTargets, id: \.self) { s in
                                Button("Sposta su Stagione \(s)") {
                                    onMigrateToSeason(s)
                                }
                            }
                            Button("Rimuovi voto", role: .destructive) {
                                isConfirmingTitleRemoval = true
                            }
                        } label: {
                            Label("Gestisci", systemImage: "ellipsis.circle.fill")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.brandPrimary)
                        }
                    }
                }

                if let derived = derivedRating, let seriesAvg = derived.seriesAvg {
                    DerivedRatingsSection(seriesAvg: seriesAvg, seasonRows: derivedSeasonRows)
                }
            }
        }
        .confirmationDialog(
            "Rimuovere il voto generale?",
            isPresented: $isConfirmingTitleRemoval,
            titleVisibility: .visible
        ) {
            Button("Rimuovi voto", role: .destructive) { onRemoveTitleRating() }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("Il titolo resta tra i visti, ma senza voto generale.")
        }
        .confirmationDialog(
            "Rimuovere il voto della stagione?",
            isPresented: seasonRemovalBinding,
            titleVisibility: .visible
        ) {
            Button("Rimuovi voto", role: .destructive) {
                if let s = pendingSeasonRemoval { onRemoveSeasonRating(s) }
                pendingSeasonRemoval = nil
            }
            Button("Annulla", role: .cancel) { pendingSeasonRemoval = nil }
        } message: {
            Text("Il voto per questa stagione verrà eliminato. Gli altri voti restano.")
        }
    }

    private var seasonRemovalBinding: Binding<Bool> {
        Binding(
            get: { pendingSeasonRemoval != nil },
            set: { newValue in if !newValue { pendingSeasonRemoval = nil } }
        )
    }
}

/// Blocco sola-lettura "Dai tuoi voti episodio": media serie + stagioni
/// derivate dai voti episodio (privato). L'esplicito vince, quindi le stagioni
/// già votate esplicitamente sono escluse a monte (`derivedSeasonRows`).
struct DerivedRatingsSection: View {
    let seriesAvg: Double
    let seasonRows: [(season: Int, avg: Double)]

    var body: some View {
        Divider().background(TwoWatchTheme.border)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Dai tuoi voti episodio")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Text("auto")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .overlay(
                        Capsule().stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
            }
            Text("Media automatica dai voti che hai dato ai singoli episodi.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textMuted)

            HStack {
                Text("Serie (media)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer()
                Text(TitleDetailFormatter.rating(seriesAvg))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Media serie dai tuoi voti episodio: \(TitleDetailFormatter.rating(seriesAvg))")

            ForEach(seasonRows, id: \.season) { row in
                HStack {
                    Text("Stagione \(row.season)")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    Spacer()
                    Text(TitleDetailFormatter.rating(row.avg))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .monospacedDigit()
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Stagione \(row.season) dai tuoi voti episodio: \(TitleDetailFormatter.rating(row.avg))")
            }
        }
    }
}

struct TitleSeasonsLoadingSkeleton: View {
    @State private var isAnimating = false

    var body: some View {
        VStack(spacing: 12) {
            ForEach(0..<3, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(TwoWatchTheme.panelStrong)
                    .frame(height: 76)
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
                    .opacity(isAnimating ? 0.55 : 1.0)
            }
        }
        .accessibilityLabel("Caricamento stagioni in corso")
        .onAppear {
            withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) {
                isAnimating = true
            }
        }
    }
}
