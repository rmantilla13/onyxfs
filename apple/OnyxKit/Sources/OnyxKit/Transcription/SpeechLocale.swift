import Foundation

/// Which of a recognizer's locales to use for a language someone asked for.
///
/// A transcript may be requested as "en-US", as plain "en", or as nothing at
/// all (the Mac's own language, which may be "en-ES" — English, set in
/// Spain — for which no recognizer exists). Each is mapped to one the Mac
/// has: the same tag; else the same language in the same region; else in
/// the Mac's region; else in the language's home region (de-DE, en-US).
public enum SpeechLocale {
    /// The entry of `supported` to use for `requested`, as it appears there,
    /// or nil when none is in that language.
    public static func match(_ requested: String, among supported: [String], preferredRegion: String? = nil) -> String? {
        let want = Tag(requested)
        guard !want.language.isEmpty else { return nil }
        let candidates = supported.map { ($0, Tag($0)) }.filter { $0.1.language == want.language }
        if let exact = candidates.first(where: { $0.1 == want }) { return exact.0 }
        let regions = [want.region, preferredRegion?.uppercased(), homeRegion[want.language] ?? want.language.uppercased()]
        for region in regions.compactMap({ $0 }) {
            if let hit = candidates.first(where: { $0.1.region == region }) { return hit.0 }
        }
        return candidates.min { $0.0 < $1.0 }?.0
    }

    /// Where a language is spoken by default, where that is not the region
    /// its code spells (fr → FR is; en → EN is not).
    static let homeRegion: [String: String] = [
        "en": "US", "pt": "BR", "zh": "CN", "ja": "JP", "ko": "KR", "sv": "SE", "da": "DK",
        "nb": "NO", "el": "GR", "cs": "CZ", "uk": "UA", "he": "IL", "hi": "IN", "vi": "VN",
        "ar": "SA", "ms": "MY", "ca": "ES",
    ]

    /// A BCP-47 tag reduced to what the recognizers vary by: the language
    /// and the region, whatever the case or separator ("pt_br", "zh-Hans-CN").
    struct Tag: Equatable {
        let language: String
        let region: String?

        init(_ tag: String) {
            // "en_US@rg=gbzzzz", as Locale writes one: the part before the "@".
            let base = tag.split(separator: "@").first.map(String.init) ?? ""
            let parts = base.replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
            language = parts.first?.lowercased() ?? ""
            // Up to the first extension ("-u-…"), whose keys look like regions.
            region = parts.dropFirst().prefix { $0.count > 1 }.first { part in
                (part.count == 2 && part.allSatisfy(\.isLetter)) || (part.count == 3 && part.allSatisfy(\.isNumber))
            }?.uppercased()
        }
    }
}
