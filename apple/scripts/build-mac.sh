#!/usr/bin/env bash
# Build Onyx.app — the Mac app with its Finder extension inside — from source,
# with the Command Line Tools alone (no Xcode).
#
#   scripts/build-mac.sh                 unsigned: the window, sign-in, the
#                                        whole workspace. Finder drives need
#                                        a team-signed build (below).
#   ONYX_TEAM_ID=ABCDE12345 \
#   ONYX_SIGN_IDENTITY="Apple Development: you@example.com (ABCDE12345)" \
#   ONYX_APP_PROFILE=~/profiles/Onyx.provisionprofile \
#   ONYX_EXT_PROFILE=~/profiles/OnyxFileProvider.provisionprofile \
#   scripts/build-mac.sh                 signed with your team: Finder too.
#
# Output: apple/build/Onyx.app. Open it, or copy it to /Applications (File
# Provider extensions are most reliable from there).
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${CONFIG:-release}"
VERSION="${ONYX_VERSION:-$(tr -d '[:space:]' < VERSION)}"
BUILD_NUMBER="${ONYX_BUILD:-$(date +%Y%m%d%H%M)}"
OUT="${OUT:-build}"
APP="$OUT/Onyx.app"
EXT="$APP/Contents/PlugIns/OnyxFileProvider.appex"

# ONYX_UNIVERSAL=1: Apple silicon and Intel in one binary (releases do this).
if [[ "${ONYX_UNIVERSAL:-0}" == "1" ]]; then
  BIN="$(mktemp -d)"
  for arch in x86_64 arm64; do
    swift build -c "$CONFIG" --triple "$arch-apple-macosx14.0" --product OnyxMac
    swift build -c "$CONFIG" --triple "$arch-apple-macosx14.0" --product OnyxFileProvider
    out="$(swift build -c "$CONFIG" --triple "$arch-apple-macosx14.0" --show-bin-path)"
    mkdir -p "$BIN/$arch"
    cp "$out/OnyxMac" "$out/OnyxFileProvider" "$BIN/$arch/"
  done
  for exe in OnyxMac OnyxFileProvider; do
    lipo -create "$BIN/x86_64/$exe" "$BIN/arm64/$exe" -output "$BIN/$exe"
  done
else
  swift build -c "$CONFIG" --product OnyxMac
  swift build -c "$CONFIG" --product OnyxFileProvider
  BIN="$(swift build -c "$CONFIG" --show-bin-path)"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$EXT/Contents/MacOS"
cp "$BIN/OnyxMac" "$APP/Contents/MacOS/Onyx"
cp "$BIN/OnyxFileProvider" "$EXT/Contents/MacOS/OnyxFileProvider"
cp ../desktop/src-tauri/icons/icon.icns "$APP/Contents/Resources/AppIcon.icns"

# The Info.plists are XcodeGen's (project.yml), where Xcode fills in the
# $(VARIABLES) and the bundle keys. Here they are filled in by hand.
plist() { /usr/libexec/PlistBuddy -c "$2" "$1" >/dev/null; }
set_key() { plist "$1" "Delete :$2" 2>/dev/null || true; plist "$1" "Add :$2 $3 $4"; }

cp OnyxMac/Info.plist "$APP/Contents/Info.plist"
P="$APP/Contents/Info.plist"
set_key "$P" CFBundleIdentifier string io.onyxfs.app
set_key "$P" CFBundleExecutable string Onyx
set_key "$P" CFBundleName string Onyx
set_key "$P" CFBundlePackageType string APPL
set_key "$P" CFBundleShortVersionString string "$VERSION"
set_key "$P" CFBundleVersion string "$BUILD_NUMBER"
set_key "$P" CFBundleIconFile string AppIcon
set_key "$P" LSMinimumSystemVersion string 14.0
set_key "$P" LSApplicationCategoryType string public.app-category.productivity
set_key "$P" NSHighResolutionCapable bool true

cp OnyxFileProvider/Info.plist "$EXT/Contents/Info.plist"
P="$EXT/Contents/Info.plist"
plist "$P" "Set :NSExtension:NSExtensionPrincipalClass OnyxFileProvider.FileProviderExtension"
set_key "$P" CFBundleIdentifier string io.onyxfs.app.fileprovider
set_key "$P" CFBundleExecutable string OnyxFileProvider
set_key "$P" CFBundleName string OnyxFileProvider
set_key "$P" CFBundleShortVersionString string "$VERSION"
set_key "$P" CFBundleVersion string "$BUILD_NUMBER"
set_key "$P" LSMinimumSystemVersion string 14.0

# Entitlements: $(AppIdentifierPrefix) is the team id and a dot.
render() { sed "s/\$(AppIdentifierPrefix)/${ONYX_TEAM_ID:-}./g" "$1" > "$2"; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Minimal entitlements: what a build gets when nothing grants it the app group.
# An app extension must be sandboxed to load at all; the app is not (it
# replaces itself when it updates). The app group and the keychain group are
# restricted: signed without a provisioning profile that grants them, macOS
# refuses to launch the app at all — so without profiles they are left off,
# and the app runs without Finder (it says so in Settings).
cat > "$WORK/ext.min.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.network.client</key><true/>
</dict></plist>
PLIST
cat > "$WORK/app.min.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.network.client</key><true/>
</dict></plist>
PLIST

if [[ -n "${ONYX_SIGN_IDENTITY:-}" ]]; then
  : "${ONYX_TEAM_ID:?set ONYX_TEAM_ID with ONYX_SIGN_IDENTITY}"
  # Hardened runtime always (notarization requires it); a secure timestamp
  # for anything that will be notarized.
  SIGN=(codesign --force --options runtime --sign "$ONYX_SIGN_IDENTITY")
  [[ "${ONYX_TIMESTAMP:-0}" == "1" ]] && SIGN+=(--timestamp)
  if [[ -n "${ONYX_APP_PROFILE:-}" && -n "${ONYX_EXT_PROFILE:-}" ]]; then
    render OnyxFileProvider/OnyxFileProvider.entitlements "$WORK/ext.entitlements"
    render OnyxMac/OnyxMac.entitlements "$WORK/app.entitlements"
    cp "$ONYX_EXT_PROFILE" "$EXT/Contents/embedded.provisionprofile"
    cp "$ONYX_APP_PROFILE" "$APP/Contents/embedded.provisionprofile"
    "${SIGN[@]}" --entitlements "$WORK/ext.entitlements" "$EXT"
    "${SIGN[@]}" --entitlements "$WORK/app.entitlements" "$APP"
    echo "Signed for team $ONYX_TEAM_ID, with the app group: Finder drives are available."
  else
    "${SIGN[@]}" --entitlements "$WORK/ext.min.entitlements" "$EXT"
    "${SIGN[@]}" --entitlements "$WORK/app.min.entitlements" "$APP"
    echo "Signed for team $ONYX_TEAM_ID without provisioning profiles: the app runs and updates itself;"
    echo "Finder drives need ONYX_APP_PROFILE and ONYX_EXT_PROFILE (apple/README.md)."
  fi
else
  codesign --force --entitlements "$WORK/ext.min.entitlements" --sign - "$EXT"
  codesign --force --sign - "$APP"
  echo "Unsigned build: the window works; Finder drives need ONYX_SIGN_IDENTITY (see apple/README.md)."
fi

codesign --verify --deep --strict "$APP"
echo "Built $APP ($VERSION, $BUILD_NUMBER)"
