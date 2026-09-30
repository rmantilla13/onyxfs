import AppKit
import OnyxFinderCore

/// The marks Finder draws on what Onyx keeps offline: a tick in a circle, as
/// the web marks a kept file (app/components/ui/OfflineMark.js, Lucide's
/// circle-check), filled with this Mac's accent colour; and while it is
/// still on its way, a downward arrow on grey. Drawn here, once, as bitmaps:
/// Finder is handed pixels, not a drawing.
enum Badges {
    static func label(_ badge: FinderLookup.Badge) -> String {
        switch badge {
        case .kept: return "Kept Offline"
        case .pending: return "Downloading"
        }
    }

    /// 16 points, with pixels for every size Finder may draw it at.
    static func image(_ badge: FinderLookup.Badge) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16))
        for pixels in [16, 32, 48, 64, 128] {
            if let rep = draw(badge, pixels: pixels) { image.addRepresentation(rep) }
        }
        return image
    }

    private static func draw(_ badge: FinderLookup.Badge, pixels: Int) -> NSBitmapImageRep? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        rep.size = NSSize(width: 16, height: 16)
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSGraphicsContext.current = context
        // Lucide's 24-unit grid, y down as in its SVG.
        let scale = CGFloat(pixels) / 24
        let transform = NSAffineTransform()
        transform.translateX(by: 0, yBy: CGFloat(pixels))
        transform.scaleX(by: scale, yBy: -scale)
        transform.concat()

        // A white rim, so the mark reads on any icon, light or dark.
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: 0.5, y: 0.5, width: 23, height: 23)).fill()
        let fill: NSColor = badge == .kept ? .controlAccentColor : .systemGray
        (fill.usingColorSpace(.sRGB) ?? fill).setFill()
        NSBezierPath(ovalIn: NSRect(x: 2.5, y: 2.5, width: 19, height: 19)).fill()

        let mark = NSBezierPath()
        switch badge {
        case .kept:
            mark.move(to: NSPoint(x: 7.8, y: 12.2))
            mark.line(to: NSPoint(x: 10.8, y: 15.2))
            mark.line(to: NSPoint(x: 16.4, y: 9.4))
        case .pending:
            mark.move(to: NSPoint(x: 12, y: 7.2))
            mark.line(to: NSPoint(x: 12, y: 16.4))
            mark.move(to: NSPoint(x: 8.2, y: 12.8))
            mark.line(to: NSPoint(x: 12, y: 16.6))
            mark.line(to: NSPoint(x: 15.8, y: 12.8))
        }
        mark.lineWidth = 2.6
        mark.lineCapStyle = .round
        mark.lineJoinStyle = .round
        NSColor.white.setStroke()
        mark.stroke()
        return rep
    }
}
