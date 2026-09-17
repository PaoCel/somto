import PhotosUI
import SwiftUI
import UIKit

// La View e' isolata al main actor. Marcare la sola computed property non
// bastava: le letture di stato stanno dentro la closure @ViewBuilder di
// PhotosPicker, che non eredita l'isolamento del contenitore.
@MainActor
struct EditProfileView: View {
    let container: AppContainer
    let session: SessionStore
    let currentUser: AppUser

    @Environment(\.dismiss) private var dismiss

    @State private var displayName: String
    @State private var pickerItem: PhotosPickerItem?
    @State private var pickedImageData: Data?
    @State private var pickedImageError: String?
    @State private var cropSourceImage: UIImage?
    @State private var isCropEditorPresented = false
    @State private var isPreparingPhoto = false
    @State private var isSaving: Bool = false
    @State private var errorMessage: String?

    init(container: AppContainer, session: SessionStore, currentUser: AppUser) {
        self.container = container
        self.session = session
        self.currentUser = currentUser
        _displayName = State(initialValue: currentUser.displayName)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                avatarSection
                nicknameSection
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
                saveButton
            }
            .padding(20)
        }
        .background(TwoWatchBackground())
        .navigationTitle("Modifica profilo")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Annulla") { dismiss() }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }
        }
        .onChange(of: pickerItem) { _, newItem in
            guard let newItem else { return }
            Task { await loadPickedImage(newItem) }
        }
        .sheet(isPresented: $isCropEditorPresented) {
            if let cropSourceImage {
                AvatarCropEditor(
                    image: cropSourceImage,
                    onCancel: {
                        isCropEditorPresented = false
                        self.cropSourceImage = nil
                        pickerItem = nil
                    },
                    onConfirm: { data in
                        pickedImageData = data
                        pickedImageError = nil
                        isCropEditorPresented = false
                        self.cropSourceImage = nil
                    }
                )
            }
        }
    }

    private var avatarSection: some View {
        // Lo stato si legge QUI e non dentro la closure di PhotosPicker: quella
        // e' una closure @ViewBuilder nonisolated, che non eredita
        // l'isolamento della View nemmeno con @MainActor sul tipo. Leggerlo
        // fuori e passarlo per valore e' l'unica forma che il compilatore
        // accetta senza allargare l'isolamento a codice che non deve averlo.
        let isPreparing = isPreparingPhoto
        return VStack(spacing: 12) {
            avatarPreview
                .frame(width: 130, height: 130)
                .clipShape(Circle())
                .overlay(Circle().stroke(TwoWatchTheme.border, lineWidth: 1))

            HStack(spacing: 10) {
                PhotosPicker(selection: $pickerItem, matching: .images) {
                    HStack(spacing: 8) {
                        if isPreparing {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Image(systemName: "photo.fill")
                        }
                        Text(isPreparing ? "Preparo la foto…" : "Cambia foto")
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(TwoWatchTheme.brandPrimary, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isPreparingPhoto || isSaving)

                if pickedImageData != nil {
                    Button {
                        pickedImageData = nil
                        pickerItem = nil
                    } label: {
                        Text("Annulla")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }

            if let pickedImageError {
                Text(pickedImageError)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
            }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var avatarPreview: some View {
        if let data = pickedImageData, let uiImage = UIImage(data: data) {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFill()
        } else if let url = currentUser.photoURL ?? currentUser.avatarURL {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case .success(let img): img.resizable().scaledToFill()
                default: placeholderAvatar
                }
            }
        } else {
            placeholderAvatar
        }
    }

    private var placeholderAvatar: some View {
        ZStack {
            Circle().fill(TwoWatchTheme.panel)
            Text(currentUser.displayName.prefix(1).uppercased())
                .font(.system(size: 50, weight: .bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
    }

    private var nicknameSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nickname")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .textCase(.uppercase)
            TextField("Nickname", text: $displayName)
                .textFieldStyle(.plain)
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .padding(12)
                .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(TwoWatchTheme.border, lineWidth: 1))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Text("Visibile agli altri utenti nella ricerca, nei thread e nelle attività.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
    }

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            if isSaving {
                ProgressView().tint(.white)
            } else {
                Text("Salva modifiche")
            }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(isSaving || !hasChanges)
        .opacity(hasChanges ? 1 : 0.55)
    }

    private var hasChanges: Bool {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed != currentUser.displayName, trimmed.count >= 3 {
            return true
        }
        return pickedImageData != nil
    }

    // `nonisolated` di proposito: `normalizedForAvatarCropping()`
    // ri-renderizza la foto a piena risoluzione, e su uno scatto da 12 MP sul
    // main actor si vedrebbe. Lo stato lo tocca gia' via `MainActor.run`,
    // quindi il comportamento resta identico a prima.
    nonisolated private func loadPickedImage(_ item: PhotosPickerItem) async {
        await MainActor.run {
            isPreparingPhoto = true
            pickedImageError = nil
        }
        defer {
            Task { @MainActor in
                isPreparingPhoto = false
            }
        }

        do {
            let data = try await item.loadTransferable(type: Data.self)
            guard let raw = data, let uiImage = UIImage(data: raw) else {
                await MainActor.run {
                    pickedImageError = "Impossibile leggere l'immagine."
                    pickerItem = nil
                }
                return
            }
            let normalized = uiImage.normalizedForAvatarCropping()
            await MainActor.run {
                cropSourceImage = normalized
                isCropEditorPresented = true
            }
        } catch {
            await MainActor.run {
                pickedImageError = UserFacingError.message(for: error)
                pickerItem = nil
            }
        }
    }

    @MainActor
    private func save() async {
        guard let uid = session.firebaseUser?.uid else { return }
        isSaving = true
        defer { isSaving = false }
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let nameChanged = trimmed != currentUser.displayName && trimmed.count >= 3
        do {
            try await container.userRepository.updateProfile(
                userID: uid,
                newDisplayName: nameChanged ? trimmed : nil,
                photoData: pickedImageData,
                clearPhoto: false
            )
            // Refresh the cached AppUser so the rest of the app sees the new
            // values without a relaunch.
            if let updated = try? await container.userRepository.fetchUser(uid: uid) {
                session.appUser = updated
            }
            dismiss()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

private struct AvatarCropEditor: View {
    let image: UIImage
    let onCancel: () -> Void
    let onConfirm: (Data) -> Void

    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var dragTranslation: CGSize = .zero
    @GestureState private var gestureZoom: CGFloat = 1
    @State private var cropError: String?

    private let maximumZoom: CGFloat = 4
    private var stageSize: CGFloat { min(UIScreen.main.bounds.width - 48, 360) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Text("Inquadra la foto")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Trascina per scegliere il centro e usa lo zoom per avvicinare.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                }

                cropStage

                HStack(spacing: 12) {
                    Image(systemName: "minus.magnifyingglass")
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    Slider(value: $zoom, in: 1...maximumZoom)
                        .tint(TwoWatchTheme.brandPrimary)
                        .onChange(of: zoom) {
                            offset = clampedOffset(offset, zoom: zoom)
                        }
                    Image(systemName: "plus.magnifyingglass")
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
                .padding(.horizontal, 12)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Zoom foto profilo")
                .accessibilityValue("\(Int(zoom * 100)) percento")

                if let cropError {
                    Text(cropError)
                        .font(.footnote)
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }

                Spacer(minLength: 0)
            }
            .padding(24)
            .background(TwoWatchBackground())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Usa questa foto") {
                        confirmCrop()
                    }
                    .fontWeight(.semibold)
                }
            }
            .interactiveDismissDisabled()
        }
    }

    private var cropStage: some View {
        let liveZoom = min(max(zoom * gestureZoom, 1), maximumZoom)
        let proposedOffset = CGSize(
            width: offset.width + dragTranslation.width,
            height: offset.height + dragTranslation.height
        )
        let liveOffset = clampedOffset(proposedOffset, zoom: liveZoom)

        return ZStack {
            Color.black
            Image(uiImage: image)
                .resizable()
                .frame(width: image.size.width, height: image.size.height)
                .scaleEffect(baseScale * liveZoom)
                .offset(liveOffset)
        }
        .frame(width: stageSize, height: stageSize)
        .clipShape(Circle())
        .overlay(Circle().stroke(.white.opacity(0.88), lineWidth: 2))
        .overlay(Circle().stroke(TwoWatchTheme.brandPrimary.opacity(0.38), lineWidth: 8))
        .contentShape(Circle())
        .gesture(dragGesture.simultaneously(with: magnificationGesture))
        .accessibilityLabel("Anteprima ritaglio foto profilo")
        .accessibilityHint("Trascina l'immagine e regola lo zoom")
    }

    private var baseScale: CGFloat {
        max(stageSize / image.size.width, stageSize / image.size.height)
    }

    private var dragGesture: some Gesture {
        DragGesture()
            .updating($dragTranslation) { value, state, _ in
                state = value.translation
            }
            .onEnded { value in
                offset = clampedOffset(
                    CGSize(
                        width: offset.width + value.translation.width,
                        height: offset.height + value.translation.height
                    ),
                    zoom: zoom
                )
            }
    }

    private var magnificationGesture: some Gesture {
        MagnificationGesture()
            .updating($gestureZoom) { value, state, _ in
                state = value
            }
            .onEnded { value in
                zoom = min(max(zoom * value, 1), maximumZoom)
                offset = clampedOffset(offset, zoom: zoom)
            }
    }

    private func clampedOffset(_ proposed: CGSize, zoom: CGFloat) -> CGSize {
        let effectiveScale = baseScale * zoom
        let maximumX = max(0, (image.size.width * effectiveScale - stageSize) / 2)
        let maximumY = max(0, (image.size.height * effectiveScale - stageSize) / 2)
        return CGSize(
            width: min(max(proposed.width, -maximumX), maximumX),
            height: min(max(proposed.height, -maximumY), maximumY)
        )
    }

    private func confirmCrop() {
        let effectiveScale = baseScale * zoom
        let sourceSide = stageSize / effectiveScale
        let originX = (image.size.width - sourceSide) / 2 - offset.width / effectiveScale
        let originY = (image.size.height - sourceSide) / 2 - offset.height / effectiveScale
        let cropRect = CGRect(x: originX, y: originY, width: sourceSide, height: sourceSide)
            .integral
            .intersection(CGRect(origin: .zero, size: image.size))

        guard cropRect.width > 0,
              cropRect.height > 0,
              let source = image.cgImage,
              let cropped = source.cropping(to: cropRect),
              let jpeg = AvatarCropEditor.squareJPEG(from: cropped) else {
            cropError = "Impossibile ritagliare l'immagine."
            return
        }
        onConfirm(jpeg)
    }

    /// Delega all'encoder condiviso: il formato dell'avatar deve essere lo
    /// stesso anche quando la foto arriva dall'onboarding, che non passa da
    /// questo editor.
    private static func squareJPEG(from image: CGImage) -> Data? {
        AvatarImageEncoder.encode(image)
    }
}

private extension UIImage {
    func normalizedForAvatarCropping() -> UIImage {
        guard imageOrientation != .up || scale != 1 else { return self }
        let pixelSize = CGSize(
            width: cgImage?.width ?? Int(size.width * scale),
            height: cgImage?.height ?? Int(size.height * scale)
        )
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: pixelSize, format: format)
        return renderer.image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: pixelSize))
            draw(in: CGRect(origin: .zero, size: pixelSize))
        }
    }
}
