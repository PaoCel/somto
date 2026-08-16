@preconcurrency import FirebaseFirestore
import Observation
import SwiftUI

// Stato e logica del feed Community, estratti da CommunityView.swift.

@Observable
@MainActor
final class CommunityViewModel {
    private let homeRepository: HomeRepository
    private let postsRepository: PostsRepository
    private let threadsRepository: ThreadsRepository
    private let watchlistRepository: WatchlistRepository
    @ObservationIgnored private var followCursor: DocumentSnapshot?
    @ObservationIgnored private var followEvents: [FeedActivity] = []
    @ObservationIgnored private var publicPosts: [CommunityFeedRanking.ScoredPublicPost] = []
    @ObservationIgnored private var loadedKey: String?
    /// Agganci alla libreria dell'utente (titolo → "sto guardando" / "visto da
    /// poco"), calcolati una volta per sessione. `nil` finché non calcolati.
    @ObservationIgnored private var cachedLibrarySignals: [String: CommunityDiscussionsRanking.LibrarySignal]?
    @ObservationIgnored private var librarySignalsKey: String?
    /// Commenti (post-eco dei thread pubblici) gia' pesati, pronti per il mix.
    @ObservationIgnored private var comments: [CommunityFeedRanking.ScoredComment] = []

    /// Progresso del viewer sui titoli presenti nel feed, per il gate
    /// anti-spoiler: `titleId -> stato`. Vuoto per i guest (niente libreria →
    /// tutti i commenti restano coperti).
    var progressByTitleID: [String: SpoilerProgressRule.Entry] = [:]

    var feed: [FeedActivity] = []
    /// "Discussioni per te": poche discussioni agganciate a ciò che l'utente ha
    /// visto o sta guardando, ognuna col suo motivo.
    var discussions: [CommunityDiscussionsRanking.Suggestion] = []
    /// True quando l'utente ha una libreria ma nessuna discussione pertinente:
    /// serve a distinguere "non hai ancora titoli" da "nessuno ne parla ancora".
    var hasLibrarySignals = false
    var isLoading = false
    var isLoadingMore = false
    var canLoadMore = false
    var errorMessage: String?

    init(
        homeRepository: HomeRepository,
        postsRepository: PostsRepository,
        threadsRepository: ThreadsRepository,
        watchlistRepository: WatchlistRepository
    ) {
        self.homeRepository = homeRepository
        self.postsRepository = postsRepository
        self.threadsRepository = threadsRepository
        self.watchlistRepository = watchlistRepository
    }

    func load(userID: String?) async {
        let key = userID ?? "guest"
        guard loadedKey != key else { return }
        await reload(userID: userID)
    }

    func reload(userID: String?) async {
        loadedKey = userID ?? "guest"
        followCursor = nil
        followEvents = []
        publicPosts = []
        canLoadMore = false
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            // I post pubblici e i thread pubblici sono globali (leggibili anche
            // da guest). Il grafo follow richiede una sessione.
            async let publicTask = postsRepository.listPublicPostsPage(pageSize: CommunityFeedRanking.candidateCap)
            async let threadsTask = threadsRepository.listPublicThreadsPage(pageSize: 40)
            async let recentCommentsTask = postsRepository.listCommentActivities(pageSize: 24)

            if let userID {
                async let followTask = homeRepository.fetchFeed(userID: userID)
                let (publicPage, threadsPage, followPage, recentComments) = try await (publicTask, threadsTask, followTask, recentCommentsTask)
                followEvents = collapsedFeed(followPage.items)
                followCursor = followPage.nextCursor
                canLoadMore = followPage.hasMore
                publicPosts = scoredPublicPosts(from: publicPage.items)
                await rankDiscussions(recentThreads: threadsPage.items, userID: userID)
                await loadComments(recent: recentComments, userID: userID)
            } else {
                let (publicPage, _, recentComments) = try await (publicTask, threadsTask, recentCommentsTask)
                followEvents = []
                followCursor = nil
                canLoadMore = false
                publicPosts = scoredPublicPosts(from: publicPage.items)
                // Un guest non ha libreria: niente suggerimenti personali.
                await rankDiscussions(recentThreads: [], userID: nil)
                await loadComments(recent: recentComments, userID: nil)
            }

            rebuildFeed()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func loadMore(userID: String) async {
        guard !isLoadingMore, canLoadMore, let cursor = followCursor else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }

        do {
            let page = try await homeRepository.fetchFeed(userID: userID, after: cursor)
            followEvents = collapsedFeed(followEvents + page.items)
            followCursor = page.nextCursor
            canLoadMore = page.hasMore
            rebuildFeed()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    private func rebuildFeed() {
        feed = CommunityFeedRanking.blendRankedFeed(
            followEvents: followEvents,
            publicPosts: publicPosts,
            comments: comments
        )
    }

    /// Commenti nel feed: quelli piu' recenti di tutta la community + quelli
    /// sui titoli della tua libreria a qualunque eta' (e' cosi' che emerge lo
    /// storico, che per data non uscirebbe mai). Poi carica il progresso sui
    /// titoli coinvolti, che serve al gate anti-spoiler PRIMA di disegnare.
    private func loadComments(recent: [FeedActivity], userID: String?) async {
        var byID: [String: FeedActivity] = [:]
        for activity in recent { byID[activity.id] = activity }

        var libraryTitleIDs: Set<String> = []
        if let userID {
            libraryTitleIDs = Set(await librarySignals(userID: userID).keys)
            if !libraryTitleIDs.isEmpty {
                do {
                    let mine = try await postsRepository.listCommentActivitiesByTitleIDs(Array(libraryTitleIDs))
                    for activity in mine { byID[activity.id] = activity }
                } catch {
                    SilentFailure.record(error, context: "Community.libraryCommentActivities")
                }
            }
        }

        comments = byID.values.map { activity in
            CommunityFeedRanking.ScoredComment(
                activity: activity,
                inLibrary: activity.titleId.map { libraryTitleIDs.contains($0) } ?? false
            )
        }

        await loadProgress(for: Array(byID.values), userID: userID)
    }

    /// Letture mirate: solo i titleStates dei titoli con un commento a schermo.
    private func loadProgress(for activities: [FeedActivity], userID: String?) async {
        guard let userID else {
            progressByTitleID = [:]
            return
        }
        let titleIDs = Array(Set(activities.compactMap(\.titleId)))
        guard !titleIDs.isEmpty else {
            progressByTitleID = [:]
            return
        }
        var states: [String: TitlePersonalState] = [:]
        do { states = try await watchlistRepository.fetchTitleStates(userID: userID, titleIDs: titleIDs) } catch { SilentFailure.record(error, context: "Community.titleStates") }
        progressByTitleID = states.mapValues { SpoilerProgressRule.Entry(state: $0) }
    }

    /// Costruisce "Discussioni per te": poche righe, tutte agganciate a un
    /// titolo che l'utente ha visto o sta guardando, ognuna col suo motivo.
    ///
    /// I candidati NON sono più i thread pubblici globali: si parte dai
    /// **titoli della libreria** e si chiedono le loro discussioni a qualsiasi
    /// età (`listPublicThreadsByTitleIDs`). Così emergono anche i thread nati
    /// dall'import dei commenti-episodio TV Time (che hanno `lastMessageAt` di
    /// anni fa) e soprattutto non entra più nulla di estraneo.
    /// La lista dei thread recenti resta come sorgente secondaria, ma passa
    /// per lo stesso filtro: se il titolo non è in libreria, non si mostra.
    private func rankDiscussions(recentThreads: [AppThread], userID: String?) async {
        guard let userID else {
            discussions = []
            hasLibrarySignals = false
            return
        }

        let signals = await librarySignals(userID: userID)
        hasLibrarySignals = !signals.isEmpty
        guard !signals.isEmpty else {
            discussions = []
            return
        }

        var candidates: [AppThread] = []
        do { candidates = try await threadsRepository.listPublicThreadsByTitleIDs(Array(signals.keys)) } catch { SilentFailure.record(error, context: "Community.publicThreadsForLibrary") }
        var seen = Set(candidates.map(\.id))
        for thread in recentThreads where !seen.contains(thread.id) {
            candidates.append(thread)
            seen.insert(thread.id)
        }

        // "Chi segui" senza query extra: gli attori degli eventi follow-graph
        // già caricati per il feed. Serve solo a scegliere il motivo, non a
        // far entrare titoli fuori libreria.
        var followedIDs = Set<String>()
        var followedNames: [String: String] = [:]
        for event in followEvents {
            followedIDs.insert(event.actor.id)
            if followedNames[event.actor.id] == nil {
                followedNames[event.actor.id] = event.actor.displayName
            }
        }

        discussions = CommunityDiscussionsRanking.buildSuggestions(
            threads: candidates,
            signals: signals,
            followedUserIDs: followedIDs,
            followedUserNames: followedNames
        )
    }

    /// Calcola (e cachea per sessione) gli agganci alla libreria dell'utente.
    /// Una sola lettura della dashboard watchlist, riusata.
    private func librarySignals(userID: String) async -> [String: CommunityDiscussionsRanking.LibrarySignal] {
        if let cachedLibrarySignals, librarySignalsKey == userID {
            return cachedLibrarySignals
        }

        let signals: [String: CommunityDiscussionsRanking.LibrarySignal]
        do {
            let dashboard = try await watchlistRepository.fetchWatchlistDashboard(userID: userID)
            signals = CommunityDiscussionsRanking.buildSignals(
                inProgress: dashboard.inProgressSeries + dashboard.toResume,
                recentlySeen: dashboard.toRate + dashboard.rewatch
            )
        } catch {
            signals = [:]
        }

        cachedLibrarySignals = signals
        librarySignalsKey = userID
        return signals
    }

    private func scoredPublicPosts(
        from items: [PostsRepository.PublicPost]
    ) -> [CommunityFeedRanking.ScoredPublicPost] {
        items.map { item in
            CommunityFeedRanking.ScoredPublicPost(
                activity: item.post.asPublicFeedActivity(),
                likes: item.counts.likes,
                comments: item.counts.comments
            )
        }
    }

    private func collapsedFeed(_ items: [FeedActivity]) -> [FeedActivity] {
        FeedActivityCollapser.collapse(items)
    }
}
