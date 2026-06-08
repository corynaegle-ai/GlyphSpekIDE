#!/usr/bin/env bash
# GlyphCode IDE — platform app-icon generator.
#
# Input : a SQUARE master PNG (>= 1024x1024 recommended).
#         default: resources/glyphcode/glyphcode-icon-master.png
# Output: resources/darwin/code.icns, resources/linux/code.png, resources/win32/code.ico
#         (filenames stay as upstream 'code.*' because the Code-OSS build references those
#          paths regardless of product branding — we replace contents, not names.)
#
# Requires: sips + iconutil (macOS, preinstalled). ImageMagick (magick/convert) is OPTIONAL,
# used only for the Windows .ico; without it that step is skipped with a warning so the
# rest still succeeds. Re-run on a machine with ImageMagick (or in CI) to refresh the .ico.
#
# NOTE: the current master is the wordmark-FREE GlyphCode G-mark, cropped so the mark
# fills ~73% of the 1024 canvas for a strong Dock presence at small sizes. The prior
# master is kept alongside as glyphcode-icon-master-prev.png for fallback. To adjust the
# mark size, re-crop the master and re-run this script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MASTER="${1:-$ROOT/resources/glyphcode/glyphcode-icon-master.png}"

[ -f "$MASTER" ] || { echo "error: master not found: $MASTER" >&2; exit 1; }

TMP="$(mktemp -d)"
ICONSET="$TMP/glyphcode.iconset"
mkdir -p "$ICONSET"

# --- macOS .icns (Apple iconset: each logical size at 1x and 2x) ---
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$MASTER" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$(( s * 2 ))
  sips -z "$d" "$d" "$MASTER" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$ROOT/resources/darwin/code.icns"
echo "wrote resources/darwin/code.icns"

# --- Linux .png (512) ---
sips -z 512 512 "$MASTER" --out "$ROOT/resources/linux/code.png" >/dev/null
echo "wrote resources/linux/code.png"

# --- Windows .ico (needs ImageMagick) ---
if command -v magick >/dev/null 2>&1; then ICO=magick
elif command -v convert >/dev/null 2>&1; then ICO=convert
else ICO=""; fi
if [ -n "$ICO" ]; then
  "$ICO" "$MASTER" -define icon:auto-resize=16,24,32,48,64,128,256 "$ROOT/resources/win32/code.ico"
  echo "wrote resources/win32/code.ico"
else
  echo "WARN: ImageMagick not found — resources/win32/code.ico NOT regenerated (still upstream art)." >&2
  echo "      brew install imagemagick && build/glyphcode/generate-icons.sh   # to refresh the .ico" >&2
fi

rm -rf "$TMP"
echo "done."
