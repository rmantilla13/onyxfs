#!/usr/bin/env bash
# Build Onyx.app from source with the Command Line Tools alone (no Xcode):
# the app, and rclone inside it for the Finder mounts.
#
#   scripts/build-mac.sh          unsigned: everything works on this Mac —
#                                 the window, sign-in, drives in Finder
#   ONYX_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
#   ONYX_TEAM_ID=TEAMID \
#   scripts/build-mac.sh          signed with your team (release-mac.sh does
#                                 this, then notarizes)
#
# With apple/.signing/Onyx.provisionprofile present (or ONYX_APP_PROFILE), a
# signed build also carries the app group from it. ONYX_FILE_PROVIDER=1 adds
# the File Provider extension (dormant: Finder uses streaming mounts now) and
# needs ONYX_EXT_PROFILE (or apple/.signing/OnyxFileProvider.provisionprofile).
#
# Output: apple/build/Onyx.app.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${CONFIG:-release}"
VERSION="${ONYX_VERSION:-$(tr -d '[:space:]' < VERSION)}"
BUILD_NUMBER="${ONYX_BUILD:-$(date +%Y%m%d%H%M)}"
OUT="${OUT:-build}"
APP="$OUT/Onyx.app"
EXT="$APP/Contents/PlugIns/OnyxFileProvider.appex"
WITH_EXT="${ONYX_FILE_PROVIDER:-0}"
# ONYX_DEV=1: "Onyx Dev" (io.onyxfs.app.dev), which keeps its own sign-in and
# settings, so testing a build never disturbs the real Onyx on this Mac.
BUNDLE_ID="io.onyxfs.app"; NAME="Onyx"
[[ "${ONYX_DEV:-0}" == "1" ]] && { BUNDLE_ID="io.onyxfs.app.dev"; NAME="Onyx Dev"; }
APP_PROFILE="${ONYX_APP_PROFILE:-$( [[ -f .signing/Onyx.provisionprofile ]] && echo .signing/Onyx.provisionprofile )}"
EXT_PROFILE="${ONYX_EXT_PROFILE:-$( [[ -f .signing/OnyxFileProvider.provisionprofile ]] && echo .signing/OnyxFileProvider.provisionprofile )}"

products=(OnyxMac)
[[ "$WITH_EXT" == "1" ]] && products+=(OnyxFileProvider)

# ONYX_UNIVERSAL=1: Apple silicon and Intel in one binary (releases do this).
if [[ "${ONYX_UNIVERSAL:-0}" == "1" ]]; then
  BIN="$(mktemp -d)"
  for arch in x86_64 arm64; do
    for p in "${products[@]}"; do swift build -c "$CONFIG" --triple "$arch-apple-macosx14.0" --product "$p"; done
    out="$(swift build -c "$CONFIG" --triple "$arch-apple-macosx14.0" --show-bin-path)"
    mkdir -p "$BIN/$arch"
    for p in "${products[@]}"; do cp "$out/$p" "$BIN/$arch/"; done
  done
  for p in "${products[@]}"; do lipo -create "$BIN/x86_64/$p" "$BIN/arm64/$p" -output "$BIN/$p"; done
else
  for p in "${products[@]}"; do swift build -c "$CONFIG" --product "$p"; done
  BIN="$(swift build -c "$CONFIG" --show-bin-path)"
fi

scripts/fetch-rclone.sh >/dev/null

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/OnyxMac" "$APP/Contents/MacOS/Onyx"
cp vendor/rclone "$APP/Contents/MacOS/rclone"
cp ../desktop/src-tauri/icons/icon.icns "$APP/Contents/Resources/AppIcon.icns"

# The Info.plists are XcodeGen's (project.yml), where Xcode fills in the
# $(VARIABLES) and the bundle keys. Here they are filled in by hand.
plist() { /usr/libexec/PlistBuddy -c "$2" "$1" >/dev/null; }
set_key() { plist "$1" "Delete :$2" 2>/dev/null || true; plist "$1" "Add :$2 $3 $4"; }

cp OnyxMac/Info.plist "$APP/Contents/Info.plist"
P="$APP/Contents/Info.plist"
set_key "$P" CFBundleIdentifier string "$BUNDLE_ID"
set_key "$P" CFBundleExecutable string Onyx
set_key "$P" CFBundleName string "$NAME"
set_key "$P" CFBundleDisplayName string "$NAME"
set_key "$P" CFBundlePackageType string APPL
set_key "$P" CFBundleShortVersionString string "$VERSION"
set_key "$P" CFBundleVersion string "$BUILD_NUMBER"
set_key "$P" CFBundleIconFile string AppIcon
set_key "$P" LSMinimumSystemVersion string 14.0
set_key "$P" LSApplicationCategoryType string public.app-category.productivity
set_key "$P" NSHighResolutionCapable bool true

if [[ "$WITH_EXT" == "1" ]]; then
  mkdir -p "$EXT/Contents/MacOS"
  cp "$BIN/OnyxFileProvider" "$EXT/Contents/MacOS/OnyxFileProvider"
  cp OnyxFileProvider/Info.plist "$EXT/Contents/Info.plist"
  P="$EXT/Contents/Info.plist"
  plist "$P" "Set :NSExtension:NSExtensionPrincipalClass OnyxFileProvider.FileProviderExtension"
  set_key "$P" CFBundleIdentifier string io.onyxfs.app.fileprovider
  set_key "$P" CFBundleExecutable string OnyxFileProvider
  set_key "$P" CFBundleName string OnyxFileProvider
  set_key "$P" CFBundleShortVersionString string "$VERSION"
  set_key "$P" CFBundleVersion string "$BUILD_NUMBER"
  set_key "$P" LSMinimumSystemVersion string 14.0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Entitlements with $(AppIdentifierPrefix) filled in, plus what Xcode adds on
# its own when signing with a profile: the App ID and team, which must match
# the embedded profile for the restricted entitlements to be honoured.
render() {
  sed "s/\$(AppIdentifierPrefix)/${ONYX_TEAM_ID:-}./g" "$1" > "$2"
  /usr/libexec/PlistBuddy -c "Add :com.apple.application-identifier string $ONYX_TEAM_ID.$3" "$2"
  /usr/libexec/PlistBuddy -c "Add :com.apple.developer.team-identifier string $ONYX_TEAM_ID" "$2"
}

# Minimal entitlements, for builds with no profile. An app extension must be
# sandboxed to load at all; the app is not (it replaces itself when it
# updates, and runs rclone). The app group is restricted: claimed without a
# profile granting it, macOS refuses to launch the app, so it is left off.
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

# Inside out: rclone, then the extension, then the app around them.
if [[ -n "${ONYX_SIGN_IDENTITY:-}" ]]; then
  : "${ONYX_TEAM_ID:?set ONYX_TEAM_ID with ONYX_SIGN_IDENTITY}"
  # Hardened runtime always (notarization requires it); a secure timestamp
  # for anything that will be notarized.
  SIGN=(codesign --force --options runtime --sign "$ONYX_SIGN_IDENTITY")
  [[ "${ONYX_TIMESTAMP:-0}" == "1" ]] && SIGN+=(--timestamp)
  "${SIGN[@]}" "$APP/Contents/MacOS/rclone"
  if [[ "$WITH_EXT" == "1" ]]; then
    if [[ -n "$EXT_PROFILE" ]]; then
      render OnyxFileProvider/OnyxFileProvider.entitlements "$WORK/ext.entitlements" io.onyxfs.app.fileprovider
      cp "$EXT_PROFILE" "$EXT/Contents/embedded.provisionprofile"
      "${SIGN[@]}" --entitlements "$WORK/ext.entitlements" "$EXT"
    else
      "${SIGN[@]}" --entitlements "$WORK/ext.min.entitlements" "$EXT"
    fi
  fi
  if [[ -n "$APP_PROFILE" ]]; then
    render OnyxMac/OnyxMac.entitlements "$WORK/app.entitlements" io.onyxfs.app
    cp "$APP_PROFILE" "$APP/Contents/embedded.provisionprofile"
    "${SIGN[@]}" --entitlements "$WORK/app.entitlements" "$APP"
    echo "Signed for team $ONYX_TEAM_ID, with its provisioning profile."
  else
    "${SIGN[@]}" --entitlements "$WORK/app.min.entitlements" "$APP"
    echo "Signed for team $ONYX_TEAM_ID (no provisioning profile)."
  fi
else
  codesign --force --sign - "$APP/Contents/MacOS/rclone"
  [[ "$WITH_EXT" == "1" ]] && codesign --force --entitlements "$WORK/ext.min.entitlements" --sign - "$EXT"
  codesign --force --sign - "$APP"
  echo "Unsigned build: for this Mac."
fi

codesign --verify --deep --strict "$APP"
echo "Built $APP ($VERSION, $BUILD_NUMBER)"
