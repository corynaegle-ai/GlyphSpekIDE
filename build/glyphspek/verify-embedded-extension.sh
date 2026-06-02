#!/usr/bin/env bash
# GlyphSpek — source <-> fork-embedded extension conformance gate (Sweep-20 F2).
#
# WHAT THIS CHECKS
#   The fork embeds a VENDORED COPY of the first-party extension at
#   extensions/glyphspek-trust-panel/. That copy is built/bundled out-of-band
#   from the canonical SOURCE tree (../extension, sibling to this repo). Because
#   the embedded copy is a snapshot, it can silently go STALE — missing new
#   commands (e.g. glyphspek.startLiveRun), a renamed dist/ file set, or a
#   supervisor bundle whose hash no longer matches the pinned one. A stale copy
#   ships a different app than the green source tree, which is exactly the
#   Sweep-20 F2 drift we must not allow.
#
#   This gate compares the EMBEDDED copy against the SOURCE and FAILS on any
#   drift across four surfaces:
#     (1) Command IDs        — contributes.commands[].command (package.json)
#     (2) Activation events  — activationEvents[]              (package.json)
#     (3) dist/ file set     — the built .js entrypoints shipped to dist/
#     (4) dist-supervisor/   — the bundled supervisor entrypoint .mjs set
#     (5) Pinned hashes      — src/supervisorHash.ts BUNDLED_*_SHA256 (SOURCE)
#                              must equal the sha256 of the EMBEDDED bundled
#                              .mjs the runtime gates spawn.
#     (6) API-proposal grants — every proposal the extension DECLARES
#                              (package.json enabledApiProposals) must be GRANTED to
#                              the real extension id (publisher.name) in
#                              product.json extensionEnabledApiProposals. A declared
#                              proposal with no grant, or a grant under the wrong id,
#                              fails. product.json may grant a superset.
#
#   (5) is the load-bearing one: the extension's runtime refuses to spawn a
#   supervisor bundle whose on-disk sha256 != the constant compiled into
#   dist/extension.js. If the embedded .mjs drifts from the SOURCE pin, the
#   shipped extension would refuse its own supervisor at runtime.
#
# USAGE
#   build/glyphspek/verify-embedded-extension.sh [SOURCE_DIR] [EMBEDDED_DIR]
#
#   SOURCE_DIR   defaults to the first that exists:
#                  $GLYPHSPEK_EXTENSION_SOURCE
#                  ../extension                 (sibling to repo root)
#                  ../../extension
#   EMBEDDED_DIR defaults to extensions/glyphspek-trust-panel (in this repo).
#
# EXIT CODES
#   0 = embedded copy conforms to source on all five surfaces.
#   1 = drift detected (the embedded copy is stale / out of sync).
#   2 = source or embedded tree not found, or a required file is missing.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ---- resolve source + embedded trees ----------------------------------------
SOURCE="${1:-}"
if [ -z "$SOURCE" ]; then
	for cand in \
		"${GLYPHSPEK_EXTENSION_SOURCE:-}" \
		"$REPO_ROOT/../extension" \
		"$REPO_ROOT/../../extension"; do
		[ -n "$cand" ] || continue
		if [ -d "$cand" ]; then SOURCE="$cand"; break; fi
	done
fi

EMBEDDED="${2:-$REPO_ROOT/extensions/glyphspek-trust-panel}"

if [ -z "$SOURCE" ] || [ ! -d "$SOURCE" ]; then
	echo "verify-embedded-extension: SOURCE extension tree not found." >&2
	echo "  Looked for: \$GLYPHSPEK_EXTENSION_SOURCE, ../extension, ../../extension" >&2
	echo "  Pass an explicit path: $0 /path/to/extension" >&2
	exit 2
fi
if [ ! -d "$EMBEDDED" ]; then
	echo "verify-embedded-extension: EMBEDDED extension not found at $EMBEDDED" >&2
	exit 2
fi

SOURCE="$(cd "$SOURCE" && pwd)"
EMBEDDED="$(cd "$EMBEDDED" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
	echo "verify-embedded-extension: python3 is required (JSON + sha256 compare)." >&2
	exit 2
fi
if ! command -v shasum >/dev/null 2>&1; then
	echo "verify-embedded-extension: shasum is required (bundle hash compare)." >&2
	exit 2
fi

echo "=== GlyphSpek source <-> embedded conformance gate (Sweep-20 F2) ==="
echo "source:   $SOURCE"
echo "embedded: $EMBEDDED"
echo

drift=0

# ---- helper: emit a sorted JSON-array field from package.json ---------------
# $1 = package.json path, $2 = python expr yielding an iterable of strings.
pkg_field() {
	python3 - "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
	d = json.load(f)
expr = sys.argv[2]
vals = eval(expr, {"d": d})  # expr is a hard-coded literal below, not user input
for v in sorted(vals):
	print(v)
PY
}

compare_set() {
	# $1 = human label, $2 = source list (newline), $3 = embedded list (newline)
	local label="$1" src="$2" emb="$3"
	if [ "$src" = "$emb" ]; then
		local n
		n="$(printf '%s\n' "$src" | sed '/^$/d' | wc -l | tr -d ' ')"
		echo "PASS: $label match ($n entries)"
		return 0
	fi
	echo "FAIL: $label DRIFT between source and embedded:"
	echo "  --- only in SOURCE ---"
	comm -23 <(printf '%s\n' "$src") <(printf '%s\n' "$emb") | sed 's/^/      + /' || true
	echo "  --- only in EMBEDDED ---"
	comm -13 <(printf '%s\n' "$src") <(printf '%s\n' "$emb") | sed 's/^/      - /' || true
	drift=$((drift + 1))
	return 1
}

SRC_PKG="$SOURCE/package.json"
EMB_PKG="$EMBEDDED/package.json"
for p in "$SRC_PKG" "$EMB_PKG"; do
	if [ ! -f "$p" ]; then
		echo "FAIL: missing package.json: $p"
		drift=$((drift + 1))
	fi
done

# ---- (1) command IDs --------------------------------------------------------
if [ -f "$SRC_PKG" ] && [ -f "$EMB_PKG" ]; then
	SRC_CMDS="$(pkg_field "$SRC_PKG" "[c['command'] for c in d.get('contributes',{}).get('commands',[])]")"
	EMB_CMDS="$(pkg_field "$EMB_PKG" "[c['command'] for c in d.get('contributes',{}).get('commands',[])]")"
	compare_set "command IDs (contributes.commands)" "$SRC_CMDS" "$EMB_CMDS"

	# ---- (2) activation events ----------------------------------------------
	SRC_ACT="$(pkg_field "$SRC_PKG" "d.get('activationEvents',[])")"
	EMB_ACT="$(pkg_field "$EMB_PKG" "d.get('activationEvents',[])")"
	compare_set "activation events (activationEvents)" "$SRC_ACT" "$EMB_ACT"
fi
echo

# ---- (3) dist/ built .js file set -------------------------------------------
# The embedded copy ships .js only (no .map). Compare the .js set RECURSIVELY (by
# path relative to dist/, so subdirs like dist/surfaces/ are included) — a flat
# `ls -1 *.js` silently ignored the dist/surfaces/ subfolder and let a missing
# module (the rail governance-surface providers) slip through.
if [ -d "$SOURCE/dist" ] && [ -d "$EMBEDDED/dist" ]; then
	SRC_DIST="$(cd "$SOURCE/dist" && find . -type f -name '*.js' ! -name '*.map' | sed 's|^\./||' | sort)"
	EMB_DIST="$(cd "$EMBEDDED/dist" && find . -type f -name '*.js' ! -name '*.map' | sed 's|^\./||' | sort)"
	compare_set "dist/ .js file set" "$SRC_DIST" "$EMB_DIST"
else
	echo "FAIL: dist/ directory missing (source: $SOURCE/dist, embedded: $EMBEDDED/dist)"
	drift=$((drift + 1))
fi
echo

# ---- (4) dist-supervisor/ entrypoint set ------------------------------------
if [ -d "$SOURCE/dist-supervisor" ] && [ -d "$EMBEDDED/dist-supervisor" ]; then
	SRC_SUP="$(cd "$SOURCE/dist-supervisor" && ls -1 *.mjs 2>/dev/null | sort)"
	EMB_SUP="$(cd "$EMBEDDED/dist-supervisor" && ls -1 *.mjs 2>/dev/null | sort)"
	compare_set "dist-supervisor/ .mjs entrypoint set" "$SRC_SUP" "$EMB_SUP"
else
	echo "FAIL: dist-supervisor/ directory missing"
	echo "      (source: $SOURCE/dist-supervisor, embedded: $EMBEDDED/dist-supervisor)"
	drift=$((drift + 1))
fi
echo

# ---- (5) pinned supervisor hashes vs embedded bundle sha256 -----------------
# The SOURCE owns the pins (src/supervisorHash.ts). The runtime spawns the
# EMBEDDED .mjs and checks its sha256 against those pins, so the embedded bundle
# sha256 MUST equal the SOURCE pin or the shipped extension refuses to spawn.
HASH_TS="$SOURCE/src/supervisorHash.ts"
if [ ! -f "$HASH_TS" ]; then
	echo "FAIL: source hash module missing: $HASH_TS"
	drift=$((drift + 1))
else
	read_pin() {
		# $1 = export const name
		grep -oE "$1[[:space:]]*=[[:space:]]*'[0-9a-f]{64}'" "$HASH_TS" \
			| grep -oE "[0-9a-f]{64}" | head -n1
	}
	embedded_sha() {
		# $1 = bundle basename under dist-supervisor/
		local f="$EMBEDDED/dist-supervisor/$1"
		[ -f "$f" ] || { echo "MISSING"; return; }
		shasum -a 256 "$f" | awk '{print $1}'
	}

	check_pin() {
		# $1 = label, $2 = export const, $3 = embedded .mjs basename
		local label="$1" pin embedded
		pin="$(read_pin "$2")"
		embedded="$(embedded_sha "$3")"
		if [ -z "$pin" ]; then
			echo "FAIL: $label — could not read pin $2 from $HASH_TS"
			drift=$((drift + 1))
			return 1
		fi
		if [ "$embedded" = "MISSING" ]; then
			echo "FAIL: $label — embedded dist-supervisor/$3 is missing"
			drift=$((drift + 1))
			return 1
		fi
		if [ "$pin" = "$embedded" ]; then
			echo "PASS: $label — embedded $3 sha256 matches source pin $2"
			echo "        $pin"
			return 0
		fi
		echo "FAIL: $label — embedded $3 sha256 != source pin $2"
		echo "        source pin ($2): $pin"
		echo "        embedded $3:      $embedded"
		drift=$((drift + 1))
		return 1
	}

	check_pin "governed-run supervisor hash" "BUNDLED_SUPERVISOR_SHA256" "governed-run.mjs"
	check_pin "bridge-server supervisor hash" "BUNDLED_BRIDGE_SERVER_SHA256" "bridge-server.mjs"
fi
echo

# ---- (6) API-proposal grant conformance (sweep finding #3) ------------------
# The extension DECLARES the API proposals it needs in package.json
# (enabledApiProposals, e.g. "defaultChatParticipant", which the chat participant's
# isDefault:true depends on). The FORK GRANTS proposals per-extension in product.json
# (extensionEnabledApiProposals["<publisher>.<name>"]). Nothing previously asserted
# the two AGREE: a renamed publisher/name, a new declared proposal with no grant, or a
# grant keyed to the WRONG id would silently disable the proposal at runtime (the chat
# panel would stop defaulting / refuse to send) with a green build.
#
# This subgate asserts, for the REAL extension id (publisher.name, which surfaces (1/2)
# already proved the embedded copy matches source on):
#   - product.json grants that EXACT id (the granted id is not stale/misspelled), and
#   - every proposal the extension declares in enabledApiProposals is in that grant.
# product.json may grant a SUPERSET (extra granted proposals are fine); a DECLARED
# proposal with NO grant — or a grant under the wrong id — FAILS.
PRODUCT_JSON="$REPO_ROOT/product.json"
if [ ! -f "$PRODUCT_JSON" ]; then
	echo "FAIL: product.json not found at $PRODUCT_JSON (cannot verify proposal grants)"
	drift=$((drift + 1))
elif [ ! -f "$SRC_PKG" ] || [ ! -f "$EMB_PKG" ]; then
	echo "FAIL: package.json missing — cannot verify API-proposal grant conformance"
	drift=$((drift + 1))
else
	# The check runs against the SOURCE package.json (the canonical declaration); (1/2)
	# already fail the gate when the embedded package.json drifts from source, so the
	# SOURCE is authoritative for what the shipped extension declares.
	PROPOSAL_REPORT="$(python3 - "$SRC_PKG" "$EMB_PKG" "$PRODUCT_JSON" <<'PY'
import json, sys

src = json.load(open(sys.argv[1]))
emb = json.load(open(sys.argv[2]))
product = json.load(open(sys.argv[3]))

problems = []

def ext_id(pkg, which):
    pub = pkg.get("publisher")
    name = pkg.get("name")
    if not pub or not name:
        problems.append(f"{which} package.json missing publisher/name (publisher={pub!r}, name={name!r})")
        return None
    return f"{pub}.{name}"

src_id = ext_id(src, "SOURCE")
emb_id = ext_id(emb, "EMBEDDED")
# The real shipped extension id. (1/2) already gate package.json drift, but assert the
# id itself matches between source and embedded so a renamed publisher/name cannot slip
# past via this surface either.
if src_id and emb_id and src_id != emb_id:
    problems.append(f"extension id DRIFT: SOURCE '{src_id}' != EMBEDDED '{emb_id}'")

ext_id_val = src_id

declared = src.get("enabledApiProposals", []) or []
# Contributed chat-participant ids and LM-provider vendors are reported for visibility
# and sanity (the participant id is publisher-namespaced as '<name>.<...>').
participant_ids = [c.get("id") for c in src.get("contributes", {}).get("chatParticipants", [])]
lm_vendors = [c.get("vendor") for c in src.get("contributes", {}).get("languageModelChatProviders", [])]

grants = product.get("extensionEnabledApiProposals", {}) or {}

if ext_id_val is not None:
    granted = grants.get(ext_id_val)
    if granted is None:
        # The grant must be keyed to the REAL extension id. Surface near-misses to help.
        near = [k for k in grants.keys() if k.split(".")[-1] == ext_id_val.split(".")[-1] or k.split(".")[0] == ext_id_val.split(".")[0]]
        hint = f" (product.json has grants for: {sorted(grants.keys())}; possible misspelling: {near})" if grants else " (product.json grants nothing)"
        if declared:
            problems.append(f"product.json has NO extensionEnabledApiProposals grant for '{ext_id_val}', "
                            f"but the extension declares {declared}{hint}")
    else:
        granted_set = set(granted)
        for p in declared:
            if p not in granted_set:
                problems.append(f"declared API proposal '{p}' is NOT granted to '{ext_id_val}' in product.json "
                                f"(granted: {sorted(granted_set)})")

# Emit a compact summary line then the problems (if any).
print("SUMMARY id=%s declared=%s participants=%s lmVendors=%s grant=%s"
      % (ext_id_val, declared, participant_ids, lm_vendors,
         grants.get(ext_id_val) if ext_id_val else None))
for p in problems:
    print("PROBLEM " + p)
sys.exit(1 if problems else 0)
PY
	)"
	proposal_rc=$?
	# Echo the summary line for the operator.
	echo "$PROPOSAL_REPORT" | sed -n 's/^SUMMARY /  /p'
	if [ "$proposal_rc" -ne 0 ]; then
		echo "FAIL: API-proposal grant conformance DRIFT:"
		echo "$PROPOSAL_REPORT" | sed -n 's/^PROBLEM /      - /p'
		drift=$((drift + 1))
	else
		echo "PASS: API-proposal grants — every declared proposal is granted to the real extension id"
	fi
fi
echo

# ---- verdict ----------------------------------------------------------------
echo "=== verdict ==="
if [ "$drift" -gt 0 ]; then
	echo "RESULT: FAIL — $drift conformance drift(s) between the SOURCE extension and"
	echo "        the fork-embedded copy at extensions/glyphspek-trust-panel/."
	echo "        Re-sync with the canonical command (do NOT copy files by hand):"
	echo "            bash build/glyphspek/sync-embedded-extension.sh"
	echo "        (or 'sync-embedded-extension.sh --check' to see the diff without writing)."
	exit 1
fi
echo "RESULT: PASS — embedded extension conforms to source (commands, activation,"
echo "        dist/ set, dist-supervisor/ set, pinned supervisor hashes, and the"
echo "        product.json API-proposal grants match the real extension id)."
exit 0
