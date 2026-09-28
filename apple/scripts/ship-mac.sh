#!/usr/bin/env bash
# Ship a new Onyx for Mac, in one command.
#
#   apple/scripts/ship-mac.sh                 the next version (0.5.7 → 0.5.8), built from origin/main
#   apple/scripts/ship-mac.sh 0.6.0           that version instead
#   apple/scripts/ship-mac.sh --from <ref>    from a branch, tag or commit on GitHub instead of main
#   apple/scripts/ship-mac.sh --dry-run       say what would ship, and stop
#   apple/scripts/ship-mac.sh --notes "…"     the update window's notes; otherwise drafted from the
#                                             commits and opened in $EDITOR
#   apple/scripts/ship-mac.sh --no-publish    stop once the notarized build is ready
#   apple/scripts/ship-mac.sh --yes           publish without stopping to ask
#
# (Or npm run ship:mac -- <the same>.)
#
# release-mac.sh builds, signs and notarizes. This is what goes around it,
# which is where shipping went wrong:
#
#   - What ships is what is on GitHub, never this checkout's files: a fresh
#     worktree of the commit under $TMPDIR, removed afterwards. Nothing
#     uncommitted goes out, and no checkout's build/Onyx.app — a copy someone
#     may be running, whose drives FSKit then drops — is replaced.
#   - Nothing already shipped is lost. The commit must contain the last
#     release's, and its apple/VERSION must not be older than it: 0.5.7 was
#     built from a branch main did not have, and a 0.5.8 from main would
#     quietly have undone it.
#   - The tag is the commit that was built. `gh release create` without a
#     target tags whatever the default branch is at that moment, which is
#     how mac-v0.5.6 and mac-v0.5.7 came to point at main.
#   - What a release needs is checked before the long part: gh, the
#     Developer ID certificate, the provisioning profiles and when they
#     expire, the notary profile, and the screen (notarytool cannot reach
#     its keychain item while it is locked).
#   - It stops to ask before publishing, with the notarized dmg ready to
#     install and try. Publishing is what every installed copy updates to.
set -euo pipefail

REPO="${ONYX_RELEASES_REPO:-rmantilla13/onyxfs}"
NOTARY="${ONYX_NOTARY_PROFILE:-onyx-notary}"

VERSION=""
FROM="main"
NOTES=""
DRY=0
PUBLISH=1
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:?--from needs a branch, tag or commit}"; shift 2 ;;
    --notes) NOTES="${2:?--notes needs the text}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-publish) PUBLISH=0; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
    *) VERSION="$1"; shift ;;
  esac
done

bold() { if [ -t 1 ]; then printf '\033[1m%s\033[0m\n' "$*"; else printf '%s\n' "$*"; fi; }
ok() { printf '  ✓ %s\n' "$*"; }
die() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

# The checkout this runs from, and the repository's main checkout: where the
# gitignored signing profiles and the fetched rclone live.
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"
first_dir() { for d in "$@"; do if [ -d "$d" ]; then echo "$d"; return; fi; done; }
SIGNING="$(first_dir "$ROOT/apple/.signing" "$MAIN/apple/.signing")"
RCLONE="$(first_dir "$ROOT/apple/vendor" "$MAIN/apple/vendor")"

valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
# Whether $1 is newer than $2 (x.y.z).
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

bold "Shipping Onyx for Mac"

# ── 1. What a release needs ─────────────────────────────────────────────────
problems=()
command -v gh >/dev/null 2>&1 || problems+=("gh, the GitHub CLI, is not installed: brew install gh")
if command -v gh >/dev/null 2>&1 && ! gh auth status >/dev/null 2>&1; then
  problems+=("gh is not signed in: gh auth login")
fi
IDENTITY="${ONYX_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)}"
[ -n "$IDENTITY" ] || problems+=("No \"Developer ID Application\" certificate in the keychain (apple/README.md, Releasing).")
# The app and its FSKit extension: without the extension's profile, drives
# fall back to ~/Onyx, read-only — never a release.
now="$(date -u +%s)"
for profile in Onyx OnyxFS; do
  file="${SIGNING:+$SIGNING/}$profile.provisionprofile"
  if [ -z "$SIGNING" ] || [ ! -f "$file" ]; then
    problems+=("No $profile.provisionprofile in apple/.signing (apple/README.md, Releasing).")
    continue
  fi
  expires="$(security cms -D -i "$file" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null || true)"
  if [ -n "$expires" ]; then
    at="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$expires" +%s 2>/dev/null || echo 0)"
    if [ "$at" -le "$now" ]; then
      problems+=("$profile.provisionprofile expired on ${expires%%T*}: download a new one (developer.apple.com → Profiles).")
    elif [ $((at - now)) -lt $((14 * 86400)) ]; then
      echo "  ! $profile.provisionprofile expires on ${expires%%T*}: renew it soon."
    fi
  fi
done
if ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked | grep -q '<true/>'; then
  problems+=("The screen is locked: notarytool cannot reach its keychain item until it is unlocked.")
elif ! xcrun notarytool history --keychain-profile "$NOTARY" >/dev/null 2>&1; then
  problems+=("The notary profile \"$NOTARY\" cannot be used (missing, or no network): xcrun notarytool store-credentials $NOTARY --apple-id <you> --team-id <TEAMID>")
fi
if [ ${#problems[@]} -gt 0 ]; then
  for p in "${problems[@]}"; do printf '  ✗ %s\n' "$p" >&2; done
  echo >&2
  exit 1
fi
ok "signing as $IDENTITY"

# ── 2. What ships ───────────────────────────────────────────────────────────
git -C "$ROOT" fetch --quiet --tags --force origin
# A branch name means the one on GitHub, not a copy here that may be behind.
REF="$FROM"
if git -C "$ROOT" rev-parse --verify --quiet "origin/$FROM^{commit}" >/dev/null; then REF="origin/$FROM"; fi
COMMIT="$(git -C "$ROOT" rev-parse --verify --quiet "$REF^{commit}")" || die "No branch, tag or commit \"$FROM\"."
if ! git -C "$ROOT" branch -r --contains "$COMMIT" | grep -q . && ! git -C "$ROOT" tag --contains "$COMMIT" | grep -q .; then
  die "${COMMIT:0:7} is not on GitHub. Push it first: what ships is what anyone can see."
fi
SUBJECT="$(git -C "$ROOT" log -1 --format=%s "$COMMIT")"

LAST="$(gh release list --repo "$REPO" --limit 200 --json tagName,isDraft --jq '.[] | select(.isDraft | not) | .tagName' \
  | sed -n 's/^mac-v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -V | tail -1)"
if [ -z "$VERSION" ]; then
  [ -n "$LAST" ] || die "No release yet to count on from: give the version (ship-mac.sh 0.1.0)."
  IFS=. read -r major minor patch <<< "$LAST"
  VERSION="$major.$minor.$((patch + 1))"
fi
valid_version "$VERSION" || die "\"$VERSION\" is not a version: three numbers, as 0.5.8."
if [ -n "$LAST" ] && ! newer "$VERSION" "$LAST"; then
  die "$VERSION is not newer than $LAST, which is out already. An installed copy only takes a newer version."
fi
TAG="mac-v$VERSION"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then die "$TAG exists already."; fi

# Nothing shipped is lost.
if [ -n "$LAST" ]; then
  SOURCE_VERSION="$(git -C "$ROOT" cat-file -p "$COMMIT:apple/VERSION" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$SOURCE_VERSION" ] && newer "$LAST" "$SOURCE_VERSION"; then
    die "$REF says it is $SOURCE_VERSION (apple/VERSION), but $LAST is out already: $LAST's changes are not in it. Merge the branch $LAST was built from, or ship from one that has it (--from)."
  fi
  LAST_COMMIT="$(git -C "$ROOT" rev-list -n1 "mac-v$LAST" 2>/dev/null || true)"
  if [ -n "$LAST_COMMIT" ] && ! git -C "$ROOT" merge-base --is-ancestor "$LAST_COMMIT" "$COMMIT"; then
    die "$REF does not contain $LAST (tagged ${LAST_COMMIT:0:7}). Merge it in first, or ship from a branch that has it (--from)."
  fi
fi

# The notes: given, or drafted from what changed in apple/ since the last
# release, to edit.
if [ -z "$NOTES" ]; then
  RANGE="$COMMIT"
  if [ -n "${LAST_COMMIT:-}" ]; then RANGE="$LAST_COMMIT..$COMMIT"; fi
  DRAFT="$(git -C "$ROOT" log --no-merges --format='- %s' "$RANGE" -- apple/ | head -20)"
  [ -n "$DRAFT" ] || DRAFT="- Onyx for Mac $VERSION."
  if [ "$DRY" = 0 ] && [ -t 0 ] && [ -t 1 ]; then
    NOTES_FILE="$(mktemp -t onyx-notes)"
    {
      echo "# What's new in Onyx $VERSION, shown in the update window and on the release."
      echo "# Lines starting with # are left out. Save and close to go on; empty it to stop."
      echo "$DRAFT"
    } > "$NOTES_FILE"
    ${VISUAL:-${EDITOR:-nano}} "$NOTES_FILE"
    NOTES="$(grep -v '^#' "$NOTES_FILE" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' || true)"
    rm -f "$NOTES_FILE"
    [ -n "$(printf '%s' "$NOTES" | tr -d '[:space:]')" ] || die "No notes: nothing shipped."
  else
    NOTES="$DRAFT"
  fi
fi

echo
bold "Onyx for Mac $VERSION"
echo "  from     $REF at ${COMMIT:0:7}  $SUBJECT"
[ -n "$LAST" ] && echo "  after    $LAST, which it contains"
echo "  notes"
printf '%s\n' "$NOTES" | sed 's/^/           /'
echo
if [ "$DRY" = 1 ]; then echo "  (dry run: nothing built)"; exit 0; fi

# ── 3. Build, sign, notarize ────────────────────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/onyx-ship.XXXXXX")"
cleanup() {
  # The link first, on its own: nothing that removes the worktree may reach
  # through it to the profiles it points at.
  rm -f "$WORK/src/apple/.signing"
  git -C "$ROOT" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
git -C "$ROOT" worktree add --quiet --detach "$WORK/src" "$COMMIT"
ln -s "$SIGNING" "$WORK/src/apple/.signing"
# rclone as fetched before, if it is the version this commit pins (its
# stamp says so); otherwise fetch-rclone.sh fetches and checks it again.
if [ -n "$RCLONE" ] && [ -x "$RCLONE/rclone" ]; then
  mkdir -p "$WORK/src/apple/vendor"
  cp -c "$RCLONE/rclone" "$WORK/src/apple/vendor/rclone" 2>/dev/null || cp "$RCLONE/rclone" "$WORK/src/apple/vendor/rclone"
  cp "$RCLONE"/.rclone-* "$WORK/src/apple/vendor/" 2>/dev/null || true
fi
echo "Building in $WORK/src (about ten minutes: two architectures, then Apple's notary, twice)…"
( cd "$WORK/src/apple" && ONYX_VERSION="$VERSION" ONYX_NOTES="$NOTES" ONYX_SIGN_IDENTITY="$IDENTITY" scripts/release-mac.sh )

OUT="$ROOT/apple/build/ship/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"
cp -R "$WORK/src/apple/build/release/." "$OUT/"
echo
ok "built and notarized: $OUT/Onyx.dmg"

# ── 4. Publish ──────────────────────────────────────────────────────────────
if [ "$PUBLISH" = 0 ]; then
  echo "  Not published (--no-publish). To publish this build later:"
  echo "    gh release create $TAG --repo $REPO --target $COMMIT --title \"Onyx for Mac $VERSION\" \\"
  echo "      --notes-file <notes> \"$OUT/Onyx.dmg\" \"$OUT/Onyx.zip\" \"$OUT/onyx-mac.json\""
  exit 0
fi
if [ "$YES" = 0 ]; then
  [ -t 0 ] || die "No terminal to ask in: pass --yes to publish, or --no-publish."
  echo
  printf 'Publish Onyx %s to everyone? Install %s first to try it, if you like. [y/N] ' "$VERSION" "$OUT/Onyx.dmg"
  read -r answer
  case "$answer" in [yY]*) ;; *) echo "Not published. The build stays in $OUT."; exit 0 ;; esac
fi
gh release create "$TAG" --repo "$REPO" --target "$COMMIT" --title "Onyx for Mac $VERSION" --notes "$NOTES" \
  "$OUT/Onyx.dmg" "$OUT/Onyx.zip" "$OUT/onyx-mac.json" >/dev/null
echo
ok "published $TAG at ${COMMIT:0:7}: https://github.com/$REPO/releases/tag/$TAG"
echo "  The download button and every installed copy find it within ten minutes."
