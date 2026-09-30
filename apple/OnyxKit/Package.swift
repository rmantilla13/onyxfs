// swift-tools-version: 5.9
import PackageDescription

/// No third-party dependencies, deliberately.
///
/// The File Provider extension runs under a memory ceiling of roughly 50 MB.
/// The AWS SDK for Swift alone is about 60 MB of package for the two request
/// shapes this app makes, so S3 access is hand-rolled on CryptoKit instead
/// (see S3/SigV4.swift, whose output is pinned against the AWS SDK's own
/// signer). Anything added here ships inside that ceiling too.
///
/// OnyxFSCore is the engine of the onyxfs file-system extension (ONYXFS.md):
/// the bridge protocol and its client, the volume's tree and writes, the
/// chunk cache and the streaming reader. Plain Swift on Foundation and
/// CryptoKit, no FSKit — so it is tested here, the extension stays a thin
/// translation, and links only this, not the rest of OnyxKit.
///
/// OnyxFinderCore is what the Finder extension (OnyxFinder, Keep Offline in
/// Finder's menus and the marks on what is kept) shares with the app: the
/// index of what is kept, the answers built from it, and the port and
/// notification they talk over. Foundation only, for the same reasons.
let package = Package(
    name: "OnyxKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "OnyxKit", targets: ["OnyxKit"]),
        .library(name: "OnyxFSCore", targets: ["OnyxFSCore"]),
        .library(name: "OnyxFinderCore", targets: ["OnyxFinderCore"]),
    ],
    targets: [
        .target(name: "OnyxKit"),
        .target(name: "OnyxFSCore"),
        .target(name: "OnyxFinderCore"),
        .testTarget(name: "OnyxKitTests", dependencies: ["OnyxKit"]),
        .testTarget(name: "OnyxFSCoreTests", dependencies: ["OnyxFSCore"]),
        .testTarget(name: "OnyxFinderCoreTests", dependencies: ["OnyxFinderCore"]),
        // The extension's engine against the app's bridge, over the wire
        // protocol itself (in process, no socket): each side's own tests
        // pin what it says; these check the two agree.
        .testTarget(name: "OnyxFSIntegrationTests", dependencies: ["OnyxKit", "OnyxFSCore"]),
    ]
)
