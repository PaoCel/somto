import SwiftUI

// Testo con menzioni e argomenti navigabili: destinazioni e rendering.
// Estratti da CommunityView.swift.

enum TaggedTextNavigationTarget: Hashable, Identifiable {
    case profile(uid: String)
    case title(id: String)
    case person(Person)

    var id: String {
        switch self {
        case let .profile(uid):
            return "profile:\(uid)"
        case let .title(id):
            return "title:\(id)"
        case let .person(person):
            return "person:\(person.id)"
        }
    }
}

enum TaggedTextLinkDestination {
    case profile(uid: String)
    case title(id: String)
    case person(id: String, name: String)

    private static let scheme = "twowatch-inline"

    init?(url: URL) {
        guard url.scheme == Self.scheme else { return nil }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let host = url.host ?? ""
        let queryItems = components?.queryItems ?? []

        switch host {
        case "profile":
            guard let uid = queryItems.first(where: { $0.name == "uid" })?.value, !uid.isEmpty else { return nil }
            self = .profile(uid: uid)
        case "title":
            guard let id = queryItems.first(where: { $0.name == "id" })?.value, !id.isEmpty else { return nil }
            self = .title(id: id)
        case "person":
            guard
                let id = queryItems.first(where: { $0.name == "id" })?.value,
                let name = queryItems.first(where: { $0.name == "name" })?.value,
                !id.isEmpty,
                !name.isEmpty
            else {
                return nil
            }
            self = .person(id: id, name: name)
        default:
            return nil
        }
    }

    static func url(for token: TaggedTextToken) -> URL? {
        var components = URLComponents()
        components.scheme = scheme

        switch token.kind {
        case .user:
            components.host = "profile"
            components.queryItems = [URLQueryItem(name: "uid", value: token.targetID)]
        case .title:
            components.host = "title"
            components.queryItems = [URLQueryItem(name: "id", value: token.targetID)]
        case .person:
            components.host = "person"
            components.queryItems = [
                URLQueryItem(name: "id", value: token.targetID),
                URLQueryItem(name: "name", value: token.label)
            ]
        case .unresolvedUser:
            return nil
        }

        return components.url
    }
}

struct InteractiveTaggedText: View {
    let source: String
    let font: Font
    let textColor: Color
    let accentColor: Color
    let lineLimit: Int?
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var navigationTarget: TaggedTextNavigationTarget?

    init(
        source: String,
        font: Font,
        textColor: Color,
        accentColor: Color = TwoWatchTheme.accent,
        lineLimit: Int? = nil,
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore
    ) {
        self.source = source
        self.font = font
        self.textColor = textColor
        self.accentColor = accentColor
        self.lineLimit = lineLimit
        self.container = container
        self.session = session
        self.shell = shell
    }

    var body: some View {
        Text(attributedText)
            .font(font)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                handleOpenURL(url)
            })
            .navigationDestination(item: $navigationTarget) { target in
                switch target {
                case let .profile(uid):
                    UserProfileDetailView(container: container, session: session, shell: shell, userID: uid)
                case let .title(id):
                    TitleDetailView(container: container, session: session, shell: shell, titleID: id)
                case let .person(person):
                    PersonTitlesView(container: container, session: session, shell: shell, person: person)
                }
            }
    }

    private var attributedText: AttributedString {
        let tokens = TaggedTextFormatter.tokens(in: source)
        guard !tokens.isEmpty else { return plainSegment(source) }

        let nsSource = source as NSString
        var output = AttributedString()
        var cursor = 0

        for token in tokens {
            if token.range.location > cursor {
                let leadingRange = NSRange(location: cursor, length: token.range.location - cursor)
                output.append(plainSegment(nsSource.substring(with: leadingRange)))
            }

            output.append(tokenSegment(token))
            cursor = NSMaxRange(token.range)
        }

        if cursor < nsSource.length {
            output.append(plainSegment(nsSource.substring(from: cursor)))
        }

        return output
    }

    private func plainSegment(_ text: String) -> AttributedString {
        var segment = AttributedString(text)
        segment.foregroundColor = textColor
        return segment
    }

    private func tokenSegment(_ token: TaggedTextToken) -> AttributedString {
        var segment = AttributedString(token.displayText)
        segment.foregroundColor = tokenColor(for: token.kind)
        if token.kind != .unresolvedUser {
            segment.underlineStyle = .single
            segment.link = TaggedTextLinkDestination.url(for: token)
        }
        return segment
    }

    private func tokenColor(for kind: TaggedTextTokenKind) -> Color {
        switch kind {
        case .user, .unresolvedUser:
            return TwoWatchTheme.brandPrimary
        case .title:
            return accentColor
        case .person:
            return TwoWatchTheme.warning
        }
    }

    private func handleOpenURL(_ url: URL) -> OpenURLAction.Result {
        guard let destination = TaggedTextLinkDestination(url: url) else {
            return .systemAction
        }

        switch destination {
        case let .profile(uid):
            navigationTarget = .profile(uid: uid)
        case let .title(id):
            navigationTarget = .title(id: id)
        case let .person(id, name):
            navigationTarget = .person(Person(
                id: id,
                name: name,
                nameLower: SearchNormalizer.normalize(name),
                avatarURL: nil,
                roles: [],
                occurrences: 0
            ))
        }

        return .handled
    }
}
