#!/usr/bin/env bash
# GlyphCode — "no Copilot runtime in the bundle" deny gate.
#
# WHAT THIS CHECKS
#   The bundled-extension deny gate (verify-bundled-extensions.sh) only scans
#   Contents/Resources/app/extensions and so MISSES Copilot material that ships
#   as a node_modules RUNTIME dependency. The fork keeps @github/copilot,
#   @github/copilot-sdk and @vscode/copilot-api in the root build graph
#   (package.json) and the package task copies them into the packaged app's
#   node_modules (and/or node_modules.asar). Removing extensions/copilot is NOT
#   enough for the "GlyphCode ships no Copilot" guardrail.
#
#   This gate scans the WHOLE app bundle for Copilot runtime libraries:
#     - Contents/Resources/app/node_modules/@github/copilot*
#     - Contents/Resources/app/node_modules/@github/copilot-sdk
#     - Contents/Resources/app/node_modules/@vscode/copilot-api
#     - the same paths inside node_modules.asar (and any *.asar) via the asar
#       header (or a binary string scan fallback)
#     - Copilot command binaries / CLI entry shims under app resources
#   and FAILS if any are present.
#
# USAGE
#   build/glyphcode/verify-no-copilot.sh [TARGET_DIR]
#
#   TARGET_DIR defaults, in order, to the first that exists:
#     ../VSCode-darwin-arm64/GlyphCode.app   (packaged build, relative to repo root)
#     ./out                                   (NOTE: dev out/ does not lay out
#                                              node_modules the packaged way; the
#                                              authoritative check is the .app)
#
# EXIT CODES
#   0 = no Copilot runtime material present in the packaged app.
#   1 = at least one Copilot runtime artifact is present (build is unshippable).
#   2 = target dir not found, or no app resources dir to scan.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

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
  echo "verify-no-copilot: no build target found." >&2
  echo "  Looked for: ../VSCode-darwin-arm64/GlyphCode.app  and  ./out" >&2
  echo "  Pass an explicit path: $0 /path/to/GlyphCode.app" >&2
  exit 2
fi

# ---- locate the packaged app resources root ---------------------------------
# macOS:        <app>/Contents/Resources/app
# Linux/Win:    <dir>/resources/app
# dev out/:     scan the target itself (best-effort)
APP_DIR=""
for cand in \
  "$TARGET/Contents/Resources/app" \
  "$TARGET/resources/app" \
  "$TARGET"; do
  if [ -d "$cand" ]; then APP_DIR="$cand"; break; fi
done

if [ -z "$APP_DIR" ]; then
  echo "verify-no-copilot: no packaged app dir under $TARGET" >&2
  echo "  (looked for Contents/Resources/app, resources/app, and the target itself)" >&2
  exit 2
fi

echo "=== GlyphCode no-Copilot-runtime deny gate ==="
echo "target:   $TARGET"
echo "app dir:  $APP_DIR"
echo

# Copilot runtime package directory names we must never ship. These are matched
# as exact path segments under node_modules/, NOT as loose substrings, so we do
# not false-positive on unrelated packages whose name merely contains "copilot"
# inside a larger word. The patterns are anchored to the END of the path so we
# report at PACKAGE-ROOT granularity (e.g. node_modules/@github/copilot, not its
# 20 child folders).
#   @github/copilot           — the Copilot CLI runtime
#   @github/copilot-sdk       — the public Copilot SDK
#   @github/copilot-<plat>    — platform-specific Copilot native packages
#   @vscode/copilot-api       — the CAPI client used to talk to Copilot's backend
COPILOT_NM_REGEXES=(
  '(^|/)node_modules/@github/copilot$'
  '(^|/)node_modules/@github/copilot-[A-Za-z0-9._-]+$'
  '(^|/)node_modules/@vscode/copilot-api$'
)
# Same patterns but allowing a trailing path (used for ASAR listings, where we
# only have file paths, not directory entries).
COPILOT_ASAR_REGEXES=(
  '(^|/)node_modules/@github/copilot(/|$)'
  '(^|/)node_modules/@github/copilot-[A-Za-z0-9._-]+(/|$)'
  '(^|/)node_modules/@vscode/copilot-api(/|$)'
)
# Human-readable labels (for reporting which package matched).
COPILOT_LABELS=(
  '@github/copilot'
  '@github/copilot-sdk / @github/copilot-<platform>'
  '@vscode/copilot-api'
)

violations=0

# ---- (1) scan the UNPACKED node_modules tree --------------------------------
# Match Copilot PACKAGE ROOTS only (nested node_modules included, e.g.
# @github/copilot-sdk/node_modules/@github/copilot), so the count reflects real
# packages shipped, not every subfolder.
echo "--- unpacked node_modules ---"
NM_DIR="$APP_DIR/node_modules"
if [ -d "$NM_DIR" ]; then
  for i in "${!COPILOT_NM_REGEXES[@]}"; do
    re="${COPILOT_NM_REGEXES[$i]}"
    label="${COPILOT_LABELS[$i]}"
    hits="$(find "$NM_DIR" -type d 2>/dev/null \
      | sed "s#^$APP_DIR/##" \
      | grep -E "$re" \
      | sort -u)"
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits" | while IFS= read -r h; do
        echo "FAIL: Copilot runtime present -> $h  (matches '$label')"
      done
      n="$(printf '%s\n' "$hits" | sed '/^$/d' | wc -l | tr -d ' ')"
      violations=$((violations + n))
    fi
  done
else
  echo "    (no unpacked node_modules dir; skipping)"
fi
echo

# ---- (2) scan any *.asar (e.g. node_modules.asar) ---------------------------
# Copilot may be packed inside an ASAR. Read the ASAR file table via the `asar`
# tool if available; otherwise fall back to a binary string scan of the header.
echo "--- ASAR archives ---"
ASAR_FILES="$(find "$APP_DIR" -maxdepth 2 -name '*.asar' 2>/dev/null | sort -u)"
if [ -z "$ASAR_FILES" ]; then
  echo "    (no *.asar archives found; skipping)"
else
  # Prefer a node-based asar header read (robust, exact path list).
  ASAR_BIN=""
  if [ -x "$REPO_ROOT/node_modules/.bin/asar" ]; then
    ASAR_BIN="$REPO_ROOT/node_modules/.bin/asar"
  elif [ -f "$REPO_ROOT/node_modules/asar/bin/asar.js" ]; then
    ASAR_BIN="node $REPO_ROOT/node_modules/asar/bin/asar.js"
  fi

  while IFS= read -r asar; do
    [ -n "$asar" ] || continue
    rel="${asar#"$APP_DIR"/}"
    listing=""
    if [ -n "$ASAR_BIN" ]; then
      listing="$($ASAR_BIN list "$asar" 2>/dev/null || true)"
    fi
    if [ -z "$listing" ]; then
      # Fallback: the ASAR header is a JSON directory tree at the start of the
      # file. `strings` over the whole archive will surface @github/copilot /
      # @vscode/copilot-api path segments if present.
      listing="$(strings -a "$asar" 2>/dev/null)"
    fi
    for i in "${!COPILOT_ASAR_REGEXES[@]}"; do
      re="${COPILOT_ASAR_REGEXES[$i]}"
      label="${COPILOT_LABELS[$i]}"
      if printf '%s\n' "$listing" | grep -Eq "$re"; then
        echo "FAIL: Copilot runtime present inside $rel  (matches '$label')"
        violations=$((violations + 1))
      fi
    done
  done <<< "$ASAR_FILES"
fi
echo

# ---- (3) scan app resources for Copilot command binaries / CLI shims --------
# The Copilot CLI ships an executable entrypoint (the `copilot` command) and a
# bin shim. Catch a stray binary/shim anywhere under the app dir even if the
# package directory layout above changed.
echo "--- Copilot command binaries / CLI shims ---"
bin_hits="$(find "$APP_DIR" \
  \( -path '*/node_modules/.bin/copilot' \
     -o -path '*/@github/copilot/*copilot' \
     -o -name 'copilot-cli*' \) \
  2>/dev/null | sed "s#^$APP_DIR/##" | sort -u)"
if [ -n "$bin_hits" ]; then
  printf '%s\n' "$bin_hits" | while IFS= read -r h; do
    echo "FAIL: Copilot command binary/shim present -> $h"
  done
  n="$(printf '%s\n' "$bin_hits" | sed '/^$/d' | wc -l | tr -d ' ')"
  violations=$((violations + n))
else
  echo "    (no Copilot command binaries/shims found)"
fi
echo

# ---- verdict ----------------------------------------------------------------
echo "=== verdict ==="
if [ "$violations" -gt 0 ]; then
  echo "RESULT: FAIL — $violations Copilot runtime artifact(s) shipped in the packaged app."
  echo "        GlyphCode must ship NO Copilot runtime. Remove @github/copilot*,"
  echo "        @github/copilot-sdk and @vscode/copilot-api from the build graph"
  echo "        (root package.json) and the Copilot package task, then rebuild."
  exit 1
fi

echo "RESULT: PASS — no Copilot runtime libraries (@github/copilot*, @vscode/copilot-api)"
echo "        found in node_modules, *.asar, or app resources."
exit 0
