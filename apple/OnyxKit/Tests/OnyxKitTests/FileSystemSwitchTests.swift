import Testing
import Foundation
@testable import OnyxKit

/// What Onyx does about its file system's switch (FileSystemSwitch): it
/// remembers the switch was on; finding it off at launch, it switches it back
/// on itself only after Onyx was replaced, only on a macOS that may let it,
/// and once; otherwise it tells the person, once; and it never undoes the
/// person's own choice.
@Suite struct FileSystemSwitchTests {
    static let first = "0.5.18 (202609292031)"
    static let next = "0.5.19 (202610011200)"
    /// Where Onyx's own Turn On is refused (fskitd wants Apple's private
    /// entitlement).
    static let refusing = FileSystemSwitch.System(major: 27, minor: 0, patch: 1, build: "26A434")
    /// The one Onyx's own Turn On was made for.
    static let original = FileSystemSwitch.System(major: 27, minor: 0, patch: 0, build: "26A123")

    /// A Mac on which the file system was on when `first` last ran.
    func wasOn() -> FileSystemSwitch.Memory {
        var memory = FileSystemSwitch.Memory()
        _ = FileSystemSwitch.atLaunch(.ready, drivesInFinder: true, build: Self.first, system: Self.refusing, memory: &memory)
        return memory
    }

    @Test func onAtLaunchIsRemembered() {
        let memory = wasOn()
        #expect(memory.wasOn)
        #expect(!memory.told)
        #expect(memory.lastBuild == Self.first)
    }

    @Test func offAfterBeingOnIsToldOnceWhereOnyxCannotSwitchItOn() {
        var memory = wasOn()
        let action = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                               system: Self.refusing, memory: &memory)
        #expect(action == .tell(.switchedOff), "27.0.1 refuses Onyx: the person is sent to System Settings")
        #expect(memory.triedTurnOn == nil)
        #expect(memory.wasOn, "still wanted: it is told, not forgotten")
        let again = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                              system: Self.refusing, memory: &memory)
        #expect(again == .none, "told once, not at every launch")
    }

    @Test func offAfterAnUpdateIsSwitchedBackOnOnceWhereOnyxMay() {
        var memory = wasOn()
        let action = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                               system: Self.original, memory: &memory)
        #expect(action == .turnOn)
        #expect(memory.triedTurnOn == "\(Self.next)|\(Self.original.name)")
        // It did not take (say a crash before it answered): the next launch
        // of the same Onyx tells, rather than trying again.
        let again = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                              system: Self.original, memory: &memory)
        #expect(again == .tell(.switchedOff))
    }

    @Test func offWithNoUpdateIsNotSwitchedOnByOnyx() {
        // Same Onyx as last time: the person may have switched it off while
        // Onyx was not running. Told, never switched back on.
        var memory = wasOn()
        let action = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.first,
                                               system: Self.original, memory: &memory)
        #expect(action == .tell(.switchedOff))
    }

    @Test func aRefusalIsRememberedForThatMacOS() {
        var memory = wasOn()
        #expect(FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                          system: Self.original, memory: &memory) == .turnOn)
        let then = FileSystemSwitch.turnOnAnswered(on: false, refused: true, drivesInFinder: true,
                                                   system: Self.original, memory: &memory)
        #expect(then == .tell(.switchedOff))
        #expect(memory.refusedOn == Self.original.name)
        #expect(!FileSystemSwitch.offersTurnOn(memory, on: Self.original))
        // Another update, same macOS: not tried again.
        memory.told = false
        let later = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: "0.5.20 (1)",
                                              system: Self.original, memory: &memory)
        #expect(later == .tell(.switchedOff))
    }

    @Test func aTurnOnThatWorkedNeedsNothingMore() {
        var memory = wasOn()
        _ = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next, system: Self.original, memory: &memory)
        let then = FileSystemSwitch.turnOnAnswered(on: true, refused: false, drivesInFinder: true,
                                                   system: Self.original, memory: &memory)
        #expect(then == .none)
        #expect(memory.refusedOn == nil)
    }

    @Test func onlyMacOS27Point0IsAskedAtAll() {
        let memory = FileSystemSwitch.Memory()
        #expect(FileSystemSwitch.offersTurnOn(memory, on: Self.original))
        #expect(!FileSystemSwitch.offersTurnOn(memory, on: Self.refusing))
        #expect(!FileSystemSwitch.offersTurnOn(memory, on: .init(major: 27, minor: 1, patch: 0, build: "26B1")))
        #expect(!FileSystemSwitch.offersTurnOn(memory, on: .init(major: 28, minor: 0, patch: 0, build: "27A1")))
    }

    @Test func switchedOffByThePersonWhileOnyxWatchedIsTheirs() {
        var memory = wasOn()
        #expect(FileSystemSwitch.changed(from: .ready, to: .disabled, memory: &memory) == .switchedOff)
        #expect(!memory.wasOn)
        // Next launch, even after an update, on a macOS that would let Onyx:
        // left off, and nothing said.
        let action = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                               system: Self.original, memory: &memory)
        #expect(action == .none)
    }

    @Test func nothingIsToldWithNoDriveInFinder() {
        var memory = wasOn()
        let action = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: false, build: Self.next,
                                               system: Self.refusing, memory: &memory)
        #expect(action == .none)
        #expect(!memory.told, "a drive turned on later is still told about")
    }

    @Test func offWhenItWasNeverOnSaysNothing() {
        var memory = FileSystemSwitch.Memory()
        let action = FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.first,
                                               system: Self.original, memory: &memory)
        #expect(action == .none, "the panel's row says it; no notice for a switch never on")
        #expect(memory.lastBuild == Self.first)
    }

    @Test func notTakenInIsARestart() {
        var memory = wasOn()
        let action = FileSystemSwitch.atLaunch(.notLoaded, drivesInFinder: true, build: Self.next,
                                               system: Self.original, memory: &memory)
        #expect(action == .tell(.needsRestart))
    }

    @Test func switchedOnWhileRunningMovesTheDrives() {
        var memory = FileSystemSwitch.Memory()
        #expect(FileSystemSwitch.changed(from: .disabled, to: .ready, memory: &memory) == .becameReady)
        #expect(memory.wasOn)
        #expect(FileSystemSwitch.changed(from: .notLoaded, to: .ready, memory: &memory) == .becameReady)
        // FSKit back after failing to answer (fskitd restarted, say): a
        // drive mounted meanwhile went to ~/Onyx.
        #expect(FileSystemSwitch.changed(from: .notInstalled, to: .ready, memory: &memory) == .becameReady)
        #expect(FileSystemSwitch.changed(from: .ready, to: .notInstalled, memory: &memory) == .none)
        #expect(memory.wasOn, "a failure to answer is not the person switching it off")
        // FSKit's first answer as Onyx opens: nothing is in ~/Onyx yet.
        var fresh = FileSystemSwitch.Memory()
        #expect(FileSystemSwitch.changed(from: .unknown, to: .ready, memory: &fresh) == .none)
        #expect(fresh.wasOn)
        #expect(FileSystemSwitch.changed(from: .ready, to: .ready, memory: &fresh) == .none)
        #expect(FileSystemSwitch.changed(from: .unknown, to: .disabled, memory: &fresh) == .none)
        #expect(fresh.wasOn, "not an answer about the person's choice")
    }

    @Test func aLossIsToldAgainOnceTheSwitchHasBeenBackOn() {
        var memory = wasOn()
        #expect(FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                          system: Self.refusing, memory: &memory) == .tell(.switchedOff))
        _ = FileSystemSwitch.changed(from: .disabled, to: .ready, memory: &memory)
        #expect(!memory.told)
        #expect(FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: "0.5.20 (1)",
                                          system: Self.refusing, memory: &memory) == .tell(.switchedOff))
    }

    @Test func theMemoryIsKept() throws {
        let suite = "onyx-switch-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(FileSystemSwitch.Memory.load(from: defaults) == FileSystemSwitch.Memory())
        var memory = wasOn()
        memory.refusedOn = Self.refusing.name
        memory.told = true
        memory.save(to: defaults)
        #expect(FileSystemSwitch.Memory.load(from: defaults) == memory)
    }

    @Test func theFirstOnyxThatRemembersGoesByDisksSeenBefore() throws {
        let suite = "onyx-switch-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // Nothing kept yet, but drives were disks here: a switch lost on the
        // way to this Onyx is still told.
        var memory = FileSystemSwitch.Memory.load(from: defaults, disksSeen: true)
        #expect(memory.wasOn)
        #expect(FileSystemSwitch.atLaunch(.disabled, drivesInFinder: true, build: Self.next,
                                          system: Self.refusing, memory: &memory) == .tell(.switchedOff))
        #expect(!FileSystemSwitch.Memory.load(from: defaults, disksSeen: false).wasOn)
        // Once something is kept, it is what counts.
        var kept = FileSystemSwitch.Memory()
        kept.lastBuild = Self.first
        kept.save(to: defaults)
        #expect(FileSystemSwitch.Memory.load(from: defaults, disksSeen: true) == kept)
    }

    @Test func thisMacsSystemHasABuild() {
        let system = FileSystemSwitch.System.current
        #expect(system.major >= 13)
        #expect(!system.build.isEmpty)
        #expect(system.name.contains("(\(system.build))"))
    }
}
