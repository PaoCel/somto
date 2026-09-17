import SwiftUI
import UIKit

/// Drop-in replacement di `SwiftUI.AsyncImage` con cache su disco (50 MB
/// memoria, 200 MB disco — configurati in `FirebaseBootstrap`). Riprende la
/// stessa API phase-based di AsyncImage così i callsite esistenti possono
/// migrare con un rename.
///
/// Mantiene `AsyncImagePhase` come tipo di phase per compatibilità totale:
/// gli switch esistenti con `@unknown default` restano validi.
///
/// Differenze rispetto a `AsyncImage`:
/// - Reuse di `URLSession.shared` + `URLCache.shared` per evitare rete su
///   poster gia viste (la `AsyncImage` di Apple non condivide la cache HTTP
///   con `URLSession.shared`).
/// - Cancella il download `onDisappear` per non sprecare banda quando una
///   row scrolla fuori dallo schermo prima del termine.
struct CachedAsyncImage<Content: View>: View {
    private let url: URL?
    private let transaction: Transaction
    /// Dimensione in pixel dell'immagine decodificata. `AsyncImagePhase` porta
    /// solo una `Image`, che non espone le proporzioni: serve a chi deve
    /// dimensionare il contenitore sull'immagine invece di ritagliarla.
    private let onImageSize: ((CGSize) -> Void)?
    private let content: (AsyncImagePhase) -> Content

    init(
        url: URL?,
        transaction: Transaction = Transaction(),
        onImageSize: ((CGSize) -> Void)? = nil,
        @ViewBuilder content: @escaping (AsyncImagePhase) -> Content
    ) {
        self.url = url
        self.transaction = transaction
        self.onImageSize = onImageSize
        self.content = content
    }

    @State private var phase: AsyncImagePhase = .empty
    @State private var task: Task<Void, Never>?
    @State private var loadedURL: URL?

    var body: some View {
        content(phase)
            .onAppear { startLoadingIfNeeded() }
            .onDisappear {
                task?.cancel()
                task = nil
            }
            .onChange(of: url) { _, newValue in
                guard newValue != loadedURL else { return }
                cancelAndReset()
                startLoadingIfNeeded()
            }
    }

    private func cancelAndReset() {
        task?.cancel()
        task = nil
        loadedURL = nil
        phase = .empty
    }

    private func startLoadingIfNeeded() {
        guard task == nil else { return }
        guard let url else {
            phase = .empty
            return
        }
        if url == loadedURL, case .success = phase { return }

        task = Task { @MainActor in
            do {
                let request = URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad)
                let (data, _) = try await URLSession.shared.data(for: request)
                if Task.isCancelled { return }
                guard let uiImage = UIImage(data: data) else {
                    withTransaction(transaction) {
                        phase = .failure(URLError(.cannotDecodeContentData))
                    }
                    loadedURL = url
                    return
                }
                onImageSize?(uiImage.size)
                withTransaction(transaction) {
                    phase = .success(Image(uiImage: uiImage))
                }
                loadedURL = url
            } catch is CancellationError {
                // swallow cancellation
            } catch {
                if !Task.isCancelled {
                    withTransaction(transaction) {
                        phase = .failure(error)
                    }
                    loadedURL = url
                }
            }
        }
    }
}
