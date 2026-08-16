import AuthenticationServices
import Observation
import SwiftUI

enum AuthMode: String, CaseIterable, Identifiable {
    case signIn = "Accedi"
    case signUp = "Registrati"

    var id: String { rawValue }
}

@Observable
@MainActor
final class AuthViewModel {
    private let authRepository: AuthenticationRepository
    private let userRepository: UserRepository
    private let analytics: AnalyticsLogging

    var mode: AuthMode = .signIn
    var email = ""
    var password = ""
    var confirmPassword = ""
    var displayName = ""
    var hasAcceptedCommunitySafetyTerms = false
    var isLoading = false
    var activeSocialProvider: String?
    var errorMessage: String?
    var successMessage: String?

    init(
        authRepository: AuthenticationRepository,
        userRepository: UserRepository,
        analytics: AnalyticsLogging = NoopAnalyticsLogger()
    ) {
        self.authRepository = authRepository
        self.userRepository = userRepository
        self.analytics = analytics
    }

    var canUseGoogleSignIn: Bool {
        authRepository.isGoogleSignInAvailable
    }

    var canUseAppleSignIn: Bool {
        authRepository.isAppleSignInAvailable
    }

    func submit() async -> Bool {
        errorMessage = nil
        successMessage = nil

        // Guideline 1.2: consenso EULA/termini richiesto prima di ogni
        // accesso o registrazione, qualunque sia il metodo.
        guard hasAcceptedCommunitySafetyTerms else {
            errorMessage = "Accetta i Termini di servizio per continuare."
            return false
        }

        isLoading = true
        defer { isLoading = false }

        do {
            switch mode {
            case .signIn:
                _ = try await authRepository.signIn(email: email, password: password)
                return true
            case .signUp:
                guard password == confirmPassword else {
                    errorMessage = "Le password non coincidono."
                    return false
                }
                let user = try await authRepository.signUp(email: email, password: password)
                try await userRepository.ensureUserDocument(for: user, preferredDisplayName: displayName)
                try await userRepository.acceptCommunitySafetyTerms(userID: user.uid)
                analytics.log(AnalyticsEvent.signupCompleted, ["method": "email"])
                return true
            }
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
            return false
        }
    }

    func sendPasswordReset() async {
        guard email.isEmpty == false else {
            errorMessage = "Inserisci l'email per ricevere il link di reset."
            successMessage = nil
            return
        }

        isLoading = true
        errorMessage = nil
        successMessage = nil
        defer { isLoading = false }

        do {
            try await authRepository.resetPassword(email: email)
            successMessage = "Ti abbiamo inviato il link per il reset."
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
        }
    }

    func signInWithGoogle() async -> Bool {
        guard hasAcceptedCommunitySafetyTerms else {
            errorMessage = "Accetta i Termini di servizio per continuare."
            return false
        }
        isLoading = true
        activeSocialProvider = "google"
        errorMessage = nil
        successMessage = nil
        defer {
            isLoading = false
            activeSocialProvider = nil
        }

        do {
            let result = try await authRepository.signInWithGoogle()
            if result.isNewUser {
                try await userRepository.acceptCommunitySafetyTerms(userID: result.user.uid)
                analytics.log(AnalyticsEvent.signupCompleted, ["method": "google"])
            }
            return true
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
            return false
        }
    }

    func prepareAppleSignIn(_ request: ASAuthorizationAppleIDRequest) {
        authRepository.prepareAppleSignInRequest(request)
    }

    func signInWithApple(_ result: Result<ASAuthorization, Error>) async -> Bool {
        guard hasAcceptedCommunitySafetyTerms else {
            errorMessage = "Accetta i Termini di servizio per continuare."
            return false
        }
        isLoading = true
        activeSocialProvider = "apple"
        errorMessage = nil
        successMessage = nil
        defer {
            isLoading = false
            activeSocialProvider = nil
        }

        do {
            let authResult = try await authRepository.signInWithApple(result: result)
            if authResult.isNewUser {
                try await userRepository.acceptCommunitySafetyTerms(userID: authResult.user.uid)
                analytics.log(AnalyticsEvent.signupCompleted, ["method": "apple"])
            }
            return true
        } catch {
            errorMessage = AuthenticationRepository.friendlyMessage(for: error)
            return false
        }
    }
}

struct AuthView: View {
    let container: AppContainer
    let shell: AppShellStore
    let showsCloseButton: Bool
    @State private var viewModel: AuthViewModel
    @State private var termsNeedAttention = false
    @State private var termsAttentionToken = UUID()
    @FocusState private var focusedField: AuthField?

    private enum AuthField: Hashable {
        case email, displayName, password, confirmPassword
    }

    init(container: AppContainer, shell: AppShellStore, showsCloseButton: Bool = true) {
        self.container = container
        self.shell = shell
        self.showsCloseButton = showsCloseButton
        _viewModel = State(initialValue: AuthViewModel(
            authRepository: container.authRepository,
            userRepository: container.userRepository,
            analytics: container.analytics
        ))
    }

    private var isSignUp: Bool { viewModel.mode == .signUp }

    private var canSubmit: Bool {
        guard viewModel.isLoading == false else { return false }
        guard viewModel.email.isEmpty == false, viewModel.password.isEmpty == false else { return false }
        if isSignUp {
            guard viewModel.confirmPassword.isEmpty == false else { return false }
        }
        return true
    }

    var body: some View {
        @Bindable var viewModel = viewModel

        ZStack {
            TwoWatchBackground()

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 22) {
                        heroHeader

                        GlassCard(padding: 20) {
                            VStack(spacing: 18) {
                                modePicker

                                formFields

                                communityTermsBlock
                                    .id("communityTerms")

                                primaryActionButton

                                if viewModel.mode == .signIn {
                                    Button {
                                        Task { await viewModel.sendPasswordReset() }
                                    } label: {
                                        Text("Password dimenticata?")
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                                            .frame(maxWidth: .infinity)
                                            .padding(.vertical, 4)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(viewModel.isLoading)
                                    .accessibilityLabel("Reimposta la password")
                                }
                            }
                        }

                        if let errorMessage = viewModel.errorMessage {
                            feedbackBanner(
                                text: errorMessage,
                                icon: "exclamationmark.triangle.fill",
                                tint: TwoWatchTheme.brandPrimary
                            )
                        }

                        if let successMessage = viewModel.successMessage {
                            feedbackBanner(
                                text: successMessage,
                                icon: "checkmark.circle.fill",
                                tint: TwoWatchTheme.success
                            )
                        }

                        if viewModel.canUseAppleSignIn || viewModel.canUseGoogleSignIn {
                            socialSignInSection
                        }

                        legalFootnote
                    }
                    .padding(20)
                    .padding(.bottom, 12)
                    .animation(.easeOut(duration: 0.22), value: viewModel.mode)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: termsAttentionToken) {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        proxy.scrollTo("communityTerms", anchor: .center)
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsCloseButton {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") {
                        shell.isAuthPresented = false
                    }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }

    // MARK: - Hero

    private var heroHeader: some View {
        VStack(spacing: 16) {
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(Color.white)
                .frame(height: 116)
                .overlay {
                    BrandWordmarkView(width: 150)
                }
                .overlay(
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .stroke(Color.black.opacity(0.06), lineWidth: 1)
                )
                .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.28), radius: 26, y: 14)

            VStack(spacing: 6) {
                Text(isSignUp ? "Entra nella community" : "Bentornato")
                    .font(.title2.weight(.bold))
                    .fontDesign(.rounded)
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text(isSignUp
                     ? "Traccia film e serie, sfida gli amici a quiz e trova chi guarda come te."
                     : "Riprendi i tuoi quiz, le watchlist e le sfide con gli amici.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 4)
        }
        .padding(.top, 4)
    }

    // MARK: - Mode picker

    private var modePicker: some View {
        HStack(spacing: 4) {
            ForEach(AuthMode.allCases) { mode in
                Button {
                    guard viewModel.mode != mode else { return }
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.easeOut(duration: 0.22)) {
                        viewModel.mode = mode
                        viewModel.errorMessage = nil
                        viewModel.successMessage = nil
                        viewModel.password = ""
                        viewModel.confirmPassword = ""
                    }
                } label: {
                    Text(mode.rawValue)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(viewModel.mode == mode ? .white : TwoWatchTheme.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background {
                            if viewModel.mode == mode {
                                Capsule(style: .continuous)
                                    .fill(TwoWatchTheme.brandGradient)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(mode == .signIn ? "Passa ad Accedi" : "Passa a Registrati")
                .accessibilityAddTraits(viewModel.mode == mode ? [.isSelected] : [])
            }
        }
        .padding(4)
        .background(
            Capsule(style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            Capsule(style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    // MARK: - Form fields

    @ViewBuilder
    private var formFields: some View {
        VStack(spacing: 12) {
            authField(icon: "envelope.fill") {
                TextField("Email", text: $viewModel.email)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .focused($focusedField, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focusedField = isSignUp ? .displayName : .password }
            }

            if isSignUp {
                authField(icon: "person.fill") {
                    TextField("Nome visibile", text: $viewModel.displayName)
                        .textContentType(.nickname)
                        .focused($focusedField, equals: .displayName)
                        .submitLabel(.next)
                        .onSubmit { focusedField = .password }
                }
            }

            authField(icon: "lock.fill") {
                SecureField("Password", text: $viewModel.password)
                    .textContentType(isSignUp ? .newPassword : .password)
                    .focused($focusedField, equals: .password)
                    .submitLabel(isSignUp ? .next : .go)
                    .onSubmit {
                        if isSignUp {
                            focusedField = .confirmPassword
                        } else {
                            focusedField = nil
                            triggerSubmit()
                        }
                    }
            }

            if isSignUp {
                authField(icon: "lock.rotation") {
                    SecureField("Conferma password", text: $viewModel.confirmPassword)
                        .textContentType(.newPassword)
                        .focused($focusedField, equals: .confirmPassword)
                        .submitLabel(.go)
                        .onSubmit {
                            focusedField = nil
                            triggerSubmit()
                        }
                }
            }
        }
    }

    private func authField<Field: View>(
        icon: String,
        @ViewBuilder field: () -> Field
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .frame(width: 22)

            field()
                .font(.body)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .tint(TwoWatchTheme.brandPrimary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 15)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    // MARK: - Community terms

    private var communityTermsBlock: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: $viewModel.hasAcceptedCommunitySafetyTerms) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Accetto i Termini di servizio (EULA)")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Tolleranza zero per contenuti offensivi, spam o utenti abusivi.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(TwoWatchTheme.brandPrimary)
            .onChange(of: viewModel.hasAcceptedCommunitySafetyTerms) {
                if viewModel.hasAcceptedCommunitySafetyTerms {
                    termsNeedAttention = false
                    if viewModel.errorMessage == "Accetta i Termini di servizio per continuare." {
                        viewModel.errorMessage = nil
                    }
                }
            }

            Divider()
                .overlay(TwoWatchTheme.border)

            HStack(spacing: 16) {
                Link(destination: CommunitySafetyPolicy.termsURL) {
                    Label("Termini", systemImage: "doc.text")
                        .font(.caption.weight(.semibold))
                }
                Link(destination: CommunitySafetyPolicy.supportURL) {
                    Label("Moderazione", systemImage: "shield.lefthalf.filled")
                        .font(.caption.weight(.semibold))
                }
            }
            .foregroundStyle(TwoWatchTheme.accent)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(TwoWatchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(
                    termsNeedAttention ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border,
                    lineWidth: termsNeedAttention ? 2 : 1
                )
        )
        .shadow(
            color: termsNeedAttention ? TwoWatchTheme.brandPrimary.opacity(0.28) : .clear,
            radius: termsNeedAttention ? 12 : 0
        )
        .animation(.easeInOut(duration: 0.22), value: termsNeedAttention)
    }

    // MARK: - Primary action

    private var primaryActionButton: some View {
        Button {
            triggerSubmit()
        } label: {
            if viewModel.isLoading {
                ProgressView()
                    .tint(.white)
            } else {
                Text(isSignUp ? "Crea account" : "Accedi")
            }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(canSubmit == false)
        .opacity(canSubmit ? 1 : 0.55)
        .accessibilityLabel(isSignUp ? "Crea il tuo account" : "Accedi al tuo account")
    }

    // MARK: - Social sign-in

    private var socialSignInSection: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                Rectangle()
                    .fill(TwoWatchTheme.border)
                    .frame(height: 1)
                Text("oppure continua con")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .fixedSize()
                Rectangle()
                    .fill(TwoWatchTheme.border)
                    .frame(height: 1)
            }

            if viewModel.canUseAppleSignIn {
                ZStack {
                    SignInWithAppleButton(.continue) { request in
                        viewModel.prepareAppleSignIn(request)
                    } onCompletion: { result in
                        Task {
                            let shouldDismiss = await viewModel.signInWithApple(result)
                            if shouldDismiss {
                                shell.isAuthPresented = false
                            }
                        }
                    }
                    .signInWithAppleButtonStyle(.white)
                    .allowsHitTesting(viewModel.hasAcceptedCommunitySafetyTerms && !viewModel.isLoading)

                    if viewModel.hasAcceptedCommunitySafetyTerms == false {
                        Button {
                            requireTermsAcceptance()
                        } label: {
                            Color.clear
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Continua con Apple")
                        .accessibilityHint("Richiede prima l'accettazione dei Termini di servizio")
                    } else if viewModel.activeSocialProvider == "apple" {
                        HStack(spacing: 8) {
                            ProgressView()
                                .tint(.black)
                            Text("Accesso in corso…")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.black)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.white)
                    }
                }
                .frame(height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.black.opacity(0.08), lineWidth: 1)
                )
                .accessibilityLabel("Continua con Apple")
            }

            if viewModel.canUseGoogleSignIn {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    guard viewModel.hasAcceptedCommunitySafetyTerms else {
                        requireTermsAcceptance()
                        return
                    }
                    Task {
                        let shouldDismiss = await viewModel.signInWithGoogle()
                        if shouldDismiss {
                            shell.isAuthPresented = false
                        }
                    }
                } label: {
                    HStack(spacing: 10) {
                        if viewModel.activeSocialProvider == "google" {
                            ProgressView()
                                .tint(Color(hex: "#1F1F1F"))
                            Text("Accesso in corso…")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color(hex: "#1F1F1F"))
                        } else {
                            GoogleGMark()
                                .frame(width: 20, height: 20)
                            Text("Continua con Google")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color(hex: "#1F1F1F"))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.white)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.black.opacity(0.12), lineWidth: 1)
                    )
                }
                .buttonStyle(GoogleButtonStyle())
                .disabled(viewModel.isLoading)
                .accessibilityLabel("Continua con Google")
            }

            socialLegalCaption
        }
    }

    private var socialLegalCaption: some View {
        VStack(spacing: 2) {
            Text(viewModel.hasAcceptedCommunitySafetyTerms
                 ? "Termini di servizio accettati."
                 : "Tocca Apple o Google: se manca il consenso ti portiamo ai Termini.")
                .font(.caption2)
                .foregroundStyle(TwoWatchTheme.textMuted)
                .multilineTextAlignment(.center)

            HStack(spacing: 16) {
                Link("Termini", destination: CommunitySafetyPolicy.termsURL)
                Link("Moderazione", destination: CommunitySafetyPolicy.supportURL)
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.accent)
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Banners & footnote

    private func feedbackBanner(text: String, icon: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(tint)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(tint.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(tint.opacity(0.32), lineWidth: 1)
        )
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var legalFootnote: some View {
        Text("Continuando accetti i Termini di servizio e la Privacy policy di Somto.")
            .font(.caption2)
            .foregroundStyle(TwoWatchTheme.textMuted)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
    }

    // MARK: - Actions

    private func triggerSubmit() {
        guard canSubmit else { return }
        guard viewModel.hasAcceptedCommunitySafetyTerms else {
            requireTermsAcceptance()
            return
        }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            let shouldDismiss = await viewModel.submit()
            if shouldDismiss {
                shell.isAuthPresented = false
            }
        }
    }

    private func requireTermsAcceptance() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        viewModel.errorMessage = "Accetta i Termini di servizio per continuare."
        viewModel.successMessage = nil
        termsNeedAttention = true
        termsAttentionToken = UUID()
    }
}

// MARK: - Google button feedback

private struct GoogleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: - Google "G" mark

/// Logo "G" ufficiale di Google ricostruito con i 4 colori del brand.
/// Geometria derivata dall'SVG ufficiale Google su una griglia 48x48.
private struct GoogleGMark: View {
    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 48

            func scaled(_ path: Path) -> Path {
                path.applying(CGAffineTransform(scaleX: scale, y: scale))
            }

            // Blu — arco destro + barra orizzontale centrale.
            var blue = Path()
            blue.move(to: CGPoint(x: 47.532, y: 24.552))
            blue.addCurve(
                to: CGPoint(x: 47.064, y: 19.291),
                control1: CGPoint(x: 47.532, y: 22.756),
                control2: CGPoint(x: 47.371, y: 21.027)
            )
            blue.addLine(to: CGPoint(x: 24.48, y: 19.291))
            blue.addLine(to: CGPoint(x: 24.48, y: 28.94))
            blue.addLine(to: CGPoint(x: 37.44, y: 28.94))
            blue.addCurve(
                to: CGPoint(x: 32.408, y: 37.231),
                control1: CGPoint(x: 36.882, y: 31.94),
                control2: CGPoint(x: 35.184, y: 34.481)
            )
            blue.addLine(to: CGPoint(x: 32.408, y: 43.49))
            blue.addLine(to: CGPoint(x: 40.756, y: 43.49))
            blue.addCurve(
                to: CGPoint(x: 47.532, y: 24.552),
                control1: CGPoint(x: 45.64, y: 38.991),
                control2: CGPoint(x: 47.532, y: 32.366)
            )
            blue.closeSubpath()
            context.fill(scaled(blue), with: .color(Color(hex: "#4285F4")))

            // Verde — arco in basso a sinistra.
            var green = Path()
            green.move(to: CGPoint(x: 24.48, y: 48))
            green.addCurve(
                to: CGPoint(x: 40.756, y: 43.49),
                control1: CGPoint(x: 30.96, y: 48),
                control2: CGPoint(x: 36.396, y: 45.86)
            )
            green.addLine(to: CGPoint(x: 32.408, y: 37.231))
            green.addCurve(
                to: CGPoint(x: 24.48, y: 39.49),
                control1: CGPoint(x: 30.105, y: 38.781),
                control2: CGPoint(x: 27.157, y: 39.49)
            )
            green.addCurve(
                to: CGPoint(x: 11.943, y: 30.21),
                control1: CGPoint(x: 18.219, y: 39.49),
                control2: CGPoint(x: 13.916, y: 35.267)
            )
            green.addLine(to: CGPoint(x: 3.314, y: 30.21))
            green.addLine(to: CGPoint(x: 3.314, y: 36.668))
            green.addCurve(
                to: CGPoint(x: 24.48, y: 48),
                control1: CGPoint(x: 7.564, y: 43.111),
                control2: CGPoint(x: 15.4, y: 48)
            )
            green.closeSubpath()
            context.fill(scaled(green), with: .color(Color(hex: "#34A853")))

            // Giallo — arco in basso a sinistra (settore inferiore del ring).
            var yellow = Path()
            yellow.move(to: CGPoint(x: 11.943, y: 30.21))
            yellow.addCurve(
                to: CGPoint(x: 11.4, y: 24),
                control1: CGPoint(x: 11.583, y: 29.13),
                control2: CGPoint(x: 11.4, y: 26.586)
            )
            yellow.addCurve(
                to: CGPoint(x: 11.943, y: 17.79),
                control1: CGPoint(x: 11.4, y: 21.414),
                control2: CGPoint(x: 11.583, y: 18.87)
            )
            yellow.addLine(to: CGPoint(x: 11.943, y: 11.332))
            yellow.addLine(to: CGPoint(x: 3.314, y: 11.332))
            yellow.addCurve(
                to: CGPoint(x: 0.48, y: 24),
                control1: CGPoint(x: 1.4, y: 15.142),
                control2: CGPoint(x: 0.48, y: 19.404)
            )
            yellow.addCurve(
                to: CGPoint(x: 3.314, y: 36.668),
                control1: CGPoint(x: 0.48, y: 28.596),
                control2: CGPoint(x: 1.4, y: 32.858)
            )
            yellow.addLine(to: CGPoint(x: 11.943, y: 30.21))
            yellow.closeSubpath()
            context.fill(scaled(yellow), with: .color(Color(hex: "#FBBC05")))

            // Rosso — arco in alto a sinistra.
            var red = Path()
            red.move(to: CGPoint(x: 24.48, y: 8.51))
            red.addCurve(
                to: CGPoint(x: 33.021, y: 11.835),
                control1: CGPoint(x: 27.994, y: 8.51),
                control2: CGPoint(x: 31.148, y: 9.718)
            )
            red.addLine(to: CGPoint(x: 40.373, y: 4.483))
            red.addCurve(
                to: CGPoint(x: 24.48, y: 0),
                control1: CGPoint(x: 36.385, y: 0.767),
                control2: CGPoint(x: 30.96, y: 0)
            )
            red.addCurve(
                to: CGPoint(x: 3.314, y: 11.332),
                control1: CGPoint(x: 15.4, y: 0),
                control2: CGPoint(x: 7.564, y: 4.889)
            )
            red.addLine(to: CGPoint(x: 11.943, y: 17.79))
            red.addCurve(
                to: CGPoint(x: 24.48, y: 8.51),
                control1: CGPoint(x: 13.916, y: 12.733),
                control2: CGPoint(x: 18.219, y: 8.51)
            )
            red.closeSubpath()
            context.fill(scaled(red), with: .color(Color(hex: "#EA4335")))
        }
        .accessibilityHidden(true)
    }
}
