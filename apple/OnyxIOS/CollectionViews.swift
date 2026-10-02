import OnyxKit
import SwiftUI

// Collections on iPhone and iPad: make one, change its rules, delete it —
// the web's rule editor (app/files/CollectionEditor.js), against the same
// routes. A collection gathers the files that meet rules on their kind,
// tags and metadata; a folder's tags and metadata count for the files in it.

/// What a rule's operators are called, as the web words them.
private func opLabel(_ op: String, field: String) -> String {
    if field == "tag", op == "set" { return "has any tag" }
    if field == "tag", op == "unset" { return "has no tags" }
    switch op {
    case "none": return "is none of"
    case "set": return "is set"
    case "unset": return "is not set"
    case "before": return "is before"
    case "after": return "is after"
    default: return "is any of"
    }
}

private let kinds: [(key: String, label: String)] = [
    ("image", "Images"), ("video", "Videos"), ("audio", "Audio"), ("doc", "Documents"), ("other", "Other"),
]

/// A rule's field key → its metadata field, when it is one.
private func field(_ rule: FileCollection.Rule, in fields: [MetadataField]) -> MetadataField? {
    guard rule.field.hasPrefix("meta:") else { return nil }
    let key = String(rule.field.dropFirst(5))
    return fields.first { $0.key == key }
}

/// Which operators a field takes (lib/collections.js opsFor).
private func ops(for rule: FileCollection.Rule, in fields: [MetadataField]) -> [String] {
    if rule.field == "kind" { return ["any", "none"] }
    if rule.field == "tag" { return ["any", "none", "set", "unset"] }
    return field(rule, in: fields)?.type == "date"
        ? ["any", "none", "set", "unset", "before", "after"]
        : ["any", "none", "set", "unset"]
}

private func takesValues(_ op: String) -> Bool { op == "any" || op == "none" }
private func takesDay(_ op: String) -> Bool { op == "before" || op == "after" }

/// A rule in words, for a list: "Project is Spring or Summer".
func describe(_ rule: FileCollection.Rule, fields: [MetadataField]) -> String {
    let label = rule.field == "kind" ? "Kind" : rule.field == "tag" ? "Tag" : field(rule, in: fields)?.label ?? String(rule.field.dropFirst(5))
    let values = rule.values.joined(separator: " or ")
    switch rule.op {
    case "none": return "\(label) is not \(values)"
    case "set": return rule.field == "tag" ? "Has a tag" : "\(label) is set"
    case "unset": return rule.field == "tag" ? "Has no tags" : "\(label) is not set"
    case "before": return "\(label) before \(rule.values.first ?? "")"
    case "after": return "\(label) after \(rule.values.first ?? "")"
    default: return "\(label) is \(values)"
    }
}

/// Make a collection, or change one: its name, whether files must meet all
/// of the rules or any one, and the rules. `onSaved` has the collection as
/// saved; `onDeleted` runs after a delete.
struct CollectionEditor: View {
    let existing: FileCollection?
    var onSaved: (FileCollection, Place) -> Void = { _, _ in }
    var onDeleted: () -> Void = {}
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var match = "all"
    /// Each rule with an identity of its own, so a rule's row keeps what is
    /// typed in it when one above it is removed.
    @State private var rows: [RuleRow] = [RuleRow()]
    private var rules: [FileCollection.Rule] { rows.map(\.rule) }
    @State private var place: Place?
    @State private var problem: String?
    @State private var saving = false
    @State private var confirmingDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Name") {
                        TextField("Name", text: $name, prompt: Text("Spring launch"))
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.words)
                    }
                    if existing == nil {
                        Picker("In", selection: $place) {
                            ForEach(session.placesForNewCollections) { Text($0.name).tag(Optional($0)) }
                        }
                    } else if let place {
                        LabeledContent("In", value: place.name)
                    }
                } footer: {
                    Text("Every file there that meets these rules, kept up to date. A folder’s tags and metadata count for the files inside it. Everyone who can open it sees the collection, and only the files they could already open.")
                }
                .glassRow()

                Section {
                    Picker("Files that meet", selection: $match) {
                        Text("All of the rules").tag("all")
                        Text("Any of the rules").tag("any")
                    }
                }
                .glassRow()

                ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                    RuleSection(index: i, rule: $rows[i].rule, fields: session.metadataFields, canRemove: rows.count > 1) {
                        rows.removeAll { $0.id == row.id }
                    }
                }

                Section {
                    Button {
                        rows.append(RuleRow())
                    } label: {
                        Label("Add Rule", systemImage: "plus")
                    }
                    .disabled(rows.count >= 20)
                } footer: {
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill")
                            .symbolRenderingMode(.multicolor)
                    }
                }
                .glassRow()

                if existing?.canEdit == true {
                    Section {
                        Button("Delete Collection", role: .destructive) { confirmingDelete = true }
                    }
                    .glassRow()
                }
            }
            .sheetBackground()
            .navigationTitle(existing == nil ? "New Collection" : "Edit Collection")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button(existing == nil ? "Make" : "Save") { save() }.fontWeight(.semibold) }
                }
            }
            .confirmationDialog("Delete this collection?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete Collection", role: .destructive) { delete() }
            } message: {
                Text("It goes for everyone who can see it. Its files stay where they are.")
            }
            .onAppear(perform: fill)
        }
    }

    private func fill() {
        guard place == nil else { return }
        if let existing {
            name = existing.name
            match = existing.match
            if !existing.rules.isEmpty { rows = existing.rules.map { RuleRow(rule: $0) } }
            place = session.place(for: existing.scope)
        } else {
            place = session.placesForNewCollections.first
        }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { problem = "Give the collection a name."; return }
        if let i = rules.firstIndex(where: { (takesValues($0.op) || takesDay($0.op)) && $0.values.isEmpty }) {
            problem = "Rule \(i + 1) needs \(takesDay(rules[i].op) ? "a day" : "a value")."
            return
        }
        guard let place else { problem = "Choose where the collection goes."; return }
        saving = true
        problem = nil
        Task {
            let result = await session.saveCollection(existing, in: place, name: trimmed, match: match, rules: rules)
            saving = false
            switch result {
            case let .success(saved):
                dismiss()
                onSaved(saved, place)
            case let .failure(p):
                problem = p.words
            }
        }
    }

    private func delete() {
        guard let existing else { return }
        Task {
            if let words = await session.deleteCollection(existing) {
                problem = words
            } else {
                dismiss()
                onDeleted()
            }
        }
    }
}

private struct RuleRow: Identifiable {
    let id = UUID()
    var rule = FileCollection.Rule(field: "tag", op: "any", values: [])
}

/// One rule: its field, its test, and its values.
private struct RuleSection: View {
    let index: Int
    @Binding var rule: FileCollection.Rule
    let fields: [MetadataField]
    let canRemove: Bool
    let remove: () -> Void
    @State private var words: String

    // The words filled once, here, not on appear: that can run again while
    // the keyboard comes up, over what is being typed.
    init(index: Int, rule: Binding<FileCollection.Rule>, fields: [MetadataField], canRemove: Bool, remove: @escaping () -> Void) {
        self.index = index
        _rule = rule
        self.fields = fields
        self.canRemove = canRemove
        self.remove = remove
        _words = State(initialValue: rule.wrappedValue.values.joined(separator: ", "))
    }

    var body: some View {
        Section {
            Picker("Field", selection: fieldBinding) {
                Text("Kind").tag("kind")
                Text("Tag").tag("tag")
                ForEach(fields) { Text($0.label).tag("meta:\($0.key)") }
            }
            Picker("Test", selection: opBinding) {
                ForEach(ops(for: rule, in: fields), id: \.self) { Text(opLabel($0, field: rule.field)).tag($0) }
            }
            values
        } header: {
            HStack {
                Text("Rule \(index + 1)")
                Spacer()
                if canRemove {
                    Button("Remove", role: .destructive, action: remove)
                        .font(.caption)
                        .textCase(nil)
                }
            }
        }
        .glassRow()
    }

    /// A new field starts over: its tests and values are its own.
    private var fieldBinding: Binding<String> {
        Binding(get: { rule.field }, set: { new in
            guard new != rule.field else { return }
            rule = .init(field: new, op: "any", values: [])
            words = ""
        })
    }

    private var opBinding: Binding<String> {
        Binding(get: { rule.op }, set: { new in
            if takesDay(new) != takesDay(rule.op) || !(takesValues(new) || takesDay(new)) {
                rule.values = []
                words = ""
            }
            rule.op = new
        })
    }

    @ViewBuilder private var values: some View {
        if takesDay(rule.op) {
            DatePicker("Day", selection: dayBinding, displayedComponents: .date)
        } else if takesValues(rule.op) {
            let choices: [(key: String, label: String)]? = rule.field == "kind"
                ? kinds
                : field(rule, in: fields)?.options.flatMap { $0.isEmpty ? nil : $0.map { ($0, $0) } }
            if let choices {
                ForEach(choices, id: \.key) { choice in
                    Button {
                        if rule.values.contains(choice.key) { rule.values.removeAll { $0 == choice.key } }
                        else { rule.values.append(choice.key) }
                    } label: {
                        HStack {
                            Text(choice.label).foregroundStyle(.primary)
                            Spacer()
                            if rule.values.contains(choice.key) { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                }
            } else {
                TextField("Values", text: $words, prompt: Text(rule.field == "tag" ? "hero, spring" : "One, or several with commas"))
                    .textInputAutocapitalization(.never)
                    .onChange(of: words) {
                        rule.values = words.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                    }
            }
        }
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private var dayBinding: Binding<Date> {
        Binding(get: {
            rule.values.first.flatMap { Self.day.date(from: $0) } ?? Date()
        }, set: { rule.values = [Self.day.string(from: $0)] })
    }
}

/// A folder's own tags and metadata, which the files inside it inherit in
/// collections. The files themselves are not changed.
struct FolderMetaEditor: View {
    let place: Place
    let node: FolderNode
    var onSaved: () -> Void = {}
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var tags: String
    @State private var values: [String: String]
    @State private var problem: String?
    @State private var saving = false

    // Filled once, here: an onAppear can run again while the keyboard comes
    // up, and would put back what was there over what is being typed.
    init(place: Place, node: FolderNode, onSaved: @escaping () -> Void = {}) {
        self.place = place
        self.node = node
        self.onSaved = onSaved
        _tags = State(initialValue: (node.tags ?? []).joined(separator: ", "))
        _values = State(initialValue: (node.metadata ?? [:]).mapValues { $0.values.joined(separator: ", ") })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Tags", text: $tags, prompt: Text("spring, launch"))
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Tags")
                } footer: {
                    Text("Every file in this folder, and in the folders inside it, counts as having these in collections. Separate them with commas.")
                }
                .glassRow()

                if !session.metadataFields.isEmpty {
                    Section("Metadata") {
                        ForEach(session.metadataFields) { f in
                            fieldRow(f)
                        }
                    }
                    .glassRow()
                }

                if let problem {
                    Section {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").symbolRenderingMode(.multicolor)
                    }
                    .glassRow()
                }
            }
            .sheetBackground()
            .navigationTitle(node.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button("Save") { save() }.fontWeight(.semibold) }
                }
            }
            .task { if session.metadataFields.isEmpty { await session.loadCollections() } }
        }
    }

    @ViewBuilder private func fieldRow(_ f: MetadataField) -> some View {
        let binding = Binding(get: { values[f.key] ?? "" }, set: { values[f.key] = $0 })
        if f.type == "select", let options = f.options, !options.isEmpty {
            Picker(f.label, selection: binding) {
                Text("None").tag("")
                ForEach(options, id: \.self) { Text($0).tag($0) }
            }
        } else {
            // Labelled beside the value: in a form, a text field's own label
            // is hidden, and a row of placeholders says nothing once typed in.
            LabeledContent(f.label) {
                TextField(f.label, text: binding,
                          prompt: Text(f.type == "date" ? "YYYY-MM-DD" : f.type == "multiselect" ? "With commas" : "None"))
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .keyboardType(f.type == "date" ? .numbersAndPunctuation : .default)
            }
        }
    }

    private func save() {
        var metadata: [String: MetadataValue?] = [:]
        for f in session.metadataFields {
            let v = (values[f.key] ?? "").trimmingCharacters(in: .whitespaces)
            if f.type == "multiselect" {
                let list = v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                metadata[f.key] = list.isEmpty ? .some(nil) : .some(.many(list))
            } else {
                metadata[f.key] = v.isEmpty ? .some(nil) : .some(.one(v))
            }
        }
        let list = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        saving = true
        problem = nil
        Task {
            let words = await session.setFolderMeta(in: place, folder: node.folder, tags: list, metadata: metadata)
            saving = false
            if let words { problem = words } else { dismiss(); onSaved() }
        }
    }
}
