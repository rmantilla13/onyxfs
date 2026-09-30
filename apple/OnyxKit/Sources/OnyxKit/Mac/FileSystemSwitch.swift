import Foundation

/// Whether Onyx for Mac's drives are disks of their own — the Onyx file
/// system (onyxfs, ONYXFS.md) switched on in System Settings — and what Onyx
/// does when it finds it off. The decisions only; DriveService acts on them.
/// Kept apart from FSKit and the app so they are tested (FileSystemSwitchTests).
///
/// Only the person can switch it on: System Settings › General › Login
/// Items & Extensions › File System Extensions. macOS 27.0.1 lets no one
/// else — fskitd sets a module's switch only for a caller holding Apple's
/// private LiveFS entitlement, which that pane has and Onyx cannot (Onyx's
/// own Turn On, through FSKit's undeclared setEnabledState call, is refused
/// with EPERM). So Onyx keeps the switch from being lost (UpdateSwap), says
/// so plainly when it is off anyway, and moves the drives to disks the
/// moment it is back on.
public enum FileSystemSwitch {
    /// What FSKit says of Onyx's file system (DiskMounter.Availability).
    public enum State: String, Codable, Sendable {
        case unknown
        /// Switched on, and this copy may mount.
        case ready
        /// Switched off in System Settings.
        case disabled
        /// This copy carries it, but macOS has not taken it in: a restart does.
        case notLoaded
        /// This copy has none (an unsigned build, or macOS before 27).
        case notInstalled
    }

    /// Which macOS this is. Onyx's own Turn On is tried only on one where it
    /// may work, and not again on a build that refused it.
    public struct System: Equatable, Sendable {
        public var major: Int
        public var minor: Int
        public var patch: Int
        /// "26A434": what distinguishes two builds of one version.
        public var build: String

        public init(major: Int, minor: Int, patch: Int, build: String) {
            self.major = major; self.minor = minor; self.patch = patch; self.build = build
        }

        /// This Mac's.
        public static let current: System = {
            let v = ProcessInfo.processInfo.operatingSystemVersion
            var size = 0
            sysctlbyname("kern.osversion", nil, &size, nil, 0)
            var bytes = [CChar](repeating: 0, count: max(size, 1))
            sysctlbyname("kern.osversion", &bytes, &size, nil, 0)
            return System(major: v.majorVersion, minor: v.minorVersion, patch: v.patchVersion,
                          build: String(cString: bytes))
        }()

        /// "27.0.1 (26A434)".
        public var name: String { "\(major).\(minor).\(patch) (\(build))" }
    }

    /// What Onyx remembers across launches (UserDefaults, `onyxfs.switch`).
    public struct Memory: Codable, Equatable, Sendable {
        /// The file system was on the last time Onyx looked, and the person
        /// has not switched it off since while Onyx watched.
        public var wasOn = false
        /// The Onyx that last looked at launch ("0.5.18 (202609292031)"):
        /// another now means Onyx was replaced in between.
        public var lastBuild: String?
        /// "<Onyx>|<macOS>" whose one automatic Turn On was tried: never twice.
        public var triedTurnOn: String?
        /// The macOS (`System.name`) that refused Onyx's own Turn On.
        public var refusedOn: String?
        /// This loss has been told (the notice): not again until the file
        /// system has been on again.
        public var told = false

        public init() {}

        public static let key = "onyxfs.switch"

        /// What was kept; or, the first time, what an earlier Onyx that kept
        /// nothing leaves to go by: `disksSeen`, whether drives were disks on
        /// this Mac (a disk given its icon, say). The switch lost on the way
        /// to the first Onyx that remembers is still told.
        public static func load(from defaults: UserDefaults = .standard, disksSeen: Bool = false) -> Memory {
            guard let data = defaults.data(forKey: key),
                  let memory = try? JSONDecoder().decode(Memory.self, from: data) else {
                var first = Memory()
                first.wasOn = disksSeen
                return first
            }
            return memory
        }

        public func save(to defaults: UserDefaults = .standard) {
            if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) }
        }
    }

    public enum Reason: Equatable, Sendable {
        /// Switched off: System Settings puts it right.
        case switchedOff
        /// macOS has not taken this copy's in: a restart does.
        case needsRestart
    }

    public enum Action: Equatable, Sendable {
        case none
        /// Onyx's own Turn On, once.
        case turnOn
        /// Tell the person the drives are in the Onyx folder, and why.
        case tell(Reason)
    }

    public enum Change: Equatable, Sendable {
        case none
        /// Switched on while Onyx runs: the drives in ~/Onyx become disks.
        case becameReady
        /// Switched off while Onyx watched: the person's choice.
        case switchedOff
    }

    /// Whether Onyx asks macOS itself to switch its file system on
    /// (DiskMounter.enableExtension): only on macOS 27.0, the one it was made
    /// for (0.5.1), and not on a build that refused it. 27.0.1's fskitd sets
    /// a module's switch only for a caller with Apple's private LiveFS
    /// entitlement — System Settings' File System Extensions sheet — and
    /// refuses Onyx with EPERM, so there, and on anything newer, System
    /// Settings is the way.
    public static func offersTurnOn(_ memory: Memory, on system: System) -> Bool {
        system.major == 27 && system.minor == 0 && system.patch == 0 && memory.refusedOn != system.name
    }

    /// Once a launch, when FSKit has answered and the drives are coming back.
    ///
    /// Off, when it was on last time: either Onyx was replaced meanwhile (an
    /// update Onyx did not make: an older updater's, or a copy dragged from
    /// the disk image), or the person switched it off while Onyx was not
    /// running. Onyx switches it back on itself only after it was replaced,
    /// only where it may (`offersTurnOn`), and only once for that Onyx on that
    /// macOS; otherwise it tells the person, once — and only if some drive is
    /// to be in Finder, since only then is anything in the wrong place.
    public static func atLaunch(_ state: State, drivesInFinder: Bool, build: String, system: System,
                                memory: inout Memory) -> Action {
        let replaced = memory.lastBuild.map { $0 != build } ?? false
        memory.lastBuild = build
        switch state {
        case .ready:
            memory.wasOn = true
            memory.told = false
            return .none
        case .disabled:
            guard memory.wasOn else { return .none }
            let attempt = "\(build)|\(system.name)"
            if replaced, offersTurnOn(memory, on: system), memory.triedTurnOn != attempt {
                // Recorded before it is tried: a crash in between never
                // makes it a loop.
                memory.triedTurnOn = attempt
                return .turnOn
            }
            return tell(.switchedOff, drivesInFinder: drivesInFinder, memory: &memory)
        case .notLoaded:
            guard memory.wasOn else { return .none }
            return tell(.needsRestart, drivesInFinder: drivesInFinder, memory: &memory)
        case .unknown, .notInstalled:
            return .none
        }
    }

    /// Onyx's own Turn On came back: on (nothing more to do), or not — then
    /// the person is told, and a refusal is remembered for this macOS.
    public static func turnOnAnswered(on: Bool, refused: Bool, drivesInFinder: Bool, system: System,
                                      memory: inout Memory) -> Action {
        if on { return .none }
        if refused { self.refused(on: system, memory: &memory) }
        return tell(.switchedOff, drivesInFinder: drivesInFinder, memory: &memory)
    }

    /// macOS refused Onyx's own Turn On (EPERM): not offered, nor tried, on
    /// this macOS again.
    public static func refused(on system: System, memory: inout Memory) {
        memory.refusedOn = system.name
    }

    /// FSKit answered differently while Onyx runs. On again after anything
    /// but its first answer — switched on, taken in by macOS, or FSKit back
    /// from a failure to answer, during which a drive may have gone to
    /// ~/Onyx — the drives in ~/Onyx become disks. Onyx cannot be replaced
    /// while it runs, so a switch turned off meanwhile is the person's doing:
    /// neither switched back on nor told about.
    public static func changed(from old: State, to new: State, memory: inout Memory) -> Change {
        guard old != new else { return .none }
        if new == .ready {
            memory.wasOn = true
            memory.told = false
            return old == .unknown ? .none : .becameReady
        }
        if old == .ready && new == .disabled {
            memory.wasOn = false
            return .switchedOff
        }
        return .none
    }

    private static func tell(_ reason: Reason, drivesInFinder: Bool, memory: inout Memory) -> Action {
        guard drivesInFinder, !memory.told else { return .none }
        memory.told = true
        return .tell(reason)
    }
}
