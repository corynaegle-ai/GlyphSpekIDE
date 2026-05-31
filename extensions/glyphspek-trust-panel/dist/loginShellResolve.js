"use strict";
/*
 * GlyphSpek LOGIN-SHELL AGENT RESOLUTION (the Dock-PATH bug).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM. When GlyphSpek.app is launched from the macOS Dock (or Finder), the
 * process inherits a STRIPPED, system-default PATH — typically just
 * `/usr/bin:/bin:/usr/sbin:/sbin` — and NOT the PATH the user gets in a real terminal.
 * The user's `claude` (and `codex`) commonly live under `~/.local/bin` (or a Homebrew /
 * nvm / asdf shim dir) that is added by their shell rc/profile. Our extension-PATH scan
 * (agentCli.detectAgentCli) therefore finds NOTHING, even though `claude` runs fine from
 * the user's own terminal. The user sees "claude isn't found" and is stuck.
 *
 * THE FIX. As a FALLBACK after the extension-PATH scan, ask the user's OWN login+
 * interactive shell where the agent is — the shell sources the same rc/profile that
 * sets up `~/.local/bin` et al., so `command -v <agent>` resolves the SAME binary the
 * user's terminal would. We run the resolved ABSOLUTE path (validated executable) under
 * the governed PTY; the launch is still pinned + binary-identity captured by the caller.
 *
 * SAFETY. This module only READS a path (it never spawns the agent), validates the
 * result is an ABSOLUTE, existing, executable file, and NEVER throws — any timeout,
 * spawn error, non-zero exit, or non-absolute/non-exec result yields undefined so the
 * caller degrades to an honest "couldn't find Claude Code / Codex" empty state.
 * ─────────────────────────────────────────────────────────────────────────────
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAgentViaLoginShell = resolveAgentViaLoginShell;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/** True iff `p` is an existing, executable regular file (best-effort, never throws). */
function isExecutableFile(p) {
    try {
        const st = (0, node_fs_1.statSync)(p);
        if (!st.isFile())
            return false;
        if (process.platform !== 'win32')
            (0, node_fs_1.accessSync)(p, node_fs_1.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The shell command that prints the resolved absolute path of `agent`. fish does not
 * have POSIX `command -v`; it uses `type -p`. Both print an absolute path (or nothing)
 * when the binary is on the shell's PATH after sourcing the user's profile.
 */
function resolveCommandFor(shell, agent) {
    if (shell.endsWith('fish'))
        return `type -p ${agent}`;
    return `command -v ${agent}`;
}
/**
 * Pick the agent path out of the shell's stdout: take the trimmed non-empty lines and
 * return the first one that is an ABSOLUTE, executable path. (Login/interactive shells
 * can emit rc-file banner noise on other lines; `command -v`/`type -p` print the path on
 * its own line, so scanning for the first valid absolute exec is robust to that noise.)
 */
function pickResolvedPath(stdout) {
    const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    for (const line of lines) {
        if ((0, node_path_1.isAbsolute)(line) && isExecutableFile(line))
            return line;
    }
    return undefined;
}
/**
 * Resolve `agent` via the user's LOGIN + INTERACTIVE shell, so the shell sources the
 * same rc/profile that puts `~/.local/bin` (Homebrew, nvm, asdf, …) on PATH. Returns the
 * validated absolute executable path, or undefined.
 *
 * Implementation: run `$SHELL -l -i -c '<resolve cmd>'` (fish: `type -p`, else
 * `command -v`), 5s timeout. NEVER throws — any error/timeout/non-absolute/non-exec
 * result → undefined, so the caller falls through to an honest not-found empty state.
 */
function resolveAgentViaLoginShell(agent) {
    // Windows shells do not use POSIX login-shell PATH sourcing; this fallback is for the
    // macOS/Linux Dock-PATH problem only. The extension-PATH scan covers Windows.
    if (process.platform === 'win32')
        return undefined;
    const shell = process.env.SHELL || '/bin/zsh';
    const command = resolveCommandFor(shell, agent);
    try {
        const result = (0, node_child_process_1.spawnSync)(shell, ['-l', '-i', '-c', command], {
            encoding: 'utf8',
            timeout: 5000,
        });
        if (!result || result.error || typeof result.stdout !== 'string')
            return undefined;
        const path = pickResolvedPath(result.stdout);
        return path ? { path } : undefined;
    }
    catch {
        // spawnSync can throw on a bad shell path / EACCES; degrade silently.
        return undefined;
    }
}
//# sourceMappingURL=loginShellResolve.js.map