#!/usr/bin/env bash
# GlyphSpek — M1 "telemetry-free startup" verifier.
#
# WHAT THIS CHECKS
#   (A) STATIC: greps the BUILT app bundle (or the dev `out/` dir) for known
#       Microsoft telemetry + Marketplace + CDN endpoints. A clean GlyphSpek
#       build must not phone home to Microsoft on startup. This catches strings
#       baked into the bundled JS/JSON (product.json, minified workbench, etc).
#   (B) DYNAMIC (documented, not auto-run): how to do a startup network capture
#       so you can PROVE the app makes zero requests to MS endpoints when launched
#       offline-cold. Static grep finds *potential* endpoints; the capture proves
#       *actual* runtime behavior.
#
# USAGE
#   build/glyphspek/verify-no-telemetry.sh [TARGET_DIR]
#
#   TARGET_DIR defaults, in order, to the first that exists:
#     ../VSCode-darwin-arm64/GlyphSpek.app   (packaged build, relative to repo root)
#     ./out                                   (dev build)
#
# EXIT CODES
#   0  = no Microsoft telemetry/marketplace endpoints found (CDN-only matches are
#        reported as WARN, not failure — see KNOWN_SOFT below).
#   1  = at least one HARD telemetry/marketplace endpoint found in the build.
#   2  = target dir not found / nothing to scan.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

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
  echo "verify-no-telemetry: no build target found." >&2
  echo "  Looked for: ../VSCode-darwin-arm64/GlyphSpek.app  and  ./out" >&2
  echo "  Pass an explicit path: $0 /path/to/GlyphSpek.app" >&2
  exit 2
fi

echo "=== GlyphSpek telemetry static scan ==="
echo "target: $TARGET"
echo

# ---- patterns ---------------------------------------------------------------
# HARD = must NOT appear in a telemetry-free build. Any hit fails the check.
HARD_PATTERNS=(
  'dc\.services\.visualstudio\.com'      # Application Insights ingestion (VS Code telemetry)
  'vortex\.data\.microsoft\.com'         # Microsoft 1DS / OneCollector telemetry
  'mobile\.events\.data\.microsoft\.com' # 1DS collector (alt host)
  'browser\.events\.data\.microsoft\.com'
  'marketplace\.visualstudio\.com'       # MS extension marketplace
  'az764295\.vo\.msecnd\.net'            # legacy VS Code update/download CDN
  'download\.visualstudio\.microsoft\.com'
  'update\.code\.visualstudio\.com'      # MS update server
  'api\.github\.com/repos/microsoft/vscode' # MS-specific issue reporter
)

# SOFT = origin known to be present (and already flagged). Reported as WARN.
# vscode-cdn.net only loads webview content host frame; it is NOT telemetry, but
# it IS a Microsoft-operated CDN and is called out in product.json
# (webviewContentExternalBaseUrlTemplate). Track it; don't fail the build on it.
SOFT_PATTERNS=(
  'vscode-cdn\.net'
)

# ---- scan -------------------------------------------------------------------
# Scan text-ish bundle files. Report at FILE level (which file references the
# endpoint, and how many lines), NOT every match line — minified bundles put the
# whole app on one giant line, so dumping matches explodes output to 100s of MB.
# We deliberately EXCLUDE *.map (sourcemaps re-embed the entire minified source,
# so every endpoint shows up there too; they are debug artifacts, not shipped
# runtime code paths, and scanning them produced ~380MB of duplicate noise).
GREP_FILES=(-r -l -I --binary-files=without-match \
  --include='*.js' --include='*.cjs' --include='*.mjs' \
  --include='*.json' --include='*.html' --include='*.css')

# scan_pattern <regex> -> prints per-file report, echoes total file count to stdout
scan_pattern() {
  local pat="$1"
  local files
  files="$(grep "${GREP_FILES[@]}" -E "$pat" "$TARGET" 2>/dev/null | sort -u)"
  if [ -z "$files" ]; then echo 0; return; fi
  local nfiles
  nfiles="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  {
    printf '%s\n' "$files" | head -40 | while IFS= read -r f; do
      # line-count per file (grep -c), trimmed to the app-relative path
      local c rel
      c="$(grep -cE "$pat" "$f" 2>/dev/null)"
      rel="${f#"$TARGET"/}"
      echo "    [$c] $rel"
    done
    [ "$nfiles" -gt 40 ] && echo "    ... and $((nfiles - 40)) more file(s)"
  } >&2
  echo "$nfiles"
}

hard_hits=0
echo "--- HARD endpoints (telemetry / marketplace / update) ---"
for pat in "${HARD_PATTERNS[@]}"; do
  echo "[$pat]" >&2
  n="$(scan_pattern "$pat")"
  if [ "$n" -gt 0 ]; then
    echo "FAIL [$pat]: present in $n file(s) (see list above)"
    hard_hits=$((hard_hits + n))
  fi
done
[ "$hard_hits" -eq 0 ] && echo "OK: no hard telemetry/marketplace/update endpoints found."
echo

soft_hits=0
echo "--- SOFT endpoints (Microsoft CDN; flagged, non-failing) ---"
for pat in "${SOFT_PATTERNS[@]}"; do
  # Split vscode-cdn.net hits into:
  #   (1) sourcemap-comment-only files — the packaging step rewrites every
  #       bundled file's trailing `//# sourceMappingURL=https://main.vscode-cdn.net/...`
  #       comment. These are debug pointers, NOT runtime fetches (the app never
  #       requests them unless a debugger asks for the sourcemap). Counted, not alarming.
  #   (2) real runtime references — a line mentioning vscode-cdn.net that is NOT a
  #       sourceMappingURL comment. THIS is what can phone home on startup.
  all_files="$(grep "${GREP_FILES[@]}" -E "$pat" "$TARGET" 2>/dev/null | sort -u)"
  if [ -z "$all_files" ]; then continue; fi
  n_all="$(printf '%s\n' "$all_files" | wc -l | tr -d ' ')"
  real_files=""
  while IFS= read -r f; do
    if grep -E "$pat" "$f" 2>/dev/null | grep -qvE 'sourceMappingURL='; then
      real_files="${real_files}${f}"$'\n'
    fi
  done <<< "$all_files"
  real_files="$(printf '%s' "$real_files" | sed '/^$/d')"
  n_real=0
  [ -n "$real_files" ] && n_real="$(printf '%s\n' "$real_files" | wc -l | tr -d ' ')"
  n_smap=$((n_all - n_real))
  echo "WARN [$pat]: $n_all file(s) total — $n_smap are sourceMappingURL comments only (debug pointers), $n_real have a REAL runtime reference:"
  if [ "$n_real" -gt 0 ]; then
    printf '%s\n' "$real_files" | head -20 | while IFS= read -r f; do
      c="$(grep -cE "$pat" "$f" 2>/dev/null)"
      echo "    [REAL $c] ${f#"$TARGET"/}" >&2
      grep -oE ".{0,8}https?://[a-zA-Z0-9.-]*vscode-cdn\.net[^\"'\`) ]*" "$f" 2>/dev/null \
        | grep -vE 'sourceMappingURL' | sort -u | head -3 | sed 's/^/        -> /' >&2
    done
  fi
  soft_hits=$((soft_hits + n_real))
done
[ "$soft_hits" -eq 0 ] && echo "OK: no real (non-sourcemap) Microsoft CDN runtime references found."
echo

# ---- dynamic capture instructions (documented, not auto-run) ----------------
cat <<'EOF'
--- DYNAMIC startup network-capture (run manually to PROVE zero phone-home) ---
Static grep finds endpoints baked in the bundle; it does NOT prove the app
contacts them. To prove a telemetry-free *startup*, capture network on a cold,
offline-first launch:

  1) Quit any running GlyphSpek; clear its data dir so first-run paths fire:
       rm -rf "$HOME/.glyphspek" "$HOME/Library/Application Support/GlyphSpek"

  2) Start a packet capture filtered to the suspect hosts (needs sudo). Run in
     a second terminal BEFORE launching the app:
       sudo tcpdump -n -i any -q \
         'tcp port 443 and (host dc.services.visualstudio.com \
          or host vortex.data.microsoft.com \
          or host marketplace.visualstudio.com \
          or host update.code.visualstudio.com)' \
         | tee /tmp/glyphspek-startup-capture.txt
     (Hostname filters in tcpdump resolve once at start; for thoroughness also
      run an unfiltered capture and grep the DNS/SNI, or use Little Snitch /
      `nettop`.)

  3) Launch the app and let it sit on the welcome screen ~60s, then quit:
       open ../VSCode-darwin-arm64/GlyphSpek.app
     (or for a dev build:  ./scripts/code.sh )

  4) PASS if the capture is empty (no packets to those hosts). Any connection to
     a HARD host above = telemetry leak; investigate which component dialed out.

  Alternative GUI tools: Little Snitch (per-process allow/deny log), Wireshark
  (filter: tls.handshake.extensions_server_name contains "microsoft" or
  "visualstudio" or "vscode-cdn"), or `nettop -m tcp -p GlyphSpek`.
EOF
echo

# ---- bundled-extension deny gate --------------------------------------------
# Chain the bundled-extension deny gate: a clean GlyphSpek build must also not
# SHIP proprietary / Copilot extensions inside extensions/. This is a separate,
# hard gate (its own script) but we run it here so `verify-no-telemetry.sh` is a
# single command that fails on either a telemetry endpoint OR a denylisted ext.
bundled_ext_fail=0
DENY_GATE="$REPO_ROOT/build/glyphspek/verify-bundled-extensions.sh"
if [ -x "$DENY_GATE" ]; then
  echo "--- bundled-extension deny gate ---"
  if ! "$DENY_GATE" "$TARGET"; then
    bundled_ext_fail=1
  fi
  echo
fi

# ---- verdict ----------------------------------------------------------------
echo "=== verdict ==="
echo "NOTE: a string match means the ENDPOINT is present in the bundle, not that"
echo "      it is contacted. VS Code/Code-OSS vendors Microsoft telemetry SDKs"
echo "      (@microsoft/applicationinsights-*, @microsoft/1ds-*, @vscode/extension-"
echo "      telemetry) inside built-in extensions; those carry hard-coded default"
echo "      ingestion hosts as constants. They only transmit when (a) the host"
echo "      product.json enables telemetry AND (b) the user's telemetryLevel != off."
echo "      GlyphSpek product.json sets NO aiConfig/enableTelemetry, so the core"
echo "      telemetry channel is unconfigured. The authoritative proof is the"
echo "      DYNAMIC startup capture above — run it on a cold offline launch."
echo
if [ "$bundled_ext_fail" -gt 0 ]; then
  echo "RESULT: FAIL — the packaged app ships one or more denylisted built-in extensions"
  echo "        (see the bundled-extension deny gate above). GlyphSpek must not ship them."
  exit 1
fi
if [ "$hard_hits" -gt 0 ]; then
  echo "RESULT: REVIEW — $hard_hits file(s) contain hard telemetry/marketplace/update"
  echo "        endpoint strings (expected from vendored SDKs). Confirm dormancy via"
  echo "        the dynamic capture; investigate any file OUTSIDE a known telemetry SDK"
  echo "        / built-in extension, and any non-empty aiKey wired to a live reporter."
  # Non-zero exit so CI flags it for human sign-off; this is conservative by design.
  exit 1
fi
if [ "$soft_hits" -gt 0 ]; then
  echo "RESULT: PASS (with $soft_hits real, non-sourcemap CDN reference(s) flagged)."
else
  echo "RESULT: PASS — no hard endpoints; CDN refs are sourcemap comments only."
fi
exit 0
