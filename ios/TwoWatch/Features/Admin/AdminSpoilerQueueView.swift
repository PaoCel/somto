@preconcurrency import FirebaseFirestore
import Observation
import SwiftUI

/// Item nella coda di moderazione spoiler (`moderationQueue` con
/// `type == "spoiler_suspect"`). I doc sono scritti dai trigger
/// `flagSuspectedSpoiler*` quando il regex matcher trova un possibile
/// spoiler in un contenuto NON flaggato dall'autore.
struct SpoilerQueueItem: Identifiable, Hashable {
    let id: String
    let source: String
    let docPath: String
    let authorUid: String?
    let preview: String
    let matchedPattern: String
    let matchedText: String
    let titleIds: [String]
    let createdAt: Date?
    let status: String
}

@Observable
@MainActor
final class AdminSpoilerQueueViewModel {
    let container: AppContainer
    let session: SessionStore

    var items: [SpoilerQueueItem] = []
    var isLoading = false
    var errorMessage: String?
    var inFlightID: String?

    init(container: AppContainer, session: SessionStore) {
        self.container = container
        self.session = session
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        errorMessage = nil

        do {
            let snap = try await Firestore.firestore()
                .collection("moderationQueue")
                .whereField("type", isEqualTo: "spoiler_suspect")
                .whereField("status", isEqualTo: "pending")
                .order(by: "createdAt", descending: true)
                .limit(to: 50)
                .getDocuments()

            items = snap.documents.compactMap { document in
                let data = document.data()
                return SpoilerQueueItem(
                    id: document.documentID,
                    source: FirestoreValueReader.string(data, key: "source") ?? "",
                    docPath: FirestoreValueReader.string(data, key: "docPath") ?? "",
                    authorUid: FirestoreValueReader.string(data, key: "authorUid"),
                    preview: FirestoreValueReader.string(data, key: "preview") ?? "",
                    matchedPattern: FirestoreValueReader.string(data, key: "matchedPattern") ?? "",
                    matchedText: FirestoreValueReader.string(data, key: "matchedText") ?? "",
                    titleIds: FirestoreValueReader.stringArray(data["titleIds"]),
                    createdAt: FirestoreValueReader.date(data["createdAt"]),
                    status: FirestoreValueReader.string(data, key: "status") ?? "pending"
                )
            }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

    func resolve(_ item: SpoilerQueueItem, decision: String) async {
        inFlightID = item.id
        defer { inFlightID = nil }

        do {
            _ = try await CloudFunctionsCaller.call(
                name: "confirmSpoilerSuspect",
                data: ["queueId": item.id, "decision": decision]
            )
            items.removeAll { $0.id == item.id }
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

struct AdminSpoilerQueueView: View {
    let container: AppContainer
    let session: SessionStore

    @State private var viewModel: AdminSpoilerQueueViewModel?

    var body: some View {
        Group {
            if session.appUser?.permissions.canRunAdminTools != true {
                deniedView
            } else if let vm = viewModel {
                content(vm)
            } else {
                ProgressView().tint(TwoWatchTheme.brandPrimary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(TwoWatchTheme.background.ignoresSafeArea())
        .navigationTitle("Spoiler Queue")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel == nil {
                let vm = AdminSpoilerQueueViewModel(container: container, session: session)
                viewModel = vm
                await vm.load()
            }
        }
    }

    private var deniedView: some View {
        VStack(spacing: 12) {
            Image(systemName: "lock.shield")
                .font(.largeTitle)
                .foregroundStyle(TwoWatchTheme.textSecondary)
            Text("Permessi insufficienti.")
                .font(.headline)
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private func content(_ vm: AdminSpoilerQueueViewModel) -> some View {
        if vm.isLoading {
            ProgressView().tint(TwoWatchTheme.brandPrimary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if vm.items.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "tray")
                    .font(.largeTitle)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                Text("Coda vuota")
                    .font(.headline)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("Nessun caso pendente di sospetto spoiler.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(vm.items) { item in
                        itemCard(item, vm: vm)
                    }
                }
                .padding(16)
            }
            .refreshable {
                await vm.load()
            }
        }
    }

    @ViewBuilder
    private func itemCard(_ item: SpoilerQueueItem, vm: AdminSpoilerQueueViewModel) -> some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(item.source)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                    Spacer()
                    if let createdAt = item.createdAt {
                        Text(createdAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                }

                Text(item.docPath)
                    .font(.caption2.monospaced())
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)

                if let author = item.authorUid {
                    Text("Autore: \(author)")
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }

                Text(item.preview)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(TwoWatchTheme.panel)
                    )

                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                    Text("match: ")
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                    Text(item.matchedText)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Spacer()
                    if !item.titleIds.isEmpty {
                        Text("\(item.titleIds.count) titoli")
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                }

                if vm.inFlightID == item.id {
                    HStack {
                        Spacer()
                        ProgressView().tint(TwoWatchTheme.brandPrimary)
                        Spacer()
                    }
                } else {
                    HStack(spacing: 10) {
                        Button {
                            Task { await vm.resolve(item, decision: "confirmed") }
                        } label: {
                            Label("Conferma spoiler", systemImage: "checkmark.shield.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(TwoWatchTheme.brandPrimary)

                        Button {
                            Task { await vm.resolve(item, decision: "false_positive") }
                        } label: {
                            Label("Falso positivo", systemImage: "xmark.circle")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(TwoWatchTheme.textSecondary)
                    }
                }
            }
        }
    }
}
