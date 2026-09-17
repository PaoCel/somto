import Observation
import SwiftUI

@Observable
@MainActor
final class PostDetailViewModel {
    private let postID: String
    private let repository: PostsRepository

    var post: AppPost?
    var counts = PostSocialCounts(likes: 0, comments: 0, shares: 0)
    var comments: [PostComment] = []
    var isLikedByMe = false
    var isLoading = false
    var isSending = false
    var isTogglingLike = false
    var likingCommentIDs: Set<String> = []
    var errorMessage: String?

    init(postID: String, repository: PostsRepository) {
        self.postID = postID
        self.repository = repository
    }

    func load(viewerUID: String?) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        async let postTask = repository.fetchPost(postID: postID)
        async let countsTask = repository.fetchSocialCounts(postID: postID)
        async let commentsTask = repository.fetchComments(postID: postID, viewerUID: viewerUID)
        async let likedTask = viewerUID == nil ? false : repository.isLikedByMe(postID: postID, uid: viewerUID ?? "")

        let loadedCounts: PostSocialCounts
        do {
            loadedCounts = try await countsTask
        } catch {
            loadedCounts = PostSocialCounts(likes: 0, comments: 0, shares: 0)
        }
        counts = loadedCounts

        let commentsLoadedSuccessfully: Bool
        do {
            comments = try await commentsTask
            commentsLoadedSuccessfully = true
        } catch {
            comments = []
            commentsLoadedSuccessfully = false
        }

        do {
            isLikedByMe = try await likedTask
        } catch {
            isLikedByMe = false
        }

        do {
            post = try await postTask
        } catch {
            post = nil
            if !commentsLoadedSuccessfully {
                errorMessage = UserFacingError.message(for: error)
            }
        }

        if post == nil, !commentsLoadedSuccessfully, errorMessage == nil {
            errorMessage = "Post non trovato."
        }
    }

    func toggleLike(userID: String?) async {
        guard let userID, !userID.isEmpty, !isTogglingLike else { return }
        isTogglingLike = true
        defer { isTogglingLike = false }

        let previousLiked = isLikedByMe
        let previousCounts = counts
        isLikedByMe.toggle()
        counts = PostSocialCounts(
            likes: max(0, counts.likes + (isLikedByMe ? 1 : -1)),
            comments: counts.comments,
            shares: counts.shares
        )

        do {
            isLikedByMe = try await repository.toggleLike(postID: postID, uid: userID)
            counts = try await repository.fetchSocialCounts(postID: postID)
        } catch {
            isLikedByMe = previousLiked
            counts = previousCounts
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func sendComment(
        userID: String?,
        authorName: String?,
        text: String,
        authorAvatarURL: URL? = nil,
        parentCommentID: String? = nil,
        parentUID: String? = nil,
        parentAuthorName: String? = nil,
        containsSpoiler: Bool = false,
        spoilerTitleIDs: [String] = []
    ) async -> Bool {
        guard let userID, !userID.isEmpty else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        isSending = true
        errorMessage = nil
        defer { isSending = false }

        do {
            try await repository.addComment(
                postID: postID,
                uid: userID,
                authorName: authorName ?? "User",
                text: trimmed,
                authorAvatarURL: authorAvatarURL,
                parentCommentID: parentCommentID,
                parentUID: parentUID,
                parentAuthorName: parentAuthorName,
                containsSpoiler: containsSpoiler,
                spoilerTitleIDs: containsSpoiler ? spoilerTitleIDs : []
            )
            counts = try await repository.fetchSocialCounts(postID: postID)
            comments = try await repository.fetchComments(postID: postID, viewerUID: userID)
            return true
        } catch {
            errorMessage = UserFacingError.message(for: error)
            return false
        }
    }

    func toggleCommentLike(commentID: String, userID: String?) async {
        guard let userID, !userID.isEmpty, !likingCommentIDs.contains(commentID),
              let index = comments.firstIndex(where: { $0.id == commentID }) else { return }
        likingCommentIDs.insert(commentID)
        defer { likingCommentIDs.remove(commentID) }

        let previous = comments[index]
        comments[index] = replacingLike(
            in: previous,
            liked: !previous.likedByMe,
            likes: max(0, previous.likes + (previous.likedByMe ? -1 : 1))
        )

        do {
            _ = try await repository.toggleCommentLike(postID: postID, commentID: commentID, uid: userID)
            counts = try await repository.fetchSocialCounts(postID: postID)
            comments = try await repository.fetchComments(postID: postID, viewerUID: userID)
        } catch {
            if let rollbackIndex = comments.firstIndex(where: { $0.id == commentID }) {
                comments[rollbackIndex] = previous
            }
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func replacingLike(in comment: PostComment, liked: Bool, likes: Int) -> PostComment {
        PostComment(
            id: comment.id,
            uid: comment.uid,
            authorName: comment.authorName,
            avatarURL: comment.avatarURL,
            text: comment.text,
            createdAt: comment.createdAt,
            likes: likes,
            likedByMe: liked,
            parentCommentId: comment.parentCommentId,
            parentAuthorName: comment.parentAuthorName,
            containsSpoiler: comment.containsSpoiler,
            spoilerTitleIds: comment.spoilerTitleIds
        )
    }
}

struct PostDetailView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let postID: String

    @State private var viewModel: PostDetailViewModel
    @State private var commentComposer: SocialComposerViewModel
    @State private var replyTarget: PostComment?
    @State private var commentContainsSpoiler: Bool = false
    @State private var commentSpoilerTitleIDs: [String] = []

    init(container: AppContainer, session: SessionStore, shell: AppShellStore, postID: String) {
        self.container = container
        self.session = session
        self.shell = shell
        self.postID = postID
        _viewModel = State(initialValue: PostDetailViewModel(postID: postID, repository: container.postsRepository))
        _commentComposer = State(initialValue: SocialComposerViewModel(
            titleRepository: container.titleRepository,
            userRepository: container.userRepository,
            topicScope: .titlesAndPeople,
            characterLimit: 5000
        ))
    }

    var body: some View {
        @Bindable var viewModel = viewModel

        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let post = viewModel.post {
                    postBlock(post)
                    actionBar
                    commentsSection
                } else if viewModel.isLoading {
                    ProgressView()
                        .tint(TwoWatchTheme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                } else {
                    EmptyStateView(
                        title: "Contenuto non disponibile",
                        message: "Questo post o thread social non è stato trovato.",
                        systemImage: "bubble.left.and.exclamationmark.bubble.right.fill"
                    )
                    .padding(20)
                }
            }
            .padding(.bottom, 12)
            .simultaneousGesture(TapGesture().onEnded {
                dismissKeyboard()
            })
        }
        .background(TwoWatchBackground())
        .scrollDismissesKeyboard(.interactively)
        // Composer ancorato in basso invece che in cima ai commenti: prima
        // occupava il primo schermo e spingeva i commenti sotto la piega.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if viewModel.post != nil {
                composerDockInline
            }
        }
        .navigationTitle("Post")
        .navigationBarTitleDisplayMode(.inline)
        // Il composer sta sul bordo inferiore: con la tab bar sotto sarebbero
        // due barre impilate. Comportamento standard delle schermate di
        // dettaglio con una barra di input.
        .toolbar(.hidden, for: .tabBar)
        .task(id: session.firebaseUser?.uid) {
            await viewModel.load(viewerUID: session.firebaseUser?.uid)
        }
        // Una query per schermata, condivisa col feed: il bottone "Segui"
        // nasce gia' nello stato giusto.
        .task(id: session.firebaseUser?.uid) {
            await container.titleFollowStore.load(userID: session.firebaseUser?.uid)
        }
        .alert("Errore", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { _ in viewModel.errorMessage = nil }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    /// Il post, in un unico blocco con una gerarchia esplicita:
    /// autore → **testo** → media → contesto (titolo, con chi, share).
    ///
    /// Prima ogni pezzo era una `GlassCard` a sé: dieci riquadri identici
    /// impilati, senza un ordine di lettura. Soprattutto il testo — il
    /// contenuto vero del post — arrivava quarto, dopo header, barra social e
    /// card del titolo.
    @ViewBuilder
    private func postBlock(_ post: AppPost) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            authorRow(post)

            if let textSource = post.primarySourceText, !textSource.isEmpty {
                SpoilerGate(
                    containsSpoiler: post.containsSpoiler,
                    spoilerTitleIDs: post.spoilerTitleIds,
                    viewerCompletedTitleIDs: session.completedTitleIDs,
                    titleNames: [:],
                    onMarkSeen: { titleID in await markCompleted(titleID) }
                ) {
                    ExpandableTaggedTextView(
                        source: textSource,
                        // Il testo è il contenuto: parte più grande di tutto
                        // il resto della pagina.
                        font: .system(size: 17),
                        textColor: TwoWatchTheme.textPrimary,
                        collapsedLineLimit: 10,
                        expansionThreshold: 420,
                        container: container,
                        session: session,
                        shell: shell
                    )
                }
            }

            let galleryURLs = postMediaGalleryURLs(for: post)
            if !galleryURLs.isEmpty {
                SocialMediaCarouselView(
                    urls: galleryURLs,
                    height: 300,
                    cornerRadius: 20,
                    tapActionForIndex: carouselTapAction(for: post)
                )
            }

            if post.taggedTitles.count > 1 {
                MultiTitleCollageView(titles: post.taggedTitles) { taggedTitle in
                    TitleDetailView(container: container, session: session, shell: shell, titleID: taggedTitle.id)
                }
            } else if let title = displayedTitle(for: post) {
                // "Segui" fuori dal link, non dentro: due aree tappabili
                // annidate finirebbero per aprire sempre la scheda.
                HStack(spacing: SomtoSpacing.ml) {
                    NavigationLink {
                        TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                    } label: {
                        postTitleCard(title)
                    }
                    .buttonStyle(.plain)

                    TitleFollowButton(
                        titleID: title.id,
                        store: container.titleFollowStore,
                        userID: session.firebaseUser?.uid,
                        showsLabel: true,
                        onRequestAuth: shell.presentAuth
                    )
                }

                // Stessa pastiglia della card nel feed: chi arriva sul post da
                // una notifica deve poter andare a guardarlo da qui.
                TitleWatchNowButton(title: title, providers: nil, style: .compact)
            }

            if let sharedPost = post.sharedPost {
                NavigationLink {
                    PostDetailView(container: container, session: session, shell: shell, postID: sharedPost.postId)
                } label: {
                    sharedPostCard(sharedPost)
                }
                .buttonStyle(.plain)
            }

            if !post.watchedWith.isEmpty {
                watchedWithRow(post.watchedWith)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 16)
    }

    /// Autore + quando + eventuale voto, su una riga sola.
    private func authorRow(_ post: AppPost) -> some View {
        HStack(alignment: .center, spacing: 12) {
            NavigationLink {
                UserProfileDetailView(container: container, session: session, shell: shell, userID: post.author.id)
            } label: {
                HStack(spacing: 10) {
                    SomtoAvatar(url: post.author.photoURL, name: post.author.displayName, size: 46, showsBorder: true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(post.author.displayName)
                            .font(.system(size: 15, weight: .heavy))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(1)
                        Text(metaLine(post))
                            .font(.system(size: 12))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)

            if let rating = post.rating {
                HStack(spacing: 4) {
                    Image(systemName: "star.fill")
                        .font(.system(size: 11, weight: .bold))
                    Text(formattedRating(rating))
                        .font(.system(size: 14, weight: .heavy))
                        .monospacedDigit()
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(TwoWatchTheme.brandPrimary, in: Capsule())
                .accessibilityLabel("Voto \(formattedRating(rating)) su 10")
            }

            ContentModerationMenu(
                container: container,
                session: session,
                authorUID: post.author.id,
                authorName: post.author.displayName,
                reportType: "post",
                reportTargetID: post.id,
                reportReason: "Post segnalato per contenuto o comportamento inappropriato.",
                reportMetadata: [
                    "postId": post.id,
                    "preview": String((post.primarySourceText ?? "").prefix(160)),
                    "source": "ios_post_detail"
                ]
            )
        }
    }

    /// "Voto · 3 giorni fa": tipo e data in una riga sola sotto il nome,
    /// invece di una pill colorata a sinistra e una data a destra.
    private func metaLine(_ post: AppPost) -> String {
        var parts: [String] = [kindLabel(post.kind)]
        if let date = post.updatedAt ?? post.createdAt {
            parts.append(date.formatted(.relative(presentation: .named)))
        }
        return parts.joined(separator: " · ")
    }

    /// Marca un titolo come visto dal gate spoiler.
    private func markCompleted(_ titleID: String) async {
        guard let uid = session.firebaseUser?.uid,
              let repo = container.watchlistRepository as WatchlistRepository?
        else { return }
        do {
            _ = try await repo.markTitleCompletedByID(userID: uid, titleID: titleID)
            session.markTitleCompletedLocally(titleID)
        } catch { /* silent */ }
    }

    private func carouselTapAction(for post: AppPost) -> ((Int) -> Void)? {
        guard let title = displayedTitle(for: post) else {
            return nil
        }

        return { index in
            guard index == 0 else { return }
            _ = shell.present(
                destination: .title(id: title.id, focus: nil),
                currentUserID: session.firebaseUser?.uid
            )
        }
    }

    /// Azioni e contatori sulla stessa riga, fra due separatori sottili.
    /// Prima erano una card con tre "stat pill" più un bottone primario a
    /// tutta larghezza: un invito enorme per un like.
    private var actionBar: some View {
        VStack(spacing: 0) {
            Divider().overlay(TwoWatchTheme.border)

            HStack(spacing: 22) {
                Button {
                    if session.isAuthenticated {
                        Task { await viewModel.toggleLike(userID: session.firebaseUser?.uid) }
                    } else {
                        shell.presentAuth()
                    }
                } label: {
                    if viewModel.isTogglingLike {
                        ProgressView()
                            .tint(TwoWatchTheme.brandPrimary)
                            .frame(minWidth: 38, minHeight: 24)
                    } else {
                        actionItem(
                            icon: viewModel.isLikedByMe ? "heart.fill" : "heart",
                            count: viewModel.counts.likes,
                            isActive: viewModel.isLikedByMe
                        )
                    }
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isTogglingLike)
                .accessibilityLabel(
                    viewModel.isLikedByMe
                        ? "Ti piace. \(viewModel.counts.likes) like. Tocca per togliere"
                        : "\(viewModel.counts.likes) like. Tocca per mettere like"
                )

                actionItem(icon: "bubble.left", count: viewModel.counts.comments, isActive: false)
                    .accessibilityLabel("\(viewModel.counts.comments) commenti")

                if viewModel.counts.shares > 0 {
                    actionItem(icon: "arrowshape.turn.up.right", count: viewModel.counts.shares, isActive: false)
                        .accessibilityLabel("\(viewModel.counts.shares) condivisioni")
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)

            Divider().overlay(TwoWatchTheme.border)
        }
    }

    private func actionItem(icon: String, count: Int, isActive: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
            if count > 0 {
                Text("\(count)")
                    .font(.system(size: 14, weight: .bold))
                    .monospacedDigit()
            }
        }
        .foregroundStyle(isActive ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
        .contentShape(Rectangle())
    }

    /// Titolo collegato: contesto del post, non il protagonista → riga
    /// compatta invece della card alta con la locandina da 108pt.
    private func postTitleCard(_ title: Title) -> some View {
        HStack(spacing: 12) {
            PosterImageView(url: title.posterPath, width: 44, height: 64, cornerRadius: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.name)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                Text(title.subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(10)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .contentShape(Rectangle())
    }

    private func displayedTitle(for post: AppPost) -> Title? {
        post.taggedTitles.first ?? post.title
    }

    private func postMediaGalleryURLs(for post: AppPost) -> [URL] {
        var urls: [URL] = []
        var seen: Set<String> = []
        let title = displayedTitle(for: post)
        let extraMedia = !post.mediaURLs.isEmpty ? post.mediaURLs : (post.mediaURL.map { [$0] } ?? [])

        if let titleMedia = title?.posterPath ?? title?.backdropPath,
           !extraMedia.isEmpty,
           seen.insert(titleMedia.absoluteString).inserted {
            urls.append(titleMedia)
        }

        for url in extraMedia where seen.insert(url.absoluteString).inserted {
            urls.append(url)
        }

        if urls.isEmpty, title == nil {
            return extraMedia
        }

        return urls
    }

    /// Post citato: rientrato con una barra verticale, come una citazione.
    private func sharedPostCard(_ sharedPost: FeedSharedPost) -> some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(TwoWatchTheme.border)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 6) {
                Text("Condivisione da @\(sharedPost.author.displayName)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.accent)
                ExpandableTextBlock(
                    isExpandable: ExpandableTextHeuristics.needsExpansion(for: sharedPost.displayText, threshold: 180),
                    collapsedLineLimit: 5
                ) { lineLimit in
                    Text(sharedPost.displayText)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(lineLimit)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// "Visto con": una riga di chip, senza card intorno — è un dettaglio.
    private func watchedWithRow(_ people: [FeedTaggedUser]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Text("Visto con")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                ForEach(people) { person in
                    Text(person.displayName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(TwoWatchTheme.panelStrong, in: Capsule())
                }
            }
        }
        .scrollClipDisabled()
    }

    /// Solo intestazione + lista. Il composer è ancorato in basso.
    private var commentsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            PostDiscussionHeader(commentCount: max(viewModel.counts.comments, visibleComments.count))
                .padding(.horizontal, SomtoSpacing.xxxl)
                .padding(.top, SomtoSpacing.section)
                .padding(.bottom, SomtoSpacing.m)

            if visibleComments.isEmpty {
                Text("Ancora nessun commento. Scrivi il primo.")
                    .font(.system(size: 15))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, SomtoSpacing.xxxl)
                    .padding(.vertical, SomtoSpacing.xl)
            } else {
                ForEach(Array(visibleComments.enumerated()), id: \.element.id) { index, comment in
                    if index > 0 {
                        Rectangle()
                            .fill(TwoWatchTheme.border)
                            .frame(height: 1)
                            .padding(.horizontal, SomtoSpacing.xxxl)
                            .accessibilityHidden(true)
                    }
                    PostCommentRow(
                        comment: comment,
                        viewModel: viewModel,
                        container: container,
                        session: session,
                        shell: shell,
                        onReply: startReply,
                        moderationSource: "ios_post_detail"
                    )
                    .padding(.horizontal, SomtoSpacing.xxxl)
                }
            }
        }
    }

    /// Guideline 1.2: i contenuti di chi hai bloccato spariscono subito.
    private var visibleComments: [PostComment] {
        viewModel.comments.filter { session.blockedUserIDs.contains($0.uid) == false }
    }

    /// Composer ancorato in fondo alla pagina: sempre raggiungibile, e non
    /// ruba il primo schermo ai commenti come faceva quello inline.
    private var composerDockInline: some View {
        @Bindable var commentComposer = commentComposer
        let editorMaxHeight: CGFloat = 96
        let clampedComposerHeight = min(editorMaxHeight, max(22, commentComposer.editorHeight))

        return VStack(alignment: .leading, spacing: 8) {
            if session.isAuthenticated {
                if let replyTarget {
                    ReplyingToBanner(authorName: replyTarget.authorName) {
                        self.replyTarget = nil
                        commentComposer.reset()
                    }
                }

                AutocompleteSuggestionsList(
                    composer: commentComposer,
                    subtitleColor: TwoWatchTheme.textSecondary,
                    dividerColor: TwoWatchTheme.border,
                    backgroundColor: TwoWatchTheme.backgroundSecondary.opacity(0.92)
                )

                SpoilerComposerSection(
                    containsSpoiler: $commentContainsSpoiler,
                    spoilerTitleIDs: $commentSpoilerTitleIDs,
                    candidateTitles: spoilerCandidateTitles
                )

                HStack(alignment: .bottom, spacing: 10) {
                    ZStack(alignment: .topLeading) {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(TwoWatchTheme.panel)

                        if commentComposer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("Scrivi un commento... usa @ e #")
                                .font(.system(size: 15))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .allowsHitTesting(false)
                        }

                        ComposerTextView(
                            text: $commentComposer.text,
                            selectedRange: $commentComposer.selectedRange,
                            dynamicHeight: $commentComposer.editorHeight,
                            shouldBecomeFirstResponder: $commentComposer.shouldRefocusEditor,
                            textColor: .white,
                            keyboardAppearance: .dark,
                            minHeight: 22,
                            maxHeight: editorMaxHeight,
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
                        .frame(height: clampedComposerHeight)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .frame(minHeight: 40, maxHeight: clampedComposerHeight + 16, alignment: .bottom)

                    // Icona invece del bottone "Invia commento" a piena
                    // larghezza: qui serve solo confermare.
                    Button {
                        Task { await submitComment() }
                    } label: {
                        Group {
                            if viewModel.isSending {
                                ProgressView().tint(Color.black)
                            } else {
                                Image(systemName: "paperplane.fill")
                                    .font(.system(size: 15, weight: .bold))
                                    .foregroundStyle(Color.black)
                            }
                        }
                        .frame(width: 40, height: 40)
                        .background(
                            commentComposer.canSubmit ? TwoWatchTheme.accent : TwoWatchTheme.panelStrong,
                            in: Circle()
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(!commentComposer.canSubmit || viewModel.isSending)
                    .accessibilityLabel("Invia commento")
                }
            } else {
                Button("Accedi per commentare") {
                    shell.presentAuth()
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    private func kindLabel(_ kind: PostKind) -> String {
        switch kind {
        case .post:
            return "Post"
        case .share:
            return "Share"
        case .rating:
            return "Voto"
        case .watchTogether:
            return "Visto insieme"
        }
    }

    private func formattedRating(_ value: Double) -> String {
        RatingDisplayFormatter.social(value)
    }

    /// Pool di titoli proponibili nel picker spoiler del comment composer.
    /// Priorità: titolo principale del post + titoli taggati. Limita a 8 per
    /// evitare overflow UI (il cap di selezione resta 5 lato rule).
    private var spoilerCandidateTitles: [Title] {
        guard let post = viewModel.post else { return [] }
        var seen: Set<String> = []
        var out: [Title] = []
        if let primary = post.title, seen.insert(primary.id).inserted {
            out.append(primary)
        }
        for t in post.taggedTitles where seen.insert(t.id).inserted {
            out.append(t)
        }
        return Array(out.prefix(8))
    }

    private func submitComment() async {
        guard session.isAuthenticated else {
            shell.presentAuth()
            return
        }

        let rawText = commentComposer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawText.isEmpty else { return }

        let resolvedText = commentComposer.resolvedTextForSubmission(rawText)
        let didSend = await viewModel.sendComment(
            userID: session.firebaseUser?.uid,
            authorName: session.appUser?.displayName ?? session.firebaseUser?.displayName,
            text: resolvedText,
            parentCommentID: replyTarget?.id,
            parentUID: replyTarget?.uid,
            parentAuthorName: replyTarget?.authorName,
            containsSpoiler: commentContainsSpoiler,
            spoilerTitleIDs: commentSpoilerTitleIDs
        )

        if didSend {
            commentComposer.reset()
            replyTarget = nil
            commentContainsSpoiler = false
            commentSpoilerTitleIDs = []
        }
    }

    private func startReply(to comment: PostComment) {
        guard session.isAuthenticated else {
            shell.presentAuth()
            return
        }
        replyTarget = comment
        commentComposer.seedMention(label: comment.authorName, uid: comment.uid)
    }
}
/// La conversazione di un post a tutto schermo: e' quello che si apre quando
/// tocchi la notifica "ha commentato il tuo post".
///
/// Prima era una pila di card dentro una card — il post in un riquadro, ogni
/// commento in un altro, tutto dentro il foglio — e la gerarchia si perdeva.
/// Ora e' una pagina piatta: post, filo, discussione. I riquadri sono
/// diventati separatori, che e' il modo piu' economico di dire "qui finisce
/// una cosa e ne comincia un'altra".
struct PostCommentsSheetView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let postID: String
    let focusesComposerOnAppear: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: PostDetailViewModel
    @State private var commentComposer: SocialComposerViewModel
    @State private var didRequestInitialFocus = false
    @State private var replyTarget: PostComment?
    @State private var commentContainsSpoiler: Bool = false
    @State private var commentSpoilerTitleIDs: [String] = []

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        postID: String,
        focusesComposerOnAppear: Bool
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.postID = postID
        self.focusesComposerOnAppear = focusesComposerOnAppear
        _viewModel = State(initialValue: PostDetailViewModel(postID: postID, repository: container.postsRepository))
        _commentComposer = State(initialValue: SocialComposerViewModel(
            titleRepository: container.titleRepository,
            userRepository: container.userRepository,
            topicScope: .titlesAndPeople,
            characterLimit: 5000
        ))
    }

    var body: some View {
        ZStack {
            TwoWatchBackground()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if viewModel.isLoading, viewModel.post == nil, viewModel.comments.isEmpty {
                        ProgressView()
                            .tint(TwoWatchTheme.accent)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 48)
                    } else {
                        if let post = viewModel.post {
                            postBlock(post)
                            separator
                        }

                        PostDiscussionHeader(commentCount: max(viewModel.counts.comments, visibleComments.count))
                            .padding(.horizontal, SomtoSpacing.xxxl)
                            .padding(.top, SomtoSpacing.section)
                            .padding(.bottom, SomtoSpacing.m)

                        if visibleComments.isEmpty {
                            Text("Ancora nessun commento. Scrivi il primo.")
                                .font(.system(size: 15))
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .padding(.horizontal, SomtoSpacing.xxxl)
                                .padding(.vertical, SomtoSpacing.xl)
                        } else {
                            ForEach(Array(visibleComments.enumerated()), id: \.element.id) { index, comment in
                                if index > 0 {
                                    separator
                                        .padding(.horizontal, SomtoSpacing.xxxl)
                                }
                                PostCommentRow(
                                    comment: comment,
                                    viewModel: viewModel,
                                    container: container,
                                    session: session,
                                    shell: shell,
                                    onReply: startReply,
                                    moderationSource: "ios_comments_sheet"
                                )
                                .padding(.horizontal, SomtoSpacing.xxxl)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, SomtoSpacing.section)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .simultaneousGesture(TapGesture().onEnded {
            dismissKeyboard()
        })
        .safeAreaInset(edge: .bottom) {
            composerDock
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                .accessibilityLabel("Chiudi")
            }

            ToolbarItem(placement: .topBarTrailing) {
                if let post = viewModel.post {
                    ContentModerationMenu(
                        container: container,
                        session: session,
                        authorUID: post.author.id,
                        authorName: post.author.displayName,
                        reportType: "post",
                        reportTargetID: post.id,
                        reportReason: "Post segnalato per contenuto o comportamento inappropriato.",
                        reportMetadata: [
                            "postId": post.id,
                            "preview": String((post.primarySourceText ?? "").prefix(160)),
                            "source": "ios_comments_sheet"
                        ]
                    )
                }
            }
        }
        .task(id: session.firebaseUser?.uid) {
            await viewModel.load(viewerUID: session.firebaseUser?.uid)
            requestInitialComposerFocusIfNeeded()
        }
        .task(id: session.firebaseUser?.uid) {
            await container.titleFollowStore.load(userID: session.firebaseUser?.uid)
        }
        .alert("Errore", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { _ in viewModel.errorMessage = nil }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    /// Guideline 1.2: i contenuti di chi hai bloccato spariscono subito.
    private var visibleComments: [PostComment] {
        viewModel.comments.filter { session.blockedUserIDs.contains($0.uid) == false }
    }

    private var separator: some View {
        Rectangle()
            .fill(TwoWatchTheme.border)
            .frame(height: 1)
            .accessibilityHidden(true)
    }

    /// Il post: autore, voto, testo e — sotto un filo — il titolo di cui parla.
    @ViewBuilder
    private func postBlock(_ post: AppPost) -> some View {
        VStack(alignment: .leading, spacing: SomtoSpacing.xl) {
            HStack(alignment: .center, spacing: SomtoSpacing.l) {
                NavigationLink {
                    UserProfileDetailView(container: container, session: session, shell: shell, userID: post.author.id)
                } label: {
                    HStack(spacing: SomtoSpacing.l) {
                        SomtoAvatar(url: post.author.photoURL, name: post.author.displayName, size: 48, showsBorder: true)
                        VStack(alignment: .leading, spacing: SomtoSpacing.xxs) {
                            Text(post.author.displayName)
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                                .lineLimit(1)
                            Text(summaryMetaLine(for: post))
                                .font(.system(size: 14))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                                .lineLimit(1)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer(minLength: SomtoSpacing.m)

                if let rating = post.rating {
                    HStack(spacing: SomtoSpacing.s) {
                        Image(systemName: "star.fill")
                            .font(.system(size: 13, weight: .bold))
                        Text(formattedRating(rating))
                            .font(.system(size: 17, weight: .bold))
                            .monospacedDigit()
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, SomtoSpacing.xl)
                    .padding(.vertical, SomtoSpacing.m)
                    .background(TwoWatchTheme.brandPrimary, in: Capsule())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Voto \(formattedRating(rating))")
                }
            }

            if let textSource = post.primarySourceText, !textSource.isEmpty {
                SpoilerGate(
                    containsSpoiler: post.containsSpoiler,
                    spoilerTitleIDs: post.spoilerTitleIds,
                    viewerCompletedTitleIDs: session.completedTitleIDs,
                    titleNames: [:],
                    onMarkSeen: { titleID in await markCompleted(titleID) }
                ) {
                    ExpandableTaggedTextView(
                        source: textSource,
                        font: .system(size: 18),
                        textColor: TwoWatchTheme.textPrimary,
                        collapsedLineLimit: 10,
                        expansionThreshold: 420,
                        container: container,
                        session: session,
                        shell: shell
                    )
                }
            }

            if post.taggedTitles.count > 1 {
                separator
                taggedTitleStrip(post.taggedTitles)
            } else if let title = displayedTitle(for: post) {
                separator
                // "Segui" fuori dal link, non dentro: due aree tappabili
                // annidate finirebbero per aprire sempre la scheda.
                HStack(spacing: SomtoSpacing.l) {
                    NavigationLink {
                        TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                    } label: {
                        HStack(spacing: SomtoSpacing.l) {
                            PosterImageView(url: title.posterPath, width: 56, height: 82, cornerRadius: SomtoRadius.m)
                            VStack(alignment: .leading, spacing: SomtoSpacing.xs) {
                                Text(title.name)
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                    .lineLimit(2)
                                Text(title.subtitle)
                                    .font(.system(size: 14))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: SomtoSpacing.m)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    TitleFollowButton(
                        titleID: title.id,
                        store: container.titleFollowStore,
                        userID: session.firebaseUser?.uid,
                        showsLabel: true,
                        onRequestAuth: shell.presentAuth
                    )
                }

                // Stessa pastiglia della card nel feed: chi arriva sul post da
                // una notifica deve poter andare a guardarlo da qui.
                TitleWatchNowButton(title: title, providers: nil, style: .compact)
            }
        }
        .padding(.horizontal, SomtoSpacing.xxxl)
        .padding(.top, SomtoSpacing.xl)
        .padding(.bottom, SomtoSpacing.section)
    }

    private func taggedTitleStrip(_ titles: [Title]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: SomtoSpacing.m) {
                ForEach(Array(titles.prefix(6))) { title in
                    NavigationLink {
                        TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                    } label: {
                        PosterImageView(url: title.posterPath, width: 52, height: 76, cornerRadius: SomtoRadius.m)
                    }
                    .buttonStyle(.plain)
                }

                if titles.count > 6 {
                    Text("+\(titles.count - 6)")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(width: 52, height: 76)
                        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: SomtoRadius.m, style: .continuous))
                }
            }
        }
    }

    /// La barra in fondo: campo, invio, e il solo interruttore spoiler.
    /// Il contatore di caratteri e il bottone "Invia commento" a piena
    /// larghezza sono spariti — occupavano quanto due commenti.
    private var composerDock: some View {
        @Bindable var commentComposer = commentComposer
        let editorMaxHeight: CGFloat = 96
        let clampedComposerHeight = min(editorMaxHeight, max(22, commentComposer.editorHeight))

        return VStack(alignment: .leading, spacing: SomtoSpacing.ml) {
            if session.isAuthenticated {
                if let replyTarget {
                    ReplyingToBanner(authorName: replyTarget.authorName) {
                        self.replyTarget = nil
                        commentComposer.reset()
                    }
                }

                AutocompleteSuggestionsList(
                    composer: commentComposer,
                    subtitleColor: TwoWatchTheme.textSecondary,
                    dividerColor: TwoWatchTheme.border,
                    backgroundColor: TwoWatchTheme.backgroundSecondary.opacity(0.92)
                )

                HStack(alignment: .bottom, spacing: SomtoSpacing.ml) {
                    ZStack(alignment: .topLeading) {
                        RoundedRectangle(cornerRadius: SomtoRadius.xl, style: .continuous)
                            .fill(TwoWatchTheme.panel)

                        if commentComposer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("Scrivi un commento... usa @ e #")
                                .font(.system(size: 16))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                                .padding(.horizontal, SomtoSpacing.xl)
                                .padding(.vertical, SomtoSpacing.l)
                                .allowsHitTesting(false)
                        }

                        ComposerTextView(
                            text: $commentComposer.text,
                            selectedRange: $commentComposer.selectedRange,
                            dynamicHeight: $commentComposer.editorHeight,
                            shouldBecomeFirstResponder: $commentComposer.shouldRefocusEditor,
                            textColor: .white,
                            keyboardAppearance: .dark,
                            minHeight: 22,
                            maxHeight: editorMaxHeight,
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
                        .frame(height: clampedComposerHeight)
                        .padding(.horizontal, SomtoSpacing.xl)
                        .padding(.vertical, SomtoSpacing.ml)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .frame(minHeight: 44, maxHeight: clampedComposerHeight + 20, alignment: .bottom)

                    Button {
                        Task { await submitComment() }
                    } label: {
                        Group {
                            if viewModel.isSending {
                                ProgressView().tint(Color.black)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 17, weight: .bold))
                                    .foregroundStyle(Color.black)
                            }
                        }
                        .frame(width: 44, height: 44)
                        .background(
                            commentComposer.canSubmit ? TwoWatchTheme.accent : TwoWatchTheme.panelStrong,
                            in: Circle()
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(!commentComposer.canSubmit || viewModel.isSending)
                    .accessibilityLabel("Invia commento")
                }

                SpoilerComposerSection(
                    containsSpoiler: $commentContainsSpoiler,
                    spoilerTitleIDs: $commentSpoilerTitleIDs,
                    candidateTitles: spoilerCandidateTitles
                )
            } else {
                Button("Accedi per commentare") {
                    shell.presentAuth()
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(.horizontal, SomtoSpacing.xxl)
        .padding(.top, SomtoSpacing.l)
        .padding(.bottom, SomtoSpacing.l)
        .background(
            TwoWatchTheme.background.opacity(0.98)
                .ignoresSafeArea(edges: .bottom)
        )
        .overlay(alignment: .top) {
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    private func displayedTitle(for post: AppPost) -> Title? {
        post.taggedTitles.first ?? post.title
    }

    private func markCompleted(_ titleID: String) async {
        guard let uid = session.firebaseUser?.uid else { return }
        do {
            _ = try await container.watchlistRepository.markTitleCompletedByID(userID: uid, titleID: titleID)
            session.markTitleCompletedLocally(titleID)
        } catch { /* silent: il gate resta chiuso, l'utente puo' riprovare */ }
    }

    private func summaryMetaLine(for post: AppPost) -> String {
        let base: String
        switch post.kind {
        case .post:
            base = "Post"
        case .share:
            base = "Share"
        case .rating:
            base = "Voto"
        case .watchTogether:
            base = "Visto insieme"
        }

        if let createdAt = post.updatedAt ?? post.createdAt {
            return "\(base) • \(createdAt.formatted(date: .abbreviated, time: .shortened))"
        }

        return base
    }

    private func formattedRating(_ value: Double) -> String {
        RatingDisplayFormatter.social(value)
    }

    /// Identico a `PostDetailView.spoilerCandidateTitles` ma scoped al sheet
    /// (per evitare di estendere accesso e tenere il file leggibile).
    private var spoilerCandidateTitles: [Title] {
        guard let post = viewModel.post else { return [] }
        var seen: Set<String> = []
        var out: [Title] = []
        if let primary = post.title, seen.insert(primary.id).inserted {
            out.append(primary)
        }
        for t in post.taggedTitles where seen.insert(t.id).inserted {
            out.append(t)
        }
        return Array(out.prefix(8))
    }

    private func submitComment() async {
        guard session.isAuthenticated else {
            shell.presentAuth()
            return
        }

        let rawText = commentComposer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawText.isEmpty else { return }

        let resolvedText = commentComposer.resolvedTextForSubmission(rawText)
        let didSend = await viewModel.sendComment(
            userID: session.firebaseUser?.uid,
            authorName: session.appUser?.displayName ?? session.firebaseUser?.displayName,
            text: resolvedText,
            parentCommentID: replyTarget?.id,
            parentUID: replyTarget?.uid,
            parentAuthorName: replyTarget?.authorName,
            containsSpoiler: commentContainsSpoiler,
            spoilerTitleIDs: commentSpoilerTitleIDs
        )

        if didSend {
            commentComposer.reset()
            replyTarget = nil
            commentContainsSpoiler = false
            commentSpoilerTitleIDs = []
            shell.invalidateSocialPost(postID)
        }
    }

    private func startReply(to comment: PostComment) {
        guard session.isAuthenticated else {
            shell.presentAuth()
            return
        }
        replyTarget = comment
        commentComposer.seedMention(label: comment.authorName, uid: comment.uid)
    }

    private func requestInitialComposerFocusIfNeeded() {
        guard focusesComposerOnAppear, session.isAuthenticated, !didRequestInitialFocus else { return }
        didRequestInitialFocus = true

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            commentComposer.shouldRefocusEditor = true
        }
    }
}

struct ReplyingToBanner: View {
    let authorName: String
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.caption2.weight(.bold))
            Text("In risposta a \(authorName)")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Spacer()
            Button(action: onCancel) {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Annulla risposta")
        }
        .foregroundStyle(TwoWatchTheme.textSecondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(TwoWatchTheme.panelStrong)
        )
    }
}

struct CommentReplyContextLabel: View {
    let parentAuthorName: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 9, weight: .bold))
            Text("In risposta a \(parentAuthorName)")
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(TwoWatchTheme.textMuted)
    }
}

/// Testo con tag (@utente, #titolo) e "mostra tutto" quando e' lungo.
/// Internal e non privato: lo usa anche `PostCommentRow`.
struct ExpandableTaggedTextView: View {
    let source: String
    let font: Font
    let textColor: Color
    let collapsedLineLimit: Int
    let expansionThreshold: Int
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    var body: some View {
        ExpandableTextBlock(
            isExpandable: ExpandableTextHeuristics.needsExpansion(for: source, threshold: expansionThreshold),
            collapsedLineLimit: collapsedLineLimit
        ) { lineLimit in
            InteractiveTaggedText(
                source: source,
                font: font,
                textColor: textColor,
                lineLimit: lineLimit,
                container: container,
                session: session,
                shell: shell
            )
        }
    }
}

