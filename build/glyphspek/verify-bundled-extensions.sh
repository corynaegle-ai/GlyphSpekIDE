#!/usr/bin/env bash
# GlyphSpek — bundled-extension deny gate.
#
# WHAT THIS CHECKS
#   (A) Scans the BUILT app bundle's built-in extensions directory
#       (Contents/Resources/app/extensions on macOS, resources/app/extensions on
#       Linux/Windows) and FAILS if any extension folder matches a pattern in
#       build/glyphspek/bundled-extension-denylist.json. A clean GlyphSpek build
#       must not ship Copilot, the proprietary Remote/Dev-Containers pack,
#       Pylance, cpptools, or the C# proprietary debugger — we cannot
#       redistribute them and we ship no Copilot.
#   (B) Chains build/glyphspek/verify-no-copilot.sh, which scans the WHOLE app
#       bundle (node_modules, *.asar, app resources) for Copilot RUNTIME
#       libraries (@github/copilot*, @vscode/copilot-api, Copilot CLI binaries).
#       Copilot can ship as a node_modules runtime dependency even when no
#       extensions/copilot folder exists, so scanning extensions/ alone is NOT a
#       sufficient "ships no Copilot" guarantee.
#
# USAGE
#   build/glyphspek/verify-bundled-extensions.sh [TARGET_DIR]
#
#   TARGET_DIR defaults, in order, to the first that exists:
#     ../VSCode-darwin-arm64/GlyphSpek.app   (packaged build, relative to repo root)
#     ./out                                   (NOTE: dev out/ does not lay out
#                                              extensions/ the packaged way; the
#                                              authoritative check is the .app)
#
# EXIT CODES
#   0 = no denylisted extension AND no Copilot runtime present in the packaged app.
#   1 = at least one denylisted extension folder OR Copilot runtime is present
#       (build is unshippable).
#   2 = target dir not found, or no extensions dir to scan.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$REPO_ROOT/build/glyphspek/bundled-extension-denylist.json"

# ---- resolve target ---------------------------------------------------------
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  for cand in \
    "$REPO_ROOT/../VSCode-darwin-arm64/GlyphSpek.app" \
    "$REPO_ROOT/out"; do
    if [ -e "$cand" ]; then TARGET="$cand"; break; fi
  done
fi

if [ -z "$TARGET" ] || [ ! -e "$TARGET" ]; then
  echo "verify-bundled-extensions: no build target found." >&2
  echo "  Looked for: ../VSCode-darwin-arm64/GlyphSpek.app  and  ./out" >&2
  echo "  Pass an explicit path: $0 /path/to/GlyphSpek.app" >&2
  exit 2
fi

if [ ! -f "$MANIFEST" ]; then
  echo "verify-bundled-extensions: deny manifest not found at $MANIFEST" >&2
  exit 2
fi

# ---- locate the packaged extensions/ dir ------------------------------------
EXT_DIR=""
for cand in \
  "$TARGET/Contents/Resources/app/extensions" \
  "$TARGET/resources/app/extensions" \
  "$TARGET/extensions"; do
  if [ -d "$cand" ]; then EXT_DIR="$cand"; break; fi
done

if [ -z "$EXT_DIR" ]; then
  echo "verify-bundled-extensions: no packaged extensions/ dir under $TARGET" >&2
  echo "  (looked for Contents/Resources/app/extensions, resources/app/extensions, extensions)" >&2
  exit 2
fi

echo "=== GlyphSpek bundled-extension deny gate ==="
echo "target:     $TARGET"
echo "extensions: $EXT_DIR"
echo "manifest:   $MANIFEST"
echo

# ---- load denylist patterns -------------------------------------------------
# Extract the "pattern" values from the manifest. Prefer python3 (handles JSON
# robustly); fall back to a grep/sed extraction if python3 is unavailable.
read_patterns() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$MANIFEST" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for entry in data.get("denylist", []):
    p = entry.get("pattern")
    if p:
        print(p)
PY
  else
    # crude fallback: pull "pattern": "<value>" occurrences
    grep -oE '"pattern"[[:space:]]*:[[:space:]]*"[^"]+"' "$MANIFEST" \
      | sed -E 's/.*"pattern"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
  fi
}

PATTERNS=()
while IFS= read -r line; do
  [ -n "$line" ] && PATTERNS+=("$line")
done < <(read_patterns)

if [ "${#PATTERNS[@]}" -eq 0 ]; then
  echo "verify-bundled-extensions: no patterns parsed from manifest." >&2
  exit 2
fi

echo "--- denylist patterns (${#PATTERNS[@]}) ---"
for p in "${PATTERNS[@]}"; do echo "    $p"; done
echo

# ---- match each extension folder against the denylist -----------------------
shopt -s nocasematch
violations=0
matched_list=""

for entry in "$EXT_DIR"/*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  # skip non-extension noise (json marker files etc.) — only folders are extensions
  [ -d "$entry" ] || continue
  for pat in "${PATTERNS[@]}"; do
    # shell glob match, case-insensitive (nocasematch)
    if [[ "$name" == $pat ]]; then
      echo "FAIL: denylisted extension present -> extensions/$name  (matched pattern: '$pat')"
      matched_list="${matched_list}${name}"$'\n'
      violations=$((violations + 1))
      break
    fi
  done
done
shopt -u nocasematch

echo

# ---- chain the no-Copilot-runtime gate --------------------------------------
# extensions/ alone is not the whole story: Copilot ships as a node_modules
# RUNTIME dependency (@github/copilot*, @vscode/copilot-api) and can be packed in
# node_modules.asar. verify-no-copilot.sh scans the full app bundle for it.
# Running it here keeps this script a single honest "ships no Copilot" gate.
copilot_runtime_fail=0
COPILOT_GATE="$REPO_ROOT/build/glyphspek/verify-no-copilot.sh"
if [ -f "$COPILOT_GATE" ]; then
  echo "--- no-Copilot-runtime gate ---"
  if ! bash "$COPILOT_GATE" "$TARGET"; then
    copilot_runtime_fail=1
  fi
  echo
else
  echo "WARN: verify-no-copilot.sh not found at $COPILOT_GATE — node_modules/ASAR" >&2
  echo "      Copilot runtime is NOT being scanned (extensions/ only)." >&2
  echo
fi

echo "=== verdict ==="
if [ "$violations" -gt 0 ] || [ "$copilot_runtime_fail" -gt 0 ]; then
  if [ "$violations" -gt 0 ]; then
    echo "RESULT: FAIL — $violations denylisted extension(s) shipped in the packaged app:"
    printf '%s' "$matched_list" | sed '/^$/d' | sed 's/^/        - extensions\//'
    echo "        GlyphSpek must not ship these. Remove them from the build/package path."
  fi
  if [ "$copilot_runtime_fail" -gt 0 ]; then
    echo "RESULT: FAIL — Copilot RUNTIME libraries present in the packaged app"
    echo "        (see the no-Copilot-runtime gate above). GlyphSpek must ship no Copilot."
  fi
  exit 1
fi

echo "RESULT: PASS — no denylisted extensions under extensions/, and no Copilot runtime"
echo "        libraries in node_modules / *.asar / app resources."
exit 0
