import SwiftUI
import UIKit

/// Vetrina di scelta GIF (backend Giphy via `ThreadsRepository.searchGifs`).
/// Query vuota → trending. Ricerca con debounce, griglia a 2 colonne che
/// mostra la still `previewUrl` (leggera) — l'animazione parte solo nella bolla
/// inviata. Paginazione a scroll-end tramite `offset`.
struct GifPickerSheet: View {
    let repository: ThreadsRepository
    let onSelect: (GifResult) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var query: String = ""
    @State private var results: [GifResult] = []
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var loadFailed = false
    @State private var offset = 0
    @State private var hasMore = true
    @State private var searchTask: Task<Void, Never>?

    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10)
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                searchField
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
                    .padding(.bottom, 12)

                content
            }
            .background(TwoWatchBackground())
            .navigationTitle("Aggiungi una GIF")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Chiudi") { dismiss() }
                        .tint(TwoWatchTheme.textSecondary)
                }
            }
        }
        .task {
            if results.isEmpty { await runSearch(reset: true) }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)

            TextField("Cerca una GIF…", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .tint(TwoWatchTheme.brandPrimary)
                .onSubmit { scheduleSearch(debounced: false) }
                .onChange(of: query) { _, _ in scheduleSearch(debounced: true) }

            if !query.isEmpty {
                Button {
                    query = ""
                    scheduleSearch(debounced: false)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancella ricerca")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    @ViewBuilder private var content: some View {
        if isLoading && results.isEmpty {
            Spacer(minLength: 0)
            ProgressView().tint(TwoWatchTheme.brandPrimary)
            Spacer(minLength: 0)
        } else if results.isEmpty {
            ScrollView {
                EmptyStateView(
                    title: loadFailed ? "GIF non disponibili" : "Nessuna GIF trovata",
                    message: loadFailed
                        ? "GIF non disponibili al momento. Riprova più tardi."
                        : "Prova con un'altra ricerca.",
                    systemImage: loadFailed ? "wifi.slash" : "magnifyingglass"
                )
                .padding(.horizontal, 20)
                .padding(.top, 24)
            }
            .scrollDismissesKeyboard(.interactively)
        } else {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 10) {
                    ForEach(results) { gif in
                        gifCell(gif)
                            .onAppear {
                                if gif == results.last { loadMoreIfNeeded() }
                            }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 4)
                .padding(.bottom, 16)

                if isLoadingMore {
                    ProgressView()
                        .tint(TwoWatchTheme.brandPrimary)
                        .padding(.bottom, 24)
                }
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    private func gifCell(_ gif: GifResult) -> some View {
        Button {
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()
            onSelect(gif)
            dismiss()
        } label: {
            CachedAsyncImage(url: URL(string: gif.previewUrl)) { phase in
                switch phase {
                case let .success(image):
                    image
                        .resizable()
                        .scaledToFill()
                case .failure:
                    ZStack {
                        TwoWatchTheme.panel
                        Image(systemName: "photo")
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                default:
                    ZStack {
                        TwoWatchTheme.panel
                        ProgressView().tint(TwoWatchTheme.brandPrimary)
                    }
                }
            }
            .frame(height: 120)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Invia questa GIF")
    }

    private func scheduleSearch(debounced: Bool) {
        searchTask?.cancel()
        searchTask = Task {
            if debounced {
                try? await Task.sleep(nanoseconds: 350_000_000)
                if Task.isCancelled { return }
            }
            await runSearch(reset: true)
        }
    }

    private func runSearch(reset: Bool) async {
        if reset {
            offset = 0
            hasMore = true
            loadFailed = false
            isLoading = true
        }
        defer { isLoading = false }

        do {
            let page = try await repository.searchGifs(query: query, offset: 0)
            if Task.isCancelled { return }
            results = page
            offset = page.count
            hasMore = !page.isEmpty
            loadFailed = false
        } catch {
            if Task.isCancelled { return }
            results = []
            hasMore = false
            loadFailed = true
        }
    }

    private func loadMoreIfNeeded() {
        guard hasMore, !isLoading, !isLoadingMore else { return }
        isLoadingMore = true
        Task {
            defer { isLoadingMore = false }
            do {
                let page = try await repository.searchGifs(query: query, offset: offset)
                if Task.isCancelled { return }
                let existingIDs = Set(results.map(\.id))
                let fresh = page.filter { !existingIDs.contains($0.id) }
                results.append(contentsOf: fresh)
                offset += page.count
                hasMore = !page.isEmpty
            } catch {
                hasMore = false
            }
        }
    }
}
