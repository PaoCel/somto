import SwiftUI

/// Corsia editoriale della Home. Ogni voce e' un fatto (`titleUpdateEvent`)
/// collegato a un unico post Somto: Community e Home condividono quindi like,
/// commenti, moderazione e protezione spoiler senza sincronizzazioni parallele.
struct HomeUpcomingReleasesSection: View {
    let releases: [HomeRepository.UpcomingRelease]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("In uscita")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("I film e le serie in arrivo, con la data.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 12) {
                    ForEach(releases) { release in
                        HomeUpcomingReleaseCard(
                            release: release,
                            container: container,
                            session: session,
                            shell: shell
                        )
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }
}

private struct HomeUpcomingReleaseCard: View {
    let release: HomeRepository.UpcomingRelease
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var commentCount = 0

    private var occasionLabel: String {
        if release.occasion == "season_premiere" {
            if release.season == 1 { return "Serie" }
            if let season = release.season { return "Stagione \(season)" }
            return "Nuova stagione"
        }
        switch release.releaseKind {
        case "cinema": return "Al cinema"
        case "streaming": return "In streaming"
        case "tv": return "In TV"
        default: return release.type == "tv" ? "Serie" : "Film"
        }
    }

    private var conversationLabel: String {
        commentCount == 1 ? "1 commento" : "\(commentCount) commenti"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            NavigationLink {
                TitleDetailView(
                    container: container,
                    session: session,
                    shell: shell,
                    titleID: release.titleId
                )
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    PosterImageView(
                        url: release.posterUrl,
                        width: 92,
                        height: 136,
                        cornerRadius: 14
                    )
                    .frame(width: 92, height: 136)

                    VStack(alignment: .leading, spacing: 7) {
                        Text(release.releaseDate.formatted(.dateTime.day().month(.wide)))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)

                        Text(release.name)
                            .font(.headline.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(3)

                        Text(occasionLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)

                        if let provider = release.provider?.name, !provider.isEmpty {
                            Text(provider)
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .buttonStyle(.plain)

            if let postID = release.resolvedPostID {
                Button {
                    if session.isAuthenticated {
                        shell.presentPostComments(postID: postID)
                    } else {
                        shell.presentAuth()
                    }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: commentCount > 0 ? "bubble.right.fill" : "bubble.right")
                            .accessibilityHidden(true)
                        Text(commentCount > 0 ? conversationLabel : "Commenta")
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .accessibilityHidden(true)
                    }
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 9)
                    .background(TwoWatchTheme.brandPrimary.opacity(0.1), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(commentCount > 0 ? "Apri \(conversationLabel)" : "Commenta")
                .task(id: "\(postID)-\(shell.socialRefreshToken.uuidString)") {
                    do {
                        commentCount = try await container.postsRepository.fetchCommentCount(postID: postID)
                    } catch {
                        commentCount = 0
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 286, alignment: .leading)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }
}
