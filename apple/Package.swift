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
    ],
    dependencies: [
        .package(path: "OnyxKit"),
    ],
    targets: [
        .executableTarget(
            name: "OnyxMac",
            dependencies: ["OnyxKit"],
            path: "OnyxMac",
            exclude: ["Info.plist", "OnyxMac.entitlements"]
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
