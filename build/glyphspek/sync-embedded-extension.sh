#!/usr/bin/env bash
# GlyphSpek — reproducible source -> fork-embedded extension sync.
#
# WHY THIS EXISTS
#   The fork embeds a VENDORED COPY of the first-party extension at
#   extensions/glyphspek-trust-panel/. That copy is built out-of-band from the
#   canonical SOURCE tree (../extension, sibling to this repo). For three review
#   sweeps (20, 22, 23) the copy DRIFTED from source because the source->embedded
#   copy was done by hand. This script makes that sync a SINGLE, deterministic,
#   idempotent command so it can no longer drift silently.
#
#   It is the inverse of build/glyphspek/verify-embedded-extension.sh: the verify
#   script FAILS on drift; this script PRODUCES the conforming embedded copy. Run
#   with no args to (re)sync; run with --check to assert "already in sync" without
#   writing (gate-suitable, same exit semantics as the verify gate).
#
# WHAT IT SYNCS  (exactly the surfaces verify-embedded-extension.sh compares,
#                 plus README so docs can't drift either)
#     package.json                 (command IDs + activationEvents the gate checks)
#     README.md                    (kept in lockstep; not gate-checked)
#     dist/*.js                    (the built .js set the gate compares — NO .map)
#     dist-supervisor/*.mjs        (the bundled supervisor entrypoints)
#     media/*                      (webview assets)
#   It does NOT touch the embedded .vscodeignore: that file is intentionally
#   DIFFERENT from source (the embedded copy ships pre-built, so it only needs to
#   drop **/*.map and .DS_Store, not exclude src/test/scripts/node_modules).
#
# DETERMINISM
#   The source build (cd ../extension && npm run compile) is byte-stable: esbuild
#   + tsc emit identical bundles + identical dist/extension.js across rebuilds, so
#   re-running this script produces zero further diff. The supervisor bundle
#   sha256s are cross-checked against the SOURCE pins in src/supervisorHash.ts
#   before anything is copied, and the script fails loudly on any mismatch.
#
# USAGE
#   build/glyphspek/sync-embedded-extension.sh [--check] [--no-build] [SOURCE_DIR]
#
#     (no flags)   Rebuild source, verify pins, copy artifacts into the embedded
#                  copy. Idempotent: a no-op diff when already in sync.
#     --check      Verify-only. Compute what WOULD be copied and FAIL (exit 1) if
#                  it differs from the embedded copy. Writes nothing. Use as a gate.
#     --no-build   Skip the source rebuild; use the pre-built artifacts already in
#                  ../extension/dist + dist-supervisor as-is (pins still verified).
#     SOURCE_DIR   Override the source tree (default: $GLYPHSPEK_EXTENSION_SOURCE,
#                  then ../extension, then ../../extension).
#
# EXIT CODES
#   0 = synced (or, with --check, already in sync).
#   1 = (--check) embedded copy differs from source / would change.
#   2 = source tree / artifacts missing, pin mismatch, or a tool is unavailable.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ---- parse args -------------------------------------------------------------
CHECK_ONLY=0
DO_BUILD=1
SOURCE_ARG=""
for arg in "$@"; do
	case "$arg" in
		--check)    CHECK_ONLY=1 ;;
		--no-build) DO_BUILD=0 ;;
		-h|--help)
			sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		-*)
			echo "sync-embedded-extension: unknown flag: $arg" >&2
			exit 2
			;;
		*)
			SOURCE_ARG="$arg" ;;
	esac
done

# ---- resolve source + embedded trees ----------------------------------------
SOURCE="$SOURCE_ARG"
if [ -z "$SOURCE" ]; then
	for cand in \
		"${GLYPHSPEK_EXTENSION_SOURCE:-}" \
		"$REPO_ROOT/../extension" \
		"$REPO_ROOT/../../extension"; do
		[ -n "$cand" ] || continue
		if [ -d "$cand" ]; then SOURCE="$cand"; break; fi
	done
fi

EMBEDDED="$REPO_ROOT/extensions/glyphspek-trust-panel"

if [ -z "$SOURCE" ] || [ ! -d "$SOURCE" ]; then
	echo "sync-embedded-extension: SOURCE extension tree not found." >&2
	echo "  Looked for: \$GLYPHSPEK_EXTENSION_SOURCE, ../extension, ../../extension" >&2
	echo "  Pass an explicit path: $0 [--check] /path/to/extension" >&2
	exit 2
fi
if [ ! -d "$EMBEDDED" ]; then
	echo "sync-embedded-extension: EMBEDDED extension not found at $EMBEDDED" >&2
	exit 2
fi

SOURCE="$(cd "$SOURCE" && pwd)"
EMBEDDED="$(cd "$EMBEDDED" && pwd)"

for tool in python3 shasum; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "sync-embedded-extension: $tool is required." >&2
		exit 2
	fi
done

mode="SYNC"
[ "$CHECK_ONLY" -eq 1 ] && mode="CHECK (no writes)"
echo "=== GlyphSpek source -> embedded extension sync [$mode] ==="
echo "source:   $SOURCE"
echo "embedded: $EMBEDDED"
echo

# ---- (1) (re)build the source so dist/ + dist-supervisor/ are current -------
if [ "$DO_BUILD" -eq 1 ] && [ "$CHECK_ONLY" -eq 0 ]; then
	if [ ! -f "$SOURCE/package.json" ]; then
		echo "sync-embedded-extension: $SOURCE/package.json missing — cannot build." >&2
		exit 2
	fi
	echo "--- building source ($SOURCE: npm run compile) ---"
	if ! ( cd "$SOURCE" && npm run compile ); then
		echo "sync-embedded-extension: source build (npm run compile) FAILED." >&2
		exit 2
	fi
	echo
else
	# --check and --no-build use the pre-built artifacts as-is.
	echo "--- using pre-built source artifacts (no rebuild) ---"
	echo
fi

# ---- (2) require the artifacts the gate compares to exist -------------------
require_file() {
	[ -f "$1" ] || { echo "sync-embedded-extension: required source file missing: $1" >&2; exit 2; }
}
require_dir() {
	[ -d "$1" ] || { echo "sync-embedded-extension: required source dir missing: $1" >&2; exit 2; }
}
require_file "$SOURCE/package.json"
require_dir  "$SOURCE/dist"
require_dir  "$SOURCE/dist-supervisor"
require_dir  "$SOURCE/media"
require_file "$SOURCE/src/supervisorHash.ts"

SRC_JS="$(cd "$SOURCE/dist" && ls -1 *.js 2>/dev/null | sort)"
SRC_MJS="$(cd "$SOURCE/dist-supervisor" && ls -1 *.mjs 2>/dev/null | sort)"
if [ -z "$SRC_JS" ]; then
	echo "sync-embedded-extension: no .js artifacts in $SOURCE/dist — run the source build." >&2
	exit 2
fi
if [ -z "$SRC_MJS" ]; then
	echo "sync-embedded-extension: no .mjs artifacts in $SOURCE/dist-supervisor — run the source build." >&2
	exit 2
fi

# ---- (3) verify the bundled supervisor sha256s match the SOURCE pins --------
# This is the load-bearing invariant: the shipped extension refuses to spawn a
# bundle whose on-disk sha256 != the pin compiled into dist/extension.js. If the
# pre-built artifacts are stale relative to the pins, fail BEFORE copying so we
# never embed a self-inconsistent copy.
HASH_TS="$SOURCE/src/supervisorHash.ts"
read_pin() {
	grep -oE "$1"'[[:space:]]*=[[:space:]]*'\''[0-9a-f]{64}'\''' "$HASH_TS" \
		| grep -oE '[0-9a-f]{64}' | head -n1
}
verify_pin() {
	# $1 = export const name, $2 = bundle basename
	local pin actual
	pin="$(read_pin "$1")"
	if [ -z "$pin" ]; then
		echo "sync-embedded-extension: could not read pin $1 from $HASH_TS" >&2
		exit 2
	fi
	actual="$(shasum -a 256 "$SOURCE/dist-supervisor/$2" | awk '{print $1}')"
	if [ "$pin" != "$actual" ]; then
		echo "sync-embedded-extension: STALE source artifact." >&2
		echo "  $2 sha256 ($actual)" >&2
		echo "  != pin $1 ($pin) in $HASH_TS" >&2
		echo "  Re-run the source build: (cd $SOURCE && npm run compile)" >&2
		exit 2
	fi
	echo "PASS: source $2 sha256 matches pin $1"
	echo "        $pin"
}
echo "--- verifying source supervisor pins ---"
verify_pin "BUNDLED_SUPERVISOR_SHA256"     "governed-run.mjs"
verify_pin "BUNDLED_BRIDGE_SERVER_SHA256"  "bridge-server.mjs"
echo

# ---- copy / check engine ----------------------------------------------------
# changes accumulates a human-readable list of what differs (check) / was copied
# (sync). diffs counts mismatches for the --check exit code.
changes=""
diffs=0

note_change() { changes="${changes}    $1"$'\n'; diffs=$((diffs + 1)); }

# Sync (or check) a single file. In --check mode, never writes; just records
# whether the destination already equals the source.
sync_file() {
	# $1 = source path, $2 = dest path, $3 = label
	local s="$1" d="$2" label="$3"
	if [ ! -f "$s" ]; then
		echo "sync-embedded-extension: source file missing during copy: $s" >&2
		exit 2
	fi
	if [ -f "$d" ] && cmp -s "$s" "$d"; then
		return 0
	fi
	if [ "$CHECK_ONLY" -eq 1 ]; then
		if [ -f "$d" ]; then
			note_change "MODIFIED: $label"
		else
			note_change "MISSING:  $label"
		fi
		return 0
	fi
	mkdir -p "$(dirname "$d")"
	cp -p "$s" "$d"
	note_change "wrote:    $label"
}

# Sync a directory restricted to a glob; also removes embedded files matching the
# same glob that no longer exist in source (so a removed entrypoint disappears).
# $1 = source dir, $2 = dest dir, $3 = glob (e.g. '*.js'), $4 = label prefix
sync_dir_glob() {
	local sdir="$1" ddir="$2" glob="$3" prefix="$4"
	local sset dset f
	sset="$(cd "$sdir" && ls -1 $glob 2>/dev/null | sort)"
	# copy/check each source entry
	while IFS= read -r f; do
		[ -n "$f" ] || continue
		sync_file "$sdir/$f" "$ddir/$f" "$prefix/$f"
	done <<<"$sset"
	# detect embedded-only entries matching the glob (stale, should be removed)
	if [ -d "$ddir" ]; then
		dset="$(cd "$ddir" && ls -1 $glob 2>/dev/null | sort)"
		while IFS= read -r f; do
			[ -n "$f" ] || continue
			if ! printf '%s\n' "$sset" | grep -qxF "$f"; then
				if [ "$CHECK_ONLY" -eq 1 ]; then
					note_change "STALE:    $prefix/$f (in embedded, not in source)"
				else
					rm -f "$ddir/$f"
					note_change "removed:  $prefix/$f (stale, not in source)"
				fi
			fi
		done <<<"$dset"
	fi
}

# ---- (4) sync the artifacts -------------------------------------------------
sync_file "$SOURCE/package.json" "$EMBEDDED/package.json" "package.json"
[ -f "$SOURCE/README.md" ] && sync_file "$SOURCE/README.md" "$EMBEDDED/README.md" "README.md"
# dist/: ship the built .js set ONLY (no .map) — matches the embedded convention
# and the gate's expectation.
sync_dir_glob "$SOURCE/dist"            "$EMBEDDED/dist"            '*.js'  "dist"
sync_dir_glob "$SOURCE/dist-supervisor" "$EMBEDDED/dist-supervisor" '*.mjs' "dist-supervisor"
# media/: webview assets — copy everything (it's all shipped).
sync_dir_glob "$SOURCE/media"           "$EMBEDDED/media"           '*'     "media"

# ---- verdict ----------------------------------------------------------------
echo "=== verdict ==="
if [ "$CHECK_ONLY" -eq 1 ]; then
	if [ "$diffs" -gt 0 ]; then
		echo "RESULT: OUT OF SYNC — the embedded copy differs from source ($diffs change(s)):"
		printf '%s' "$changes" | sed '/^$/d'
		echo
		echo "  Re-sync with: bash build/glyphspek/sync-embedded-extension.sh"
		exit 1
	fi
	echo "RESULT: IN SYNC — embedded extension matches source; nothing to copy."
	exit 0
fi

if [ "$diffs" -eq 0 ]; then
	echo "RESULT: ALREADY IN SYNC — no files changed (idempotent no-op)."
else
	echo "RESULT: SYNCED — $diffs file(s) updated in $EMBEDDED:"
	printf '%s' "$changes" | sed '/^$/d'
fi
echo
echo "Next: bash build/glyphspek/verify-bundled-extensions.sh   (conformance gate)"
exit 0
