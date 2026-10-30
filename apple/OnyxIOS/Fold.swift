import SwiftUI

/// Where an iPhone Duo's inner screen folds, and what its inner camera
/// covers, as the system reserves them (iOS 27.1): the bars keep clear of
/// both, and Home opens into two panes that meet at the fold. Every other
/// screen reserves neither, and nothing here changes it.
///
/// Read from each view's own geometry every time, never assumed: the inner
/// screen ignores the orientations the app supports, so the fold may run
/// down it or across it.
enum Fold {
    /// The fold running top to bottom with room for a pane either side of
    /// it, bent or flat — so the panes don't come and go as the hinge moves.
    /// Nil on any screen without one.
    static func panes(in proxy: GeometryProxy, minimum: CGFloat = 300) -> CGRect? {
        guard #available(iOS 27.1, *) else { return nil }
        return proxy.reservedRegions(kind: .division, options: .includeInactive)
            .map(\.frame)
            .first { $0.height > $0.width && $0.minX >= minimum && proxy.size.width - $0.maxX >= minimum }
    }

    /// The stretch across `proxy`'s width that a bent fold or the camera
    /// leaves clear, where bars along it go; nil when neither crosses it.
    static func lane(in proxy: GeometryProxy) -> ClosedRange<CGFloat>? {
        guard #available(iOS 27.1, *) else { return nil }
        let band = CGRect(origin: .zero, size: proxy.size)
        let reserved = proxy.reservedRegions(kind: .division) + proxy.reservedRegions(kind: .occlusion)
        let blocked = reserved.map(\.frame).filter { $0.intersects(band) }
            .map { min(max($0.minX, 0), band.width)...min(max($0.maxX, 0), band.width) }
        return widest(of: band.width, around: blocked)
    }

    /// The widest stretch of `0...width` that none of `blocked` covers — the
    /// leading one of two alike — or nil when nothing is blocked.
    static func widest(of width: CGFloat, around blocked: [ClosedRange<CGFloat>]) -> ClosedRange<CGFloat>? {
        guard !blocked.isEmpty else { return nil }
        var best: ClosedRange<CGFloat>?
        var x: CGFloat = 0
        for range in blocked.sorted(by: { $0.lowerBound < $1.lowerBound }) + [width...width] {
            let stretch = x...max(x, range.lowerBound)
            if stretch.upperBound - stretch.lowerBound > (best.map { $0.upperBound - $0.lowerBound } ?? 0) + 1 {
                best = stretch
            }
            x = max(x, range.upperBound)
        }
        return best
    }
}

extension View {
    /// Moves bars that span the screen into the stretch a bent fold or the
    /// camera leaves clear, gliding there as the hinge moves; centred, as
    /// before, wherever neither crosses them.
    func clearOfFold() -> some View { modifier(ClearOfFold()) }
}

private struct ClearOfFold: ViewModifier {
    @State private var lane: ClosedRange<CGFloat>?

    func body(content: Content) -> some View {
        content
            .frame(width: lane.map { $0.upperBound - $0.lowerBound })
            .padding(.leading, lane?.lowerBound ?? 0)
            .frame(maxWidth: .infinity, alignment: lane == nil ? .center : .leading)
            .onGeometryChange(for: ClosedRange<CGFloat>?.self) { Fold.lane(in: $0) } action: { lane = $0 }
            .animation(Theme.motion(.sheet), value: lane)
    }
}
