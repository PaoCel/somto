import SwiftUI

// Testa della scheda titolo: metadati rapidi, aggiornamenti del titolo,
// trama e l'editor editoriale. Estratti da TitleDetailSections.swift.

struct TitleQuickMetadataSection: View {
    let title: Title
    let seasons: [TitleSeason]
    let isCompactWidth: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if metadataItems.isEmpty {
                EmptyStateView(
                    title: "Info non disponibili",
                    message: "Le informazioni editoriali di questo titolo non sono ancora complete.",
                    systemImage: "sparkles.tv"
                )
            } else {
                Text("Info essenziali")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                if isCompactWidth {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(metadataItems) { item in
                            metadataTextRow(item)
                        }
                    }
                } else {
                    LazyVGrid(columns: metadataColumns, alignment: .leading, spacing: 8) {
                        ForEach(metadataItems) { item in
                            metadataTextRow(item)
                        }
                    }
                }
            }
        }
    }

    private var metadataItems: [TitleMetadataItem] {
        var items: [TitleMetadataItem] = []

        if title.type == .movie, let duration = title.metadata.durationMovie, duration > 0 {
            items.append(TitleMetadataItem(label: "Durata", value: "\(duration) min", systemName: "clock.fill"))
        }

        if title.type == .tv {
            let seasonsCount = seasons.isEmpty ? title.metadata.seasonsCount : seasons.count
            if let seasonsCount, seasonsCount > 0 {
                items.append(TitleMetadataItem(label: "Stagioni", value: "\(seasonsCount)", systemName: "rectangle.stack.fill"))
            }

            if let episodesPerSeason = title.metadata.episodesPerSeason, episodesPerSeason > 0 {
                items.append(TitleMetadataItem(label: "Episodi / stagione", value: "\(episodesPerSeason)", systemName: "list.number"))
            }

            if let durationEpisode = title.metadata.durationEpisode, durationEpisode > 0 {
                items.append(TitleMetadataItem(label: "Durata episodio", value: "\(durationEpisode) min", systemName: "timer"))
            }
        }

        if let language = TitleDetailFormatter.languageName(title.metadata.language) {
            items.append(TitleMetadataItem(label: "Lingua originale", value: language, systemName: "captions.bubble.fill"))
        }

        if let country = TitleDetailFormatter.countryName(title.metadata.country) {
            items.append(TitleMetadataItem(label: "Paese", value: country, systemName: "globe.europe.africa.fill"))
        }

        if let network = title.metadata.network?.trimmingCharacters(in: .whitespacesAndNewlines), !network.isEmpty {
            items.append(TitleMetadataItem(label: "Piattaforma", value: network, systemName: "tv.fill"))
        }

        return items
    }

    private func metadataTextRow(_ item: TitleMetadataItem) -> some View {
        HStack(spacing: 8) {
            Image(systemName: item.systemName)
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.accent)

            Text("\(item.label): ")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
            +
            Text(item.value)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var metadataColumns: [GridItem] {
        if isCompactWidth {
            return [GridItem(.flexible(), spacing: 12)]
        }
        return [
            GridItem(.flexible(), spacing: 12),
            GridItem(.flexible(), spacing: 12)
        ]
    }
}

@MainActor
struct TitleUpdatesSection: View {
    let snapshot: TitleUpdatesSnapshot
    let isLoading: Bool
    let errorMessage: String?
    let preference: TitleUpdatePreference
    let isSavingPreference: Bool
    let canManagePreference: Bool
    let onRetry: () -> Void
    let onOpenOfficialUpdate: (String) -> Void
    let onSetPreference: (TitleUpdatePreference) -> Void

    var body: some View {
        VStack(spacing: 18) {
            TitleSectionCard {
                VStack(alignment: .leading, spacing: 16) {
                    TitleSectionHeader(
                        title: "Aggiornamenti",
                        subtitle: "Trailer, uscite e contenuti collegati al titolo."
                    )

                    if isLoading, snapshot.events.isEmpty, snapshot.videos.isEmpty, snapshot.officialUpdates.isEmpty {
                        HStack(spacing: 10) {
                            ProgressView().tint(TwoWatchTheme.accent)
                            Text("Caricamento aggiornamenti...")
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                    } else if let errorMessage, snapshot.events.isEmpty, snapshot.videos.isEmpty, snapshot.officialUpdates.isEmpty, snapshot.release == nil {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(errorMessage)
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                            Button("Riprova", action: onRetry)
                                .buttonStyle(.bordered)
                        }
                    } else {
                        updatesContent
                    }
                }
            }

            if canManagePreference {
                TitleSectionCard {
                    VStack(alignment: .leading, spacing: 12) {
                        TitleSectionHeader(
                            title: "Notifiche per questo titolo",
                            subtitle: "Scegli quali aggiornamenti vuoi ricevere."
                        )

                        Menu {
                            ForEach(TitleUpdatePreference.allCases) { option in
                                Button {
                                    onSetPreference(option)
                                } label: {
                                    if option == preference {
                                        Label(option.label, systemImage: "checkmark")
                                    } else {
                                        Text(option.label)
                                    }
                                }
                            }
                        } label: {
                            HStack {
                                Image(systemName: preference == .muted ? "bell.slash.fill" : "bell.badge.fill")
                                Text(preference.label)
                                    .font(.subheadline.weight(.semibold))
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down")
                                    .font(.caption.weight(.bold))
                            }
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .padding(.horizontal, 14)
                            .frame(height: 46)
                            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .disabled(isSavingPreference)
                        .opacity(isSavingPreference ? 0.65 : 1)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var updatesContent: some View {
        if let release = snapshot.release {
            HStack(spacing: 12) {
                Image(systemName: release.isEpisode ? "calendar.badge.clock" : "calendar")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .frame(width: 42, height: 42)
                    .background(TwoWatchTheme.accent.opacity(0.12), in: Circle())

                VStack(alignment: .leading, spacing: 3) {
                    Text(release.isEpisode ? "Prossimo episodio" : "In uscita")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                        .textCase(.uppercase)

                    Text(releaseTitle(release))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }

        let isEmpty = snapshot.events.isEmpty && snapshot.officialUpdates.isEmpty && snapshot.videos.isEmpty && snapshot.release == nil
        if isEmpty {
            SectionEmptyStateView(
                title: "Nessun aggiornamento disponibile",
                message: "Trailer, uscite e contenuti collegati compariranno qui.",
                systemImage: "clock.badge"
            )
        } else {
            VStack(spacing: 0) {
                ForEach(snapshot.events) { event in
                    Group {
                        if let destination = event.sourceURL {
                            Link(destination: destination) { eventRow(event) }
                                .buttonStyle(.plain)
                        } else {
                            eventRow(event)
                        }
                    }
                    .id("title-update-\(event.id)")
                    Divider().overlay(TwoWatchTheme.border)
                }

                ForEach(snapshot.officialUpdates) { update in
                    Button {
                        onOpenOfficialUpdate(update.id)
                    } label: {
                        officialUpdateRow(update)
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(TwoWatchTheme.border)
                }

                ForEach(snapshot.videos) { video in
                    if let destination = video.youtubeURL {
                        Link(destination: destination) { videoRow(video) }
                            .buttonStyle(.plain)
                    }
                    if video.id != snapshot.videos.last?.id {
                        Divider().overlay(TwoWatchTheme.border)
                    }
                }
            }
        }
    }

    private func releaseTitle(_ release: TitleReleaseUpdate) -> String {
        let date = release.date.formatted(.dateTime.day().month(.wide).year())
        guard release.isEpisode else { return date }
        let code: String
        if let season = release.season, let episode = release.episode {
            code = "S\(season) · E\(episode)"
        } else {
            code = "Nuovo episodio"
        }
        if let name = release.name, !name.isEmpty {
            return "\(code) · \(name) · \(date)"
        }
        return "\(code) · \(date)"
    }

    private func videoRow(_ video: TitleUpdateVideo) -> some View {
        HStack(spacing: 12) {
            CachedAsyncImage(url: video.thumbnailURL) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                default:
                    ZStack {
                        TwoWatchTheme.panel
                        Image(systemName: "play.fill")
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                }
            }
            .frame(width: 112, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(alignment: .center) {
                Image(systemName: "play.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(Color.black.opacity(0.58), in: Circle())
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(video.kind == "teaser" ? "Teaser" : "Trailer")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(video.kind == "teaser" ? TwoWatchTheme.brandWarm : TwoWatchTheme.accent)
                    .textCase(.uppercase)

                Text(video.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)

                if let publishedAt = video.publishedAt {
                    Text(publishedAt.formatted(.dateTime.day().month(.abbreviated).year()))
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func eventRow(_ event: TitleUpdateEvent) -> some View {
        HStack(spacing: 12) {
            Image(systemName: eventIcon(event.eventType))
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.accent)
                .frame(width: 42, height: 42)
                .background(TwoWatchTheme.accent.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(eventTypeLabel(event.eventType))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .textCase(.uppercase)
                Text(event.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
                if let sortAt = event.sortAt {
                    Text(sortAt.formatted(.dateTime.day().month(.abbreviated).year()))
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
            Spacer(minLength: 0)
            if event.sourceURL != nil {
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func officialUpdateRow(_ update: TitleOfficialUpdate) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.seal.fill")
                .font(.headline)
                .foregroundStyle(TwoWatchTheme.brandWarm)
                .frame(width: 42, height: 42)
                .background(TwoWatchTheme.brandWarm.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text("Aggiornamento ufficiale")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandWarm)
                    .textCase(.uppercase)
                Text(update.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func eventTypeLabel(_ type: String) -> String {
        switch type {
        case "trailer": String(localized: "Trailer")
        case "teaser": String(localized: "Teaser")
        case "release_date": String(localized: "Data di uscita")
        case "new_episode": String(localized: "Nuovo episodio")
        case "new_season": String(localized: "Nuova stagione")
        case "renewal": String(localized: "Rinnovo")
        case "cancellation": String(localized: "Cancellazione")
        case "sequel": String(localized: "Sequel")
        case "casting": String(localized: "Casting")
        default: String(localized: "Aggiornamento ufficiale")
        }
    }

    private func eventIcon(_ type: String) -> String {
        switch type {
        case "trailer", "teaser": "play.rectangle.fill"
        case "release_date", "new_episode", "new_season": "calendar.badge.clock"
        case "renewal", "sequel": "arrow.triangle.2.circlepath"
        case "cancellation": "xmark.circle.fill"
        case "casting": "person.2.fill"
        default: "megaphone.fill"
        }
    }
}

struct TitleOverviewSection: View {
    let overview: String?
    let trailerURL: URL?
    /// Il trailer si risolve dopo il primo render: senza questo, il blocco
    /// sinossi si chiudeva sul testo e il player compariva a scatto.
    var isLoadingTrailer: Bool = false
    let canEditEditorialContent: Bool
    let isExpanded: Bool
    let onToggleExpanded: () -> Void
    let onOpenEditor: () -> Void
    @State private var isSafariFallbackPresented = false
    @State private var isInlineTrailerUnavailable = false

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Sinossi e trailer",
                    subtitle: "Contesto editoriale e trailer ufficiale nello stesso blocco."
                )

                if let overview, hasOverview {
                    Text(overview)
                        .font(.body)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .lineSpacing(3)
                        .lineLimit(isExpanded ? nil : 5)

                    if overview.count > 180 {
                        Button(isExpanded ? "Mostra meno" : "Leggi tutto", action: onToggleExpanded)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.accent)
                    }
                }

                if let trailerURL {
                    VStack(alignment: .leading, spacing: 12) {
                        if isInlineTrailerUnavailable {
                            Button {
                                isSafariFallbackPresented = true
                            } label: {
                                trailerFallbackCard
                            }
                            .buttonStyle(.plain)
                        } else {
                            EmbeddedTrailerView(
                                trailerURL: trailerURL,
                                onPlaybackUnavailable: {
                                    isInlineTrailerUnavailable = true
                                }
                            )
                            .frame(height: 208)
                            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 24, style: .continuous)
                                    .stroke(TwoWatchTheme.border, lineWidth: 1)
                            )
                        }

                        Button {
                            isSafariFallbackPresented = true
                        } label: {
                            Label("Apri su YouTube", systemImage: "play.rectangle.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.accent)
                        }
                        .buttonStyle(.plain)
                    }
                } else if isLoadingTrailer {
                    TitleSkeletonBlock(height: 208, cornerRadius: 24)
                        .accessibilityLabel(Text("Carico il trailer…"))
                } else if !hasOverview {
                    SectionEmptyStateView(
                        title: "Contenuti non disponibili",
                        message: "Per questo titolo non abbiamo ancora sinossi o trailer da mostrare.",
                        systemImage: "play.rectangle",
                        actionTitle: editorActionTitle.map { LocalizedStringKey($0) },
                        action: canEditEditorialContent ? onOpenEditor : nil
                    )
                }

                // Niente "Aggiungi il trailer" finché il trailer sta ancora
                // arrivando: sarebbe una richiesta basata su un dato non letto.
                if canEditEditorialContent && !isLoadingTrailer && needsEditorialCompletion && (hasOverview || trailerURL != nil) {
                    Button(action: onOpenEditor) {
                        HStack(spacing: 10) {
                            Image(systemName: "square.and.pencil")
                            Text(editorActionTitle ?? "Completa contenuti")
                        }
                    }
                    .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.accent))
                }
            }
        }
        .sheet(isPresented: $isSafariFallbackPresented) {
            if let trailerURL {
                TitleSafariView(url: trailerURL)
                    .ignoresSafeArea()
            }
        }
        .onChange(of: trailerURL) { _, _ in
            isInlineTrailerUnavailable = false
        }
    }

    private var trailerFallbackCard: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(TwoWatchTheme.panelStrong)

            VStack(spacing: 14) {
                Image(systemName: "play.rectangle.fill")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(TwoWatchTheme.accent)

                VStack(spacing: 6) {
                    Text("Trailer disponibile su YouTube")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text("L'embed interno non è stato accettato da YouTube per questo video.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .multilineTextAlignment(.center)
                }

                Text("Apri il trailer")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.accent)
            }
            .padding(24)
        }
        .frame(height: 208)
    }

    private var hasOverview: Bool {
        overview?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    private var needsEditorialCompletion: Bool {
        !hasOverview || trailerURL == nil
    }

    private var editorActionTitle: String? {
        guard canEditEditorialContent, needsEditorialCompletion else { return nil }
        if !hasOverview, trailerURL == nil {
            return "Aggiungi sinossi e trailer"
        }
        if !hasOverview {
            return String(localized: "Aggiungi la sinossi")
        }
        return String(localized: "Aggiungi il trailer")
    }
}

struct TitleEditorialEditorSheet: View {
    let title: Title
    let isOverviewMissing: Bool
    let isTrailerMissing: Bool
    let onSave: (String?, String?) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var overview = ""
    @State private var trailerInput = ""
    @State private var isSaving = false
    @State private var inlineError: String?

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    Text(helperText)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)

                    if isOverviewMissing {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Sinossi")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)

                            TextEditor(text: $overview)
                                .frame(minHeight: 180)
                                .padding(12)
                                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                                )
                        }
                    }

                    if isTrailerMissing {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Trailer YouTube")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)

                            TextField("https://www.youtube.com/watch?v=...", text: $trailerInput)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 14)
                                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                                )

                            Text("Va bene un link YouTube classico, `youtu.be` oppure il solo ID del video.")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                    }

                    if let inlineError, !inlineError.isEmpty {
                        Text(inlineError)
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(20)
            }
            .background(TwoWatchBackground().ignoresSafeArea())
            .navigationTitle("Completa contenuti")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla") {
                        dismiss()
                    }
                    .disabled(isSaving)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Salva")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(isSaving || !hasDraftContent)
                }
            }
        }
    }

    private var hasDraftContent: Bool {
        overview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            || trailerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    private var helperText: String {
        if isOverviewMissing && isTrailerMissing {
            return String(localized: "Per \(title.name) puoi aggiungere adesso una sinossi, un trailer YouTube o entrambi.")
        }
        if isOverviewMissing {
            return String(localized: "Per \(title.name) manca ancora la sinossi. Aggiungiamola qui in modo rapido.")
        }
        return String(localized: "Per \(title.name) manca ancora il trailer YouTube. Incolla il link e lo salviamo subito.")
    }

    private func save() async {
        isSaving = true
        inlineError = nil

        do {
            try await onSave(
                isOverviewMissing ? overview : nil,
                isTrailerMissing ? trailerInput : nil
            )
            dismiss()
        } catch {
            inlineError = UserFacingError.message(for: error)
        }

        isSaving = false
    }
}
