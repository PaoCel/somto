import SwiftUI

struct AnimatedLoadingSplashView: View {
    private static let wordmarkWidth: CGFloat = 208
    private static let wordmarkFrameWidth: CGFloat = 244
    private static let markStartOffset: CGFloat = 116
    private static let markLandingOffset: CGFloat = -69

    @State private var hasStarted = false
    @State private var revealProgress: CGFloat = 0
    @State private var markOffset: CGFloat = Self.markStartOffset
    @State private var markScale: CGFloat = 0.96
    @State private var subtitleOpacity = 0.0
    @State private var haloScale: CGFloat = 0.92

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color.white,
                    Color(hex: "#FFF7F2"),
                    Color(hex: "#FFFDFC")
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()

            Circle()
                .fill(TwoWatchTheme.brandPrimary.opacity(0.16))
                .blur(radius: 86)
                .frame(width: 220, height: 220)
                .scaleEffect(haloScale)
                .offset(y: -30)

            Circle()
                .fill(TwoWatchTheme.brandWarm.opacity(0.13))
                .blur(radius: 108)
                .frame(width: 260, height: 260)
                .offset(x: 110, y: -180)

            VStack(spacing: 22) {
                ZStack {
                    Image("OmtoSplash")
                        .resizable()
                        .scaledToFit()
                        .frame(width: Self.wordmarkWidth)
                        .mask(alignment: .trailing) {
                            Rectangle()
                                .frame(width: max(12, Self.wordmarkWidth * revealProgress))
                        }
                        .offset(x: -5.5, y: -3)

                    BrandMarkView(size: 82)
                        .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.22), radius: 20, x: 0, y: 10)
                        .offset(x: markOffset)
                        .scaleEffect(markScale)
                }
                .frame(width: Self.wordmarkFrameWidth, height: 94)

                VStack(spacing: 10) {
                    Text("Sto preparando Somto…")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.black.opacity(0.58))

                    PlayLoadingIndicator()
                }
                .opacity(subtitleOpacity)
            }
            .padding(.horizontal, 24)
        }
        .task {
            startAnimationIfNeeded()
        }
    }

    private func startAnimationIfNeeded() {
        guard !hasStarted else { return }
        hasStarted = true

        withAnimation(.timingCurve(0.2, 0.96, 0.32, 1, duration: 1.18)) {
            revealProgress = 0.78
            markOffset = Self.markLandingOffset + 12
            haloScale = 1.06
            markScale = 1.02
        }

        withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
            haloScale = 1.12
        }

        Task {
            try? await Task.sleep(for: .milliseconds(420))
            withAnimation(.spring(response: 0.72, dampingFraction: 0.84)) {
                revealProgress = 1
                markOffset = Self.markLandingOffset
                markScale = 1
            }

            try? await Task.sleep(for: .milliseconds(520))
            withAnimation(.easeOut(duration: 0.48)) {
                subtitleOpacity = 1
            }
        }
    }
}

#Preview("Splash") {
    AnimatedLoadingSplashView()
}

private struct PlayLoadingIndicator: View {
    private let cycleDuration: TimeInterval = 1.45

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: false)) { context in
            let progress = animationProgress(at: context.date)
            let leading = segmentProgress(progress, start: 0.00, duration: 0.24)
            let top = segmentProgress(progress, start: 0.17, duration: 0.24)
            let bottom = segmentProgress(progress, start: 0.34, duration: 0.24)
            let opacity = indicatorOpacity(progress)
            let scale = 0.96 + (0.04 * smoothPulse(progress))

            ZStack {
                PlayOutlineShape()
                    .stroke(Color.black.opacity(0.08), style: indicatorStrokeStyle)

                PlayEdgeShape(edge: .leading)
                    .trim(from: 0, to: leading)
                    .stroke(indicatorGradient, style: indicatorStrokeStyle)

                PlayEdgeShape(edge: .top)
                    .trim(from: 0, to: top)
                    .stroke(indicatorGradient, style: indicatorStrokeStyle)

                PlayEdgeShape(edge: .bottom)
                    .trim(from: 0, to: bottom)
                    .stroke(indicatorGradient, style: indicatorStrokeStyle)
            }
            .frame(width: 26, height: 26)
            .scaleEffect(scale)
            .opacity(opacity)
            .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.14 * opacity), radius: 10, x: 0, y: 4)
        }
        .accessibilityHidden(true)
    }

    private var indicatorGradient: LinearGradient {
        LinearGradient(
            colors: [TwoWatchTheme.brandWarm, TwoWatchTheme.brandPrimary],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var indicatorStrokeStyle: StrokeStyle {
        StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round)
    }

    private func animationProgress(at date: Date) -> Double {
        date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: cycleDuration) / cycleDuration
    }

    private func segmentProgress(_ progress: Double, start: Double, duration: Double) -> CGFloat {
        CGFloat(min(max((progress - start) / duration, 0), 1))
    }

    private func indicatorOpacity(_ progress: Double) -> Double {
        let fadeIn = min(max(progress / 0.12, 0), 1)
        let fadeOut = 1 - min(max((progress - 0.72) / 0.28, 0), 1)
        return 0.24 + (0.76 * fadeIn * fadeOut)
    }

    private func smoothPulse(_ progress: Double) -> Double {
        let wave = sin(progress * .pi * 2 - (.pi / 2))
        return (wave + 1) / 2
    }
}

private struct PlayOutlineShape: Shape {
    func path(in rect: CGRect) -> Path {
        let points = PlayGeometry.points(in: rect)
        var path = Path()
        path.move(to: points.topLeft)
        path.addLine(to: points.bottomLeft)
        path.addLine(to: points.tip)
        path.closeSubpath()
        return path
    }
}

private struct PlayEdgeShape: Shape {
    enum Edge {
        case leading
        case top
        case bottom
    }

    let edge: Edge

    func path(in rect: CGRect) -> Path {
        let points = PlayGeometry.points(in: rect)
        var path = Path()

        switch edge {
        case .leading:
            path.move(to: points.topLeft)
            path.addLine(to: points.bottomLeft)
        case .top:
            path.move(to: points.topLeft)
            path.addLine(to: points.tip)
        case .bottom:
            path.move(to: points.bottomLeft)
            path.addLine(to: points.tip)
        }

        return path
    }
}

private enum PlayGeometry {
    static func points(in rect: CGRect) -> (topLeft: CGPoint, bottomLeft: CGPoint, tip: CGPoint) {
        (
            topLeft: CGPoint(x: rect.minX + rect.width * 0.30, y: rect.minY + rect.height * 0.18),
            bottomLeft: CGPoint(x: rect.minX + rect.width * 0.30, y: rect.minY + rect.height * 0.82),
            tip: CGPoint(x: rect.minX + rect.width * 0.80, y: rect.midY)
        )
    }
}
