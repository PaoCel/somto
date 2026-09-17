import SwiftUI
import UIKit

// Riepilogo attivita': ore viste (con l'unita' ciclabile), conteggi per
// categoria. Estratti da ProfileComponents.swift.

enum WatchTimeUnitMode: String, CaseIterable {
    case dhm
    case hours
    case days
    case months
    case years
    case minutes
    case binary

    var next: WatchTimeUnitMode {
        let all = Self.allCases
        let index = all.firstIndex(of: self) ?? 0
        return all[(index + 1) % all.count]
    }

    var hintLabel: String {
        switch self {
        case .dhm: return "giorni · ore · min"
        case .hours: return "ore"
        case .days: return "giorni"
        case .months: return "mesi"
        case .years: return "anni"
        case .minutes: return "minuti"
        case .binary: return "minuti in binario"
        }
    }
}

struct ProfileActivitySummarySection: View {
    let activitySummary: ProfileActivitySummary
    let reviewCount: Int
    var isLoading: Bool = false
    var user: AppUser? = nil
    var showsReviewCount = true
    var showsCaption = true
    var captionText: String? = nil
    /// Solo sul profilo proprio: apre il flusso di import cronologia (TV Time / Netflix).
    /// `nil` nasconde la riga (es. profilo altrui).
    var onImportRequested: (() -> Void)? = nil

    /// Strip contatori-filtro Film/Serie/Cartoni/Anime dentro il blocco tempo di
    /// visione. Conteggi calcolati dal parent sulla libreria "Visti". La strip
    /// compare solo se `categoryFilterSelection != nil` e c'è almeno un titolo.
    var categoryCounts: [ContentCategory: Int] = [:]
    var categoryFilterSelection: Binding<Set<ContentCategory>>? = nil
    /// Invocato quando l'utente tocca una categoria: il parent porta al tab "Visti".
    var onCategoryFilterSelected: ((ContentCategory) -> Void)? = nil

    // Dynamic Type: mantiene la dimensione default (34pt), scala con le preferenze utente
    @ScaledMetric(relativeTo: .largeTitle) private var separatorFontSize: CGFloat = 34

    @State private var shareImage: UIImage?
    @State private var showShareSheet = false
    @State private var isRenderingShare = false

    /// `@AppStorage` tipizzato: `WatchTimeUnitMode` e' `RawRepresentable` con
    /// raw value `String`, quindi il compilatore garantisce che sul disco
    /// finiscano solo casi validi e sparisce la conversione difensiva a ogni
    /// lettura (docs/context/IOS_CODE_STYLE.md §3.4).
    @AppStorage(SomtoDefaultsKey.watchTimeUnit) private var watchTimeUnitMode: WatchTimeUnitMode = .dhm

    private func cycleWatchTimeUnit() {
        watchTimeUnitMode = watchTimeUnitMode.next
    }

    private var categoryTotal: Int {
        categoryCounts.values.reduce(0, +)
    }

    private var timeParts: (days: Int, hours: Int, minutes: Int) {
        let safeMinutes = max(0, activitySummary.totalWatchMinutes)
        let days = safeMinutes / 1_440
        let hours = (safeMinutes % 1_440) / 60
        let minutes = safeMinutes % 60
        return (days, hours, minutes)
    }

    /// Formattazione italiana (virgola decimale, 1 decimale) per le unità
    /// espresse come numero frazionario (giorni/mesi/anni).
    private func formattedDecimalIT(_ value: Double) -> String {
        String(format: "%.1f", max(0, value)).replacingOccurrences(of: ".", with: ",")
    }

    /// Valore singolo (numero + unità) per tutte le modalità diverse da `dhm`.
    private var singleUnitDisplay: (value: String, unit: String) {
        let safeMinutes = max(0, activitySummary.totalWatchMinutes)
        let totalHours = Double(safeMinutes) / 60.0
        let roundedHours = Int(totalHours.rounded())

        switch watchTimeUnitMode {
        case .dhm:
            return ("", "")
        case .hours:
            return ("\(roundedHours)", "ore")
        case .days:
            return (formattedDecimalIT(Double(safeMinutes) / 1_440.0), "giorni")
        case .months:
            return (formattedDecimalIT(Double(safeMinutes) / 43_830.0), "mesi")
        case .years:
            return (formattedDecimalIT(Double(safeMinutes) / 525_960.0), "anni")
        case .minutes:
            return ("\(safeMinutes)", "min")
        case .binary:
            return (String(safeMinutes, radix: 2), "minuti in binario")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("Tempo di visione", systemImage: "clock.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.warning)

                Spacer()

                if showsReviewCount {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text("\(reviewCount) review")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                        // Voti serie derivati dai voti episodio (privato, solo profilo proprio).
                        if activitySummary.derivedRatingsCount > 0 {
                            Text("+\(activitySummary.derivedRatingsCount) dai tuoi voti episodio")
                                .font(.caption2)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }
                    }
                }

                if user != nil {
                    Button {
                        guard let user, !isRenderingShare else { return }
                        isRenderingShare = true
                        Task {
                            let image = WatchTimeShareHelper.renderShareImage(
                                user: user,
                                activitySummary: activitySummary,
                                reviewCount: reviewCount
                            )
                            shareImage = image
                            isRenderingShare = false
                            showShareSheet = image != nil
                        }
                    } label: {
                        if isRenderingShare {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 32, height: 32)
                        } else {
                            Image(systemName: "square.and.arrow.up")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.brandPrimary)
                                .frame(width: 32, height: 32)
                                .background(TwoWatchTheme.brandPrimary.opacity(0.1), in: Circle())
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(isRenderingShare)
                    // Area tocco ≥44pt; il chip visivo resta 32pt
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityLabel("Condividi statistiche visione")
                }
            }

            Button(action: cycleWatchTimeUnit) {
                VStack(spacing: 6) {
                    Group {
                        if watchTimeUnitMode == .dhm {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                ProfileDigitalTimeBlock(value: timeParts.days, unit: "giorni", isLoading: isLoading)
                                timeSeparator
                                ProfileDigitalTimeBlock(value: timeParts.hours, unit: "ore", isLoading: isLoading)
                                timeSeparator
                                ProfileDigitalTimeBlock(value: timeParts.minutes, unit: "min", isLoading: isLoading)
                            }
                        } else {
                            ProfileDigitalSingleValueBlock(
                                value: singleUnitDisplay.value,
                                unit: singleUnitDisplay.unit,
                                isLoading: isLoading
                            )
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .center)

                    HStack(spacing: 4) {
                        Text("\(watchTimeUnitMode.hintLabel) · tocca per cambiare")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                        // Affordance visiva: segnala che il valore sopra è "editabile" (ciclabile).
                        Image(systemName: "pencil")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                }
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tempo di visione, unità \(watchTimeUnitMode.hintLabel)")
            .accessibilityHint("Tocca per cambiare unità di misura")

            if let categoryFilterSelection, categoryTotal > 0 {
                ProfileCategoryFilterStrip(
                    counts: categoryCounts,
                    selected: categoryFilterSelection,
                    onSelect: { category in onCategoryFilterSelected?(category) }
                )
            }

            if let onImportRequested {
                Button(action: onImportRequested) {
                    HStack(spacing: 8) {
                        Image(systemName: "square.and.arrow.down.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)

                        VStack(alignment: .leading, spacing: 1) {
                            Text("Importa la tua cronologia")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                            Text("Da TV Time o Netflix")
                                .font(.caption2)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }

                        Spacer(minLength: 0)

                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(TwoWatchTheme.panel.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Importa la tua cronologia da TV Time o Netflix")
            }

            // La strip contatori-filtro (Film/Serie/Cartoni/Anime) è renderizzata
            // sopra, tra il timer e la CTA import: i counter sono cliccabili e
            // filtrano la libreria "Visti" (vedi ProfileCategoryFilterStrip).

            if showsCaption {
                Text(captionText ?? defaultCaptionText)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .multilineTextAlignment(.center)
            }
        }
        .sheet(isPresented: $showShareSheet) {
            if let shareImage {
                ShareSheetView(items: [shareImage])
            }
        }
    }

    private var timeSeparator: some View {
        Text(":")
            .font(.system(size: separatorFontSize, weight: .black, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(TwoWatchTheme.textMuted)
            .padding(.bottom, 18)
    }

    private var defaultCaptionText: String {
        if user != nil {
            return "Tempo totale speso a guardare titoli nella tua libreria."
        }
        return String(localized: "Tempo totale speso a guardare titoli nella libreria di questo utente.")
    }
}

extension ContentCategory {
    /// SF Symbol per la strip categorie del profilo.
    var symbolName: String {
        switch self {
        case .film: return "film.fill"
        case .serieTV: return "tv.fill"
        case .cartoniAnimati: return "face.smiling.fill"
        case .anime: return "sparkles"
        }
    }

    /// Tinta per categoria, presa dalla palette esistente (nessun colore nuovo).
    var accentColor: Color {
        switch self {
        case .film: return TwoWatchTheme.brandPrimary
        case .serieTV: return TwoWatchTheme.brandSecondary
        case .cartoniAnimati: return TwoWatchTheme.brandWarm
        case .anime: return TwoWatchTheme.accent
        }
    }
}

/// Conteggio titoli visti per categoria (Film/Serie/Cartoni/Anime), calcolato
/// sull'intera libreria "Visti": alimenta la strip contatori-filtro del blocco
/// "Tempo di visione". Condiviso da ProfileView e UserProfileDetailView.
/// Contatori per categoria della griglia "Visti". Solo titoli finiti, come
/// `stats.byCategory` lato server: le serie in corso stanno nella proiezione
/// `library` ma non sono "viste".
func profileWatchedCategoryCounts(_ entries: [LibraryEntry]) -> [ContentCategory: Int] {
    var counts: [ContentCategory: Int] = [:]
    for entry in entries where entry.isCompletedWatch {
        guard let title = entry.title else { continue }
        counts[title.profileContentCategory, default: 0] += 1
    }
    return counts
}

/// Strip contatori Film/Serie/Cartoni/Anime che fa ANCHE da filtro tipo
/// (multi-select), mostrata dentro la card "Tempo di visione" del profilo.
/// I counter SONO i filtri: toccarne uno filtra la libreria "Visti" (tramite
/// il binding `selected`) e notifica il parent via `onSelect` così può portare
/// l'utente sul tab Visti. Una categoria a zero resta visibile ma disabilitata.
/// Stile a token di tema (testo chiaro) perché vive sul blocco scuro, non sulla
/// card bianca del tab Visti.
