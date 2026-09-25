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
VERSION="${ONYX_VERSION:-0.2.0}"
BUILD_NUMBER="${ONYX_BUILD:-$(date +%Y%m%d%H%M)}"
OUT="${OUT:-build}"
APP="$OUT/Onyx.app"
EXT="$APP/Contents/PlugIns/OnyxFileProvider.appex"

swift build -c "$CONFIG" --product OnyxMac
swift build -c "$CONFIG" --product OnyxFileProvider
BIN="$(swift build -c "$CONFIG" --show-bin-path)"

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

if [[ -n "${ONYX_SIGN_IDENTITY:-}" ]]; then
  : "${ONYX_TEAM_ID:?set ONYX_TEAM_ID with ONYX_SIGN_IDENTITY}"
  render OnyxFileProvider/OnyxFileProvider.entitlements "$WORK/ext.entitlements"
  render OnyxMac/OnyxMac.entitlements "$WORK/app.entitlements"
  [[ -n "${ONYX_EXT_PROFILE:-}" ]] && cp "$ONYX_EXT_PROFILE" "$EXT/Contents/embedded.provisionprofile"
  [[ -n "${ONYX_APP_PROFILE:-}" ]] && cp "$ONYX_APP_PROFILE" "$APP/Contents/embedded.provisionprofile"
  codesign --force --options runtime --entitlements "$WORK/ext.entitlements" --sign "$ONYX_SIGN_IDENTITY" "$EXT"
  codesign --force --options runtime --entitlements "$WORK/app.entitlements" --sign "$ONYX_SIGN_IDENTITY" "$APP"
  echo "Signed for team $ONYX_TEAM_ID."
else
  # Unsigned. An app extension must be sandboxed to load at all, so it gets
  # that much; neither gets the app group, which only a team can hold.
  cat > "$WORK/ext.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.network.client</key><true/>
</dict></plist>
PLIST
  codesign --force --entitlements "$WORK/ext.entitlements" --sign - "$EXT"
  codesign --force --sign - "$APP"
  echo "Unsigned build: the window works; Finder drives need ONYX_SIGN_IDENTITY (see apple/README.md)."
fi

codesign --verify --deep --strict "$APP"
echo "Built $APP ($VERSION, $BUILD_NUMBER)"
