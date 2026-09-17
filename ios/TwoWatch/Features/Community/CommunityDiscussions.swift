import SwiftUI

// Sezione "Discussioni per te" e card commento del feed, estratte da
// CommunityView.swift.

struct CommunityDiscussionsSection: View {
    let suggestions: [CommunityDiscussionsRanking.Suggestion]
    /// True se l'utente ha una libreria ma nessuna discussione pertinente.
    let hasLibrarySignals: Bool
    let onOpenThread: (String) -> Void
    let onExploreThreads: () -> Void
    let onSearchTitles: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Discussioni per te")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Su quello che hai visto e stai guardando")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if suggestions.isEmpty {
                emptyState
            } else {
                VStack(spacing: 10) {
                    ForEach(suggestions) { suggestion in
                        Button {
                            onOpenThread(suggestion.thread.id)
                        } label: {
                            CommunityDiscussionRow(suggestion: suggestion)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            exploreRow
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Nessun suggerimento pertinente: si dice il perché e si offre una strada,
    /// invece di riempire la sezione con discussioni a caso.
    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(hasLibrarySignals
                 ? "Ancora nessuno commenta i titoli che stai seguendo."
                 : "Segna qualcosa come visto: qui compariranno le discussioni sui titoli che segui.")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: hasLibrarySignals ? onExploreThreads : onSearchTitles) {
                HStack(spacing: 6) {
                    Image(systemName: hasLibrarySignals ? "text.magnifyingglass" : "magnifyingglass")
                        .font(.system(size: 12, weight: .bold))
                    Text(hasLibrarySignals ? "Cerca una discussione" : "Cerca un titolo")
                        .font(.system(size: 13, weight: .bold))
                }
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    /// Accesso esplicito all'esplorazione completa: i suggerimenti sono pochi
    /// per scelta, quindi serve una porta evidente verso "tutto il resto".
    private var exploreRow: some View {
        Button(action: onExploreThreads) {
            HStack(spacing: 10) {
                Image(systemName: "text.magnifyingglass")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Esplora tutti i thread")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Cerca una serie o un film")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Apre la ricerca delle discussioni per titolo")
    }
}

/// Riga di un suggerimento. Rispetto alla versione precedente dice tre cose che
/// prima mancavano: **perché** la vedi (riga motivo), **che tipo** di
/// discussione è (serie / stagione / episodio) e **quanto è viva**. Il voto
/// eventuale nell'anteprima diventa un badge ★ senza "/10", come sul web.
struct CommunityDiscussionRow: View {
    let suggestion: CommunityDiscussionsRanking.Suggestion

    private var thread: AppThread { suggestion.thread }

    private var displayTitle: String {
        if let name = thread.title?.name, !name.isEmpty { return name }
        if !thread.groupName.isEmpty { return thread.groupName }
        return "Discussione pubblica"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            reasonRow

            HStack(alignment: .top, spacing: 12) {
                posterView
                    .frame(width: 52, height: 74)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    Text(displayTitle)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)

                    HStack(spacing: 6) {
                        ThreadScopeBadge(scope: thread.scope, compact: true)
                        if let score = preview.score {
                            ThreadRatingBadge(score: score)
                        }
                        Spacer(minLength: 0)
                    }

                    if !preview.text.isEmpty {
                        Text(preview.text)
                            .font(.system(size: 12))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            HStack(spacing: 8) {
                Text("Partecipa alla discussione")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                Image(systemName: "arrow.right")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                Spacer(minLength: 0)
                if let activity = activityText {
                    Text(activity)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(suggestion.reason.label). \(displayTitle), \(thread.scope.longLabel)")
        .accessibilityHint("Apri la discussione")
    }

    private var preview: (score: String?, text: String) {
        thread.previewSplit
    }

    private var reasonRow: some View {
        HStack(spacing: 5) {
            Image(systemName: suggestion.reason.symbolName)
                .font(.system(size: 10, weight: .bold))
            Text(suggestion.reason.label)
                .font(.system(size: 11, weight: .heavy))
                .lineLimit(1)
        }
        .foregroundStyle(TwoWatchTheme.accent)
        .accessibilityHidden(true)
    }

    private var activityText: String? {
        guard let lastMessageAt = thread.lastMessageAt else { return nil }
        return lastMessageAt.formatted(.relative(presentation: .named))
    }

    @ViewBuilder
    private var posterView: some View {
        if let poster = thread.title?.posterPath {
            PosterImageView(url: poster, width: 52, height: 74, cornerRadius: 10)
        } else {
            ZStack {
                TwoWatchTheme.panelStrong
                Image(systemName: thread.scope.symbolName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
            }
        }
    }
}

// MARK: - Card commento (eco di un thread pubblico)

/// Card di un commento su film / serie / episodio: eco di un messaggio in un
/// thread pubblico (`posts` con `visibility:"comment"`).
///
/// Volutamente leggera rispetto a `FeedActivityCard`: niente like/condivisione,
/// perche' la conversazione vive nel thread — la risposta scritta qui finisce
/// li' dentro, non nei commenti del post gemello. Il testo passa dal gate
/// anti-spoiler per progresso (`SpoilerProgressGate`).
struct CommunityCommentCard: View {
    let activity: FeedActivity
    let progressEntry: SpoilerProgressRule.Entry?
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var isReplying = false
    @State private var replyText = ""
    @State private var isSending = false
    @State private var feedback: String?
    @FocusState private var replyFocused: Bool

    private var scope: SpoilerProgressRule.Scope? {
        guard let titleID = activity.titleId, !titleID.isEmpty else { return nil }
        return SpoilerProgressRule.Scope(
            titleID: titleID,
            level: activity.level,
            season: activity.season,
            episode: activity.episode
        )
    }

    private var isOwnComment: Bool {
        guard let uid = session.firebaseUser?.uid else { return false }
        return uid == activity.actor.id
    }

    private var isUnlocked: Bool {
        isOwnComment || SpoilerProgressRule.isUnlocked(scope: scope, entry: progressEntry)
    }

    private var threadID: String? {
        guard let id = activity.sourceId, !id.isEmpty else { return nil }
        return id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            SpoilerProgressGate(
                scope: scope,
                entry: progressEntry,
                titleName: activity.title?.name,
                isOwnContent: isOwnComment
            ) {
                commentBody
            }

            if let title = activity.title {
                NavigationLink {
                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                } label: {
                    miniTitleRow(title)
                }
                .buttonStyle(.plain)
            }

            footer

            if isReplying {
                replyComposer
            }

            if let feedback {
                Text(feedback)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            SomtoAvatar(url: activity.actor.photoURL, name: activity.actor.displayName, size: 38)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                    Text(activity.actor.displayName)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                    Text(activity.actionText)
                        .font(.system(size: 13))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .lineLimit(1)
                    if let label = scope?.shortLabel {
                        Text(label)
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(TwoWatchTheme.panelStrong, in: Capsule())
                    }
                    Spacer(minLength: 0)
                }

                if let createdAt = activity.createdAt {
                    Text(createdAt.formatted(.relative(presentation: .named)))
                        .font(.system(size: 11))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
        }
    }

    @ViewBuilder
    private var commentBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let text = activity.primaryText, !text.isEmpty {
                // I messaggi nati da un voto arrivano come "8/10 — testo":
                // è wire format, a schermo il numero diventa una pastiglia e
                // la scala sparisce (si capisce da sola).
                if let split = RatingDisplayFormat.splitRatingPrefix(text) {
                    HStack(alignment: .top, spacing: 10) {
                        ThreadRatingBadge(score: split.score, size: .prominent)

                        VStack(alignment: .leading, spacing: 2) {
                            if !split.people.isEmpty {
                                Text(split.people)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                            }
                            if !split.body.isEmpty {
                                Text(split.body)
                                    .font(.system(size: 14))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    Text(text)
                        .font(.system(size: 14))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let mediaURL = activity.mediaURL {
                CachedAsyncImage(url: mediaURL) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFit()
                    default:
                        Color.clear
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(maxHeight: 220)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Il contenuto sfocato deve lasciare spazio all'overlay del gate:
        // un commento di una riga sola sarebbe troppo basso.
        .frame(minHeight: isUnlocked ? 0 : 92, alignment: .topLeading)
    }

    private func miniTitleRow(_ title: Title) -> some View {
        HStack(spacing: 10) {
            PosterImageView(url: title.posterPath, width: 40, height: 58, cornerRadius: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.name)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                if let year = title.year {
                    Text(String(year))
                        .font(.system(size: 11))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(8)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button {
                isReplying.toggle()
                if isReplying { replyFocused = true }
            } label: {
                Label("Rispondi", systemImage: "arrowshape.turn.up.left")
                    .font(.system(size: 13, weight: .semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(isUnlocked ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textMuted)
            .disabled(!isUnlocked || !session.isAuthenticated || threadID == nil)

            if let threadID {
                Button {
                    shell.activePresentedSheet = .thread(id: threadID)
                } label: {
                    Text("Apri la discussione")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                .buttonStyle(.plain)
            }

            Spacer(minLength: 0)
        }
    }

    private var replyComposer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Scrivi un commento", text: $replyText, axis: .vertical)
                .lineLimit(1...4)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .padding(10)
                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .focused($replyFocused)

            HStack {
                Spacer(minLength: 0)
                Button {
                    Task { await sendReply() }
                } label: {
                    if isSending {
                        ProgressView().tint(.white)
                    } else {
                        Text("Invia")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSending || replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    /// La risposta va nel THREAD di origine, non nei commenti del post gemello:
    /// una sola conversazione per titolo, identica dal feed e dalla scheda.
    private func sendReply() async {
        let body = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !body.isEmpty,
            let threadID,
            let uid = session.firebaseUser?.uid
        else { return }

        isSending = true
        defer { isSending = false }

        do {
            try await container.threadsRepository.sendMessage(
                threadID: threadID,
                senderUID: uid,
                displayName: session.appUser?.displayName ?? session.firebaseUser?.displayName ?? "Utente",
                text: body
            )
            replyText = ""
            isReplying = false
            feedback = String(localized: "Risposta inviata")
        } catch {
            feedback = UserFacingError.message(for: error)
        }
    }
}

// MARK: - Feed & composer (moved from HomeView)
