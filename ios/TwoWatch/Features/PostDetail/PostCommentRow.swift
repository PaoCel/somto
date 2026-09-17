import SwiftUI

/// Il commento di un post, in una forma sola per tutte e tre le superfici che
/// lo mostrano: il dettaglio post, il foglio commenti aperto da una notifica e
/// il pannello sotto la card nel feed. Prima ognuna aveva la sua — card con
/// bordo nel foglio, riga senza avatar nel dettaglio, riga compatta nel feed —
/// e la stessa conversazione cambiava aspetto a seconda di dove la aprivi.
///
/// Forma: avatar, nome e ora sulla riga del nome, testo a tutta larghezza,
/// azioni con etichetta ("Like", "Rispondi") e il conteggio like a destra.
/// Le risposte rientrano con una barra verticale, non con una card annidata.
struct PostCommentRow: View {
    let comment: PostComment
    let viewModel: PostDetailViewModel
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let onReply: (PostComment) -> Void

    /// Da dove arriva la segnalazione, per la moderazione.
    var moderationSource: String = "ios_post_comments"

    private var isLiking: Bool { viewModel.likingCommentIDs.contains(comment.id) }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if comment.isReply {
                // Il filo che lega la risposta al commento sopra: costa una
                // barra, non un riquadro dentro un riquadro.
                RoundedRectangle(cornerRadius: SomtoRadius.xs, style: .continuous)
                    .fill(TwoWatchTheme.border)
                    .frame(width: 2)
                    .padding(.trailing, SomtoSpacing.xl)
                    .accessibilityHidden(true)
            }

            HStack(alignment: .top, spacing: SomtoSpacing.l) {
                profileLink {
                    SomtoAvatar(
                        url: comment.avatarURL,
                        name: comment.authorName,
                        size: comment.isReply ? 32 : 40
                    )
                }
                .accessibilityLabel("Profilo di \(comment.authorName)")

                VStack(alignment: .leading, spacing: SomtoSpacing.m) {
                    if comment.isReply {
                        CommentReplyContextLabel(
                            parentAuthorName: comment.parentAuthorName ?? String(localized: "un commento")
                        )
                    }
                    headerLine
                    text
                    actions
                }
            }
        }
        .padding(.vertical, SomtoSpacing.xl)
    }

    private var headerLine: some View {
        HStack(spacing: SomtoSpacing.m) {
            profileLink {
                Text(comment.authorName)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
            }

            Spacer(minLength: SomtoSpacing.xs)

            if let createdAt = comment.createdAt {
                Text(createdAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.system(size: 12))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
            }

            ContentModerationMenu(
                container: container,
                session: session,
                authorUID: comment.uid,
                authorName: comment.authorName,
                reportType: "comment",
                reportTargetID: comment.id,
                reportReason: "Commento segnalato per contenuto o comportamento inappropriato.",
                reportMetadata: [
                    "preview": String(comment.text.prefix(160)),
                    "source": moderationSource
                ]
            )
        }
    }

    private var text: some View {
        SpoilerGate(
            containsSpoiler: comment.containsSpoiler,
            spoilerTitleIDs: comment.spoilerTitleIds,
            viewerCompletedTitleIDs: session.completedTitleIDs,
            titleNames: [:],
            onMarkSeen: { titleID in await markCompleted(titleID) }
        ) {
            ExpandableTaggedTextView(
                source: comment.text,
                font: .system(size: 16),
                textColor: TwoWatchTheme.textPrimary,
                collapsedLineLimit: 6,
                expansionThreshold: 240,
                container: container,
                session: session,
                shell: shell
            )
        }
    }

    private var actions: some View {
        HStack(spacing: SomtoSpacing.section) {
            Button {
                guard session.isAuthenticated else {
                    shell.presentAuth()
                    return
                }
                Task { await viewModel.toggleCommentLike(commentID: comment.id, userID: session.firebaseUser?.uid) }
            } label: {
                HStack(spacing: SomtoSpacing.s) {
                    if isLiking {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: comment.likedByMe ? "heart.fill" : "heart")
                            .font(.system(size: 15, weight: .medium))
                    }
                    Text(comment.likedByMe ? "Ti piace" : "Like")
                        .font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(comment.likedByMe ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
            }
            .buttonStyle(.plain)
            .disabled(isLiking)

            Button {
                onReply(comment)
            } label: {
                HStack(spacing: SomtoSpacing.s) {
                    Image(systemName: "arrowshape.turn.up.left")
                        .font(.system(size: 15, weight: .medium))
                    Text("Rispondi")
                        .font(.system(size: 14, weight: .medium))
                }
                .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .buttonStyle(.plain)

            Spacer(minLength: SomtoSpacing.m)

            Text("\(comment.likes) like")
                .font(.system(size: 13))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .monospacedDigit()
                .accessibilityLabel("\(comment.likes) like in tutto")
        }
    }

    @ViewBuilder
    private func profileLink<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        NavigationLink {
            UserProfileDetailView(container: container, session: session, shell: shell, userID: comment.uid)
        } label: {
            content()
        }
        .buttonStyle(.plain)
    }

    private func markCompleted(_ titleID: String) async {
        guard let uid = session.firebaseUser?.uid else { return }
        do {
            _ = try await container.watchlistRepository.markTitleCompletedByID(userID: uid, titleID: titleID)
            session.markTitleCompletedLocally(titleID)
        } catch { /* silent: il gate resta chiuso, l'utente puo' riprovare */ }
    }
}

/// "Discussione — N commenti": la riga che separa il post dalla conversazione.
struct PostDiscussionHeader: View {
    let commentCount: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Discussione")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Spacer(minLength: SomtoSpacing.m)

            Text("\(commentCount) commenti")
                .font(.system(size: 15))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Discussione, \(commentCount) commenti")
    }
}
