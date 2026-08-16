import Observation
import SwiftUI
import UIKit
import UserNotifications

enum NotificationsFilter: String, CaseIterable, Identifiable {
    case all = "Tutte"
    case unread = "Non lette"
    case comments = "Commenti"

    var id: String { rawValue }

    var symbolName: String {
        switch self {
        case .all: return "line.3.horizontal"
        case .unread: return "circle.fill"
        case .comments: return "bubble.left.fill"
        }
    }
}

@Observable
@MainActor
final class NotificationsViewModel {
    private let repository: NotificationRepository

    var notifications: [AppNotification] = []
    var filter: NotificationsFilter = .all
    var isLoading = false
    var isUpdating = false
    var errorMessage: String?

    init(repository: NotificationRepository) {
        self.repository = repository
    }

    var filteredNotifications: [AppNotification] {
        notifications.filter { notification in
            switch filter {
            case .all: return true
            case .unread: return !notification.read
            case .comments:
                return Self.commentTypes.contains(notification.type)
            }
        }
    }

    var unreadCount: Int {
        notifications.filter { !$0.read }.count
    }

    func load(userID: String) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            notifications = try await repository.fetchNotifications(userID: userID)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markAsRead(userID: String, notificationID: String) async {
        guard let index = notifications.firstIndex(where: { $0.id == notificationID }), !notifications[index].read else { return }
        do {
            try await repository.markAsRead(userID: userID, notificationID: notificationID)
            notifications[index].read = true
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func markAllAsRead(userID: String) async {
        guard unreadCount > 0 else { return }
        isUpdating = true
        defer { isUpdating = false }
        do {
            try await repository.markAllAsRead(userID: userID)
            for index in notifications.indices { notifications[index].read = true }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    static let commentTypes: Set<String> = [
        "post_comment", "rating_comment", "comment_like", "post_mention", "comment_on_post", "comment_reply"
    ]
}

struct NotificationsView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    private let disablesAutomaticLoading: Bool
    @State private var viewModel: NotificationsViewModel
    @State private var pushAuthorizationStatus: UNAuthorizationStatus = .notDetermined
    @Environment(\.openURL) private var openURL

    init(container: AppContainer, session: SessionStore, shell: AppShellStore) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = false
        _viewModel = State(initialValue: NotificationsViewModel(repository: container.notificationRepository))
    }

#if DEBUG
    init(container: AppContainer, session: SessionStore, shell: AppShellStore, previewViewModel: NotificationsViewModel) {
        self.container = container
        self.session = session
        self.shell = shell
        disablesAutomaticLoading = true
        _viewModel = State(initialValue: previewViewModel)
    }
#endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !session.isAuthenticated {
                    EmptyStateView(
                        title: "Inbox privata",
                        message: "Accedi per vedere recommendation, commenti, follow e messaggi in un unico posto.",
                        systemImage: "bell.slash.fill",
                        actionTitle: "Accedi"
                    ) { shell.presentAuth() }
                } else {
                    pageHeader
                    summaryRow
                    filtersRow
                    listContent
                    if shouldShowPushCTA {
                        pushPermissionCard
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            .padding(.bottom, 100)
        }
        .background(TwoWatchBackground())
        .navigationTitle("Notifiche")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: session.firebaseUser?.uid) {
            guard !disablesAutomaticLoading else { return }
            if let uid = session.firebaseUser?.uid { await viewModel.load(userID: uid) }
            pushAuthorizationStatus = await container.pushNotifications.currentAuthorizationStatus()
            shell.notificationUnreadCount = viewModel.unreadCount
        }
        .refreshable {
            guard !disablesAutomaticLoading else { return }
            if let uid = session.firebaseUser?.uid { await viewModel.load(userID: uid) }
            pushAuthorizationStatus = await container.pushNotifications.currentAuthorizationStatus()
            shell.notificationUnreadCount = viewModel.unreadCount
        }
        .onChange(of: viewModel.unreadCount) { _, newCount in
            shell.notificationUnreadCount = newCount
        }
        .alert("Errore", isPresented: Binding(get: { viewModel.errorMessage != nil }, set: { _ in viewModel.errorMessage = nil })) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(viewModel.errorMessage ?? "")
        }
    }

    // MARK: - Page title row

    private var pageHeader: some View {
        Text("Notifiche")
            .font(.system(size: 34, weight: .black, design: .rounded))
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var summaryRow: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "bell.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Group {
                    Text("\(viewModel.notifications.count)")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .monospacedDigit()
                    Text("notifiche totali")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
            }
            Divider().frame(height: 18).overlay(TwoWatchTheme.border)
            HStack(spacing: 6) {
                Text("\(viewModel.unreadCount)")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .monospacedDigit()
                Text("non lette")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                if viewModel.unreadCount > 0 {
                    Circle()
                        .fill(TwoWatchTheme.accent)
                        .frame(width: 8, height: 8)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(TwoWatchTheme.panel, in: Capsule())
        .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private var filtersRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(NotificationsFilter.allCases) { filter in
                    let isActive = viewModel.filter == filter
                    Button {
                        withAnimation(.easeInOut(duration: 0.15)) { viewModel.filter = filter }
                    } label: {
                        HStack(spacing: 5) {
                            if filter == .unread {
                                Circle().fill(isActive ? Color.black : TwoWatchTheme.accent).frame(width: 6, height: 6)
                            } else {
                                Image(systemName: filter.symbolName).font(.caption.weight(.bold))
                            }
                            Text(filter.rawValue)
                                .font(.subheadline.weight(.semibold))
                        }
                        .foregroundStyle(isActive ? Color.black : TwoWatchTheme.textPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(
                            isActive ? AnyShapeStyle(TwoWatchTheme.accent) : AnyShapeStyle(TwoWatchTheme.panelStrong),
                            in: Capsule()
                        )
                        .overlay(Capsule().stroke(isActive ? Color.clear : TwoWatchTheme.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }

                if viewModel.unreadCount > 0 {
                    Button {
                        if let uid = session.firebaseUser?.uid {
                            Task { await viewModel.markAllAsRead(userID: uid) }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            if viewModel.isUpdating {
                                ProgressView().tint(TwoWatchTheme.accent).controlSize(.small)
                            } else {
                                Image(systemName: "checkmark.circle")
                                    .font(.caption.weight(.bold))
                            }
                            Text("Segna tutte come lette")
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                        }
                        .foregroundStyle(TwoWatchTheme.accent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .overlay(Capsule().stroke(TwoWatchTheme.accent.opacity(0.45), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(viewModel.isUpdating)
                }
            }
            .padding(.horizontal, 1)
        }
        .scrollClipDisabled()
    }

    // MARK: - List grouped by recency

    @ViewBuilder
    private var listContent: some View {
        if viewModel.filteredNotifications.isEmpty && !viewModel.isLoading {
            EmptyStateView(
                title: LocalizedStringKey(emptyTitle),
                message: LocalizedStringKey(emptyMessage),
                systemImage: "bell.slash"
            )
            .padding(.top, 8)
        } else {
            // LazyVStack: l'inbox non ha un tetto, e con VStack ogni riga
            // veniva costruita anche a centinaia di elementi fuori schermo.
            // Solo il livello esterno: i gruppi interni sono piccoli e la
            // pigrizia annidata non aggiunge niente.
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(groupedNotifications, id: \.title) { group in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(group.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                        VStack(spacing: 8) {
                            ForEach(group.items) { notification in
                                notificationRow(notification)
                            }
                        }
                    }
                }
            }
        }
    }

    private var emptyTitle: String {
        switch viewModel.filter {
        case .all: return "Nessuna notifica"
        case .unread: return String(localized: "Sei in pari")
        case .comments: return String(localized: "Nessun commento")
        }
    }

    private var emptyMessage: String {
        switch viewModel.filter {
        case .all: return String(localized: "Quando arrivano commenti, like, recommendation o thread message le trovi qui.")
        case .unread: return String(localized: "Hai letto tutte le notifiche più recenti. Torna più tardi.")
        case .comments: return "I commenti ai tuoi post o alle tue recensioni compariranno qui."
        }
    }

    private struct NotificationsGroup {
        let title: String
        let items: [AppNotification]
    }

    private var groupedNotifications: [NotificationsGroup] {
        let calendar = Calendar.current
        let now = Date()
        var today: [AppNotification] = []
        var thisWeek: [AppNotification] = []
        var earlier: [AppNotification] = []

        for notif in viewModel.filteredNotifications {
            guard let created = notif.createdAt else { earlier.append(notif); continue }
            if calendar.isDateInToday(created) {
                today.append(notif)
            } else if let days = calendar.dateComponents([.day], from: created, to: now).day, days < 7 {
                thisWeek.append(notif)
            } else {
                earlier.append(notif)
            }
        }

        var groups: [NotificationsGroup] = []
        if !today.isEmpty { groups.append(.init(title: "Oggi", items: today)) }
        if !thisWeek.isEmpty { groups.append(.init(title: String(localized: "Questa settimana"), items: thisWeek)) }
        if !earlier.isEmpty { groups.append(.init(title: "Prima", items: earlier)) }
        return groups
    }

    // MARK: - Row navigation

    @ViewBuilder
    private func notificationRow(_ notification: AppNotification) -> some View {
        switch notification.destination {
        case let .title(id, focus):
            NavigationLink {
                TitleDetailView(container: container, session: session, shell: shell, titleID: id, initialFocus: focus)
            } label: {
                NotificationRowView(notification: notification)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded { handleTap(notification) })
        case let .thread(id):
            NavigationLink {
                ThreadDetailView(container: container, session: session, shell: shell, threadID: id)
            } label: {
                NotificationRowView(notification: notification)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded { handleTap(notification) })
        case .threads:
            NavigationLink {
                ThreadsListView(container: container, session: session, shell: shell)
            } label: {
                NotificationRowView(notification: notification)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded { handleTap(notification) })
        case .profileInbox:
            NavigationLink {
                ProfileInboxView(container: container, session: session, shell: shell)
            } label: {
                NotificationRowView(notification: notification)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded { handleTap(notification) })
        case let .profile(uid) where uid != session.firebaseUser?.uid:
            NavigationLink {
                UserProfileDetailView(container: container, session: session, shell: shell, userID: uid)
            } label: {
                NotificationRowView(notification: notification)
            }
            .buttonStyle(.plain)
            .simultaneousGesture(TapGesture().onEnded { handleTap(notification) })
        case .post:
            // Passa da `shell.present`: apriva la sheet dei commenti mentre la
            // schermata notifiche era ancora presentata, e SwiftUI monta una
            // sola sheet per volta → il tap sembrava non fare niente finché non
            // chiudevi le notifiche a mano. `present` chiude prima e apre dopo.
            Button {
                Task { await open(notification) }
            } label: {
                NotificationRowView(notification: notification)
            }
            .buttonStyle(.plain)
        default:
            Button {
                Task { await open(notification) }
            } label: {
                NotificationRowView(notification: notification)
            }
            .buttonStyle(.plain)
        }
    }

    /// Centralizza tap notifica: logga l'evento Analytics e marca read.
    /// Chiamato dai tap path (NavigationLink + Button) per evitare duplicati.
    private func handleTap(_ notification: AppNotification) {
        container.analytics.log(AnalyticsEvent.notificationOpened, [
            "type": notification.type,
            "target_id": notificationTargetID(notification)
        ])
        markRead(notification.id)
    }

    private func notificationTargetID(_ notification: AppNotification) -> String {
        switch notification.destination {
        case let .title(id, _): return id
        case let .thread(id): return id
        case let .profile(uid): return uid
        case let .post(id): return id
        case let .titlesImport(importId): return importId ?? ""
        default: return ""
        }
    }

    private func markRead(_ id: String) {
        if let uid = session.firebaseUser?.uid {
            Task { await viewModel.markAsRead(userID: uid, notificationID: id) }
        }
    }

    private func open(_ notification: AppNotification) async {
        guard let uid = session.firebaseUser?.uid else { return }
        handleTap(notification)
        if case let .web(url) = notification.destination {
            openURL(url)
            return
        }
        _ = shell.present(destination: notification.destination, currentUserID: uid)
    }

    // MARK: - Push CTA

    private var shouldShowPushCTA: Bool {
        switch pushAuthorizationStatus {
        case .authorized, .provisional, .ephemeral: return false
        case .notDetermined, .denied: return true
        @unknown default: return true
        }
    }

    private var pushPermissionCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "bell.badge")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                Text("Notifiche push")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }
            Text(pushPermissionStatusText)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task {
                    if pushAuthorizationStatus == .denied {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        return
                    }
                    _ = await container.pushNotifications.requestAuthorizationFromUser()
                    pushAuthorizationStatus = await container.pushNotifications.currentAuthorizationStatus()
                }
            } label: {
                Text(pushAuthorizationStatus == .denied ? "Apri Impostazioni iPhone" : "Attiva notifiche push")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.black)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(TwoWatchTheme.accent, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(TwoWatchTheme.border, lineWidth: 1))
    }

    private var pushPermissionStatusText: String {
        switch pushAuthorizationStatus {
        case .notDetermined:
            return String(localized: "Attivale per ricevere recommendation, thread message e commenti anche fuori dall’app.")
        case .denied:
            return String(localized: "Le notifiche push sono disattivate a livello di sistema.")
        case .authorized, .provisional, .ephemeral:
            return "Notifiche push attive."
        @unknown default:
            return ""
        }
    }
}

#if DEBUG
#Preview("Notifiche") {
    NavigationStack {
        NotificationsView(
            container: TwoWatchPreview.container,
            session: TwoWatchPreview.session(),
            shell: TwoWatchPreview.shell(selectedTab: .home),
            previewViewModel: TwoWatchPreview.notificationsViewModel()
        )
    }
}
#endif

// MARK: - Row

private struct NotificationRowView: View {
    let notification: AppNotification

    private var snippetText: String {
        let raw = (notification.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return raw
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            avatar
                .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(notification.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(notification.read ? TwoWatchTheme.textSecondary : TwoWatchTheme.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 6)
                    if let createdAt = notification.createdAt {
                        Text(NotificationRowView.relativeFormatter.localizedString(for: createdAt, relativeTo: Date()))
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .monospacedDigit()
                            .layoutPriority(1)
                    }
                }

                Text(snippetText.isEmpty ? " " : snippetText)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)
                    .multilineTextAlignment(.leading)
                    .opacity(snippetText.isEmpty ? 0 : 1)

                HStack(spacing: 8) {
                    contextRow
                    Spacer(minLength: 0)
                    if !notification.read {
                        Circle()
                            .fill(TwoWatchTheme.accent)
                            .frame(width: 8, height: 8)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TwoWatchTheme.border.opacity(notification.read ? 0.6 : 1), lineWidth: 1))
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        // I "3 giorni fa" della lista notifiche: con it_IT fisso restavano
        // italiani anche con l'interfaccia in inglese.
        f.locale = .autoupdatingCurrent
        return f
    }()

    private var avatar: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let url = notification.avatarURL {
                    CachedAsyncImage(url: url) { phase in
                        switch phase {
                        case let .success(image):
                            image.resizable().scaledToFill()
                        default:
                            placeholder
                        }
                    }
                } else {
                    placeholder
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(Circle())
            .overlay(Circle().stroke(TwoWatchTheme.border, lineWidth: 1))

            if let badgeIcon, let badgeTint {
                Image(systemName: badgeIcon)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 18, height: 18)
                    .background(badgeTint, in: Circle())
                    .overlay(Circle().stroke(TwoWatchTheme.background, lineWidth: 2))
                    .offset(x: 2, y: 2)
            }
        }
    }

    private var badgeIcon: String? {
        switch notification.type {
        case "post_comment", "rating_comment", "comment_on_post", "comment_reply":
            return "bubble.left.fill"
        case "rating_like", "post_like", "comment_like":
            return "heart.fill"
        case "follow", "friend_request", "friend_accept":
            return "person.fill"
        case "watched_with_tag", "engagement_friend_watched":
            return "eye.fill"
        case "new_season_available", "title_update":
            return "tv.fill"
        case "engagement_nudge", "engagement_watchlist_reminder", "engagement_friend_activity":
            return "sparkles"
        default:
            return nil
        }
    }

    private var badgeTint: Color? {
        switch notification.type {
        case "post_comment", "rating_comment", "comment_on_post", "comment_reply":
            return TwoWatchTheme.accent
        case "rating_like", "post_like", "comment_like":
            return TwoWatchTheme.brandPrimary
        case "follow", "friend_request", "friend_accept":
            return TwoWatchTheme.brandSecondary
        case "watched_with_tag", "engagement_friend_watched":
            return TwoWatchTheme.success
        case "new_season_available", "title_update":
            return TwoWatchTheme.warning
        default:
            return TwoWatchTheme.textMuted
        }
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(TwoWatchTheme.panelStrong)
            Text(notification.avatarText.isEmpty ? notification.icon : notification.avatarText)
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
    }

    @ViewBuilder
    private var contextRow: some View {
        if let context = contextLabel {
            HStack(spacing: 6) {
                Image(systemName: contextIcon)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                Text(context)
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
            }
            .padding(.top, 2)
        }
    }

    private var contextLabel: String? {
        // Best-effort context: fall back to the notification icon glyph.
        switch notification.destination {
        case let .title(_, focus), let .titleSlug(_, focus):
            if let focus, !focus.isEmpty { return focus.capitalized }
            return notification.icon.isEmpty ? nil : "Titolo"
        case .post:
            return "Post"
        case .thread, .threads:
            return "Thread"
        case .profile, .profileInbox:
            return "Profilo"
        case .quizChallenges, .quizInvite:
            return "Quiz"
        case .publicList:
            return "Lista"
        case .titlesImport:
            return "Import"
        case .web, .watchlist, .notifications, .widgetGuide:
            return nil
        }
    }

    private var contextIcon: String {
        switch notification.destination {
        case .title: return "film.fill"
        case .post: return "doc.text.fill"
        case .thread, .threads: return "bubble.left.fill"
        case .profile, .profileInbox: return "person.fill"
        case .titlesImport: return "square.and.arrow.down.fill"
        default: return "circle.fill"
        }
    }
}
