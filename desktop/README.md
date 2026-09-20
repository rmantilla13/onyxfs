# Onyx — desktop

The desktop client for [Onyx](../README.md). Sign in, pick a filespace, mount it
as a drive.

Onyx web is the control plane: it authenticates you, says which filespaces you
may reach, and mints short-lived credentials scoped to one bucket prefix. This
app is a thin client that then talks **straight to S3** — the control plane never
sees a file's bytes.

## Running it

```bash
npm install
npm run tauri:dev
```

Point it at a non-production control plane by setting the `control_base` key in
its SQLite config (it defaults to `https://onyxfs.io`).

```bash
npm run tauri:build   # a local .app / .dmg — no signing key needed
```

Output lands in `src-tauri/target/<triple>/release/bundle/`.

## How it works

| Layer | Detail |
|---|---|
| Auth | Browser PKCE over the `onyxfs://` scheme, or a typed pairing code. The bearer token lives in the system keychain. |
| Filespaces | `GET /api/space/filespaces` lists what you may mount; `POST /api/space/sts` mints scoped credentials. |
| Mount | `rclone nfsmount` against macOS's built-in NFS client, at `~/Onyx`. No macFUSE, no reboot. Windows uses the classic mount path and needs [WinFSP](https://winfsp.dev/rel/). |
| Browsing | Direct S3 with the scoped credentials — works with nothing mounted. |
| Pinning | Click ⊕; "Sync Pins" downloads into the configurable cache directory. |
| Updates | Checked against GitHub Releases on launch and from Settings. Minisign-verified. |

Credentials expire (≤1h) and the app refreshes and remounts before they do. The
grant is re-checked server-side on every mint, so revoking someone's access cuts
off new mounts within one STS window rather than at token expiry.

## Before the first release

Two things are intentionally unset:

**1. The update signing key.** `tauri.conf.json` ships with `updater.active:
false` and an empty `pubkey`. ARMRA's key was removed rather than carried over —
verifying updates against a keypair you do not hold the private half of would
reject every release you ship.

```bash
npm run tauri signer generate -- -w ~/.tauri/onyx.key
```

Put the public key in `tauri.conf.json`, keep the private key and its password
in CI secrets, then flip `active` to `true`.

**2. The rclone sidecar.** `src-tauri/binaries/` is gitignored. Place the rclone
binary for each target there, named with the target triple
(`rclone-aarch64-apple-darwin`, etc.) before bundling. `scripts/` has the helper.

## End-user prerequisites

macOS: none. rclone ships inside the app and mounting uses the built-in NFS
client. The only first-run step is Gatekeeper — right-click the app and choose
Open once, while it is unsigned.

See [INTEGRATION-SETUP.md](INTEGRATION-SETUP.md) for the AWS IAM, release repo
and signing-key setup.
