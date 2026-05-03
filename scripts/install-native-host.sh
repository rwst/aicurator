#!/usr/bin/env bash
# AICurator native messaging host installer.
# Compiles scripts/native-host/aicurator-pdftotext.c into ~/.local/bin and
# writes the host manifest under any Chrome / Chromium config dir found.
# Re-running is idempotent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$SCRIPT_DIR/native-host"
SRC="$HOST_DIR/aicurator-pdftotext.c"
TEMPLATE="$HOST_DIR/manifest.template.json"

EXEC_DIR="$HOME/.local/bin"
EXEC_PATH="$EXEC_DIR/aicurator-pdftotext"
HOST_NAME="com.reactome.aicurator.pdftotext"
EXTENSION_ID="ficloojffnfibdhflbinbnonaemknfai"

echo "AICurator native host installer"
echo "==============================="

if ! command -v pkg-config >/dev/null 2>&1; then
  echo "Error: pkg-config not found. Install pkg-config and retry." >&2
  exit 1
fi
if ! pkg-config --exists poppler-glib json-glib-1.0; then
  echo "Error: missing poppler-glib and/or json-glib development headers." >&2
  echo "  Debian/Ubuntu:  sudo apt install libpoppler-glib-dev libjson-glib-dev" >&2
  echo "  Fedora:         sudo dnf install poppler-glib-devel json-glib-devel" >&2
  echo "  Arch:           sudo pacman -S poppler-glib json-glib" >&2
  echo "  openSUSE:       sudo zypper install poppler-glib-devel json-glib-devel" >&2
  exit 1
fi
if ! command -v gcc >/dev/null 2>&1; then
  echo "Error: gcc not found." >&2
  exit 1
fi

mkdir -p "$EXEC_DIR"
echo "Compiling: $SRC"
echo "      ->  $EXEC_PATH"
gcc -O2 -Wall -o "$EXEC_PATH" "$SRC" \
  $(pkg-config --cflags --libs poppler-glib json-glib-1.0)

TMP_MANIFEST="$(mktemp)"
trap 'rm -f "$TMP_MANIFEST"' EXIT
sed -e "s|EXEC_PATH_PLACEHOLDER|$EXEC_PATH|g" \
    -e "s|EXTENSION_ID_PLACEHOLDER|$EXTENSION_ID|g" \
    "$TEMPLATE" > "$TMP_MANIFEST"

INSTALLED=0
for BROWSER_DIR in \
    "$HOME/.config/google-chrome" \
    "$HOME/.config/google-chrome-beta" \
    "$HOME/.config/google-chrome-unstable" \
    "$HOME/.config/chromium"; do
  if [ -d "$BROWSER_DIR" ]; then
    NMH_DIR="$BROWSER_DIR/NativeMessagingHosts"
    mkdir -p "$NMH_DIR"
    cp "$TMP_MANIFEST" "$NMH_DIR/$HOST_NAME.json"
    echo "Installed: $NMH_DIR/$HOST_NAME.json"
    INSTALLED=$((INSTALLED + 1))
  fi
done

if [ "$INSTALLED" -eq 0 ]; then
  echo
  echo "Warning: no Chrome/Chromium config dir found under ~/.config." >&2
  echo "Launch the browser at least once, then re-run this script." >&2
  exit 1
fi

echo
echo "Done. $INSTALLED manifest(s) installed."
echo "Reload the AICurator extension to pick up the host."
