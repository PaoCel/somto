#if DEBUG
import Foundation

@MainActor
enum TwoWatchPreview {
    static let container = AppContainer(startSessionObservation: false)

    static let currentUser = AppUser(
        id: "preview-me",
        displayName: "Paolo",
        displayNameLower: "paolo",
        photoURL: URL(string: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=240&q=80"),
        avatarURL: URL(string: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=240&q=80"),
        trusted: true,
        isAdmin: true,
        level: .doctor,
        stats: UserStats(ratingsCount: 182, reviewsCount: 47, watchedCount: 318, totalWatchMinutes: 28_440),
        favoriteGenres: ["Sci-Fi", "Thriller", "Drama"],
        communitySafetyAcceptedAt: Date(),
        communitySafetyVersion: CommunitySafetyPolicy.currentVersion
    )

    static let friendUser = AppUser(
        id: "preview-friend",
        displayName: "Chiara",
        displayNameLower: "chiara",
        photoURL: URL(string: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=240&q=80"),
        avatarURL: URL(string: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=240&q=80"),
        trusted: true,
        isAdmin: false,
        level: .associate,
        stats: UserStats(ratingsCount: 91, reviewsCount: 16, watchedCount: 144, totalWatchMinutes: 12_960),
        favoriteGenres: ["Comedy", "Crime"],
        communitySafetyAcceptedAt: Date(),
        communitySafetyVersion: CommunitySafetyPolicy.currentVersion
    )

    static let criticUser = AppUser(
        id: "preview-critic",
        displayName: "Luca",
        displayNameLower: "luca",
        photoURL: URL(string: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=240&q=80"),
        avatarURL: URL(string: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=240&q=80"),
        trusted: false,
        isAdmin: false,
        level: .associate,
        stats: UserStats(ratingsCount: 73, reviewsCount: 9, watchedCount: 126, totalWatchMinutes: 9_720),
        favoriteGenres: ["Thriller", "Mystery", "Drama"],
        communitySafetyAcceptedAt: nil,
        communitySafetyVersion: 0
    )

    static let featuredTitle = Title(
        id: "title-dune-2",
        name: "Dune: Parte Due",
        nameLower: "dune parte due",
        type: .movie,
        year: 2024,
        description: "Paul Atreides si unisce ai Fremen mentre la guerra per Arrakis entra nella sua fase piu intensa.",
        posterPath: URL(string: "https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg"),
        backdropPath: URL(string: "https://image.tmdb.org/t/p/w780/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg"),
        genres: ["Sci-Fi", "Adventure"],
        originalName: "Dune: Part Two",
        aliases: [],
        directors: ["Denis Villeneuve"],
        directorIDs: ["person-denis-villeneuve"],
        cast: ["Timothee Chalamet", "Zendaya"],
        castIDs: ["person-timothee-chalamet", "person-zendaya"],
        keywords: ["deserto", "messia", "arrakis"],
        collectionName: "Dune Collection",
        searchableText: "Dune Parte Due Dune Part Two Arrakis messia deserto",
        ratingAvg: 4.6,
        ratingCount: 421,
        ratingAggregate: nil,
        reviewCount: 119,
        createdBy: "preview-me",
        status: "approved",
        metadata: TitleMetadata(
            tmdbId: 693134,
            mediaType: .movie,
            language: "it",
            country: "IT",
            network: nil,
            durationMovie: 166,
            durationEpisode: nil,
            seasonsCount: nil,
            episodesPerSeason: nil,
            collectionId: 726871,
            collectionName: "Dune Collection",
            collectionPosterPath: URL(string: "https://image.tmdb.org/t/p/w500/omHqB8W2l2l6QK1N6rIjXfJ4eTW.jpg"),
            collectionBackdropPath: nil
        ),
        searchDedupeKey: "movie_693134",
        updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 20),
        tmdbNextRefreshAt: .now.addingTimeInterval(-60 * 60 * 24)
    )

    static let secondTitle = Title(
        id: "title-the-bear",
        name: "The Bear",
        nameLower: "the bear",
        type: .tv,
        year: 2022,
        description: "Una cucina di Chicago, ritmi altissimi e un cast perfetto per una serie che tiene tutto in tensione.",
        posterPath: URL(string: "https://image.tmdb.org/t/p/w500/sHFlbKS3WLqMnp9t2ghADIJFnuQ.jpg"),
        backdropPath: URL(string: "https://image.tmdb.org/t/p/w780/9rBQWQJ8J7mTtZy3n1lS1bD2v7m.jpg"),
        genres: ["Drama"],
        originalName: "The Bear",
        aliases: [],
        directors: [],
        directorIDs: [],
        cast: ["Jeremy Allen White"],
        castIDs: ["person-jeremy-allen-white"],
        keywords: ["chef", "ristorante", "cucina"],
        collectionName: nil,
        searchableText: "The Bear chef ristorante cucina Chicago",
        ratingAvg: 4.4,
        ratingCount: 233,
        ratingAggregate: nil,
        reviewCount: 54,
        createdBy: "preview-friend",
        status: "approved",
        metadata: TitleMetadata(
            tmdbId: 136315,
            mediaType: .tv,
            language: "en",
            country: "US",
            network: "FX",
            durationMovie: nil,
            durationEpisode: 32,
            seasonsCount: 3,
            episodesPerSeason: 10,
            collectionId: nil,
            collectionName: nil,
            collectionPosterPath: nil,
            collectionBackdropPath: nil
        ),
        searchDedupeKey: "tv_136315",
        updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
        tmdbNextRefreshAt: .now.addingTimeInterval(60 * 60 * 24 * 12)
    )

    static let thirdTitle = Title(
        id: "title-severance",
        name: "Severance",
        nameLower: "severance",
        type: .tv,
        year: 2022,
        description: "Lavoro, identita e memoria in un thriller stilizzato che su iPhone rende benissimo nel layout a card.",
        posterPath: URL(string: "https://image.tmdb.org/t/p/w500/7jTtK8N1aP6dM4R3Y7I5l8U5M8R.jpg"),
        backdropPath: nil,
        genres: ["Sci-Fi", "Thriller"],
        originalName: "Severance",
        aliases: [],
        directors: [],
        directorIDs: [],
        cast: ["Adam Scott"],
        castIDs: ["person-adam-scott"],
        keywords: ["ufficio", "memoria", "thriller"],
        collectionName: nil,
        searchableText: "Severance ufficio memoria thriller Apple TV",
        ratingAvg: 4.7,
        ratingCount: 198,
        ratingAggregate: nil,
        reviewCount: 71,
        createdBy: "preview-me",
        status: "approved",
        metadata: TitleMetadata(
            tmdbId: 95396,
            mediaType: .tv,
            language: "en",
            country: "US",
            network: "Apple TV+",
            durationMovie: nil,
            durationEpisode: 45,
            seasonsCount: 2,
            episodesPerSeason: 10,
            collectionId: nil,
            collectionName: nil,
            collectionPosterPath: nil,
            collectionBackdropPath: nil
        ),
        searchDedupeKey: "tv_95396",
        updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 30),
        tmdbNextRefreshAt: .now.addingTimeInterval(-60 * 60 * 24 * 2)
    )

    static let titles = [featuredTitle, secondTitle, thirdTitle]

    static let feed: [FeedActivity] = [
        FeedActivity(
            id: "feed-rating",
            kind: .rating,
            actor: UserSummary(id: friendUser.id, displayName: friendUser.displayName, photoURL: friendUser.avatarURL),
            relatedUser: nil,
            title: featuredTitle,
            titleId: featuredTitle.id,
            postId: "post-rating-1",
            recommendationId: nil,
            sourceId: nil,
            sourcePath: nil,
            rating: 4.5,
            previousRating: nil,
            text: nil,
            snippet: "Visivamente enorme. Denis qui e fuori scala.",
            reviewText: "Visivamente enorme. Denis qui e fuori scala.",
            taggedTitles: [featuredTitle],
            mediaURL: featuredTitle.posterPath,
            mediaURLs: [featuredTitle.posterPath].compactMap { $0 },
            watchedWith: [],
            watchedWithGroup: nil,
            sharedPost: nil,
            createdAt: .now.addingTimeInterval(-3_600),
            webURL: featuredTitle.shareURL
        ),
        FeedActivity(
            id: "feed-post",
            kind: .post,
            actor: UserSummary(id: currentUser.id, displayName: currentUser.displayName, photoURL: currentUser.avatarURL),
            relatedUser: nil,
            title: secondTitle,
            titleId: secondTitle.id,
            postId: "post-plain-1",
            recommendationId: nil,
            sourceId: nil,
            sourcePath: nil,
            rating: nil,
            previousRating: nil,
            text: "The Bear continua a essere una masterclass di ritmo e caos controllato.",
            snippet: nil,
            reviewText: nil,
            taggedTitles: [secondTitle],
            mediaURL: nil,
            mediaURLs: [],
            watchedWith: [],
            watchedWithGroup: nil,
            sharedPost: FeedSharedPost(
                postId: "post-shared-1",
                author: UserSummary(id: friendUser.id, displayName: friendUser.displayName, photoURL: friendUser.avatarURL),
                text: "Questo episodio mi ha distrutto.",
                titleId: secondTitle.id
            ),
            createdAt: .now.addingTimeInterval(-7_200),
            webURL: URL(string: "https://somto.it/thread.html?id=post-plain-1")
        )
    ]

    static let watchlistEntries: [WatchlistEntry] = [
        WatchlistEntry(id: "watch-1", titleId: featuredTitle.id, watchState: "to_watch", priority: "high", addedAt: .now.addingTimeInterval(-86_400), title: featuredTitle),
        WatchlistEntry(id: "watch-2", titleId: secondTitle.id, watchState: "to_rate", priority: "medium", addedAt: .now.addingTimeInterval(-172_800), title: secondTitle),
        WatchlistEntry(id: "watch-3", titleId: thirdTitle.id, watchState: "to_watch", priority: "low", addedAt: .now.addingTimeInterval(-259_200), title: thirdTitle)
    ]

    static let generalMovieState = TitlePersonalState(
        id: featuredTitle.id,
        titleId: featuredTitle.id,
        mediaType: .movie,
        generalWatchlist: true,
        rewatchIntent: false,
        movieStatus: .unseen,
        seriesStatus: nil,
        seriesProgress: nil,
        ratingValue: nil,
        hasTitleRating: false,
        seenAt: nil,
        completedAt: nil,
        ratedAt: nil,
        rewatchAddedAt: nil,
        createdAt: .now.addingTimeInterval(-86_400),
        updatedAt: .now.addingTimeInterval(-86_400),
        lastInteractionAt: .now.addingTimeInterval(-86_400),
        source: "preview",
        reminderHints: .empty,
        title: featuredTitle
    )

    static let generalSeriesState = TitlePersonalState(
        id: secondTitle.id,
        titleId: secondTitle.id,
        mediaType: .tv,
        generalWatchlist: true,
        rewatchIntent: false,
        movieStatus: nil,
        seriesStatus: .inProgress,
        seriesProgress: TitleSeriesProgress(
            episodesWatchedCount: 11,
            seasonsCompletedCount: 1,
            totalEpisodeCount: 18,
            totalSeasonCount: 3,
            lastWatchedEpisodeId: "s02e03",
            lastWatchedEpisodeName: "S2 E3",
            lastWatchedSeasonNumber: 2,
            lastWatchedEpisodeNumber: 3,
            lastWatchedAt: .now.addingTimeInterval(-60 * 60 * 24 * 2),
            percentComplete: 11.0 / 18.0
        ),
        ratingValue: nil,
        hasTitleRating: false,
        seenAt: nil,
        completedAt: nil,
        ratedAt: nil,
        rewatchAddedAt: nil,
        createdAt: .now.addingTimeInterval(-172_800),
        updatedAt: .now.addingTimeInterval(-TimeInterval(60 * 60 * 24 * 2)),
        lastInteractionAt: .now.addingTimeInterval(-TimeInterval(60 * 60 * 24 * 2)),
        source: "preview",
        reminderHints: TitleReminderHints(
            ratingReminderEligible: false,
            resumeReminderEligible: true,
            lastProgressAt: .now.addingTimeInterval(-60 * 60 * 24 * 2),
            suggestedReminderAt: .now.addingTimeInterval(60 * 60 * 24 * 3)
        ),
        title: secondTitle
    )

    static let toRateState = TitlePersonalState(
        id: thirdTitle.id,
        titleId: thirdTitle.id,
        mediaType: .tv,
        generalWatchlist: false,
        rewatchIntent: false,
        movieStatus: nil,
        seriesStatus: .completedUnrated,
        seriesProgress: TitleSeriesProgress(
            episodesWatchedCount: 20,
            seasonsCompletedCount: 2,
            totalEpisodeCount: 20,
            totalSeasonCount: 2,
            lastWatchedEpisodeId: "s02e10",
            lastWatchedEpisodeName: "Finale",
            lastWatchedSeasonNumber: 2,
            lastWatchedEpisodeNumber: 10,
            lastWatchedAt: .now.addingTimeInterval(-60 * 60 * 16),
            percentComplete: 1
        ),
        ratingValue: nil,
        hasTitleRating: false,
        seenAt: .now.addingTimeInterval(-60 * 60 * 18),
        completedAt: .now.addingTimeInterval(-60 * 60 * 16),
        ratedAt: nil,
        rewatchAddedAt: nil,
        createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 8),
        updatedAt: .now.addingTimeInterval(-60 * 60 * 16),
        lastInteractionAt: .now.addingTimeInterval(-60 * 60 * 16),
        source: "preview",
        reminderHints: TitleReminderHints(
            ratingReminderEligible: true,
            resumeReminderEligible: false,
            lastProgressAt: .now.addingTimeInterval(-60 * 60 * 16),
            suggestedReminderAt: .now.addingTimeInterval(60 * 60 * 24)
        ),
        title: thirdTitle
    )

    static let rewatchState = TitlePersonalState(
        id: "rewatch-\(featuredTitle.id)",
        titleId: featuredTitle.id,
        mediaType: .movie,
        generalWatchlist: false,
        rewatchIntent: true,
        movieStatus: .rated,
        seriesStatus: nil,
        seriesProgress: nil,
        ratingValue: 8.5,
        hasTitleRating: true,
        seenAt: .now.addingTimeInterval(-60 * 60 * 24 * 20),
        completedAt: .now.addingTimeInterval(-60 * 60 * 24 * 20),
        ratedAt: .now.addingTimeInterval(-60 * 60 * 24 * 19),
        rewatchAddedAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
        createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 20),
        updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
        lastInteractionAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
        source: "preview",
        reminderHints: .empty,
        title: featuredTitle
    )

    static let previewListCover = UserListCover(
        imageURL: nil,
        storagePath: nil,
        fallbackTitleIds: [featuredTitle.id, secondTitle.id, thirdTitle.id],
        accentHex: "#FFB347"
    )

    static let previewDefaultWatchlist = UserListSummary(
        id: WatchlistRepository.generalWatchlistListID,
        title: "Watchlist",
        description: "I titoli che hai segnato da vedere, sempre pronti da riprendere.",
        visibility: .private,
        kind: .collection,
        ownerUid: currentUser.id,
        owner: UserSummary(id: currentUser.id, displayName: currentUser.displayName, photoURL: currentUser.avatarURL),
        memberUids: [currentUser.id],
        editorUids: [],
        cover: previewListCover,
        itemCount: 10,
        completedCount: 0,
        followersCount: 0,
        createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 12),
        updatedAt: .now.addingTimeInterval(-60 * 60 * 5),
        isOwnedByCurrentUser: true,
        canEdit: false,
        isSavedByCurrentUser: true,
        previewTitles: [
            featuredTitle, secondTitle, thirdTitle,
            featuredTitle, secondTitle, thirdTitle,
            featuredTitle, secondTitle, thirdTitle,
            featuredTitle
        ]
    )

    static let previewMyList = UserListSummary(
        id: "list-marvel",
        title: "Marvel Rewatch",
        description: "Percorso ordinato per rimettere in fila tutto il MCU con calma.",
        visibility: .private,
        kind: .orderedPath,
        ownerUid: currentUser.id,
        owner: UserSummary(id: currentUser.id, displayName: currentUser.displayName, photoURL: currentUser.avatarURL),
        memberUids: [currentUser.id],
        editorUids: [currentUser.id],
        cover: previewListCover,
        itemCount: 8,
        completedCount: 3,
        followersCount: 0,
        createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 20),
        updatedAt: .now.addingTimeInterval(-60 * 60 * 6),
        isOwnedByCurrentUser: true,
        canEdit: true,
        isSavedByCurrentUser: true,
        previewTitles: [featuredTitle, secondTitle, thirdTitle]
    )

    static let previewSharedList = UserListSummary(
        id: "list-sherlock",
        title: "Sherlock Holmes con Chiara",
        description: "Lista condivisa per i film e le serie piu iconiche dell'universo Holmes.",
        visibility: .shared,
        kind: .collection,
        ownerUid: friendUser.id,
        owner: UserSummary(id: friendUser.id, displayName: friendUser.displayName, photoURL: friendUser.avatarURL),
        memberUids: [friendUser.id, currentUser.id],
        editorUids: [friendUser.id, currentUser.id],
        cover: previewListCover,
        itemCount: 6,
        completedCount: 2,
        followersCount: 0,
        createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 11),
        updatedAt: .now.addingTimeInterval(-60 * 60 * 18),
        isOwnedByCurrentUser: false,
        canEdit: true,
        isSavedByCurrentUser: true,
        previewTitles: [thirdTitle, featuredTitle]
    )

    static let previewPublicList = UserListSummary(
        id: "list-lotr",
        title: "Middle-earth Essentials",
        description: "Una lista pubblica pronta da duplicare nella tua libreria.",
        visibility: .public,
        kind: .collection,
        ownerUid: criticUser.id,
        owner: UserSummary(id: criticUser.id, displayName: criticUser.displayName, photoURL: criticUser.avatarURL),
        memberUids: [criticUser.id],
        editorUids: [criticUser.id],
        cover: previewListCover,
        itemCount: 5,
        completedCount: 1,
        followersCount: 42,
        createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 30),
        updatedAt: .now.addingTimeInterval(-60 * 60 * 12),
        isOwnedByCurrentUser: false,
        canEdit: false,
        isSavedByCurrentUser: false,
        previewTitles: [featuredTitle, thirdTitle]
    )

    static let watchlistDashboard = WatchlistDashboard(
        generalWatchlist: [generalMovieState, generalSeriesState],
        rewatch: [rewatchState],
        toRate: [toRateState],
        toResume: [],
        inProgressSeries: [generalSeriesState],
        myLists: [previewDefaultWatchlist, previewMyList],
        sharedLists: [previewSharedList],
        publicLists: [previewPublicList]
    )

    static let notifications: [AppNotification] = [
        AppNotification(
            id: "notif-1",
            type: "friend_request",
            fromUid: friendUser.id,
            toUid: currentUser.id,
            read: false,
            createdAt: .now.addingTimeInterval(-1_200),
            title: "Nuova richiesta amicizia",
            text: "Chiara vuole collegarsi con te.",
            icon: "person.badge.plus",
            avatarURL: friendUser.avatarURL,
            avatarText: "C",
            destination: .profileInbox
        ),
        AppNotification(
            id: "notif-2",
            type: "post_comment",
            fromUid: friendUser.id,
            toUid: currentUser.id,
            read: true,
            createdAt: .now.addingTimeInterval(-9_600),
            title: "Nuovo commento",
            text: "Chiara ha risposto al tuo post su Dune.",
            icon: "text.bubble",
            avatarURL: friendUser.avatarURL,
            avatarText: "C",
            destination: .post(id: "post-plain-1")
        )
    ]

    static let matchCandidates: [MatchCandidate] = [
        MatchCandidate(
            id: featuredTitle.id,
            name: featuredTitle.name,
            type: featuredTitle.type,
            year: featuredTitle.year,
            overview: featuredTitle.description ?? "",
            posterURL: featuredTitle.posterPath,
            genres: featuredTitle.genres,
            cast: Array(featuredTitle.cast.prefix(3)),
            reasons: ["Molto in linea con i tuoi sci-fi preferiti", "Community score alto tra i tuoi amici"],
            score: 0.94,
            matchPercent: 94,
            ratingAvg: featuredTitle.ratingAvg,
            ratingCount: featuredTitle.ratingCount
        ),
        MatchCandidate(
            id: secondTitle.id,
            name: secondTitle.name,
            type: secondTitle.type,
            year: secondTitle.year,
            overview: secondTitle.description ?? "",
            posterURL: secondTitle.posterPath,
            genres: secondTitle.genres,
            cast: Array(secondTitle.cast.prefix(3)),
            reasons: ["Tensione alta", "Serie breve da recuperare"],
            score: 0.88,
            matchPercent: 88,
            ratingAvg: secondTitle.ratingAvg,
            ratingCount: secondTitle.ratingCount
        )
    ]


    static let genres = [
        Genre(id: "genre-sci-fi", name: "Sci-Fi", nameLower: "sci-fi"),
        Genre(id: "genre-drama", name: "Drama", nameLower: "drama"),
        Genre(id: "genre-thriller", name: "Thriller", nameLower: "thriller")
    ]

    static let people = [
        Person(
            id: "person-denis-villeneuve",
            name: "Denis Villeneuve",
            nameLower: "denis villeneuve",
            avatarURL: URL(string: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=240&q=80"),
            roles: ["director"],
            occurrences: 12
        ),
        Person(
            id: "person-zendaya",
            name: "Zendaya",
            nameLower: "zendaya",
            avatarURL: URL(string: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=240&q=80"),
            roles: ["actor"],
            occurrences: 9
        )
    ]

    static let tmdbResults = [
        TMDBSearchResult(
            id: "tmdb-1",
            tmdbId: 157336,
            mediaType: .movie,
            title: "Interstellar",
            originalTitle: "Interstellar",
            year: 2014,
            overview: "Un classico di catalogo che puoi importare con un tap.",
            posterURL: URL(string: "https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg"),
            genreIds: [878, 12]
        )
    ]

    static let previewProviders = TitleProviders(
        region: "IT",
        link: URL(string: "https://www.justwatch.com/it"),
        providers: [
            StreamingProvider(
                id: "provider-netflix",
                name: "Netflix",
                logoURL: URL(string: "https://image.tmdb.org/t/p/original/t2yyOv40HZeVlLjYsCsPHnWLk4W.jpg"),
                type: "flatrate"
            ),
            StreamingProvider(
                id: "provider-prime",
                name: "Prime Video",
                logoURL: URL(string: "https://image.tmdb.org/t/p/original/emthp39XA2YScoYL1p0sdbAH2WA.jpg"),
                type: "flatrate"
            )
        ],
        customProviders: [
            StreamingProvider(
                id: "provider-cinema",
                name: "Cinema",
                logoURL: nil,
                type: "theatrical"
            )
        ]
    )

    static let previewRatings: [Rating] = [
        Rating(
            id: "rating-1",
            uid: friendUser.id,
            titleId: secondTitle.id,
            level: "title",
            season: nil,
            episode: nil,
            rating: 9,
            reviewText: "Ritmo incredibile e una tensione che non molla mai.",
            updatedAt: .now.addingTimeInterval(-12_000),
            author: UserSummary(id: friendUser.id, displayName: friendUser.displayName, photoURL: friendUser.avatarURL),
            watchedWith: [FeedTaggedUser(id: criticUser.id, displayName: criticUser.displayName)],
            watchedWithGroup: nil,
            mediaURLs: []
        ),
        Rating(
            id: "rating-2",
            uid: currentUser.id,
            titleId: secondTitle.id,
            level: "title",
            season: nil,
            episode: nil,
            rating: 8,
            reviewText: "Caotica al punto giusto. La regia regge benissimo anche nei momenti piu nervosi.",
            updatedAt: .now.addingTimeInterval(-36_000),
            author: UserSummary(id: currentUser.id, displayName: currentUser.displayName, photoURL: currentUser.avatarURL),
            watchedWith: [],
            watchedWithGroup: nil,
            mediaURLs: []
        ),
        Rating(
            id: "rating-3",
            uid: currentUser.id,
            titleId: secondTitle.id,
            level: "season",
            season: 1,
            episode: nil,
            rating: 8,
            reviewText: nil,
            updatedAt: .now.addingTimeInterval(-18_000),
            author: UserSummary(id: currentUser.id, displayName: currentUser.displayName, photoURL: currentUser.avatarURL),
            watchedWith: [],
            watchedWithGroup: nil,
            mediaURLs: []
        ),
        Rating(
            id: "rating-4",
            uid: currentUser.id,
            titleId: secondTitle.id,
            level: "episode",
            season: 1,
            episode: 1,
            rating: 9,
            reviewText: nil,
            updatedAt: .now.addingTimeInterval(-9_000),
            author: UserSummary(id: currentUser.id, displayName: currentUser.displayName, photoURL: currentUser.avatarURL),
            watchedWith: [],
            watchedWithGroup: nil,
            mediaURLs: []
        )
    ]

    static func session(authenticated: Bool = true) -> SessionStore {
        let session = SessionStore(
            authRepository: container.authRepository,
            userRepository: container.userRepository,
            shouldObserveAuthState: false
        )
        session.appUser = authenticated ? currentUser : nil
        session.isLoading = false
        return session
    }

    static func shell(selectedTab: AppTab = .home) -> AppShellStore {
        let shell = AppShellStore()
        shell.selectedTab = selectedTab
        return shell
    }

    static func homeViewModel() -> HomeViewModel {
        let viewModel = HomeViewModel(homeRepository: container.homeRepository)
        viewModel.hero = watchlistDashboard.generalWatchlist
        viewModel.continueWatching = [generalSeriesState]
        viewModel.newForYou = watchlistDashboard.toResume
        viewModel.trending = titles
        viewModel.fresh = Array(titles.reversed())
        return viewModel
    }

    static func communityViewModel() -> CommunityViewModel {
        let viewModel = CommunityViewModel(
            homeRepository: container.homeRepository,
            postsRepository: container.postsRepository,
            threadsRepository: container.threadsRepository,
            watchlistRepository: container.watchlistRepository
        )
        viewModel.feed = feed
        viewModel.canLoadMore = true
        return viewModel
    }

    static func matchViewModel() -> MatchViewModel {
        let viewModel = MatchViewModel(repository: container.matchRepository)
        viewModel.queue = matchCandidates
        return viewModel
    }

    static func watchlistViewModel() -> WatchlistViewModel {
        let viewModel = WatchlistViewModel(
            watchlistRepository: container.watchlistRepository,
            titleRepository: container.titleRepository
        )
        viewModel.dashboard = watchlistDashboard
        return viewModel
    }

    static func notificationsViewModel() -> NotificationsViewModel {
        let viewModel = NotificationsViewModel(repository: container.notificationRepository)
        viewModel.notifications = notifications
        return viewModel
    }

    static func profileViewModel() -> ProfileViewModel {
        let viewModel = ProfileViewModel(
            watchlistRepository: container.watchlistRepository,
            userRepository: container.userRepository,
            titleRepository: container.titleRepository
        )
        viewModel.watchedEntries = [
            LibraryEntry(
                id: featuredTitle.id,
                titleId: featuredTitle.id,
                lastRating: 8.5,
                ratedAt: .now.addingTimeInterval(-60 * 60 * 18),
                seenAt: .now.addingTimeInterval(-60 * 60 * 20),
                updatedAt: .now.addingTimeInterval(-60 * 60 * 18),
                createdAt: .now.addingTimeInterval(-60 * 60 * 20),
                state: nil,
                title: featuredTitle
            ),
            LibraryEntry(
                id: secondTitle.id,
                titleId: secondTitle.id,
                lastRating: 7.5,
                ratedAt: .now.addingTimeInterval(-60 * 60 * 24 * 4),
                seenAt: .now.addingTimeInterval(-60 * 60 * 24 * 5),
                updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 4),
                createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 5),
                state: nil,
                title: secondTitle
            ),
            LibraryEntry(
                id: thirdTitle.id,
                titleId: thirdTitle.id,
                lastRating: nil,
                ratedAt: nil,
                seenAt: .now.addingTimeInterval(-60 * 60 * 24 * 8),
                updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 8),
                createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 8),
                state: nil,
                title: thirdTitle
            )
        ]
        viewModel.activitySummary = ProfileActivitySummary(
            ratedTitlesCount: 182,
            watchedTitlesCount: 318,
            totalWatchMinutes: 27_540
        )
        viewModel.reviews = [
            ProfileReviewEntry(
                id: "review-dune-2",
                titleId: featuredTitle.id,
                rating: 8.5,
                reviewText: "Piaciuto tantissimo per respiro, scala e senso del tempo. In app rende bene come review hero perche ha sia titolo che testo abbastanza lungo.",
                updatedAt: .now.addingTimeInterval(-60 * 60 * 18),
                title: featuredTitle
            ),
            ProfileReviewEntry(
                id: "review-the-bear",
                titleId: secondTitle.id,
                rating: 7.5,
                reviewText: "Scrittura nervosa, personaggi che restano e un ritmo che funziona molto bene per testare card review e stato espanso.",
                updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 4),
                title: secondTitle
            )
        ]
        viewModel.reviewCount = 47
        viewModel.followers = [friendUser, criticUser]
        viewModel.following = [friendUser]
        return viewModel
    }

    static func userProfileDetailViewModel() -> UserProfileDetailViewModel {
        let viewModel = UserProfileDetailViewModel(
            userID: friendUser.id,
            userRepository: container.userRepository,
            watchlistRepository: container.watchlistRepository,
            threadsRepository: container.threadsRepository,
            titleRepository: container.titleRepository
        )
        viewModel.user = friendUser
        viewModel.currentViewerID = currentUser.id
        viewModel.relationship = UserRelationshipState(
            isFollowing: true,
            isBlockedByViewer: false
        )
        viewModel.watchedEntries = [
            LibraryEntry(
                id: secondTitle.id,
                titleId: secondTitle.id,
                lastRating: 8,
                ratedAt: .now.addingTimeInterval(-60 * 60 * 14),
                seenAt: .now.addingTimeInterval(-60 * 60 * 16),
                updatedAt: .now.addingTimeInterval(-60 * 60 * 14),
                createdAt: .now.addingTimeInterval(-60 * 60 * 16),
                state: nil,
                title: secondTitle
            ),
            LibraryEntry(
                id: thirdTitle.id,
                titleId: thirdTitle.id,
                lastRating: 9,
                ratedAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
                seenAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
                updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
                createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
                state: nil,
                title: thirdTitle
            ),
            LibraryEntry(
                id: featuredTitle.id,
                titleId: featuredTitle.id,
                lastRating: nil,
                ratedAt: nil,
                seenAt: .now.addingTimeInterval(-60 * 60 * 24 * 8),
                updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 8),
                createdAt: .now.addingTimeInterval(-60 * 60 * 24 * 8),
                state: nil,
                title: featuredTitle
            )
        ]
        viewModel.reviews = [
            ProfileReviewEntry(
                id: "friend-review-the-bear",
                titleId: secondTitle.id,
                rating: 8,
                reviewText: "Una serie che sembra piccola ma regge tutto sul dettaglio. Perfetta per testare la lettura del tab Review anche nel profilo pubblico.",
                updatedAt: .now.addingTimeInterval(-60 * 60 * 14),
                title: secondTitle
            ),
            ProfileReviewEntry(
                id: "friend-review-severance",
                titleId: thirdTitle.id,
                rating: 9,
                reviewText: "Mette ansia nel modo giusto e ha una direzione visiva fortissima. In preview aiuta a vedere subito card review, spacing e gerarchia.",
                updatedAt: .now.addingTimeInterval(-60 * 60 * 24 * 3),
                title: thirdTitle
            )
        ]
        viewModel.activitySummary = ProfileActivitySummary(
            ratedTitlesCount: friendUser.stats.ratingsCount,
            watchedTitlesCount: friendUser.stats.watchedCount,
            totalWatchMinutes: 11_820
        )
        viewModel.reviewCount = max(friendUser.stats.reviewsCount, viewModel.reviews.count)
        viewModel.followers = [currentUser, criticUser]
        viewModel.following = [criticUser]
        return viewModel
    }

    static func searchViewModel() -> SearchViewModel {
        let viewModel = SearchViewModel(
            titleRepository: container.titleRepository,
            userRepository: container.userRepository
        )
        viewModel.query = "du"
        viewModel.scope = .titles
        viewModel.titles = titles
        viewModel.tmdbResults = tmdbResults
        viewModel.users = [currentUser, friendUser]
        viewModel.genres = genres
        viewModel.people = people
        return viewModel
    }

    static func titleDetailViewModel() -> TitleDetailViewModel {
        let viewModel = TitleDetailViewModel(
            titleID: secondTitle.id,
            titleRepository: container.titleRepository,
            watchlistRepository: container.watchlistRepository,
            userRepository: container.userRepository
        )
        viewModel.title = secondTitle
        viewModel.providers = previewProviders
        viewModel.ratings = previewRatings
        viewModel.relatedTitles = [featuredTitle, thirdTitle]
        viewModel.trailerURL = URL(string: "https://www.youtube.com/watch?v=Way9Dexny3w")
        viewModel.seasons = [
            TitleSeason(seasonNumber: 1, episodeCount: 8, name: "Stagione 1"),
            TitleSeason(seasonNumber: 2, episodeCount: 8, name: "Stagione 2")
        ]
        viewModel.resolvedGenres = ["Dramma"]
        viewModel.directorCredits = [
            TitleCreditPerson(
                personID: "person-christopher-storer",
                name: "Christopher Storer",
                nameLower: "christopher storer",
                avatarURL: URL(string: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=240&q=80"),
                roles: ["director"],
                occurrences: 4,
                primaryRole: "director"
            )
        ]
        viewModel.castCredits = [
            TitleCreditPerson(
                personID: "person-jeremy-allen-white",
                name: "Jeremy Allen White",
                nameLower: "jeremy allen white",
                avatarURL: URL(string: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=240&q=80"),
                roles: ["actor"],
                occurrences: 8,
                primaryRole: "actor"
            ),
            TitleCreditPerson(
                personID: "person-ayo-edebiri",
                name: "Ayo Edebiri",
                nameLower: "ayo edebiri",
                avatarURL: URL(string: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=240&q=80"),
                roles: ["actor"],
                occurrences: 7,
                primaryRole: "actor"
            )
        ]
        viewModel.followedUsers = [friendUser]
        viewModel.personalState = generalSeriesState
        viewModel.editableLists = [previewMyList, previewSharedList]
        viewModel.currentUserID = currentUser.id
        return viewModel
    }
}
#endif
