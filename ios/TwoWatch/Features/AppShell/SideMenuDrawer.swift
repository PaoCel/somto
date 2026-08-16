import SwiftUI

/// Side-anchored drawer used to host the hamburger menu. Slides in from
/// the leading edge with a dimmed backdrop, drag-to-dismiss and tap-to-dismiss.
struct SideMenuDrawer<Content: View>: View {
    let onDismiss: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var dragOffset: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let drawerWidth = min(340, geo.size.width * 0.86)
            ZStack(alignment: .leading) {
                Color.black
                    .opacity(0.42)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { onDismiss() }
                    .transition(.opacity)

                content()
                    .frame(width: drawerWidth, alignment: .leading)
                    .frame(maxHeight: .infinity)
                    .background(
                        TwoWatchTheme.background
                            .ignoresSafeArea()
                    )
                    .clipShape(
                        UnevenRoundedRectangle(
                            cornerRadii: .init(
                                topLeading: 0,
                                bottomLeading: 0,
                                bottomTrailing: 28,
                                topTrailing: 28
                            ),
                            style: .continuous
                        )
                    )
                    .shadow(color: Color.black.opacity(0.32), radius: 30, x: 8, y: 0)
                    .offset(x: min(dragOffset, 0))
                    .gesture(
                        DragGesture(minimumDistance: 8)
                            .onChanged { value in
                                if value.translation.width < 0 {
                                    dragOffset = value.translation.width
                                }
                            }
                            .onEnded { value in
                                if value.translation.width < -drawerWidth * 0.3
                                    || value.predictedEndTranslation.width < -drawerWidth * 0.5 {
                                    onDismiss()
                                }
                                withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                                    dragOffset = 0
                                }
                            }
                    )
            }
        }
    }
}
