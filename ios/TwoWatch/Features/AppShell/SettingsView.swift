import FirebaseAuth
import FirebaseFirestore
import SwiftUI
import UIKit
import UserNotifications

struct SettingsView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    @State private var pushStatus: UNAuthorizationStatus = .notDetermined
    @State private var showsDeleteConfirmation = false
    @State private var isDeletingAccount = false
    @State private var isSendingPasswordReset = false
    @State private var errorMessage: String?
    @State private var infoMessage: String?
    @State private var receivesTitleUpdates = true
    @State private var isLoadingTitleUpdatePreference = false
    @State private var isSavingTitleUpdatePreference = false
    @Environment(\.openURL) private var openURL

    private var accountEmail: String? {
        session.firebaseUser?.email
    }

    /// Il flusso "Cambia password" ha senso solo per gli account creati con
    /// email+password: chi accede con Google/Apple non ha una password Somto.
    private var hasPasswordProvider: Bool {
        session.firebaseUser?.providerData.contains { $0.providerID == "password" } ?? false
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if session.isAuthenticated {
                    accountSection
                }
                preferencesSection
                notificationsSection
                supportSection
                if session.isAuthenticated {
                    dangerZoneSection
                }
            }
            .padding(20)
        }
        .background(TwoWatchBackground())
        .navigationTitle("Impostazioni")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            pushStatus = settings.authorizationStatus
            await loadTitleUpdateNotificationPreference()
        }
        .alert("Errore", isPresented: Binding(
            get: { errorMessage != nil },
            set: { _ in errorMessage = nil }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .alert("Fatto", isPresented: Binding(
            get: { infoMessage != nil },
            set: { _ in infoMessage = nil }
        )) {
            Button("Ok", role: .cancel) {}
        } message: {
            Text(infoMessage ?? "")
        }
        .confirmationDialog(
            "Eliminare definitivamente l'account?",
            isPresented: $showsDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Elimina account", role: .destructive) {
                Task { await deleteAccount() }
            }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("L'operazione elimina l'accesso e i dati privati associati al profilo. Alcuni contenuti pubblici potrebbero essere trattenuti per motivi legali.")
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Account")

            if let email = accountEmail, !email.isEmpty {
                Button {
                    UIPasteboard.general.string = email
                    infoMessage = "Email copiata negli appunti."
                } label: {
                    rowLabel(
                        icon: "envelope.badge.fill",
                        title: "Email dell'account",
                        subtitle: email,
                        tint: TwoWatchTheme.accent,
                        trailingSystemImage: "doc.on.doc"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Tocca per copiare l'email")
            }

            if hasPasswordProvider {
                Button {
                    Task { await sendPasswordReset() }
                } label: {
                    rowLabel(
                        icon: "key.fill",
                        title: "Cambia password",
                        subtitle: isSendingPasswordReset
                            ? "Invio in corso…"
                            : String(localized: "Ti inviamo un link via email per reimpostarla"),
                        tint: TwoWatchTheme.brandPrimary
                    )
                }
                .buttonStyle(.plain)
                .disabled(isSendingPasswordReset)
            }

            ShareLink(item: SomtoInvite.url, message: Text(SomtoInvite.message)) {
                rowLabel(
                    icon: "person.2.fill",
                    title: String(localized: "Invita un amico"),
                    subtitle: "Condividi Somto e guardate insieme",
                    tint: TwoWatchTheme.brandSecondary,
                    trailingSystemImage: "square.and.arrow.up"
                )
            }
        }
    }

    // MARK: - Preferences

    private var preferencesSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Preferenze")

            settingsRow(
                icon: "globe",
                title: "Lingua",
                subtitle: "Segue le impostazioni di sistema",
                tint: TwoWatchTheme.accent
            ) {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    openURL(url)
                }
            }
        }
    }

    // MARK: - Notifications

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Notifiche")

            settingsRow(
                icon: pushStatus == .authorized ? "bell.badge.fill" : "bell.slash.fill",
                title: pushStatus == .authorized ? "Notifiche attive" : "Notifiche disattivate",
                subtitle: pushStatus == .authorized
                    ? "Ricevi aggiornamenti su amici, thread e consigli"
                    : pushStatus == .notDetermined
                        ? String(localized: "Attivale per ricevere aggiornamenti su amici, thread e consigli")
                        : "Attiva dalle impostazioni di sistema",
                tint: pushStatus == .authorized ? TwoWatchTheme.success : TwoWatchTheme.textSecondary
            ) {
                Task { await handleNotificationsRowTap() }
            }

            if session.isAuthenticated {
                HStack(spacing: 10) {
                    Toggle(isOn: Binding(
                        get: { receivesTitleUpdates },
                        set: { newValue in
                            guard !isLoadingTitleUpdatePreference, !isSavingTitleUpdatePreference else { return }
                            receivesTitleUpdates = newValue
                            Task { await saveTitleUpdateNotificationPreference(enabled: newValue) }
                        }
                    )) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Aggiornamenti sui titoli")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                            Text("Trailer, annunci e nuove uscite dei titoli che segui")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                    }
                    .tint(TwoWatchTheme.accent)
                    .disabled(isLoadingTitleUpdatePreference || isSavingTitleUpdatePreference)

                    if isLoadingTitleUpdatePreference || isSavingTitleUpdatePreference {
                        ProgressView()
                            .controlSize(.small)
                            .tint(TwoWatchTheme.accent)
                            .accessibilityLabel(isLoadingTitleUpdatePreference ? "Caricamento preferenza" : "Salvataggio preferenza")
                    }
                }
            }
        }
    }

    private func loadTitleUpdateNotificationPreference() async {
        guard let uid = session.firebaseUser?.uid else { return }
        isLoadingTitleUpdatePreference = true
        defer { isLoadingTitleUpdatePreference = false }
        do {
            let snapshot = try await Firestore.firestore().collection("users").document(uid)
                .collection("_system").document("notificationPrefs")
                .getDocument()
            let disabledTypes = FirestoreValueReader.stringArray(snapshot.data()?["disabledTypes"])
            receivesTitleUpdates = !disabledTypes.contains("title_update")
        } catch {
            errorMessage = String(localized: "Impossibile caricare le preferenze notifiche.")
        }
    }

    private func saveTitleUpdateNotificationPreference(enabled: Bool) async {
        guard let uid = session.firebaseUser?.uid else { return }
        isSavingTitleUpdatePreference = true
        defer { isSavingTitleUpdatePreference = false }
        let reference = Firestore.firestore().collection("users").document(uid)
            .collection("_system").document("notificationPrefs")
        do {
            try await reference.setData([
                "disabledTypes": enabled
                    ? FieldValue.arrayRemove(["title_update"])
                    : FieldValue.arrayUnion(["title_update"]),
                "updatedAt": FieldValue.serverTimestamp()
            ], merge: true)
        } catch {
            receivesTitleUpdates.toggle()
            errorMessage = String(localized: "Impossibile salvare la preferenza. Riprova.")
        }
    }

    /// Se il permesso non è mai stato chiesto (`.notDetermined`) lo chiediamo
    /// in-app (stesso pattern di `NotificationsView.pushPermissionCard`):
    /// aprire le Impostazioni di sistema qui sarebbe un vicolo cieco, perché
    /// iOS non mostra un toggle per un permesso mai richiesto. Solo se è già
    /// stato negato ha senso mandare l'utente in Impostazioni.
    private func handleNotificationsRowTap() async {
        if pushStatus == .notDetermined {
            _ = await container.pushNotifications.requestAuthorizationFromUser()
            pushStatus = await container.pushNotifications.currentAuthorizationStatus()
            return
        }
        if let url = URL(string: UIApplication.openSettingsURLString) {
            openURL(url)
        }
    }

    // MARK: - Support

    private var supportSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Supporto")

            settingsRow(
                icon: "envelope.fill",
                title: "Contatta il supporto",
                subtitle: "Scrivici per problemi o domande",
                tint: TwoWatchTheme.brandPrimary
            ) {
                if let url = URL(string: "mailto:support@somto.it") {
                    openURL(url)
                }
            }

            settingsRow(
                icon: "lightbulb.fill",
                title: "Manda un suggerimento",
                subtitle: "Aiutaci a migliorare Somto",
                tint: TwoWatchTheme.warning
            ) {
                if let url = URL(string: "mailto:support@somto.it?subject=Suggerimento%20Somto") {
                    openURL(url)
                }
            }

            settingsRow(
                icon: "lock.shield.fill",
                title: "Informativa privacy",
                subtitle: "Leggi come trattiamo i tuoi dati",
                tint: TwoWatchTheme.accent
            ) {
                if let url = URL(string: "https://somto.it/privacy.html") {
                    openURL(url)
                }
            }

            settingsRow(
                icon: "doc.text.fill",
                title: "Termini di servizio",
                subtitle: "Regole e condizioni d'uso",
                tint: TwoWatchTheme.textSecondary
            ) {
                openURL(CommunitySafetyPolicy.termsURL)
            }
        }
    }

    // MARK: - Danger Zone

    private var dangerZoneSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Account")

            Button {
                showsDeleteConfirmation = true
            } label: {
                HStack(spacing: 14) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.red.opacity(0.12))
                            .frame(width: 40, height: 40)

                        if isDeletingAccount {
                            ProgressView().tint(.red)
                        } else {
                            Image(systemName: "trash")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(.red)
                        }
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Elimina account")
                            .font(.headline.weight(.semibold))
                            .foregroundStyle(.red)
                        Text("Azione irreversibile")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .padding(16)
                .background(Color.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke(Color.red.opacity(0.12), lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(isDeletingAccount)
        }
    }

    // MARK: - Helpers

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.headline.weight(.bold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
    }

    private func rowLabel(
        icon: String,
        title: String,
        subtitle: String,
        tint: Color,
        trailingSystemImage: String = "chevron.right"
    ) -> some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(tint.opacity(0.12))
                    .frame(width: 40, height: 40)

                Image(systemName: icon)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(tint)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(2)
            }

            Spacer()

            Image(systemName: trailingSystemImage)
                .font(.caption2.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(16)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func settingsRow(
        icon: String,
        title: String,
        subtitle: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            rowLabel(icon: icon, title: title, subtitle: subtitle, tint: tint)
        }
        .buttonStyle(.plain)
    }

    private func sendPasswordReset() async {
        guard let email = session.firebaseUser?.email, !email.isEmpty else {
            errorMessage = String(localized: "Nessuna email associata a questo account.")
            return
        }
        isSendingPasswordReset = true
        defer { isSendingPasswordReset = false }
        do {
            try await container.authRepository.resetPassword(email: email)
            infoMessage = "Ti abbiamo inviato un'email a \(email) con il link per cambiare la password."
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
        }
    }

    private func deleteAccount() async {
        guard session.isAuthenticated else { return }
        isDeletingAccount = true
        defer { isDeletingAccount = false }

        do {
            try await container.authRepository.deleteCurrentAccount()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

#if DEBUG
#Preview("Impostazioni") {
    NavigationStack {
        SettingsView(
            container: TwoWatchPreview.container,
            session: TwoWatchPreview.session(),
            shell: TwoWatchPreview.shell()
        )
    }
}
#endif
