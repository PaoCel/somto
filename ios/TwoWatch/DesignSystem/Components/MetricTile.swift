import SwiftUI

struct MetricTile: View {
    let title: String
    let value: String
    var tint: Color = TwoWatchTheme.brandPrimary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(value)
                .font(.title3.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Text(title)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(tint.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

