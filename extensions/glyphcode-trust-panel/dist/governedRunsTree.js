"use strict";
/*
 * GlyphCode GOVERNED-RUNS TREE — the activity-bar "Governed Runs" view.
 *
 * A real vscode.TreeDataProvider backed by GovernedRunsModel (governedRunsModel.ts),
 * which is fed the SAME `run/event` stream the Trust Panel renders. Each row is a
 * run the extension actually observed this session — no placeholder rows. A row
 * shows:
 *   - the gs-* CREATION-TRUST posture icon (via the SHARED RUN_TRUST_BADGE map in
 *     runTrustBadge.ts — the host-side mirror of the webview's CREATION_TRUST_BADGE),
 *   - the honest creation-trust badge LABEL,
 *   - the actor + lifecycle status as the row description.
 * Clicking a row runs `glyphcode.runs.openRun` with the runId, which focuses the
 * Trust Panel on that run (where the full evidence + Ed25519 signature gate live).
 *
 * When the model is empty the view shows a `viewsWelcome` (declared in
 * package.json) with a "New Governed Terminal" button — the only honest first
 * action, since there is nothing to list until a governed run exists.
 *
 * Note: tree items are built with `new vscode.TreeItem(...)` at RUNTIME inside
 * getChildren (not via a module-load `extends vscode.TreeItem`), so requiring this
 * module never touches the vscode API at load time.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernedRunsTreeProvider = exports.OPEN_RUN_COMMAND = void 0;
exports.buildRunTreeItem = buildRunTreeItem;
const vscode = __importStar(require("vscode"));
const runTrustBadge_1 = require("./runTrustBadge");
/** The command a tree row fires on click: focus the Trust Panel on a run. */
exports.OPEN_RUN_COMMAND = 'glyphcode.runs.openRun';
/** Build one Governed Runs tree item from a run summary, honest label + icon. */
function buildRunTreeItem(summary, iconRoot) {
    const badge = (0, runTrustBadge_1.runTrustBadge)(summary.creationTrust);
    // The row LABEL is the honest creation-trust posture; the actor + runId + status
    // read as the secondary description so the trust posture is the first thing seen.
    const item = new vscode.TreeItem(badge.label, vscode.TreeItemCollapsibleState.None);
    const shortRunId = summary.runId.length > 28 ? summary.runId.slice(0, 27) + '…' : summary.runId;
    item.description = `${(0, runTrustBadge_1.actorLabel)(summary.actorType)} · ${summary.status}${summary.closed ? '' : ' (live)'} · ${shortRunId}`;
    item.tooltip = new vscode.MarkdownString([
        `**${summary.runId}**`,
        '',
        `Actor: \`${(0, runTrustBadge_1.actorLabel)(summary.actorType)}\``,
        `Creation trust: **${badge.label}**`,
        `Status: \`${summary.status}\`${summary.closed ? ' (closed)' : ' (live)'}`,
        `Product-trust eligible: ${badge.productTrustEligible ? 'yes (pending signature gate)' : 'no'}`,
        '',
        badge.description,
        '',
        '_Click to open the Trust Panel focused on this run._',
    ].join('\n'));
    // The TRUST-posture gs-* icon names the row's honest posture at a glance; the
    // actor identity rides in the description. (One icon slot per tree item.)
    const iconUri = vscode.Uri.joinPath(iconRoot, `${badge.icon}.svg`);
    item.iconPath = { light: iconUri, dark: iconUri };
    // contextValue lets future per-row menus target a run; harmless today.
    item.contextValue = summary.closed ? 'glyphcode.run.closed' : 'glyphcode.run.live';
    item.command = {
        command: exports.OPEN_RUN_COMMAND,
        title: 'Open Trust Panel for this run',
        arguments: [summary.runId],
    };
    return item;
}
/** TreeDataProvider for the Governed Runs view, backed by the run model. */
class GovernedRunsTreeProvider {
    constructor(model, extensionUri) {
        this.model = model;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        this.iconRoot = vscode.Uri.joinPath(extensionUri, 'media', 'icons');
        // Refresh the tree whenever a run/event updates the model.
        this.modelSub = this.model.onDidChange(() => this.emitter.fire());
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        // Flat list: runs are top-level rows; there are no child nodes (the run's
        // detail lives in the Trust Panel, not nested tree nodes).
        if (element)
            return [];
        return this.model.list().map((s) => buildRunTreeItem(s, this.iconRoot));
    }
    dispose() {
        this.modelSub.dispose();
        this.emitter.dispose();
    }
}
exports.GovernedRunsTreeProvider = GovernedRunsTreeProvider;
//# sourceMappingURL=governedRunsTree.js.map