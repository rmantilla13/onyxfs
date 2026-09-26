import Foundation

/// Timed words, as a speech recognizer gives them, into captions.
///
/// A caption is read in the time it is on screen, so it is kept short: it
/// ends at a sentence's end, before it would run past ~7 seconds or ~84
/// characters (two lines of a subtitle), at a long pause, and at a comma once
/// it is half full. The result is what the server accepts and nothing it
/// would refuse: no empty text, times to three decimals, each segment
/// starting no earlier than the one before ended.
///
/// Pure, so both engines (SpeechAnalyzer, SFSpeechRecognizer) share it and
/// it is tested here rather than against a microphone.
public enum TranscriptSegmenter {
    /// One recognized word, with the space before it if the language puts one
    /// there (" world"). The engine's own spacing is kept rather than one
    /// invented here, so Japanese or Chinese stays without spaces.
    public struct Word: Sendable, Equatable {
        public var text: String
        public var start: Double
        public var end: Double

        public init(_ text: String, start: Double, end: Double) {
            self.text = text; self.start = start; self.end = end
        }
    }

    /// A stretch of recognized text that may or may not carry a time: the
    /// runs of a SpeechAnalyzer result, where words are timed and the spaces
    /// and some punctuation between them are not.
    public struct Run: Sendable, Equatable {
        public var text: String
        public var start: Double?
        public var end: Double?

        public init(_ text: String, start: Double? = nil, end: Double? = nil) {
            self.text = text; self.start = start; self.end = end
        }
    }

    public struct Limits: Sendable {
        public var maxDuration: Double = 7
        public var maxCharacters = 84
        /// Silence longer than this ends a caption: text should not sit on
        /// screen over a gap in the speech.
        public var pause: Double = 1.5
        /// The server's own limit on one segment's text.
        public var hardCharacters = 1000

        public init() {}
    }

    /// Runs into words: untimed text touching the end of a word (".", ",")
    /// joins that word; from its first space on, it leads the next one.
    public static func words(from runs: [Run]) -> [Word] {
        var words: [Word] = []
        var pending = ""
        for run in runs {
            if let start = run.start, let end = run.end, start.isFinite, end.isFinite {
                words.append(Word(pending + run.text, start: start, end: max(start, end)))
                pending = ""
            } else if pending.isEmpty, !words.isEmpty {
                let head = run.text.prefix { !$0.isWhitespace }
                words[words.count - 1].text += head
                pending = String(run.text.dropFirst(head.count))
            } else {
                pending += run.text
            }
        }
        // Text after the last timed word is that word's.
        if !pending.isEmpty, !words.isEmpty { words[words.count - 1].text += pending }
        return words
    }

    public static func segments(from words: [Word], limits: Limits = Limits()) -> [TranscriptSegment] {
        var out: [TranscriptSegment] = []
        var text = ""
        var start = 0.0, end = 0.0

        func close() {
            let t = clean(text)
            if !t.isEmpty { out.append(TranscriptSegment(start: start, end: end, text: t)) }
            text = ""
        }

        for word in words {
            let piece = clean(word.text)
            guard !piece.isEmpty, word.start.isFinite, word.end.isFinite else { continue }
            let s = max(0, word.start), e = max(s, word.end)
            if text.isEmpty {
                // Punctuation alone, just after a break, belongs to the words
                // before it; a caption never starts with a full stop.
                if piece.allSatisfy(\.isPunctuation), var last = out.popLast() {
                    last.text = clean(last.text + piece)
                    last.end = max(last.end, e)
                    out.append(last)
                    continue
                }
                start = s; end = e; text = word.text
            } else if e - start > limits.maxDuration
                        || clean(text + word.text).count > limits.maxCharacters
                        || s - end > limits.pause {
                close()
                start = s; end = e; text = word.text
            } else {
                text += word.text
                end = max(end, e)
            }
            if endsSentence(piece) {
                close()
            } else if endsClause(piece),
                      end - start >= limits.maxDuration / 2 || clean(text).count >= limits.maxCharacters / 2 {
                close()
            }
        }
        close()
        return tidy(out, limits: limits)
    }

    /// Three decimals, in order, and within the server's limits. Rounding and
    /// recognizers' overlapping words can both put a start before the last
    /// end; it is moved up to it.
    static func tidy(_ segments: [TranscriptSegment], limits: Limits) -> [TranscriptSegment] {
        var previousEnd = 0.0
        return segments.map { segment in
            let start = max(round3(segment.start), previousEnd)
            let end = max(round3(segment.end), start)
            previousEnd = end
            return TranscriptSegment(start: start, end: end, text: String(segment.text.prefix(limits.hardCharacters)))
        }
    }

    static func round3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }

    /// Runs of spaces and line breaks as one space, and none at either end.
    static func clean(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Closing quotes and brackets after the mark do not hide it:
    /// `"Stop."` ends a sentence.
    private static func lastMark(_ s: String) -> Character? {
        s.last { !"\"'”’»)]」』".contains($0) }
    }

    static func endsSentence(_ s: String) -> Bool {
        guard let c = lastMark(s), ".!?…。！？؟।".contains(c) else { return false }
        // "Dr." is not the end of anything.
        return !titles.contains(s.lowercased())
    }

    private static let titles: Set<String> = ["mr.", "mrs.", "ms.", "dr.", "st.", "vs.", "e.g.", "i.e."]

    static func endsClause(_ s: String) -> Bool {
        guard let c = lastMark(s) else { return false }
        return ",;:—–，、；：".contains(c)
    }
}
