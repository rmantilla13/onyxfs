#!/usr/bin/env bash
# Onyx — Dependency Installer
#
# Good news: there's nothing to install anymore.
#   • rclone ships INSIDE Onyx (official build, bundled).
#   • Mounting uses macOS's built-in NFS client — macFUSE and its
#     system-extension approval are no longer needed (since v0.1.5).
#
# This script is kept only so old instructions that reference it don't break.

set -euo pipefail
BOLD='\033[1m'; GREEN='\033[0;32m'; RESET='\033[0m'

clear
echo -e "${BOLD}Onyx${RESET}"
echo ""
echo -e "  ${GREEN}✓${RESET} Nothing to install — Onyx is self-contained."
echo ""
echo "  Just drag Onyx.app to Applications and launch it."
echo "  (First launch: right-click the app → Open, since it isn't notarized yet.)"
echo ""
read -n1 -r -p "Press any key to close… " _ || true
