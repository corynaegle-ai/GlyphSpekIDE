#!/usr/bin/env bash
# GlyphCode — M1 "telemetry-free startup" verifier.
#
# WHAT THIS CHECKS
#   (A) STATIC: greps the BUILT app bundle (or the dev `out/` dir) for known
#       Microsoft telemetry + Marketplace + CDN endpoints. A clean GlyphCode
#       build must not phone home to Microsoft on startup. This catches strings
#       baked into the bundled JS/JSON (product.json, minified workbench, etc).
#   (B) DYNAMIC (documented, not auto-run): how to do a startup network capture
#       so you can PROVE the app makes zero requests to MS endpoints when launched
#       offline-cold. Static grep finds *potential* endpoints; the capture proves
#       *actual* runtime behavior.
#
# USAGE
#   build/glyphcode/verify-no-telemetry.sh [TARGET_DIR]
#
#   TARGET_DIR defaults, in order, to the first that exists:
#     ../VSCode-darwin-arm64/GlyphCode.app   (packaged build, relative to repo root)
#     ./out                                   (dev build)
#
# CLASSIFICATION (why this is a PASS, not a perpetual REVIEW)
#   Every HARD endpoint hit is classified against an inventoried allowlist
#   (build/glyphcode/vendored-telemetry-allowlist.json):
#     - VENDORED-DORMANT: the hit is in a Microsoft-authored built-in / the
#       vendored @microsoft/1ds telemetry SDK / core out/ that Code-OSS ships,
#       where the endpoint is a DORMANT string constant (or a localized doc-link
#       description). GlyphCode introduces no telemetry; telemetry is OFF at the
#       product level (no aiConfig/enableTelemetry/aiKey; gallery=open-vsx;
#       no updateUrl). These are inventoried + expected → they do NOT fail.
#     - GlyphCode-INTRODUCED / UNEXPECTED: a HARD hit whose path is NOT in the
#       allowlist (e.g. the embedded glyphcode-trust-panel extension, product.json,
#       or any new/GlyphCode-authored code). This HARD-FAILS — GlyphCode must
#       introduce zero telemetry.
#   Result: PASS (with an inventoried accounting) when the only hits are the
#   known vendored-dormant set; FAIL the instant a telemetry string appears
#   outside that inventory.
#
# EXIT CODES
#   0  = no UNEXPECTED telemetry/marketplace endpoints found. Either nothing
#        matched, or every HARD hit is an inventoried vendored-dormant file
#        (CDN-only matches are reported as WARN — see SOFT below).
#   1  = at least one UNEXPECTED HARD hit (GlyphCode-introduced or not yet
#        inventoried), OR a denylisted bundled extension. This is a real finding.
#   2  = target dir not found / nothing to scan.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ---- vendored-telemetry allowlist (inventoried, auditable) -------------------
# Path globs (app-relative) of files that may legitimately contain a HARD
# endpoint string because it is a dormant vendored-upstream constant. Loaded
# from the checked-in JSON inventory so the list is reviewable in git. A
# trailing /** matches any descendant path.
ALLOWLIST_JSON="$REPO_ROOT/build/glyphcode/vendored-telemetry-allowlist.json"
VENDORED_ALLOW=()
if [ -f "$ALLOWLIST_JSON" ]; then
  # Extract "pattern" values without requiring jq (portable grep/sed).
  while IFS= read -r p; do
    [ -n "$p" ] && VENDORED_ALLOW+=("$p")
  done < <(grep -oE '"pattern"[[:space:]]*:[[:space:]]*"[^"]+"' "$ALLOWLIST_JSON" \
             | sed -E 's/.*"pattern"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
fi

# is_vendored_allowed <app-relative-path> -> 0 if it matches an allowlist glob.
is_vendored_allowed() {
  local rel="$1" pat
  for pat in "${VENDORED_ALLOW[@]}"; do
    case "$pat" in
      */\*\*)
        # 'prefix/**' matches the prefix dir and anything under it.
        local prefix="${pat%/\*\*}"
        case "$rel" in
          "$prefix"|"$prefix"/*) return 0 ;;
        esac
        ;;
      *)
        [ "$rel" = "$pat" ] && return 0
        # also tolerate a glob if the inventory ever uses one mid-path
        case "$rel" in $pat) return 0 ;; esac
        ;;
    esac
  done
  return 1
}

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
  echo "verify-no-telemetry: no build target found." >&2
  echo "  Looked for: ../VSCode-darwin-arm64/GlyphCode.app  and  ./out" >&2
  echo "  Pass an explicit path: $0 /path/to/GlyphCode.app" >&2
  exit 2
fi

echo "=== GlyphCode telemetry static scan ==="
echo "target: $TARGET"

# The vendored-dormant allowlist is scoped to the PACKAGED app — the actual
# shipped artifact (Microsoft built-ins + the 1DS SDK + the minified/tree-shaken
# core out/ bundles). The dev ./out tree is a build INTERMEDIATE: it is the
# unbundled source-mirror of core, so it contains hundreds of individual vs/**
# modules (e.g. vs/platform/telemetry/common/1dsAppender.js) and *.test.js files
# that get bundled/minified into a handful of out/vs/**/*.main.js files in the
# package. Those extra dev-intermediate paths are NOT inventoried (they are not
# shipped), so a scan of ./out will report them as UNEXPECTED. Scan the PACKAGED
# .app for an authoritative verdict; ./out is for quick local smoke only.
TARGET_IS_PACKAGED=0
case "$TARGET" in
  *.app|*.app/) TARGET_IS_PACKAGED=1 ;;
  *) [ -d "$TARGET/Contents/Resources/app" ] || [ -d "$TARGET/resources/app" ] && TARGET_IS_PACKAGED=1 ;;
esac
if [ "$TARGET_IS_PACKAGED" -ne 1 ]; then
  echo "note: target looks like a dev build intermediate (not a packaged .app)."
  echo "      The vendored-dormant allowlist is packaged-app-scoped; unbundled core"
  echo "      modules under out/vs/** may be reported as UNEXPECTED here even though"
  echo "      they minify into already-inventoried bundles. Scan the packaged"
  echo "      ../VSCode-darwin-arm64/GlyphCode.app for the authoritative verdict."
fi
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

# app_rel <abs-path> -> path relative to the app root we classify against.
# For a packaged .app the allowlist is written relative to Contents/Resources/app
# (macOS) or resources/app (Linux/Windows); for a dev ./out target it is the same
# 'out/...' prefix. Strip the longest known app-root prefix so the remainder
# matches the inventory's app-relative globs.
app_rel() {
  local f="$1" rel
  rel="${f#"$TARGET"/}"
  case "$rel" in
    Contents/Resources/app/*) rel="${rel#Contents/Resources/app/}" ;;
    resources/app/*)          rel="${rel#resources/app/}" ;;
  esac
  echo "$rel"
}

# scan_pattern <regex> -> per-file report tagged VENDORED vs UNEXPECTED; echoes
# the count of UNEXPECTED (non-allowlisted) files to stdout. Vendored-dormant
# (inventoried) files are reported for the audit trail but do NOT count as hits.
scan_pattern() {
  local pat="$1"
  local files
  files="$(grep "${GREP_FILES[@]}" -E "$pat" "$TARGET" 2>/dev/null | sort -u)"
  if [ -z "$files" ]; then echo 0; return; fi
  local nfiles unexpected=0
  nfiles="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  {
    printf '%s\n' "$files" | head -60 | while IFS= read -r f; do
      local c rel tag
      c="$(grep -cE "$pat" "$f" 2>/dev/null)"
      rel="$(app_rel "$f")"
      if is_vendored_allowed "$rel"; then tag="VENDORED-DORMANT"; else tag="UNEXPECTED"; fi
      echo "    [$c][$tag] $rel"
    done
    [ "$nfiles" -gt 60 ] && echo "    ... and $((nfiles - 60)) more file(s)"
  } >&2
  # Count files NOT covered by the allowlist (these are the real hits).
  while IFS= read -r f; do
    rel="$(app_rel "$f")"
    is_vendored_allowed "$rel" || unexpected=$((unexpected + 1))
  done <<< "$files"
  echo "$unexpected"
}

unexpected_hits=0
vendored_hits=0
echo "--- HARD endpoints (telemetry / marketplace / update) ---"
for pat in "${HARD_PATTERNS[@]}"; do
  echo "[$pat]" >&2
  # total files matching this pattern
  pfiles="$(grep "${GREP_FILES[@]}" -E "$pat" "$TARGET" 2>/dev/null | sort -u)"
  if [ -z "$pfiles" ]; then continue; fi
  ptotal="$(printf '%s\n' "$pfiles" | wc -l | tr -d ' ')"
  n_unexpected="$(scan_pattern "$pat")"
  n_vendored=$((ptotal - n_unexpected))
  vendored_hits=$((vendored_hits + n_vendored))
  if [ "$n_unexpected" -gt 0 ]; then
    echo "FAIL [$pat]: $n_unexpected UNEXPECTED file(s) (not in vendored allowlist) — see list above"
    unexpected_hits=$((unexpected_hits + n_unexpected))
  elif [ "$n_vendored" -gt 0 ]; then
    echo "INVENTORY [$pat]: $n_vendored vendored-dormant file(s) (allowlisted)"
  fi
done
if [ "$unexpected_hits" -eq 0 ] && [ "$vendored_hits" -eq 0 ]; then
  echo "OK: no hard telemetry/marketplace/update endpoints found."
elif [ "$unexpected_hits" -eq 0 ]; then
  echo "OK: $vendored_hits vendored-dormant hit(s), all inventoried; 0 unexpected/GlyphCode-introduced."
fi
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

  1) Quit any running GlyphCode; clear its data dir so first-run paths fire:
       rm -rf "$HOME/.glyphcode" "$HOME/Library/Application Support/GlyphCode"

  2) Start a packet capture filtered to the suspect hosts (needs sudo). Run in
     a second terminal BEFORE launching the app:
       sudo tcpdump -n -i any -q \
         'tcp port 443 and (host dc.services.visualstudio.com \
          or host vortex.data.microsoft.com \
          or host marketplace.visualstudio.com \
          or host update.code.visualstudio.com)' \
         | tee /tmp/glyphcode-startup-capture.txt
     (Hostname filters in tcpdump resolve once at start; for thoroughness also
      run an unfiltered capture and grep the DNS/SNI, or use Little Snitch /
      `nettop`.)

  3) Launch the app and let it sit on the welcome screen ~60s, then quit:
       open ../VSCode-darwin-arm64/GlyphCode.app
     (or for a dev build:  ./scripts/code.sh )

  4) PASS if the capture is empty (no packets to those hosts). Any connection to
     a HARD host above = telemetry leak; investigate which component dialed out.

  Alternative GUI tools: Little Snitch (per-process allow/deny log), Wireshark
  (filter: tls.handshake.extensions_server_name contains "microsoft" or
  "visualstudio" or "vscode-cdn"), or `nettop -m tcp -p GlyphCode`.
EOF
echo

# ---- bundled-extension deny gate --------------------------------------------
# Chain the bundled-extension deny gate: a clean GlyphCode build must also not
# SHIP proprietary / Copilot extensions inside extensions/. This is a separate,
# hard gate (its own script) but we run it here so `verify-no-telemetry.sh` is a
# single command that fails on either a telemetry endpoint OR a denylisted ext.
bundled_ext_fail=0
DENY_GATE="$REPO_ROOT/build/glyphcode/verify-bundled-extensions.sh"
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
echo "      GlyphCode product.json sets NO aiConfig/enableTelemetry/aiKey, no"
echo "      updateUrl, and a gallery of open-vsx.org, so the core telemetry/update/"
echo "      marketplace channels are unconfigured. Each HARD hit above is classified:"
echo "      VENDORED-DORMANT hits are inventoried in"
echo "      build/glyphcode/vendored-telemetry-allowlist.json (confirmed string"
echo "      constants / localized doc-link text, not active call paths); an UNEXPECTED"
echo "      hit is a GlyphCode-introduced or not-yet-inventoried telemetry string and"
echo "      hard-fails. The authoritative proof of zero phone-home is the DYNAMIC"
echo "      startup capture above — run it on a cold offline launch."
echo
if [ "$bundled_ext_fail" -gt 0 ]; then
  echo "RESULT: FAIL — the packaged app ships one or more denylisted built-in extensions"
  echo "        (see the bundled-extension deny gate above). GlyphCode must not ship them."
  exit 1
fi
if [ "$unexpected_hits" -gt 0 ]; then
  echo "RESULT: FAIL — $unexpected_hits file(s) contain a hard telemetry/marketplace/update"
  echo "        endpoint string OUTSIDE the vendored-dormant allowlist. This is a REAL"
  echo "        finding: it is either GlyphCode-INTRODUCED telemetry (must be zero) or a"
  echo "        new vendored file not yet inventoried. Investigate each [UNEXPECTED] file"
  echo "        above; if (and only if) it is a confirmed dormant vendored-upstream"
  echo "        constant, add it to vendored-telemetry-allowlist.json with a why-dormant."
  exit 1
fi
# No unexpected hard hits. Report PASS with an honest accounting of the dormant set.
if [ "$vendored_hits" -gt 0 ]; then
  echo "RESULT: PASS — GlyphCode introduces ZERO telemetry. $vendored_hits HARD endpoint"
  echo "        hit(s) are all VENDORED-DORMANT (inventoried in"
  echo "        build/glyphcode/vendored-telemetry-allowlist.json) — Microsoft-authored"
  echo "        built-ins / vendored 1DS SDK / core out/, telemetry OFF at product level."
elif [ "$soft_hits" -gt 0 ]; then
  echo "RESULT: PASS — no hard endpoints; $soft_hits real, non-sourcemap CDN reference(s) flagged."
else
  echo "RESULT: PASS — no hard endpoints; CDN refs are sourcemap comments only."
fi
[ "$soft_hits" -gt 0 ] && echo "        (plus $soft_hits non-sourcemap Microsoft-CDN reference(s) flagged above.)"
exit 0
