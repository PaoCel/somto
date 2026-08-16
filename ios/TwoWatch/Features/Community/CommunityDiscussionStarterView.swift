import SwiftUI

/// Card "Apri una discussione" — port di `#discussionStarter` (`public/community.html`
/// righe ~39-92 + `public/js/pages/community.page.js` righe ~880-966). Due modi per
/// iniziare un thread pubblico:
/// 1. Ricerca titolo inline → `ensurePublicThread(titleID:)` → apre il thread.
/// 2. Spunto ("prompt") → prefill del composer post via `shell.composerPrefillText`.
/// Solo per utenti autenticati (i guest non possono creare thread né postare).
struct CommunityDiscussionStarterCard: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var isSearchExpanded = false
    @State private var searchQuery = ""
    @State private var searchResults: [Title] = []
    @State private var isSearching = false
    @State private var isStartingThread = false
    @State private var searchErrorMessage: String?
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var isSearchFieldFocused: Bool

    private let prompts: [DiscussionPrompt] = [
        DiscussionPrompt(
            icon: "tv",
            tint: TwoWatchTheme.brandSecondary,
            text: String(localized: "Cosa hai visto stasera?")
        ),
        DiscussionPrompt(
            icon: "star.fill",
            tint: TwoWatchTheme.warning,
            text: String(localized: "Consiglia una serie sottovalutata")
        ),
        DiscussionPrompt(
            icon: "hand.thumbsdown.fill",
            tint: TwoWatchTheme.brandPrimary,
            text: String(localized: "Un film che ti ha deluso di recente?")
        )
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Apri una discussione")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Scegli un titolo oppure parti da uno spunto per iniziare il thread.")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            titleSearchToggleButton

            if isSearchExpanded {
                titleSearchSection
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            promptsDivider

            VStack(spacing: 8) {
                ForEach(prompts) { prompt in
                    Button {
                        shell.composerPrefillText = prompt.text
                    } label: {
                        DiscussionPromptRow(prompt: prompt)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(prompt.text)
                    .accessibilityHint("Usa questo spunto per il tuo post")
                }
            }
        }
        .padding(16)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.2), value: isSearchExpanded)
    }

    private var titleSearchToggleButton: some View {
        Button {
            isSearchExpanded.toggle()
            if isSearchExpanded {
                isSearchFieldFocused = true
            } else {
                resetSearch()
            }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle().fill(TwoWatchTheme.brandPrimary.opacity(0.16))
                    Image(systemName: "magnifyingglass")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
                .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Scegli un titolo")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Cerca un film o una serie e apri il thread")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .rotationEffect(.degrees(isSearchExpanded ? 90 : 0))
                    .accessibilityHidden(true)
            }
            .padding(14)
            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scegli un titolo")
        .accessibilityHint("Cerca un film o una serie e apri il thread")
    }

    private var titleSearchSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(TwoWatchTheme.textMuted)
                TextField("Cerca un film o una serie…", text: $searchQuery)
                    .focused($isSearchFieldFocused)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.search)
                    .onChange(of: searchQuery) { _, newValue in
                        scheduleSearch(newValue)
                    }

                if isSearching {
                    ProgressView().tint(TwoWatchTheme.textSecondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .accessibilityLabel("Cerca un titolo su cui aprire la discussione")

            if let searchErrorMessage {
                Text(searchErrorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            } else if !searchResults.isEmpty {
                VStack(spacing: 6) {
                    ForEach(searchResults) { title in
                        Button {
                            Task { await startThread(titleID: title.id) }
                        } label: {
                            DiscussionSearchResultRow(title: title, isStarting: isStartingThread)
                        }
                        .buttonStyle(.plain)
                        .disabled(isStartingThread)
                        .accessibilityLabel("Apri il thread su \(title.name)")
                    }
                }
            } else if !trimmedQuery.isEmpty, !isSearching {
                Text("Nessun titolo trovato per \u{201C}\(trimmedQuery)\u{201D}.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
        }
    }

    private var promptsDivider: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkle")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)
            Text("Oppure prova uno spunto")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .lineLimit(1)
            Rectangle()
                .fill(TwoWatchTheme.border)
                .frame(height: 1)
        }
    }

    private var trimmedQuery: String {
        searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func scheduleSearch(_ query: String) {
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            isSearching = false
            searchErrorMessage = nil
            return
        }

        searchErrorMessage = nil
        isSearching = true
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }

            do {
                let results = try await container.titleRepository.searchTitles(trimmed, limit: 8)
                guard !Task.isCancelled else { return }
                searchResults = results
                isSearching = false
            } catch {
                guard !Task.isCancelled else { return }
                searchResults = []
                isSearching = false
                searchErrorMessage = "Errore nella ricerca."
            }
        }
    }

    private func startThread(titleID: String) async {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }

        isStartingThread = true
        searchErrorMessage = nil
        defer { isStartingThread = false }

        do {
            let thread = try await container.threadsRepository.ensurePublicThread(titleID: titleID, createdBy: uid)
            resetSearch()
            isSearchExpanded = false
            shell.activePresentedSheet = .thread(id: thread.id)
        } catch {
            searchErrorMessage = UserFacingError.message(for: error)
        }
    }

    private func resetSearch() {
        searchTask?.cancel()
        searchTask = nil
        searchQuery = ""
        searchResults = []
        isSearching = false
        searchErrorMessage = nil
    }
}

struct DiscussionPrompt: Identifiable, Hashable {
    let icon: String
    let tint: Color
    let text: String

    var id: String { text }
}

private struct DiscussionPromptRow: View {
    let prompt: DiscussionPrompt

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(prompt.tint.opacity(0.16))
                Image(systemName: prompt.icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(prompt.tint)
            }
            .frame(width: 32, height: 32)

            Text(prompt.text)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .accessibilityHidden(true)
        }
        .padding(12)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

private struct DiscussionSearchResultRow: View {
    let title: Title
    let isStarting: Bool

    var body: some View {
        HStack(spacing: 12) {
            PosterImageView(url: title.posterPath, width: 40, height: 58, cornerRadius: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(title.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                Text(title.subtitle)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if isStarting {
                ProgressView().tint(TwoWatchTheme.textSecondary)
            } else {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .accessibilityHidden(true)
            }
        }
        .padding(10)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
