import SwiftUI

/// "Segui" gli aggiornamenti di un titolo, da una superficie social.
///
/// PERCHE' ESISTE FUORI DALLA SCHEDA TITOLO — senza `follow`, l'evento di
/// uscita di un titolo arriva solo a chi ce l'ha in watchlist. Chi legge un
/// post su un film che esce fra due mesi, e quel film non l'ha mai toccato,
/// oggi non ha nessun modo di dire "avvisami": deve aprire la scheda e
/// cercarne il menu. Questo bottone e' quel modo, in un tap.
///
/// Toggle secco `follow ⇄ auto`: le sfumature ("solo importanti", "silenzia")
/// restano nel menu della scheda titolo, che e' dove si capiscono. Stessa
/// scelta fatta sul web.
struct TitleFollowButton: View {
    let titleID: String
    let store: TitleFollowStore
    /// `nil` per i guest: il tap porta al login invece di scrivere.
    let userID: String?
    /// `false` = solo la campanella, per le righe strette (la card del feed
    /// divide la riga con la barra social e col nome del titolo).
    var showsLabel = false
    let onRequestAuth: () -> Void

    @State private var errorMessage: String?
    @ScaledMetric(relativeTo: .subheadline) private var iconSize: CGFloat = 15

    private var isFollowing: Bool { store.isFollowing(titleID) }
    private var isSaving: Bool { store.isSaving(titleID) }

    private var actionLabel: String {
        isFollowing ? String(localized: "Non seguire") : String(localized: "Segui")
    }

    private var stateLabel: String {
        isFollowing ? String(localized: "Seguito") : String(localized: "Segui")
    }

    var body: some View {
        Button {
            guard let userID, !userID.isEmpty else {
                onRequestAuth()
                return
            }
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            Task { await toggle(userID: userID) }
        } label: {
            HStack(spacing: SomtoSpacing.s) {
                Image(systemName: isFollowing ? "bell.fill" : "bell")
                    .font(.system(size: iconSize, weight: .semibold))
                if showsLabel {
                    Text(stateLabel)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
            }
            .foregroundStyle(isFollowing ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
            .padding(.horizontal, showsLabel ? SomtoSpacing.l : SomtoSpacing.ml)
            .padding(.vertical, SomtoSpacing.s)
            .background(background)
            .opacity(isSaving ? 0.55 : 1)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSaving)
        .animation(.snappy(duration: 0.18), value: isFollowing)
        // Label = l'azione, hint = l'esito (§6.4). La frase dell'esito e' la
        // stessa gia' usata nelle impostazioni notifiche.
        .accessibilityLabel(actionLabel)
        .accessibilityHint("Trailer, annunci e nuove uscite dei titoli che segui")
        .alert("Impossibile salvare", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var background: some View {
        Capsule()
            .fill(isFollowing ? TwoWatchTheme.brandPrimary.opacity(0.16) : TwoWatchTheme.panelStrong)
            .overlay(
                Capsule().stroke(
                    isFollowing ? TwoWatchTheme.brandPrimary.opacity(0.5) : TwoWatchTheme.border,
                    lineWidth: 1
                )
            )
    }

    /// L'utente ha innescato una scrittura: se fallisce lo deve sapere (§5).
    /// Il messaggio passa da `UserFacingError`, il tecnico va a Crashlytics.
    private func toggle(userID: String) async {
        do {
            try await store.toggleFollow(titleID: titleID, userID: userID)
        } catch {
            SilentFailure.record(error, context: "TitleFollowButton.toggle")
            errorMessage = UserFacingError.message(for: error)
        }
    }
}
