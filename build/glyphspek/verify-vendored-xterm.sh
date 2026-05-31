#!/usr/bin/env bash
# GlyphSpek (fork) — embedded vendored-xterm provenance gate.
#
# WHAT THIS CHECKS
#   The embedded Trust Panel extension ships UNMODIFIED third-party MIT xterm build
#   artifacts (xterm.js, xterm.css, addon-fit.js) under
#     extensions/glyphspek-trust-panel/media/vendor/xterm/
#   alongside a provenance manifest (VENDOR.txt) and a LICENSE. This gate recomputes
#   each shipped file's SHA256 and FAILS if it does not match the SHA256 pinned in
#   that manifest, and FAILS if the LICENSE is missing — so a tampered or silently
#   upgraded vendored asset cannot ship from the fork checkout. (The canonical source
#   repo's extension/verify-xterm-vendor.sh additionally cross-checks source<->fork
#   drift; here we verify the embedded copy in place.)
#
# EXIT CODES
#   0 = every shipped file matches the manifest SHA256 and the LICENSE is present.
#   1 = a SHA256 mismatch, a missing file, a missing LICENSE, or an unreadable manifest.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VENDOR_DIR="$REPO_ROOT/extensions/glyphspek-trust-panel/media/vendor/xterm"
MANIFEST="$VENDOR_DIR/VENDOR.txt"

FILES=(xterm.js xterm.css addon-fit.js)

if [ ! -d "$VENDOR_DIR" ]; then
  echo "verify-vendored-xterm: vendor dir not found at $VENDOR_DIR" >&2
  echo "  (embedded Trust Panel xterm assets absent — nothing to verify)" >&2
  exit 1
fi
if [ ! -f "$MANIFEST" ]; then
  echo "verify-vendored-xterm: manifest not found at $MANIFEST" >&2
  exit 1
fi

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "verify-vendored-xterm: no shasum/sha256sum available" >&2
    return 2
  fi
}

expected_sha() {
  grep -E "^[[:space:]]*$1[[:space:]]" "$MANIFEST" | grep -oE '[0-9a-f]{64}' | head -1
}

echo "=== GlyphSpek embedded vendored-xterm provenance gate ==="
echo "vendor:   $VENDOR_DIR"
echo "manifest: $MANIFEST"
echo

fail=0
if [ ! -f "$VENDOR_DIR/LICENSE" ]; then
  echo "FAIL: LICENSE missing ($VENDOR_DIR/LICENSE)"
  fail=1
fi
for f in "${FILES[@]}"; do
  want="$(expected_sha "$f")"
  path="$VENDOR_DIR/$f"
  if [ -z "$want" ]; then
    echo "FAIL: no SHA256 pinned for '$f' in the manifest"; fail=1; continue
  fi
  if [ ! -f "$path" ]; then
    echo "FAIL: shipped file missing: $path"; fail=1; continue
  fi
  have="$(sha256_of "$path")"
  if [ "$have" != "$want" ]; then
    echo "FAIL: SHA256 mismatch for $f"
    echo "        expected (manifest): $want"
    echo "        actual   (on disk):  $have"
    fail=1
  else
    echo "ok: $f  $have"
  fi
done

echo
echo "=== verdict ==="
if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAIL — embedded vendored xterm assets do not match the pinned manifest."
  exit 1
fi
echo "RESULT: PASS — embedded vendored xterm assets match the manifest SHA256s; LICENSE present."
exit 0
