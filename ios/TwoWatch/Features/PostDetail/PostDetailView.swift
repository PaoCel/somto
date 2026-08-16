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
            HStack(spacing: 8) {
                // Il numero mostrato è quello dei commenti davvero in lista,
                // non il contatore aggregato: se divergono, vince ciò che si
                // vede sotto.
                Text("\(viewModel.comments.count) commenti")
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 8)

            if viewModel.comments.isEmpty {
                Text("Ancora nessun commento. Scrivi il primo.")
                    .font(.system(size: 14))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
            } else {
                // Filtro bloccati: rimozione immediata come nel feed (Guideline 1.2).
                let visibleComments = viewModel.comments.filter { session.blockedUserIDs.contains($0.uid) == false }
                ForEach(Array(visibleComments.enumerated()), id: \.element.id) { index, comment in
                    commentRow(comment, isFirst: index == 0)
                }
            }
        }
    }

    /// Commento in stile board: avatar compatto, nome e ora sulla stessa riga,
    /// testo senza riquadro, azioni piccole. Prima ogni commento era una
    /// `GlassCard` con padding pieno — in uno schermo ne entravano tre.
    /// Le risposte rientrano con una barra verticale invece di una card annidata.
    private func commentRow(_ comment: PostComment, isFirst: Bool) -> some View {
        VStack(spacing: 0) {
            if !isFirst {
                Divider()
                    .overlay(TwoWatchTheme.border.opacity(0.6))
                    .padding(.leading, comment.isReply ? 68 : 56)
            }

            HStack(alignment: .top, spacing: 0) {
                if comment.isReply {
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                        .fill(TwoWatchTheme.border)
                        .frame(width: 2)
                        .padding(.leading, 20)
                        .padding(.trailing, 10)
                        .padding(.vertical, 10)
                }

                HStack(alignment: .top, spacing: 10) {
                    NavigationLink {
                        UserProfileDetailView(container: container, session: session, shell: shell, userID: comment.uid)
                    } label: {
                        SomtoAvatar(url: nil, name: comment.authorName, size: 26)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Profilo di \(comment.authorName)")

                    VStack(alignment: .leading, spacing: 5) {
                        if comment.isReply {
                            CommentReplyContextLabel(parentAuthorName: comment.parentAuthorName ?? String(localized: "un commento"))
                        }

                        HStack(spacing: 6) {
                            NavigationLink {
                                UserProfileDetailView(container: container, session: session, shell: shell, userID: comment.uid)
                            } label: {
                                Text(comment.authorName)
                                    .font(.system(size: 13, weight: .heavy))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.plain)

                            if let createdAt = comment.createdAt {
                                Text(createdAt.formatted(.relative(presentation: .numeric, unitsStyle: .narrow)))
                                    .font(.system(size: 11))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                            }

                            Spacer(minLength: 0)

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
                                    "source": "ios_post_detail"
                                ]
                            )
                        }

                        SpoilerGate(
                            containsSpoiler: comment.containsSpoiler,
                            spoilerTitleIDs: comment.spoilerTitleIds,
                            viewerCompletedTitleIDs: session.completedTitleIDs,
                            titleNames: [:],
                            onMarkSeen: { titleID in await markCompleted(titleID) }
                        ) {
                            ExpandableTaggedTextView(
                                source: comment.text,
                                font: .system(size: 15),
                                textColor: TwoWatchTheme.textPrimary,
                                collapsedLineLimit: 6,
                                expansionThreshold: 240,
                                container: container,
                                session: session,
                                shell: shell
                            )
                        }

                        HStack(spacing: 16) {
                            Button {
                                if session.isAuthenticated {
                                    Task { await viewModel.toggleCommentLike(commentID: comment.id, userID: session.firebaseUser?.uid) }
                                } else {
                                    shell.presentAuth()
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    if viewModel.likingCommentIDs.contains(comment.id) {
                                        ProgressView()
                                            .controlSize(.small)
                                    } else {
                                        Image(systemName: comment.likedByMe ? "heart.fill" : "heart")
                                            .font(.system(size: 11, weight: .semibold))
                                    }
                                    if comment.likes > 0 {
                                        Text("\(comment.likes)")
                                            .font(.system(size: 11, weight: .bold))
                                            .monospacedDigit()
                                    }
                                }
                                .foregroundStyle(comment.likedByMe ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textMuted)
                            }
                            .buttonStyle(.plain)
                            .disabled(viewModel.likingCommentIDs.contains(comment.id))
                            .accessibilityLabel(
                                comment.likedByMe
                                    ? "Ti piace, \(comment.likes) like"
                                    : "\(comment.likes) like, tocca per mettere like"
                            )

                            Button {
                                startReply(to: comment)
                            } label: {
                                Text("Rispondi")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                            }
                            .buttonStyle(.plain)

                            Spacer(minLength: 0)
                        }
                        .padding(.top, 1)
                    }
                }
                .padding(.leading, comment.isReply ? 0 : 20)
                .padding(.trailing, 20)
                .padding(.vertical, 10)
            }
        }
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
        @Bindable var viewModel = viewModel

        ZStack {
            TwoWatchBackground()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    headerBar

                    if viewModel.isLoading, viewModel.post == nil, viewModel.comments.isEmpty {
                        ThreadSheetCard {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 28)
                        }
                    } else {
                        if let post = viewModel.post {
                            postSummaryCard(post)
                        }

                        commentsHeader

                        if viewModel.comments.isEmpty {
                            EmptyStateView(
                                title: "Ancora nessun commento",
                                message: "Apri tu la conversazione: il primo commento comparirà qui.",
                                systemImage: "text.bubble"
                            )
                        } else {
                            ForEach(viewModel.comments.filter { session.blockedUserIDs.contains($0.uid) == false }) { comment in
                                commentRow(comment)
                                    .padding(.leading, comment.isReply ? 22 : 0)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, session.isAuthenticated ? 188 : 132)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .simultaneousGesture(TapGesture().onEnded {
            dismissKeyboard()
        })
        .safeAreaInset(edge: .bottom) {
            composerDock
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

    private var headerBar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text("Commenti")
                    .font(.title2.weight(.black))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Leggi e rispondi senza uscire dal feed")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            Spacer()

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .frame(width: 38, height: 38)
                    .background(TwoWatchTheme.panel, in: Circle())
            }
            .buttonStyle(.plain)
        }
    }

    private func postSummaryCard(_ post: AppPost) -> some View {
        ThreadSheetCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    NavigationLink {
                        UserProfileDetailView(container: container, session: session, shell: shell, userID: post.author.id)
                    } label: {
                        SomtoAvatar(url: post.author.photoURL, name: post.author.displayName, size: 46, showsBorder: true)
                    }
                    .buttonStyle(.plain)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(post.author.displayName)
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text(summaryMetaLine(for: post))
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }

                    Spacer()

                    if let rating = post.rating {
                        HStack(spacing: 5) {
                            Image(systemName: "star.fill")
                                .font(.caption.weight(.bold))
                            Text(formattedRating(rating))
                                .font(.caption.weight(.bold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(TwoWatchTheme.brandPrimary, in: Capsule())
                    }
                }

                if let textSource = post.primarySourceText, !textSource.isEmpty {
                    ExpandableTaggedTextView(
                        source: textSource,
                        font: .body,
                        textColor: TwoWatchTheme.textPrimary,
                        collapsedLineLimit: 6,
                        expansionThreshold: 240,
                        container: container,
                        session: session,
                        shell: shell
                    )
                }

                if post.taggedTitles.count > 1 {
                    taggedTitleStrip(post.taggedTitles)
                } else if let title = displayedTitle(for: post) {
                    // Come nel dettaglio post: il bottone sta accanto al link,
                    // non dentro, se no il tap aprirebbe sempre la scheda.
                    HStack(spacing: SomtoSpacing.ml) {
                        NavigationLink {
                            TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                        } label: {
                            HStack(spacing: 12) {
                                PosterImageView(url: title.posterPath, width: 56, height: 82, cornerRadius: 16)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(title.name)
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                        .lineLimit(2)
                                    Text(title.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                }
                                Spacer()
                            }
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
                }
            }
        }
    }

    private func taggedTitleStrip(_ titles: [Title]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(titles.prefix(6))) { title in
                    NavigationLink {
                        TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                    } label: {
                        PosterImageView(url: title.posterPath, width: 52, height: 76, cornerRadius: 14)
                    }
                    .buttonStyle(.plain)
                }

                if titles.count > 6 {
                    Text("+\(titles.count - 6)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(width: 52, height: 76)
                        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
        }
    }

    private var commentsHeader: some View {
        HStack {
            Text("Discussione")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Spacer()
            Text("\(max(viewModel.counts.comments, viewModel.comments.count)) commenti")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
    }

    private var composerDock: some View {
        @Bindable var commentComposer = commentComposer
        let editorMaxHeight: CGFloat = 120
        let clampedComposerHeight = min(editorMaxHeight, max(22, commentComposer.editorHeight))

        return VStack(alignment: .leading, spacing: 10) {
            if session.isAuthenticated {
                if let replyTarget {
                    ReplyingToBanner(authorName: replyTarget.authorName) {
                        self.replyTarget = nil
                        commentComposer.reset()
                    }
                }

                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(TwoWatchTheme.panel)

                    if commentComposer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("Scrivi un commento... usa @ e #")
                            .font(.body)
                            .foregroundStyle(TwoWatchTheme.textMuted)
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
                        keyboardAppearance: .dark,
                        minHeight: 22,
                        maxHeight: 72,
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
                    .padding(.vertical, 7)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                .frame(minHeight: 38, maxHeight: 74, alignment: .bottom)

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

                HStack(spacing: 10) {
                    Text("\(commentComposer.text.count)/\(commentComposer.characterLimit)")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)

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
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 12)
        .background(
            LinearGradient(
                colors: [
                    TwoWatchTheme.backgroundSecondary.opacity(0.86),
                    TwoWatchTheme.background.opacity(0.98)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
        )
        .overlay(alignment: .top) {
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    private func commentRow(_ comment: PostComment) -> some View {
        ThreadSheetCard {
            VStack(alignment: .leading, spacing: 10) {
                if comment.isReply {
                    CommentReplyContextLabel(parentAuthorName: comment.parentAuthorName ?? String(localized: "un commento"))
                }

                HStack {
                    NavigationLink {
                        UserProfileDetailView(container: container, session: session, shell: shell, userID: comment.uid)
                    } label: {
                        Text(comment.authorName)
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .buttonStyle(.plain)

                    Spacer()

                    if let createdAt = comment.createdAt {
                        Text(createdAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
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
                            "postId": postID,
                            "preview": String(comment.text.prefix(160)),
                            "source": "ios_comments_sheet"
                        ]
                    )
                }

                SpoilerGate(
                    containsSpoiler: comment.containsSpoiler,
                    spoilerTitleIDs: comment.spoilerTitleIds,
                    viewerCompletedTitleIDs: session.completedTitleIDs,
                    titleNames: [:],
                    onMarkSeen: { titleID in
                        guard let uid = session.firebaseUser?.uid,
                              let repo = container.watchlistRepository as WatchlistRepository?
                        else { return }
                        do {
                            _ = try await repo.markTitleCompletedByID(userID: uid, titleID: titleID)
                            session.markTitleCompletedLocally(titleID)
                        } catch { /* silent */ }
                    }
                ) {
                    ExpandableTaggedTextView(
                        source: comment.text,
                        font: .subheadline,
                        textColor: TwoWatchTheme.textPrimary,
                        collapsedLineLimit: 5,
                        expansionThreshold: 180,
                        container: container,
                        session: session,
                        shell: shell
                    )
                }

                HStack(spacing: 16) {
                    Text("\(comment.likes) like")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    Spacer()
                    Button {
                        startReply(to: comment)
                    } label: {
                        Label("Rispondi", systemImage: "arrowshape.turn.up.left")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                    .buttonStyle(.plain)
                    Button {
                        if session.isAuthenticated {
                            Task {
                                await viewModel.toggleCommentLike(
                                    commentID: comment.id,
                                    userID: session.firebaseUser?.uid
                                )
                            }
                        } else {
                            shell.presentAuth()
                        }
                    } label: {
                        if viewModel.likingCommentIDs.contains(comment.id) {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Label(comment.likedByMe ? "Ti piace" : "Like", systemImage: comment.likedByMe ? "heart.fill" : "heart")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(comment.likedByMe ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.likingCommentIDs.contains(comment.id))
                }
            }
        }
    }

    private func displayedTitle(for post: AppPost) -> Title? {
        post.taggedTitles.first ?? post.title
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
            shell.invalidateSocialSurfaces()
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

private struct ThreadSheetCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(TwoWatchTheme.backgroundSecondary.opacity(0.9))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.28), radius: 18, y: 10)
    }
}

private struct ExpandableTaggedTextView: View {
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

