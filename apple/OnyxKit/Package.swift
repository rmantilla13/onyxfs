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
/// OnyxFSCore is the engine of the onyxfs file-system extension: the bridge
/// protocol, the node table, the chunk cache and the streaming reader. It is
/// a target of its own, on Foundation and CryptoKit alone, so the extension
/// links only that and not the rest of OnyxKit.
let package = Package(
    name: "OnyxKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "OnyxKit", targets: ["OnyxKit"]),
        .library(name: "OnyxFSCore", targets: ["OnyxFSCore"]),
    ],
    targets: [
        .target(name: "OnyxKit"),
        .target(name: "OnyxFSCore"),
        .testTarget(name: "OnyxKitTests", dependencies: ["OnyxKit"]),
        .testTarget(name: "OnyxFSCoreTests", dependencies: ["OnyxFSCore"]),
    ]
)
