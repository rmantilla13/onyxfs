import Foundation

/// Unzip Here, from Finder's menu on a drive (OnyxFinder), and on its own
/// once Archive Utility could not (the app's UnzipService): a zip unzipped
/// beside itself, as Archive Utility would, but unpacked on this Mac's own
/// disk first and then copied in.
///
/// Archive Utility cannot do it for a zip that came from the internet. A
/// drive is not a local disk to macOS (no MNT_LOCAL: FSKit gives a
/// URL-mounted volume none), so macOS keeps no .TemporaryItems on it and
/// Archive Utility unpacks into a scratch folder beside the zip. Its
/// sandbox then refuses to mark that folder with the zip's quarantine, the
/// unzip stops with Error 1, and an empty folder is left. A zip with no
/// quarantine unzips there; a downloaded one never does.
///
/// Both steps are ditto's, each in a process of its own. Unpacking carries
/// the zip's quarantine onto everything in it, and restores what __MACOSX
/// holds; copying in keeps both. Every write to a drive comes back through
/// this app's own bridge, so none of it runs in this process.
public enum Unzipper {
    public struct Failure: Error, Equatable, Sendable {
        /// Why, in words, for the notice: "It's protected with a password."
        public var reason: String
        public init(_ reason: String) { self.reason = reason }
    }

    /// Whether the path names a zip, by its name.
    public static func isZip(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        return name.count > 4 && name.lowercased().hasSuffix(".zip")
    }

    /// What lands beside the zip, as Archive Utility lands it: the zip's one
    /// item as itself, or all of them in a folder named after the zip. A
    /// name already there gets " 2", " 3"…: "Footage 2", "notes 2.txt".
    /// `items` are the unpacked top level's names, __MACOSX left out;
    /// `isFolder` is for the one item.
    public static func landing(items: [String], isFolder: Bool, zipName: String,
                               taken: (String) -> Bool) -> (name: String, wrapped: Bool) {
        if items.count == 1 { return (free(items[0], isFolder: isFolder, taken: taken), false) }
        let base = (zipName as NSString).deletingPathExtension
        return (free(base.isEmpty ? zipName : base, isFolder: true, taken: taken), true)
    }

    /// `name`, or the first of "name 2", "name 3"… not taken; a file's
    /// number goes before its extension.
    static func free(_ name: String, isFolder: Bool, taken: (String) -> Bool) -> String {
        guard taken(name) else { return name }
        let ext = isFolder ? "" : (name as NSString).pathExtension
        let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
        var n = 2
        while true {
            let candidate = ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)"
            if !taken(candidate) { return candidate }
            n += 1
        }
    }

    /// The names at the top of a zip, from `tar -tf`'s listing: each
    /// entry's first name, once, without macOS's own (__MACOSX, ._*,
    /// .DS_Store), which no unzip lands.
    public static func topLevel(listing: String) -> [String] {
        var seen = Set<String>()
        var top: [String] = []
        for line in listing.split(whereSeparator: \.isNewline) {
            guard let first = line.split(separator: "/").first.map(String.init),
                  !isMacOSOwn(first), seen.insert(fold(first)).inserted else { continue }
            top.append(first)
        }
        return top
    }

    /// Of the zips beside it, the one Archive Utility unpacked: the only one
    /// whose top is what it unpacked — `unpacked` (at most a hundred of the
    /// names) and `count` of them in all. Nil for none, or more than one.
    public static func unpackedFrom(_ candidates: [(zip: URL, top: [String])], unpacked: [String], count: Int) -> URL? {
        let matching = candidates.filter { candidate in
            let names = Set(candidate.top.map(fold))
            return names.count == count && unpacked.allSatisfy { names.contains(fold($0)) }
        }
        return matching.count == 1 ? matching[0].zip : nil
    }

    static func isMacOSOwn(_ name: String) -> Bool {
        name == "__MACOSX" || name == ".DS_Store" || name.hasPrefix("._")
    }

    /// Names as a drive compares them: either Unicode form, any case, and
    /// without the whitespace at either end the server trims from every
    /// name — a drive keeps "Selects " as "Selects" (DriveEngine.stored),
    /// while the zip lists it as it was.
    static func fold(_ name: String) -> String {
        name.trimmingCharacters(in: serverTrims).precomposedStringWithCanonicalMapping.lowercased()
    }

    /// What JavaScript's `trim` takes (lib/folder-ops.js), as OnyxFSCore's
    /// DriveEngine.serverTrims.
    static let serverTrims = CharacterSet(charactersIn:
        "\u{9}\u{A}\u{B}\u{C}\u{D}\u{20}\u{A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}"
        + "\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    /// ditto's complaint, as the notice says it.
    static func reason(_ complaint: String, copying: Bool) -> String {
        let said = complaint.lowercased()
        if said.contains("password") { return "It's protected with a password. Unzip it on your Mac, then copy it in." }
        if said.contains("no space") { return copying ? "There isn't room for it in the drive." : "There isn't room on this Mac to unzip it." }
        if copying, said.contains("permission denied") || said.contains("operation not permitted") || said.contains("read-only") {
            return "Files can't be added to this folder."
        }
        if copying, said.contains("operation not supported") { return "It holds links, which a drive can't keep." }
        let line = complaint.split(separator: "\n").last.map(String.init) ?? ""
        return line.isEmpty ? "The zip could not be read." : line
    }
}

#if os(macOS)
extension Unzipper {
    /// Unzips `zip` beside itself and answers where it landed. Unpacked in a
    /// folder of its own under `scratch` (this Mac's temporary folder),
    /// which goes once it is done, however it ends.
    public static func unzip(_ zip: URL, scratch: URL = FileManager.default.temporaryDirectory) async throws -> URL {
        let fm = FileManager.default
        var status = stat()
        guard lstat(zip.path, &status) == 0, status.st_mode & S_IFMT == S_IFREG, isZip(zip.path) else {
            throw Failure("It isn't a zip file.")
        }
        // On this Mac's own disk, never in a drive: a folder made there is a
        // real folder, on the server.
        let work = scratch.appendingPathComponent("Onyx Unzip \(UUID().uuidString)", isDirectory: true)
        do { try fm.createDirectory(at: work, withIntermediateDirectories: true) } catch {
            throw Failure("This Mac's temporary folder can't be written.")
        }
        defer { try? fm.removeItem(at: work) }
        let out = work.appendingPathComponent("Unzipped", isDirectory: true)
        try await ditto(["-x", "-k", zip.path, out.path], in: work, copying: false)

        let items = ((try? fm.contentsOfDirectory(atPath: out.path)) ?? []).filter { $0 != "__MACOSX" }.sorted()
        guard let first = items.first else { throw Failure("There's nothing in it.") }
        var isFolder: ObjCBool = false
        _ = fm.fileExists(atPath: out.appendingPathComponent(first).path, isDirectory: &isFolder)
        let beside = zip.deletingLastPathComponent()
        let (name, wrapped) = landing(items: items, isFolder: isFolder.boolValue, zipName: zip.lastPathComponent) { name in
            var at = stat()
            return lstat(beside.appendingPathComponent(name).path, &at) == 0
        }
        let source = wrapped ? out : out.appendingPathComponent(first)
        let landed = beside.appendingPathComponent(name, isDirectory: wrapped || isFolder.boolValue)
        try await ditto([source.path, landed.path], in: work, copying: true)
        return landed
    }

    /// The names at the top of `zip` (`topLevel(listing:)`), as bsdtar lists
    /// them — in UTF-8, as they are. zipinfo would print "?" for any byte
    /// it takes for no letter: "Café Ñ" came out "Caf?? ??".
    public static func topLevel(of zip: URL, scratch: URL = FileManager.default.temporaryDirectory) async throws -> [String] {
        let fm = FileManager.default
        let work = scratch.appendingPathComponent("Onyx Unzip \(UUID().uuidString)", isDirectory: true)
        do { try fm.createDirectory(at: work, withIntermediateDirectories: true) } catch {
            throw Failure("This Mac's temporary folder can't be written.")
        }
        defer { try? fm.removeItem(at: work) }
        let listed = work.appendingPathComponent("list.txt")
        let said = work.appendingPathComponent("tar.log")
        guard try await run("/usr/bin/tar", ["-tf", zip.path], output: listed, errors: said,
                            environment: ["LC_ALL": "en_US.UTF-8"]) == 0,
              let listing = try? String(contentsOf: listed, encoding: .utf8) else {
            throw Failure("The zip could not be read.")
        }
        return topLevel(listing: listing)
    }

    /// Archive Utility's placeholder for what it meant to land, if it is
    /// still there and still empty: a folder with nothing in it (rmdir takes
    /// no other), or a file of no bytes. Answers whether it went.
    @discardableResult
    public static func removePlaceholder(_ item: URL) async -> Bool {
        var status = stat()
        guard lstat(item.path, &status) == 0 else { return false }
        let log = FileManager.default.temporaryDirectory.appendingPathComponent("Onyx placeholder \(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: log) }
        switch status.st_mode & S_IFMT {
        case S_IFDIR:
            return (try? await run("/bin/rmdir", [item.path], output: nil, errors: log)) == 0
        case S_IFREG where status.st_size == 0:
            return (try? await run("/bin/rm", ["-f", item.path], output: nil, errors: log)) == 0
        default:
            return false
        }
    }

    /// /usr/bin/ditto with `arguments`, waited for without holding a thread.
    /// Nothing to read from (a zip that wants a password fails at once); what
    /// it says goes to a file in `work`, read if it fails.
    private static func ditto(_ arguments: [String], in work: URL, copying: Bool) async throws {
        let said = work.appendingPathComponent(copying ? "copy.log" : "unzip.log")
        let code = try await run("/usr/bin/ditto", arguments, output: nil, errors: said)
        guard code == 0 else {
            let complaint = (try? String(contentsOf: said, encoding: .utf8)) ?? ""
            throw Failure(reason(complaint, copying: copying))
        }
    }

    /// `tool` in a process of its own — what it does on a drive comes back
    /// through this app's own bridge — waited for without holding a thread.
    /// What it prints goes to `output` (or nowhere), what it complains of to
    /// `errors`; its exit status is the answer. `environment` is added to
    /// this app's.
    private static func run(_ tool: String, _ arguments: [String], output: URL?, errors: URL,
                            environment: [String: String] = [:]) async throws -> Int32 {
        let fm = FileManager.default
        guard fm.createFile(atPath: errors.path, contents: nil), let log = try? FileHandle(forWritingTo: errors) else {
            throw Failure("This Mac's temporary folder can't be written.")
        }
        defer { try? log.close() }
        var printed: FileHandle?
        if let output {
            guard fm.createFile(atPath: output.path, contents: nil), let handle = try? FileHandle(forWritingTo: output) else {
                throw Failure("This Mac's temporary folder can't be written.")
            }
            printed = handle
        }
        defer { try? printed?.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        if !environment.isEmpty {
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, given in given }
        }
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = printed ?? FileHandle.nullDevice
        process.standardError = log
        return try await withCheckedThrowingContinuation { done in
            process.terminationHandler = { done.resume(returning: $0.terminationStatus) }
            do { try process.run() } catch {
                process.terminationHandler = nil
                done.resume(throwing: Failure("\((tool as NSString).lastPathComponent) could not be started."))
            }
        }
    }
}
#endif
