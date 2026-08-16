import SwiftUI

// Metriche del profilo: card hero, metriche inline, blocchi del tempo di
// visione. Estratti da ProfileComponents.swift.

struct ProfileHeroMetricCard: View {
    let title: String
    let value: String
    let systemImage: String
    let tint: Color
    let textPrimary: Color
    let textSecondary: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: systemImage)
                .font(.caption.weight(.bold))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(tint.opacity(0.14), in: Circle())

            Text(value)
                .font(.subheadline.weight(.black))
                .foregroundStyle(textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)

            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(tint.opacity(0.09), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct ProfileConnectionsInlineMetric: View {
    let title: String
    let count: Int
    let action: () -> Void
    private let primary = Color(hex: "#131826")
    private let secondary = Color(hex: "#5F6777")

    var body: some View {
        Button(action: action) {
            VStack(alignment: .center, spacing: 4) {
                Text("\(count)")
                    .font(.headline.weight(.black))
                    .foregroundStyle(primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)

                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(secondary)
                    .lineLimit(1)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 38)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count)")
        .accessibilityHint("Apre la lista completa")
    }
}

struct ProfileStaticInlineMetric: View {
    let title: String
    let value: String
    private let primary = Color(hex: "#131826")
    private let secondary = Color(hex: "#5F6777")

    var body: some View {
        VStack(alignment: .center, spacing: 4) {
            Text(value)
                .font(.headline.weight(.black))
                .foregroundStyle(primary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)

            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(secondary)
                .lineLimit(1)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 38)
    }
}

struct ProfileMetricDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.black.opacity(0.08))
            .frame(width: 1, height: 28)
            .accessibilityHidden(true) // separatore decorativo
    }
}

struct ProfileDigitalTimeBlock: View {
    let value: Int
    let unit: String
    var isLoading: Bool = false

    // Dynamic Type: mantiene la dimensione default (38pt), scala con le preferenze utente
    @ScaledMetric(relativeTo: .largeTitle) private var numberFontSize: CGFloat = 38

    @State private var displayValue: Int = 0
    @State private var timer: Timer?

    private var formattedValue: String {
        String(format: "%02d", max(0, isLoading ? displayValue : value))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(formattedValue)
                .font(.system(size: numberFontSize, weight: .black, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .contentTransition(.numericText())
                .animation(.easeOut(duration: 0.3), value: isLoading)

            Text(unit)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .onChange(of: isLoading) { _, loading in
            if loading {
                startSlotAnimation()
            } else {
                stopSlotAnimation()
            }
        }
        .onAppear {
            if isLoading {
                startSlotAnimation()
            }
        }
        .onDisappear {
            stopSlotAnimation()
        }
    }

    private func startSlotAnimation() {
        stopSlotAnimation()
        timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in
            Task { @MainActor in
                withAnimation(.linear(duration: 0.06)) {
                    displayValue = Int.random(in: 0...99)
                }
            }
        }
    }

    private func stopSlotAnimation() {
        timer?.invalidate()
        timer = nil
    }
}

/// Blocco a valore singolo (numero grande + unità) usato dalle modalità di
/// "Tempo di visione" diverse da `dhm` (ore/giorni/mesi/anni/minuti/binario).
struct ProfileDigitalSingleValueBlock: View {
    let value: String
    let unit: String
    var isLoading: Bool = false

    // Dynamic Type: mantiene la dimensione default (38pt), scala con le preferenze utente
    @ScaledMetric(relativeTo: .largeTitle) private var numberFontSize: CGFloat = 38

    var body: some View {
        VStack(spacing: 4) {
            Text(isLoading ? "--" : value)
                .font(.system(size: numberFontSize, weight: .black, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .contentTransition(.numericText())
                .animation(.easeOut(duration: 0.3), value: value)

            Text(unit)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
    }
}
