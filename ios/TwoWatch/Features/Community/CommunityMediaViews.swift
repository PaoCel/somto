import SwiftUI

// Carosello media e collage multi-titolo del feed, estratti da
// CommunityView.swift.

struct SocialMediaCarouselView: View {
    let urls: [URL]
    var height: CGFloat = 420
    var cornerRadius: CGFloat = 20
    /// `.fill` riempie il riquadro tagliando i bordi (foto degli utenti, dove
    /// il crop e' l'effetto voluto). `.fit` mostra l'immagine intera e adatta
    /// l'altezza della card alle sue proporzioni: serve alle copertine
    /// editoriali, che perderebbero pezzi di grafica se ritagliate.
    var contentMode: ContentMode = .fill
    var tapActionForIndex: ((Int) -> Void)? = nil

    @State private var selection = 0
    @State private var naturalAspect: CGFloat?

    var body: some View {
        Group {
            if contentMode == .fit, let naturalAspect, naturalAspect > 0 {
                carousel.aspectRatio(naturalAspect, contentMode: .fit)
            } else {
                carousel.frame(height: height)
            }
        }
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }

    private var carousel: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.black.opacity(0.08))

            if urls.isEmpty {
                Image(systemName: "photo")
                    .font(.largeTitle)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            } else {
                TabView(selection: $selection) {
                    ForEach(Array(urls.enumerated()), id: \.offset) { index, url in
                        CachedAsyncImage(
                            url: url,
                            onImageSize: { size in
                                // Solo la prima immagine detta le proporzioni della
                                // card: in un carosello misto non ha senso farla
                                // saltare a ogni swipe.
                                guard index == 0, size.height > 0 else { return }
                                let ratio = size.width / size.height
                                if naturalAspect != ratio { naturalAspect = ratio }
                            }
                        ) { phase in
                            switch phase {
                            case let .success(image):
                                if contentMode == .fit {
                                    image
                                        .resizable()
                                        .scaledToFit()
                                } else {
                                    image
                                        .resizable()
                                        .scaledToFill()
                                }
                            default:
                                ProgressView()
                                    .tint(TwoWatchTheme.textMuted)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            tapActionForIndex?(index)
                        }
                        .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                if urls.count > 1 {
                    VStack {
                        Spacer()
                        HStack(spacing: 8) {
                            ForEach(Array(urls.enumerated()), id: \.offset) { index, _ in
                                Circle()
                                    .fill(index == selection ? Color.white : Color.white.opacity(0.35))
                                    .frame(width: 8, height: 8)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Color.black.opacity(0.14), in: Capsule())
                        .padding(.bottom, 14)
                    }
                    .padding(.horizontal, 14)
                }
            }
        }
    }
}

struct MultiTitleCollageView<Destination: View>: View {
    let titles: [Title]
    let destination: (Title) -> Destination

    init(
        titles: [Title],
        @ViewBuilder destination: @escaping (Title) -> Destination
    ) {
        self.titles = titles
        self.destination = destination
    }

    var body: some View {
        GeometryReader { geometry in
            let spacing: CGFloat = 4
            let visibleColumns = titles.count > 4 ? 5 : max(1, titles.count)
            let itemWidth = max(56, (geometry.size.width - (CGFloat(visibleColumns - 1) * spacing)) / CGFloat(visibleColumns))

            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: spacing) {
                        ForEach(Array(titles.prefix(4).enumerated()), id: \.element.id) { _, title in
                            collagePoster(title, width: itemWidth)
                        }

                        if titles.count > 4 {
                            collageOverflowBadge(extraCount: titles.count - 4, width: itemWidth)
                                .onTapGesture {
                                    withAnimation(.easeInOut(duration: 0.25)) {
                                        proxy.scrollTo("collage-extra-start", anchor: .leading)
                                    }
                                }
                        }

                        ForEach(Array(titles.dropFirst(4).enumerated()), id: \.element.id) { index, title in
                            collagePoster(title, width: itemWidth)
                                .id(index == 0 ? "collage-extra-start" : "collage-\(title.id)")
                        }
                    }
                    .padding(4)
                }
            }
        }
        .frame(height: 420)
    }

    private func collagePoster(_ title: Title, width: CGFloat) -> some View {
        NavigationLink {
            destination(title)
        } label: {
            PosterImageView(url: title.posterPath, width: width, height: 412, cornerRadius: 16)
                .frame(width: width, height: 412)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func collageOverflowBadge(extraCount: Int, width: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.black.opacity(0.45))
            VStack(spacing: 4) {
                Text("+\(extraCount)")
                    .font(.title3.weight(.bold))
                Text("Altri")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(.white)
        }
        .frame(width: width, height: 412)
    }
}
