@preconcurrency import FirebaseStorage
import SwiftUI
import PhotosUI

// Editor di una lista personale (creazione e modifica) e il layout a capo
// per gli avatar dei collaboratori. Estratti da WatchlistView.swift.

struct WatchlistListEditorView: View {
    let container: AppContainer
    let session: SessionStore
    @Bindable var viewModel: WatchlistViewModel
    @Binding var selectedCoverItem: PhotosPickerItem?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section("Base") {
                TextField("Titolo lista", text: $viewModel.draft.title)
                TextField("Descrizione", text: $viewModel.draft.description, axis: .vertical)
                    .lineLimit(2...4)
                Picker("Visibilita", selection: $viewModel.draft.visibility) {
                    ForEach(UserListVisibility.allCases) { visibility in
                        Text(visibility.label).tag(visibility)
                    }
                }
                Picker("Tipo", selection: $viewModel.draft.kind) {
                    ForEach(UserListKind.allCases) { kind in
                        Text(kind.label).tag(kind)
                    }
                }
            }

            Section("Cover") {
                PhotosPicker(selection: $selectedCoverItem, matching: .images) {
                    Label("Scegli copertina", systemImage: "photo.on.rectangle")
                }
                .disabled(viewModel.isPreparingCover)
                if viewModel.isPreparingCover {
                    Label {
                        Text("Preparo la foto…")
                    } icon: {
                        ProgressView()
                    }
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                } else if viewModel.pendingCoverImage != nil
                    || viewModel.draft.coverStoragePath != nil
                    || viewModel.draft.coverImageURL != nil {
                    Text("Cover pronta. Verra caricata al salvataggio.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                } else {
                    Text("Se non carichi una cover, Somto usera un fallback automatico con i poster della lista.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
            }

            if viewModel.draft.visibility == .shared {
                Section("Collaboratori") {
                    TextField("Cerca utenti", text: $viewModel.collaboratorQuery)
                        .onSubmit {
                            guard let uid = session.firebaseUser?.uid else { return }
                            Task { await viewModel.searchCollaborators(userID: uid) }
                        }

                    if viewModel.isSearchingCollaborators {
                        Label {
                            Text("Preparo la ricerca")
                        } icon: {
                            ProgressView()
                        }
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    }

                    if !viewModel.draftCollaborators.isEmpty {
                        WrapUsersView(users: viewModel.draftCollaborators) { user in
                            viewModel.toggleCollaborator(user)
                        }
                    }

                    ForEach(viewModel.collaboratorResults) { user in
                        Button {
                            viewModel.toggleCollaborator(user)
                        } label: {
                            HStack {
                                Text(user.displayName)
                                Spacer()
                                if viewModel.draftCollaborators.contains(where: { $0.id == user.id }) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(TwoWatchTheme.accent)
                                }
                            }
                        }
                    }
                }
            }

            Section("Aggiungi titoli") {
                TextField("Ricerca manuale", text: $viewModel.titleSearchQuery)
                    .onSubmit {
                        Task { await viewModel.searchTitlesForDraft() }
                    }

                if viewModel.isSearchingTitles {
                    Label {
                        Text("Preparo la ricerca")
                    } icon: {
                        ProgressView()
                    }
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                ForEach(viewModel.titleSearchResults) { title in
                    Button {
                        let isSelected = !viewModel.draftSelectedTitles.contains(where: { $0.id == title.id })
                        viewModel.toggleDraftTitle(title, isSelected: isSelected)
                    } label: {
                        HStack {
                            SearchTitleRow(title: title)
                            if viewModel.draftSelectedTitles.contains(where: { $0.id == title.id }) {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(TwoWatchTheme.accent)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            Section("Input naturale") {
                TextField("Detta o scrivi una frase", text: $viewModel.draft.naturalPrompt, axis: .vertical)
                    .lineLimit(2...4)
                Text("Esempi: “tutti i film del Signore degli Anelli”, “film di Sherlock Holmes”, “Marvel in ordine cronologico”.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                Button {
                    Task { await viewModel.generateNaturalPreview() }
                } label: {
                    HStack(spacing: 8) {
                        if viewModel.isPreparingNaturalPreview {
                            ProgressView()
                        }
                        Text(
                            viewModel.isPreparingNaturalPreview
                                ? String(localized: "Preparo la ricerca")
                                : String(localized: "Interpreta e prepara preview")
                        )
                    }
                }
                .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.brandPrimary))
                .disabled(viewModel.isPreparingNaturalPreview)

                if let preview = viewModel.naturalPreview {
                    Text(preview.suggestedName)
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    ForEach(preview.candidates) { candidate in
                        Button {
                            if viewModel.naturalSelection.contains(candidate.id) {
                                viewModel.naturalSelection.remove(candidate.id)
                            } else {
                                viewModel.naturalSelection.insert(candidate.id)
                            }
                        } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: viewModel.naturalSelection.contains(candidate.id) ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(viewModel.naturalSelection.contains(candidate.id) ? TwoWatchTheme.accent : TwoWatchTheme.textMuted)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(candidate.title.name)
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                    Text(candidate.reason)
                                        .font(.caption)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Button("Aggiungi selezionati") {
                        viewModel.applyNaturalPreviewSelection()
                    }
                    .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.accent))
                }
            }

            Section("Selezione finale") {
                if viewModel.draftSelectedTitles.isEmpty {
                    Text("Nessun titolo selezionato.")
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                } else {
                    ForEach(viewModel.draftSelectedTitles) { title in
                        HStack {
                            Text(title.name)
                            Spacer()
                            Button(role: .destructive) {
                                viewModel.removeDraftTitle(title.id)
                            } label: {
                                Image(systemName: "minus.circle.fill")
                            }
                        }
                    }
                    .onMove { offsets, destination in
                        viewModel.moveDraftTitles(from: offsets, to: destination)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(TwoWatchBackground())
        .navigationTitle(viewModel.editorMode?.title ?? "Lista")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Chiudi") {
                    dismiss()
                    viewModel.editorMode = nil
                }
                .foregroundStyle(TwoWatchTheme.textPrimary)
            }

            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    guard let uid = session.firebaseUser?.uid, !viewModel.isSavingList else { return }
                    Task {
                        if await viewModel.saveList(userID: uid, owner: session.appUser) {
                            dismiss()
                        }
                    }
                } label: {
                    HStack(spacing: 7) {
                        if viewModel.isSavingList {
                            ProgressView()
                        }
                        Text(
                            viewModel.isSavingList
                                ? String(localized: "Salvo…")
                                : String(localized: "Salva")
                        )
                    }
                }
                .disabled(viewModel.isSavingList)
                .foregroundStyle(TwoWatchTheme.accent)
            }
        }
    }
}

struct WrapUsersView: View {
    let users: [AppUser]
    let onTap: (AppUser) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(users) { user in
                Button {
                    onTap(user)
                } label: {
                    HStack {
                        Text(user.displayName)
                        Spacer()
                        Image(systemName: "xmark.circle.fill")
                    }
                }
            }
        }
    }
}
