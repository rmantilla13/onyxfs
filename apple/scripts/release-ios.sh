#!/usr/bin/env bash
# Build Onyx for iPhone and iPad, and send it to TestFlight.
#
#   scripts/release-ios.sh             → build/ios/Onyx.xcarchive, built and checked;
#                                         nothing leaves this Mac
#   scripts/release-ios.sh --upload    … then signed for the App Store and uploaded to
#                                         App Store Connect. TestFlight has it once Apple
#                                         has processed it, usually within minutes.
#
# The version is MARKETING_VERSION in project.yml (or ONYX_IOS_VERSION). The build
# number is the date and time, UTC (or ONYX_IOS_BUILD), so each upload is newer
# than the last.
#
# Needs, once (apple/README.md, "TestFlight"):
#   - Xcode, signed in to the developer account (Xcode → Settings → Accounts). It
#     makes the Apple Distribution certificate and the App Store profile itself.
#     Or an App Store Connect API key instead: ONYX_ASC_KEY_ID and
#     ONYX_ASC_ISSUER_ID, with the key at
#     ~/.appstoreconnect/private_keys/AuthKey_<ONYX_ASC_KEY_ID>.p8 (or ONYX_ASC_KEY_PATH)
#   - the app in App Store Connect, for the bundle ID io.onyxfs.app
#   - brew install xcodegen
set -euo pipefail
cd "$(dirname "$0")/.."

UPLOAD=0
[[ "${1:-}" == "--upload" ]] && UPLOAD=1

# Xcode, not just the command-line tools: the iOS SDK comes with it.
if ! xcodebuild -version >/dev/null 2>&1; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
  if ! xcodebuild -version >/dev/null 2>&1; then
    echo "Needs Xcode, not just the command-line tools (or DEVELOPER_DIR set to it)." >&2
    exit 1
  fi
fi

if [[ -z "${ONYX_TEAM_ID:-}" ]]; then
  # The team the Mac release is signed by.
  ONYX_TEAM_ID="$(security find-identity -v -p codesigning | sed -nE 's/.*\(([A-Z0-9]{10})\)"$/\1/p' | head -1)"
fi
if [[ -z "$ONYX_TEAM_ID" ]]; then
  echo "Set ONYX_TEAM_ID to your developer team's ID (developer.apple.com → Membership)." >&2
  exit 1
fi

# Date, then time: a later build compares greater, part by part.
NOW="$(date -u +%Y%m%d%H%M)"
BUILD_NUMBER="${ONYX_IOS_BUILD:-${NOW:0:8}.$((10#${NOW:8:4}))}"

OUT=build/ios
ARCHIVE="$OUT/Onyx.xcarchive"
APP="$ARCHIVE/Products/Applications/Onyx.app"
rm -rf "$OUT" && mkdir -p "$OUT"

ONYX_TEAM_ID="$ONYX_TEAM_ID" xcodegen generate --quiet

# Built unsigned. Xcode would sign an archive for development, and a
# development profile for an iPhone app needs an iPhone registered to the
# team; the App Store signature is the export's to make, below.
xcodebuild archive -quiet -project Onyx.xcodeproj -scheme OnyxIOS -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$OUT/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  ${ONYX_IOS_VERSION:+MARKETING_VERSION="$ONYX_IOS_VERSION"}

# Then signed here, ad hoc, to carry the entitlements: the export signs for
# the App Store with the entitlements it finds on the archive, and an unsigned
# one has none. The app would lose its app group, and with it the sign-in it
# is to share with the Files extension.
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")"
ENTITLEMENTS="$OUT/Onyx.entitlements"
sed "s/[$](AppIdentifierPrefix)/$ONYX_TEAM_ID./g" OnyxIOS/OnyxIOS.entitlements > "$ENTITLEMENTS"
/usr/libexec/PlistBuddy -c "Add :application-identifier string $ONYX_TEAM_ID.$BUNDLE_ID" \
  -c "Add :com.apple.developer.team-identifier string $ONYX_TEAM_ID" "$ENTITLEMENTS" >/dev/null
codesign --force --sign - --entitlements "$ENTITLEMENTS" --generate-entitlement-der "$APP"

# What App Store Connect would otherwise turn away after the upload.
if ! plutil -lint -s "$APP/PrivacyInfo.xcprivacy"; then
  echo "The app has no valid privacy manifest (OnyxIOS/PrivacyInfo.xcprivacy)." >&2
  exit 1
fi
if ! codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q "group.io.onyxfs"; then
  echo "The archive is not signed with the app group." >&2
  exit 1
fi
echo "Built Onyx $VERSION ($BUILD_NUMBER) for iOS: $ARCHIVE"

if [[ "$UPLOAD" != "1" ]]; then
  echo "Nothing was sent. scripts/release-ios.sh --upload sends a build to TestFlight."
  exit 0
fi

AUTH=()
if [[ -n "${ONYX_ASC_KEY_ID:-}" ]]; then
  KEY="${ONYX_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$ONYX_ASC_KEY_ID.p8}"
  if [[ ! -f "$KEY" || -z "${ONYX_ASC_ISSUER_ID:-}" ]]; then
    echo "ONYX_ASC_KEY_ID needs ONYX_ASC_ISSUER_ID too, and the key at $KEY." >&2
    exit 1
  fi
  AUTH=(-authenticationKeyPath "$KEY" -authenticationKeyID "$ONYX_ASC_KEY_ID"
        -authenticationKeyIssuerID "$ONYX_ASC_ISSUER_ID")
fi

# The build number is ours (above), not Xcode's to change on the way up.
cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$ONYX_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF

# Signs for the App Store, making the certificate and profile the first time,
# and uploads.
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT/export" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -allowProvisioningUpdates ${AUTH[@]+"${AUTH[@]}"}

echo "Uploaded Onyx $VERSION ($BUILD_NUMBER). It shows in App Store Connect → TestFlight once processed."
