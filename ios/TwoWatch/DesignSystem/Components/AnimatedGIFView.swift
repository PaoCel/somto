import ImageIO
import SwiftUI
import UIKit

/// Cache in memoria dei dati GIF già scaricati, chiavata sull'URL remoto.
/// Evita il refetch quando la stessa GIF ricompare (grid + bolla inviata).
private enum GifDataCache {
    // NSCache è thread-safe: l'accesso concorrente è sicuro senza isolamento.
    nonisolated(unsafe) static let shared: NSCache<NSURL, NSData> = {
        let cache = NSCache<NSURL, NSData>()
        cache.totalCostLimit = 32 * 1024 * 1024 // ~32 MB
        return cache
    }()
}

/// Riproduce una GIF animata da un URL remoto usando ImageIO
/// (`CGAnimateImageDataWithBlock`) — nessuna dipendenza esterna.
///
/// - Scarica i dati con `URLSession` e li tiene in una piccola cache in memoria.
/// - Mostra uno spinner in caricamento e un fallback grazioso in errore.
/// - Rispetta `Riduci movimento`: mostra il primo frame statico invece
///   dell'animazione.
/// - Deriva l'altezza dall'aspect ratio della GIF, dato un `targetWidth`.
struct AnimatedGIFView: View {
    let url: URL?
    var targetWidth: CGFloat = 220
    var cornerRadius: CGFloat = 14

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var loadState: LoadState = .loading
    @State private var gifData: Data?
    @State private var firstFrame: UIImage?
    @State private var aspectRatio: CGFloat = 4.0 / 3.0

    private enum LoadState { case loading, loaded, failed }

    /// Altezza derivata dall'aspect ratio, con clamp per evitare bolle
    /// esageratamente alte o basse.
    private var derivedHeight: CGFloat {
        let ratio = aspectRatio > 0 ? aspectRatio : (4.0 / 3.0)
        let raw = targetWidth / ratio
        return min(max(raw, 90), 320)
    }

    var body: some View {
        content
            .frame(width: targetWidth, height: derivedHeight)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .task(id: url) { await load() }
            .accessibilityLabel("GIF")
    }

    @ViewBuilder private var content: some View {
        switch loadState {
        case .loading:
            ZStack {
                TwoWatchTheme.panel
                ProgressView().tint(TwoWatchTheme.brandPrimary)
            }
        case .failed:
            ZStack {
                TwoWatchTheme.panel
                VStack(spacing: 6) {
                    Image(systemName: "photo")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                    Text("GIF non disponibile")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
        case .loaded:
            if reduceMotion, let firstFrame {
                Image(uiImage: firstFrame)
                    .resizable()
                    .scaledToFill()
            } else if let gifData {
                AnimatedGIFRepresentable(data: gifData)
            } else if let firstFrame {
                Image(uiImage: firstFrame)
                    .resizable()
                    .scaledToFill()
            }
        }
    }

    private func load() async {
        guard let url else {
            loadState = .failed
            return
        }

        loadState = .loading
        let outcome = await Self.fetchAndDecode(url: url)
        guard !Task.isCancelled else { return }

        switch outcome {
        case let .success(data, frame, ratio):
            gifData = data
            firstFrame = frame
            aspectRatio = ratio
            loadState = .loaded
        case .failure:
            loadState = .failed
        }
    }

    private enum DecodeOutcome {
        case success(data: Data, firstFrame: UIImage, aspectRatio: CGFloat)
        case failure
    }

    /// Download + decode del primo frame fuori dal main actor (non isolato):
    /// la decodifica CPU non blocca la UI.
    private static func fetchAndDecode(url: URL) async -> DecodeOutcome {
        let data: Data
        if let cached = GifDataCache.shared.object(forKey: url as NSURL) {
            data = Data(referencing: cached)
        } else {
            do {
                let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad)
                let (fetched, _) = try await URLSession.shared.data(for: request)
                GifDataCache.shared.setObject(fetched as NSData, forKey: url as NSURL, cost: fetched.count)
                data = fetched
            } catch {
                return .failure
            }
        }

        guard
            let source = CGImageSourceCreateWithData(data as CFData, nil),
            let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            return .failure
        }

        let height = CGFloat(cgImage.height)
        let ratio = height > 0 ? CGFloat(cgImage.width) / height : (4.0 / 3.0)
        return .success(data: data, firstFrame: UIImage(cgImage: cgImage), aspectRatio: ratio)
    }
}

/// Anima i dati GIF dentro una `UIImageView` via `CGAnimateImageDataWithBlock`.
/// L'animazione è pilotata dal run loop principale (il blocco è invocato sul
/// main thread) e viene fermata al dismantle tramite il flag del coordinator.
private struct AnimatedGIFRepresentable: UIViewRepresentable {
    let data: Data

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIImageView {
        let imageView = UIImageView()
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.setContentHuggingPriority(.defaultLow, for: .horizontal)
        imageView.setContentHuggingPriority(.defaultLow, for: .vertical)
        context.coordinator.startAnimating(data: data, in: imageView)
        return imageView
    }

    func updateUIView(_ uiView: UIImageView, context: Context) {}

    static func dismantleUIView(_ uiView: UIImageView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class Coordinator {
        private var stopped = false

        func stop() { stopped = true }

        func startAnimating(data: Data, in imageView: UIImageView) {
            // `CGAnimateImageDataWithBlock` è chiamato dal main run loop
            // (invocato da `makeUIView` su MainActor) e consegna i frame sul
            // main thread → `assumeIsolated` è sicuro. `stop.pointee = true`
            // termina il ciclo al dismantle.
            CGAnimateImageDataWithBlock(data as CFData, nil) { [weak self, weak imageView] _, cgImage, stop in
                guard let self, let imageView, !self.stopped else {
                    stop.pointee = true
                    return
                }
                MainActor.assumeIsolated {
                    imageView.image = UIImage(cgImage: cgImage)
                }
            }
        }
    }
}
