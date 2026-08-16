import SwiftUI

/// Menu riusabile "Segnala / Blocca autore" per i contenuti UGC del feed
/// (post e commenti). Richiesto da App Review (Guideline 1.2 — Safety, UGC):
/// ogni contenuto generato dagli utenti deve offrire un meccanismo di
/// segnalazione e uno di blocco dell'autore; il blocco rimuove subito i
/// contenuti del bloccato dal feed del bloccante (filtro su
/// `SessionStore.blockedUserIDs`) e il backend avvisa gli admin
/// (`notifyOnReportCreate` + trigger `blockedUsers`).
/// Stesso pattern visivo del `moderationMenu` dei messaggi thread.
struct ContentModerationMenu: View {
    let container: AppContainer
    let session: SessionStore
    /// Autore del contenuto (bersaglio del blocco).
    let authorUID: String
    let authorName: String
    /// Tipo per `reports` (es. "post", "comment") + id del doc bersaglio.
    let reportType: String
    let reportTargetID: String
    /// Motivo leggibile della segnalazione (stessa formula dei thread).
    let reportReason: String
    /// Metadata extra per il doc report (preview, postId, ...). Tipizzata
    /// `[String: String]` (Sendable): il valore attraversa il confine di
    /// isolamento verso `submitModerationReport` (param `sending`).
    var reportMetadata: [String: String] = [:]

    @State private var isBlockConfirmPresented = false
    @State private var feedbackMessage: String?
    @State private var isReporting = false
    @State private var isBlocking = false

    private var isWorking: Bool { isReporting || isBlocking }

    private var currentUID: String? {
        session.firebaseUser?.uid
    }

    /// Il menu esiste solo per contenuti altrui di utenti loggati.
    private var isVisible: Bool {
        guard let currentUID, !authorUID.isEmpty else { return false }
        return currentUID != authorUID
    }

    var body: some View {
        if isVisible {
            Menu {
                Button(role: .destructive) {
                    Task { await submitReport() }
                } label: {
                    Label(isReporting ? "Invio…" : "Segnala", systemImage: "flag.fill")
                }
                .disabled(isWorking)

                Button(role: .destructive) {
                    isBlockConfirmPresented = true
                } label: {
                    Label("Blocca utente", systemImage: "hand.raised.fill")
                }
                .disabled(isWorking)
            } label: {
                Group {
                    if isWorking {
                        ProgressView()
                            .tint(TwoWatchTheme.textMuted)
                    } else {
                        Image(systemName: "ellipsis")
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
            }
            .disabled(isWorking)
            .accessibilityLabel("Azioni di moderazione")
            .confirmationDialog(
                "Bloccare \(authorName)?",
                isPresented: $isBlockConfirmPresented,
                titleVisibility: .visible
            ) {
                Button("Blocca utente", role: .destructive) {
                    Task { await blockAuthor() }
                }
                .disabled(isWorking)
                Button("Annulla", role: .cancel) {}
            } message: {
                Text("Non vedrai più i suoi contenuti e il team di moderazione viene avvisato.")
            }
            .alert(
                feedbackMessage ?? "",
                isPresented: Binding(
                    get: { feedbackMessage != nil },
                    set: { if !$0 { feedbackMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            }
        }
    }

    private func submitReport() async {
        guard let currentUID, !isWorking else { return }
        isReporting = true
        defer { isReporting = false }
        do {
            var enriched = reportMetadata
            enriched["reportedUid"] = authorUID
            // Copia fresca [String: Any] da valori Sendable → regione
            // disconnessa, passabile al param `sending`.
            var metadata: [String: Any] = [:]
            for (key, value) in enriched {
                metadata[key] = value
            }
            try await container.userRepository.submitModerationReport(
                fromUid: currentUID,
                type: reportType,
                targetId: reportTargetID,
                reason: reportReason,
                metadata: metadata
            )
            feedbackMessage = String(localized: "Segnalazione inviata al team di moderazione.")
        } catch {
            feedbackMessage = UserFacingError.message(for: error)
        }
    }

    private func blockAuthor() async {
        guard let currentUID, !isWorking else { return }
        isBlocking = true
        defer { isBlocking = false }
        do {
            try await container.userRepository.blockUser(
                myUid: currentUID,
                targetUid: authorUID,
                source: "ios_feed"
            )
            session.markUserBlockedLocally(authorUID)
            feedbackMessage = String(localized: "Utente bloccato. Non vedrai più i suoi contenuti.")
        } catch {
            feedbackMessage = UserFacingError.message(for: error)
        }
    }
}
