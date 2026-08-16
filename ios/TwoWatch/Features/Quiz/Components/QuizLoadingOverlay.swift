import SwiftUI

/// Full-screen loading state for Quiz flows.
///
/// Reuses the same motion language of `AnimatedLoadingSplashView` (brand halo +
/// triangular play indicator with sequential edge animation) but adapts it to
/// the dark Quiz background and overlays the `SomtoQuizLockup` so users read
/// it as "Somto Quiz is preparing", not generic app loading.
struct QuizLoadingOverlay: View {
    var caption: LocalizedStringKey = "Sto preparando il quiz…"

    @State private var haloScale: CGFloat = 0.92
    @State private var lockupOffsetY: CGFloat = 18
    @State private var lockupOpacity: Double = 0
    @State private var captionOpacity: Double = 0

    var body: some View {
        ZStack {
            TwoWatchTheme.background.ignoresSafeArea()

            // Brand halo (warm + primary blobs, soft and large)
            Circle()
                .fill(TwoWatchTheme.brandPrimary.opacity(0.22))
                .blur(radius: 100)
                .frame(width: 260, height: 260)
                .scaleEffect(haloScale)
                .offset(y: -40)
                .accessibilityHidden(true)

            Circle()
                .fill(TwoWatchTheme.brandWarm.opacity(0.16))
                .blur(radius: 120)
                .frame(width: 280, height: 280)
                .offset(x: 110, y: -180)
                .accessibilityHidden(true)

            VStack(spacing: 26) {
                SomtoQuizLockup(size: .large, alignment: .center)
                    .offset(y: lockupOffsetY)
                    .opacity(lockupOpacity)

                VStack(spacing: 12) {
                    Text(caption)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                    QuizPlayIndicator()
                }
                .opacity(captionOpacity)
            }
            .padding(.horizontal, 24)
        }
        .task {
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) {
                haloScale = 1.12
            }
            withAnimation(.spring(response: 0.7, dampingFraction: 0.82)) {
                lockupOffsetY = 0
                lockupOpacity = 1
            }
            try? await Task.sleep(for: .milliseconds(280))
            withAnimation(.easeOut(duration: 0.4)) {
                captionOpacity = 1
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Somto Quiz, sto caricando")
    }
}

// MARK: - Animated play indicator
// Mirrors the geometry/cadence of AnimatedLoadingSplashView's indicator so the
// motion feels native to Somto. Kept fileprivate to avoid polluting the design
// system: this is a Quiz-only variant tinted on dark backgrounds.

private struct QuizPlayIndicator: View {
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
                QuizPlayOutlineShape()
                    .stroke(Color.white.opacity(0.10), style: indicatorStrokeStyle)

                QuizPlayEdgeShape(edge: .leading)
                    .trim(from: 0, to: leading)
                    .stroke(indicatorGradient, style: indicatorStrokeStyle)

                QuizPlayEdgeShape(edge: .top)
                    .trim(from: 0, to: top)
                    .stroke(indicatorGradient, style: indicatorStrokeStyle)

                QuizPlayEdgeShape(edge: .bottom)
                    .trim(from: 0, to: bottom)
                    .stroke(indicatorGradient, style: indicatorStrokeStyle)
            }
            .frame(width: 28, height: 28)
            .scaleEffect(scale)
            .opacity(opacity)
            .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.20 * opacity), radius: 10, x: 0, y: 4)
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
        StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round)
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

private struct QuizPlayOutlineShape: Shape {
    func path(in rect: CGRect) -> Path {
        let points = QuizPlayGeometry.points(in: rect)
        var path = Path()
        path.move(to: points.topLeft)
        path.addLine(to: points.bottomLeft)
        path.addLine(to: points.tip)
        path.closeSubpath()
        return path
    }
}

private struct QuizPlayEdgeShape: Shape {
    enum Edge {
        case leading
        case top
        case bottom
    }

    let edge: Edge

    func path(in rect: CGRect) -> Path {
        let points = QuizPlayGeometry.points(in: rect)
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

private enum QuizPlayGeometry {
    static func points(in rect: CGRect) -> (topLeft: CGPoint, bottomLeft: CGPoint, tip: CGPoint) {
        (
            topLeft: CGPoint(x: rect.minX + rect.width * 0.30, y: rect.minY + rect.height * 0.18),
            bottomLeft: CGPoint(x: rect.minX + rect.width * 0.30, y: rect.minY + rect.height * 0.82),
            tip: CGPoint(x: rect.minX + rect.width * 0.80, y: rect.midY)
        )
    }
}

#if DEBUG
#Preview("Quiz Loading") {
    QuizLoadingOverlay()
}
#endif
