import SwiftUI

enum ExpandableTextHeuristics {
    static func needsExpansion(for source: String?, threshold: Int = 220) -> Bool {
        guard let trimmed = source?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return false
        }

        return trimmed.count > threshold || trimmed.contains("\n")
    }
}

struct ExpandableTextBlock<Content: View>: View {
    let isExpandable: Bool
    let collapsedLineLimit: Int
    let content: (Int?) -> Content

    @State private var isExpanded = false

    init(
        isExpandable: Bool,
        collapsedLineLimit: Int = 5,
        @ViewBuilder content: @escaping (Int?) -> Content
    ) {
        self.isExpandable = isExpandable
        self.collapsedLineLimit = collapsedLineLimit
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            content(isExpandable && !isExpanded ? collapsedLineLimit : nil)

            if isExpandable {
                Button(isExpanded ? "Mostra meno" : "Altro") {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                }
                .buttonStyle(.plain)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
