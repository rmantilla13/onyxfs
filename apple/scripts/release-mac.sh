#!/usr/bin/env bash
# Build, sign, notarize and publish a Mac release of Onyx.
#
#   scripts/release-mac.sh              → build/release/: Onyx.dmg, Onyx.zip, onyx-mac.json
#   scripts/release-mac.sh --publish    … and the GitHub release mac-v<VERSION>, which the
#                                         website's download button and every installed
#                                         copy's updater then find (lib/mac-release.js)
#
# The version is apple/VERSION (or ONYX_VERSION). Bump it for each release: an
# installed copy only offers an update to a newer version (or a newer build of
# the same one).
#
# Needs, once (apple/README.md, "Releasing"):
#   - a "Developer ID Application" certificate in your login keychain — found
#     automatically, or name it with ONYX_SIGN_IDENTITY
#   - notarization credentials saved under a keychain profile:
#       xcrun notarytool store-credentials onyx-notary --apple-id <you> --team-id <TEAMID>
#     (it asks for an app-specific password; the name is ONYX_NOTARY_PROFILE)
#   - for Finder drives: Developer ID provisioning profiles for io.onyxfs.app and
#     io.onyxfs.app.fileprovider with the group.io.onyxfs app group, as
#     ONYX_APP_PROFILE and ONYX_EXT_PROFILE. Without them the release still
#     works and updates itself; Finder is what waits.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLISH=0
[[ "${1:-}" == "--publish" ]] && PUBLISH=1

VERSION="${ONYX_VERSION:-$(tr -d '[:space:]' < VERSION)}"
BUILD_NUMBER="${ONYX_BUILD:-$(date -u +%Y%m%d%H%M)}"
NOTARY="${ONYX_NOTARY_PROFILE:-onyx-notary}"
REPO="${ONYX_RELEASES_REPO:-rmantilla13/onyxfs}"
TAG="mac-v$VERSION"

if [[ -z "${ONYX_SIGN_IDENTITY:-}" ]]; then
  ONYX_SIGN_IDENTITY="$(security find-identity -v -p codesigning | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)"
fi
if [[ -z "$ONYX_SIGN_IDENTITY" ]]; then
  echo "No \"Developer ID Application\" certificate in your keychain." >&2
  echo "Create one in Xcode → Settings → Accounts → Manage Certificates → + (apple/README.md)." >&2
  exit 1
fi
ONYX_TEAM_ID="${ONYX_TEAM_ID:-$(sed -nE 's/.*\(([A-Z0-9]{10})\)$/\1/p' <<<"$ONYX_SIGN_IDENTITY")}"
echo "Releasing Onyx $VERSION ($BUILD_NUMBER) signed by: $ONYX_SIGN_IDENTITY"

if [[ "$PUBLISH" == "1" ]] && gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "$TAG already exists on $REPO. Bump apple/VERSION first." >&2
  exit 1
fi

export ONYX_VERSION="$VERSION" ONYX_BUILD="$BUILD_NUMBER" ONYX_SIGN_IDENTITY ONYX_TEAM_ID
ONYX_UNIVERSAL=1 ONYX_TIMESTAMP=1 scripts/build-mac.sh

OUT=build/release
rm -rf "$OUT" && mkdir -p "$OUT"
APP=build/Onyx.app

notarize() {
  xcrun notarytool submit "$1" --keychain-profile "$NOTARY" --wait --timeout 30m
}

# The app: notarized as a zip, then the ticket stapled onto the app itself, so
# it opens offline the first time. The zip the updater downloads is re-made
# from the stapled app.
ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
notarize "$OUT/notarize.zip"
xcrun stapler staple "$APP"
rm "$OUT/notarize.zip"
ditto -c -k --keepParent "$APP" "$OUT/Onyx.zip"

# The disk image people download: the app and a link to Applications.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Onyx" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Onyx.dmg"
codesign --force --timestamp --sign "$ONYX_SIGN_IDENTITY" "$OUT/Onyx.dmg"
notarize "$OUT/Onyx.dmg"
xcrun stapler staple "$OUT/Onyx.dmg"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
size() { stat -f %z "$1"; }
NOTES="${ONYX_NOTES:-Onyx for Mac $VERSION.}"
cat > "$OUT/onyx-mac.json" <<JSON
{
  "version": "$VERSION",
  "build": "$BUILD_NUMBER",
  "minimumSystemVersion": "14.0",
  "publishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "notes": $(printf '%s' "$NOTES" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "zip": { "sha256": "$(sha "$OUT/Onyx.zip")", "size": $(size "$OUT/Onyx.zip") },
  "dmg": { "sha256": "$(sha "$OUT/Onyx.dmg")", "size": $(size "$OUT/Onyx.dmg") }
}
JSON

spctl --assess --type execute --verbose "$APP"
echo "Built and notarized: $OUT/Onyx.dmg, $OUT/Onyx.zip, $OUT/onyx-mac.json"

if [[ "$PUBLISH" == "1" ]]; then
  gh release create "$TAG" --repo "$REPO" --title "Onyx for Mac $VERSION" --notes "$NOTES" \
    "$OUT/Onyx.dmg" "$OUT/Onyx.zip" "$OUT/onyx-mac.json"
  echo "Published $TAG. The download button and installed copies pick it up within ten minutes."
fi
