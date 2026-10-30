import SwiftUI

/// A note on a native surface — the menu bar's panel, Settings › Finder —
/// that something needs a look, or just a word: why drives are in a folder
/// rather than disks, whether Full Disk Access is on, where Keep Offline is
/// in Finder's menus. One drawing for all of them, so "needs a look" reads
/// the same everywhere: the panel's inset group with a leading icon in the
/// note's tone, a title, the body in secondary ink, and the buttons that put
/// it right beneath. `problem` is the line in red when the way to put it
/// right did not work either.
///
/// Three tones, told apart by the icon alone: the card is the same for each,
/// so a wall of notes never turns into a wall of colour.
/// What a note is about. Outside the card's type, which is generic over its
/// buttons: nested there, naming the tone would name the buttons too.
enum NoteTone {
    /// Something to know.
    case info
    /// Something to do.
    case warning
    /// Something that went wrong.
    case problem

    var tint: AnyShapeStyle {
        switch self {
        case .info: return AnyShapeStyle(.secondary)
        case .warning: return AnyShapeStyle(Theme.warning)
        case .problem: return AnyShapeStyle(Theme.danger)
        }
    }
}

struct NoteCard<Actions: View>: View {
    typealias Tone = NoteTone

    var tone: Tone = .info
    let icon: String
    var title: String? = nil
    let message: String
    var problem: String? = nil
    @ViewBuilder var actions: () -> Actions

    init(tone: Tone = .info, icon: String, title: String? = nil, message: String, problem: String? = nil,
         @ViewBuilder actions: @escaping () -> Actions) {
        self.tone = tone
        self.icon = icon
        self.title = title
        self.message = message
        self.problem = problem
        self.actions = actions
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(lucide: icon, size: 14)
                .foregroundStyle(tone.tint)
                // Level with the first line's x-height, whichever font it is in.
                .padding(.top, title == nil ? 1 : 2)
            VStack(alignment: .leading, spacing: 5) {
                if let title {
                    Text(title).font(.callout.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(message)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let problem {
                    Text(problem).font(.caption).foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 8) { actions() }
                    .controlSize(.small)
                    .padding(.top, 1)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panelGroup()
        .accessibilityElement(children: .contain)
    }
}

extension NoteCard where Actions == EmptyView {
    /// A note with nothing to press.
    init(tone: Tone = .info, icon: String, title: String? = nil, message: String, problem: String? = nil) {
        self.init(tone: tone, icon: icon, title: title, message: message, problem: problem) { EmptyView() }
    }
}
