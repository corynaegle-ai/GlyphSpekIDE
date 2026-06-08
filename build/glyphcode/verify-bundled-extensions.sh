#!/usr/bin/env bash
# GlyphCode — bundled-extension deny gate.
#
# WHAT THIS CHECKS
#   (A) Scans the BUILT app bundle's built-in extensions directory
#       (Contents/Resources/app/extensions on macOS, resources/app/extensions on
#       Linux/Windows) and FAILS if any extension folder matches a pattern in
#       build/glyphcode/bundled-extension-denylist.json. A clean GlyphCode build
#       must not ship Copilot, the proprietary Remote/Dev-Containers pack,
#       Pylance, cpptools, or the C# proprietary debugger — we cannot
#       redistribute them and we ship no Copilot.
#   (B) Chains build/glyphcode/verify-no-copilot.sh, which scans the WHOLE app
#       bundle (node_modules, *.asar, app resources) for Copilot RUNTIME
#       libraries (@github/copilot*, @vscode/copilot-api, Copilot CLI binaries).
#       Copilot can ship as a node_modules runtime dependency even when no
#       extensions/copilot folder exists, so scanning extensions/ alone is NOT a
#       sufficient "ships no Copilot" guarantee.
#   (C) Chains build/glyphcode/verify-embedded-extension.sh — the source<->embedded
#       conformance gate (command IDs, activationEvents, dist/*.js,
#       dist-supervisor/*.mjs, pinned supervisor hashes).
#   (D) Chains build/glyphcode/sync-embedded-extension.sh --check --no-build — the
#       media/** drift gate. (C) does NOT compare media/**, so the embedded Trust
#       Panel webview (media/app.js, live.js, chat.js, index.html, CSS, icons/*.svg
#       — the verifier display, failure-state UI, live trust-posture text) could go
#       stale/missing while (C) stays green. --check is read-only (writes nothing)
#       and --no-build verifies the embedded copy against the already-built source
#       artifacts WITHOUT rebuilding source, keeping this gate read-only.
#
# USAGE
#   build/glyphcode/verify-bundled-extensions.sh [TARGET_DIR]
#
#   TARGET_DIR defaults, in order, to the first that exists:
#     ../VSCode-darwin-arm64/GlyphCode.app   (packaged build, relative to repo root)
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
MANIFEST="$REPO_ROOT/build/glyphcode/bundled-extension-denylist.json"

# ---- resolve target ---------------------------------------------------------
TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  for cand in \
    "$REPO_ROOT/../VSCode-darwin-arm64/GlyphCode.app" \
    "$REPO_ROOT/out"; do
    if [ -e "$cand" ]; then TARGET="$cand"; break; fi
  done
fi

if [ -z "$TARGET" ] || [ ! -e "$TARGET" ]; then
  echo "verify-bundled-extensions: no build target found." >&2
  echo "  Looked for: ../VSCode-darwin-arm64/GlyphCode.app  and  ./out" >&2
  echo "  Pass an explicit path: $0 /path/to/GlyphCode.app" >&2
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

echo "=== GlyphCode bundled-extension deny gate ==="
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
COPILOT_GATE="$REPO_ROOT/build/glyphcode/verify-no-copilot.sh"
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

# ---- chain the source<->embedded conformance gate (Sweep-20 F2) -------------
# The bundled extensions/glyphcode-trust-panel/ is a vendored snapshot of the
# canonical SOURCE tree (../extension). It can silently go stale — missing a new
# command, a renamed dist/ file, or a supervisor bundle whose hash no longer
# matches the pinned one. verify-embedded-extension.sh fails on any such drift so
# a stale embedded copy can't ship a different app than the green source tree.
embedded_conformance_fail=0
EMBEDDED_GATE="$REPO_ROOT/build/glyphcode/verify-embedded-extension.sh"
if [ -f "$EMBEDDED_GATE" ]; then
  echo "--- source<->embedded conformance gate ---"
  if ! bash "$EMBEDDED_GATE"; then
    embedded_conformance_fail=1
  fi
  echo
else
  echo "WARN: verify-embedded-extension.sh not found at $EMBEDDED_GATE —" >&2
  echo "      the embedded extension is NOT being checked for drift vs source." >&2
  echo
fi

# ---- chain the media/** drift gate (Sweep-24 #2) ----------------------------
# verify-embedded-extension.sh above compares command IDs, activationEvents,
# dist/*.js, dist-supervisor/*.mjs, and the pinned supervisor hashes — but it does
# NOT compare the media/** tree. The embedded media/ holds the Trust Panel webview
# (media/app.js, live.js, chat.js, index.html, CSS, media/icons/*.svg) that renders
# the verifier display, failure-state UI, and live trust-posture text. Stale/missing
# media could ship while the conformance gate stays green. The reproducible sync
# script already has a media-aware verify mode that recursively compares media/**
# (and the rest of the synced surfaces) and exits non-zero on ANY drift; run it here
# in --check (read-only, writes nothing) + --no-build (do NOT rebuild source; verify
# the embedded copy against the already-built source artifacts) so media drift is
# release-blocking. This subgate is read-only: it never touches the source or the
# embedded copy.
media_sync_fail=0
SYNC_CHECK="$REPO_ROOT/build/glyphcode/sync-embedded-extension.sh"
if [ -f "$SYNC_CHECK" ]; then
  echo "--- source<->embedded media/** drift gate (sync --check --no-build) ---"
  if ! bash "$SYNC_CHECK" --check --no-build; then
    media_sync_fail=1
  fi
  echo
else
  echo "WARN: sync-embedded-extension.sh not found at $SYNC_CHECK —" >&2
  echo "      the embedded media/** tree is NOT being checked for drift vs source." >&2
  echo
fi

# ---- chain the embedded vendored-xterm provenance gate (F5) -----------------
# The embedded Trust Panel ships UNMODIFIED third-party MIT xterm build artifacts
# (xterm.js, xterm.css, addon-fit.js). verify-vendored-xterm.sh recomputes each
# file's SHA256 and fails on any drift from the pinned provenance manifest
# (VENDOR.txt), and requires the LICENSE to be present — so a tampered/upgraded
# vendored asset can't ship unnoticed. Read-only.
vendored_xterm_fail=0
XTERM_GATE="$REPO_ROOT/build/glyphcode/verify-vendored-xterm.sh"
if [ -f "$XTERM_GATE" ]; then
  echo "--- embedded vendored-xterm provenance gate ---"
  if ! bash "$XTERM_GATE"; then
    vendored_xterm_fail=1
  fi
  echo
else
  echo "WARN: verify-vendored-xterm.sh not found at $XTERM_GATE —" >&2
  echo "      the embedded vendored xterm assets are NOT being provenance-checked." >&2
  echo
fi

echo "=== verdict ==="
if [ "$violations" -gt 0 ] || [ "$copilot_runtime_fail" -gt 0 ] || [ "$embedded_conformance_fail" -gt 0 ] || [ "$media_sync_fail" -gt 0 ] || [ "$vendored_xterm_fail" -gt 0 ]; then
  if [ "$violations" -gt 0 ]; then
    echo "RESULT: FAIL — $violations denylisted extension(s) shipped in the packaged app:"
    printf '%s' "$matched_list" | sed '/^$/d' | sed 's/^/        - extensions\//'
    echo "        GlyphCode must not ship these. Remove them from the build/package path."
  fi
  if [ "$copilot_runtime_fail" -gt 0 ]; then
    echo "RESULT: FAIL — Copilot RUNTIME libraries present in the packaged app"
    echo "        (see the no-Copilot-runtime gate above). GlyphCode must ship no Copilot."
  fi
  if [ "$embedded_conformance_fail" -gt 0 ]; then
    echo "RESULT: FAIL — the embedded GlyphCode extension drifted from its source"
    echo "        (see the source<->embedded conformance gate above). Re-sync with the"
    echo "        canonical command (do NOT copy files by hand):"
    echo "            bash build/glyphcode/sync-embedded-extension.sh"
  fi
  if [ "$media_sync_fail" -gt 0 ]; then
    echo "RESULT: FAIL — the embedded GlyphCode media/** tree (Trust Panel webview:"
    echo "        verifier display, failure-state UI, live trust-posture text, icons)"
    echo "        drifted from its source (see the media/** drift gate above). Re-sync"
    echo "        with the canonical command (do NOT copy files by hand):"
    echo "            bash build/glyphcode/sync-embedded-extension.sh"
  fi
  if [ "$vendored_xterm_fail" -gt 0 ]; then
    echo "RESULT: FAIL — the embedded vendored xterm assets (xterm.js/xterm.css/"
    echo "        addon-fit.js) do not match the pinned provenance manifest VENDOR.txt,"
    echo "        or the LICENSE is missing (see the vendored-xterm provenance gate"
    echo "        above). A tampered/upgraded vendored asset must not ship."
  fi
  exit 1
fi

echo "RESULT: PASS — no denylisted extensions under extensions/, and no Copilot runtime"
echo "        libraries in node_modules / *.asar / app resources."
exit 0
