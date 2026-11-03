import Foundation
import Testing
@testable import OnyxFSCore

/// What one change to the local store costs with the store as big as the
/// Mac's get: almost every entry a `._` file a few folders down, 3,000 and
/// 10,000 of them. Off by default; run it in release:
///
///     ONYXFS_BENCH=1 swift test -c release --package-path OnyxKit --filter LocalStoreBench
///
/// A round is what Finder does for each file it copies with attributes: its
/// `._` file made, written, sized and dated. Then `._` files removed and
/// renamed, and real files renamed and removed — the store is asked to
/// carry or drop their attributes, and has none.
///
/// Measured on an M5 Max with other work running, before the log — index.json
/// written whole on every change: 4.5 ms a change at 3,000 entries and
/// 19 ms at 10,000, a `._` file renamed 15 and 55 ms, a real file renamed or
/// deleted (nothing of it here) 5 and 18 ms. With it, 8–170 µs a change at
/// either size, and under a microsecond for a real file.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["ONYXFS_BENCH"] != nil))
struct LocalStoreBenchTests {
    static let rounds = 200
    static let sizes = [3_000, 10_000]

    @Test func aChangeCostsTheSameHoweverBigTheStore() async throws {
        print("local store bench: \(Self.rounds) calls each, µs per call — mean, median, p99, max")
        for size in Self.sizes { try await run(size) }
    }

    func run(_ size: Int) async throws {
        let dir = benchDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let seeded = try seedStore(dir, entries: size, blobs: true)
        let index = dir.appendingPathComponent("index.json")
        let indexBytes = try FileManager.default.attributesOfItem(atPath: index.path)[.size] as? Int ?? 0

        var store: LocalStore!
        let live = liveBytes()
        let opened = try ContinuousClock().measure { store = try LocalStore(directory: dir) }
        let held = liveBytes() - live
        var samples: [(name: String, times: [Duration])] = []
        func record(_ name: String, _ time: Duration) {
            if let at = samples.firstIndex(where: { $0.name == name }) { samples[at].times.append(time) } else { samples.append((name, [time])) }
        }

        let header = Data(repeating: 0x41, count: 4096)
        let date = Date(timeIntervalSince1970: 1_762_000_000)
        for n in 0..<Self.rounds {
            let path = "/Bench/Day \(n % 10)/._copy-\(n).jpg"
            record("createFile", try await timed { try await store.createFile(path) })
            record("write 4 KB", try await timed { _ = try await store.write(path, at: 0, header) })
            record("truncate", try await timed { try await store.truncate(path, to: 4096) })
            record("setModified", await timed { await store.setModified(path, to: date) })
        }
        for n in 0..<Self.rounds {
            let real = seeded[n].replacingOccurrences(of: "/._", with: "/")
            record("move ._ file", await timed { await store.move(seeded[n], to: seeded[n] + " 2") })
            record("move real file", await timed { await store.move(real, to: real + " 2") })
            record("remove ._ file", await timed { await store.remove(seeded[n] + " 2") })
            record("removeAttributes (real file)", await timed { await store.removeAttributes(under: real + " 2") })
        }
        let folders = Set(seeded.map { ($0 as NSString).deletingLastPathComponent }).sorted()
        for n in 0..<Self.rounds {
            let folder = folders[n % folders.count]
            record("names(in:) a folder", await timed { _ = await store.names(in: folder) })
        }

        let after = try FileManager.default.contentsOfDirectory(atPath: dir.path).sorted().map { name in
            let size = (try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(name).path)[.size] as? Int) ?? 0
            return name == "blobs" ? name : "\(name) \(size) B"
        }
        print("\n\(size) entries — index.json \(indexBytes / 1024) KB, opened in \(micros(opened)) µs holding \(held / 1024) KB; "
              + "after: \(after.joined(separator: ", "))")
        for (name, times) in samples {
            let sorted = times.sorted()
            let mean = sorted.reduce(Duration.zero, +) / sorted.count
            let line = [mean, sorted[sorted.count / 2], sorted[sorted.count * 99 / 100], sorted[sorted.count - 1]].map(micros)
            print("  \(name.padding(toLength: 30, withPad: " ", startingAt: 0)) \(line.map { $0.leftPadded(9) }.joined())")
        }
    }

    /// The other side of the log: index.json written whole once it has
    /// outgrown it, and the log read back as the store opens — at most
    /// a log just short of being folded in, after a crash or a mount that
    /// ended before the store did.
    @Test func foldingTheLogIn() async throws {
        print("local store bench: the log folded in, and read back — medians")
        for size in Self.sizes {
            let dir = benchDirectory()
            defer { try? FileManager.default.removeItem(at: dir) }
            _ = try seedStore(dir, entries: size)
            let clock = ContinuousClock()
            var store: LocalStore!
            let upgraded = try clock.measure { store = try LocalStore(directory: dir) }

            // An open, apart: index.json read, then the folders found.
            let data = try Data(contentsOf: dir.appendingPathComponent(LocalStore.indexFile))
            var decoded = LocalStore.Index()
            let decode = try clock.measure { decoded = try JSONDecoder().decode(LocalStore.Index.self, from: data) }
            let link = clock.measure { decoded.linkAll() }

            var compactions: [Duration] = []
            for _ in 0..<5 { compactions.append(await timed { await store.compact() }) }
            let compaction = median(compactions)
            let snapshot = try FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(LocalStore.indexFile).path)[.size] as? Int ?? 0
            let threshold = LocalStore.logLimit(snapshot)

            let start = await store.disk
            var spent = Duration.zero
            for n in 0..<Self.rounds {
                let path = "/Bench/._copy-\(n).jpg"
                spent += try await timed {
                    try await store.createFile(path)
                    _ = try await store.write(path, at: 0, Data(repeating: 0x41, count: 4096))
                    try await store.truncate(path, to: 4096)
                    await store.setModified(path, to: Date(timeIntervalSince1970: 1_762_000_000))
                }
            }
            let rounds = await store.disk
            let changes = rounds.appends - start.appends
            let line = (rounds.appendBytes - start.appendBytes) / changes
            let perChange = spent / changes
            let between = threshold / line

            // Filled to just short of being folded in, then opened again —
            // which folds it in — and again, with nothing to read back.
            var replays: [Duration] = [], plain: [Duration] = []
            var current: LocalStore = store
            // What the log holds already: the rounds above.
            var carried = rounds.appendBytes - start.appendBytes
            for _ in 0..<3 {
                let before = await current.disk
                var logged = carried
                var n = 0
                while logged < threshold - 2048 {
                    n += 1
                    await current.setModified("/Bench/._copy-0.jpg", to: Date(timeIntervalSince1970: Double(n)))
                    logged = carried + (await current.disk.appendBytes - before.appendBytes)
                }
                #expect(await current.disk.snapshots == before.snapshots, "not folded in yet")
                if replays.isEmpty { try readingBack(dir) }
                var reopened: LocalStore!
                replays.append(try clock.measure { reopened = try LocalStore(directory: dir) })
                plain.append(try clock.measure { _ = try LocalStore(directory: dir) })
                current = reopened
                carried = 0
            }

            print("""

                \(size) entries — index.json \(snapshot / 1024) KB; opened from before the log (folded in) in \(micros(upgraded)) µs
                  an open with no log: \(micros(median(plain))) µs — index.json read \(micros(decode)) µs, its folders found \(micros(link)) µs
                  index.json written whole: \(micros(compaction)) µs, once the log passes \(threshold / 1024) KB
                  a change: \(line) bytes, \(micros(perChange)) µs — \(between) of them between foldings, \
                \(micros(perChange + compaction / between)) µs each with its share of one
                  an open with \(threshold / 1024) KB of log to read back and fold in: \(micros(median(replays))) µs
                """)
        }
    }
}

/// The full log of a store in `dir`, read back as an open reads it (one
/// array) and a line at a time, by turns: what the open spends on the log.
private func readingBack(_ dir: URL) throws {
    let generation = try #require(LocalStore.load(dir).index.generation)
    let log = try Data(contentsOf: LocalStore.logURL(generation, in: dir))
    let clock = ContinuousClock()
    var whole: [Duration] = [], lines: [Duration] = [], loads: [Duration] = []
    for _ in 0..<5 {
        loads.append(clock.measure { _ = LocalStore.load(dir) })
        whole.append(clock.measure {
            var all = Data([0x5B])
            all.append(log)
            all.withUnsafeMutableBytes { bytes in
                for at in bytes.indices where bytes[at] == 0x0A { bytes[at] = 0x2C }
                bytes[bytes.count - 1] = 0x5D
            }
            _ = try? JSONDecoder().decode([[LocalStore.Change]].self, from: all)
        })
        lines.append(clock.measure {
            let decoder = JSONDecoder()
            _ = log.split(separator: 0x0A).compactMap { try? decoder.decode([LocalStore.Change].self, from: Data($0)) }
        })
    }
    print("  the log, \(log.count / 1024) KB, read back: as one array \(micros(median(whole))) µs, "
          + "a line at a time \(micros(median(lines))) µs; index.json and log read and applied \(micros(median(loads))) µs")
}

private func median(_ times: [Duration]) -> Duration { times.sorted()[times.count / 2] }

/// A store of `count` entries as the Mac's are: `._` files four folders
/// down in some 300 folders, about 160 bytes of index.json each, written
/// as an Onyx from before the log wrote them. → their paths.
func seedStore(_ dir: URL, entries count: Int, blobs: Bool = false) throws -> [String] {
    let folder = dir.appendingPathComponent("blobs", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var index = LocalStore.Index()
    var paths: [String] = []
    for n in 0..<count {
        let path = "/Portfolio/20\(20 + n % 5)/Client \(n % 7) Lookbook/Selects \(n % 9) Final/._IMG_\(String(format: "%05d", n)).JPG"
        let blob = UUID().uuidString
        if blobs { FileManager.default.createFile(atPath: folder.appendingPathComponent(blob).path, contents: nil) }
        index.files[path] = LocalStore.Entry(blob: blob, directory: false, modified: 1_762_000_000 + Double(n))
        paths.append(path)
    }
    try JSONEncoder().encode(index).write(to: dir.appendingPathComponent("index.json"))
    return paths
}

private func benchDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("onyxfs-bench-store-\(UUID().uuidString)", isDirectory: true)
}

/// Bytes malloc has handed out and not had back, across its zones.
private func liveBytes() -> Int {
    var stats = malloc_statistics_t()
    malloc_zone_statistics(nil, &stats)
    return Int(stats.size_in_use)
}

private func timed(_ body: () async throws -> Void) async rethrows -> Duration {
    let start = ContinuousClock.now
    try await body()
    return ContinuousClock.now - start
}

private func micros(_ duration: Duration) -> String {
    let (seconds, attoseconds) = duration.components
    return String(format: "%.1f", Double(seconds) * 1e6 + Double(attoseconds) / 1e12)
}

private extension String {
    func leftPadded(_ width: Int) -> String { count >= width ? self : String(repeating: " ", count: width - count) + self }
}
