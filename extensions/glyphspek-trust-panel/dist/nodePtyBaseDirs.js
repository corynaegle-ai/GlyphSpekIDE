"use strict";
/*
 * GlyphSpek NODE-PTY LOAD-PATH CANDIDATES (sweep-30 F4) — a PURE, vscode-free helper
 * that computes, in order, the directories the sidebar Chat tries to load node-pty from.
 *
 * Kept in its own module (rather than inline in extension.ts) for two reasons: (1) it is
 * pure and unit-testable without an ExtensionContext, and (2) extension.ts must export
 * ONLY its activation contract (activate/deactivate) — a security invariant — so helpers
 * that want to be exported for tests live beside it instead.
 *
 * F4 HARDENING. node-pty is a NATIVE module (it dlopen's a .node). Its load directory
 * must therefore be FIRST-PARTY / trusted. We removed glyphspek.supervisorPath from the
 * candidate list: a general dev setting (especially one a workspace could try to set)
 * must never select which directory a native module is loaded from. The dev-spikes
 * fallback that keeps `npm test` working is taken from a DEDICATED env hint instead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeNodePtyBaseDirs = computeNodePtyBaseDirs;
const node_path_1 = require("node:path");
const ptyHost_1 = require("./ptyHost");
/**
 * Candidate base dirs to resolve node-pty from, in order:
 *   (1) PRIMARY — the RUNNING app's bundled, FIRST-PARTY node_modules. Code-OSS already
 *       ships a correct Electron-ABI node-pty there (its integrated terminal uses it).
 *       This is the DISTRIBUTION path: in the packaged GlyphSpek.app the extension host
 *       is Electron, so a node-built node-pty wouldn't load and the extension ships none;
 *       resolving the app's OWN node-pty gives the right-ABI module for free. Derived two
 *       ways (deduped): appRoot (canonical) and execPath (works when appRoot is unset,
 *       e.g. the ext-host test harness). deriveAppNodeModulesDir is pure + unit-tested.
 *   (2) the extension's own install dir (in case a node-pty is ever vendored there);
 *   (3) DEV fallback — the spikes root, so `npm test`/dev keep working. NOT supervisorPath.
 * The first that resolves wins; if none do, the chat surfaces an honest empty state.
 */
function computeNodePtyBaseDirs(inputs) {
    const bases = [];
    // (1) PRIMARY: the running app's bundled, first-party node_modules (Electron ABI).
    if (inputs.appRoot && inputs.appRoot.trim()) {
        bases.push((0, node_path_1.join)(inputs.appRoot.trim(), 'node_modules'));
    }
    const fromExec = (0, ptyHost_1.deriveAppNodeModulesDir)(inputs.execPath);
    if (fromExec && !bases.includes(fromExec)) {
        bases.push(fromExec);
    }
    // (2) The extension's own install dir (vendored node-pty, if ever present).
    if (inputs.extensionDir && !bases.includes(inputs.extensionDir)) {
        bases.push(inputs.extensionDir);
    }
    // (3) DEV fallback only: the spikes root, for `npm test`. Never supervisorPath (F4).
    if (inputs.devSpikesRoot && inputs.devSpikesRoot.trim()) {
        const dev = inputs.devSpikesRoot.trim();
        if (!bases.includes(dev))
            bases.push(dev);
    }
    return bases;
}
//# sourceMappingURL=nodePtyBaseDirs.js.map