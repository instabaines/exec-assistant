#!/usr/bin/env bash
# Downloads the Ollama macOS CLI binary into src-tauri/binaries/.
# Run this on any platform (Linux, macOS, Windows/WSL) before building.
# The files are just downloaded — they don't need to execute on the build machine.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARIES_DIR="$SCRIPT_DIR/../app/src-tauri/binaries"
OLLAMA_VERSION="${OLLAMA_VERSION:-v0.24.0}"
TGZ="$BINARIES_DIR/ollama-darwin.tgz"

mkdir -p "$BINARIES_DIR"

echo "Downloading Ollama $OLLAMA_VERSION..."
curl -fL \
  "https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-darwin.tgz" \
  -o "$TGZ"

echo "Extracting binary..."
# The tgz contains the 'ollama' binary at the root or inside a bin/ directory.
# We try both locations and take whichever exists.
EXTRACT_DIR="$BINARIES_DIR/_extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$TGZ" -C "$EXTRACT_DIR"

# Find the ollama binary (handles both flat and nested archives)
OLLAMA_BIN=$(find "$EXTRACT_DIR" -type f -name "ollama" | head -1)

if [ -z "$OLLAMA_BIN" ]; then
  echo "Error: could not find 'ollama' binary inside the archive."
  echo "Archive contents:"
  tar -tzf "$TGZ" | head -20
  exit 1
fi

# Tauri needs a file named for each target triple it will bundle
cp "$OLLAMA_BIN" "$BINARIES_DIR/ollama-aarch64-apple-darwin"
cp "$OLLAMA_BIN" "$BINARIES_DIR/ollama-x86_64-apple-darwin"
chmod +x "$BINARIES_DIR/ollama-aarch64-apple-darwin" "$BINARIES_DIR/ollama-x86_64-apple-darwin"

# Clean up
rm -rf "$EXTRACT_DIR" "$TGZ"

echo ""
echo "Done. Binaries placed at:"
echo "  $BINARIES_DIR/ollama-aarch64-apple-darwin  (Apple Silicon)"
echo "  $BINARIES_DIR/ollama-x86_64-apple-darwin   (Intel Mac)"
