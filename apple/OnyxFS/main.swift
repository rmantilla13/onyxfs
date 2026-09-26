import Foundation

// The Onyx file system (FSKit module "onyxfs", apple/ONYXFS.md). fskitd
// launches this once per mounted drive. The APIs it is built on are macOS 27's;
// the app only mounts drives this way there, so an older system never runs it.
if #available(macOS 27.0, *) {
    try OnyxFSExtension.main()
} else {
    exit(EXIT_FAILURE)
}
