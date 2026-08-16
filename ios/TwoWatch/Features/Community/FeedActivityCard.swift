import SwiftUI

// Card di attivita' del feed e la logica che accorpa piu' eventi vicini in
// una card sola. Estratte da CommunityView.swift.

struct FeedActivityCard: View {
    let activity: FeedActivity
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let allowsLiveSocialLoad: Bool

    @State private var counts = PostSocialCounts(likes: 0, comments: 0, shares: 0)
    @State private var isLikedByMe = false
    @State private var isCommentsExpanded = false
    @State private var navigationTarget: FeedActivityCardDestination?
    @Environment(\.openURL) private var openURL

    private var socialPostID: String? {
        activity.resolvedPostID
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if let primaryTextSource, !primaryTextSource.isEmpty {
                // I post ufficiali non si collassano: dietro "Altro" ci sarebbe
                // il contenuto vero (elenco dei titoli, domanda, link).
                ExpandableTextBlock(
                    isExpandable: !isOfficialUpdate
                        && ExpandableTextHeuristics.needsExpansion(for: primaryTextSource, threshold: 220),
                    collapsedLineLimit: 5
                ) { lineLimit in
                    InteractiveTaggedText(
                        source: primaryTextSource,
                        font: .subheadline,
                        textColor: TwoWatchTheme.textPrimary,
                        lineLimit: lineLimit,
                        container: container,
                        session: session,
                        shell: shell
                    )
                }
            } else if let primaryText, !primaryText.isEmpty {
                ExpandableTextBlock(
                    isExpandable: !isOfficialUpdate
                        && ExpandableTextHeuristics.needsExpansion(for: primaryText, threshold: 220),
                    collapsedLineLimit: 5
                ) { lineLimit in
                    Text(primaryText)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(lineLimit)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            mediaSection

            HStack(alignment: .center, spacing: 12) {
                socialBar

                Spacer(minLength: 8)

                if taggedTitles.count > 1 {
                    Text("\(taggedTitles.count) titoli taggati")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                } else if let linkedTitle = linkedTitle {
                    // La campanella sta a SINISTRA del titolo: il nome resta
                    // allineato al bordo destro della card, dov'era.
                    HStack(spacing: SomtoSpacing.m) {
                        TitleFollowButton(
                            titleID: linkedTitle.id,
                            store: container.titleFollowStore,
                            userID: session.firebaseUser?.uid,
                            onRequestAuth: shell.presentAuth
                        )

                        Button {
                            navigationTarget = .title(id: linkedTitle.id)
                        } label: {
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(linkedTitle.name)
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                    .multilineTextAlignment(.trailing)
                                    .lineLimit(2)
                                Text(linkedTitle.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                            }
                        }
                        .buttonStyle(.plain)
                        .contentShape(Rectangle())
                    }
                }
            }

            if let postID = socialPostID, isCommentsExpanded {
                FeedCommentsPanel(
                    container: container,
                    session: session,
                    shell: shell,
                    postID: postID
                ) { updatedCounts in
                    counts = updatedCounts
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 15)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .task(id: socialTaskID) {
            guard allowsLiveSocialLoad, let postID = socialPostID else {
                counts = emptyCounts
                isLikedByMe = false
                return
            }
            await loadSocial(postID: postID)
        }
        .navigationDestination(item: $navigationTarget) { target in
            switch target {
            case let .title(id):
                TitleDetailView(container: container, session: session, shell: shell, titleID: id)
            case let .profile(uid):
                UserProfileDetailView(container: container, session: session, shell: shell, userID: uid)
            }
        }
    }

    private var header: some View {
        // Mirror `.feed-item-header` (home.css): gap 0.6rem (~10pt), avatar
        // 2.4rem (38pt, invariato). Il badge "Ufficiale" vive sulla line1
        // (accanto al nome), non sulla line2 con la data — come su web
        // (`officialUpdateBadgeHtml()` appeso dentro `.line1`).
        HStack(alignment: .center, spacing: 10) {
            NavigationLink {
                UserProfileDetailView(container: container, session: session, shell: shell, userID: activity.actor.id)
            } label: {
                SomtoAvatar(url: activity.actor.photoURL, name: activity.actor.displayName, size: 38)
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(headlineAttributedText)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .environment(\.openURL, OpenURLAction { url in
                            handleOpenURL(url)
                        })
                    if isOfficialUpdate {
                        OfficialUpdateBadge()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Text(metaLine)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            if !isOfficialUpdate {
                ContentModerationMenu(
                    container: container,
                    session: session,
                    authorUID: activity.actor.id,
                    authorName: activity.actor.displayName,
                    reportType: "post",
                    reportTargetID: socialPostID ?? activity.sourceId ?? activity.id,
                    reportReason: "Post segnalato per contenuto o comportamento inappropriato.",
                    reportMetadata: [
                        "postId": socialPostID ?? "",
                        "preview": String((activity.primaryText ?? "").prefix(160)),
                        "source": "ios_feed"
                    ]
                )
            }
        }
    }

    // Mirror `.feed-media-rating` (home.css): capsule brand-primary
    // sovrapposta in alto a destra sul poster/foto, NON più nel header.
    private func mediaRatingBadge(_ rating: Double) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "star.fill")
                .font(.system(size: 11, weight: .bold))
                .accessibilityHidden(true)
            Text(formattedRating(rating))
                .font(.system(size: 12, weight: .bold))
                .monospacedDigit()
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(TwoWatchTheme.brandPrimary, in: Capsule())
        .accessibilityLabel("Voto: \(formattedRating(rating))")
    }

    @ViewBuilder
    private var mediaSection: some View {
        let titles = taggedTitles
        // Un media caricato sul post (copertina editoriale, foto di chi scrive)
        // vince sul collage delle locandine: il collage e' il fallback grafico
        // per i post che un'immagine propria non ce l'hanno.
        if !activity.mediaURLs.isEmpty {
            SocialMediaCarouselView(
                urls: activity.mediaURLs,
                height: 420,
                cornerRadius: 20,
                contentMode: .fit,
                tapActionForIndex: nil
            )
        } else if titles.count > 1 {
            MultiTitleCollageView(titles: titles) { title in
                TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
            }
        } else if !mediaGalleryURLs.isEmpty {
            ZStack(alignment: .topTrailing) {
                SocialMediaCarouselView(
                    urls: mediaGalleryURLs,
                    height: 420,
                    cornerRadius: 20,
                    tapActionForIndex: linkedTitle.map { title in
                        { index in
                            guard index == 0 else { return }
                            navigationTarget = .title(id: title.id)
                        }
                    }
                )

                if let rating = activity.rating {
                    mediaRatingBadge(rating)
                        .padding(10)
                }
            }
        } else if let rating = activity.rating {
            // Voto senza poster/foto da sovrapporre: il web mette il badge sul
            // media, qui non c'è → mostralo inline per non perdere il voto.
            HStack {
                mediaRatingBadge(rating)
                Spacer(minLength: 0)
            }
        }
    }

    private var socialBar: some View {
        HStack(spacing: 16) {
            if let postID = socialPostID {
                Button {
                    Task { await toggleLike(postID: postID) }
                } label: {
                    socialIconLabel(
                        systemName: isLikedByMe ? "heart.fill" : "heart",
                        value: counts.likes,
                        tint: isLikedByMe ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary,
                        isActive: isLikedByMe
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isLikedByMe ? "Rimuovi Mi piace" : "Aggiungi Mi piace")
                .accessibilityValue("\(counts.likes) Mi piace")

                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isCommentsExpanded.toggle()
                    }
                } label: {
                    socialIconLabel(
                        systemName: isCommentsExpanded ? "bubble.right.fill" : "bubble.right",
                        value: counts.comments,
                        tint: isCommentsExpanded ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary,
                        isActive: isCommentsExpanded
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isCommentsExpanded ? "Nascondi commenti" : "Mostra commenti")
                .accessibilityValue("\(counts.comments) commenti")

                shareButton(postID: postID)
            } else if let webURL = activity.webURL {
                Button {
                    openURL(webURL)
                } label: {
                    socialIconLabel(systemName: "square.and.arrow.up", value: counts.shares, tint: TwoWatchTheme.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Condividi")
            }
        }
    }

    private var primaryText: String? {
        if let primary = activity.primaryText, !primary.isEmpty {
            return primary
        }
        if activity.kind == .follow, let relatedUser = activity.relatedUser {
            return "Ha iniziato a seguire \(relatedUser.displayName)."
        }
        return nil
    }

    private var primaryTextSource: String? {
        activity.primarySourceText
    }

    private var linkedTitle: Title? {
        if taggedTitles.count > 1 {
            return nil
        }
        return taggedTitles.first ?? activity.title
    }

    private var mediaGalleryURLs: [URL] {
        var urls: [URL] = []
        var seen: Set<String> = []

        if let titleMedia = linkedTitle?.posterPath ?? linkedTitle?.backdropPath {
            let key = titleMedia.absoluteString
            if seen.insert(key).inserted {
                urls.append(titleMedia)
            }
        }

        for url in activity.mediaURLs {
            let key = url.absoluteString
            guard seen.insert(key).inserted else { continue }
            urls.append(url)
        }

        if urls.isEmpty, let fallback = activity.mediaURL {
            return [fallback]
        }

        return urls
    }

    private var taggedTitles: [Title] {
        activity.taggedTitles
    }

    private var isOfficialUpdate: Bool {
        activity.actor.id == "somto_official"
    }

    private var metaLine: String {
        let dateText = activity.createdAt?.formatted(date: .abbreviated, time: .shortened) ?? activity.actionText
        if let watchedWithGroup = activity.watchedWithGroup {
            return "\(dateText) • \(watchedWithGroup.groupName)"
        }
        return dateText
    }

    private var headlineAttributedText: AttributedString {
        var output = linkedSegment(label: activity.actor.displayName, uid: activity.actor.id)

        switch activity.kind {
        case .rating where !headlinePeople.isEmpty, .watchTogether where !headlinePeople.isEmpty:
            output.append(plainSegment(" ha visto con "))
            for (index, person) in headlinePeople.enumerated() {
                if index > 0 {
                    let separator = index == headlinePeople.count - 1 ? " e " : ", "
                    output.append(plainSegment(separator))
                }
                output.append(linkedSegment(label: person.displayName, uid: person.id))
            }
            if hasHiddenHeadlinePeople {
                output.append(plainSegment(" e altri"))
            }
            output.append(plainSegment("."))
        case .follow:
            output.append(plainSegment(" ha iniziato a seguire "))
            if let relatedUser = activity.relatedUser {
                output.append(linkedSegment(label: relatedUser.displayName, uid: relatedUser.id))
            } else {
                output.append(plainSegment(String(localized: "un profilo")))
            }
            output.append(plainSegment("."))
        case .post where isOfficialUpdate:
            output.append(plainSegment(String(localized: " ha pubblicato un aggiornamento ufficiale.")))
        default:
            output.append(plainSegment(" \(activity.actionText)."))
        }

        return output
    }

    private var headlinePeople: [FeedTaggedUser] {
        let people = activity.watchedWith
        if people.count <= 2 {
            return people
        }
        return Array(people.prefix(1))
    }

    private var hasHiddenHeadlinePeople: Bool {
        activity.watchedWith.count > headlinePeople.count
    }

    private func linkedSegment(label: String, uid: String) -> AttributedString {
        var segment = AttributedString(label)
        segment.foregroundColor = TwoWatchTheme.brandPrimary
        segment.link = profileLinkURL(uid: uid)
        return segment
    }

    private func plainSegment(_ value: String) -> AttributedString {
        var segment = AttributedString(value)
        segment.foregroundColor = TwoWatchTheme.textPrimary
        return segment
    }

    private func profileLinkURL(uid: String) -> URL? {
        var components = URLComponents()
        components.scheme = "twowatch-home-profile"
        components.host = "user"
        components.queryItems = [URLQueryItem(name: "uid", value: uid)]
        return components.url
    }

    private func handleOpenURL(_ url: URL) -> OpenURLAction.Result {
        guard url.scheme == "twowatch-home-profile" else { return .systemAction }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        guard let uid = components?.queryItems?.first(where: { $0.name == "uid" })?.value,
              !uid.isEmpty
        else {
            return .discarded
        }
        navigationTarget = .profile(uid: uid)
        return .handled
    }

    private var emptyCounts: PostSocialCounts {
        PostSocialCounts(likes: 0, comments: 0, shares: 0)
    }

    private var socialTaskID: String {
        "\(socialPostID ?? activity.id)-\(shell.socialRefreshToken.uuidString)"
    }

    private func loadSocial(postID: String) async {
        do {
            let viewerUID = session.firebaseUser?.uid
            async let countsTask = container.postsRepository.fetchSocialCounts(postID: postID)
            async let likedTask = viewerUID == nil ? false : container.postsRepository.isLikedByMe(postID: postID, uid: viewerUID ?? "")
            counts = try await countsTask
            isLikedByMe = try await likedTask
        } catch {
            counts = emptyCounts
            isLikedByMe = false
        }
    }

    private func toggleLike(postID: String) async {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }

        let previousLiked = isLikedByMe
        let previousCounts = counts
        let optimisticLiked = !previousLiked
        let optimisticLikes = max(0, previousCounts.likes + (optimisticLiked ? 1 : -1))

        let feedback = UIImpactFeedbackGenerator(style: optimisticLiked ? .medium : .soft)
        feedback.prepare()
        feedback.impactOccurred()

        withAnimation(.spring(response: 0.32, dampingFraction: 0.55)) {
            isLikedByMe = optimisticLiked
            counts = PostSocialCounts(
                likes: optimisticLikes,
                comments: previousCounts.comments,
                shares: previousCounts.shares
            )
        }

        do {
            let confirmed = try await container.postsRepository.toggleLike(postID: postID, uid: uid)
            let updatedCounts = try await container.postsRepository.fetchSocialCounts(postID: postID)
            withAnimation(.easeOut(duration: 0.18)) {
                isLikedByMe = confirmed
                counts = updatedCounts
            }
        } catch {
            // Rollback to previous state on failure (less jarring than zeroing out).
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            withAnimation(.easeOut(duration: 0.18)) {
                isLikedByMe = previousLiked
                counts = previousCounts
            }
        }
    }

    @ViewBuilder
    private func shareButton(postID: String) -> some View {
        if let shareURL = activity.webURL ?? linkedTitle?.shareURL ?? defaultPostShareURL(postID: postID) {
            ShareLink(item: shareURL) {
                socialIconLabel(systemName: "paperplane", value: counts.shares, tint: TwoWatchTheme.textSecondary)
            }
        }
    }

    private func defaultPostShareURL(postID: String) -> URL? {
        URL(string: "https://somto.it/?post=\(postID)")
    }

    private func socialIconLabel(systemName: String, value: Int, tint: Color, isActive: Bool = false) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemName)
                .font(.headline)
                .scaleEffect(isActive ? 1.1 : 1.0)
                .animation(.spring(response: 0.32, dampingFraction: 0.55), value: isActive)
            Text("\(value)")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .contentTransition(.numericText(value: Double(value)))
                .animation(.snappy(duration: 0.18), value: value)
        }
        .foregroundStyle(tint)
        .frame(minHeight: 44, alignment: .center)
        .contentShape(Rectangle())
    }

    private func formattedRating(_ value: Double) -> String {
        RatingDisplayFormatter.social(value)
    }
}

enum FeedActivityCollapser {
    private struct Group {
        var items: [FeedActivity]
    }

    static func collapse(_ activities: [FeedActivity]) -> [FeedActivity] {
        let sorted = activities.sorted(by: sortByRecency)
        var groups: [Group] = []
        var groupedIndexes: [String: Int] = [:]

        for activity in sorted {
            guard let key = collapseKey(for: activity) else {
                groups.append(Group(items: [activity]))
                continue
            }

            if let index = groupedIndexes[key] {
                groups[index].items.append(activity)
            } else {
                groupedIndexes[key] = groups.count
                groups.append(Group(items: [activity]))
            }
        }

        return groups.compactMap { merge($0.items) }
    }

    private static func merge(_ items: [FeedActivity]) -> FeedActivity? {
        let sorted = items.sorted(by: sortByRecency)
        // Niente fatalError in produzione: un gruppo vuoto (non dovrebbe mai capitare,
        // ma meglio degradare che crashare) viene semplicemente saltato dal compactMap.
        guard let latest = sorted.first else {
            return nil
        }
        guard sorted.count > 1 else { return latest }

        let base = preferredRepresentative(in: sorted)
        let mergedWatchedWith = mergeWatchedWith(sorted)
        let mergedTaggedTitles = mergeTaggedTitles(sorted)
        let mergedMediaURLs = mergeMediaURLs(sorted)
        let latestRating = sorted.compactMap(\.rating).first

        return FeedActivity(
            id: latest.id,
            kind: !mergedWatchedWith.isEmpty ? .watchTogether : base.kind,
            actor: base.actor,
            relatedUser: latest.relatedUser ?? base.relatedUser,
            title: sorted.compactMap(\.title).first,
            titleId: latest.titleId ?? base.titleId,
            postId: latest.resolvedPostID ?? base.resolvedPostID,
            recommendationId: latest.recommendationId ?? base.recommendationId,
            sourceId: latest.sourceId ?? base.sourceId,
            sourcePath: latest.sourcePath ?? base.sourcePath,
            rating: latestRating,
            previousRating: latest.previousRating,
            level: base.level,
            season: base.season,
            episode: base.episode,
            text: firstNonEmptyText(in: sorted, keyPath: \.text),
            snippet: firstNonEmptyText(in: sorted, keyPath: \.snippet),
            reviewText: firstNonEmptyText(in: sorted, keyPath: \.reviewText),
            taggedTitles: mergedTaggedTitles,
            mediaURL: mergedMediaURLs.first,
            mediaURLs: mergedMediaURLs,
            watchedWith: mergedWatchedWith,
            watchedWithGroup: sorted.compactMap(\.watchedWithGroup).first,
            sharedPost: sorted.compactMap(\.sharedPost).first,
            createdAt: latest.createdAt ?? base.createdAt,
            webURL: latest.webURL ?? base.webURL
        )
    }

    private static func collapseKey(for activity: FeedActivity) -> String? {
        switch activity.kind {
        case .rating, .watchTogether:
            if let sourceId = activity.sourceId, !sourceId.isEmpty {
                return "rating-source:\(sourceId)"
            }
            if let postId = activity.resolvedPostID, !postId.isEmpty {
                return "rating-post:\(postId)"
            }
            if let titleId = activity.titleId, !titleId.isEmpty {
                return "rating-title:\(activity.actor.id)::\(titleId)::\(activity.level)::\(activity.season ?? 0)::\(activity.episode ?? 0)"
            }
            return nil
        case .post, .postShare:
            if let sourceId = activity.sourceId, !sourceId.isEmpty {
                return "\(activity.kind.rawValue):\(sourceId)"
            }
            if let postId = activity.resolvedPostID, !postId.isEmpty {
                return "\(activity.kind.rawValue):\(postId)"
            }
            return nil
        case .postComment:
            if let sourceId = activity.sourceId, !sourceId.isEmpty {
                return "post-comment:\(sourceId)"
            }
            return nil
        case .recommendation:
            if let recommendationId = activity.recommendationId, !recommendationId.isEmpty {
                return "recommendation:\(recommendationId)"
            }
            return nil
        case .seriesStarted:
            if let titleId = activity.titleId, !titleId.isEmpty {
                return "series-started:\(activity.actor.id)::\(titleId)"
            }
            return nil
        case .follow:
            return nil
        case .titleComment:
            // Ogni commento e' un contenuto a se': niente collasso.
            return nil
        }
    }

    private static func preferredRepresentative(in items: [FeedActivity]) -> FeedActivity {
        if let sourceMatch = items.first(where: isSourceActorActivity) {
            return sourceMatch
        }
        if let ratingItem = items.first(where: { $0.kind == .rating }) {
            return ratingItem
        }
        return items[0]
    }

    private static func isSourceActorActivity(_ activity: FeedActivity) -> Bool {
        guard let postId = activity.resolvedPostID, postId.hasPrefix("rating::") else { return false }
        let parts = postId.components(separatedBy: "::")
        guard parts.count >= 3 else { return false }
        return parts[1] == activity.actor.id
    }

    private static func firstNonEmptyText(
        in items: [FeedActivity],
        keyPath: KeyPath<FeedActivity, String?>
    ) -> String? {
        items.lazy
            .compactMap { $0[keyPath: keyPath]?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
    }

    private static func mergeWatchedWith(_ items: [FeedActivity]) -> [FeedTaggedUser] {
        var merged: [FeedTaggedUser] = []
        var seen: Set<String> = []

        for item in items {
            for person in item.watchedWith where seen.insert(person.id).inserted {
                merged.append(person)
            }
        }

        return merged
    }

    private static func mergeTaggedTitles(_ items: [FeedActivity]) -> [Title] {
        var merged: [Title] = []
        var seen: Set<String> = []

        for item in items {
            for title in item.taggedTitles where seen.insert(title.id).inserted {
                merged.append(title)
            }
            if let title = item.title, seen.insert(title.id).inserted {
                merged.append(title)
            }
        }

        return merged
    }

    private static func mergeMediaURLs(_ items: [FeedActivity]) -> [URL] {
        var merged: [URL] = []
        var seen: Set<String> = []

        for item in items {
            for url in item.mediaURLs where seen.insert(url.absoluteString).inserted {
                merged.append(url)
            }
        }

        if merged.isEmpty,
           let fallback = items.compactMap(\.mediaURL).first {
            return [fallback]
        }

        return Array(merged.prefix(2))
    }

    private static func sortByRecency(lhs: FeedActivity, rhs: FeedActivity) -> Bool {
        let leftDate = lhs.createdAt ?? .distantPast
        let rightDate = rhs.createdAt ?? .distantPast
        if leftDate != rightDate {
            return leftDate > rightDate
        }
        return lhs.id > rhs.id
    }
}
