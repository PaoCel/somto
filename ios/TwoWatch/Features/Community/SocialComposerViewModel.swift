import Observation
import SwiftUI

// Composer sociale: tipi dell'autocomplete (menzioni e argomenti) e il
// ViewModel che li risolve. Estratti da CommunityView.swift.

enum AutocompleteTopicScope: Hashable {
    case titlesOnly
    case titlesAndPeople
}

enum ComposerSuggestionKind: String, Hashable {
    case user
    case title
    case person
}

enum ComposerActiveMentionType: Hashable {
    case user
    case topic
}

struct ComposerResolvedToken: Hashable {
    let display: String
    let resolved: String
}

struct ComposerSuggestion: Identifiable, Hashable {
    let targetID: String
    let label: String
    let kind: ComposerSuggestionKind
    let subtitle: String
    let avatarURL: URL?
    let score: Int

    var id: String {
        "\(kind.rawValue):\(targetID)"
    }

    var displayToken: String {
        switch kind {
        case .user:
            return "@\(label)"
        case .title, .person:
            return "#\(label)"
        }
    }

    var resolvedToken: String {
        switch kind {
        case .user:
            return "@{\(label)}(\(targetID))"
        case .title:
            return "#[\(label)](\(targetID))"
        case .person:
            return "#[\(label)](person:\(targetID))"
        }
    }

    var badge: String {
        switch kind {
        case .user:
            return "@"
        case .title, .person:
            return "#"
        }
    }
}

struct ComposerActiveMention: Equatable {
    let type: ComposerActiveMentionType
    let start: Int
    let query: String
}

@Observable
@MainActor
final class SocialComposerViewModel {
    @ObservationIgnored private let titleRepository: TitleRepository
    @ObservationIgnored private let userRepository: UserRepository
    @ObservationIgnored private let topicScope: AutocompleteTopicScope
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var cachedFriends: [AppUser]?
    @ObservationIgnored private var activeMention: ComposerActiveMention?
    @ObservationIgnored private var resolvedTokens: [ComposerResolvedToken] = []

    let characterLimit: Int
    var text = ""
    var suggestions: [ComposerSuggestion] = []
    var selectedSuggestionIndex = 0
    var selectedRange = NSRange(location: 0, length: 0)
    var editorHeight: CGFloat = 22
    var shouldRefocusEditor = false

    init(
        titleRepository: TitleRepository,
        userRepository: UserRepository,
        topicScope: AutocompleteTopicScope = .titlesAndPeople,
        characterLimit: Int = 1000
    ) {
        self.titleRepository = titleRepository
        self.userRepository = userRepository
        self.topicScope = topicScope
        self.characterLimit = characterLimit
    }

    var canSubmit: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.count <= characterLimit
    }

    var isSuggestionsPresented: Bool {
        activeMention != nil && !suggestions.isEmpty
    }

    var highlightedSuggestion: ComposerSuggestion? {
        guard !suggestions.isEmpty else { return nil }
        let safeIndex = min(max(0, selectedSuggestionIndex), suggestions.count - 1)
        return suggestions[safeIndex]
    }

    func handleEditorChange(_ text: String, selection: NSRange, currentUserID: String?, canSearchUsers: Bool) {
        self.text = text
        self.selectedRange = clamped(range: selection, maxLength: (text as NSString).length)
        shouldRefocusEditor = false
        resolvedTokens.removeAll { token in
            !text.contains(token.display)
        }
        scheduleAutocomplete(currentUserID: currentUserID, canSearchUsers: canSearchUsers)
    }

    func acceptHighlightedSuggestion() -> Bool {
        guard let suggestion = highlightedSuggestion else { return false }
        applySuggestion(suggestion)
        return true
    }

    func selectSuggestion(_ suggestion: ComposerSuggestion) {
        applySuggestion(suggestion)
    }

    private func scheduleAutocomplete(currentUserID: String?, canSearchUsers: Bool) {
        searchTask?.cancel()
        let mention = activeMentionCandidate(in: text, cursorLocation: selectedRange.location)
        activeMention = mention

        guard let mention else {
            closeAutocomplete()
            return
        }

        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 120_000_000)
            guard let self, !Task.isCancelled else { return }

            let items = await self.loadSuggestions(
                for: mention,
                currentUserID: currentUserID,
                canSearchUsers: canSearchUsers
            )
            guard !Task.isCancelled else { return }

            let latestMention = self.activeMentionCandidate(
                in: self.text,
                cursorLocation: self.selectedRange.location
            )
            guard latestMention == mention else { return }

            self.activeMention = latestMention
            self.suggestions = items
            self.selectedSuggestionIndex = 0
        }
    }

    private func loadSuggestions(
        for mention: ComposerActiveMention,
        currentUserID: String?,
        canSearchUsers: Bool
    ) async -> [ComposerSuggestion] {
        switch mention.type {
        case .topic:
            return await loadTopicSuggestions(query: mention.query)
        case .user:
            return await loadUserSuggestions(
                query: mention.query,
                currentUserID: currentUserID,
                canSearchUsers: canSearchUsers
            )
        }
    }

    private func loadTopicSuggestions(query: String) async -> [ComposerSuggestion] {
        let normalized = SearchNormalizer.normalize(query)
        if normalized.isEmpty {
            var titles: [Title] = []
            do { titles = try await titleRepository.listPopularTitles(limit: 6) } catch { SilentFailure.record(error, context: "Composer.popularTitles") }
            let people: [Person]
            if topicScope == .titlesAndPeople {
                do { people = try await titleRepository.listPopularPeople(limit: 4) } catch { SilentFailure.record(error, context: "Composer.popularPeople"); people = [] }
            } else {
                people = []
            }
            return mergeTopicSuggestions(titles: titles, people: people, normalizedQuery: normalized)
        }

        async let titlesTask = titleRepository.searchTitles(query, limit: 6)
        var titles: [Title] = []
        do { titles = try await titlesTask } catch { SilentFailure.record(error, context: "Composer.titleSuggestions") }
        let people: [Person]
        if topicScope == .titlesAndPeople {
            do { people = try await titleRepository.searchPeople(query, limit: 6) } catch { SilentFailure.record(error, context: "Composer.searchPeople"); people = [] }
        } else {
            people = []
        }

        return mergeTopicSuggestions(titles: titles, people: people, normalizedQuery: normalized)
    }

    private func mergeTopicSuggestions(
        titles: [Title],
        people: [Person],
        normalizedQuery: String
    ) -> [ComposerSuggestion] {
        let titleSuggestions = titles
            .filter { !$0.id.isEmpty && !$0.name.isEmpty }
            .map { title in
                ComposerSuggestion(
                    targetID: title.id,
                    label: title.name,
                    kind: .title,
                    subtitle: title.subtitle,
                    avatarURL: title.posterPath,
                    score: score(label: title.name, normalizedQuery: normalizedQuery)
                )
            }

        let peopleSuggestions = people
            .filter { !$0.id.isEmpty && !$0.name.isEmpty }
            .map { person in
                ComposerSuggestion(
                    targetID: person.id,
                    label: person.name,
                    kind: .person,
                    subtitle: person.roles.map(roleLabel).joined(separator: " • "),
                    avatarURL: person.avatarURL,
                    score: score(label: person.name, normalizedQuery: normalizedQuery)
                )
            }

        return (titleSuggestions + peopleSuggestions)
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                if lhs.kind != rhs.kind { return lhs.kind == .title }
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
            .prefix(8)
            .map { $0 }
    }

    private func loadUserSuggestions(
        query: String,
        currentUserID: String?,
        canSearchUsers: Bool
    ) async -> [ComposerSuggestion] {
        let normalized = SearchNormalizer.normalize(query)

        if cachedFriends == nil, let currentUserID, !currentUserID.isEmpty {
            do { cachedFriends = try await userRepository.listAcceptedFriends(userID: currentUserID) } catch { SilentFailure.record(error, context: "Composer.friends"); cachedFriends = [] }
        }

        let friendSuggestions = (cachedFriends ?? [])
            .filter { user in
                let name = user.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return false }
                if normalized.isEmpty { return true }
                return SearchNormalizer.normalize(name).contains(normalized)
            }
            .map { user in
                ComposerSuggestion(
                    targetID: user.id,
                    label: user.displayName,
                    kind: .user,
                    subtitle: "@\(user.displayNameLower)",
                    avatarURL: user.photoURL ?? user.avatarURL,
                    score: score(label: user.displayName, normalizedQuery: normalized) + 1
                )
            }

        var publicUsers: [AppUser] = []
        if canSearchUsers, !normalized.isEmpty {
            do {
                publicUsers = try await userRepository.searchUsers(prefix: query, limit: 10)
            } catch {
                SilentFailure.record(error, context: "Composer.searchUsers")
            }
        }
        let publicSuggestions = publicUsers.map { user in
            ComposerSuggestion(
                targetID: user.id,
                label: user.displayName,
                kind: .user,
                subtitle: "@\(user.displayNameLower)",
                avatarURL: user.photoURL ?? user.avatarURL,
                score: score(label: user.displayName, normalizedQuery: normalized)
            )
        }

        var deduped: [String: ComposerSuggestion] = [:]
        for item in friendSuggestions + publicSuggestions {
            if let existing = deduped[item.targetID], existing.score >= item.score {
                continue
            }
            deduped[item.targetID] = item
        }

        return deduped.values
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
            .prefix(8)
            .map { $0 }
    }

    private func activeMentionCandidate(in text: String, cursorLocation: Int) -> ComposerActiveMention? {
        let nsText = text as NSString
        let safeCursor = min(max(0, cursorLocation), nsText.length)
        let prefix = nsText.substring(to: safeCursor) as NSString
        var candidates: [ComposerActiveMention] = []

        for symbol in ["@", "#"] {
            let range = prefix.range(of: symbol, options: .backwards)
            guard range.location != NSNotFound else { continue }

            if range.location > 0 {
                let previous = prefix.substring(with: NSRange(location: range.location - 1, length: 1))
                if previous.range(of: "[\\s(]", options: .regularExpression) == nil {
                    continue
                }
            }

            let queryStart = range.location + 1
            let queryLength = prefix.length - queryStart
            let query = queryLength > 0
                ? prefix.substring(with: NSRange(location: queryStart, length: queryLength))
                : ""

            if symbol == "@" {
                if query.hasPrefix("{") || query.range(of: "[\\s\\]\\)\\}]", options: .regularExpression) != nil {
                    continue
                }
                let fullDisplay = "@\(query)"
                if isAlreadyInserted(displayToken: fullDisplay) {
                    continue
                }
                candidates.append(ComposerActiveMention(type: .user, start: range.location, query: query))
            } else {
                if query.hasPrefix("[") || query.range(of: "[\\]\\)\\}]", options: .regularExpression) != nil {
                    continue
                }
                let fullDisplay = "#\(query)"
                if isAlreadyInserted(displayToken: fullDisplay) {
                    continue
                }
                candidates.append(ComposerActiveMention(type: .topic, start: range.location, query: query))
            }
        }

        return candidates.sorted { $0.start > $1.start }.first
    }

    private func isAlreadyInserted(displayToken: String) -> Bool {
        resolvedTokens.contains { token in
            guard displayToken.hasPrefix(token.display) else { return false }
            let remaining = displayToken.dropFirst(token.display.count)
            return remaining.isEmpty || remaining.first?.isWhitespace == true
        }
    }

    private func applySuggestion(_ suggestion: ComposerSuggestion) {
        guard let mention = activeMention else { return }
        let nsText = text as NSString
        let safeCursor = min(max(mention.start, selectedRange.location), nsText.length)
        let replaceRange = NSRange(location: mention.start, length: safeCursor - mention.start)
        guard NSMaxRange(replaceRange) <= nsText.length else { return }

        let insertion = suggestion.displayToken + " "
        text = nsText.replacingCharacters(in: replaceRange, with: insertion)
        selectedRange = NSRange(location: mention.start + (insertion as NSString).length, length: 0)
        resolvedTokens.append(ComposerResolvedToken(display: suggestion.displayToken, resolved: suggestion.resolvedToken))
        shouldRefocusEditor = true
        closeAutocomplete()
    }

    func resolvedTextForSubmission(_ source: String? = nil) -> String {
        let rawSource = source ?? text
        let sortedTokens = resolvedTokens.sorted { lhs, rhs in
            lhs.display.count > rhs.display.count
        }
        return sortedTokens.reduce(rawSource) { partial, token in
            partial.replacingOccurrences(of: token.display, with: token.resolved)
        }
    }

    func reset() {
        text = ""
        suggestions = []
        selectedSuggestionIndex = 0
        selectedRange = NSRange(location: 0, length: 0)
        editorHeight = 22
        resolvedTokens.removeAll()
        activeMention = nil
        shouldRefocusEditor = false
    }

    /// Pre-fills the composer with a resolved @-mention of a user, used when
    /// replying to a comment so the parent author is tagged automatically.
    /// The token resolves to the canonical `@{name}(uid)` form on submit.
    func seedMention(label: String, uid: String) {
        reset()
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedUID = uid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedLabel.isEmpty, !trimmedUID.isEmpty else {
            shouldRefocusEditor = true
            return
        }
        let display = "@\(trimmedLabel)"
        let insertion = display + " "
        text = insertion
        selectedRange = NSRange(location: (insertion as NSString).length, length: 0)
        resolvedTokens = [
            ComposerResolvedToken(display: display, resolved: "@{\(trimmedLabel)}(\(trimmedUID))")
        ]
        shouldRefocusEditor = true
    }

    private func closeAutocomplete() {
        searchTask?.cancel()
        suggestions = []
        selectedSuggestionIndex = 0
        activeMention = nil
    }

    private func score(label: String, normalizedQuery: String) -> Int {
        if normalizedQuery.isEmpty { return 1 }
        let normalizedLabel = SearchNormalizer.normalize(label)
        if normalizedLabel.hasPrefix(normalizedQuery) { return 3 }
        if normalizedLabel.contains(normalizedQuery) { return 2 }
        return 1
    }

    private func roleLabel(_ role: String) -> String {
        switch role {
        case "actor":
            return "Attore"
        case "director":
            return "Regista"
        default:
            return role.capitalized
        }
    }

    private func clamped(range: NSRange, maxLength: Int) -> NSRange {
        let safeLocation = min(max(0, range.location), maxLength)
        let remaining = max(0, maxLength - safeLocation)
        let safeLength = min(max(0, range.length), remaining)
        return NSRange(location: safeLocation, length: safeLength)
    }
}
