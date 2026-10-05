import AppKit

/// Onyx's mark in the menu bar: the logo's rounded square with its slash
/// cut out (public/onyx-mark.svg, the app icon), in one colour as menu bar
/// icons are — a template image, which AppKit tints for a light or a dark
/// bar. A dot cut into its corner says there is something to look at:
/// syncing, offline, a problem, an update; the panel says which.
///
/// Drawn rather than read from SVG, because the dot's ring is a cut through
/// the square, which needs a blend mode an SVG template cannot carry.
@MainActor
enum MenuBarMark {
    private static var cache: [Bool: NSImage] = [:]

    /// The mark at the menu bar's size, with the dot when `badged`.
    static func image(badged: Bool) -> NSImage {
        if let hit = cache[badged] { return hit }
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { rect in
            guard let cg = NSGraphicsContext.current?.cgContext else { return false }
            // The logo's 24-point grid, as the Lucide icons are drawn.
            let u = rect.width / 24
            cg.scaleBy(x: u, y: u)
            NSColor.black.setFill()
            // The square: the app icon's corners, 112 of 512, on 20 points.
            NSBezierPath(roundedRect: NSRect(x: 2, y: 2, width: 20, height: 20), xRadius: 4.4, yRadius: 4.4).fill()
            cg.setBlendMode(.clear)
            // The slash, from the mark's own path mapped onto the square.
            let slash = NSBezierPath()
            slash.move(to: NSPoint(x: 14.70, y: 6.14))
            slash.line(to: NSPoint(x: 11.54, y: 17.86))
            slash.line(to: NSPoint(x: 9.30, y: 17.86))
            slash.line(to: NSPoint(x: 12.46, y: 6.14))
            slash.close()
            slash.fill()
            if badged {
                // A ring cut out of the corner, then the dot inside it.
                NSBezierPath(ovalIn: NSRect(x: 19.6 - 5.2, y: 4.4 - 5.2, width: 10.4, height: 10.4)).fill()
                cg.setBlendMode(.normal)
                NSBezierPath(ovalIn: NSRect(x: 19.6 - 3.4, y: 4.4 - 3.4, width: 6.8, height: 6.8)).fill()
            }
            return true
        }
        image.isTemplate = true
        cache[badged] = image
        return image
    }
}
