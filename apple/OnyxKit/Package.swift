// swift-tools-version: 5.9
import PackageDescription

/// No third-party dependencies, deliberately.
///
/// The File Provider extension runs under a memory ceiling of roughly 50 MB.
/// The AWS SDK for Swift alone is about 60 MB of package for the two request
/// shapes this app makes, so S3 access is hand-rolled on CryptoKit instead
/// (see S3/SigV4.swift, whose output is pinned against the AWS SDK's own
/// signer). Anything added here ships inside that ceiling too.
let package = Package(
    name: "OnyxKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "OnyxKit", targets: ["OnyxKit"]),
    ],
    targets: [
        .target(name: "OnyxKit"),
        .testTarget(name: "OnyxKitTests", dependencies: ["OnyxKit"]),
    ]
)
