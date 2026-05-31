"use strict";
/*
 * GlyphSpek AGENT-CLI DETECTION — extension-local, headlessly-testable PATH scan for
 * an installed coding-agent CLI (claude / codex). Mirrors the spike launcher's
 * detectAgentCli (spikes/p0-governed-cli/cli-agent-launcher.ts); the extension is a
 * SEPARATE build package and cannot import the spikes tree, so the detection is
 * restated here (node:fs/path/os only — no which/execa/cross-spawn deps).
 *
 * This is detection ONLY — it does NOT spawn anything. The Governed Terminal command
 * uses it to make `claude`/`codex` ergonomic to launch inside the governed terminal
 * (pre-typing the command for the operator to run), never to force-run a CLI.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWN_AGENT_CLIS = void 0;
exports.resolveOnPath = resolveOnPath;
exports.detectAgentCli = detectAgentCli;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
/** The agent CLIs we look for on PATH, highest preference first. */
exports.KNOWN_AGENT_CLIS = ['claude', 'codex'];
/** The candidate executable basenames for `agent` on the current platform. */
function candidateNames(agent) {
    if ((0, node_os_1.platform)() === 'win32') {
        return [`${agent}.cmd`, `${agent}.exe`, `${agent}.bat`, agent];
    }
    return [agent];
}
/** True iff `p` exists and is an executable regular file (best-effort, no deps). */
function isExecutableFile(p) {
    try {
        const st = (0, node_fs_1.statSync)(p);
        if (!st.isFile())
            return false;
        if ((0, node_os_1.platform)() !== 'win32')
            (0, node_fs_1.accessSync)(p, node_fs_1.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Resolve `agent` on PATH by scanning PATH entries directly (a which-style lookup
 * with no external dependency). Returns the first executable match's absolute path,
 * or undefined. PATH source is INJECTABLE so tests can point at a fixture dir.
 */
function resolveOnPath(agent, env = process.env) {
    const rawPath = env.PATH ?? env.Path ?? '';
    if (rawPath.length === 0)
        return undefined;
    const dirs = rawPath.split(node_path_1.delimiter).filter((d) => d.length > 0);
    for (const dir of dirs) {
        for (const name of candidateNames(agent)) {
            const full = (0, node_path_1.join)(dir, name);
            if (isExecutableFile(full))
                return full;
        }
    }
    return undefined;
}
/**
 * Detect an installed agent CLI, trying {@link KNOWN_AGENT_CLIS} in preference order
 * (`claude`, then `codex`). Returns the first found, or undefined if none is
 * installed. The env (and thus PATH) is injectable for tests.
 */
function detectAgentCli(env = process.env) {
    for (const agent of exports.KNOWN_AGENT_CLIS) {
        const path = resolveOnPath(agent, env);
        if (path)
            return { agent, path };
    }
    return undefined;
}
//# sourceMappingURL=agentCli.js.map