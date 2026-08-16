import SwiftUI

// Coda della scheda titolo: recensioni personali e della community,
// correlati, liste pubbliche, chi sta guardando, azioni social. Estratte da
// TitleDetailSections.swift.

struct TitlePersonalReviewSection: View {
    let review: Rating
    let onEditReview: () -> Void

    private var reviewText: String {
        (review.reviewText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: String(localized: "La tua review"),
                    subtitle: String(localized: "La ritrovi qui subito e, se vuoi, puoi anche condividerla nel thread pubblico.")
                )

                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        TitleBadge(
                            text: TitleDetailFormatter.rating(review.rating),
                            tint: TwoWatchTheme.warning
                        )

                        Spacer(minLength: 0)

                        if let updated = TitleDetailFormatter.date(review.updatedAt) {
                            Text("Aggiornata \(updated)")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }
                    }

                    ExpandableTextBlock(
                        isExpandable: ExpandableTextHeuristics.needsExpansion(for: reviewText, threshold: 240),
                        collapsedLineLimit: 6
                    ) { lineLimit in
                        Text(reviewText)
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineSpacing(2)
                            .lineLimit(lineLimit)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    HStack(spacing: 8) {
                        Label("Review personale", systemImage: "person.text.rectangle")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)

                        Spacer(minLength: 0)

                        Button("Modifica review", action: onEditReview)
                            .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.brandPrimary))
                    }
                }
                .padding(16)
                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                )
            }
        }
    }
}

struct TitleCommunityReviewsSection: View {
    let reviews: [Rating]
    let titleID: String
    let isAuthenticated: Bool
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let onWriteReview: () -> Void
    let onRequestAuth: () -> Void

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Review community",
                    subtitle: String(localized: "Pareri leggibili in card, con rating e data ben visibili.")
                )

                if reviews.isEmpty {
                    SectionEmptyStateView(
                        title: "Ancora nessuna review",
                        message: isAuthenticated
                            ? "Puoi essere il primo a raccontare com'è andata."
                            : "Accedi per lasciare la prima review su questo titolo.",
                        systemImage: "text.bubble",
                        actionTitle: isAuthenticated ? "Scrivi la prima review" : "Accedi",
                        action: isAuthenticated ? onWriteReview : onRequestAuth
                    )
                } else {
                    ForEach(Array(reviews.prefix(6))) { review in
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

struct TitleRelatedCarouselSection: View {
    let relatedTitles: [Title]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Titoli correlati",
                    subtitle: String(localized: "Una corsia orizzontale per continuare l'esplorazione senza perdere il contesto.")
                )

                if relatedTitles.isEmpty {
                    SectionEmptyStateView(
                        title: "Nessun correlato trovato",
                        message: "Quando il catalogo trova affinità forti, compariranno qui.",
                        systemImage: "square.stack.3d.forward.dottedline"
                    )
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 14) {
                            ForEach(relatedTitles) { related in
                                NavigationLink {
                                    TitleDetailView(container: container, session: session, shell: shell, titleID: related.id)
                                } label: {
                                    TitleRelatedCard(title: related)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }
}

/// String(localized: "Chi la sta guardando"): amici e profili seguiti dal viewer che stanno
/// guardando questa serie, con avatar, nome e chip di avanzamento (S·E /
/// Completa / %). Mostrata solo per le serie e quando la lista non è vuota.
struct TitlePublicListsSection: View {
    let lists: [UserListSummary]
    let onOpenList: (UserListSummary) -> Void

    private var subtitle: String {
        lists.count == 1
            ? String(localized: "Una lista pubblica include questo titolo.")
            : String(localized: "\(lists.count) liste pubbliche includono questo titolo.")
    }

    var body: some View {
        TitleCollapsibleSection(
            title: String(localized: "Liste che lo includono"),
            subtitle: subtitle,
            accessibilityHintExpanded: String(localized: "Tocca per vedere le liste")
        ) {
            VStack(spacing: 10) {
                ForEach(lists) { list in
                    Button {
                        onOpenList(list)
                    } label: {
                        TitlePublicListRow(list: list)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

struct TitlePublicListRow: View {
    let list: UserListSummary

    @ScaledMetric(relativeTo: .body) private var posterWidth: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var posterHeight: CGFloat = 60

    var body: some View {
        HStack(spacing: 12) {
            PosterImageView(
                url: list.previewTitles.first.flatMap { $0.posterPath ?? $0.backdropPath },
                width: posterWidth,
                height: posterHeight,
                cornerRadius: 10
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(list.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 6) {
                    Text(list.kind.label)
                    Text("•")
                    Text("\(list.itemCount) titoli")
                    if list.followersCount > 0 {
                        Text("•")
                        Text("\(list.followersCount) follower")
                            .monospacedDigit()
                    }
                }
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .lineLimit(1)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.black))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(list.title), \(list.kind.label), \(list.itemCount) titoli")
        .accessibilityAddTraits(.isButton)
    }
}

struct TitleWatchersSection: View {
    let watchers: [TitleWatcher]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    private var subtitle: String {
        let inProgress = watchers.filter(\.isInProgress).count
        if inProgress > 0 {
            return inProgress == 1
                ? String(localized: "1 persona la sta seguendo proprio ora.")
                : String(localized: "\(inProgress) persone la stanno seguendo proprio ora.")
        }
        return String(localized: "Amici e profili che segui che hanno guardato questa serie.")
    }

    var body: some View {
        TitleCollapsibleSection(
            title: String(localized: "Chi la sta guardando"),
            subtitle: subtitle,
            accessibilityHintExpanded: String(localized: "Tocca per vedere chi la guarda")
        ) {
            VStack(spacing: 10) {
                ForEach(watchers) { watcher in
                    NavigationLink {
                        UserProfileDetailView(
                            container: container,
                            session: session,
                            shell: shell,
                            userID: watcher.uid
                        )
                    } label: {
                        TitleWatcherRow(watcher: watcher)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

struct TitleWatcherRow: View {
    let watcher: TitleWatcher

    var body: some View {
        HStack(spacing: 12) {
            avatar
                .frame(width: 40, height: 40)
                .clipShape(Circle())
                .overlay(
                    Circle().stroke(TwoWatchTheme.border, lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(watcher.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)

                    if watcher.isSynthetic {
                        guidedChip
                    }
                }

                Text(watcher.isInProgress ? "In corso" : "Ha finito la serie")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if let chipLabel = watcher.progressChipLabel {
                Text(chipLabel)
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(watcher.isInProgress ? TwoWatchTheme.accent : TwoWatchTheme.success)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        Capsule().fill((watcher.isInProgress ? TwoWatchTheme.accent : TwoWatchTheme.success).opacity(0.14))
                    )
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = [watcher.displayName]
        if watcher.isSynthetic { parts.append("profilo guidato") }
        parts.append(watcher.isInProgress ? "in corso" : String(localized: "ha finito la serie"))
        if let chip = watcher.progressChipLabel { parts.append(chip) }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private var avatar: some View {
        if let url = watcher.photoImageURL {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image
                        .resizable()
                        .scaledToFill()
                default:
                    avatarFallback
                }
            }
        } else {
            avatarFallback
        }
    }

    // Gradiente brand come ovunque (decisione 2026-08-09): prima qui il
    // fondo era un pannello piatto con testo scuro.
    private var avatarFallback: some View {
        ZStack {
            TwoWatchTheme.brandGradient
            Text(SomtoInitials.from(watcher.displayName))
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
        }
    }

    private var guidedChip: some View {
        HStack(spacing: 3) {
            Image(systemName: "sparkles")
                .font(.system(size: 8, weight: .bold))
            Text("Guidato")
                .font(.system(size: 10, weight: .semibold))
        }
        .foregroundStyle(TwoWatchTheme.brandPrimary)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(
            Capsule(style: .continuous)
                .fill(TwoWatchTheme.brandPrimary.opacity(0.12))
        )
        .accessibilityHidden(true)
    }
}

struct TitleSocialActionsSection: View {
    let title: Title
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let onSuggestToFriend: () -> Void
    let onOpenGroupDiscussion: () -> Void

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Azioni social",
                    subtitle: "Suggerimenti, conversazioni di gruppo e thread pubblico dedicato."
                )

                socialButton(
                    title: String(localized: "Suggerisci a un amico"),
                    subtitle: isAuthenticated
                        ? String(localized: "Invia il titolo in DM con un messaggio personale.")
                        : String(localized: "Accedi per consigliarlo direttamente a un amico."),
                    systemName: "paperplane.fill",
                    tint: TwoWatchTheme.brandPrimary,
                    action: socialAction(isAuthenticated: isAuthenticated, authenticatedAction: onSuggestToFriend)
                )

                socialButton(
                    title: String(localized: "Apri una discussione di gruppo"),
                    subtitle: isAuthenticated
                        ? String(localized: "Condividilo in un gruppo esistente o creane uno al volo.")
                        : String(localized: "Accedi per aprire una conversazione di gruppo sul titolo."),
                    systemName: "bubble.left.and.bubble.right.fill",
                    tint: TwoWatchTheme.accent,
                    action: socialAction(isAuthenticated: isAuthenticated, authenticatedAction: onOpenGroupDiscussion)
                )

                if isAuthenticated {
                    NavigationLink {
                        ThreadDetailView(
                            container: container,
                            session: session,
                            shell: shell,
                            threadID: container.threadsRepository.threadIDForPublic(titleID: title.id),
                            publicThreadSeed: .title(title.id)
                        )
                    } label: {
                        TitleSocialActionRow(
                            title: String(localized: "Apri il thread pubblico"),
                            subtitle: String(localized: "Leggi cosa sta dicendo la community e partecipa alla conversazione."),
                            systemName: "megaphone.fill",
                            tint: TwoWatchTheme.brandWarm
                        )
                    }
                    .buttonStyle(.plain)
                } else {
                    socialButton(
                        title: String(localized: "Apri il thread pubblico"),
                        subtitle: String(localized: "Accedi per entrare nella discussione pubblica del titolo."),
                        systemName: "megaphone.fill",
                        tint: TwoWatchTheme.brandWarm,
                        action: shell.presentAuth
                    )
                }
            }
        }
    }

    private var isAuthenticated: Bool {
        session.firebaseUser?.uid != nil
    }

    private func socialAction(isAuthenticated: Bool, authenticatedAction: @escaping () -> Void) -> () -> Void {
        {
            if isAuthenticated {
                authenticatedAction()
            } else {
                shell.presentAuth()
            }
        }
    }

    private func socialButton(
        title: String,
        subtitle: String,
        systemName: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            TitleSocialActionRow(
                title: title,
                subtitle: subtitle,
                systemName: systemName,
                tint: tint
            )
        }
        .buttonStyle(.plain)
    }
}
