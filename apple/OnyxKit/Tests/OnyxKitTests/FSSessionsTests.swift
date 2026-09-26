import Testing
import Foundation
@testable import OnyxKit

/// Tickets and sessions for the onyxfs bridge. The ticket travels in a URL
/// every account on the Mac can read, so what it is worth — once, for two
/// minutes, for one drive — is the whole of the security, and each rule is
/// pinned.
struct FSSessionsTests {
    /// The time of day, as a test sets it.
    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 1_790_000_000)
        var now: Date { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
    }

    static let base64url = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    @Test func ticketsAndKeysAre32RandomBytesInBase64url() throws {
        let sessions = FSSessions()
        var seen = Set<String>()
        for _ in 0..<50 {
            let ticket = sessions.issueTicket(for: "drive.a")
            #expect(ticket.count == 43, "32 bytes, no padding")
            #expect(ticket.unicodeScalars.allSatisfy(Self.base64url.contains))
            #expect(seen.insert(ticket).inserted)
            let (key, _) = try #require(sessions.exchange(ticket))
            #expect(key.count == 43 && key != ticket)
            #expect(key.unicodeScalars.allSatisfy(Self.base64url.contains))
            #expect(seen.insert(key).inserted)
        }
    }

    @Test func aTicketIsGoodForOneExchangeForItsDrive() throws {
        let sessions = FSSessions()
        let ticket = sessions.issueTicket(for: "drive.a")
        let (key, scope) = try #require(sessions.exchange(ticket))
        #expect(scope == "drive.a")
        #expect(sessions.exchange(ticket) == nil, "spent")
        #expect(sessions.exchange("") == nil)
        #expect(sessions.exchange("not-a-ticket") == nil)
        #expect(sessions.session(for: "Bearer \(key)") == FSSessions.Session(id: FSSessions.digest(key), scope: "drive.a"))
        // A ticket is not a key.
        #expect(sessions.session(for: "Bearer \(ticket)") == nil)
    }

    @Test func aTicketLastsTwoMinutes() {
        let clock = Clock()
        let sessions = FSSessions(clock: { clock.now })
        let early = sessions.issueTicket(for: "drive.a")
        let late = sessions.issueTicket(for: "drive.a")
        clock.advance(119)
        #expect(sessions.exchange(early) != nil)
        clock.advance(2)
        #expect(sessions.exchange(late) == nil, "expired at 120 s")
    }

    @Test func onlyTheExactBearerHeaderIsASession() throws {
        let sessions = FSSessions()
        let (key, _) = try #require(sessions.exchange(sessions.issueTicket(for: "library")))
        #expect(sessions.session(for: "Bearer \(key)")?.scope == "library")
        #expect(sessions.session(for: " Bearer \(key)\t")?.scope == "library", "blanks around the value are forgiven")
        for header in [nil, "", "Bearer", "Bearer ", "bearer \(key)", "Basic \(key)", key, "Bearer \(key)x",
                       "Bearer \(key.dropLast())", "Bearer  \(key)"] {
            #expect(sessions.session(for: header) == nil, "\(header ?? "no header")")
        }
    }

    @Test func endingADriveEndsItsSessionsAndTicketsOnly() throws {
        let sessions = FSSessions()
        let (a1, _) = try #require(sessions.exchange(sessions.issueTicket(for: "drive.a")))
        let (a2, _) = try #require(sessions.exchange(sessions.issueTicket(for: "drive.a")))
        let (b, _) = try #require(sessions.exchange(sessions.issueTicket(for: "drive.b")))
        let unspentA = sessions.issueTicket(for: "drive.a")
        let unspentB = sessions.issueTicket(for: "drive.b")

        sessions.end(scope: "drive.a")
        #expect(sessions.session(for: "Bearer \(a1)") == nil)
        #expect(sessions.session(for: "Bearer \(a2)") == nil)
        #expect(sessions.exchange(unspentA) == nil)
        #expect(sessions.session(for: "Bearer \(b)")?.scope == "drive.b")
        #expect(sessions.exchange(unspentB)?.scope == "drive.b")

        sessions.revoke(b)
        #expect(sessions.session(for: "Bearer \(b)") == nil)

        let (c, _) = try #require(sessions.exchange(sessions.issueTicket(for: "drive.c")))
        let unspent = sessions.issueTicket(for: "drive.c")
        sessions.endAll()
        #expect(sessions.session(for: "Bearer \(c)") == nil)
        #expect(sessions.exchange(unspent) == nil)
        #expect(sessions.sessionCount == 0)
    }
}
