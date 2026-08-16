import SwiftUI

// Pannello commenti di una card del feed, estratto da CommunityView.swift.

enum FeedActivityCardDestination: Hashable, Identifiable {
    case title(id: String)
    case profile(uid: String)

    var id: String {
        switch self {
        case let .title(id):
            return "title:\(id)"
        case let .profile(uid):
            return "profile:\(uid)"
        }
    }
}

struct FeedCommentsPanel: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let postID: String
    let onCountsUpdated: (PostSocialCounts) -> Void

    @State private var viewModel: PostDetailViewModel
    @State private var commentComposer: SocialComposerViewModel
    @State private var replyTarget: PostComment?

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        postID: String,
        onCountsUpdated: @escaping (PostSocialCounts) -> Void
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.postID = postID
        self.onCountsUpdated = onCountsUpdated
        _viewModel = State(initialValue: PostDetailViewModel(postID: postID, repository: container.postsRepository))
        _commentComposer = State(initialValue: SocialComposerViewModel(
            titleRepository: container.titleRepository,
            userRepository: container.userRepository,
            topicScope: .titlesAndPeople,
            characterLimit: 5000
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("Commenti", systemImage: "bubble.right.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(commentTextColor)

                Spacer()

                Text("\(viewModel.counts.comments)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(commentSecondaryColor)
            }

            if viewModel.isLoading && viewModel.comments.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .tint(commentTextColor)
            } else if let errorMessage = viewModel.errorMessage, viewModel.comments.isEmpty {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
            } else if viewModel.comments.isEmpty {
                Text("Nessun commento per ora.")
                    .font(.subheadline)
                    .foregroundStyle(commentSecondaryColor)
            } else {
                // LazyVStack: i commenti di un post non hanno un tetto, e a
                // differenza del feed (gia' lazy) qui venivano costruiti tutti.
                LazyVStack(spacing: 10) {
                    // Filtro bloccati: stesso criterio del feed (Guideline 1.2).
                    ForEach(viewModel.comments.filter { session.blockedUserIDs.contains($0.uid) == false }) { comment in
                        commentRow(comment)
                            .padding(.leading, comment.isReply ? 22 : 0)
                    }
                }
            }

            composerSection
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(commentPanelColor)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(commentPanelBorderColor, lineWidth: 1)
        )
        .task(id: session.firebaseUser?.uid) {
            await viewModel.load(viewerUID: session.firebaseUser?.uid)
            onCountsUpdated(viewModel.counts)
            if session.isAuthenticated {
                commentComposer.shouldRefocusEditor = true
            }
        }
        .onChange(of: viewModel.counts) { _, newValue in
            onCountsUpdated(newValue)
        }
    }

    private var composerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if session.isAuthenticated {
                if let replyTarget {
                    ReplyingToBanner(authorName: replyTarget.authorName) {
                        self.replyTarget = nil
                        commentComposer.reset()
                    }
                }

                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(commentComposerSurfaceColor)

                    if commentComposer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("Scrivi un commento... usa @ e #")
                            .font(.body)
                            .foregroundStyle(commentPlaceholderColor)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .allowsHitTesting(false)
                    }

                    ComposerTextView(
                        text: $commentComposer.text,
                        selectedRange: $commentComposer.selectedRange,
                        dynamicHeight: $commentComposer.editorHeight,
                        shouldBecomeFirstResponder: $commentComposer.shouldRefocusEditor,
                        textColor: .white,
                        keyboardAppearance: .default,
                        onTextEvent: { text, selection in
                            commentComposer.handleEditorChange(
                                text,
                                selection: selection,
                                currentUserID: session.firebaseUser?.uid,
                                canSearchUsers: session.permissions.canSearchUsers
                            )
                        },
                        onReturnKey: {
                            if commentComposer.acceptHighlightedSuggestion() {
                                return true
                            }
                            guard commentComposer.canSubmit, !viewModel.isSending else { return false }
                            Task { await submitComment() }
                            return true
                        }
                    )
                    .frame(minHeight: max(48, commentComposer.editorHeight), maxHeight: 130)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }

                AutocompleteSuggestionsList(
                    composer: commentComposer,
                    subtitleColor: commentSecondaryColor,
                    dividerColor: commentDividerColor,
                    backgroundColor: commentComposerSurfaceColor
                )

                HStack(spacing: 10) {
                    Text("\(commentComposer.text.count)/\(commentComposer.characterLimit)")
                        .font(.caption)
                        .foregroundStyle(commentSecondaryColor)

                    Spacer()

                    Button {
                        Task { await submitComment() }
                    } label: {
                        if viewModel.isSending {
                            ProgressView()
                                .tint(.white)
                                .frame(minWidth: 120)
                        } else {
                            Text("Invia commento")
                                .frame(minWidth: 120)
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!commentComposer.canSubmit || viewModel.isSending)
                }
            } else {
                Button("Accedi per commentare") {
                    shell.presentAuth()
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
    }

    private func commentRow(_ comment: PostComment) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if comment.isReply {
                CommentReplyContextLabel(parentAuthorName: comment.parentAuthorName ?? String(localized: "un commento"))
            }

            HStack(alignment: .top, spacing: 10) {
                SomtoAvatar(
                    url: comment.avatarURL,
                    name: comment.authorName,
                    size: 34
                )

                VStack(alignment: .leading, spacing: 4) {
                    NavigationLink {
                        UserProfileDetailView(container: container, session: session, shell: shell, userID: comment.uid)
                    } label: {
                        Text(comment.authorName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(commentTextColor)
                    }
                    .buttonStyle(.plain)

                    if let createdAt = comment.createdAt {
                        Text(createdAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(commentSecondaryColor)
                    }
                }

                Spacer(minLength: 8)

                Button {
                    if session.isAuthenticated {
                        Task {
                            await viewModel.toggleCommentLike(commentID: comment.id, userID: session.firebaseUser?.uid)
                        }
                    } else {
                        shell.presentAuth()
                    }
                } label: {
                    Image(systemName: comment.likedByMe ? "heart.fill" : "heart")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(comment.likedByMe ? TwoWatchTheme.brandPrimary : commentSecondaryColor)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(comment.likedByMe ? "Rimuovi Mi piace al commento" : "Mi piace al commento")

                ContentModerationMenu(
                    container: container,
                    session: session,
                    authorUID: comment.uid,
                    authorName: comment.authorName,
                    reportType: "comment",
                    reportTargetID: comment.id,
                    reportReason: "Commento segnalato per contenuto o comportamento inappropriato.",
                    reportMetadata: [
                        "postId": postID,
                        "preview": String(comment.text.prefix(160)),
                        "source": "ios_feed_comments"
                    ]
                )
            }

            ExpandableTextBlock(
                isExpandable: ExpandableTextHeuristics.needsExpansion(for: comment.text, threshold: 180),
                collapsedLineLimit: 5
            ) { lineLimit in
                InteractiveTaggedText(
                    source: comment.text,
                    font: .subheadline,
                    textColor: commentTextColor,
                    lineLimit: lineLimit,
                    container: container,
                    session: session,
                    shell: shell
                )
            }

            HStack(spacing: 12) {
                if comment.likes > 0 {
                    Text("\(comment.likes) Mi piace")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(commentSecondaryColor)
                }
                Spacer()
                Button {
                    startReply(to: comment)
                } label: {
                    Label("Rispondi", systemImage: "arrowshape.turn.up.left")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(commentSecondaryColor)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(commentCardColor)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(commentCardBorderColor, lineWidth: 1)
        )
    }

    private func submitComment() async {
        let resolvedText = commentComposer.resolvedTextForSubmission(commentComposer.text)
        let didSend = await viewModel.sendComment(
            userID: session.firebaseUser?.uid,
            authorName: session.appUser?.displayName,
            text: resolvedText,
            authorAvatarURL: session.appUser?.photoURL ?? session.appUser?.avatarURL,
            parentCommentID: replyTarget?.id,
            parentUID: replyTarget?.uid,
            parentAuthorName: replyTarget?.authorName
        )

        guard didSend else { return }
        resetComposer()
        replyTarget = nil
        shell.invalidateSocialSurfaces()
    }

    private func startReply(to comment: PostComment) {
        guard session.isAuthenticated else {
            shell.presentAuth()
            return
        }
        replyTarget = comment
        commentComposer.seedMention(label: comment.authorName, uid: comment.uid)
    }

    private func resetComposer() {
        commentComposer.text = ""
        commentComposer.selectedRange = NSRange(location: 0, length: 0)
        commentComposer.editorHeight = 26
        commentComposer.handleEditorChange(
            "",
            selection: commentComposer.selectedRange,
            currentUserID: session.firebaseUser?.uid,
            canSearchUsers: session.permissions.canSearchUsers
        )
        commentComposer.shouldRefocusEditor = true
    }

    private var commentPanelColor: Color { TwoWatchTheme.panel }
    private var commentPanelBorderColor: Color { TwoWatchTheme.border }
    private var commentCardColor: Color { TwoWatchTheme.panelStrong }
    private var commentCardBorderColor: Color { TwoWatchTheme.border }
    private var commentComposerSurfaceColor: Color { TwoWatchTheme.panelStrong }
    private var commentDividerColor: Color { TwoWatchTheme.border }
    private var commentTextColor: Color { TwoWatchTheme.textPrimary }
    private var commentSecondaryColor: Color { TwoWatchTheme.textSecondary }
    private var commentPlaceholderColor: Color { TwoWatchTheme.textMuted }
}
