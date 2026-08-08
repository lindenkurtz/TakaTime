#!/usr/bin/env bash
# Build the TakaTime Go binaries for THIS machine and install them where the
# VS Code extension looks for them.
#
# Why this exists: Plugin/BinaryDownload.js fetches releases from the UPSTREAM
# repo (Rtarun3606k/TakaTime), which will never publish this fork's versions.
# Anything past v2.2.x has to be built locally.
#
# Usage: ./scripts/build-binaries.sh
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(sed -n 's/.*Version string = "\(.*\)".*/\1/p' internal/types/version.go)"
if [[ -z "$VERSION" ]]; then
  echo "Could not read version from internal/types/version.go" >&2
  exit 1
fi

BIN_DIR="$HOME/.takatime/bin"
mkdir -p "$BIN_DIR"

echo "Building TakaTime $VERSION -> $BIN_DIR"

for target in upload dashboard; do
  out="$BIN_DIR/taka-$target-$VERSION"
  echo "  taka-$target"
  go build -o "$out" "./cmd/$target"
  chmod +x "$out"
done

echo ""
echo "Installed:"
ls -1 "$BIN_DIR" | sed 's/^/  /'
echo ""
echo "Verify:  $BIN_DIR/taka-upload-$VERSION -version"
echo ""
echo "The extension's Plugin/Config.js CURRENT_VERSION must equal $VERSION,"
echo "otherwise it will look for a binary that is not there and silently skip uploads."
