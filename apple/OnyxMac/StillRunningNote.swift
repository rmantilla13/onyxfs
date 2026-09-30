import SwiftUI
import AppKit

/// The note the first ⌘Q leaves by the menu bar item: Onyx did not quit, it
/// is up there, and ⌥⌘Q is what quits it. Once, ever (Background.
/// closeToMenuBar). It takes no focus, goes by itself after a few seconds,
/// and a click sends it sooner.
@MainActor
enum StillRunningNote {
    private static var panel: NSPanel?
    private static var fade: DispatchWorkItem?

    static let title = "Onyx is still running"
    static let detail = "It is here in the menu bar, keeping your drives in Finder and in sync. To quit Onyx, press ⌥⌘Q."
    /// On screen this long, unless clicked away.
    static let shownFor: TimeInterval = 12

    static func show() {
        dismiss(animated: false)
        let host = NSHostingView(rootView: NoteView(dismiss: { dismiss(animated: true) }))
        host.setFrameSize(host.fittingSize)
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.contentView = host
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.setFrameOrigin(origin(for: panel.frame.size))
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.2
            panel.animator().alphaValue = 1
        }
        self.panel = panel
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [
            .announcement: "\(title). \(detail)",
            .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
        let later = DispatchWorkItem { dismiss(animated: true) }
        fade = later
        DispatchQueue.main.asyncAfter(deadline: .now() + shownFor, execute: later)
    }

    static func dismiss(animated: Bool) {
        fade?.cancel()
        fade = nil
        guard let panel else { return }
        self.panel = nil
        guard animated else {
            panel.orderOut(nil)
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.3
            panel.animator().alphaValue = 0
        }, completionHandler: { panel.orderOut(nil) })
    }

    /// Under the menu bar item, its middle under the item's, kept on its
    /// screen; at the screen's top right when the item is nowhere to be
    /// found (hidden behind the notch, say).
    private static func origin(for size: NSSize) -> NSPoint {
        let item = NSApp.windows.first { $0.className.contains("NSStatusBarWindow") && $0.isVisible }?.frame
        let screen = NSScreen.screens.first { item.map($0.frame.intersects) ?? false } ?? NSScreen.main ?? NSScreen.screens[0]
        let area = screen.visibleFrame
        let margin: CGFloat = 8
        var x = item.map { $0.midX - size.width / 2 } ?? (area.maxX - size.width - margin)
        x = min(max(x, area.minX + margin), area.maxX - size.width - margin)
        let top = min(item?.minY ?? area.maxY, area.maxY) - 6
        return NSPoint(x: x, y: top - size.height)
    }
}

private struct NoteView: View {
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(StillRunningNote.title).font(.system(size: 13, weight: .semibold))
                Text(StillRunningNote.detail)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(width: 300, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.quaternary))
        .contentShape(Rectangle())
        .onTapGesture(perform: dismiss)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Dismisses this note")
    }
}
