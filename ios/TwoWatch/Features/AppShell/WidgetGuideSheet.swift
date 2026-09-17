import SwiftUI

/// Come si usa il widget, in tre passaggi.
///
/// PERCHE' ESISTE — dal widget non si scopre niente da soli: che il bottone
/// segni davvero l'episodio senza aprire l'app si intuisce, ma che la serie si
/// cambi tenendo premuto e andando su "Modifica widget" no. Constatato sul
/// device il 2026-08-14: "non avevo idea di come si potesse cambiare serie".
///
/// PERCHE' DISEGNI E NON SCREENSHOT — uno screenshot invecchia al primo ritocco
/// del widget e nessuno se ne accorge finche' non stona. Questi mockup sono gli
/// stessi token del widget vero (`TwoWatchTheme`, `SomtoSpacing`): se cambia la
/// palette, cambiano con lei.
///
/// Si apre SOLO toccando il widget, cioe' nel momento in cui la domanda c'e'.
struct WidgetGuideSheet: View {
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: SomtoSpacing.xxl) {
                    Text("Segna gli episodi dalla schermata Home, senza aprire l'app.")
                        .font(.title3)
                        .fontWeight(.semibold)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)

                    WidgetGuideStep(
                        number: 1,
                        title: "Tocca «Episodio visto»",
                        detail: "Il punto in cui sei si aggiorna subito, qui e in Somto."
                    ) {
                        WidgetGuideMockup(showsButton: true, highlightsMenu: false)
                    }

                    WidgetGuideStep(
                        number: 2,
                        title: "Per cambiare serie, tieni premuto",
                        detail: "Tieni premuto il widget, scegli «Modifica widget» e poi la serie."
                    ) {
                        WidgetGuideMockup(showsButton: false, highlightsMenu: true)
                    }

                    WidgetGuideStep(
                        number: 3,
                        title: "L'elenco arriva dalla tua watchlist",
                        detail: "Ci sono le serie in corso e quelle che non hai ancora iniziato. Si aggiorna quando apri Somto."
                    ) {
                        EmptyView()
                    }
                }
                .padding(SomtoSpacing.xl)
            }
            .background(TwoWatchTheme.screenGradient.ignoresSafeArea())
            .navigationTitle("Il widget di Somto")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi", action: onClose)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }
}

private struct WidgetGuideStep<Illustration: View>: View {
    let number: Int
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    @ViewBuilder let illustration: Illustration

    var body: some View {
        VStack(alignment: .leading, spacing: SomtoSpacing.m) {
            HStack(alignment: .firstTextBaseline, spacing: SomtoSpacing.m) {
                Text("\(number)")
                    .font(.footnote)
                    .fontWeight(.bold)
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .frame(width: 22, height: 22)
                    .background(TwoWatchTheme.brandPrimary.opacity(0.16), in: Circle())

                VStack(alignment: .leading, spacing: SomtoSpacing.xs) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            illustration
        }
    }
}

/// Il widget disegnato: stessa forma, stessi colori, contenuto finto.
private struct WidgetGuideMockup: View {
    let showsButton: Bool
    let highlightsMenu: Bool

    var body: some View {
        HStack(alignment: .top, spacing: SomtoSpacing.ml) {
            VStack(alignment: .leading, spacing: SomtoSpacing.s) {
                Text("Segna episodio")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(TwoWatchTheme.textSecondary)

                HStack(spacing: SomtoSpacing.ml) {
                    RoundedRectangle(cornerRadius: SomtoRadius.xs, style: .continuous)
                        .fill(TwoWatchTheme.panelStrong)
                        .frame(width: 30, height: 45)

                    VStack(alignment: .leading, spacing: SomtoSpacing.xs) {
                        Text("La tua serie")
                            .font(.subheadline)
                            .fontWeight(.semibold)
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                        Text("Sei a S2·E4")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                    }
                }

                if showsButton {
                    Label("Episodio visto", systemImage: "checkmark")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, SomtoSpacing.s)
                        .background(
                            TwoWatchTheme.brandPrimary.opacity(0.22),
                            in: RoundedRectangle(cornerRadius: SomtoRadius.s, style: .continuous)
                        )
                }
            }
            .padding(SomtoSpacing.ml)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: SomtoRadius.xl, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: SomtoRadius.xl, style: .continuous)
                    .strokeBorder(TwoWatchTheme.border, lineWidth: 1)
            )

            if highlightsMenu {
                // Il menu che compare tenendo premuto: due voci bastano a far
                // riconoscere la cosa, la terza e' quella che serve.
                VStack(alignment: .leading, spacing: SomtoSpacing.s) {
                    Text("Modifica widget")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Rimuovi widget")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .padding(SomtoSpacing.m)
                .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: SomtoRadius.m, style: .continuous))
            }
        }
        .accessibilityHidden(true)
    }
}
