import SwiftUI
import UIKit

// UI del composer sociale: campo di testo UIKit con evidenziazione dei
// token, lista dei suggerimenti, card in Home. Estratti da CommunityView.swift.

struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selectedRange: NSRange
    @Binding var dynamicHeight: CGFloat
    @Binding var shouldBecomeFirstResponder: Bool
    var textColor: UIColor = .white
    var keyboardAppearance: UIKeyboardAppearance = .default
    var minHeight: CGFloat = 22
    var maxHeight: CGFloat = 140
    let onTextEvent: (String, NSRange) -> Void
    let onReturnKey: () -> Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = UIFont.preferredFont(forTextStyle: .body)
        textView.textColor = textColor
        textView.keyboardAppearance = keyboardAppearance
        textView.isScrollEnabled = false
        textView.showsVerticalScrollIndicator = false
        textView.showsHorizontalScrollIndicator = false
        textView.autocapitalizationType = .sentences
        textView.autocorrectionType = .yes
        textView.returnKeyType = .default
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.text = text
        context.coordinator.updateHeight(for: textView)
        return textView
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        if uiView.text != text {
            uiView.text = text
        }
        if uiView.textColor != textColor {
            uiView.textColor = textColor
        }
        if uiView.keyboardAppearance != keyboardAppearance {
            uiView.keyboardAppearance = keyboardAppearance
        }
        if uiView.selectedRange != selectedRange {
            uiView.selectedRange = selectedRange
        }
        context.coordinator.updateHeight(for: uiView)

        if shouldBecomeFirstResponder, !uiView.isFirstResponder {
            uiView.becomeFirstResponder()
            DispatchQueue.main.async {
                shouldBecomeFirstResponder = false
            }
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        private var parent: ComposerTextView

        init(parent: ComposerTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.selectedRange = textView.selectedRange
            updateHeight(for: textView)
            scrollCaretToVisible(textView)
            parent.onTextEvent(textView.text, textView.selectedRange)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.selectedRange = textView.selectedRange
            scrollCaretToVisible(textView)
            parent.onTextEvent(textView.text, textView.selectedRange)
        }

        /// Tiene il cursore nel campo visibile quando il testo supera l'altezza
        /// massima e la text view scrolla internamente. Async: l'altezza SwiftUI
        /// si aggiorna al layout successivo, quindi si scrolla dopo.
        private func scrollCaretToVisible(_ textView: UITextView) {
            guard textView.isScrollEnabled else { return }
            let range = textView.selectedRange
            DispatchQueue.main.async {
                textView.scrollRangeToVisible(range)
            }
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            if text == "\n", parent.onReturnKey() {
                return false
            }
            return true
        }

        func updateHeight(for textView: UITextView) {
            let availableWidth = textView.bounds.width
            guard availableWidth > 8 else {
                if textView.isScrollEnabled {
                    textView.isScrollEnabled = false
                }
                if parent.dynamicHeight != parent.minHeight {
                    DispatchQueue.main.async {
                        self.parent.dynamicHeight = self.parent.minHeight
                    }
                }
                return
            }

            let fittingSize = CGSize(width: availableWidth, height: .greatestFiniteMagnitude)
            let rawHeight = textView.sizeThatFits(fittingSize).height
            let clampedHeight = min(max(parent.minHeight, rawHeight), parent.maxHeight)
            let shouldScroll = rawHeight > parent.maxHeight + 0.5
            if textView.isScrollEnabled != shouldScroll {
                textView.isScrollEnabled = shouldScroll
            }
            if parent.dynamicHeight != clampedHeight {
                DispatchQueue.main.async {
                    self.parent.dynamicHeight = clampedHeight
                }
            }
        }
    }
}

struct AutocompleteSuggestionsList: View {
    let composer: SocialComposerViewModel
    var subtitleColor: Color = TwoWatchTheme.textSecondary
    var dividerColor: Color = TwoWatchTheme.border
    var backgroundColor: Color = TwoWatchTheme.panelStrong

    var body: some View {
        @Bindable var composer = composer

        if composer.isSuggestionsPresented {
            VStack(spacing: 0) {
                ForEach(composer.suggestions) { suggestion in
                    Button {
                        composer.selectSuggestion(suggestion)
                    } label: {
                        HStack(spacing: 12) {
                            SomtoAvatar(
                                url: suggestion.avatarURL,
                                name: suggestion.label,
                                size: 30
                            )

                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(suggestion.badge)\(suggestion.label)")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(suggestionTint(for: suggestion.kind))
                                    .frame(maxWidth: .infinity, alignment: .leading)

                                if !suggestion.subtitle.isEmpty {
                                    Text(suggestion.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(subtitleColor)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }

                            Spacer(minLength: 8)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                    }
                    .buttonStyle(.plain)

                    if suggestion.id != composer.suggestions.last?.id {
                        Divider()
                            .overlay(dividerColor)
                    }
                }
            }
            .background(backgroundColor, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private func suggestionTint(for kind: ComposerSuggestionKind) -> Color {
        switch kind {
        case .user:
            return TwoWatchTheme.brandPrimary
        case .title:
            return TwoWatchTheme.accent
        case .person:
            return TwoWatchTheme.warning
        }
    }
}

struct HomeComposerCard: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let onPublished: (String) async -> Void

    @State private var composer: SocialComposerViewModel
    @State private var visibility: PostVisibility = .public
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        onPublished: @escaping (String) async -> Void
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.onPublished = onPublished
        _composer = State(initialValue: SocialComposerViewModel(
            titleRepository: container.titleRepository,
            userRepository: container.userRepository,
            topicScope: .titlesAndPeople,
            characterLimit: 1000
        ))
    }

    var body: some View {
        @Bindable var composer = composer

        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                SomtoAvatar(url: authorSummary.photoURL, name: authorSummary.displayName, size: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(authorSummary.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                .frame(minHeight: 40, alignment: .center)

                Spacer()

                Menu {
                    ForEach(PostVisibility.selectableCases, id: \.self) { option in
                        Button {
                            visibility = option
                        } label: {
                            Label(option.label, systemImage: option.symbolName)
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: visibility.symbolName)
                            .font(.subheadline.weight(.semibold))
                        Text(visibility.label)
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
                    .background(TwoWatchTheme.panelStrong, in: Capsule())
                    .contentShape(Capsule())
                    .accessibilityLabel("Visibilita': \(visibility.label)")
                }
                .frame(minHeight: 44, alignment: .center)
            }

            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(TwoWatchTheme.panel)

                if composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("A cosa stai pensando? Puoi citare amici, titoli, attori e registi.")
                        .font(.body)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .allowsHitTesting(false)
                }

                ComposerTextView(
                    text: $composer.text,
                    selectedRange: $composer.selectedRange,
                    dynamicHeight: $composer.editorHeight,
                    shouldBecomeFirstResponder: $composer.shouldRefocusEditor,
                    onTextEvent: { text, selection in
                        composer.handleEditorChange(
                            text,
                            selection: selection,
                            currentUserID: session.firebaseUser?.uid,
                            canSearchUsers: session.permissions.canSearchUsers
                        )
                    },
                    onReturnKey: {
                        composer.acceptHighlightedSuggestion()
                    }
                )
                    .frame(minHeight: max(70, composer.editorHeight), maxHeight: 160)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }

            AutocompleteSuggestionsList(composer: composer)

            HStack(alignment: .center, spacing: 12) {
                // Mirror `.home-composer-hint` (home.css): testo statico a
                // sinistra, invariato dal web ("@ amici · # titoli e persone").
                Text("@ amici · # titoli e persone")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 0)

                Text("\(composer.text.count)/\(composer.characterLimit)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(counterColor)

                Button {
                    Task { await submit() }
                } label: {
                    HStack(spacing: 6) {
                        if isSubmitting {
                            ProgressView()
                                .tint(.white)
                                .scaleEffect(0.85)
                        } else {
                            Image(systemName: "paperplane.fill")
                                .font(.caption.weight(.bold))
                            Text("Pubblica")
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .frame(minWidth: 124, minHeight: 36)
                    .background(
                        ZStack {
                            Capsule()
                                .fill(TwoWatchTheme.panelStrong)
                            if composer.canSubmit && !isSubmitting {
                                Capsule()
                                    .fill(TwoWatchTheme.brandGradient)
                            }
                        }
                    )
                    .shadow(
                        color: composer.canSubmit && !isSubmitting
                            ? TwoWatchTheme.brandPrimary.opacity(0.28)
                            : .clear,
                        radius: 12,
                        y: 6
                    )
                    .frame(minHeight: 44, alignment: .center)
                    .contentShape(Capsule())
                }
                .disabled(!composer.canSubmit || isSubmitting)
                .accessibilityLabel(isSubmitting ? "Pubblicazione in corso" : "Pubblica post")
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(16)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        // Consuma il prefill dello "spunto" (discussion starter chips): mirror
        // di web `composerText.value = prompt` + focus + cursore a fine testo.
        .onChange(of: shell.composerPrefillText) { _, newValue in
            guard let newValue else { return }
            composer.text = newValue
            composer.selectedRange = NSRange(location: (newValue as NSString).length, length: 0)
            composer.shouldRefocusEditor = true
            shell.composerPrefillText = nil
        }
    }

    private var authorSummary: UserSummary {
        UserSummary(
            id: session.appUser?.id ?? session.firebaseUser?.uid ?? "me",
            displayName: session.appUser?.displayName ?? session.firebaseUser?.displayName ?? "Tu",
            photoURL: session.appUser?.photoURL ?? session.appUser?.avatarURL
        )
    }

    private var counterColor: Color {
        let limit = composer.characterLimit
        let count = composer.text.count
        if count > limit {
            return .red
        }
        if Double(count) / Double(max(1, limit)) > 0.9 {
            return TwoWatchTheme.warning
        }
        return TwoWatchTheme.textSecondary
    }

    private func submit() async {
        guard let uid = session.firebaseUser?.uid else {
            shell.presentAuth()
            return
        }

        let rawText = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawText.isEmpty else {
            errorMessage = "Scrivi qualcosa prima di pubblicare."
            return
        }
        guard rawText.count <= composer.characterLimit else {
            errorMessage = "Il post può avere massimo \(composer.characterLimit) caratteri."
            return
        }

        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }

        let resolvedText = composer.resolvedTextForSubmission(rawText)
        let taggedTitleID = TaggedTextFormatter.firstTaggedTitleID(in: resolvedText)

        do {
            let post = try await container.postsRepository.createPost(
                authorUID: uid,
                authorName: session.appUser?.displayName ?? session.firebaseUser?.displayName ?? "User",
                text: resolvedText,
                titleID: taggedTitleID,
                visibility: visibility
            )
            composer.reset()
            visibility = .public
            await onPublished(post.id)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }

}
