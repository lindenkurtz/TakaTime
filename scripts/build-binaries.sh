#!/usr/bin/env bash
# Build the TakaTime Go binaries for THIS machine and install them where the
# VS Code extension looks for them. Also installs the analytics bundle, which is
# what actually computes every statistic.
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

# ---------------------------------------------------------------------------
# Analytics bundle
# ---------------------------------------------------------------------------
# The stats server, the `taka` CLI and the VS Code panel all run from here. It is
# installed rather than run from the repo because the extension is a VSIX snapshot in
# ~/.vscode/extensions and has no idea where this checkout lives.
#
# Versionless on purpose: unlike the Go binaries, nothing looks this up by version,
# and duration.mjs is the single source of truth for the algorithm. Two copies at
# different versions is exactly the drift METHODOLOGY.md warns about.

ANALYTICS_DIR="$HOME/.takatime/analytics"

echo ""
echo "Installing analytics bundle -> $ANALYTICS_DIR"

if [[ ! -d analytics/node_modules ]]; then
  echo "  analytics/node_modules is missing; running npm install"
  (cd analytics && npm install --omit=dev)
fi

mkdir -p "$ANALYTICS_DIR/scripts"
cp analytics/duration.mjs analytics/summary.mjs analytics/source.mjs \
   analytics/server.mjs analytics/cli.mjs analytics/package.json "$ANALYTICS_DIR/"
cp analytics/scripts/_mongo.mjs "$ANALYTICS_DIR/scripts/"

# The driver is the only runtime dependency. rsync --delete keeps a re-install from
# accumulating packages that were removed upstream.
rsync -a --delete analytics/node_modules/ "$ANALYTICS_DIR/node_modules/"

cat > "$BIN_DIR/taka" <<'SHIM'
#!/usr/bin/env sh
# TakaTime CLI shim. Installed by scripts/build-binaries.sh.
exec node "$HOME/.takatime/analytics/cli.mjs" "$@"
SHIM
chmod +x "$BIN_DIR/taka"

# ---------------------------------------------------------------------------
# Claude Code tracker
# ---------------------------------------------------------------------------
# Installed under the SAME relative layout as the repo (trackers/claude-code next to
# analytics/), because import-claude.mjs imports ../../analytics/duration.mjs to read
# CONFIG_REGISTRY. Flattening the two directories would break that import, and copying
# the registry instead would create the second source of truth METHODOLOGY.md exists
# to prevent. Node also resolves the mongodb driver by walking up from _mongo.mjs, so
# the single node_modules under analytics/ serves both.

TRACKER_DIR="$HOME/.takatime/trackers/claude-code"

echo ""
echo "Installing Claude Code tracker -> $TRACKER_DIR"

mkdir -p "$TRACKER_DIR"
cp trackers/claude-code/import-claude.mjs trackers/claude-code/transcript.mjs "$TRACKER_DIR/"

cat > "$BIN_DIR/taka-claude-import" <<'SHIM'
#!/usr/bin/env sh
# Import Claude Code sessions as heartbeats. Installed by scripts/build-binaries.sh.
#
# Idempotent: safe to run on a timer, from a Claude Code Stop hook, or by hand.
# Runs with --apply because a hook that dry-runs would silently never record anything.
exec node "$HOME/.takatime/trackers/claude-code/import-claude.mjs" --apply --quiet "$@"
SHIM
chmod +x "$BIN_DIR/taka-claude-import"

echo ""
echo "Installed:"
ls -1 "$BIN_DIR" | sed 's/^/  /'
echo ""
echo "Verify:  $BIN_DIR/taka-upload-$VERSION -version"
echo "         $BIN_DIR/taka doctor"
echo ""
echo "For the CLI, add to ~/.zshrc:"
echo "  alias taka='\$HOME/.takatime/bin/taka'"
echo ""
echo "The extension's Plugin/Config.js CURRENT_VERSION must equal $VERSION,"
echo "otherwise it will look for a binary that is not there and silently skip uploads."
