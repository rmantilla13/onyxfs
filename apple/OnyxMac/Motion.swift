import AppKit
import SwiftUI

/// How things move on the Mac: the iPhone's two curves (OnyxiOS/Theme.swift,
/// `Motion`) and one for a bar reaching its next figure — and whether they
/// should move at all.
///
/// Every animation in the app is bound to a state that changed: a download
/// finishing, a tint flashing, the status dot turning. Nothing here ticks,
/// so with nothing happening nothing is drawn (the rule ActivityView sets
/// for the bar, which runs all day in the menu bar).
enum Motion {
    /// A state that flips: a tint, a dot, a figure.
    static let quick: Animation = .easeOut(duration: 0.12)
    /// Something arriving: a card, a button taking a row's place.
    static let arrive: Animation = .spring(duration: 0.3, bounce: 0.15)
    /// A bar sliding to the fraction it was just given, rather than stepping.
    static let glide: Animation = .linear(duration: 0.25)

    /// System Settings › Accessibility › Display › Reduce Motion. Read as a
    /// view is built or a fade begins; AppKit keeps it current.
    static var reduced: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// `animation`, or none at all with Reduce Motion on: the state still
    /// changes, it just does not travel.
    static func gated(_ animation: Animation) -> Animation? { reduced ? nil : animation }
}
