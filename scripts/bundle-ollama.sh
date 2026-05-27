#!/usr/bin/env bash
# Downloads the Ollama macOS binaries into src-tauri/binaries/.
# Run this on any platform (Linux, macOS, Windows/WSL) before building.
# The files are just downloaded — they don't need to execute on the build machine.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARIES_DIR="$SCRIPT_DIR/../app/src-tauri/binaries"
OLLAMA_VERSION="${OLLAMA_VERSION:-v0.24.0}"

mkdir -p "$BINARIES_DIR"

echo "Downloading Ollama $OLLAMA_VERSION universal macOS binary..."
curl -fL \
  "https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-darwin" \
  -o "$BINARIES_DIR/ollama-universal-darwin"

# Tauri needs a file named for each target triple it will bundle
cp "$BINARIES_DIR/ollama-universal-darwin" "$BINARIES_DIR/ollama-aarch64-apple-darwin"
cp "$BINARIES_DIR/ollama-universal-darwin" "$BINARIES_DIR/ollama-x86_64-apple-darwin"
chmod +x "$BINARIES_DIR/ollama-aarch64-apple-darwin" "$BINARIES_DIR/ollama-x86_64-apple-darwin"
rm "$BINARIES_DIR/ollama-universal-darwin"

echo "Placed at:"
echo "  $BINARIES_DIR/ollama-aarch64-apple-darwin  (Apple Silicon)"
echo "  $BINARIES_DIR/ollama-x86_64-apple-darwin   (Intel Mac)"
