#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-5.3.0}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/vendor/epubcheck"
TMP_DIR="$(mktemp -d)"
ZIP_FILE="$TMP_DIR/epubcheck.zip"

mkdir -p "$TARGET_DIR"

curl -L "https://github.com/w3c/epubcheck/releases/download/v${VERSION}/epubcheck-${VERSION}.zip" -o "$ZIP_FILE"
unzip -q "$ZIP_FILE" -d "$TMP_DIR"

DIST_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name "epubcheck-*" | head -n 1)"
if [[ -z "$DIST_DIR" ]]; then
  echo "Nepodarilo se najit rozbaleny epubcheck release adresar." >&2
  exit 1
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$DIST_DIR"/. "$TARGET_DIR"/
echo "epubcheck nainstalovan do $TARGET_DIR"
