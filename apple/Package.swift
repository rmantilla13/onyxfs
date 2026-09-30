// swift-tools-version: 5.9
import PackageDescription

/// The macOS app and its Finder extension, built with SwiftPM alone.
///
/// `scripts/build-mac.sh` compiles these and assembles Onyx.app (the
/// extension inside it as an .appex), with nothing but the Command Line
/// Tools. The Xcode project generated from project.yml builds the same
/// sources, and the iOS targets too; this exists so the Mac app can be built,
/// run and tested on a machine without Xcode.
let package = Package(
    name: "OnyxApple",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "OnyxMac", targets: ["OnyxMac"]),
        .executable(name: "OnyxFileProvider", targets: ["OnyxFileProvider"]),
        .executable(name: "OnyxFS", targets: ["OnyxFS"]),
        .executable(name: "OnyxFinder", targets: ["OnyxFinder"]),
    ],
    dependencies: [
        .package(path: "OnyxKit"),
    ],
    targets: [
        .executableTarget(
            name: "OnyxMac",
            dependencies: ["OnyxKit", .product(name: "OnyxFinderCore", package: "OnyxKit")],
            path: "OnyxMac",
            exclude: ["Info.plist", "OnyxMac.entitlements"]
        ),
        // Finder's right-click menu (Keep Offline, Remove Offline Copy) and
        // the marks on what is kept offline: a Finder Sync extension, built
        // into Contents/PlugIns/OnyxFinder.appex by scripts/build-mac.sh.
        // An NSExtension, so its entry point is NSExtensionMain, as for the
        // File Provider extension below.
        .executableTarget(
            name: "OnyxFinder",
            dependencies: [.product(name: "OnyxFinderCore", package: "OnyxKit")],
            path: "OnyxFinder",
            exclude: ["Info.plist", "OnyxFinder.entitlements"],
            swiftSettings: [.unsafeFlags(["-application-extension"])],
            linkerSettings: [.unsafeFlags([
                "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
                "-Xlinker", "-application_extension",
            ])]
        ),
        // The Onyx file system (onyxfs, ONYXFS.md): an ExtensionKit
        // extension. Built into Contents/Extensions/OnyxFS.appex by
        // scripts/build-mac.sh.
        //
        // Its entry point is ExtensionFoundation's EXExtensionMain, as Xcode
        // links one: that reads the launch arguments ExtensionKit starts the
        // process with, and only then calls main.swift, whose
        // OnyxFSExtension.main() needs them. Started at main.swift instead,
        // the extension traps in ExtensionFoundation before any of it runs,
        // and every drive falls back to ~/Onyx.
        .executableTarget(
            name: "OnyxFS",
            dependencies: [.product(name: "OnyxFSCore", package: "OnyxKit")],
            path: "OnyxFS",
            exclude: ["Info.plist", "OnyxFS.entitlements"],
            swiftSettings: [.unsafeFlags(["-application-extension"])],
            linkerSettings: [.unsafeFlags([
                "-Xlinker", "-e", "-Xlinker", "_EXExtensionMain",
                "-Xlinker", "-application_extension",
            ])]
        ),
        // An app extension is an executable whose entry point is the system's
        // NSExtensionMain, which loads the principal class named in its
        // Info.plist. These are the flags Xcode passes for one.
        .executableTarget(
            name: "OnyxFileProvider",
            dependencies: ["OnyxKit"],
            path: "OnyxFileProvider",
            exclude: ["Info.plist", "OnyxFileProvider.entitlements"],
            swiftSettings: [.unsafeFlags(["-application-extension"])],
            linkerSettings: [.unsafeFlags([
                "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
                "-Xlinker", "-application_extension",
            ])]
        ),
    ]
)
