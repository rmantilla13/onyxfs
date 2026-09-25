#!/usr/bin/env bash
# rclone, for the Finder mount: the official release for both Apple silicon and
# Intel, checked against checksums pinned here, joined into one universal
# binary at apple/vendor/rclone. build-mac.sh copies it into the app.
#
# Pinned on purpose. The mount depends on rclone's nfsmount and VFS cache
# behaving exactly as tested, and a checksum pinned in the repository (not
# fetched beside the download) means a changed file fails the build instead
# of shipping. To update: change VERSION and both hashes from
# https://downloads.rclone.org/<version>/SHA256SUMS, then test the mount.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="v1.74.3"
SHA_ARM64="33a435ab17023b686918ce9a3975aceb75fe1796c694f38f1993024be1f063f5"
SHA_AMD64="417cabd402d57806d597bd0ba8fb33a434ca8c2a1a5aa98de5a0bd4b52b39202"
OUT="vendor/rclone"
STAMP="vendor/.rclone-$VERSION"

if [[ -x "$OUT" && -f "$STAMP" ]]; then
  echo "rclone $VERSION already at $OUT"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for arch in arm64 amd64; do
  zip="rclone-$VERSION-osx-$arch.zip"
  curl -sSfL "https://downloads.rclone.org/$VERSION/$zip" -o "$WORK/$zip"
  want="SHA_$(tr '[:lower:]' '[:upper:]' <<<"$arch")"
  echo "${!want}  $WORK/$zip" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch for $zip" >&2; exit 1; }
  unzip -q "$WORK/$zip" -d "$WORK"
done

mkdir -p vendor
lipo -create "$WORK/rclone-$VERSION-osx-arm64/rclone" "$WORK/rclone-$VERSION-osx-amd64/rclone" -output "$OUT"
chmod +x "$OUT"
rm -f vendor/.rclone-*
touch "$STAMP"
echo "rclone $VERSION (universal) at $OUT"
