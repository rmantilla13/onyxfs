import AuthenticationServices
import OnyxKit
import SwiftUI

/// Signing in: the web's own sign-in in a sheet, or a pairing code made on
/// the web — the two ways the Mac app signs in. The server is production
/// unless someone points this install at their own.
struct SignInView: View {
    @Environment(Session.self) private var session
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var pairing = false
    @State private var choosingServer = false
    @State private var serverText = ""

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Mark(size: 96)
            Text("Onyx")
                .font(.system(size: 36, weight: .bold))
                .padding(.top, 28)
            Text("Your drives, on this \(Session.deviceLabel).")
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.top, 6)
            Spacer()
            VStack(spacing: 12) {
                Button {
                    session.signIn(with: webAuthenticationSession)
                } label: {
                    HStack(spacing: 8) {
                        if session.signingIn { ProgressView().tint(.white) }
                        Text("Sign In")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)

                Button {
                    session.problem = nil
                    pairing = true
                } label: {
                    Text("Use a Pairing Code")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)

                if let problem = session.problem, !pairing {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.top, 4)
                }
            }
            .controlSize(.large)
            .disabled(session.signingIn)

            Button {
                serverText = session.serverName
                choosingServer = true
            } label: {
                Text("Server: \(session.serverName)")
                    .font(.footnote)
            }
            .foregroundStyle(.secondary)
            .padding(.top, 24)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .frame(maxWidth: 440)
        .sheet(isPresented: $pairing) { PairingSheet() }
        .alert("Onyx Server", isPresented: $choosingServer) {
            TextField("www.onyxfs.io", text: $serverText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            Button("Use This Server") {
                if !session.setServer(serverText) { session.problem = "That isn't a server address." }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The address of the Onyx you sign in to.")
        }
    }
}

/// A code from the web's pairing page, for a phone whose browser is not
/// signed in to Onyx.
private struct PairingSheet: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Code", text: $code)
                        .font(.system(.title2, design: .monospaced))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.go)
                        .onSubmit(pair)
                } footer: {
                    Text("On a computer signed in to Onyx, open \(session.serverName)/space/pair and type the code it shows. It works once, within five minutes.")
                }
                if let problem = session.problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Pairing Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if session.signingIn {
                        ProgressView()
                    } else {
                        Button("Sign In", action: pair).disabled(cleaned.isEmpty)
                    }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private var cleaned: String { code.filter { $0.isLetter || $0.isNumber } }

    private func pair() {
        guard !cleaned.isEmpty else { return }
        Task { await session.pair(code: code) }
    }
}

/// The Onyx mark — the slash from the ONYX/FS wordmark on its near-black —
/// in the light the web's glow throws behind it.
struct Mark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(AngularGradient(colors: [.accentColor, Color("AuraMagenta"), Color("AuraCyan"), .accentColor],
                                      center: .center))
                .frame(width: size * 1.5, height: size * 1.5)
                .blur(radius: size * 0.42)
                .opacity(0.55)
            Image("Mark")
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
                .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
        }
        .accessibilityHidden(true)
    }
}
