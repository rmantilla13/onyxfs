import SwiftUI
import OnyxKit
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif
#if canImport(UIKit)
import UIKit
#endif

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if model.isSignedIn { library } else { signedOut }
            }
            .navigationTitle("Onyx")
            .toolbar {
                if model.isSignedIn {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Sign out") { Task { await model.signOut() } }
                    }
                }
            }
        }
        .task { if model.isSignedIn { await model.refresh() } }
    }

    private var signedOut: some View {
        ContentUnavailableView {
            Label("Onyx", systemImage: "externaldrive.connected.to.line.below")
        } description: {
            Text("Sign in to browse your library. Your files also appear in the Files app.")
        } actions: {
            Button("Sign in") {
                Task { await model.signIn(anchor: anchor()) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy)
        }
    }

    private var library: some View {
        List(model.files) { file in
            HStack(spacing: 12) {
                Image(systemName: icon(for: file.kind))
                    .foregroundStyle(.secondary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name).lineLimit(1)
                    Text(subtitle(for: file)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await model.refresh() }
        .overlay {
            if model.files.isEmpty && !model.busy {
                ContentUnavailableView("Nothing here yet", systemImage: "tray")
            }
        }
    }

    private func subtitle(for file: FileItem) -> String {
        var parts: [String] = []
        if !file.folder.isEmpty { parts.append(file.folder) }
        if let size = file.size {
            parts.append(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
        }
        return parts.joined(separator: " · ")
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "video": return "film"
        case "image": return "photo"
        case "audio": return "waveform"
        case "doc":   return "doc.text"
        default:      return "doc"
        }
    }

    private func anchor() -> ASPresentationAnchor {
        // The key window. ASWebAuthenticationSession needs something to
        // present from and will not start without it.
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?
            .keyWindow ?? ASPresentationAnchor()
    }
}
