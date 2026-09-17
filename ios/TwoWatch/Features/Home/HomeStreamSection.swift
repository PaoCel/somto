import SwiftUI

// "Di cosa si parla": la seconda meta' della Home.
//
// PERCHE' — Community come tab a se' aveva 4 autori, 2 commenti e 0 like su 96
// attivi in 30 giorni (misurato il 2026-09-04): la prominenza non produceva
// partecipazione, e la tab si apriva con tre inviti a fare qualcosa prima di
// qualunque contenuto. Qui il feed e' il corpo della Home e le corsie
// personali ("Per te", uscite, novita') sono inserti a posizioni fisse dentro
// il flusso, come le righe di Netflix o i suggeriti di Instagram: ogni
// sessione passa dai post senza doverlo decidere.

/// Un elemento del flusso: un post, oppure una corsia personale inserita.
enum HomeStreamItem: Identifiable, Equatable {
    case post(FeedActivity)
    case forYou
    case discussions
    case upcoming
    case people
    case newForYou

    var id: String {
        switch self {
        case let .post(activity): return "post-\(activity.id)"
        case .forYou: return "for-you"
        case .discussions: return "discussions"
        case .upcoming: return "upcoming"
        case .people: return "people"
        case .newForYou: return "new-for-you"
        }
    }

    var isPost: Bool {
        if case .post = self { return true }
        return false
    }
}

/// Dove entra una corsia: dopo l'N-esimo post.
struct HomeStreamInsert: Equatable {
    let afterPost: Int
    let item: HomeStreamItem
}

enum HomeStreamComposer {
    /// Intreccia post e corsie. Le corsie che non trovano abbastanza post
    /// davanti (feed corto, guest, primo giorno) finiscono in coda nell'ordine
    /// dato: non spariscono mai, al massimo scendono.
    static func compose(posts: [FeedActivity], inserts: [HomeStreamInsert]) -> [HomeStreamItem] {
        var pending = inserts.sorted { $0.afterPost < $1.afterPost }
        var items: [HomeStreamItem] = []
        items.reserveCapacity(posts.count + pending.count)

        for (index, post) in posts.enumerated() {
            items.append(.post(post))
            let seen = index + 1
            while let next = pending.first, next.afterPost <= seen {
                items.append(next.item)
                pending.removeFirst()
            }
        }
        items.append(contentsOf: pending.map(\.item))
        return items
    }
}

/// Riga che apre il composer. Il composer intero (`HomeComposerCard`) e' una
/// card alta: come prima cosa sotto le tue serie sarebbe un muro. Qui e' una
/// riga sola, e si allarga solo quando la tocchi.
struct HomeComposerRow: View {
    let session: SessionStore
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: SomtoSpacing.l) {
                SomtoAvatar(
                    url: session.appUser?.avatarURL,
                    name: session.appUser?.displayName ?? "",
                    size: 36
                )
                Text("A cosa stai pensando?")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                Spacer(minLength: 0)
                Image(systemName: "square.and.pencil")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .padding(.horizontal, SomtoSpacing.xl)
            .padding(.vertical, SomtoSpacing.ml)
            .frame(minHeight: 52)
            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: SomtoRadius.l, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: SomtoRadius.l, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("A cosa stai pensando?")
        .accessibilityHint(Text("Apre il composer per pubblicare un post"))
    }
}

struct HomeStreamSection: View {
    let home: HomeViewModel
    let community: CommunityViewModel
    let people: PeopleToFollowViewModel
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let allowsLiveSocialLoad: Bool
    let onExploreThreads: () -> Void

    /// Guideline 1.2: i contenuti degli utenti bloccati spariscono subito dal
    /// feed del bloccante (cache di sessione, niente refetch).
    private var posts: [FeedActivity] {
        community.feed.filter { session.blockedUserIDs.contains($0.actor.id) == false }
    }

    private var items: [HomeStreamItem] {
        var inserts: [HomeStreamInsert] = []
        if !home.forYou.isEmpty { inserts.append(HomeStreamInsert(afterPost: 2, item: .forYou)) }
        if !community.discussions.isEmpty { inserts.append(HomeStreamInsert(afterPost: 3, item: .discussions)) }
        if !home.upcomingReleases.isEmpty { inserts.append(HomeStreamInsert(afterPost: 5, item: .upcoming)) }
        if !people.people.isEmpty { inserts.append(HomeStreamInsert(afterPost: 6, item: .people)) }
        if !home.newForYou.isEmpty { inserts.append(HomeStreamInsert(afterPost: 9, item: .newForYou)) }
        return HomeStreamComposer.compose(posts: posts, inserts: inserts)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HomeSectionHeader(
                title: String(localized: "Di cosa si parla"),
                subtitle: String(localized: "Uscite, novità e post di chi segui")
            )

            if let errorMessage = community.errorMessage, !community.isLoading {
                HomeErrorBanner(message: errorMessage) {
                    Task { await community.reload(userID: session.firebaseUser?.uid) }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
                .animation(.easeInOut(duration: 0.2), value: community.errorMessage)
            }

            if community.isLoading, posts.isEmpty {
                HomeFeedSkeleton()
                    .padding(.top, 4)
            }

            LazyVStack(spacing: 18) {
                ForEach(items) { item in
                    itemView(item)
                }

                if !community.isLoading, posts.isEmpty {
                    EmptyStateView(
                        title: "Ancora nessuna discussione",
                        message: "Qui trovi i post della community e di chi segui. Pubblica il primo o segui qualcuno per animare il feed.",
                        systemImage: "rectangle.on.rectangle.angled",
                        actionTitle: "Esplora titoli"
                    ) {
                        shell.presentSearch()
                    }
                }

                loadMoreFooter
            }
        }
    }

    @ViewBuilder
    private func itemView(_ item: HomeStreamItem) -> some View {
        switch item {
        case let .post(activity):
            postCard(activity)
                .onAppear {
                    guard allowsLiveSocialLoad,
                          activity.id == posts.last?.id,
                          let userID = session.firebaseUser?.uid
                    else { return }
                    Task { await community.loadMore(userID: userID) }
                }

        case .forYou:
            HomeDiscoveryRow(
                title: String(localized: "Per te"),
                subtitle: String(localized: "In base a quello che guardi, su qualsiasi piattaforma"),
                titles: home.forYou,
                container: container,
                session: session,
                shell: shell
            )

        case .discussions:
            // Una sola discussione, non tre: e' un invito dentro il flusso,
            // non una sezione. "Esplora tutti i thread" resta nella card.
            CommunityDiscussionsSection(
                suggestions: Array(community.discussions.prefix(1)),
                hasLibrarySignals: community.hasLibrarySignals,
                onOpenThread: { threadID in
                    shell.activePresentedSheet = .thread(id: threadID)
                },
                onExploreThreads: onExploreThreads,
                onSearchTitles: { shell.presentSearch() }
            )

        case .upcoming:
            HomeUpcomingReleasesSection(
                releases: home.upcomingReleases,
                container: container,
                session: session,
                shell: shell
            )

        case .people:
            PeopleToFollowSection(
                viewModel: people,
                myUserID: session.firebaseUser?.uid,
                onOpenProfile: { uid in
                    shell.activePresentedDestination = .profile(uid: uid)
                }
            )

        case .newForYou:
            VStack(alignment: .leading, spacing: 10) {
                HomeSectionHeader(
                    title: String(localized: "Novità per te"),
                    subtitle: String(localized: "Nuove stagioni sui titoli che hai già visto")
                )
                LazyVStack(spacing: 12) {
                    ForEach(home.newForYou) { state in
                        WatchlistResumeCard(
                            state: state,
                            container: container,
                            session: session,
                            shell: shell
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func postCard(_ activity: FeedActivity) -> some View {
        if activity.kind == .titleComment {
            CommunityCommentCard(
                activity: activity,
                progressEntry: activity.titleId.flatMap { community.progressByTitleID[$0] },
                container: container,
                session: session,
                shell: shell
            )
        } else {
            FeedActivityCard(
                activity: activity,
                container: container,
                session: session,
                shell: shell,
                allowsLiveSocialLoad: allowsLiveSocialLoad
            )
        }
    }

    @ViewBuilder
    private var loadMoreFooter: some View {
        if community.canLoadMore {
            if community.isLoadingMore {
                HStack(spacing: 10) {
                    ProgressView().tint(TwoWatchTheme.brandPrimary)
                    Text("Carico altri post...")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            } else if let userID = session.firebaseUser?.uid {
                Button {
                    Task { await community.loadMore(userID: userID) }
                } label: {
                    Text("Carica altri post")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
    }
}
