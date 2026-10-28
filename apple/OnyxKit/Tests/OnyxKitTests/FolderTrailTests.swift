import Testing
@testable import OnyxKit

@Suite("FolderTrail")
struct FolderTrailTests {
    @Test("a folder's way down: each folder above it, then itself")
    func steps() {
        #expect(FolderTrail.steps(to: "Spring/Day 1/Selects") == ["Spring", "Spring/Day 1", "Spring/Day 1/Selects"])
        #expect(FolderTrail.steps(to: "Spring") == ["Spring"])
        #expect(FolderTrail.steps(to: "").isEmpty, "a place's top has nothing above it")
        #expect(FolderTrail.steps(to: "/Spring//Day 1/") == ["Spring", "Spring/Day 1"], "stray slashes are not folders")
    }

    @Test("how far down: 0 at the top")
    func depth() {
        #expect(FolderTrail.depth(of: "") == 0)
        #expect(FolderTrail.depth(of: "Spring") == 1)
        #expect(FolderTrail.depth(of: "Spring/Day 1/Selects/Finals") == 4)
    }
}
