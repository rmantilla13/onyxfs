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
# The Onyx file system (onyxfs, apple/ONYXFS.md): each drive as a disk of its
# own, on macOS 27. An ExtensionKit extension, so Contents/Extensions.
# ONYX_ONYXFS=0 leaves it out.
FSX="$APP/Contents/Extensions/OnyxFS.appex"
WITH_FS="${ONYX_ONYXFS:-1}"
# ONYX_DEV=1: "Onyx Dev" (io.onyxfs.app.dev), which keeps its own sign-in and
# settings, so testing a build never disturbs the real Onyx on this Mac.
BUNDLE_ID="io.onyxfs.app"; NAME="Onyx"
[[ "${ONYX_DEV:-0}" == "1" ]] && { BUNDLE_ID="io.onyxfs.app.dev"; NAME="Onyx Dev"; }
# `|| true`: with no profile the test fails, and under `set -e` that failed
# assignment would end the script silently (a fresh clone has no .signing/).
# A dev build has App IDs of its own (io.onyxfs.app.dev and .dev.fs), so its
# own profiles: signing it with the real app's would name the wrong App ID,
# and macOS would refuse to launch it.
PROFILE_PREFIX="Onyx"; [[ "${ONYX_DEV:-0}" == "1" ]] && PROFILE_PREFIX="OnyxDev"
profile() { [[ -f ".signing/$1.provisionprofile" ]] && echo ".signing/$1.provisionprofile" || true; }
APP_PROFILE="${ONYX_APP_PROFILE:-$(profile "$PROFILE_PREFIX")}"
EXT_PROFILE="${ONYX_EXT_PROFILE:-$(profile OnyxFileProvider)}"
FS_PROFILE="${ONYX_FS_PROFILE:-$(profile "${PROFILE_PREFIX}FS")}"

products=(OnyxMac)
[[ "$WITH_EXT" == "1" ]] && products+=(OnyxFileProvider)
[[ "$WITH_FS" == "1" ]] && products+=(OnyxFS)

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

if [[ "$WITH_FS" == "1" ]]; then
  mkdir -p "$FSX/Contents/MacOS"
  cp "$BIN/OnyxFS" "$FSX/Contents/MacOS/OnyxFS"
  # SwiftPM stamps each binary with the package's minimum macOS as the SDK it
  # was built with (14.0), whatever SDK that really was. Frameworks read that
  # stamp to decide which behaviour a program was built for, and this one is
  # built for FSKit on macOS 27: it is stamped with what it is — this SDK, and
  # macOS 27, all it runs on. The app keeps SwiftPM's stamp: a newer SDK
  # would change how it looks.
  vtool -set-build-version macos 27.0 "$(xcrun --show-sdk-version)" -replace \
    -output "$FSX/Contents/MacOS/OnyxFS" "$FSX/Contents/MacOS/OnyxFS"
  cp OnyxFS/Info.plist "$FSX/Contents/Info.plist"
  P="$FSX/Contents/Info.plist"
  set_key "$P" CFBundleIdentifier string "$BUNDLE_ID.fs"
  set_key "$P" CFBundleName string "$NAME"
  set_key "$P" CFBundleDisplayName string "$NAME"
  set_key "$P" CFBundleShortVersionString string "$VERSION"
  set_key "$P" CFBundleVersion string "$BUILD_NUMBER"
  set_key "$P" LSMinimumSystemVersion string 27.0
  /usr/libexec/PlistBuddy -c "Delete :CFBundleSupportedPlatforms" "$P" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleSupportedPlatforms array" -c "Add :CFBundleSupportedPlatforms:0 string MacOSX" "$P"
  # A dev build's file system is a kind of its own, "onyxfsdev". Each app,
  # as it opens, unmounts the disks of its kind that an earlier run left —
  # under one name, a dev build opening would eject the real Onyx's drives —
  # and `mount -t onyxfs` could reach either copy. (FSKit does list two
  # modules of one name side by side; one missing from its list is
  # fskit_agent holding an earlier build, ONYXFS.md.)
  if [[ "${ONYX_DEV:-0}" == "1" ]]; then
    plist "$P" "Set :EXAppExtensionAttributes:FSShortName onyxfsdev"
    plist "$P" "Set :EXAppExtensionAttributes:FSPersonalities:Onyx:FSName Onyx Dev"
  fi
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Whether a provisioning profile grants an entitlement. A restricted one the
# profile does not grant stops the app from launching, so the app claims
# FSKit's mount entitlement only when its profile has it.
grants() { security cms -D -i "$1" 2>/dev/null | plutil -extract "Entitlements.$2" raw -o - - >/dev/null 2>&1; }

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
  if [[ "$WITH_FS" == "1" ]]; then
    if [[ -n "$FS_PROFILE" ]]; then
      render OnyxFS/OnyxFS.entitlements "$WORK/fs.entitlements" "$BUNDLE_ID.fs"
      cp "$FS_PROFILE" "$FSX/Contents/embedded.provisionprofile"
      "${SIGN[@]}" --entitlements "$WORK/fs.entitlements" "$FSX"
    else
      # No profile: it cannot run as a file system (FSKit needs the
      # restricted entitlement), and the app mounts drives the NFS way.
      "${SIGN[@]}" --entitlements "$WORK/ext.min.entitlements" "$FSX"
      echo "No ${PROFILE_PREFIX}FS provisioning profile: drives mount in ~/Onyx, not as disks."
    fi
  fi
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
    # A dev build claims no app group or shared keychain: they are the real
    # app's (and the dormant File Provider's), and Onyx Dev must not reach them.
    if [[ "${ONYX_DEV:-0}" == "1" ]]; then
      render "$WORK/app.min.entitlements" "$WORK/app.entitlements" "$BUNDLE_ID"
    else
      render OnyxMac/OnyxMac.entitlements "$WORK/app.entitlements" "$BUNDLE_ID"
    fi
    if grants "$APP_PROFILE" "com\\.apple\\.developer\\.fskit\\.mount"; then
      /usr/libexec/PlistBuddy -c "Add :com.apple.developer.fskit.mount bool true" "$WORK/app.entitlements"
    fi
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
  [[ "$WITH_FS" == "1" ]] && codesign --force --entitlements "$WORK/ext.min.entitlements" --sign - "$FSX"
  codesign --force --sign - "$APP"
  echo "Unsigned build: for this Mac."
fi

codesign --verify --deep --strict "$APP"
echo "Built $APP ($VERSION, $BUILD_NUMBER)"
