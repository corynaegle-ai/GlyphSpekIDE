"use strict";
/*
 * GlyphStudio AGENT-CLI LAUNCH RESOLUTION — pure, headlessly-testable helpers that PIN
 * the EXACT binary a governed chat auto-runs (sweep-27 High). NO vscode dependency
 * (node:fs/path only), so it compiles to dist/ and is unit-tested under node:test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PATH-SHADOW RISK (sweep-27 High). detectAgentCli() returns the ABSOLUTE path
 * it resolved on PATH, AND the modal confirm names a CLI — but the governed-chat
 * auto-run historically sent the BARE NAME (`claude`) into the terminal. The
 * governed terminal PRESERVES PATH (governedTerminalEnv.ts), so the shell
 * RE-RESOLVES that bare name at exec time: a workspace-local `./claude` or a
 * PATH-injected shim could run a DIFFERENT binary than the one detected/confirmed,
 * between the modal confirm and the launch.
 *
 * THE FIX. We (1) CANONICALIZE the detected path (resolve symlinks) and launch THAT
 * absolute path — shell-quoted — so the exact inode that detection found is the one
 * that runs, regardless of any PATH mutation; and (2) REJECT auto-run when the
 * canonical path resolves UNDER a workspace folder (the red flag for a repo-supplied
 * shim). A normal system/user path (/usr/local/bin, /opt/homebrew/bin, ~/.local/bin,
 * ~/.claude/…) is trusted and auto-runs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalizeLaunchPath = canonicalizeLaunchPath;
exports.isPathUnderRoot = isPathUnderRoot;
exports.isWorkspaceLocalPath = isWorkspaceLocalPath;
exports.posixShellQuote = posixShellQuote;
exports.resolveAgentLaunch = resolveAgentLaunch;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * Best-effort canonicalize a path for COMPARISON, robust to the path not existing.
 * realpathSync resolves symlinks (e.g. macOS /var → /private/var) but throws when the
 * leaf is missing; so we canonicalize the DEEPEST existing ancestor and re-append the
 * non-existent tail. Falls back to a plain absolute-normalize if nothing resolves. This
 * makes a `/var/tmp/ws` root and an only-absolute `/var/tmp/ws/bin/claude` target
 * compare like-for-like even when the target file does not exist yet.
 */
function canonicalizeForCompare(p) {
    const abs = (0, node_path_1.resolve)(p);
    try {
        return (0, node_fs_1.realpathSync)(abs);
    }
    catch {
        // Leaf (or deeper) does not exist: resolve the existing ancestor, keep the tail.
        const parent = (0, node_path_1.dirname)(abs);
        if (parent === abs)
            return abs; // reached the root
        return (0, node_path_1.join)(canonicalizeForCompare(parent), (0, node_path_1.basename)(abs));
    }
}
/**
 * CANONICALIZE a resolved executable path: resolve symlinks (and `.`/`..`) to the
 * real on-disk target via {@link realpathSync}. Pinning the CANONICAL path means a
 * symlink that is re-pointed after detection cannot redirect the launch — the exact
 * inode detection found is the one we run. Falls back to an absolute-normalized form
 * if realpath fails (e.g. the file vanished); the caller still launches an absolute
 * path, never a bare name.
 */
function canonicalizeLaunchPath(resolvedPath) {
    try {
        return (0, node_fs_1.realpathSync)(resolvedPath);
    }
    catch {
        // realpath failed (race / permission / vanished): still return an ABSOLUTE,
        // normalized path so the launch is never a bare, PATH-re-resolved name.
        return (0, node_path_1.resolve)(resolvedPath);
    }
}
/**
 * True iff `target` resolves to a location AT OR UNDER `root` (a containment test on
 * canonicalized absolute paths). Uses path.relative so `/ws-evil` is NOT treated as
 * under `/ws` (a prefix-string check would wrongly match). Both inputs should already
 * be absolute; `root` is canonicalized for a like-for-like comparison.
 */
function isPathUnderRoot(target, root) {
    if (!target || !root)
        return false;
    // Canonicalize BOTH sides (best-effort) so a /var → /private/var style symlinked
    // tmp/home root and an only-absolute target are compared like-for-like.
    const canonTarget = canonicalizeForCompare(target);
    const canonRoot = canonicalizeForCompare(root);
    const rel = (0, node_path_1.relative)(canonRoot, canonTarget);
    // Same dir ⇒ rel === '' ; a child ⇒ rel has no leading '..' and is not absolute.
    if (rel === '')
        return true;
    return !rel.startsWith(`..${node_path_1.sep}`) && rel !== '..' && !(0, node_path_1.isAbsolute)(rel);
}
/**
 * True iff `target` resolves AT OR UNDER ANY of `roots` (the workspace folders). This
 * is the WORKSPACE-LOCAL red flag: a CLI binary that lives inside the repo being
 * worked on is exactly the swap a malicious repo would plant, so we do NOT auto-run it.
 */
function isWorkspaceLocalPath(target, roots) {
    for (const root of roots) {
        if (isPathUnderRoot(target, root))
            return true;
    }
    return false;
}
/**
 * POSIX single-quote a path for safe injection into a shell command line. Wraps in
 * single quotes (which suppress ALL shell expansion) and escapes any embedded single
 * quote via the standard `'\''` close-reopen idiom, so a path with spaces, `$`, `;`,
 * `&`, or quotes runs the EXACT file and cannot inject extra shell words. Used to send
 * the canonical absolute launch path into the governed terminal verbatim.
 */
function posixShellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
 * Resolve how to auto-run a detected agent CLI: canonicalize the detected absolute
 * path, decide whether it is trusted (NOT workspace-local) for auto-run, and produce
 * the shell-quoted token to send. PURE; exported for direct unit-testing. The caller
 * (extension.ts) supplies the workspace-folder roots from vscode.
 */
function resolveAgentLaunch(resolvedPath, workspaceRoots) {
    const launchPath = canonicalizeLaunchPath(resolvedPath);
    const workspaceLocal = isWorkspaceLocalPath(launchPath, workspaceRoots);
    return {
        launchPath,
        launchCommand: posixShellQuote(launchPath),
        trustedForAutoRun: !workspaceLocal,
        workspaceLocal,
    };
}
//# sourceMappingURL=agentLaunch.js.map