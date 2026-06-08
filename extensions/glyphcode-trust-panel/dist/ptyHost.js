"use strict";
/*
 * GlyphCode PTY HOST (extension-local) — load node-pty resiliently and spawn an
 * interactive child under a real PTY for the Chat terminal view. MIRRORS
 * spikes/p0-governed-pty/governed-pty.ts (the spike that PROVED the mechanism); the
 * extension is a separate build package and cannot import the spikes tree at build
 * time, so the load-bearing pieces are restated here (exactly as the env contract is
 * mirrored in governedTerminalEnv.ts).
 *
 * THE MECHANISM (proven in the spike): node-pty 1.1.0 ships PREBUILT bindings
 * (darwin-arm64/x64, win32) so require('node-pty') needs NO compile. It allocates a
 * genuine pty so interactive `claude` sees a TTY and renders its TUI; we read the
 * master via onData and inject keystrokes via write(). The ONE prebuild gotcha — the
 * npm tarball drops the exec bit on the unix `spawn-helper`, yielding
 * "posix_spawnp failed" — is repaired by {@link ensurePtyExecBits} before the first
 * spawn. (The BSD `script` allocator was evaluated and rejected: it requires a real
 * controlling TTY on its own stdin, which a webview-hosted host does not have.)
 *
 * node: built-ins only here; node-pty is the only non-builtin and is loaded through a
 * try/catch so its absence degrades to an honest empty state, never a hard crash.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clampPtySize = clampPtySize;
exports.ensurePtyExecBits = ensurePtyExecBits;
exports.deriveAppNodeModulesDir = deriveAppNodeModulesDir;
exports.loadNodePty = loadNodePty;
exports.spawnGovernedPty = spawnGovernedPty;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_module_1 = require("node:module");
const MIN = 1;
const MAX = 1000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Clamp a (possibly 0/NaN/huge) requested size to a valid pty winsize. PURE. */
function clampPtySize(size) {
    const c = size?.cols;
    const r = size?.rows;
    const cols = Number.isFinite(c) && c >= MIN ? Math.min(Math.floor(c), MAX) : DEFAULT_COLS;
    const rows = Number.isFinite(r) && r >= MIN ? Math.min(Math.floor(r), MAX) : DEFAULT_ROWS;
    return { cols, rows };
}
/* ── prebuild exec-bit repair (mirrors the spike) ────────────────────────── */
/**
 * Ensure node-pty's unix `spawn-helper` binaries are executable (the npm tarball
 * ships them mode 0644 → "posix_spawnp failed"). Returns the paths it fixed. Never
 * throws. win32 (conpty) has no spawn-helper and is simply skipped.
 */
function ensurePtyExecBits(nodePtyDir) {
    const fixed = [];
    const candidates = [
        (0, node_path_1.join)(nodePtyDir, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
        (0, node_path_1.join)(nodePtyDir, 'prebuilds', 'darwin-x64', 'spawn-helper'),
        (0, node_path_1.join)(nodePtyDir, 'build', 'Release', 'spawn-helper'),
    ];
    for (const p of candidates) {
        try {
            if (!(0, node_fs_1.existsSync)(p))
                continue;
            const st = (0, node_fs_1.statSync)(p);
            if ((st.mode & 0o111) === 0) {
                (0, node_fs_1.chmodSync)(p, 0o755);
                fixed.push(p);
            }
        }
        catch {
            // best-effort
        }
    }
    return fixed;
}
/**
 * Derive the RUNNING app's bundled-node-pty base dir from an Electron/Node exec path.
 * PURE (no fs, no vscode) so it is unit-testable on every platform.
 *
 * WHY (distribution): in the packaged GlyphCode.app the extension host runs under
 * Electron (node 24 / ABI 146 / Electron 42), and Code-OSS already ships a working,
 * correct-Electron-ABI `node-pty` at `Contents/Resources/app/node_modules/node-pty`
 * (its integrated terminal uses it). The extension itself ships NO node-pty. Relying on
 * Node's upward module walk to reach the app's node_modules is fragile — it only works
 * while the extension lives UNDER the app dir, and Electron filters node_modules paths
 * under resourcesPath. So we resolve the app's node_modules EXPLICITLY: from the exec
 * path we walk up to the app root and point at `<appRoot>/node_modules`, which is the
 * SAME directory the integrated terminal loads node-pty from — the right Electron-ABI
 * module for free, no bundling and no electron-rebuild.
 *
 * Mapping (macOS):  .../GlyphCode.app/Contents/MacOS/GlyphCode (execPath)
 *               ->  .../GlyphCode.app/Contents/Resources/app/node_modules
 * Mapping (linux/win, unpackaged dirs): <dir-of-exec>/resources/app/node_modules.
 * Returns undefined when no plausible app root is derivable (e.g. dev `node`/`tsx`),
 * so the caller simply falls through to its other candidate bases.
 */
function deriveAppNodeModulesDir(execPath) {
    if (!execPath)
        return undefined;
    const parts = execPath.split(/[\\/]/);
    // macOS app bundle: find the *.app then descend into Contents/Resources/app.
    const appIdx = parts.findIndex((p) => p.endsWith('.app'));
    if (appIdx >= 0) {
        const base = parts.slice(0, appIdx + 1);
        return [...base, 'Contents', 'Resources', 'app', 'node_modules'].join(node_path_1.sep);
    }
    // linux/windows layout: the executable sits next to a `resources/app` tree.
    const execDir = parts.slice(0, -1);
    if (execDir.length === 0)
        return undefined;
    return [...execDir, 'resources', 'app', 'node_modules'].join(node_path_1.sep);
}
/**
 * Try to load node-pty from a list of candidate base directories (in order). For each
 * base we createRequire from it, resolve node-pty's package dir, repair the exec bits,
 * and require it. Returns the first that loads, or undefined if none do (the caller
 * degrades to an honest empty state). The candidate bases let the extension find a
 * node-pty installed in its OWN node_modules (production target) OR in a dev spikes
 * tree (the proven spike install) without a hard dependency at this layer.
 */
function loadNodePty(candidateBaseDirs) {
    for (const base of candidateBaseDirs) {
        try {
            const req = (0, node_module_1.createRequire)(base.endsWith('/') ? base : `${base}/`);
            const pkgJson = req.resolve('node-pty/package.json');
            ensurePtyExecBits((0, node_path_1.dirname)(pkgJson));
            const mod = req('node-pty');
            if (mod && typeof mod.spawn === 'function')
                return mod;
        }
        catch {
            // try the next base
        }
    }
    return undefined;
}
/**
 * Spawn the interactive agent under a real PTY with the given governed env. The
 * returned session bridges PTY ⇄ webview xterm: onData → xterm.write, write ← xterm
 * onData, resize ← fit addon. The child sees a TTY and renders its interactive TUI.
 */
function spawnGovernedPty(opts) {
    const size = clampPtySize(opts.size);
    const child = opts.pty.spawn(opts.file, opts.args ?? [], {
        name: opts.term ?? 'xterm-256color',
        cols: size.cols,
        rows: size.rows,
        cwd: opts.cwd,
        env: opts.env,
    });
    return {
        onData: (cb) => child.onData(cb),
        onExit: (cb) => child.onExit(cb),
        write: (data) => child.write(data),
        resize: (s) => {
            const clamped = clampPtySize(s);
            try {
                child.resize(clamped.cols, clamped.rows);
            }
            catch {
                /* resize on an exited pty throws; ignore */
            }
        },
        kill: (signal) => {
            try {
                child.kill(signal);
            }
            catch {
                /* already dead */
            }
        },
        size,
    };
}
//# sourceMappingURL=ptyHost.js.map