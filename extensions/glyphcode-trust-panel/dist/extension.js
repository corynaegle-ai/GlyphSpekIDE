"use strict";
/*
 * GlyphCode Trust Panel — VS Code / Code-OSS extension host.
 *
 * This is the charter's Workstream-4 IDE surface (W1-19 / W1-27 / W1-28),
 * delivered as a PLAIN extension — no deep fork of the editor, no Microsoft
 * Marketplace dependency, Open-VSX-distributable, and no telemetry. It hosts the
 * existing standalone Trust Panel prototype verbatim inside a WebviewPanel.
 *
 * Division of trust:
 *   - The extension HOST (this file, Node) only reads run-bundle files off disk
 *     with node:fs and ships their RAW bytes to the webview. It deliberately
 *     does NOT parse, judge, or vouch for them.
 *   - The WEBVIEW (media/app.js) parses the trace, separates the actor's CLAIMS
 *     from the verifier's VERDICT, and VERIFIES the verifier's Ed25519 signature
 *     in-browser with Web Crypto BEFORE presenting any verdict as authoritative.
 *     The signature-before-display gate lives there and is unchanged.
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const supervisorRunner_1 = require("./supervisorRunner");
const supervisorBridgeRunner_1 = require("./supervisorBridgeRunner");
const governedTerminalEnv_1 = require("./governedTerminalEnv");
const agentCli_1 = require("./agentCli");
const agentLaunch_1 = require("./agentLaunch");
const loginShellResolve_1 = require("./loginShellResolve");
const agentBinaryIdentity_1 = require("./agentBinaryIdentity");
const chatTerminalView_1 = require("./chatTerminalView");
const ptyHost_1 = require("./ptyHost");
const nodePtyBaseDirs_1 = require("./nodePtyBaseDirs");
const inlineScript_1 = require("./inlineScript");
const chatParticipant_1 = require("./chatParticipant");
const inlineEdit_1 = require("./inlineEdit");
const terminalCmdK_1 = require("./terminalCmdK");
const commitMessage_1 = require("./commitMessage");
const indexStatusBar_1 = require("./indexStatusBar");
const indexProgress_1 = require("./indexProgress");
const inlineCompletion_1 = require("./inlineCompletion");
const ungovernedTerminalNotice_1 = require("./ungovernedTerminalNotice");
const ungovernedTerminalOpenNotice_1 = require("./ungovernedTerminalOpenNotice");
const governedFloatingTerminal_1 = require("./governedFloatingTerminal");
const autoImport_1 = require("./autoImport");
const bridgeProtocol_1 = require("./bridgeProtocol");
const policyHash_1 = require("./policyHash");
const runEventProtocol_1 = require("./runEventProtocol");
const mockRunStream_1 = require("./mockRunStream");
const webviewGestureGate_1 = require("./webviewGestureGate");
const configScope_1 = require("./configScope");
const governedRunsModel_1 = require("./governedRunsModel");
const agentRunSnapshot_1 = require("./agentRunSnapshot");
const agentRunDetail_1 = require("./agentRunDetail");
const governedRunsTree_1 = require("./governedRunsTree");
const agenticBuildReview_1 = require("./agenticBuildReview");
const agenticBuildPromotion_1 = require("./agenticBuildPromotion");
const statusBarSegments_1 = require("./statusBarSegments");
const haloChrome_1 = require("./haloChrome");
const provenanceGutter_1 = require("./provenanceGutter");
const governedRunsCardView_1 = require("./governedRunsCardView");
const surfaces_1 = require("./surfaces");
const verifyAutoTest_1 = require("./verifyAutoTest");
/** The file names that make up a run bundle, in load order. */
const BUNDLE_FILE_NAMES = [
    'trace.jsonl',
    'verdict.json',
    'verifier-public-key.pem',
    'actor-claims.json',
    // OPTIONAL per-run unified git diff (present only when the run edited files). The
    // commit-message feature binds a "Verified:" trailer against it; the bundle loader
    // recognizes it here so it surfaces alongside the other bundle files when present.
    'diff.patch',
];
/**
 * Per-file size cap (bytes). A single bundle file larger than this aborts the
 * load: the host reads each file fully into memory and posts it to the webview in
 * one message, so an incident-scale trace.jsonl could otherwise block the host
 * and then the webview while it parses/renders. 8 MiB is generous for a normal
 * run bundle while still bounding the synchronous read.
 */
const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;
/**
 * Total-bundle size cap (bytes) across all files in one load. Bounds the single
 * postMessage payload to the webview. 32 MiB covers a large multi-file bundle.
 */
const MAX_BUNDLE_TOTAL_BYTES = 32 * 1024 * 1024;
/**
 * workspaceState key recording that the operator chose "Always Allow in This Workspace"
 * at the governed-build authority modal. When set (true), subsequent governed builds in
 * THIS workspace skip the up-front modal (friction paid once per authority boundary, not
 * per build). Scoped to workspaceState so the grant never leaks across workspaces, and
 * cleared by `glyphcode.revokeBuildAuthority`.
 */
const BUILD_AUTHORITY_GRANTED_KEY = 'glyphcode.buildAuthority.granted';
/**
 * The module-private first-party webview gesture gate (sweep-20 High #3). One
 * instance per extension process, created on first use. It owns the operator-
 * gesture registry AND the trusted-run launchers, and is NEVER exported on the
 * public surface. Trusted-run launchers are reached ONLY via
 * gate.launchFromWebview, which TrustPanel calls from its webview message handler —
 * so only a genuine first-party webview gesture (the operator clicking a GlyphCode
 * Trust Panel button) can start a product-trusted run. A globally-invokable command
 * cannot mint a gesture or reach a launcher.
 */
let webviewGestureGate;
function getWebviewGestureGate() {
    if (!webviewGestureGate)
        webviewGestureGate = new webviewGestureGate_1.WebviewGestureGate();
    return webviewGestureGate;
}
/**
 * The module-private GOVERNED-RUNS MODEL backing the activity-bar "Governed Runs"
 * tree (governedRunsModel.ts / governedRunsTree.ts). One instance per extension
 * process. It is fed the SAME raw `run/event` envelopes the Trust Panel renders —
 * TrustPanel.postRunEvent feeds it on every event — so the sidebar lists exactly
 * the runs the extension actually observed (live bridge runs, governed terminals,
 * the demo feed), never an invented placeholder. The tree subscribes to its
 * onDidChange to refresh.
 */
let governedRunsModel;
function getGovernedRunsModel() {
    if (!governedRunsModel)
        governedRunsModel = new governedRunsModel_1.GovernedRunsModel();
    return governedRunsModel;
}
/**
 * The honest friction-tier vocabulary (BLENDED-WORKBENCH-SPEC §6). Mirrors the
 * webview's LADDER_TIERS. Used to validate the `glyphcodeTier` message before it
 * reaches the `glyphcode.tier` context-key so the fork chrome only ever sees a known
 * tier. FRICTION axis only — orthogonal to the assurance vocabulary.
 */
const FRICTION_TIERS = new Set([
    'ask',
    'inline',
    'governed',
    'sensitive',
    'sovereign',
]);
function isFrictionTier(value) {
    return FRICTION_TIERS.has(value);
}
/* ================================================================== *
 * TIER CONTROLLER (Blended Workbench PATCH-009) — the SINGLE writer of the
 * `glyphcode.tier` context-key, the one source feeding the two friction views.
 *
 * The friction tier (ask | inline | governed | sensitive | sovereign — §6) is set
 * from exactly two view controls, both of which route through here so there is NO
 * second writer of the context-key:
 *
 *   (1) The NATIVE title-bar Authority Ladder (fork, glyphcodeTitleLadder.ts) — its
 *       rung click invokes the `glyphcode.setTier` command, which calls set() here.
 *   (2) The WEBVIEW Trust Panel ladder — its rung click posts `glyphcodeTier`, whose
 *       host handler calls set() here.
 *
 * set() (a) de-dups + writes the `glyphcode.tier` context-key (the native ladder + the
 * editor-recede chrome read it), and (b) syncs the Trust Panel webview ladder if one is
 * open (so a native click reflects in the webview, and vice-versa via the no-echo
 * receiver in live.js). It NEVER force-opens the panel — the native ladder is the
 * canonical control and works with no webview present.
 *
 * VIEW-ONLY / ORTHOGONAL (§2.1, §6, §2.4): this is the FRICTION axis only. It carries
 * NO assurance, NEVER touches `glyphcode.authority` (the halo), and grants NOTHING. The
 * promote modal remains the only authority door.
 */
class TierController {
    /**
     * Set the effective friction tier. `sync` decides whether to echo to the webview
     * ladder: a NATIVE click syncs the webview; a WEBVIEW-originated set does NOT echo
     * back to the same webview (it already updated its own DOM) — that avoids a loop.
     * The caller MUST have validated the tier (isFrictionTier).
     */
    set(tier, options) {
        if (tier !== this.lastTier) {
            this.lastTier = tier;
            void vscode.commands.executeCommand('setContext', 'glyphcode.tier', tier);
        }
        if (options.syncWebview) {
            TrustPanel.syncLadderTier(tier);
        }
    }
    /** Clear the context-key back to its neutral (unset) state on teardown. */
    reset() {
        if (this.lastTier !== undefined) {
            this.lastTier = undefined;
            void vscode.commands.executeCommand('setContext', 'glyphcode.tier', undefined);
        }
    }
}
let tierController;
function getTierController() {
    if (!tierController) {
        tierController = new TierController();
    }
    return tierController;
}
/* ================================================================== *
 * RUN STATUS CONTROLLER (Slice 2 — status-bar segments + halo fallback +
 * the `glyphcode.authority` context-key).
 *
 * Owns the vscode side effects for three honest surfaces, all fed by the SAME
 * run/event stream the Trust Panel + Governed Runs view read (TrustPanel.
 * postRunEvent calls notify() on every event):
 *
 *   (1) STATUS-BAR SEGMENTS (§1.12 / §5.10): four items — `authority: <level>`
 *       (colored by ThemeColor to match the halo/assurance), `sandboxed worktree`,
 *       `N traced events`, `policy: .glyphcode/policy.yml`. Computed by the PURE
 *       StatusBarSegments model (statusBarSegments.ts), disposed on deactivate.
 *
 *   (2) HALO FALLBACK (§1.1/§2.2 option 1): an OPT-IN (glyphcode.halo.tintChrome,
 *       default OFF) tint of real chrome edges (titleBar/activityBar/statusBar) to
 *       the assurance color via workbench.colorCustomizations — FULLY REVERSIBLE
 *       (snapshot on first enable, restore on disable/deactivate). When OFF, the
 *       `authority:` segment + Slice 1's header accent are the honest backstop.
 *
 *   (3) The `glyphcode.authority` CONTEXT-KEY: set on every assurance change so the
 *       FUTURE FORK halo ring (§1.1) reads it with NO extension change.
 *
 * HONESTY (enforced here, not in styling): the ladder/manual-view never feeds this
 * — only real run facts do. `authority` reaches `verified` ONLY when the webview
 * posts a signature-VERIFIED confirmation (confirmVerified), the same gate the
 * verdict pane uses. The halo/`authority:` reflect ONLY the computed assurance.
 */
class RunStatusController {
    constructor() {
        this.model = new statusBarSegments_1.StatusBarSegments();
        this.attached = false;
        /** The last assurance level pushed to the context-key + halo (no-op guard). */
        this.lastAuthority = null;
        /** True while our tint is currently applied (so we only restore once). */
        this.haloApplied = false;
    }
    /**
     * Create the four status-bar items + wire the halo setting watcher. Idempotent.
     * The caller pushes the controller's dispose into context.subscriptions.
     */
    attach(context) {
        if (this.attached)
            return;
        this.attached = true;
        // Seed the policy file from the setting if one is configured (honest segment).
        const policyPath = vscode.workspace
            .getConfiguration('glyphcode')
            .get('policyPath');
        this.model.setPolicyFile(policyPath && policyPath.trim() ? policyPath.trim() : undefined);
        // The segments sit on the LEFT, ordered authority → sandbox → traced; policy on
        // the RIGHT. Lower priority = further right within an alignment. The status-bar
        // API is additive: if it is unavailable (a minimal host/test stub), we degrade
        // gracefully — the context-key + halo still work; we just render no items.
        const align = vscode.StatusBarAlignment;
        if (typeof vscode.window.createStatusBarItem === 'function' && align) {
            this.authorityItem = vscode.window.createStatusBarItem(align.Left, 100);
            this.sandboxItem = vscode.window.createStatusBarItem(align.Left, 99);
            this.tracedItem = vscode.window.createStatusBarItem(align.Left, 98);
            this.policyItem = vscode.window.createStatusBarItem(align.Right, 50);
            // Clicking the authority/traced segments reveals the Trust Panel (evidence).
            this.authorityItem.command = 'glyphcode.openTrustPanel';
            this.tracedItem.command = 'glyphcode.openTrustPanel';
            context.subscriptions.push(this.authorityItem, this.sandboxItem, this.tracedItem, this.policyItem);
        }
        // Re-apply/restore the halo + refresh the policy segment when settings change
        // (reversible toggle). Guarded so a stub host without the config event is safe.
        if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
            context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('glyphcode.halo.tintChrome')) {
                    void this.refreshHalo();
                }
                if (e.affectsConfiguration('glyphcode.policyPath')) {
                    const p = vscode.workspace
                        .getConfiguration('glyphcode')
                        .get('policyPath');
                    this.model.setPolicyFile(p && p.trim() ? p.trim() : undefined);
                    this.render();
                }
            }));
        }
        this.render();
    }
    /** Feed one raw run/event envelope (called by TrustPanel.postRunEvent). */
    notify(rawEvent) {
        if (this.model.ingest(rawEvent))
            this.render();
    }
    /** Focus the segments on a run (Governed Runs tree-row click). View-only. */
    focus(runId) {
        if (this.model.focus(runId))
            this.render();
    }
    /**
     * The webview confirmed (or revoked) a signature-VERIFIED authority for a run —
     * the ONLY path to a `verified` segment, since the host cannot run the Ed25519
     * gate. Honest: a later tamper posts verified:false and the run drops off blue.
     * Returns whether the canonical verified set actually CHANGED, so the caller can
     * advance the Agent View snapshot revision only on a real amber→blue flip / revert.
     */
    confirmVerified(runId, verified) {
        const changed = this.model.confirmVerified(runId, verified);
        if (changed)
            this.render();
        return changed;
    }
    /**
     * Whether the webview signature gate confirmed a verified authority for a run.
     * The Agent View snapshot (glyphcode.runs.snapshot) reads this canonical verified
     * set so its 'verified' row uses the SAME fact the status bar + gutter + cards do.
     */
    isVerified(runId) {
        return this.model.isVerified(runId);
    }
    /**
     * The CANONICAL per-run assurance level — the SAME computation the status bar
     * renders for the focused run, evaluated for any runId. The Agent View per-run
     * detail (glyphcode.runs.detail) reads this so the Slice-4 halo reflects the EXACT
     * authority the run earned — never an inflated or independently derived one. An
     * unknown/just-opened run is 'read'.
     */
    authorityFor(runId) {
        return this.model.authorityFor(runId);
    }
    /** Recompute all four segments + push the assurance to the context-key/halo. */
    render() {
        const v = this.model.compute();
        if (this.authorityItem) {
            this.authorityItem.text = '$(shield) ' + v.authorityText;
            this.authorityItem.color = authorityThemeColor(v.authority);
            this.authorityItem.tooltip =
                'GlyphCode assurance level for the focused run. Reflects the computed ' +
                    'assurance only — never more than the verifier proved.';
            this.authorityItem.show();
        }
        if (this.sandboxItem) {
            this.sandboxItem.text =
                (v.sandboxed ? '$(lock) ' : '$(unlock) ') + v.sandboxText;
            this.sandboxItem.tooltip = v.sandboxed
                ? 'The focused run executes in an approved isolation runtime (sandboxed worktree).'
                : 'The focused run is NOT in an approved isolation runtime — shown honestly.';
            this.sandboxItem.show();
        }
        if (this.tracedItem) {
            this.tracedItem.text = '$(list-ordered) ' + v.tracedText;
            this.tracedItem.tooltip =
                'Hash-chained trace events observed for the focused run.';
            this.tracedItem.show();
        }
        if (this.policyItem) {
            this.policyItem.text = '$(law) ' + v.policyText;
            this.policyItem.tooltip = 'Policy-as-code file governing the run.';
            this.policyItem.show();
        }
        // Push the assurance to the context-key + halo only when it actually changed.
        if (v.authority !== this.lastAuthority) {
            this.lastAuthority = v.authority;
            // The future FORK halo ring (§1.1) reads this SAME key — set it now so no
            // extension change is needed when the fork lands.
            void vscode.commands.executeCommand('setContext', 'glyphcode.authority', v.authority);
            void this.refreshHalo();
        }
    }
    /**
     * Apply or restore the OPT-IN chrome tint (glyphcode.halo.tintChrome). When ON,
     * tint the halo-key edges to the current assurance color; when OFF (or on
     * deactivate), restore the user's prior customizations EXACTLY. Reversible.
     */
    async refreshHalo() {
        // Guarded: the halo tint is additive + opt-in. A minimal host/test stub without
        // the configuration API simply skips it (the context-key still drives the fork).
        if (typeof vscode.workspace.getConfiguration !== 'function' ||
            !vscode.ConfigurationTarget) {
            return;
        }
        const on = vscode.workspace
            .getConfiguration('glyphcode')
            .get('halo.tintChrome', false);
        const cfg = vscode.workspace.getConfiguration('workbench');
        const current = (cfg.get('colorCustomizations') ?? {});
        if (on) {
            // Snapshot the user's halo-key values the FIRST time we tint, so we can put
            // them back byte-for-byte on disable/deactivate.
            if (this.haloSnapshot === undefined) {
                this.haloSnapshot = (0, haloChrome_1.snapshotHaloKeys)(current);
            }
            const next = (0, haloChrome_1.applyHaloCustomizations)(current, this.lastAuthority ?? 'read');
            this.haloApplied = true;
            await cfg.update('colorCustomizations', next, vscode.ConfigurationTarget.Global);
        }
        else if (this.haloApplied && this.haloSnapshot !== undefined) {
            // Turned OFF after being ON: restore exactly.
            const restored = (0, haloChrome_1.restoreHaloCustomizations)(current, this.haloSnapshot);
            this.haloApplied = false;
            this.haloSnapshot = undefined;
            await cfg.update('colorCustomizations', restored, vscode.ConfigurationTarget.Global);
        }
    }
    /** Restore any applied halo tint (called on deactivate). Best-effort. */
    async dispose() {
        if (this.haloApplied && this.haloSnapshot !== undefined) {
            try {
                const cfg = vscode.workspace.getConfiguration('workbench');
                const current = (cfg.get('colorCustomizations') ??
                    {});
                await cfg.update('colorCustomizations', (0, haloChrome_1.restoreHaloCustomizations)(current, this.haloSnapshot), vscode.ConfigurationTarget.Global);
            }
            catch {
                /* best-effort restore on shutdown */
            }
            this.haloApplied = false;
            this.haloSnapshot = undefined;
        }
        void vscode.commands.executeCommand('setContext', 'glyphcode.authority', undefined);
    }
}
/**
 * Map an assurance level to its status-bar ThemeColor. We reuse built-in theme
 * colors so the `authority:` segment honors the user's theme (and contrast), while
 * still varying by assurance: a denied run reads error-red, a verified run prominent.
 */
function authorityThemeColor(level) {
    // Guarded so a minimal host/test stub without ThemeColor degrades to default.
    if (typeof vscode.ThemeColor !== 'function')
        return undefined;
    switch (level) {
        case 'denied':
            return new vscode.ThemeColor('statusBarItem.errorForeground');
        case 'soft':
        case 'claimed':
            return new vscode.ThemeColor('statusBarItem.warningForeground');
        case 'verified':
            return new vscode.ThemeColor('statusBarItem.prominentForeground');
        case 'read':
        default:
            return undefined; // default status-bar foreground (no over-emphasis)
    }
}
/**
 * The module-private RUN STATUS CONTROLLER. One per extension process; fed the
 * SAME run/event stream the Trust Panel renders (postRunEvent calls notify()).
 * Created+attached in activate(); its dispose restores the halo on deactivate.
 */
let runStatusController;
function getRunStatusController() {
    if (!runStatusController)
        runStatusController = new RunStatusController();
    return runStatusController;
}
/* ================================================================== *
 * PROVENANCE GUTTER CONTROLLER (Slice 3 — §5.5 / §8).
 *
 * The module-private PROVENANCE GUTTER controller. One per extension process; fed
 * the SAME run/event stream the Trust Panel renders (TrustPanel.postRunEvent calls
 * notify()), the SAME webview signature-verified confirmation the status bar reads
 * (the `glyphcodeAuthority` message → confirmVerified, the amber→blue flip / tamper
 * revert), and the agentic build's real git diff (the one honest hunk-granularity
 * source). It paints the four trust-state decorations onto the editor gutter/minimap/
 * row at the HONEST granularity (whole-file amber for changed files; hunk where a
 * real diff exists; blue ONLY on verifier-covered hunks of a webview-verified run;
 * SOFT never blue). Created+attached in activate(); its dispose drops the decoration
 * types on deactivate. Needs the extensionUri (for the colored-bar icon assets), so
 * unlike the other singletons it is created in activate(), not lazily on first use.
 */
let provenanceGutterController;
function getProvenanceGutterController() {
    return provenanceGutterController;
}
/**
 * The Governed Runs CARD view provider (Slice 4). Holds the same per-run webview-
 * verified flag the status bar + gutter hold, so the green VERIFIED card flips ONLY
 * on the signature gate (confirmVerified), and follows the focused run.
 */
let governedRunsCardView;
function getGovernedRunsCardView() {
    return governedRunsCardView;
}
/**
 * The RAIL GOVERNANCE-SURFACE registry (Blended Workbench §5.3 / §5.9). One per
 * extension process. Every nine-surface webview provider is registered into it in
 * activate(); TrustPanel.postRunEvent fans EVERY raw run/event envelope out to it
 * (registry.dispatch) alongside the model / status bar / gutter / cards feeds — so
 * each per-surface reader consumes the IDENTICAL stream the panel does, with no new
 * supervisor API. The scaffold's stubs ingest a no-op; per-surface readers fold the
 * stream into evidence (validating it themselves, never rendering a higher assurance
 * than the stream supplies). Module-scoped so postRunEvent (a TrustPanel method) can
 * reach it without threading it through every call site.
 */
let governanceSurfaceRegistry;
function getGovernanceSurfaceRegistry() {
    if (!governanceSurfaceRegistry) {
        governanceSurfaceRegistry = new surfaces_1.GovernanceSurfaceRegistry();
    }
    return governanceSurfaceRegistry;
}
/**
 * The AGENT VIEW snapshot REVISION (Slice 1, design §2). A monotonic counter bumped
 * on every run-set change AND on every webview signature confirmation — the two
 * facts the workbench Agent View renders (a row appearing/updating, and an
 * acting→verified flip). The native workbench polls `glyphcode.runs.revision` and
 * re-fetches `glyphcode.runs.snapshot` only when this advances; a command cannot
 * PUSH to the workbench, so this cheap counter is the change signal for the pull
 * transport. Module-scoped so both the model subscription (in activate) and the
 * glyphcodeAuthority handler (in TrustPanel) can advance it.
 */
let agentRunsRevision = 0;
function bumpAgentRunsRevision() {
    agentRunsRevision++;
}
/** Human-readable byte size for size-cap error messages. */
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const mib = bytes / (1024 * 1024);
    if (mib >= 1)
        return `${mib.toFixed(1)} MiB`;
    return `${(bytes / 1024).toFixed(1)} KiB`;
}
/** Absolute path to the verifier keystore directory. */
function verifierKeystoreDir() {
    return path.join(os.homedir(), '.glyphcode', 'verifier');
}
/**
 * Ensure ~/.glyphcode/verifier/{private.pem,public.pem} exists, generating a
 * fresh Ed25519 keypair (PKCS8 private + SPKI public, both PEM) on first use.
 * Idempotent: if both files already exist they are read and returned as-is, so
 * the operator's pinned trust root is STABLE across runs and sessions.
 *
 * Returns the paths plus the public PEM. Throws only on a genuine filesystem
 * failure (the caller surfaces that as an error toast and aborts the run rather
 * than silently running unpinned).
 */
function ensureVerifierKeystore() {
    const dir = verifierKeystoreDir();
    const privateKeyPath = path.join(dir, 'private.pem');
    const publicKeyPath = path.join(dir, 'public.pem');
    const haveBoth = fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath);
    if (!haveBoth) {
        fs.mkdirSync(dir, { recursive: true });
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
        const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
        const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
        // Write the private key with owner-only perms; best-effort on platforms
        // that ignore mode. The public key is non-secret.
        fs.writeFileSync(privateKeyPath, privatePem, { encoding: 'utf8', mode: 0o600 });
        fs.writeFileSync(publicKeyPath, publicPem, 'utf8');
    }
    const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
    return { dir, privateKeyPath, publicKeyPath, publicKeyPem };
}
/**
 * Resolve the operator's full trusted-verifier-key set for injection into the
 * webview: the OPERATOR-controlled `glyphcode.trustedVerifierKeys` value PLUS the
 * keystore's pinned public key (when the keystore exists). The keystore key is
 * the out-of-band trust root for runs launched from this extension. We never read
 * a key from a run bundle here — app.js intentionally ignores bundle-embedded
 * keys.
 *
 * SECURITY (sweep-07 Critical #1): we read the setting via inspect() and accept
 * ONLY the default + user/global scopes, EXCLUDING workspaceValue and
 * workspaceFolderValue. getConfiguration().get() would merge a repo's
 * .vscode/settings.json value and let it win — a repository could then inject its
 * own verifier public key and drive a verdict to AUTHORITATIVE. Combined with the
 * `"scope": "machine"` declaration in package.json (which makes VS Code refuse
 * workspace/folder values for this key), this is defense in depth. The selection
 * itself lives in the pure, headlessly-testable selectGlobalScopedTrustKeys().
 */
function resolveTrustedVerifierKeys() {
    const inspect = vscode.workspace
        .getConfiguration('glyphcode')
        .inspect('trustedVerifierKeys');
    // Read the keystore public key if it already exists. We do NOT generate it
    // here — generation happens on demand when a run is launched — so merely
    // opening the panel never creates key material. It is machine-local and
    // provisioned out-of-band, so it is NOT workspace-controlled.
    let keystorePublicKeyPem;
    try {
        const publicKeyPath = path.join(verifierKeystoreDir(), 'public.pem');
        if (fs.existsSync(publicKeyPath)) {
            keystorePublicKeyPem = fs.readFileSync(publicKeyPath, 'utf8');
        }
    }
    catch {
        // Unreadable keystore is non-fatal: fall back to the setting-only set.
    }
    return (0, configScope_1.selectGlobalScopedTrustKeys)(inspect, keystorePublicKeyPem);
}
/**
 * The webview "reduce motion" value derived from the GlyphCode Halo Motion setting
 * (§14.3 accessibility). `glyphcode.workbench.haloMotion` is the explicit user toggle
 * for the Trust Panel's deny-pulse + amber→blue trust cross-fades; it defaults to ON
 * (motion enabled), so reduce-motion is its inverse. This is the SECOND disable path
 * §14.3 requires alongside the OS `prefers-reduced-motion` preference (which the
 * webview's @media query always honors independently). Guarded so a stub host without
 * getConfiguration is safe (treats motion as ON → reduce = false). View-only — it
 * changes nothing about trust, only whether those two animations play.
 */
function resolveReduceMotion() {
    if (typeof vscode.workspace.getConfiguration !== 'function')
        return false;
    const haloMotion = vscode.workspace
        .getConfiguration('glyphcode')
        .get('workbench.haloMotion', true);
    return haloMotion === false;
}
/**
 * Read the GlyphCode icon symbol sprite (media/glyphcode-icons.svg) for inline
 * injection into a webview body (docs/assets/ICON-USAGE.md). The sprite is a
 * static, first-party product asset — never untrusted input — so inlining it is
 * safe and lets same-document <use href="#gs-..."> resolve reliably across the
 * Chromium/webview contexts where external `./file.svg#id` references break and
 * lose `currentColor`. If the asset is ever missing, fall back to an empty string
 * so the panel still renders (icons simply won't show) rather than throwing.
 */
function readIconsSprite(mediaUri) {
    try {
        const iconsPath = vscode.Uri.joinPath(mediaUri, 'glyphcode-icons.svg');
        return fs.readFileSync(iconsPath.fsPath, 'utf8');
    }
    catch {
        return '';
    }
}
/**
 * Singleton Trust Panel manager. Keeps at most one webview panel alive, builds
 * its CSP-locked HTML, and bridges host<->webview messages.
 */
class TrustPanel {
    /**
     * Read-only peek at the live panel WITHOUT creating one (createOrShow would spawn a
     * webview). The Agent View evidence transport (glyphcode.runs.detail) uses this to
     * read a run's retained review when a panel happens to be open, and falls back to
     * the honest "no evidence yet" projection when it is not — a read-only command must
     * never have the side effect of opening a panel.
     */
    static peekCurrent() {
        return TrustPanel.current;
    }
    static createOrShow(extensionUri, gate) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (TrustPanel.current) {
            TrustPanel.current.panel.reveal(column);
            return TrustPanel.current;
        }
        const panel = vscode.window.createWebviewPanel('glyphcodeTrustPanel', 'GlyphCode Trust Panel', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            // Lock the webview to loading resources only from the extension's media dir.
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        });
        TrustPanel.current = new TrustPanel(panel, extensionUri, gate);
        return TrustPanel.current;
    }
    constructor(panel, extensionUri, gate) {
        this.disposables = [];
        this.ready = false;
        /**
         * Run-events received before the webview signalled ready; replayed IN ORDER on
         * ready so the live stream is never dropped during webview boot.
         */
        this.pendingRunEvents = [];
        /**
         * The most recent AgenticBuildReview posted per runId (Phase C). The webview's
         * decision message carries only { runId, decision } — the host scopes the Accept /
         * Reject outcome (esp. the revert) to EXACTLY this review's changedFiles, so it keeps
         * the authoritative review here keyed by runId. PREVIEW reviews are recorded too but
         * carry no real changes (the decision handler treats a preview/non-real review as a
         * recorded-only outcome). View-only — confers no trust.
         */
        this.reviewsByRunId = new Map();
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.gate = gate;
        this.panel.webview.html = this.getWebviewContent(this.panel.webview);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
        // Returns void for most messages; for `startTrustedRun` it RETURNS the launch
        // promise. VS Code ignores a handler's return value, but returning it lets a
        // test await the (otherwise fire-and-forget) trusted-run launch deterministically.
        (msg) => {
            if (!msg || typeof msg !== 'object') {
                return;
            }
            if (msg.type === 'ready') {
                this.ready = true;
                if (this.pendingFiles) {
                    const files = this.pendingFiles;
                    this.pendingFiles = undefined;
                    this.postBundle(files);
                }
                // Replay any run-events buffered during webview boot, in order.
                if (this.pendingRunEvents.length > 0) {
                    const events = this.pendingRunEvents;
                    this.pendingRunEvents = [];
                    void this.panel.webview.postMessage({ type: 'runEvents', events });
                }
                // Replay a pending "offer trusted run" so the in-webview affordance shows.
                if (this.pendingOfferKind) {
                    const kind = this.pendingOfferKind;
                    this.pendingOfferKind = undefined;
                    void this.panel.webview.postMessage({ type: 'offerTrustedRun', kind });
                }
                // Replay a pending run-focus so a tree-row click that raced the webview
                // boot still focuses the run the operator selected.
                if (this.pendingSelectRunId) {
                    const runId = this.pendingSelectRunId;
                    this.pendingSelectRunId = undefined;
                    void this.panel.webview.postMessage({ type: 'selectRun', runId });
                }
                // Replay a pending Agentic Build Review (Phase B) so a preview command
                // that raced the webview boot still renders its review.
                if (this.pendingAgenticReview) {
                    const pending = this.pendingAgenticReview;
                    this.pendingAgenticReview = undefined;
                    void this.panel.webview.postMessage({
                        type: 'agenticBuildReview',
                        review: pending.review,
                        preview: pending.preview,
                    });
                }
                // Replay a pending tier-sync so a NATIVE title-bar ladder click that raced
                // the webview boot still syncs the webview ladder (PATCH-009). FRICTION
                // axis only — view-only, confers no authority.
                if (this.pendingSetTier !== undefined) {
                    const tier = this.pendingSetTier;
                    this.pendingSetTier = undefined;
                    void this.panel.webview.postMessage({ type: 'setTier', tier });
                }
                // REDUCED-MOTION SETTING (§14.3). Post the current GlyphCode Halo Motion
                // toggle on webview creation so the deny-pulse + amber→blue trust cross-
                // fades honor a user who disabled motion (the global injected pre-boot is
                // the no-flash seed; this confirms the live value once the webview is up).
                // View-only — it changes nothing about trust. Kept live via the config
                // listener (onDidChangeConfiguration) registered in activate().
                void this.panel.webview.postMessage({
                    type: 'reduceMotion',
                    value: resolveReduceMotion(),
                });
            }
            else if (msg.type === 'requestLoadBundle') {
                // The webview's "Load run bundle…" button delegates to the host command.
                void vscode.commands.executeCommand('glyphcode.loadRunBundle');
            }
            else if (msg.type === 'glyphcodePromote') {
                // BLENDED FRICTION SURFACE — "Promote to governed run" (Slice 1, §5.8/§6).
                // The panel's Promote button (shown only at the ask/inline friction tiers)
                // wires the workbench promotion gesture to the agentic-build command we
                // already ship. The button itself does NOT grant authority: this command's
                // OWN modal (confirmBuildAuthority in promoteChatToBuild) is the load-bearing
                // authority gate, and a third party cannot post this message (it can only
                // come from our own webview). We pass no intent so the command prompts for it.
                void vscode.commands.executeCommand('glyphcode.promoteChatToBuild');
            }
            else if (msg.type === 'glyphcodeAuthority') {
                // ASSURANCE CONFIRMATION (Slice 2, §1.12). The webview computed the run's
                // assurance via deriveAuthority — INCLUDING the Ed25519 signature-before-
                // display gate the host cannot run. We use it for ONE honest purpose: to
                // let the status-bar `authority:` segment + the future fork halo reach
                // `verified` ONLY when the panel's own gate verified the signature. Any
                // other (read/claimed/soft/denied) confirmation just clears the verified
                // flag, so a later tamper honestly drops the run off blue. This can only
                // come from our own webview — a third party cannot post into it.
                if (typeof msg.runId === 'string' &&
                    typeof msg.authority === 'string') {
                    const verifiedChanged = getRunStatusController().confirmVerified(msg.runId, msg.authority === 'verified');
                    // AGENT VIEW snapshot (Slice 1, design §2): a verified flip (amber→blue)
                    // or a tamper-revert changes a run's 'verified' ELIGIBILITY but is NOT a
                    // run-set change, so GovernedRunsModel.onDidChange does not fire. Advance
                    // the snapshot revision here — only when the canonical verified set really
                    // changed — so the native workbench poll re-fetches and the Agent View row
                    // flips in step with the status bar / gutter / cards (never ahead of the
                    // signature gate). The bump is the only extra signal this path needs.
                    if (verifiedChanged)
                        bumpAgentRunsRevision();
                    // PROVENANCE GUTTER (Slice 3): the SAME webview gate drives the editor's
                    // amber→blue flip / tamper revert. 'verified' moves the run's covered
                    // hunks to blue; any other value clears the flag so a later tamper drops
                    // them off blue. The host never decides 'verified' itself — this is the
                    // only door to blue, exactly as the status bar reads it.
                    getProvenanceGutterController()?.confirmVerified(msg.runId, msg.authority === 'verified');
                    // GOVERNED RUNS CARDS (Slice 4): the SAME webview gate flips a run card
                    // amber→green (and a later tamper reverts it). The card view never decides
                    // 'verified' itself — this is its only door to green, exactly as the status
                    // bar reads it and the gutter reads blue.
                    getGovernedRunsCardView()?.confirmVerified(msg.runId, msg.authority === 'verified');
                    // RAIL GOVERNANCE SURFACES (§5.3/§5.9): the SAME webview gate is the ONLY
                    // door to verified-blue on the per-run surfaces (Verifier / Workspace). The
                    // registry fans this to every surface that implements confirmVerified;
                    // surfaces with no per-run verdict (Trace/Policy/Egress/…) are skipped. A
                    // surface caps SOFT runs at violet and reverts off blue on a later
                    // tamper — none decides 'verified' itself, exactly as the gutter/cards.
                    getGovernanceSurfaceRegistry().confirmVerified(msg.runId, msg.authority === 'verified');
                }
            }
            else if (msg.type === 'glyphcodeTier') {
                // FRICTION-TIER PUBLISH (Blended Workbench Phase 1, §A). The panel's
                // Authority Ladder is a VIEW control; the webview posts the effective
                // friction tier (ask | inline | governed | sensitive | sovereign) here so
                // the FORK chrome can react to it — e.g. recede the center editor at Ask
                // (glyphcodeTierChrome). We mirror it to the `glyphcode.tier` context-key,
                // exactly as the authority context-key is plumbed.
                //
                // ORTHOGONAL + VIEW-ONLY: this is the FRICTION axis only. It carries NO
                // assurance, NEVER touches `glyphcode.authority` (the halo), and grants
                // NOTHING — receding the editor REDUCES perceived authority, it adds no
                // friction and confers no trust. The promote modal (glyphcodePromote)
                // remains the only authority door. This can only come from our own webview.
                //
                // Routes through the SINGLE writer (TierController). `syncWebview: false`:
                // this webview already updated its OWN ladder DOM before posting, so echoing
                // a `setTier` back would be a redundant round-trip — the native title-bar
                // ladder reads the context-key TierController sets here and updates itself.
                if (typeof msg.tier === 'string' && isFrictionTier(msg.tier)) {
                    getTierController().set(msg.tier, { syncWebview: false });
                }
            }
            else if (msg.type === 'startTrustedRun') {
                // FIRST-PARTY OPERATOR GESTURE (sweep-20 High #3). This message can ONLY
                // come from our own webview (the operator clicked a GlyphCode Trust Panel
                // button) — a third-party extension cannot post into our webview. ONLY
                // here do we mint+consume a gesture and reach a trusted-run launcher.
                if ((0, webviewGestureGate_1.isTrustedRunKind)(msg.kind)) {
                    return this.gate.launchFromWebview(msg.kind);
                }
            }
            else if (msg.type === 'agenticBuildDecision') {
                // AGENTIC BUILD REVIEW DECISION (Phase C — the SECOND gate). The operator
                // clicked Accept / Reject / Request changes in the review view. This message
                // can ONLY come from our own webview. We now implement the REAL outcome:
                //   accepted          → keep the changes (already in the working tree).
                //   rejected          → REVERT exactly the run's changedFiles (confirm-gated).
                //   changes-requested → keep the changes + record the note.
                // codex edited the REAL cwd (no staging), so the git diff IS the safety net.
                if (typeof msg.runId === 'string' && (0, agenticBuildReview_1.isAgenticBuildDecision)(msg.decision)) {
                    return this.handleAgenticBuildDecision(msg.runId, msg.decision);
                }
            }
        }, null, this.disposables);
    }
    /**
     * Surface the first-party in-webview "Start run" affordance for `kind`. Called by
     * a command-palette handler: the command itself does NOT start a trusted run
     * (commands have no caller attribution); it reveals the panel and asks the webview
     * to show a button. The operator clicking that button posts `startTrustedRun`
     * back — the ONLY path that mints a gesture and runs a launcher.
     */
    offerTrustedRun(kind) {
        if (!this.ready) {
            this.pendingOfferKind = kind;
            return;
        }
        void this.panel.webview.postMessage({ type: 'offerTrustedRun', kind });
    }
    /**
     * Focus the panel on a specific run (the Governed Runs tree-row click path). The
     * webview already tracks `selectedRunId`; this posts a `selectRun` message it
     * honors by selecting that run and re-rendering. View-only navigation — it
     * confers NO trust and starts no run. Buffered until the webview is ready so a
     * click that raced the boot is not lost.
     */
    selectRun(runId) {
        // Also focus the status-bar segments on this run (Slice 2). View-only — confers
        // no trust; a no-op if the run hasn't streamed to the status model yet.
        getRunStatusController().focus(runId);
        // Focus the PROVENANCE GUTTER on this run too (Slice 3) so the editor paints the
        // selected run's changed files. View-only; a no-op if the run is unknown to the
        // gutter model yet.
        getProvenanceGutterController()?.focus(runId);
        // Focus the GOVERNED RUNS CARDS' "Changed in run" list on this run too (Slice 4),
        // so the side cards + the editor gutter agree on which run is in focus. View-only.
        getGovernedRunsCardView()?.focus(runId);
        if (!this.ready) {
            this.pendingSelectRunId = runId;
            return;
        }
        void this.panel.webview.postMessage({ type: 'selectRun', runId });
    }
    /**
     * Render an AgenticBuildReview (Phase B view layer) in the panel. The host does
     * NOT judge the review — it posts the pinned evidence object and the webview
     * renders it (intent + actor + honest posture, verdict + signature state, changed
     * files, the unified-diff viewer, commands + exit codes, egress, and the
     * accept/reject/request-changes controls). `preview` flags a fixture so the UI
     * shows a clear PREVIEW tag. Buffered until the webview is ready, like bundles.
     *
     * `cwd` is the REAL repo codex edited (absolute). The host retains it with the review
     * so a REJECT can scope its git revert to that repo + exactly this review's
     * changedFiles. A preview/fixture review passes no cwd (its changes are not real).
     */
    postAgenticBuildReview(review, preview = false, cwd) {
        // Retain the authoritative review so the decision handler can scope Accept / Reject
        // (esp. the revert) to EXACTLY this review's changedFiles. Keyed by runId.
        if (review && typeof review.runId === 'string' && review.runId.length > 0) {
            this.reviewsByRunId.set(review.runId, { review, preview, ...(cwd ? { cwd } : {}) });
            // AGENT VIEW BRIDGE (sweep-50 Medium): the agentic-build path streams ONLY
            // `build/event` (never `run/event`), so a build started from native Home never
            // reached postRunEvent → GovernedRunsModel.ingest. The terminal review was
            // retained for the Evidence pane, but the run stayed INVISIBLE to the run set —
            // absent from the Governed Runs tree AND the Agent View snapshot (and so the
            // detail transport returned undefined for it). Fold the REAL terminal review into
            // the SAME GovernedRunsModel the tree/snapshot read so the run LISTS honestly. We
            // do this ONLY for an AUTHORITATIVE (non-preview) review — a preview/fixture's
            // changes are not real, exactly as getRetainedReview excludes it from evidence.
            // The model's ingestBuildReview folds only the real fields (runId/posture/actor/
            // intent + a status derived from the real verdict) and never fabricates a row.
            if (!preview) {
                getGovernedRunsModel().ingestBuildReview(review);
                // The Agent View polls glyphcode.runs.revision and only re-fetches snapshot +
                // detail when it advances. ingestBuildReview emits the model's onDidChange (→
                // bumpAgentRunsRevision) when the row changes; bump here too so the EVIDENCE
                // pane refreshes even when the row summary was already up to date (e.g. a second
                // review for a run whose summary fields did not change but whose evidence did).
                bumpAgentRunsRevision();
            }
            // PROVENANCE GUTTER (Slice 3): the agentic build's git diff is the ONE honest
            // source of real hunk ranges. Attach it so the run's changed files promote from
            // whole-file amber to HUNK granularity. The blue gate is unchanged — hunks paint
            // amber/violet until the webview confirms a signature-verified authority; the
            // diff only refines WHERE we paint, never WHETHER we may paint blue.
            if (typeof review.diff === 'string' && review.diff.length > 0) {
                getProvenanceGutterController()?.attachDiff(review.runId, review.diff);
            }
        }
        if (!this.ready) {
            this.pendingAgenticReview = { review, preview };
            return;
        }
        void this.panel.webview.postMessage({ type: 'agenticBuildReview', review, preview });
    }
    /**
     * Read-only accessor for the latest AgenticBuildReview retained per runId (Phase C
     * retention; the SAME store the decision handler scopes its revert to). The Agent
     * View detail transport (glyphcode.runs.detail) reads it to project the run's
     * EVIDENCE (changed files + diff + signed verdict) for the native Evidence pane.
     * Returns undefined when no review has been posted for the run yet (the honest
     * "no evidence yet" state — the projection then emits empty changes + no verdict).
     * Returns the AUTHORITATIVE review only; a preview/fixture review is also retained
     * but its changes are not real, so it is excluded from the evidence projection.
     */
    getRetainedReview(runId) {
        const entry = this.reviewsByRunId.get(runId);
        if (!entry || entry.preview)
            return undefined;
        return entry.review;
    }
    /**
     * Handle the operator's diff-accept DECISION (Phase C — the SECOND gate). The webview
     * posts only { runId, decision }; the host looks up the authoritative review it
     * retained (so the outcome — esp. a revert — is scoped to EXACTLY that review's
     * changedFiles + its real cwd, never a broad checkout).
     *
     *   - accepted          → keep the changes (already in the working tree). Records
     *                         human_accepted. Optionally OFFERS (does not force) to stage.
     *   - rejected          → REVERT exactly the run's changedFiles, behind a destructive
     *                         confirm ("Discard the agent's changes to N files?"). Records
     *                         human_rejected. FAILS SAFE if not a git repo (lists the
     *                         files; reverts nothing).
     *   - changes-requested → keep the changes + records human_corrected_output.
     *
     * A PREVIEW/fixture review (or one with no retained real cwd) is recorded honestly as
     * a recorded-only outcome — there is no real working tree to revert.
     */
    async handleAgenticBuildDecision(runId, decision) {
        const entry = this.reviewsByRunId.get(runId);
        if (!entry) {
            // No retained review for this runId — record the decision honestly without a
            // working-tree action (we cannot scope a revert to a review we do not have).
            void vscode.window.showInformationMessage(`GlyphCode: review decision "${decision}" recorded for run ${runId} (no retained review to act on).`);
            return;
        }
        const { review, preview, cwd } = entry;
        const plan = (0, agenticBuildPromotion_1.planDecisionOutcome)(decision, review);
        // A preview/fixture (or a review with no real cwd) has no real working tree to act
        // on — record the outcome honestly without touching disk.
        if (preview || !cwd) {
            void vscode.window.showInformationMessage(`GlyphCode: ${plan.traceMarker} recorded for ${preview ? 'PREVIEW ' : ''}run ${runId}. ` +
                `${plan.summary}${preview ? ' (preview — no real changes to apply or revert.)' : ''}`);
            return;
        }
        if (decision === 'accepted') {
            // Keep the changes (already in the working tree). human_accepted is recorded.
            //
            // N3: NO post-decision "Stage Changes?" prompt. Accept is the hot path — the
            // changes are already in the working tree, so Accept needs no further action.
            // Staging is an optional git nicety the operator can do themselves (and the diff,
            // not the index, is the safety net), so we DO NOT interrupt the accept with a
            // notification. Friction belongs at the authority boundary, not after every Accept.
            return;
        }
        if (decision === 'changes-requested') {
            // Keep the changes + capture the request. A follow-up build is a later nicety.
            void vscode.window.showInformationMessage(`GlyphCode: ${plan.traceMarker} recorded for run ${runId}. ${plan.summary}`);
            return;
        }
        // rejected → REVERT exactly the run's changedFiles, behind a destructive confirm.
        const n = plan.filesToRevert.length;
        const DISCARD = 'Discard Changes';
        const confirm = await vscode.window.showWarningMessage(`Discard the agent's changes to ${n} file(s) in ${cwd}? This reverts EXACTLY the ` +
            "run's changed files (a scoped git operation) and cannot be undone.", { modal: true }, DISCARD);
        if (confirm !== DISCARD) {
            // Operator backed out of the destructive action — change nothing, keep the diff.
            return;
        }
        const result = (0, agenticBuildPromotion_1.revertChangedFiles)(cwd, plan.filesToRevert);
        if (!result.isGitRepo) {
            // FAIL SAFE: we cannot auto-revert outside a git repo — tell the user + list the
            // files so they can revert manually. Nothing was changed.
            const list = plan.filesToRevert.map((f) => `  - ${f.path}`).join('\n');
            void vscode.window.showWarningMessage(`GlyphCode: ${cwd} is not a git repository, so the agent's changes cannot be ` +
                `auto-reverted. human_rejected recorded. Revert these ${n} file(s) manually:\n${list}`);
            return;
        }
        const failed = result.files.filter((f) => !f.ok);
        if (failed.length === 0) {
            void vscode.window.showInformationMessage(`GlyphCode: rejected run ${runId} — reverted the agent's changes to ${n} file(s). ` +
                'human_rejected recorded.');
        }
        else {
            const list = failed.map((f) => `  - ${f.path}: ${f.error ?? 'failed'}`).join('\n');
            void vscode.window.showWarningMessage(`GlyphCode: reverted ${n - failed.length}/${n} file(s); ${failed.length} could not be ` +
                `reverted (human_rejected recorded):\n${list}`);
        }
    }
    /** Read a run-bundle directory and post its files into the webview. */
    loadBundleFromDirectory(dir) {
        const files = [];
        const missing = [];
        let totalBytes = 0;
        for (const name of BUNDLE_FILE_NAMES) {
            const full = path.join(dir, name);
            let size;
            try {
                size = fs.statSync(full).size;
            }
            catch {
                // Absent/unreadable file: treated as "missing" exactly as before.
                missing.push(name);
                continue;
            }
            // Cap per file BEFORE reading, so an oversized file never gets loaded into
            // memory or posted to the webview.
            if (size > MAX_BUNDLE_FILE_BYTES) {
                void vscode.window.showErrorMessage(`GlyphCode: ${name} is ${formatBytes(size)} which exceeds the ` +
                    `${formatBytes(MAX_BUNDLE_FILE_BYTES)} per-file limit. Bundle load aborted.`);
                return;
            }
            // Cap the total bundle size across files, so the single webview message
            // payload stays bounded.
            if (totalBytes + size > MAX_BUNDLE_TOTAL_BYTES) {
                void vscode.window.showErrorMessage(`GlyphCode: run bundle in ${dir} exceeds the ` +
                    `${formatBytes(MAX_BUNDLE_TOTAL_BYTES)} total-size limit. Bundle load aborted.`);
                return;
            }
            try {
                const text = fs.readFileSync(full, 'utf8');
                files.push({ name, text });
                totalBytes += size;
            }
            catch {
                missing.push(name);
            }
        }
        if (files.length === 0) {
            void vscode.window.showErrorMessage(`GlyphCode: no run-bundle files found in ${dir}. Expected at least one of: ${BUNDLE_FILE_NAMES.join(', ')}.`);
            return;
        }
        // trace.jsonl or verdict.json is required to render anything meaningful.
        const hasTraceOrVerdict = files.some((f) => f.name === 'trace.jsonl' || f.name === 'verdict.json');
        if (!hasTraceOrVerdict) {
            void vscode.window.showErrorMessage(`GlyphCode: ${dir} has no trace.jsonl or verdict.json — nothing to verify.`);
            return;
        }
        if (missing.length && missing.includes('verifier-public-key.pem')) {
            void vscode.window.showWarningMessage('GlyphCode: no verifier-public-key.pem in this bundle — the verdict cannot be verified and will show as UNTRUSTED.');
        }
        this.postBundle(files);
    }
    /** Post bundle files to the webview, or queue them until it is ready. */
    postBundle(files) {
        if (!this.ready) {
            this.pendingFiles = files;
            return;
        }
        void this.panel.webview.postMessage({ type: 'loadBundleFiles', files });
    }
    reveal() {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        this.panel.reveal(column);
    }
    /**
     * Sync the OPEN Trust Panel webview's Authority Ladder to `tier` (PATCH-009). Called
     * by TierController when a NATIVE title-bar rung click re-tiers the workbench, so the
     * webview ladder reflects it. No-op if no panel is open (the native ladder is the
     * canonical control and works without the webview). The webview applies this WITHOUT
     * echoing `glyphcodeTier` back (see live.js `setTier` receiver), so there is no loop.
     * View-only — confers no authority. Static so TierController need not hold a ref.
     */
    static syncLadderTier(tier) {
        TrustPanel.current?.postSetTier(tier);
    }
    /** Post (or buffer) a `setTier` sync to this webview. FRICTION axis only; view-only. */
    postSetTier(tier) {
        if (!this.ready) {
            this.pendingSetTier = tier;
            return;
        }
        void this.panel.webview.postMessage({ type: 'setTier', tier });
    }
    dispose() {
        TrustPanel.current = undefined;
        // NOTE: we deliberately do NOT clear the `glyphcode.tier` context-key here. Since
        // PATCH-009 the NATIVE title-bar Authority Ladder is the CANONICAL friction control
        // and persists after the webview closes; the key reflects the workbench's current
        // friction view and is owned by the TierController (cleared only on deactivate).
        // The orthogonal authority key is owned by RunStatusController, untouched here.
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
    /**
     * Build the webview HTML from media/index.html: inject a per-load nonce, the
     * webview cspSource, and asWebviewUri()-rewritten URIs for the bundled CSS/JS.
     * Scripts execute only with the nonce; styles only from the extension media
     * dir; no remote origins. The Web Crypto Ed25519 verify runs client-side.
     */
    getWebviewContent(webview) {
        const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
        const htmlPath = vscode.Uri.joinPath(mediaUri, 'index.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'styles.css'));
        const sampleBundleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'sample-bundle.js'));
        const appUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'app.js'));
        const liveUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'live.js'));
        const nonce = crypto.randomBytes(16).toString('base64');
        // GlyphCode icon system (docs/assets/ICON-USAGE.md). External SVG <use href>
        // is unreliable in VS Code webviews, so we INLINE the symbol sprite into the
        // body and reference it with same-document <use href="#gs-...">. The sprite is
        // static product asset markup (no untrusted input), read from the extension's
        // own media dir; CSS hides it (.gs-icons / first-child aria-hidden svg).
        const iconsSprite = readIconsSprite(mediaUri);
        // Out-of-band trust-root seam (sweep-05 Critical). Resolve the operator's
        // trusted verifier public keys and inject them as a global the webview reads
        // BEFORE app.js loads. The set is the `glyphcode.trustedVerifierKeys` setting
        // PLUS the extension-managed keystore public key (~/.glyphcode/verifier/
        // public.pem) — the out-of-band pinning that makes a real run launched from
        // here show AUTHORITATIVE. The host injects key MATERIAL only; it never tells
        // the webview a verdict is trusted — the Ed25519 verify still runs in the
        // webview (the trust division at the top of this file). app.js treats these
        // (plus its built-in demo key) as the trust root; a bundle's embedded
        // verifierPublicKey is NEVER trusted, and the keystore key NEVER comes from
        // the run bundle.
        const trusted = resolveTrustedVerifierKeys();
        // escapeForInlineScript (not bare JSON.stringify): a key value containing the
        // closing-script sequence must NOT be able to terminate this inline <script>
        // and inject markup before app.js loads.
        const trustedKeysScript = `<script nonce="${nonce}">window.GLYPHCODE_TRUSTED_VERIFIER_KEYS = ${(0, inlineScript_1.escapeForInlineScript)(trusted)};</script>`;
        // CANONICAL RunTrust SET (sweep-25 #1). Inject the bridgeProtocol RUN_TRUSTS
        // list — the SAME constant the host's validateRunEvent uses — as a nonce-guarded
        // global so the webview's run-event gate (media/live.js) validates
        // run_opened.trust against the canonical five-value vocabulary instead of a
        // hand-kept allowlist that drifted and dropped governed-unsandboxed /
        // sandboxed-soft-egress runs. escapeForInlineScript (not bare JSON.stringify)
        // keeps the inline <script> un-breakable, matching the trusted-keys seam.
        const runTrustsScript = `<script nonce="${nonce}">window.GLYPHCODE_RUN_TRUSTS = ${(0, inlineScript_1.escapeForInlineScript)(bridgeProtocol_1.RUN_TRUSTS)};</script>`;
        // REDUCED-MOTION SETTING (§14.3). Inject the GlyphCode Halo Motion toggle (the
        // inverse of glyphcode.workbench.haloMotion) as a nonce-guarded global BEFORE
        // live.js runs, so a user who disabled motion sees NO deny-pulse / trust cross-
        // fade on first paint (no flash). live.js seeds from this global on boot and
        // stays live via the `reduceMotion` message posted on config change below. A
        // boolean cannot break the inline <script>, but we route it through the same
        // escapeForInlineScript seam as the other injected globals for consistency.
        const reduceMotionScript = `<script nonce="${nonce}">window.GLYPHCODE_REDUCE_MOTION = ${(0, inlineScript_1.escapeForInlineScript)(resolveReduceMotion())};</script>`;
        // PROJECT-SCOPING (panel honesty). Tell the IN-IDE webview it is the WORKSPACE
        // Trust Panel, not the standalone zero-install demo. app.js uses this to show an
        // honest empty state ("no governed run in this project yet") on open instead of
        // preloading the bundled DEMO sample — so a fresh project never presents another
        // run's evidence as if it were this project's. The standalone demo page does NOT
        // set this global, so it keeps the on-open sample (in-browser verify demo). The
        // workspace folder name rides along for the empty-state copy. Routed through
        // escapeForInlineScript like the other injected globals so neither value can
        // break out of the inline <script>.
        const wsName = vscode.workspace.workspaceFolders?.[0]?.name ?? null;
        const panelContextScript = `<script nonce="${nonce}">window.GLYPHCODE_PANEL_CONTEXT = ${(0, inlineScript_1.escapeForInlineScript)('workspace')}; window.GLYPHCODE_WORKSPACE_NAME = ${(0, inlineScript_1.escapeForInlineScript)(wsName)};</script>`;
        return html
            .replace('{{iconsSprite}}', iconsSprite)
            .replace(/\{\{cspSource\}\}/g, webview.cspSource)
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{stylesUri\}\}/g, stylesUri.toString())
            .replace(/\{\{sampleBundleUri\}\}/g, sampleBundleUri.toString())
            .replace(/\{\{appUri\}\}/g, appUri.toString())
            .replace(/\{\{liveUri\}\}/g, liveUri.toString())
            .replace(/\{\{trustedKeysScript\}\}/g, trustedKeysScript)
            .replace(/\{\{runTrustsScript\}\}/g, runTrustsScript)
            .replace(/\{\{reduceMotionScript\}\}/g, reduceMotionScript)
            .replace(/\{\{panelContextScript\}\}/g, panelContextScript);
    }
    /**
     * Forward a validated supervisor `run/event` envelope to the webview's live
     * view. The host does NOT judge or vouch for the event — it validates the
     * envelope SHAPE (so a malformed message never reaches the renderer) and posts
     * the raw event; all rendering + the Ed25519 signature-before-display gate run
     * in the webview. Events that arrive before the webview signals 'ready' are
     * queued and replayed, preserving order — the same pattern as bundle loads.
     */
    postRunEvent(rawEvent) {
        // Feed the activity-bar Governed Runs model FIRST so the sidebar lists every
        // run the panel is asked to render. The model does its own validate-then-fold
        // and silently ignores a malformed/foreign envelope, so this never fabricates a
        // row — it mirrors exactly what reaches the panel below.
        getGovernedRunsModel().ingest(rawEvent);
        // Feed the STATUS-BAR SEGMENTS model (Slice 2, §1.12) from the SAME stream so
        // `authority:` / `sandboxed worktree` / `N traced events` reflect the focused
        // run honestly. It does its own validate-then-fold and ignores malformed input.
        getRunStatusController().notify(rawEvent);
        // Feed the PROVENANCE GUTTER controller (Slice 3, §5.5/§8) from the SAME stream
        // so the editor gutter/minimap paints the run's changed files at the honest
        // granularity (whole-file amber; hunk where a real diff exists; blue only on a
        // webview-verified run's covered hunks). It does its own validate-then-fold and
        // ignores malformed input, so this never paints from a foreign/malformed event.
        getProvenanceGutterController()?.notify(rawEvent);
        // Feed the RAIL GOVERNANCE SURFACES (Slice 4, §5.3/§5.9) from the SAME stream so
        // each registered per-surface reader (trace / policy / verifier / egress / model-
        // calls / workspace / search / settings / actor) sees the IDENTICAL raw envelope
        // the panel / model / status bar / gutter / cards see. The registry only fans out
        // (isolating a misbehaving surface); each surface validates + folds at its own
        // altitude and never renders a higher assurance than the stream supplies. The
        // scaffold's stubs ingest a no-op, so this is inert until per-surface readers land.
        getGovernanceSurfaceRegistry().dispatch(rawEvent);
        const validation = (0, runEventProtocol_1.validateRunEvent)(rawEvent);
        if (!validation.ok) {
            // SCHEMA-VERSION MISMATCH (sweep-19 Medium #6 — FAIL CLOSED). A `rev` problem
            // means the envelope is from a future/foreign run-event schema. Do NOT render
            // it as a current event; instead synthesize a DISTINCT bridge-mismatch failure
            // so the panel de-authoritates that run with a clear, honest card (the §14
            // bridge_mismatch state) rather than silently dropping a foreign stream.
            if (validation.problems.includes('rev') && validation.problems.length === 1) {
                const runId = rawEvent && typeof rawEvent === 'object' && typeof rawEvent.runId === 'string'
                    ? rawEvent.runId
                    : 'unknown-run';
                const mismatch = {
                    rev: runEventProtocol_1.RUN_EVENT_PROTOCOL_VERSION,
                    runId,
                    kind: runEventProtocol_1.RunEventKind.Failure,
                    failure: runEventProtocol_1.RunFailureKind.BridgeMismatch,
                    message: 'unsupported run-event schema (rev mismatch) — refusing to render a foreign/future ' +
                        `stream as current (expected rev ${runEventProtocol_1.RUN_EVENT_PROTOCOL_VERSION}).`,
                };
                // Mirror the synthesized mismatch into the SIDEBAR model too (sweep-25 #2).
                // The original foreign-rev envelope was ignored by the model above (it fails
                // validateRunEvent on `rev`), so without this the Governed Runs view would be
                // EMPTY while the panel shows a bridge_mismatch card. The synthesized failure
                // is current-rev and valid, so the model accepts it and produces a row with a
                // refused posture — the same de-authoritated signal, in both surfaces.
                getGovernedRunsModel().ingest(mismatch);
                if (!this.ready) {
                    this.pendingRunEvents.push(mismatch);
                }
                else {
                    void this.panel.webview.postMessage({ type: 'runEvent', event: mismatch });
                }
                return;
            }
            // Drop any other malformed envelope rather than mis-render it; surface it for
            // the operator without blocking the stream.
            void vscode.window.showWarningMessage(`GlyphCode: ignored a malformed run/event (problems: ${validation.problems.join(', ')}).`);
            return;
        }
        if (!this.ready) {
            this.pendingRunEvents.push(validation.event);
            return;
        }
        void this.panel.webview.postMessage({ type: 'runEvent', event: validation.event });
    }
    /**
     * Post the current GlyphCode Halo Motion setting to the webview (§14.3). Called on
     * config change (onDidChangeConfiguration) so a user toggling motion off/on disables
     * or re-enables the deny-pulse + amber→blue trust cross-fades live. If the webview
     * has not signaled `ready` yet, the global injected at boot already carries the
     * setting (and `ready` re-posts the live value), so there is nothing to buffer here.
     * View-only — it changes nothing about trust.
     */
    postReduceMotion() {
        if (!this.ready)
            return;
        void this.panel.webview.postMessage({
            type: 'reduceMotion',
            value: resolveReduceMotion(),
        });
    }
    /** Post the motion setting to the live panel, if one is open (config-change hook). */
    static notifyReduceMotion() {
        TrustPanel.current?.postReduceMotion();
    }
}
/* ================================================================== *
 * GOVERNED-RUN COMMAND (glyphcode.runGovernedTask).
 *
 * Resolves the target repo, policy, output dir and verifier keystore, then
 * launches the supervisor's governed-run-cli.ts via supervisorRunner under a
 * cancellable progress notification. On success it opens the Trust Panel and
 * hands the bundle directory to the EXISTING loadBundleFromDirectory() seam. On
 * any failure (docker unavailable, CLI error, cancel) it shows a clear message
 * and leaves any currently-loaded panel untouched.
 * ================================================================== */
/**
 * Resolve the DEV-OVERRIDE spikes root, if any, that hosts the un-bundled
 * supervisor exec (the child cwd for the dev path).
 *
 * SECURITY (sweep-07 Critical #2): the un-bundled supervisor is spawned with
 * `--import tsx` and (optionally) the verifier PRIVATE key + host env. If a
 * repository could set glyphcode.supervisorPath via .vscode/settings.json,
 * opening that repo would redirect the spawned process to attacker code (RCE) and
 * leak the verifier private key. We read via inspect() and accept ONLY the
 * user/global value (falling back to the default empty), IGNORING workspace and
 * workspace-folder values. Combined with `"scope": "machine"` in package.json
 * (VS Code refuses workspace/folder values for this key) this is defense in
 * depth. The pure, testable selection lives in selectSupervisorPath(); when a
 * workspace value was present and ignored, the caller warns the operator.
 *
 * This is now an OPT-IN dev override: when empty (the default), the extension
 * launches the bundled, hash-pinned supervisor instead.
 */
function resolveSupervisorPath() {
    const inspect = vscode.workspace
        .getConfiguration('glyphcode')
        .inspect('supervisorPath');
    return (0, configScope_1.selectSupervisorPath)(inspect);
}
/**
 * Absolute path to the BUNDLED, hash-pinned supervisor shipped in the .vsix.
 * This is the DEFAULT exec: no setting needed. supervisorRunner verifies its
 * sha256 against the build-time constant before spawning.
 */
function resolveBundledSupervisorPath(context) {
    return vscode.Uri.joinPath(context.extensionUri, 'dist-supervisor', 'governed-run.mjs').fsPath;
}
/**
 * Absolute path to the BUNDLED, hash-pinned supervisor BRIDGE-SERVER shipped in
 * the .vsix. This is the spawnable stdio JSON-RPC server the SupervisorBridge
 * client connects to (spawn → hash-pin → handshake → run/create). The bridge
 * verifies its sha256 against the build-time constant before spawning.
 */
function resolveBundledBridgeServerPath(context) {
    return vscode.Uri.joinPath(context.extensionUri, 'dist-supervisor', 'bridge-server.mjs').fsPath;
}
/** The un-bundled governed-run CLI entry, relative to the dev-override spikes root. */
function resolveCliPath(supervisorPath) {
    return path.join(supervisorPath, 'p0-supervisor', 'governed-run-cli.ts');
}
/**
 * A filesystem-safe, stable, collision-resistant key for the CURRENT workspace, so
 * each project's runs live in their own subtree instead of one shared global pile.
 * Without this, run state from every project accumulated under one base and the
 * on-disk store / "Load run bundle" picker co-mingled unrelated projects' evidence —
 * exactly NOT the per-run, project-scoped trust the product promises (a fresh project
 * would surface another project's runs). No workspace → a stable '_no-workspace'
 * bucket. The key is `<sanitized-basename>-<sha256(absPath)[0:12]>` so two folders
 * that share a basename never collide.
 */
function workspaceRunsKey() {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) {
        return '_no-workspace';
    }
    const base = path.basename(ws).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'workspace';
    const hash = crypto.createHash('sha256').update(ws).digest('hex').slice(0, 12);
    return `${base}-${hash}`;
}
/**
 * Resolve the runs/worktree base passed to the supervisor as --runs-base. Uses the
 * machine-scoped glyphcode.runOutputRoot setting when set, else a stable $HOME-based
 * default (~/.glyphcode/runs), and ALWAYS namespaces by the current workspace
 * (workspaceRunsKey) so each project's run state is project-scoped — a fresh project
 * starts with no prior-run data. The bundled supervisor cwds here and writes all run
 * state under it, so it never writes under the install dir and never co-mingles one
 * project's runs with another's.
 */
function resolveRunsBase() {
    const configured = vscode.workspace
        .getConfiguration('glyphcode')
        .get('runOutputRoot', '');
    const root = configured && configured.trim() ? configured.trim() : path.join(os.homedir(), '.glyphcode', 'runs');
    return path.join(root, workspaceRunsKey());
}
/** Configured run mode, defaulting to the safe verify-only path. */
function resolveSupervisorMode() {
    const mode = vscode.workspace
        .getConfiguration('glyphcode')
        .get('supervisorMode', 'verify-only');
    return mode === 'autonomous' ? 'autonomous' : 'verify-only';
}
/**
 * Resolve the repo to govern: the single workspace folder if there is exactly
 * one, otherwise a folder picker. Returns undefined if the user cancels.
 */
async function resolveTargetRepo() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 1) {
        return folders[0].uri.fsPath;
    }
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Govern this repo',
        title: 'Select the repository to run the governed task against',
        ...(folders.length > 1 ? { defaultUri: folders[0].uri } : {}),
    });
    return picked && picked.length ? picked[0].fsPath : undefined;
}
/**
 * Resolve the policy file. SECURITY (sweep-08 Medium #1 — PROVENANCE, not
 * lockdown): a repo-local policy is LEGITIMATE under policy-as-code, so unlike
 * the supervisor path we do NOT machine-scope or ignore workspace values. We DO
 * read via inspect() and classify the SCOPE the value came from, so the caller
 * can surface the provenance: a 'workspace'/'workspaceFolder' policy is reported
 * (and confirmed) rather than silently winning via merged get().
 *
 * When no scope supplies a value, fall back to a file picker (scope 'picker').
 * CANCELLING the picker returns undefined and aborts the run — it must NOT fall
 * through to a relative fixture (sweep-15 Medium): on the bundled path the
 * supervisorPath is empty, so a relative '.glyphcode-fixtures/...' would resolve
 * against the host cwd, not a real policy. The capstone fixture is only offered
 * as the picker DEFAULT when a real dev supervisorPath is set AND the fixture
 * actually exists (see resolveDefaultPolicyCandidate); otherwise the picker has
 * no default and cancel => undefined => clean abort.
 */
async function resolvePolicyPath(supervisorPath) {
    const inspect = vscode.workspace
        .getConfiguration('glyphcode')
        .inspect('policyPath');
    const classified = (0, configScope_1.classifyPolicyPath)(inspect);
    if (classified.scope !== 'none') {
        return { path: classified.path, scope: classified.scope };
    }
    const defaultCandidate = (0, configScope_1.resolveDefaultPolicyCandidate)(supervisorPath, fs.existsSync);
    const defaultUri = defaultCandidate ? vscode.Uri.file(defaultCandidate) : undefined;
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Use this policy',
        title: defaultCandidate
            ? 'Select the GlyphCode policy file (defaults to the bundled capstone policy)'
            : 'Select the GlyphCode policy file',
        filters: { 'Policy JSON': ['json'], 'All files': ['*'] },
        ...(defaultUri ? { defaultUri } : {}),
    });
    // Picker CANCELLED — return undefined so the caller aborts the run, rather
    // than silently falling back to a (possibly host-cwd-relative) fixture path.
    if (!picked || picked.length === 0) {
        return undefined;
    }
    return { path: picked[0].fsPath, scope: 'picker' };
}
/* ------------------------------------------------------------------ *
 * NON-PROMPTING resolution for the GOVERNED TERMINAL (one-click).
 *
 * The Governed Terminal is just a cwd to drive `claude`/`codex` in under the SOFT
 * (governed-unsandboxed) boundary — it is NOT a sandboxed worktree and NOT a real
 * governed RUN. So, unlike the heavier governed-RUN path (assembleBridgeRunRequest /
 * runGovernedTask), opening it must be a SINGLE CLICK: it must NEVER pop a folder or
 * policy picker. These helpers resolve the cwd and the policy with ZERO interaction.
 * Provenance (workspace vs home-dir cwd; configured vs shipped-default policy) is
 * reported honestly rather than hidden.
 * ------------------------------------------------------------------ */
/** Bundled, ships-in-the-vsix default governed-terminal policy (media/). */
const DEFAULT_GOVERNED_TERMINAL_POLICY_FILE = 'default-governed-terminal-policy.json';
/**
 * Absolute path to the DEFAULT governed-terminal policy shipped inside the .vsix
 * (extension/media/). Used by the terminal path when no `glyphcode.policyPath` is
 * configured, so opening the soft terminal never needs a picker.
 */
function resolveDefaultGovernedTerminalPolicyPath(context) {
    return vscode.Uri.joinPath(context.extensionUri, 'media', DEFAULT_GOVERNED_TERMINAL_POLICY_FILE).fsPath;
}
/**
 * Resolve the governed-terminal cwd WITHOUT any picker (one-click):
 *   - exactly one workspace folder  → that folder ('workspace-folder'),
 *   - multiple folders              → the folder owning the active text editor if it
 *                                      maps to one ('active-editor-folder'), else the
 *                                      first folder ('workspace-folder'),
 *   - NO workspace folder           → os.homedir() ('home-dir-fallback').
 *
 * NEVER calls showOpenDialog — the soft terminal is a cwd to run `claude`/`codex`
 * in, not a sandboxed worktree, so there is nothing to pick.
 */
function resolveTerminalCwd() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return { path: os.homedir(), provenance: 'home-dir-fallback' };
    }
    if (folders.length === 1) {
        return { path: folders[0].uri.fsPath, provenance: 'workspace-folder' };
    }
    // Multiple folders: prefer the one owning the active editor when it maps to one.
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
        const owning = vscode.workspace.getWorkspaceFolder?.(activeUri);
        if (owning) {
            return { path: owning.uri.fsPath, provenance: 'active-editor-folder' };
        }
    }
    return { path: folders[0].uri.fsPath, provenance: 'workspace-folder' };
}
/**
 * Resolve the governed-terminal policy WITHOUT any picker (one-click). If a
 * `glyphcode.policyPath` scope is configured (classified exactly as
 * resolvePolicyPath does), use it and KEEP that provenance. Otherwise use the
 * DEFAULT policy SHIPPED with the extension (media/), fingerprinting whichever
 * file is chosen for the §10.3 policyHash pin.
 *
 * NEVER calls showOpenDialog. If the chosen policy cannot be fingerprinted (e.g. a
 * configured path is missing, or — should it ever happen — the bundled default is
 * unreadable), returns undefined after surfacing a clear error: the caller aborts
 * rather than silently falling through to a host-cwd-relative path.
 */
function resolveTerminalPolicy(context) {
    const inspect = vscode.workspace
        .getConfiguration('glyphcode')
        .inspect('policyPath');
    const classified = (0, configScope_1.classifyPolicyPath)(inspect);
    if (classified.scope !== 'none') {
        const fp = (0, policyHash_1.policyFileSha256)(classified.path);
        if (!fp.sha256) {
            void vscode.window.showErrorMessage(`GlyphCode: the configured glyphcode.policyPath (${classified.path}) could not be ` +
                `fingerprinted (${fp.note}); cannot open a governed terminal.`);
            return undefined;
        }
        return {
            path: classified.path,
            policyHash: fp.sha256,
            provenance: 'configured',
            scope: classified.scope,
        };
    }
    // No configured policy — use the bundled, ships-in-the-vsix default. No picker.
    const defaultPath = resolveDefaultGovernedTerminalPolicyPath(context);
    const fp = (0, policyHash_1.policyFileSha256)(defaultPath);
    if (!fp.sha256) {
        void vscode.window.showErrorMessage(`GlyphCode: the bundled default governed-terminal policy could not be read ` +
            `(${defaultPath}: ${fp.note}); cannot open a governed terminal.`);
        return undefined;
    }
    return { path: defaultPath, policyHash: fp.sha256, provenance: 'shipped-default', scope: 'default' };
}
/**
 * Resolve the output directory for THIS run's bundle: a per-run, timestamped subdir
 * under the project-scoped runs base (see resolveRunsBase). Co-locating the bundle
 * with the run state keeps a project's evidence under a single project-scoped tree, so
 * a fresh project never shows another project's bundles. `repo` is retained for
 * call-site symmetry; the base is already workspace-scoped.
 */
function resolveOutputDir(_repo) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(resolveRunsBase(), stamp);
}
/**
 * A STUB ModelGateway. CLEARLY MARKED: it performs NO real provider call and dials
 * NO supervisor — it exists so the governed-chat UI is demoable before the
 * supervisor's stdio bridge server is packaged. It offers a small fixed allowlist
 * and answers an allowlisted call with a synthetic completion; a non-allowlisted
 * model is DENIED (mirroring the broker's default-deny); an untrusted-provenance
 * call surfaces force_ask (mirroring the taint firewall). It NEVER holds, reads, or
 * returns a credential. Replace with the real SupervisorBridge gateway once packaged.
 *
 * NOT exported (spec §9): module-private, reachable only by the first-party
 * command handlers below.
 */
function stubModelGateway() {
    const allowed = [
        {
            provider: 'anthropic',
            model: 'claude-3-7-sonnet',
            endpointHost: 'api.anthropic.com',
            label: 'anthropic / claude-3-7-sonnet',
        },
        {
            provider: 'openai',
            model: 'gpt-4o',
            endpointHost: 'api.openai.com',
            label: 'openai / gpt-4o',
        },
    ];
    return {
        // DEMO POSTURE (sweep-20 High #4): this gateway makes NO supervisor call. The
        // webview reads this and renders the demo/unbrokered state instead of claiming
        // the call was brokered/auditable/traced.
        mode: 'stub',
        async allowlist() {
            return allowed.slice();
        },
        async call(params) {
            const onList = allowed.some((m) => m.provider === params.provider && m.model === params.model);
            if (!onList) {
                return {
                    decision: 'deny',
                    ok: false,
                    error: `model ${params.provider}/${params.model} not on allowlist (default-deny)`,
                };
            }
            const untrusted = params.provenanceLabel !== 'user' && params.provenanceLabel !== 'system';
            if (untrusted) {
                return {
                    decision: 'force_ask',
                    ok: false,
                    error: `model call requires confirmation (untrusted provenance '${params.provenanceLabel}')`,
                };
            }
            const turns = params.messages.length;
            return {
                decision: 'allow',
                ok: true,
                completion: `[stub model:${params.model}] received ${turns} turn(s). This is a synthetic ` +
                    'completion — no real provider was called. Package the supervisor bridge ' +
                    'server to broker a real model call.',
                usage: { inputTokens: turns * 8, outputTokens: 24, costMicroUsd: 0 },
                traceEventRef: `stub-${Date.now().toString(36)}`,
            };
        },
    };
}
/**
 * Singleton governed-chat webview. Hosts the chat + inline-edit surface, surfaces
 * ONLY the supervisor's allowlisted models, renders decision/completion/usage/
 * traceRef, handles deny + force_ask, and DIFF-GATES any edit it applies to a file.
 * The provider credential never reaches this panel — it only ever sees the
 * redacted result from the gateway.
 */
class ChatPanel {
    static createOrShow(extensionUri, gateway) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ChatPanel.current) {
            ChatPanel.current.panel.reveal(column);
            return ChatPanel.current;
        }
        const panel = vscode.window.createWebviewPanel('glyphcodeChat', 'GlyphCode Chat', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        });
        ChatPanel.current = new ChatPanel(panel, extensionUri, gateway);
        return ChatPanel.current;
    }
    constructor(panel, extensionUri, gateway) {
        this.disposables = [];
        this.ready = false;
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.gateway = gateway;
        this.panel.webview.html = this.getWebviewContent(this.panel.webview);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
        // RETURN the onMessage promise (VS Code ignores it) so a test can await an
        // otherwise fire-and-forget message handler deterministically.
        (msg) => this.onMessage(msg), null, this.disposables);
    }
    reveal() {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        this.panel.reveal(column);
    }
    /** Set the active run id the chat brokers calls against. */
    setRunId(runId) {
        this.runId = runId;
        if (this.ready)
            void this.panel.webview.postMessage({ type: 'chatRunId', runId });
    }
    /**
     * Seed an inline-edit: stash the selection (with its provenance) as context to
     * fold into the next user turn, and prefill the input via a status message.
     */
    seedInlineEdit(filePath, selection, instruction) {
        this.pendingContext = [
            {
                ref: filePath,
                kind: 'workspace-file',
                content: selection,
                provenanceLabel: 'workspace',
            },
        ];
        void this.panel.webview.postMessage({
            type: 'chatStatus',
            status: `inline-edit context staged from ${filePath} (${selection.length} chars). Your next message edits it.`,
        });
        if (instruction) {
            // Treat the instruction as an immediate user turn against the selection.
            void this.handleSend(instruction, true, 'user');
        }
    }
    async onMessage(msg) {
        if (!msg || typeof msg !== 'object')
            return;
        if (msg.type === 'ready') {
            this.ready = true;
            // Tell the webview the gateway's honesty posture FIRST (sweep-20 High #4): on
            // the stub gateway it renders an explicit demo/unbrokered banner and must not
            // claim the call was brokered/auditable/traced. The webview defaults to the
            // demo posture until this arrives, so it never over-claims during boot.
            void this.panel.webview.postMessage({ type: 'chatGatewayMode', mode: this.gateway.mode });
            const models = await this.gateway.allowlist();
            // Guard: never forward a credential-shaped field to the webview.
            void this.panel.webview.postMessage({ type: 'chatAllowlist', models });
            if (this.runId) {
                void this.panel.webview.postMessage({ type: 'chatRunId', runId: this.runId });
            }
            return;
        }
        if (msg.type === 'chatSelectModel') {
            // Record the operator's model selection (sweep-20 Medium #5). It is RE-VALIDATED
            // against the current allowlist at send time, so recording a label here is safe
            // even if the allowlist changes before the next send.
            const label = typeof msg.label === 'string' ? msg.label : undefined;
            this.selectedLabel = label && label.length > 0 ? label : undefined;
            return;
        }
        if (msg.type === 'chatSend') {
            await this.handleSend(String(msg.text ?? ''), Boolean(msg.includeSelection), 'user');
            return;
        }
        if (msg.type === 'chatApproveRetry') {
            // The operator approved a force_ask: retry as a TRUSTED (user) provenance
            // turn so the taint firewall permits it (the human is now in the loop).
            await this.handleSend(String(msg.text ?? ''), Boolean(msg.includeSelection), 'user');
            return;
        }
    }
    /**
     * Broker one chat turn. Assembles the {@link ModelCallParams} (WITH any staged
     * inline-edit context / active selection), calls the gateway, and posts the
     * redacted result back to the webview. If the result is an allowed completion AND
     * an inline-edit context was staged, it DIFF-GATES the edit (shows the proposed
     * change and only applies on explicit confirmation).
     */
    async handleSend(text, includeSelection, provenance) {
        if (!text.trim())
            return;
        if (!this.runId) {
            void this.panel.webview.postMessage({
                type: 'chatStatus',
                status: 'no active run — open a governed run first (GlyphCode: Run Governed Task).',
            });
            return;
        }
        const contextSources = [];
        if (this.pendingContext)
            contextSources.push(...this.pendingContext);
        if (includeSelection) {
            const sel = activeEditorSelection();
            if (sel) {
                contextSources.push({
                    ref: sel.ref,
                    kind: 'workspace-file',
                    content: sel.text,
                    provenanceLabel: 'workspace',
                });
            }
        }
        // Resolve the model THE OPERATOR SELECTED, re-validated against the CURRENT
        // supervisor allowlist immediately before the call (sweep-20 Medium #5). The
        // selection wins when still allowlisted; otherwise we fall back to the first
        // allowlisted model (a single allowlist read covers both branches). This stops
        // the host calling one model while the operator selected another.
        const chosen = await this.resolveModelForCall();
        if (!chosen) {
            void this.panel.webview.postMessage({
                type: 'chatStatus',
                status: 'no allowlisted model is available — the supervisor offered none.',
            });
            return;
        }
        const params = {
            runId: this.runId,
            provider: chosen.provider,
            model: chosen.model,
            messages: [{ role: 'user', content: text }],
            provenanceLabel: provenance,
            ...(contextSources.length ? { contextSources } : {}),
        };
        const result = await this.gateway.call(params);
        void this.panel.webview.postMessage({ type: 'chatResult', result });
        // DIFF-GATE an inline edit: if this turn carried file context AND the model
        // produced an allowed completion, offer to apply it as a diff (never auto-apply).
        if (this.pendingContext &&
            result.ok &&
            result.decision === 'allow' &&
            typeof result.completion === 'string') {
            const ctx = this.pendingContext[0];
            this.pendingContext = undefined;
            await this.offerDiffGatedEdit(ctx.ref, ctx.content ?? '', result.completion);
        }
    }
    /**
     * Resolve the model to call (sweep-20 Medium #5). Reads the CURRENT supervisor
     * allowlist ONCE and honors the operator's selected label when it is STILL
     * allowlisted; otherwise falls back to the first allowlisted model. Returns
     * undefined only when the allowlist is empty (the UI then cannot send). Validating
     * the selection against the live allowlist right before the call means a model the
     * supervisor has since dropped can never be used just because it was selected.
     */
    async resolveModelForCall() {
        const models = await this.gateway.allowlist();
        if (models.length === 0)
            return undefined;
        if (this.selectedLabel) {
            const selected = models.find((m) => m.label === this.selectedLabel);
            if (selected)
                return selected;
        }
        return models[0];
    }
    /**
     * DIFF-GATE a proposed inline edit: show the operator the before/after as a diff
     * and apply the edit to the file ONLY on explicit confirmation. We never write
     * the file without the operator choosing "Apply edit".
     */
    async offerDiffGatedEdit(ref, before, after) {
        if (before === after)
            return;
        const choice = await vscode.window.showInformationMessage(`GlyphCode: the model proposed an edit to ${ref}. Review and apply?`, { modal: true }, 'Show diff', 'Apply edit');
        if (choice === 'Show diff') {
            // Open a read-only diff between the current selection and the proposal.
            const left = vscode.Uri.parse(`untitled:${ref} (current)`);
            const right = vscode.Uri.parse(`untitled:${ref} (proposed)`);
            const leftDoc = await vscode.workspace.openTextDocument({ content: before });
            const rightDoc = await vscode.workspace.openTextDocument({ content: after });
            void left;
            void right;
            await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, `GlyphCode edit · ${ref}`);
            return;
        }
        if (choice === 'Apply edit') {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                await editor.edit((b) => b.replace(editor.selection, after));
            }
            else {
                void vscode.window.showWarningMessage('GlyphCode: no active selection to apply the edit to — edit not applied.');
            }
        }
    }
    dispose() {
        ChatPanel.current = undefined;
        while (this.disposables.length)
            this.disposables.pop()?.dispose();
    }
    getWebviewContent(webview) {
        const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
        const htmlPath = vscode.Uri.joinPath(mediaUri, 'chat.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'styles.css'));
        const chatViewUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chatView.js'));
        const chatUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat.js'));
        const nonce = crypto.randomBytes(16).toString('base64');
        // Inline the GlyphCode icon sprite (see readIconsSprite / ICON-USAGE.md).
        const iconsSprite = readIconsSprite(mediaUri);
        return html
            .replace('{{iconsSprite}}', iconsSprite)
            .replace(/\{\{cspSource\}\}/g, webview.cspSource)
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{stylesUri\}\}/g, stylesUri.toString())
            .replace(/\{\{chatViewUri\}\}/g, chatViewUri.toString())
            .replace(/\{\{chatUri\}\}/g, chatUri.toString());
    }
}
/**
 * Singleton native-chat webview. Owns ONE {@link ChatSession} (opened lazily on the
 * first send and reused across turns), assembles the conversation the webview posts,
 * drives bridge chat/send, and forwards each chat/delta event to the webview. The
 * provider credential never reaches this panel — chat/send carries none and the
 * supervisor holds none either (Codex authenticates from its own store).
 */
class NativeChatPanel {
    static createOrShow(extensionUri, sessionFactory) {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (NativeChatPanel.current) {
            NativeChatPanel.current.panel.reveal(column);
            return NativeChatPanel.current;
        }
        const panel = vscode.window.createWebviewPanel('glyphcodeNativeChat', 'GlyphCode Chat', column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        });
        NativeChatPanel.current = new NativeChatPanel(panel, extensionUri, sessionFactory);
        return NativeChatPanel.current;
    }
    constructor(panel, extensionUri, sessionFactory) {
        this.disposables = [];
        this.ready = false;
        /** Guard: one turn in flight at a time (the composer is disabled meanwhile). */
        this.sending = false;
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.sessionFactory = sessionFactory;
        this.panel.webview.html = this.getWebviewContent(this.panel.webview);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
        // RETURN the onMessage promise so a test can await an otherwise fire-and-forget
        // handler deterministically (VS Code itself ignores the return).
        (msg) => this.onMessage(msg), null, this.disposables);
    }
    reveal() {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        this.panel.reveal(column);
    }
    async onMessage(msg) {
        if (!msg || typeof msg !== 'object')
            return;
        if (msg.type === 'ready') {
            this.ready = true;
            return;
        }
        if (msg.type === 'chatSend') {
            const messages = Array.isArray(msg.messages) ? msg.messages : [];
            await this.handleSend(messages);
            return;
        }
    }
    /**
     * Drive ONE chat turn. Opens the session lazily, posts a "thinking…" turn-start to
     * the webview, calls bridge chat/send with the FULL transcript, and streams each
     * chat/delta event to the webview (appending delta text, finalizing on done, or
     * rendering error.message honestly). Resolve-never-throw: any failure becomes a
     * chatError the webview renders.
     */
    async handleSend(messages) {
        // Sanitize the transcript to {role, content} pairs (defense-in-depth: the webview
        // posts only these, but never trust an inbound webview payload's shape).
        const clean = messages
            .filter((m) => m &&
            (m.role === 'user' || m.role === 'assistant' || m.role === 'system') &&
            typeof m.content === 'string')
            .map((m) => ({ role: m.role, content: m.content }));
        if (clean.length === 0) {
            this.postError('empty message — nothing to send.');
            return;
        }
        if (this.sending) {
            // A turn is already in flight; ignore (the webview also disables the composer).
            return;
        }
        this.sending = true;
        this.post({ type: 'chatTurnStart' });
        try {
            const session = await this.ensureSession();
            if (!session) {
                // ensureSession already posted the error.
                return;
            }
            const outcome = await session.sendTurn(clean, {
                onEvent: (event) => this.onChatEvent(event),
            });
            // A transport-level failure that produced no terminal event still finalizes.
            if (!outcome.ok && outcome.message) {
                // onChatEvent already rendered a terminal error if one streamed; if not,
                // surface the outcome message so the UI never hangs in the thinking state.
                this.postError(outcome.message);
            }
        }
        catch (err) {
            this.postError(`chat turn failed: ${String(err?.message ?? err)}`);
        }
        finally {
            this.sending = false;
            this.post({ type: 'chatBusy', busy: false });
        }
    }
    /** Map a streamed chat/delta event to the webview's render messages. */
    onChatEvent(event) {
        if (event.type === 'delta') {
            this.post({ type: 'chatDelta', text: event.text });
        }
        else if (event.type === 'done') {
            this.post({ type: 'chatDone' });
        }
        else if (event.type === 'error') {
            this.postError(event.message);
        }
    }
    /** Open the chat session lazily; report a connect failure honestly to the webview. */
    async ensureSession() {
        if (this.session)
            return this.session;
        const opened = await this.sessionFactory.open();
        if (!opened.connected || !opened.session) {
            this.postError(opened.message || 'could not open the governed chat session.');
            return undefined;
        }
        this.session = opened.session;
        return this.session;
    }
    post(msg) {
        // VS Code queues messages to a live webview, so a post that races the webview's
        // `ready` signal is delivered once it boots — no pre-ready buffering needed.
        void this.panel.webview.postMessage(msg);
    }
    postError(message) {
        this.post({ type: 'chatError', message });
    }
    dispose() {
        NativeChatPanel.current = undefined;
        try {
            this.session?.dispose();
        }
        catch {
            /* best-effort teardown */
        }
        this.session = undefined;
        while (this.disposables.length)
            this.disposables.pop()?.dispose();
    }
    getWebviewContent(webview) {
        const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
        const htmlPath = vscode.Uri.joinPath(mediaUri, 'native-chat.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'styles.css'));
        const nativeChatUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'native-chat.js'));
        const nonce = crypto.randomBytes(16).toString('base64');
        const iconsSprite = readIconsSprite(mediaUri);
        return html
            .replace('{{iconsSprite}}', iconsSprite)
            .replace(/\{\{cspSource\}\}/g, webview.cspSource)
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{stylesUri\}\}/g, stylesUri.toString())
            .replace(/\{\{nativeChatUri\}\}/g, nativeChatUri.toString());
    }
}
/** The active editor's selection (or whole document) + its workspace ref. */
function activeEditorSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return undefined;
    const doc = editor.document;
    const ref = vscode.workspace.asRelativePath(doc.uri);
    const text = editor.selection.isEmpty
        ? doc.getText()
        : doc.getText(editor.selection);
    return { ref, text };
}
function activate(context) {
    const gate = getWebviewGestureGate();
    // ACTIVITY-BAR "Governed Runs" view (first GlyphCode sidebar surface). A real
    // TreeView backed by the run model, which is fed the SAME run/event stream the
    // Trust Panel renders (TrustPanel.postRunEvent feeds it). The view title carries
    // the "New Governed Terminal" + "Open Trust Panel" actions; an empty model shows
    // the viewsWelcome (declared in package.json) with the New Governed Terminal CTA.
    const runsModel = getGovernedRunsModel();
    const runsTree = new governedRunsTree_1.GovernedRunsTreeProvider(runsModel, context.extensionUri);
    context.subscriptions.push(runsTree);
    // AGENT VIEW snapshot transport (Slice 1, design §2). The native workbench Home
    // surface cannot import this tree (layer boundary), so it reaches the run set
    // through TWO read-only commands:
    //   glyphcode.runs.snapshot  → the AgentRunSnapshot projection (newest-first runs
    //                              + the per-run webview-verified fact), built from the
    //                              SAME GovernedRunsModel the tree/cards render. Pure
    //                              projection (agentRunSnapshot.ts) — never invents a row.
    //   glyphcode.runs.revision  → a monotonic counter bumped on every run-set change
    //                              (and on a webview signature confirmation). The
    //                              workbench polls this cheap counter and only re-fetches
    //                              the full snapshot when it advances — a pull transport
    //                              that matches VS Code's command seam (a command cannot
    //                              PUSH to the workbench) without busy work.
    // The verified fact is read from the canonical RunStatusController set, so the
    // snapshot's 'verified' eligibility uses the SAME signature gate the status bar /
    // gutter / cards use — the workbench mirror re-derives the card state from it.
    context.subscriptions.push(runsModel.onDidChange(() => bumpAgentRunsRevision()));
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.runs.snapshot', () => (0, agentRunSnapshot_1.projectAgentRuns)(runsModel.list(), (runId) => getRunStatusController().isVerified(runId))));
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.runs.revision', () => agentRunsRevision));
    // AGENT VIEW per-run EVIDENCE transport (Slice 2 Part A, design §1/§3). The native
    // Evidence pane reaches ONE run's evidence through a third read-only command:
    //   glyphcode.runs.detail(runId) → the AgentRunDetail projection (rev 2: intent +
    //                                  authorityLevel + changed files + diff + the SIGNED
    //                                  verifier verdict facts) for the pane, or `undefined`
    //                                  if the run is unknown to the model. Built from the
    //                                  SAME GovernedRunsModel row (which now retains the
    //                                  run intent from run_created), the SAME canonical
    //                                  webview-verified gate the snapshot uses
    //                                  (RunStatusController.isVerified — NOT a
    //                                  re-implemented Ed25519 check; the workbench never
    //                                  re-verifies), the SAME canonical per-run authority
    //                                  the status bar computes (authorityFor — for the
    //                                  Slice-4 halo), and the latest AUTHORITATIVE review
    //                                  retained per runId on the Trust Panel
    //                                  (getRetainedReview). No review yet → an honest
    //                                  empty-changes / no-verdict shape (never a faked PASS).
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.runs.detail', (runId) => {
        if (typeof runId !== 'string' || runId.length === 0)
            return undefined;
        const summary = runsModel.get(runId);
        if (!summary)
            return undefined; // unknown run — never fabricate evidence
        return (0, agentRunDetail_1.projectAgentRunDetail)(summary, TrustPanel.peekCurrent()?.getRetainedReview(runId), getRunStatusController().isVerified(runId), 
        // The CANONICAL per-run authority — the SAME status-bar computation, so the
        // Slice-4 halo reflects only what the verifier proved (Slices 3 & 4 Part A).
        getRunStatusController().authorityFor(runId));
    }));
    // STATUS-BAR SEGMENTS + HALO FALLBACK + the glyphcode.authority context-key
    // (Slice 2, §1.12 / §1.1 / §2.2). The controller creates the four status-bar
    // items, sets the context-key the future fork ring reads, and (opt-in behind
    // glyphcode.halo.tintChrome, default OFF) reversibly tints chrome edges. Fed by
    // the SAME run/event stream via TrustPanel.postRunEvent → controller.notify.
    const statusController = getRunStatusController();
    statusController.attach(context);
    context.subscriptions.push({ dispose: () => void statusController.dispose() });
    // PROVENANCE GUTTER (Slice 3, §5.5/§8). The editor-area trust-origin decorations:
    // per-region amber (claimed) / blue (verified) / violet (soft) / slate (human)
    // gutter bars + minimap stripes + whole-line tint over the focused run's changed
    // files. Created here (it needs the extensionUri for the colored-bar icon assets),
    // fed the SAME run/event stream (TrustPanel.postRunEvent → notify), the SAME webview
    // signature-verified confirmation (glyphcodeAuthority → confirmVerified — the
    // amber→blue flip / tamper revert), and the agentic build's git diff (the honest
    // hunk source). attach() wires the active-editor change listener and pushes the
    // controller's dispose (which drops the four decoration types) into subscriptions.
    provenanceGutterController = new provenanceGutter_1.ProvenanceGutterController(context.extensionUri);
    provenanceGutterController.attach(context);
    context.subscriptions.push(vscode.window.createTreeView('glyphcode.runs', {
        treeDataProvider: runsTree,
        showCollapseAll: false,
    }));
    // ACTIVITY-BAR "Governed Runs" CARDS view (Slice 4, §5.4 — the card-webview upgrade
    // of the run row). A webview-view rendering the SAME run model as the cards mockup:
    // colored left-border + status PILL (acting/verified/blocked) per run, then the
    // focused run's "Changed in run" list with provenance dots. Reuses the provenance
    // gutter as the changed-files + dot seam, and the SAME signature gate (confirmVerified)
    // the status bar + gutter use — so a SOFT run is capped at ACTING and VERIFIED-green
    // appears ONLY on the webview-confirmed signature. A card click runs openRun, which
    // focuses the Trust Panel + gutter on that run.
    governedRunsCardView = new governedRunsCardView_1.GovernedRunsCardViewProvider(context.extensionUri, runsModel, {
        changedFilesFor: (runId) => getProvenanceGutterController()?.changedFilesFor(runId) ?? [],
        fileDotState: (path, runId) => getProvenanceGutterController()?.fileDotState(path, runId) ?? 'human',
        focusedRun: () => getProvenanceGutterController()?.focusedRun(),
    });
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(governedRunsCardView_1.GovernedRunsCardViewProvider.viewType, governedRunsCardView, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push({
        dispose: () => {
            governedRunsCardView?.dispose();
            governedRunsCardView = undefined;
        },
    });
    // RAIL GOVERNANCE-SURFACE READERS (Slice 4, §5.3 / §5.9). Each governance icon in the
    // rail is its own activity-bar view container (package.json viewsContainers). The Runs
    // surface is fully built (the cards above); the other NINE surfaces (trace · policy ·
    // verifier · egress · model-calls · workspace · search · settings · actor) are now real
    // WEBVIEW VIEWS backed by per-surface stub providers under src/surfaces/. The stubs
    // render an HONEST "<surface> — coming online" placeholder (no fabricated trust data)
    // and implement the GovernanceSurfaceProvider SEAM: each is registered into the shared
    // GovernanceSurfaceRegistry, which TrustPanel.postRunEvent fans EVERY raw run/event
    // envelope out to — so a per-surface reader consumes the IDENTICAL stream the panel /
    // model / status bar / gutter / cards consume, with no new supervisor API. Per-surface
    // readers replace each stub's render in its own file (naming convention in
    // surfaceViewBase.ts). NOTE: making the rail governance-ONLY (hiding the stock
    // Explorer/Extensions icons) is a FORK tweak — an extension cannot hide stock containers
    // — deferred to the integration fork build.
    //
    // ROBUST REGISTRATION (defense-in-depth): registerWebviewViewProvider does NOT throw on
    // an as-yet-unregistered view id (it resolves lazily when the view is first shown), so a
    // newly-added activity-bar container simply resolves its provider on next show / full
    // relaunch. We STILL wrap each surface registration in a per-id try/catch (below) so that
    // any single failing registration is isolated and never aborts activate() or the other
    // surfaces. We log the registered set for diagnostics.
    const surfaceOutput = vscode.window.createOutputChannel('GlyphCode');
    context.subscriptions.push(surfaceOutput);
    const surfaceRegistry = getGovernanceSurfaceRegistry();
    const surfaceProviders = [
        new surfaces_1.TraceSurfaceViewProvider(context.extensionUri),
        new surfaces_1.PolicySurfaceViewProvider(context.extensionUri),
        new surfaces_1.VerifierSurfaceViewProvider(context.extensionUri),
        new surfaces_1.EgressSurfaceViewProvider(context.extensionUri),
        new surfaces_1.ModelCallsSurfaceViewProvider(context.extensionUri),
        new surfaces_1.WorkspaceSurfaceViewProvider(context.extensionUri),
        new surfaces_1.SearchSurfaceViewProvider(context.extensionUri),
        new surfaces_1.SettingsSurfaceViewProvider(context.extensionUri),
        new surfaces_1.ActorSurfaceViewProvider(context.extensionUri),
    ];
    for (const provider of surfaceProviders) {
        // Per-surface try/catch (defense-in-depth): registerWebviewViewProvider does not throw
        // on an as-yet-unregistered manifest id (it resolves lazily on first show), but should
        // any single surface registration fail, isolate it so the OTHER surfaces (and the rest
        // of activate()) still come up — graceful degradation, never an aborted activation.
        try {
            // (a) Register the webview view provider for the surface's package.json view id.
            context.subscriptions.push(vscode.window.registerWebviewViewProvider(provider.surfaceId, provider, {
                webviewOptions: { retainContextWhenHidden: true },
            }));
            // (b) Register the SAME provider into the run/event fan-out registry so it sees the
            //     shared stream (postRunEvent → registry.dispatch → provider.ingestRunEvent).
            surfaceRegistry.register(provider);
            // (c) Dispose the provider's webview state on deactivate.
            context.subscriptions.push({ dispose: () => provider.dispose() });
        }
        catch (err) {
            surfaceOutput.appendLine(`[host] surface ${provider.surfaceId} failed to register (skipped): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    surfaceOutput.appendLine(`[host] registered ${surfaceProviders.length} rail governance surfaces: ${surfaceRegistry
        .surfaceIds()
        .join(', ')}`);
    // REDUCED-MOTION SETTING LISTENER (§14.3). Keep the Trust Panel's deny-pulse +
    // amber→blue trust cross-fades in step with the user's GlyphCode Halo Motion toggle
    // (glyphcode.workbench.haloMotion): the panel injects the setting as a global on
    // creation and posts it on `ready`; here we POST it again whenever the setting
    // changes so a live toggle takes effect without reopening the panel. Registered as a
    // disposable (no leak) and guarded so a stub host without the config event is safe.
    // View-only — it changes nothing about trust, only whether those two animations play.
    if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('glyphcode.workbench.haloMotion')) {
                TrustPanel.notifyReduceMotion();
            }
        }));
    }
    // ACTIVITY-BAR "Chat" view (the SIDEBAR "chat that's a terminal"). A webview-view
    // hosting an xterm.js terminal connected to a real PTY running the user's
    // interactive `claude`, governed. Reuses the entire governed stack (bridge session,
    // forced-proxy + secret-firewall env, run/event projection into the Trust Panel +
    // Governed Runs view). The PTY backend is node-pty (proven in spikes/p0-governed-pty).
    const chatViewOutput = vscode.window.createOutputChannel('GlyphCode Chat');
    context.subscriptions.push(chatViewOutput);
    const chatViewProvider = new chatTerminalView_1.ChatTerminalViewProvider(context.extensionUri, buildChatTerminalDeps(context, chatViewOutput), chatViewOutput);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatTerminalView_1.ChatTerminalViewProvider.viewType, chatViewProvider, { webviewOptions: { retainContextWhenHidden: true } }));
    context.subscriptions.push({ dispose: () => chatViewProvider.dispose() });
    // Tree-row click → focus the Trust Panel on that run (view-only navigation;
    // confers no trust and starts nothing). Opens/reveals the panel, then selects
    // the run; the panel buffers the selection if the webview is still booting.
    context.subscriptions.push(vscode.commands.registerCommand(governedRunsTree_1.OPEN_RUN_COMMAND, (runId) => {
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
        if (typeof runId === 'string' && runId.length > 0) {
            panel.selectRun(runId);
        }
    }));
    // Title-bar action on the Governed Runs view: New Governed Terminal. Delegates to
    // the EXISTING governed-terminal command so the sidebar button and the command
    // palette share one code path (no duplicated launch logic).
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.runs.newGovernedTerminal', () => vscode.commands.executeCommand('glyphcode.openGovernedTerminal')));
    // Title-bar action: Open Trust Panel. Surfaces the existing Trust Panel webview
    // from the sidebar (the lower-risk path: the panel stays a WebviewPanel; the
    // sidebar contributes a prominent action to reveal it).
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.runs.openTrustPanel', () => {
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.openTrustPanel', () => {
        TrustPanel.createOrShow(context.extensionUri, gate);
    }));
    // SET FRICTION TIER (Blended Workbench PATCH-009). The CANONICAL friction control —
    // the native title-bar Authority Ladder (fork, glyphcodeTitleLadder.ts) — invokes
    // this on a rung click. It (a) validates the tier, (b) routes through the SINGLE
    // writer (TierController) which sets the `glyphcode.tier` context-key the native
    // ladder + the editor-recede chrome read, and (c) syncs the Trust Panel webview
    // ladder if one is open. It does NOT force-open the panel.
    //
    // VIEW-ONLY (§6, §2.4 "tier is enforced authority, not a UI hint"): selecting a rung
    // changes friction / which evidence is visible. It does NOT grant authority and NEVER
    // touches the assurance axis (`glyphcode.authority` / the halo). The promote modal
    // remains the only authority door. An unknown tier is rejected (fail closed to no-op).
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.setTier', (tier) => {
        if (typeof tier === 'string' && isFrictionTier(tier)) {
            getTierController().set(tier, { syncWebview: true });
        }
    }));
    // Inline edit (Cmd-K-style) is now a REAL governed gateway edit, registered via
    // registerInlineEdit(...) further below (alongside the chat agent) so it can REUSE the
    // SAME governed Codex session factory the chat participant is wired with. The former
    // stub-gateway demo preview has been removed.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.loadRunBundle', async () => {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Load run bundle',
            title: 'Select a GlyphCode run bundle directory (trace.jsonl + verdict.json + verifier-public-key.pem)',
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
        panel.loadBundleFromDirectory(picked[0].fsPath);
    }));
    // Live Trust Panel demo (milestone M5). Opens the panel and streams a mock
    // run/event sequence through the SAME host→webview seam (postRunEvent) the real
    // supervisor stream will use. A scenario can be passed as the command argument
    // (one of MOCK_SCENARIOS) to exercise a specific failure state; default is the
    // isolated-native happy path. This is the stub event source the design calls for
    // until the supervisor-side stdio server is wired.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.demoLiveRun', async (scenarioArg) => {
        const scenario = mockRunStream_1.MOCK_SCENARIOS.includes(scenarioArg)
            ? scenarioArg
            : 'isolated-native';
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
        const runId = `demo-${scenario}-${Date.now().toString(36)}`;
        const events = (0, mockRunStream_1.mockRunStream)(scenario, runId);
        // Stream the envelopes with a small delay so the panel renders them as a
        // live feed rather than all at once. postRunEvent buffers any that arrive
        // before the webview signals ready.
        let i = 0;
        const tick = () => {
            if (i >= events.length)
                return;
            panel.postRunEvent(events[i]);
            i += 1;
            setTimeout(tick, 200);
        };
        tick();
    }));
    // AGENTIC BUILD REVIEW PREVIEW (Phase B). Opens the Trust Panel and renders a
    // realistic FIXTURE review so Cory can SEE the review UI now — the compact
    // evidence object (intent + actor + honest governed-unsandboxed posture, signed
    // pass verdict, changed files, the unified-diff viewer, commands incl. a passing
    // `npm test`, observed egress) plus the accept/reject/request-changes controls.
    // Clearly a PREVIEW (the view shows a fixture tag); the real backend posts the
    // same shape via TrustPanel.postAgenticBuildReview.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.previewAgenticBuildReview', () => {
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
        panel.postAgenticBuildReview((0, agenticBuildReview_1.previewAgenticBuildReviewFixture)(), true);
    }));
    // VERIFY (Auto Test) — the EXECUTABLE-verify layer (catches LOGIC bugs the
    // structural compile gate cannot). Highlight a function → right-click → generate
    // edge-case tests FROM THE SPEC (doc+signature, not the body, so AI expectations
    // don't inherit the implementation's bug) → run them in a v1 local timed sandbox
    // (child Node process, minimal env, hard timeout) → show an honest CHARACTERIZATION
    // evidence card. The HarnessRunner seam routes execution through the governed run
    // envelope in a later version.
    for (const disposable of (0, verifyAutoTest_1.registerVerifyAutoTest)(context)) {
        context.subscriptions.push(disposable);
    }
    // GOVERNED AGENTIC BUILD — THE CHAT→ACTOR PROMOTION (Phase C-UI capstone).
    // "GlyphCode: Build This (Governed Run)". This is the EXPLICIT authority boundary
    // (docs/developer-trust-model.md): chat stays Ask (lightweight); promoting a task into
    // a governed agent run that EDITS FILES and RUNS COMMANDS is where friction belongs. The
    // command resolves the workspace folder as cwd (honest error if none), takes the build
    // intent (an arg from the chat surface, or a quick-input prompt), shows an UP-FRONT
    // authority modal naming the boundary honestly (governed-unsandboxed — traced, NOT
    // sandboxed), and ONLY on explicit confirm starts the build with approved:true. A decline
    // does nothing. As build/event arrives, progress shows in an output channel; the terminal
    // result renders the diff + verdict in the Trust Panel for the second gate (Accept/Reject).
    const buildOutput = vscode.window.createOutputChannel('GlyphCode Governed Build');
    context.subscriptions.push(buildOutput);
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.promoteChatToBuild', (intentArg) => promoteChatToBuild(context, gate, buildOutput, intentArg)));
    // REVOKE the per-workspace "Always Allow" governed-build grant (N1). Clears the
    // workspaceState key so the next governed build shows the up-front authority modal
    // again. Honest, idempotent, and surfaces whether a grant was actually present.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.revokeBuildAuthority', async () => {
        const had = context.workspaceState.get(BUILD_AUTHORITY_GRANTED_KEY) === true;
        await context.workspaceState.update(BUILD_AUTHORITY_GRANTED_KEY, undefined);
        void vscode.window.showInformationMessage(had
            ? 'GlyphCode: revoked the remembered governed-build authorization for this workspace. ' +
                'The next governed build will ask for authority again.'
            : 'GlyphCode: no remembered governed-build authorization for this workspace — ' +
                'the up-front modal already fires on every build.');
    }));
    // Output channel for the supervisor's human-readable progress (stderr). One
    // per session; disposed with the extension.
    const supervisorOutput = vscode.window.createOutputChannel('GlyphCode Governed Run');
    context.subscriptions.push(supervisorOutput);
    // GOVERNED TERMINAL (M7). Opens a REAL VS Code terminal whose egress is FORCED
    // through the supervisor-owned metadata-only proxy and whose env is sanitized of
    // ambient host secrets/capability handles, then streams the session's governed
    // model-call + egress-decision metadata LIVE into the Trust Panel. This surface is
    // honestly GOVERNED (egress proxied, trace signed) but UNSANDBOXED — the
    // `governed-unsandboxed` posture — so it can NEVER mint a product-trusted run and
    // is NOT routed through the trusted-run gesture gate below (there is no product-
    // trust lever to protect). The command opens the governed terminal directly.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.openGovernedTerminal', () => openGovernedTerminal(context, supervisorOutput)));
    // GOVERNED FLOATING TERMINAL SEAM (⌃⌘K, Option A — the FORK calls these). The fork
    // hosts a cursor-anchored floating governed terminal in the renderer and drives its
    // lifecycle over this command bridge (it cannot spawn the supervisor/proxy or build
    // the governed env — all ext-side). startSession does the terminal/start handshake +
    // buildGovernedTerminalEnv and RETURNS the governed {runId, env, strictEnv, proxyUrl,
    // cwd, name} for the fork to host VERBATIM (B1a/AD8); stopSession finalizes the run
    // (idempotent, runId-scoped); registerOwned records the run as governed-owned (B2a).
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.governedTerminal.startSession', () => startGovernedFloatingTerminalSession(context, supervisorOutput)), vscode.commands.registerCommand('glyphcode.governedTerminal.stopSession', (runId) => stopGovernedFloatingTerminalSession(runId)), vscode.commands.registerCommand('glyphcode.governedTerminal.registerOwned', (runId) => {
        // B2a defence-in-depth: record the run as governed-owned. The PRIMARY A1
        // notice-suppression key is the terminal-NAME marker (onDidOpenTerminal hands a
        // Terminal, not a runId); this is a secondary, run-scoped ownership record. Inert
        // + best-effort; never throws.
        if (typeof runId === 'string' && runId.length > 0) {
            governedFloatingOwnedRunIds.add(runId);
        }
    }));
    // EXPLICITLY UNGOVERNED TERMINAL (⌃⌘U). A first-class, deliberate accelerator for a
    // PLAIN host shell — full host env, NO supervisor proxy, command + network egress NOT
    // traced. This is NOT a new escape hatch: stock/ungoverned terminals already exist
    // (Ctrl+`) and the A1 audit already labels them; ⌃⌘U is just an HONESTLY-LABELED
    // accelerator ("friction follows authority": a plain shell is a deliberate choice). The
    // INVARIANT: it is VISIBLY, honestly ungoverned — a neutral/amber badge, NEVER the
    // governed shield/green, and it is deliberately NOT added to glyphSpekOwnedTerminals.
    // It IS recorded in deliberatelyUngovernedTerminals so the A1 onDidOpenTerminal listener
    // skips it (its own one-time confirming notice is the single honest signal — no
    // double-nag). The command is also palette-invokable.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.openUngovernedTerminal', () => openUngovernedTerminal(context)));
    // GOVERNANCE-BOUNDARY LEGIBILITY (A1, Part 2 — honesty about STOCK terminals). A
    // "GlyphCode IDE" still exposes ungoverned stock terminals (the integrated terminal,
    // task/debug shells — full host env, untraced egress) that look almost identical to a
    // Governed Terminal. When a terminal GlyphCode did NOT create opens, show a one-time
    // (dismissible) honest warning that it is NOT governed/traced and offer to open a
    // governed one. Best-effort + non-fatal: a state-store/UI failure must never break
    // opening a terminal. The disposable is registered in context.subscriptions (no leak);
    // ownership is read from the WeakSet the governed createTerminal site populates.
    // Guarded on the API's presence so a minimal host/test stub without
    // onDidOpenTerminal degrades to no notice (the same defensive shape used elsewhere,
    // e.g. the ThemeColor guard) rather than throwing during activation.
    if (typeof vscode.window.onDidOpenTerminal === 'function') {
        context.subscriptions.push(vscode.window.onDidOpenTerminal((terminal) => {
            try {
                // DELIBERATE ⌃⌘U opens are NOT accidental stock terminals: the
                // openUngovernedTerminal command already shows its own honest one-time
                // confirming notice, so the A1 "did you mean a governed terminal?" steer must
                // SKIP them (one honest signal per terminal, not two). A1 STILL fires for
                // terminals GlyphCode didn't open (plain Ctrl+`), which are NOT in this set.
                if (deliberatelyUngovernedTerminals.has(terminal)) {
                    return;
                }
                // B2a / H6 — the FORK's ⌃⌘K floating governed terminal is created in the
                // RENDERER, so it can NEVER be in glyphSpekOwnedTerminals (a WeakSet of
                // ext-host Terminal objects the fork has no handle to) — yet it surfaces here
                // through onDidOpenTerminal. Left alone the A1 notice would MIS-FIRE for a
                // terminal GlyphCode itself governs + badges. Suppress it on the cross-process
                // NAME marker the fork created the terminal with (the seam key, not an
                // ext-host object). This is the H6 invariant: the notice does NOT fire for the
                // governed floating terminal.
                if ((0, governedFloatingTerminal_1.isGovernedFloatingTerminalName)({ terminalName: terminal.name })) {
                    return;
                }
                const isGlyphCodeOwned = glyphSpekOwnedTerminals.has(terminal);
                const dismissed = Boolean(context.globalState.get(ungovernedTerminalNotice_1.UNGOVERNED_TERMINAL_NOTICE_KEY));
                if (!(0, ungovernedTerminalNotice_1.shouldAnnounceUngovernedTerminal)({ isGlyphCodeOwned, dismissed })) {
                    return;
                }
                void vscode.window
                    .showWarningMessage(ungovernedTerminalNotice_1.UNGOVERNED_TERMINAL_NOTICE, 'New Governed Terminal', "Don't show again")
                    .then((choice) => {
                    if (choice === 'New Governed Terminal') {
                        void vscode.commands.executeCommand('glyphcode.openGovernedTerminal');
                    }
                    else if (choice === "Don't show again") {
                        void context.globalState.update(ungovernedTerminalNotice_1.UNGOVERNED_TERMINAL_NOTICE_KEY, true);
                    }
                });
            }
            catch {
                /* best-effort: the honest boundary notice must never break opening a terminal */
            }
        }));
    }
    // GlyphCode CHAT (M7). Chat = a governed terminal running INTERACTIVE Claude Code.
    // The interactive TUI IS the chat: it runs on the user's OWN subscription (auth from
    // ~/.claude; GlyphCode injects no credential), governed (egress via the supervisor's
    // metadata-only proxy), and traced (a governed-unsandboxed run in the Trust Panel +
    // Governed Runs sidebar). This reuses the EXACT openGovernedTerminal machinery and
    // auto-launches the detected interactive agent CLI. It NO LONGER opens the stub
    // ChatPanel/stubModelGateway — that fake gateway is retired as the chat path. The
    // API-key model broker is a separate, secondary path (parked).
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.openChat', () => openGovernedChat(context, supervisorOutput)));
    // INTERNAL/TEST-ONLY demo door for the RETIRED stub ChatPanel + stubModelGateway
    // surface. The legacy stub chat webview (chat.html sprite injection + the stub
    // gateway's model-selection/broker logic) is no longer reachable from a user-facing
    // command (openChat runs a governed terminal; inlineEdit is now the REAL governed
    // gateway edit). This command is deliberately NOT contributed in package.json#commands
    // (it does not appear in the palette) — it exists ONLY so the surviving stub-panel
    // unit tests (iconSpriteInjection / chatModelSelection) can still open and assert that
    // retired surface. Remove it when the stub ChatPanel itself is deleted.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.openStubChatPanel', () => {
        const panel = ChatPanel.createOrShow(context.extensionUri, stubModelGateway());
        panel.reveal();
        // Seed a demo run id so the stub gateway's broker path has an active run to call
        // against (the send path refuses with "no active run" otherwise) — matching what
        // the retired demo-inlineEdit door used to do.
        panel.setRunId(`stub-${Date.now().toString(36)}`);
    }));
    // GlyphCode NATIVE CHAT (M7). The "normal chat window": a webview where the user
    // types a message and sees the assistant reply, GOVERNED through our gateway —
    // bridge chat/send → the GlyphCode model gateway's CODEX backend on the user's own
    // ChatGPT subscription. This is a brokered, metadata-TRACED model call (governed,
    // UNSANDBOXED, never product-trusted); GlyphCode injects no credential (Codex
    // authenticates from its own ~/.codex store). Distinct from glyphcode.openChat,
    // which runs interactive Claude Code in a governed terminal.
    const chatOutput = vscode.window.createOutputChannel('GlyphCode Chat (Gateway)');
    context.subscriptions.push(chatOutput);
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.openNativeChat', () => {
        const factory = buildNativeChatSessionFactory(context, chatOutput);
        const panel = NativeChatPanel.createOrShow(context.extensionUri, factory);
        panel.reveal();
    }));
    // THE REAL FIX: make the FORK's STOCK "Build with Agent" chat view answer.
    // Register this first-party extension AS THE DEFAULT chat agent (+ a minimal,
    // user-selectable Codex-gateway language model so the fork's agent-invocation path
    // resolves a model instead of throwing "Language model unavailable"). Both route to
    // the SAME governed bridge chat/send → Codex gateway used by the native chat panel,
    // so a message typed into the built-in panel streams a governed Codex reply back into
    // that panel. The `isDefault`/`modes` manifest flags (gated by the defaultChatParticipant
    // proposal we enable for this built-in in product.json) make Send route here with no
    // extra user step. This is a brokered, metadata-TRACED model call on the user's own
    // ChatGPT subscription (governed, UNSANDBOXED, never product-trusted); no credential
    // is injected. The separate command-palette webview above is the legacy surface.
    context.subscriptions.push((0, chatParticipant_1.registerGlyphCodeChatAgent)(buildNativeChatSessionFactory(context, chatOutput), chatOutput));
    // INLINE EDIT (Cmd-K-style) — a REAL governed, gateway-backed edit. Reuses the EXACT
    // SAME governed Codex session factory the chat participant above is wired with
    // (buildNativeChatSessionFactory → openChatSession → chat/send → Codex gateway), so an
    // inline rewrite shares chat's governed posture: a brokered, metadata-TRACED model call
    // on the user's own ChatGPT subscription (governed, UNSANDBOXED, never product-trusted;
    // no credential injected). The rewrite is applied as an UNDOABLE WorkspaceEdit (⌘Z).
    (0, inlineEdit_1.registerInlineEdit)(context, buildNativeChatSessionFactory(context, chatOutput), chatOutput);
    // EVIDENCE-GROUNDED AI COMMIT MESSAGE — "GlyphCode: Generate Commit Message" (SCM input
    // sparkle + palette). Pre-fills the commit input with an AI message GROUNDED in the staged
    // diff, carrying a machine-parseable provenance trailer ONLY when a verdict's signature
    // verifies AND the staged content binds to what that verdict actually verified. Reuses the
    // EXACT SAME governed Codex session factory chat/inline-edit/terminal-Cmd-K use (a brokered,
    // metadata-TRACED model call on the user's own subscription — governed, UNSANDBOXED, never
    // product-trusted; no credential injected). The trust-critical decisions live in the pure,
    // headless-tested commitMessageLogic.ts. NEVER commits/stages/pushes; never clobbers existing
    // commit text on failure.
    (0, commitMessage_1.registerGenerateCommitMessage)(context, {
        sessionFactory: buildNativeChatSessionFactory(context, chatOutput),
        output: chatOutput,
    });
    // TERMINAL Cmd-K — the `glyphcode.terminalGenerateCommand` PALETTE command. D4a (unify
    // transition): it now targets the cursor-anchored FLOATING governed terminal, NOT the
    // panel terminal. On invoke it DELEGATES to the fork command
    // `glyphcode.floatingTerminal.describeCommand`, which opens the floating governed terminal
    // (refuse-not-degrade) and runs its "describe a command" NL fold-in there (generate →
    // sanitize → PRE-TYPE; operator's Enter launches, never auto-run). The ⌃⌘K accelerator
    // belongs to the fork's floating-terminal workbench action; this command is the
    // palette-invokable entry. The underlying generation still flows through the SAME governed
    // Codex gateway + terminalCommandGen sanitize via glyphcode.governedTerminal.generateCommand.
    (0, terminalCmdK_1.registerTerminalCmdK)(context, chatOutput);
    // D1/D2/D3/D4a — HEADLESS NL-generate for the FORK's ⌃⌘K floating terminal's
    // "describe a command" fold-in. Reuses the SAME governed Codex gateway +
    // terminalCommandGen sanitize as glyphcode.terminalGenerateCommand, but RETURNS the
    // single sanitized command STRING (or undefined) for the fork to PRE-TYPE into the
    // floating terminal — it never auto-runs (D3) and never fabricates on an empty/garbage
    // reply (D5: returns undefined → the fork pre-types nothing). The fork prompts for the
    // NL instruction and passes it as the first arg; with no arg the command resolves
    // undefined (honest no-op). This is the D4a unify target: the palette/floating NL path
    // generates INTO the floating terminal, not the panel terminal.
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.governedTerminal.generateCommand', async (instruction) => {
        if (typeof instruction !== 'string' || instruction.trim().length === 0) {
            return undefined;
        }
        const req = {
            instruction,
            platform: process.platform,
            shell: typeof vscode.env.shell === 'string'
                ? vscode.env.shell.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/iu, '')
                : undefined,
        };
        const result = await (0, terminalCmdK_1.requestTerminalCommand)(req, buildNativeChatSessionFactory(context, chatOutput), chatOutput);
        // D5/E9: empty / gateway-error / unparseable ⇒ undefined (no fabricated command).
        return result.ok ? result.command : undefined;
    }));
    // FIRST-PARTY WEBVIEW GESTURE GATE (sweep-20 High #3 — rework of sweep-19).
    //
    // ALL THREE trusted-run paths (governed / bridge / live) are PRODUCT-TRUSTED:
    // they prepare the verifier private key or accept the supervisor's
    // trust:'trusted'. Commands carry NO caller attribution, so a third-party
    // extension's executeCommand must NOT be able to start any of them. We register a
    // LAUNCHER per kind on the gate; a launcher receives a gesture token and forwards
    // it to the trusted-run creator, which consumes it and REFUSES without a valid
    // CURRENT first-party gesture. The ONLY thing that mints a gesture and invokes a
    // launcher is gate.launchFromWebview — called from the Trust Panel's webview
    // message handler when the operator clicks an in-panel "Start run" button. A
    // third-party extension cannot post into our webview, so it can never reach a
    // launcher; the worst a global command can do is OPEN the panel and surface the
    // first-party button (no trusted run until the operator clicks it in OUR webview).
    gate.registerLauncher('governed', (gestureToken) => createTrustedGovernedRun(context, supervisorOutput, gate.gestures, gestureToken));
    gate.registerLauncher('bridge', (gestureToken) => bridgeCreateRun(context, supervisorOutput, gate.gestures, gestureToken));
    gate.registerLauncher('live', (gestureToken) => startLiveRun(context, supervisorOutput, gate.gestures, gestureToken));
    // The VISIBLE commands do NOT start a trusted run. They reveal the Trust Panel and
    // ask the webview to surface the first-party "Start run" affordance; the operator
    // clicking it posts `startTrustedRun` back, which is the ONLY path that mints a
    // gesture and runs a launcher. A third-party executeCommand of any of these can,
    // at most, open the panel — it cannot forge the in-webview click.
    const offerTrustedRun = (kind) => {
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
        panel.offerTrustedRun(kind);
    };
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.runGovernedTask', () => {
        offerTrustedRun('governed');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.bridgeSupervisedRun', () => {
        offerTrustedRun('bridge');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.startLiveRun', () => {
        offerTrustedRun('live');
    }));
    // INDEX WORKSPACE (the no-CLI "Index Workspace" experience). A command + status-bar
    // item that build/rebuild the workspace's LOCAL, on-device code index ON DEMAND, with
    // visible progress, so the index that powers repo-aware chat + completion is warm before
    // the first chat message (cold builds are slow). The build runs over the SAME bridge
    // session-bound index the chat retrieval + repo-aware FIM use (never a parallel index);
    // `glyphcode.index.persist` carries the encrypted-persist opt-in to the bridge. Honest,
    // best-effort, never throws.
    setupIndexWorkspace(context, supervisorOutput);
    // TAB COMPLETION (UNGOVERNED, on-device LOCAL assist — OPT-IN).
    // A VS Code InlineCompletionItemProvider that fills code at the cursor using the
    // user's OWN local Ollama daemon's fill-in-the-middle endpoint (inlineCompletion.ts
    // / ollamaFimClient.ts). LOCAL-only: loopback, NO egress, NO credential, works
    // OFFLINE / air-gapped. Best-effort — a down daemon returns undefined and never
    // breaks typing. HONESTY: this is a STOCK-SURFACE local assist that sits OUTSIDE the
    // governed envelope — it calls Ollama DIRECTLY and is NOT routed through the GlyphCode
    // Model broker, so it does NOT appear in the governed Model-Calls trace (broker routing
    // is intentionally PARKED until completion goes remote). So nothing default-on implies
    // governance, it is OFF by default: gated on glyphcode.inlineCompletion.enabled
    // (default FALSE — opt in); model from glyphcode.inlineCompletion.model. Registered for
    // all documents (pattern '**'). When the setting is false we register NO provider, so
    // the feature fully no-ops. Guarded so a minimal host / test stub without the
    // inline-completion API degrades gracefully (it simply registers no provider).
    if (typeof vscode.languages?.registerInlineCompletionItemProvider === 'function' &&
        vscode.workspace
            .getConfiguration('glyphcode')
            .get('inlineCompletion.enabled', false) &&
        // Respect workspace trust: don't run the local assist in an untrusted workspace.
        // Guarded so a stub host without the trust API still works (treats it as trusted).
        (typeof vscode.workspace.isTrusted !== 'boolean' || vscode.workspace.isTrusted)) {
        const inlineOutput = vscode.window.createOutputChannel('GlyphCode Tab Completion');
        context.subscriptions.push(inlineOutput);
        inlineOutput.appendLine('[inlineCompletion] UNGOVERNED local assist enabled — loopback Ollama FIM model, ' +
            'on-device (no egress); NOT routed through the GlyphCode Model broker and NOT in ' +
            'the governed Model-Calls trace.');
        // REPO-AWARE (index-aware FIM) — PROTOTYPE, default-OFF. When
        // glyphcode.inlineCompletion.repoAware is ON we build a long-lived per-workspace
        // COMPLETION bridge session (openChatSession → index/retrieve, the SAME warm
        // session-bound index the chat surface uses) and inject the top-k repo chunks into
        // the FIM prompt under a HARD timeout — falling back to plain FIM on cold/timeout/
        // error. The retriever is constructed only when a workspace folder is open; with no
        // folder there is no index to bind and the provider stays plain-FIM. Best-effort: a
        // failed session yields a not-warm retriever that always falls back.
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const repoRetriever = workspaceRoot
            ? buildCompletionRepoRetriever(context, inlineOutput, workspaceRoot)
            : undefined;
        // COMPILE-CHECK GATE INDICATOR. A spinning status-bar item shown ONLY while the gate is
        // searching for a compiling completion (the primary failed the structural gate and the
        // provider is regenerating). Created guarded so a minimal host without the status-bar API
        // degrades to no indicator. The provider's onGateSearch(active) hook toggles it; the
        // show/hide is balanced in the provider's finally so it never sticks.
        const onGateSearch = buildGateSearchIndicator(context);
        // "GENERATING CODE" CURSOR INDICATOR. A faded, animated braille spinner shown AT THE
        // CURSOR while the provider is generating (especially during multi-chunk auto-chunk), and
        // hidden the instant the suggestion is ready / the loop ends / it's cancelled. Distinct
        // surface from the gate's STATUS-BAR "finding a compiling completion…" spinner above (this
        // is the everyday "the model is thinking" signal at the cursor; the gate's is the rarer
        // "first draft didn't compile, regenerating" signal). The provider toggles it via the bound
        // onGenerating(active) hook; the show/hide is balanced in the provider's finally so it never
        // sticks. Gated on glyphcode.inlineCompletion.generatingIndicator (default true) — when off
        // we pass no hook so the provider never toggles it. Disposed on deactivate (clears any timer
        // + decoration). Guarded so a minimal host without the decoration API degrades to no-op.
        const generatingIndicatorOn = vscode.workspace
            .getConfiguration('glyphcode')
            .get('inlineCompletion.generatingIndicator', true);
        let onGenerating;
        if (generatingIndicatorOn) {
            const decorationManager = new inlineCompletion_1.DecorationManager();
            context.subscriptions.push({ dispose: () => decorationManager.dispose() });
            onGenerating = decorationManager.onGenerating;
        }
        const inlineProvider = new inlineCompletion_1.GlyphCodeInlineCompletionProvider(() => vscode.workspace
            .getConfiguration('glyphcode')
            .get('inlineCompletion.model', 'qwen2.5-coder:3b-base'), inlineOutput, undefined, 
        // ONE-TIME HONEST NOTICE: the FIRST time the (opted-in) local assist actually
        // activates on this machine, show a single non-blocking info message stating its
        // ungoverned-local posture. shouldAnnounceUngovernedCompletion gates it to once per
        // machine via globalState and is best-effort/non-fatal, so a state failure (or a
        // host without showInformationMessage) never breaks typing.
        () => {
            try {
                if ((0, inlineCompletion_1.shouldAnnounceUngovernedCompletion)(context.globalState)) {
                    void vscode.window.showInformationMessage(inlineCompletion_1.UNGOVERNED_COMPLETION_NOTICE);
                }
            }
            catch {
                /* best-effort: the honest notice must never break the local assist */
            }
        }, 
        // Live repo-aware config (read fresh per request). Default OFF.
        () => readRepoAwareConfig(), repoRetriever, 
        // LSP-DIRECTED query strategy seam: a thin guarded wrapper over
        // vscode.executeDefinitionProvider. Used by the 'lsp'/'auto' strategies to inject the
        // cursor symbol's cross-file DEFINITION index-free. Resolve-never-reject.
        buildCompletionDefinitionProvider(), 
        // LEVER 1 (keep the model hot): live reader of keep_alive (default '30m'), passed to
        // every FIM call so Ollama keeps the model resident across keystrokes.
        () => vscode.workspace
            .getConfiguration('glyphcode')
            .get('inlineCompletion.keepAlive', '30m'), 
        // AUTO-IMPORT ON ACCEPT — live toggle reader (glyphcode.inlineCompletion.autoImport,
        // default true). When ON we hand the provider the command id to attach to each item's
        // on-accept command; when OFF we return undefined so NO command is attached and the
        // completion behaves exactly as before. Read live so the toggle takes effect without a
        // reload. The handler (registered below) reads the toggle again before doing any work,
        // so even a stale-attached command no-ops when the toggle is flipped off mid-session.
        () => vscode.workspace
            .getConfiguration('glyphcode')
            .get('inlineCompletion.autoImport', true)
            ? inlineCompletion_1.AUTO_IMPORT_AFTER_ACCEPT_COMMAND
            : undefined, 
        // TWO-TIER COMPLETIONS — live reader of the cyclable-alternates knobs
        // (glyphcode.inlineCompletion.alternatives / alternativesCount / alternativesTemperature).
        // Read fresh per request so every lever is independently toggleable without a reload.
        // When enabled with a positive count, the provider ADDITIONALLY generates that many
        // moderate-temperature alternates in the BACKGROUND and returns [primary, ...alternates]
        // so the native inline-suggest controls (Alt+] / Alt+[) cycle "1/N".
        () => readAlternativesConfig(), 
        // LATENCY LEVER — live reader of the PRIMARY sampling temperature
        // (glyphcode.inlineCompletion.temperature, default 0.1 = today's confident guess). A
        // VARIETY dial, not a quality dial; >0.7 degrades code.
        () => vscode.workspace
            .getConfiguration('glyphcode')
            .get('inlineCompletion.temperature', 0.1), 
        // INLINE-SUGGEST REFRESH — after background alternates land, ask VS Code to re-trigger
        // inline suggestions so the provider is re-invoked and now returns the full cyclable list.
        // GUARDED so it NEVER disrupts active typing: we only fire when the editor's active
        // document + cursor are UNCHANGED since the request. Best-effort; a missing command API
        // or a moved cursor just defers the alternates to the next natural provide.
        (document, position) => {
            try {
                const active = vscode.window.activeTextEditor;
                if (!active)
                    return;
                if (active.document.uri.toString() !== document.uri.toString())
                    return;
                const sel = active.selection?.active;
                if (!sel ||
                    sel.line !== position.line ||
                    sel.character !== position.character) {
                    return;
                }
                void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
            }
            catch {
                /* best-effort: a failing refresh just defers alternates to the next provide */
            }
        }, 
        // COMPILE-CHECK GATE — live reader of the gate knobs
        // (glyphcode.inlineCompletion.compileGate / compileGateMaxAttempts, default ON / 3). When
        // ON and the primary completion is NOT structurally valid when inserted, the provider
        // searches (regenerates at a raised temperature) for one that is; when OFF the provider is
        // byte-for-byte the pre-gate behavior. Read fresh per request so the gate is toggleable
        // without a reload.
        () => readCompileGateConfig(), 
        // COMPILE-CHECK GATE — the status-bar "searching" indicator hook.
        onGateSearch, 
        // AUTO-CHUNK — live reader of the auto-chunk knobs
        // (glyphcode.inlineCompletion.autoChunk / autoChunkMaxChunks, default ON / 5). When ON the
        // primary is built as a sequence of small, self-grounding chunks (generate → re-read what
        // it wrote → continue), gated + de-duplicated each step, until the block is complete; when
        // OFF the primary is a single one-shot completion (byte-for-byte today's behavior). Read
        // fresh per request so it's toggleable without a reload.
        () => readAutoChunkConfig(), 
        // "GENERATING CODE" CURSOR INDICATOR — the faded, animated spinner-at-cursor hook (or
        // undefined when the indicator setting is off, so the provider never toggles it).
        onGenerating, 
        // SINGLE-SHOT TOKEN BUDGET — live reader of the single-shot generation budget
        // (glyphcode.inlineCompletion.maxTokens, default 256). num_predict is a CEILING: short/line
        // completions still stop early and are unaffected; the extra room lets a typical function
        // body finish in ONE single-shot Tab (so the background auto-chunk loop only runs for the
        // long tail). The loop's OWN per-chunk budget stays at the smaller client default (128).
        () => vscode.workspace
            .getConfiguration('glyphcode')
            .get('inlineCompletion.maxTokens', 256));
        context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider));
        // AUTO-IMPORT-AFTER-ACCEPT COMMAND. VS Code runs an InlineCompletionItem.command after the
        // item is accepted; this handler adds any workspace import the accepted snippet references
        // but the file does not yet import, via the language server's OWN add-import code action
        // (autoImport.ts). It reads the toggle LIVE (so it no-ops if flipped off after an item was
        // offered), computes the inserted range, and is best-effort — it never throws.
        registerAutoImportAfterAcceptCommand(context, inlineOutput);
        registerAddMissingImportsCommand(context, inlineOutput);
    }
}
/**
 * Register the {@link AUTO_IMPORT_AFTER_ACCEPT_COMMAND} handler. It reads the live toggle
 * (glyphcode.inlineCompletion.autoImport, default true), resolves the accepting document,
 * computes the inserted range from the accepted text + insertion position, and delegates to
 * {@link applyAutoImports}. Best-effort: an invalid arg / missing document / disabled toggle is
 * a no-op, and the handler never throws (applyAutoImports itself never throws either).
 */
function registerAutoImportAfterAcceptCommand(context, output) {
    context.subscriptions.push(vscode.commands.registerCommand(inlineCompletion_1.AUTO_IMPORT_AFTER_ACCEPT_COMMAND, async (rawArgs) => {
        try {
            // LIVE toggle re-read: even if an item was offered while ON, honor a flip to OFF.
            const enabled = vscode.workspace
                .getConfiguration('glyphcode')
                .get('inlineCompletion.autoImport', true);
            if (!enabled)
                return;
            const args = rawArgs;
            if (!args ||
                typeof args.uri !== 'string' ||
                typeof args.insertedText !== 'string' ||
                typeof args.line !== 'number' ||
                typeof args.character !== 'number' ||
                args.insertedText.length === 0) {
                return;
            }
            // Resolve the document the completion was inserted into. Prefer the active editor's
            // document when its URI matches (it is the live, post-insert buffer); else open it.
            const targetUri = vscode.Uri.parse(args.uri);
            const active = vscode.window.activeTextEditor?.document;
            const document = active && active.uri.toString() === targetUri.toString()
                ? active
                : await vscode.workspace.openTextDocument(targetUri);
            // The inserted range: from the insertion position to that position advanced by the
            // accepted text. Computed via offsetAt/positionAt so multi-line inserts are exact.
            const startPos = new vscode.Position(args.line, args.character);
            const startOffset = document.offsetAt(startPos);
            const endPos = document.positionAt(startOffset + args.insertedText.length);
            const insertedRange = new vscode.Range(startPos, endPos);
            await (0, autoImport_1.applyAutoImports)(document, insertedRange, {
                enabled: true,
                insertedText: args.insertedText,
                output,
            });
        }
        catch {
            // Best-effort: an accepted completion must never surface an error to the user.
        }
    }));
}
/**
 * Register `glyphcode.inlineCompletion.addMissingImports` — the USER-INVOKED add-import pass
 * over the active editor's EXISTING code (the on-accept hook only covers symbols a completion
 * just inserted; this covers code already on the page — typed, pasted, or chunk-written). It
 * reuses the same conservative on-device logic and reports how many imports it added.
 */
function registerAddMissingImportsCommand(context, output) {
    context.subscriptions.push(vscode.commands.registerCommand('glyphcode.inlineCompletion.addMissingImports', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showInformationMessage('Add Missing Imports: no active editor.');
            return;
        }
        const applied = await (0, autoImport_1.addMissingImportsForDocument)(editor.document, { output });
        if (applied > 0) {
            void vscode.window.setStatusBarMessage(`$(check) Added ${applied} missing import${applied === 1 ? '' : 's'}.`, 4000);
        }
        else {
            void vscode.window.setStatusBarMessage('$(info) No unambiguous missing imports to add — try Quick Fix (⌘.) for ambiguous ones.', 4000);
        }
    }));
}
/** The no-CLI "Index Workspace" command id (registered in package.json#commands). */
const INDEX_WORKSPACE_COMMAND = 'glyphcode.indexWorkspace';
/**
 * Set up the no-CLI "Index Workspace" experience: the {@link INDEX_WORKSPACE_COMMAND}
 * command, a status-bar item reflecting the index state (idle / `$(sync~spin) Indexing…`
 * / `$(database) Indexed N files` / `$(warning) Index error`), and the optional
 * auto-index-on-open. The build runs through a LONG-LIVED per-workspace bridge session
 * (the SAME openChatSession the repo-aware FIM uses, so they SHARE the one session-bound
 * server-side index), inside a Notification progress, and ends with an info toast.
 *
 * No workspace folder open → no index to build: the command surfaces an honest message
 * and no status-bar item is shown. Honest + best-effort: every failure is caught and
 * rendered (toast + status-bar error state); the command never throws.
 */
/**
 * Resolve the `glyphcode.index.vectorStore` setting to a valid {@link VectorStoreKind},
 * falling back to the default ('flat' — the exact, fast store) for any unrecognized
 * value. Returned undefined is never produced; the supervisor also defaults defensively.
 */
function resolveVectorStoreSetting() {
    const raw = vscode.workspace
        .getConfiguration('glyphcode')
        .get('index.vectorStore', 'flat');
    return raw === 'brute' || raw === 'flat' || raw === 'ann' ? raw : 'flat';
}
function setupIndexWorkspace(context, output) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // The status-bar item (when the host supports it). Created left of center so it sits
    // with the other GlyphCode surface affordances; clicking it runs the command (reindex).
    let statusItem;
    if (typeof vscode.window.createStatusBarItem === 'function') {
        const align = vscode.StatusBarAlignment?.Left ?? 1;
        statusItem = vscode.window.createStatusBarItem(align, 40);
        statusItem.command = INDEX_WORKSPACE_COMMAND;
        context.subscriptions.push(statusItem);
    }
    const setStatus = (state) => {
        if (!statusItem)
            return;
        const p = (0, indexStatusBar_1.indexStatusPresentation)(state);
        statusItem.text = p.text;
        statusItem.tooltip = p.tooltip;
        statusItem.show();
    };
    // Show the idle state up front (only when there is a workspace to index).
    if (workspaceRoot)
        setStatus({ kind: 'idle' });
    // A LONG-LIVED completion-style bridge session, opened lazily on the first build and
    // reused for every reindex. Disposed on deactivate via context.subscriptions.
    let sessionPromise;
    let disposed = false;
    const openSession = () => {
        if (!workspaceRoot)
            return Promise.resolve(undefined);
        if (!sessionPromise) {
            sessionPromise = (0, supervisorBridgeRunner_1.openChatSession)({
                bridgeServerPath: resolveBundledBridgeServerPath(context),
                extensionVersion: resolveExtensionVersion(context),
                runsBase: resolveRunsBase(),
                workspaceRoot,
                output,
            })
                .then((res) => (res.connected ? res.session : undefined))
                .catch(() => undefined);
        }
        return sessionPromise;
    };
    context.subscriptions.push({
        dispose: () => {
            disposed = true;
            void sessionPromise?.then((s) => {
                try {
                    s?.dispose();
                }
                catch {
                    /* best-effort teardown */
                }
            });
        },
    });
    // Serialize builds: a click while a build runs should not start a second concurrent one.
    let building = false;
    const runIndexWorkspace = async () => {
        if (disposed)
            return;
        if (!workspaceRoot) {
            void vscode.window.showInformationMessage('GlyphCode: open a folder to index its workspace.');
            return;
        }
        if (building) {
            void vscode.window.showInformationMessage('GlyphCode: indexing is already in progress…');
            return;
        }
        building = true;
        setStatus({ kind: 'indexing' });
        // The encrypted-persist opt-in (default OFF) flows to the bridge in the build params.
        const persist = vscode.workspace
            .getConfiguration('glyphcode')
            .get('index.persist', false);
        // Which LOCAL vector store backs the index ('flat' exact default | 'brute' fallback |
        // 'ann' approximate). Flows to the bridge so the build picks the store; default-safe.
        const vectorStore = resolveVectorStoreSetting();
        // The inactivity BACKSTOP for the streaming index/build request. The reset-on-
        // progress (each index/progress event re-arms the timer) is the real mechanism;
        // this cap only fires if the build STALLS with no progress for the whole window.
        // Default 30 min — a cold build of a real repo is tens of seconds to minutes.
        const buildTimeoutMs = vscode.workspace
            .getConfiguration('glyphcode')
            .get('index.buildTimeoutMs', 1_800_000);
        const withProgress = typeof vscode.window.withProgress === 'function'
            ? vscode.window.withProgress.bind(vscode.window)
            : // Minimal-host fallback: just run the task with no progress UI. A no-op
                // progress reporter is passed so the task's progress.report calls are safe.
                ((_o, task) => task({ report: () => undefined }));
        try {
            await withProgress({
                location: vscode.ProgressLocation?.Notification ?? 15,
                title: 'GlyphCode: indexing workspace…',
                cancellable: false,
            }, async (progress) => {
                const session = await openSession();
                if (!session) {
                    setStatus({ kind: 'error', reason: 'bridge unavailable' });
                    void vscode.window.showWarningMessage('GlyphCode: could not start the indexer (bridge unavailable).');
                    return;
                }
                // PERCENT IN THE NOTIFICATION (the fix). vscode increments are CUMULATIVE
                // to 100, so each report carries the DELTA percent since the last (computed
                // by indexProgressIncrement). The embed phase drives the bar; discover/chunk
                // just update the message. Best-effort: a throwing report never fails the build.
                let lastPercent = 0;
                const onProgress = (event) => {
                    try {
                        const { increment, percent } = (0, indexProgress_1.indexProgressIncrement)(event, lastPercent);
                        lastPercent = percent;
                        progress.report({ increment, message: (0, indexProgress_1.indexProgressMessage)(event) });
                    }
                    catch {
                        /* progress is best-effort: never let a report break the build */
                    }
                };
                const result = await session.indexBuild({ workspaceRoot, persist, vectorStore }, { timeoutMs: buildTimeoutMs, onProgress });
                if (!result.ok || !result.stats) {
                    setStatus({ kind: 'error', reason: result.error });
                    void vscode.window.showWarningMessage(`GlyphCode: indexing failed${result.error ? ` (${result.error})` : ''}.`);
                    return;
                }
                const { files, chunks, totalMs } = result.stats;
                setStatus({ kind: 'indexed', files, chunks });
                const secs = (totalMs / 1000).toFixed(1);
                void vscode.window.showInformationMessage(`Indexed ${files} ${files === 1 ? 'file' : 'files'} · ${chunks} chunks · ${secs}s`);
            });
        }
        catch (err) {
            // withProgress should not throw (the task catches), but be defensive: never let the
            // command reject. Render the error state honestly.
            const reason = String(err?.message ?? err);
            setStatus({ kind: 'error', reason });
            output.appendLine(`[indexWorkspace] unexpected error (non-fatal): ${reason}`);
        }
        finally {
            building = false;
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand(INDEX_WORKSPACE_COMMAND, () => {
        void runIndexWorkspace();
    }));
    // AUTO INDEX (glyphcode.index.autoIndex, default ON). When enabled, build the code index
    // in the BACKGROUND on activation — i.e. when a folder/workspace is opened — so repo-aware
    // chat and Tab are warm before first use. Non-blocking; reuses the exact command build path.
    // No workspace → no-op. Falls back to the legacy `index.autoIndexOnOpen` key for older configs.
    const indexCfg = vscode.workspace.getConfiguration('glyphcode');
    const autoIndex = indexCfg.get('index.autoIndex', indexCfg.get('index.autoIndexOnOpen', true));
    if (autoIndex && workspaceRoot) {
        output.appendLine('[indexWorkspace] Auto Index enabled — building the index in the background.');
        void runIndexWorkspace();
    }
}
/**
 * Read the live repo-aware inline-completion config from settings. Default OFF so the
 * shipped plain-FIM Tab is never affected unless the operator opts in.
 */
function readRepoAwareConfig() {
    const cfg = vscode.workspace.getConfiguration('glyphcode');
    return {
        enabled: cfg.get('inlineCompletion.repoAware', false),
        topK: cfg.get('inlineCompletion.repoAwareTopK', inlineCompletion_1.DEFAULT_REPO_AWARE_TOP_K),
        timeoutMs: cfg.get('inlineCompletion.repoAwareTimeoutMs', inlineCompletion_1.DEFAULT_REPO_AWARE_TIMEOUT_MS),
        maxContextChars: cfg.get('inlineCompletion.repoAwareMaxContextChars', inlineCompletion_1.DEFAULT_REPO_AWARE_MAX_CONTEXT_CHARS),
        // The query-tuning strategy (default 'auto': LSP → symbol → window → plain). Narrowed
        // through asQueryStrategy so a stray setting value degrades to 'auto', never throws.
        queryStrategy: (0, inlineCompletion_1.asQueryStrategy)(cfg.get('inlineCompletion.queryStrategy', 'auto')),
    };
}
/**
 * Read the live TWO-TIER (cyclable alternates) inline-completion config from settings.
 * Defaults: alternates ON, count 2, temperature 0.4 (moderate = varied but mostly-correct).
 * Each lever is read fresh per request so the user can toggle any of them off without a
 * reload. The provider only does background-alternate work when `enabled` AND `count > 0`.
 */
function readAlternativesConfig() {
    const cfg = vscode.workspace.getConfiguration('glyphcode');
    return {
        enabled: cfg.get('inlineCompletion.alternatives', true),
        count: cfg.get('inlineCompletion.alternativesCount', 2),
        temperature: cfg.get('inlineCompletion.alternativesTemperature', 0.4),
    };
}
/**
 * Read the live COMPILE-CHECK GATE config from settings. Defaults: gate ON, 3 max regenerate
 * attempts. Read fresh per request so the gate (and its retry budget) is toggleable without a
 * reload. When `enabled` is false the provider is byte-for-byte the pre-gate behavior.
 */
function readCompileGateConfig() {
    const cfg = vscode.workspace.getConfiguration('glyphcode');
    return {
        enabled: cfg.get('inlineCompletion.compileGate', true),
        maxAttempts: cfg.get('inlineCompletion.compileGateMaxAttempts', inlineCompletion_1.DEFAULT_COMPILE_GATE_MAX_ATTEMPTS),
    };
}
/**
 * Read the live AUTO-CHUNK config from settings. Defaults: auto-chunk ON, 5 max chunks. Read
 * fresh per request so it's toggleable without a reload. When `enabled` is false the provider
 * builds the primary as a SINGLE one-shot completion — byte-for-byte today's behavior.
 */
function readAutoChunkConfig() {
    const cfg = vscode.workspace.getConfiguration('glyphcode');
    return {
        enabled: cfg.get('inlineCompletion.autoChunk', true),
        maxChunks: cfg.get('inlineCompletion.autoChunkMaxChunks', inlineCompletion_1.DEFAULT_AUTO_CHUNK_MAX_CHUNKS),
    };
}
/**
 * Build the COMPILE-CHECK GATE "searching" indicator: a right-aligned, spinning status-bar item
 * shown ONLY while the provider is searching for a compiling completion (the primary failed the
 * structural gate and it is regenerating). Returns the `onGateSearch(active)` toggle wired into
 * the inline-completion provider — `true` shows it, `false` hides it. Pushed to
 * context.subscriptions so it is disposed with the extension. Guarded: a minimal host without
 * the status-bar API yields a no-op toggle (no indicator, no crash). A small min-visible window
 * avoids a flicker when a search resolves almost instantly.
 */
function buildGateSearchIndicator(context) {
    if (typeof vscode.window.createStatusBarItem !== 'function') {
        // No status-bar API (minimal host) → a no-op toggle; the gate still works, just silently.
        return () => undefined;
    }
    const align = vscode.StatusBarAlignment?.Right ?? 2;
    const gateStatus = vscode.window.createStatusBarItem(align, 40);
    gateStatus.text = '$(sync~spin) GlyphCode: finding a compiling completion…';
    gateStatus.tooltip =
        'GlyphCode is regenerating: the first Tab draft was not structurally valid when inserted ' +
            '(unbalanced delimiters/quotes, truncation, or garbage). Searching for one that compiles.';
    context.subscriptions.push(gateStatus);
    // A small min-visible window so a sub-flicker search doesn't strobe the status bar.
    const MIN_VISIBLE_MS = 250;
    let shownAt = 0;
    let hideTimer;
    return (active) => {
        try {
            if (active) {
                if (hideTimer) {
                    clearTimeout(hideTimer);
                    hideTimer = undefined;
                }
                shownAt = Date.now();
                gateStatus.show();
            }
            else {
                const elapsed = Date.now() - shownAt;
                if (elapsed >= MIN_VISIBLE_MS) {
                    gateStatus.hide();
                }
                else if (!hideTimer) {
                    // Keep it visible for the remainder of the min window, then hide.
                    hideTimer = setTimeout(() => {
                        hideTimer = undefined;
                        try {
                            gateStatus.hide();
                        }
                        catch {
                            /* best-effort */
                        }
                    }, MIN_VISIBLE_MS - elapsed);
                }
            }
        }
        catch {
            /* best-effort: a failing indicator toggle must never break inline completion */
        }
    };
}
/**
 * Build the production {@link DefinitionProvider} for the LSP-directed query strategy: a
 * thin, GUARDED wrapper over `vscode.executeDefinitionProvider` (+ a hover fallback for the
 * signature). It identifies the cursor symbol via {@link extractCursorSymbol}, asks the
 * editor's language server for the symbol's DEFINITION location, reads the defining
 * line(s) from that document (capped to `maxChars`), and returns the text + the symbol +
 * the definition's workspace-relative path. This is the ONE place the live-editor LSP call
 * lives — the strategy ladder around it is unit-tested with a fake. Resolve-never-reject:
 * every failure (no symbol, no definition, an unavailable language server, a read error)
 * resolves to `undefined` so the provider falls back to the next strategy.
 */
function buildCompletionDefinitionProvider() {
    return {
        async resolveDefinition(document, offset, maxChars) {
            try {
                // The cursor symbol (the identifier being referenced/completed). No symbol → the
                // LSP strategy has nothing to look up; fall back to the index strategies.
                const symbol = (0, inlineCompletion_1.extractCursorSymbol)(document.getText(), offset);
                if (!symbol)
                    return undefined;
                if (typeof vscode.commands?.executeCommand !== 'function')
                    return undefined;
                const position = document.positionAt(offset);
                // Ask the language server for the definition LOCATION(s). The result shape varies
                // (Location | Location[] | LocationLink[]); normalize to {uri, range}.
                const raw = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, position);
                const target = firstDefinitionTarget(raw);
                if (!target)
                    return undefined;
                // SESSION-ROOT SCOPING (security): `executeDefinitionProvider` can resolve a symbol
                // to a file ANYWHERE — a package/SDK cache, node_modules, or another open folder —
                // so reading + injecting that definition would pull source from OUTSIDE the
                // first-party session workspace into the FIM prompt (same class as index/retrieve).
                // Drop any target NOT inside a workspace folder: belt (the live
                // getWorkspaceFolder(uri) must resolve) AND suspenders (the canonical fsPath must
                // sit UNDER a workspace-folder root, collapsing `..`). Either failing → no
                // definition (the strategy ladder falls back to symbol/window/plain).
                if (!definitionTargetInWorkspace(target.uri))
                    return undefined;
                // Read the defining text from the target document. Open it (cached by VS Code) and
                // slice from the definition line, capped to a handful of lines / maxChars so a huge
                // definition can't blow the budget.
                const defDoc = target.uri.toString() === document.uri.toString()
                    ? document
                    : await vscode.workspace.openTextDocument(target.uri);
                const definitionText = readDefinitionText(defDoc, target.startLine, maxChars);
                if (!definitionText)
                    return undefined;
                const defPath = workspaceRelativePosix(target.uri);
                return defPath
                    ? { symbol, defPath, definitionText }
                    : { symbol, definitionText };
            }
            catch {
                // Resolve-never-reject: any LSP/read failure → no definition (fall back).
                return undefined;
            }
        },
    };
}
/**
 * Normalize the polymorphic `executeDefinitionProvider` result to the FIRST target's
 * `{ uri, startLine }`. Handles a single Location, a Location[], and a LocationLink[]
 * (`targetUri`/`targetRange` or `targetSelectionRange`). Returns undefined for an empty /
 * unrecognized result.
 */
function firstDefinitionTarget(raw) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (!first || typeof first !== 'object')
        return undefined;
    const anyFirst = first;
    // LocationLink: { targetUri, targetRange|targetSelectionRange }.
    if (anyFirst.targetUri) {
        const uri = anyFirst.targetUri;
        const range = (anyFirst.targetSelectionRange ??
            anyFirst.targetRange);
        return uri && range ? { uri, startLine: range.start.line } : undefined;
    }
    // Location: { uri, range }.
    if (anyFirst.uri && anyFirst.range) {
        const uri = anyFirst.uri;
        const range = anyFirst.range;
        return { uri, startLine: range.start.line };
    }
    return undefined;
}
/**
 * Read up to a few lines of definition text starting at `startLine` from `doc`, capped to
 * `maxChars`. We take the definition line plus a small window (so a multi-line signature /
 * interface head is captured) and stop at the char cap. Returns '' when the line is out of
 * range. Best-effort; the caller treats '' as "no definition".
 */
function readDefinitionText(doc, startLine, maxChars) {
    try {
        const lineCount = doc.lineCount;
        if (startLine < 0 || startLine >= lineCount)
            return '';
        // A modest window — enough to capture a signature / small block without dragging in a
        // whole function body. The char cap is the real bound.
        const endLine = Math.min(lineCount - 1, startLine + 12);
        const lines = [];
        let used = 0;
        for (let i = startLine; i <= endLine; i++) {
            const text = doc.lineAt(i).text;
            if (used + text.length + 1 > maxChars && lines.length > 0)
                break;
            lines.push(text);
            used += text.length + 1;
        }
        return lines.join('\n').trim();
    }
    catch {
        return '';
    }
}
/**
 * Workspace-relative POSIX path of a definition target URI (for the preamble's `// path`
 * comment). Best-effort: undefined when there is no workspace / the API is unavailable.
 */
function workspaceRelativePosix(uri) {
    try {
        if (typeof vscode.workspace?.asRelativePath !== 'function')
            return undefined;
        const rel = vscode.workspace.asRelativePath(uri, false);
        if (typeof rel !== 'string' || rel.length === 0)
            return undefined;
        return rel.split('\\').join('/');
    }
    catch {
        return undefined;
    }
}
/**
 * SESSION-ROOT SCOPING for the LSP-directed completion strategy: is `targetUri` (a resolved
 * definition location) INSIDE the first-party session workspace? Only an in-workspace
 * definition may have its source read + injected into the FIM prompt. A target in a
 * package/SDK cache, node_modules, or another open-but-out-of-session root is REJECTED.
 *
 * Two complementary checks, both must hold (fail-closed — when in doubt, drop it):
 *   - BELT: `vscode.workspace.getWorkspaceFolder(uri)` must resolve to a folder (VS Code's
 *     own "which workspace folder owns this uri" — undefined for files outside every root,
 *     and it accounts for the live folder set).
 *   - SUSPENDERS: the pure {@link isUriInWorkspace} canonical-path check (collapses `..`,
 *     sibling-prefix safe) against the workspace-folder fsPaths — catches a path-escape /
 *     symlinked target that a name-only check might miss.
 *
 * Only file-scheme targets are eligible (an untitled/in-memory/remote-scheme target has no
 * meaningful on-disk root to scope). Best-effort and NEVER throws; any failure → false.
 */
function definitionTargetInWorkspace(targetUri) {
    try {
        // Only on-disk (file://) targets can be scoped to a workspace-folder root.
        if (targetUri.scheme !== 'file')
            return false;
        // BELT: VS Code's own owning-folder lookup must resolve (undefined → outside all roots).
        const owning = typeof vscode.workspace?.getWorkspaceFolder === 'function'
            ? vscode.workspace.getWorkspaceFolder(targetUri)
            : undefined;
        if (!owning)
            return false;
        // SUSPENDERS: canonical-path containment against the live workspace-folder roots.
        const roots = (vscode.workspace.workspaceFolders ?? [])
            .map((f) => f.uri.fsPath)
            .filter((p) => typeof p === 'string' && p.length > 0);
        return (0, inlineCompletion_1.isUriInWorkspace)(targetUri.fsPath, roots);
    }
    catch {
        return false;
    }
}
/**
 * Build the production {@link RepoContextRetriever} for repo-aware Tab completion: a
 * LONG-LIVED per-workspace COMPLETION bridge session (openChatSession), reused across
 * keystrokes. The session is opened LAZILY on the first retrieve (so an enabled-but-idle
 * editor pays nothing), bound to `workspaceRoot` via the handshake trusted channel, and
 * kept alive for the editor's lifetime (disposed on deactivate via context.subscriptions).
 *
 * WARMTH: `isWarm()` reports whether the FIRST retrieve has completed — i.e. the
 * supervisor's lazy per-workspace index build is done and subsequent retrieves are fast.
 * Until then the provider falls back to plain FIM; the provider's background warm-up
 * kick triggers that first (slow) build OFF the typing path.
 *
 * BEST-EFFORT: every failure (session open failed, retrieve rejected, bridge down)
 * resolves to `{ ok:false, hits:[] }` and leaves `isWarm()` false — the provider then
 * always falls back to plain FIM. Nothing here egresses code (the index is local).
 */
function buildCompletionRepoRetriever(context, output, workspaceRoot) {
    let sessionPromise;
    let warm = false;
    let disposed = false;
    const openSession = () => {
        if (!sessionPromise) {
            sessionPromise = (0, supervisorBridgeRunner_1.openChatSession)({
                bridgeServerPath: resolveBundledBridgeServerPath(context),
                extensionVersion: resolveExtensionVersion(context),
                runsBase: resolveRunsBase(),
                workspaceRoot,
                output,
            })
                .then((res) => (res.connected ? res.session : undefined))
                .catch(() => undefined);
        }
        return sessionPromise;
    };
    // Dispose the long-lived completion session when the extension deactivates.
    context.subscriptions.push({
        dispose: () => {
            disposed = true;
            void sessionPromise?.then((s) => {
                try {
                    s?.dispose();
                }
                catch {
                    /* best-effort teardown */
                }
            });
        },
    });
    return {
        isWarm: () => warm,
        async retrieve(query, k) {
            if (disposed)
                return { ok: false, hits: [] };
            try {
                const session = await openSession();
                if (!session)
                    return { ok: false, hits: [] };
                const result = await session.indexRetrieve({
                    workspaceRoot,
                    query,
                    k,
                    vectorStore: resolveVectorStoreSetting(),
                });
                // The first successful query means the index finished building → warm.
                if (result.ok)
                    warm = true;
                const hits = result.hits.map((h) => ({
                    path: h.path,
                    text: h.text,
                }));
                return { ok: result.ok, hits };
            }
            catch {
                return { ok: false, hits: [] };
            }
        },
    };
}
/**
 * Resolve the source-commit provenance anchor for a run request: the workspace's
 * git HEAD sha when it is a git checkout, else undefined. A non-git / detached
 * workspace supplies `worktreeBase` instead (see assembleRunRequest). Best-effort:
 * git missing or a non-repo returns undefined rather than throwing.
 */
function resolveSourceCommit(repoRoot) {
    try {
        const res = (0, node_child_process_1.spawnSync)('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
        });
        if (res && res.status === 0 && typeof res.stdout === 'string') {
            const sha = res.stdout.trim();
            if (sha.length > 0)
                return sha;
        }
    }
    catch {
        /* git missing / not a repo — fall back to a worktree base anchor */
    }
    return undefined;
}
/**
 * Spawn the PACKAGED bridge-server and create a REAL run via the actual spawned
 * supervisor, returning the supervisor-minted {runId, trust}. This is the M2
 * end-to-end path: hash-pin → handshake → run/create against the spawned
 * supervisor (not a mock/stub). It reveals the Trust Panel and surfaces the run's
 * trust posture. Streaming live run/event from this created run into the panel is
 * the documented follow-up; for now the panel keeps its embedded sample feed.
 */
/**
 * Resolve the repo + policy and assemble the full §10.3 run request shared by the
 * bridge create-run and live-run command paths. Returns undefined (after surfacing
 * the reason) when the operator cancelled or the policy could not be fingerprinted.
 */
async function assembleBridgeRunRequest(output) {
    // Resolve the repo to govern (single folder, else a picker).
    const repo = await resolveTargetRepo();
    if (!repo) {
        output.appendLine('[host] bridge run aborted: no target repo selected.');
        return undefined;
    }
    // Resolve the policy (operator-pinned / repo-provided / picker) and fingerprint
    // its bytes for the §10.3 policyHash provenance pin.
    const resolvedPolicy = await resolvePolicyPath(resolveSupervisorPath().path);
    if (!resolvedPolicy) {
        output.appendLine('[host] bridge run aborted: no policy selected.');
        return undefined;
    }
    const policyFp = (0, policyHash_1.policyFileSha256)(resolvedPolicy.path);
    if (!policyFp.sha256) {
        void vscode.window.showErrorMessage(`GlyphCode: could not fingerprint the policy file (${policyFp.note}); cannot create a run.`);
        return undefined;
    }
    // Assemble the full §10.3 run request. Exactly one provenance anchor:
    // sourceCommit (git HEAD) when available, else worktreeBase (the repo root).
    const sourceCommit = resolveSourceCommit(repo);
    const runtimeProfile = vscode.workspace
        .getConfiguration('glyphcode')
        .get('runtime', 'docker');
    return {
        actorType: 'native',
        autonomyTier: 'allowlist',
        policyPath: resolvedPolicy.path,
        policyHash: policyFp.sha256,
        workspaceRoot: repo,
        runtimeProfile,
        extensionPosture: 'sovereign',
        ...(sourceCommit ? { sourceCommit } : { worktreeBase: repo }),
    };
}
/** The first-party extension's product version, reported in the handshake. */
function resolveExtensionVersion(context) {
    return (context.extension?.packageJSON?.version ?? '0.0.1');
}
/**
 * THE CHAT→ACTOR PROMOTION (Phase C-UI capstone). Promote a task into a GOVERNED AGENTIC
 * BUILD: codex edits files + runs commands in the workspace folder, GOVERNED (metadata
 * egress proxy + signed trace) but UNSANDBOXED — the git diff is the safety net. This is
 * the explicit authority boundary (docs/developer-trust-model.md): chat stays Ask; only
 * an EXPLICIT up-front approval here grants the authority to edit/run.
 *
 * Flow:
 *   1. Resolve cwd = the open workspace folder (HONEST error if none).
 *   2. Resolve the intent (the chat prompt passed as the command arg, else a quick-input).
 *   3. UP-FRONT AUTHORITY MODAL naming the boundary honestly. Decline → do NOTHING.
 *   4. On confirm ONLY → start the build with approved:true; stream build/event progress
 *      into the output channel + a status notification; on the terminal result, post the
 *      AgenticBuildReview into the Trust Panel for the second gate (Accept/Reject); on
 *      error, surface the honest message.
 *
 * `intentArg` is the optional chat-surfaced prompt (a follow-up "Build This" after a chat
 * turn); when absent the command is standalone and quick-inputs the intent.
 */
async function promoteChatToBuild(context, gate, output, intentArg) {
    // (1) cwd = the open workspace folder. No folder → honest error, do nothing.
    const folder = vscode.workspace.workspaceFolders?.[0];
    const candidateCwd = folder?.uri.fsPath;
    // (2) Intent: the chat prompt arg, else a quick-input. A blank intent aborts.
    let intent = typeof intentArg === 'string' && intentArg.trim().length > 0 ? intentArg.trim() : undefined;
    if (!intent && candidateCwd) {
        // Only prompt for an intent when there IS a workspace folder — otherwise the
        // preflight below surfaces the no-folder error first (don't ask for a task we
        // can't run). validateInput REFUSES to submit a blank/whitespace-only task (it
        // shows an inline error and re-prompts in place) so an empty Enter can never reach
        // the preflight's "no build task given" path — only Escape (→ undefined) cancels.
        intent = await vscode.window.showInputBox({
            prompt: 'GlyphCode — what should the governed agent build? (it WILL edit files + run commands)',
            placeHolder: 'e.g. "add input validation to the signup form and a test for it"',
            ignoreFocusOut: true,
            validateInput: (v) => v.trim().length === 0
                ? 'Enter a task — what should the agent build? (it WILL edit files + run commands)'
                : undefined,
        });
        if (intent === undefined)
            return; // cancelled the quick-input (Escape)
    }
    const preflight = (0, agenticBuildPromotion_1.resolveBuildPreflight)(candidateCwd, intent);
    if (!preflight.ok) {
        void vscode.window.showWarningMessage(`GlyphCode: ${preflight.reason}`);
        return;
    }
    const { cwd, prompt } = preflight;
    // (3) UP-FRONT AUTHORITY APPROVAL. This is the operator gesture that grants the build
    // authority — minted via the SAME first-party operator-gesture registry that gates a
    // product-trusted run, so a third-party `executeCommand('glyphcode.promoteChatToBuild')`
    // cannot satisfy the MODAL and thus cannot start a build. The modal names the boundary
    // honestly (governed-unsandboxed). Decline → do NOTHING (no build/start; approved is
    // never sent as anything but true).
    //
    // FRICTION ONCE PER AUTHORITY BOUNDARY (not per build). The modal offers a second
    // button, "Always Allow in This Workspace": picking it persists the grant in
    // workspaceState so subsequent governed builds in this SAME workspace skip the modal
    // (the git diff + the downstream Reject-reverts gesture remain the safety net either
    // way). A persisted grant can be cleared via `glyphcode.revokeBuildAuthority`. If a
    // prior "Always Allow" grant exists, skip the modal and proceed directly with a brief,
    // NON-modal Output note. The one-time "Build…" button never persists.
    const alreadyGranted = context.workspaceState.get(BUILD_AUTHORITY_GRANTED_KEY) === true;
    if (!alreadyGranted) {
        const grant = await (0, agenticBuildPromotion_1.confirmBuildAuthorityWithGrant)(cwd, (message, proceedLabel, alwaysLabel) => Promise.resolve(vscode.window.showWarningMessage(message, { modal: true }, proceedLabel, alwaysLabel)));
        if (!grant.granted) {
            output.appendLine(`[host] governed build DECLINED at the authority gate for ${cwd} — nothing started.`);
            return;
        }
        if (grant.remember) {
            await context.workspaceState.update(BUILD_AUTHORITY_GRANTED_KEY, true);
            output.appendLine(`[host] governed-build authority GRANTED + remembered for this workspace (${cwd}). ` +
                'Subsequent builds skip the up-front modal; run "GlyphCode: Revoke Governed-Build ' +
                'Authorization (This Workspace)" to require it again. The diff + Reject-reverts stay the safety net.');
        }
    }
    else {
        // Prior "Always Allow" grant in this workspace — proceed WITHOUT the modal. A
        // non-modal Output line keeps the boundary visible without interrupting the operator.
        output.appendLine(`[host] governed-build authority previously remembered for this workspace (${cwd}) — ` +
            'proceeding without the up-front modal. The git diff + Reject-reverts remain the safety net; ' +
            'run "GlyphCode: Revoke Governed-Build Authorization (This Workspace)" to require the modal again.');
    }
    // Mint+consume a first-party operator gesture so the authority grant is attributable
    // (defense-in-depth: the modal already gates this command from a third party, and the
    // gesture records the deliberate operator act). A failure to mint never blocks the
    // build the operator just approved — the modal is the load-bearing gate.
    try {
        gate.gestures.consume(gate.gestures.mint());
    }
    catch {
        /* gesture bookkeeping is best-effort; the modal confirm is the authority gate */
    }
    output.show(true);
    output.appendLine('');
    output.appendLine(`[host] governed agentic build APPROVED for ${cwd}.`);
    output.appendLine(`[host] intent: ${prompt}`);
    // TRUSTED VERIFIER KEY (the chat→build "Verified:" trailer). Ensure the out-of-band
    // keystore and forward its STABLE PRIVATE-key PATH so the supervisor SIGNS this build's
    // verdict with the operator's trusted key (whose public half the panel already pins) —
    // the bridge mirror of the governed-run CLI's `--verifier-key`. BEST-EFFORT: a keystore
    // failure must NOT block the build the operator just approved — we log and fall back to
    // the per-run ephemeral key (the build still runs + reviews; only the IDE's "Verified:"
    // trailer is withheld, which is the correct fail-safe). The actor is firewalled from this
    // key regardless (cli-agent-launcher sanitizeBaseEnv strips GLYPHCODE_VERIFIER_KEY).
    let verifierKeyPath;
    try {
        verifierKeyPath = ensureVerifierKeystore().privateKeyPath;
    }
    catch (err) {
        output.appendLine(`[host] verifier keystore unavailable (${String(err?.message ?? err)}) — ` +
            'this build will sign with a per-run ephemeral key; the IDE will NOT emit a "Verified:" ' +
            'commit-message trailer (correct fail-safe).');
    }
    // Open + reveal the Trust Panel FIRST so it is ready to receive the review.
    const panel = TrustPanel.createOrShow(context.extensionUri, gate);
    panel.reveal();
    // (4) Start the build (approved:true) and stream progress honestly. Each state/command
    // becomes an output line + a brief status; the terminal result posts the review.
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: 'GlyphCode: governed agentic build…',
    }, (progress) => (0, supervisorBridgeRunner_1.runAgenticBuild)({
        bridgeServerPath: resolveBundledBridgeServerPath(context),
        extensionVersion: resolveExtensionVersion(context),
        runsBase: resolveRunsBase(),
        ...(verifierKeyPath ? { verifierKeyPath } : {}),
        prompt,
        cwd,
        approved: true,
        output,
        onBuildEvent: (event) => reportBuildProgress(event, output, progress),
    }));
    if (!result.started) {
        void vscode.window.showErrorMessage(`GlyphCode: governed build not started — ${result.message}`);
        return;
    }
    if (result.review) {
        // Render the diff + commands + verdict in the Trust Panel for the SECOND gate. Pass
        // the REAL cwd so a Reject scopes its revert to this repo + the review's changedFiles.
        panel.postAgenticBuildReview(result.review, false, cwd);
        void vscode.window.showInformationMessage(`GlyphCode: governed build ${result.runId ?? ''} complete — review the diff + verdict in the ` +
            'Trust Panel, then Accept or Reject.');
    }
    else {
        void vscode.window.showWarningMessage(`GlyphCode: governed build ${result.runId ?? ''} ended without a review — ${result.message || 'no result event'}.`);
    }
}
/**
 * Surface one streamed `build/event` honestly as operator-facing progress (an output line
 * per state/command/fileChange + a brief progress report). The terminal result/error are
 * handled by the caller; here we narrate the in-flight evidence (e.g. "running `npm test`…").
 */
function reportBuildProgress(event, output, progress) {
    switch (event.type) {
        case 'state':
            output.appendLine(`[build] state: ${event.state}`);
            progress.report({ message: event.state });
            break;
        case 'command':
            if (event.phase === 'start') {
                output.appendLine(`[build] running: ${event.cmd}`);
                progress.report({ message: `running ${event.cmd}…` });
            }
            else {
                output.appendLine(`[build] finished: ${event.cmd}${typeof event.exitCode === 'number' ? ` (exit ${event.exitCode})` : ''}`);
            }
            break;
        case 'fileChange':
            output.appendLine(`[build] ${event.status}: ${event.path}`);
            break;
        case 'summary':
            // Narration deltas — append without a newline-per-token spam; one line per chunk.
            if (event.textDelta.trim().length > 0)
                output.append(event.textDelta);
            break;
        case 'result':
            output.appendLine('');
            output.appendLine('[build] complete — review the diff + verdict in the Trust Panel.');
            break;
        case 'error':
            output.appendLine(`[build] error: ${event.message}`);
            break;
    }
}
/**
 * Consume the first-party operator gesture that gates a PRODUCT-TRUSTED run
 * (sweep-20 High #3). Returns true ONLY when `gestureToken` consumes as a CURRENT,
 * unspent first-party gesture from `gestures`. A request lacking one (e.g. a path
 * that did not originate from a Trust-Panel webview click) is REFUSED here — before
 * any trusted work (keystore / verifier key / run/create) — so it can never produce
 * a `trust:'trusted'` run. Surfaces an honest refusal to the operator + the log.
 */
function consumeTrustedRunGesture(gestures, gestureToken, output) {
    const gesture = gestures.consume(gestureToken);
    if (!gesture.ok) {
        output.appendLine(`[host] trusted run REFUSED: missing/invalid first-party operator gesture (${gesture.reason}). ` +
            'A trusted run can only be started by clicking a GlyphCode Trust Panel button (a first-party ' +
            'webview gesture a third-party extension cannot forge).');
        void vscode.window.showErrorMessage('GlyphCode: refused to start a trusted run — it must be initiated by clicking "Start run" ' +
            'inside the GlyphCode Trust Panel (a first-party operator gesture).');
        return false;
    }
    return true;
}
async function bridgeCreateRun(context, output, gestures, gestureToken) {
    output.show(true);
    // GATE: a product-trusted bridge run requires a CURRENT first-party webview
    // gesture. Without it, refuse before connecting to the supervisor — so an
    // ungated (e.g. third-party command) invocation can never create a trusted run.
    if (!consumeTrustedRunGesture(gestures, gestureToken, output))
        return;
    const request = await assembleBridgeRunRequest(output);
    if (!request)
        return;
    const extensionVersion = resolveExtensionVersion(context);
    const result = await (0, supervisorBridgeRunner_1.createRunViaBridge)({
        bridgeServerPath: resolveBundledBridgeServerPath(context),
        extensionVersion,
        runsBase: resolveRunsBase(),
        request,
        output,
    });
    if (!result.connected) {
        void vscode.window.showErrorMessage(`GlyphCode: bridge run not created — ${result.message}`);
        return;
    }
    // Reveal the Trust Panel for the (future) live feed and report the real run.
    const panel = TrustPanel.createOrShow(context.extensionUri, getWebviewGestureGate());
    panel.reveal();
    if (result.trust === 'trusted') {
        void vscode.window.showInformationMessage(`GlyphCode: created a TRUSTED run (${result.runId}) via the spawned supervisor` +
            (result.supervisorVersion ? ` ${result.supervisorVersion}` : '') + '.');
    }
    else {
        void vscode.window.showWarningMessage(`GlyphCode: created an ${result.trust.toUpperCase()} run (${result.runId ?? 'no id'}) — ${result.message}`);
    }
}
/**
 * M5 §14 — wrap a run-event sink so that, when the extension host is in the
 * trust-degrading AMBIENT posture (vscode.ExtensionMode.Development — ambient,
 * non-curated extensions enabled; governed surfaces outside a curated/sovereign set),
 * each REAL run that OPENS in this host ALSO gets a distinct `ambient_extensions_dev_mode`
 * §14 failure card. We anchor it to the supervisor-minted runId from the `run_opened`
 * envelope (so it attaches to the actual run, never a phantom), emit it ONCE per run
 * (after run_opened, before the rest of the stream is forwarded), and forward every
 * envelope onward unchanged. In Production / Test mode the predicate is false and the
 * wrapper is a transparent pass-through — a normal install never sees this card.
 *
 * Detection is delegated to the PURE, vscode-free predicate ambientExtensionsDevModeFailureEvent
 * (runEventProtocol.ts) so it is unit-testable headlessly; this wrapper only supplies
 * the numeric extension mode + the run identity.
 */
function withAmbientDevModePosture(context, onRunEvent) {
    const inputs = {
        extensionMode: context.extensionMode,
        // M5 §14 / H7 GUARD: a minimal host or a unit-test vscode stub may omit the
        // `ExtensionMode` enum entirely. Read `Development` defensively (`?.`) so the
        // posture wrapper degrades to a transparent pass-through (developmentMode
        // undefined ⇒ ambientExtensionsDevModeFailureEvent's predicate is false) instead
        // of throwing `Cannot read properties of undefined (reading 'Development')` during
        // a governed-terminal / chat / live-run command. Fixes the 5 pre-existing
        // openGovernedTerminalCommand stub failures.
        developmentMode: vscode.ExtensionMode?.Development,
    };
    // Emit the posture warning at most once per runId (de-dup is also enforced
    // webview-side by appendFailure, but emitting once keeps the stream clean).
    const flagged = new Set();
    return (raw) => {
        onRunEvent(raw);
        if (!raw || typeof raw !== 'object')
            return;
        const e = raw;
        if (e.kind !== runEventProtocol_1.RunEventKind.RunOpened)
            return;
        if (typeof e.runId !== 'string' || e.runId.length === 0)
            return;
        if (flagged.has(e.runId))
            return;
        flagged.add(e.runId);
        const ambient = (0, runEventProtocol_1.ambientExtensionsDevModeFailureEvent)(e.runId, inputs);
        if (ambient)
            onRunEvent(ambient);
    };
}
/**
 * Spawn the PACKAGED bridge-server, create a REAL run, KEEP THE CHILD ALIVE, and
 * DRIVE it so the supervisor streams the LIVE `run/event` sequence into the Trust
 * Panel — a real run streaming in, not the embedded sample. The panel's
 * postRunEvent runs validateRunEvent + the fail-closed schema gate on every
 * streamed envelope before rendering. The child disposes once the run closes.
 *
 * This is the M5 end-to-end live path. The events are REAL supervisor output
 * (real lifecycle FSM + real hash-chained trace + real policy decisions + a real
 * signed verdict); only the actor's tool steps are scripted server-side. A real
 * model-driven agent loop replaces the scripted actor (scripted-run-driver.ts's
 * REAL-MODEL PLUG-IN POINT) without changing this host path or the wire grammar.
 */
async function startLiveRun(context, output, gestures, gestureToken) {
    output.show(true);
    // GATE: a product-trusted LIVE run requires a CURRENT first-party webview gesture.
    // Refuse before connecting so an ungated invocation can never stream a trusted run.
    if (!consumeTrustedRunGesture(gestures, gestureToken, output))
        return;
    const request = await assembleBridgeRunRequest(output);
    if (!request)
        return;
    // Open + reveal the Trust Panel FIRST so it is ready to receive the live stream.
    // postRunEvent buffers any events that arrive before the webview signals ready,
    // so opening here loses nothing even if the first envelope races the webview.
    const panel = TrustPanel.createOrShow(context.extensionUri, getWebviewGestureGate());
    panel.reveal();
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: 'GlyphCode: live supervised run…',
    }, () => (0, supervisorBridgeRunner_1.startRunViaBridge)({
        bridgeServerPath: resolveBundledBridgeServerPath(context),
        extensionVersion: resolveExtensionVersion(context),
        runsBase: resolveRunsBase(),
        request,
        output,
        // The supervisor's streamed envelopes flow straight into the panel's
        // validated feed. postRunEvent fail-closes on a schema-version mismatch.
        // The §14 ambient-dev-mode wrapper additively flags the run's posture when
        // the host is in Development mode (transparent pass-through otherwise).
        onRunEvent: withAmbientDevModePosture(context, (raw) => panel.postRunEvent(raw)),
    }));
    if (!result.connected) {
        void vscode.window.showErrorMessage(`GlyphCode: live run not started — ${result.message}`);
        return;
    }
    if (!result.started) {
        void vscode.window.showWarningMessage(`GlyphCode: run ${result.runId ?? '(no id)'} was created but did not stream — ${result.message}`);
        return;
    }
    const trustLabel = result.trust.toUpperCase();
    const finalState = result.finalState ? ` (${result.finalState})` : '';
    if (result.trust === 'trusted') {
        void vscode.window.showInformationMessage(`GlyphCode: streamed a LIVE TRUSTED run (${result.runId})${finalState} into the Trust Panel` +
            (result.supervisorVersion ? ` — supervisor ${result.supervisorVersion}` : '') + '.');
    }
    else {
        void vscode.window.showWarningMessage(`GlyphCode: streamed a LIVE ${trustLabel} run (${result.runId})${finalState} into the Trust Panel — ${result.message}`);
    }
}
/**
 * GOVERNANCE-BOUNDARY LEGIBILITY (A1). The set of terminals GlyphCode ITSELF created
 * (the Governed Terminal / Chat surfaces). A just-opened terminal NOT in this set is a
 * stock/ungoverned shell (integrated terminal, task/debug shells — full host env,
 * untraced egress); the {@link activate} `onDidOpenTerminal` listener uses membership
 * here to decide whether to show the honest ungoverned-terminal notice. A WeakSet so a
 * closed terminal is garbage-collected without us tracking close events (no leak).
 */
const glyphSpekOwnedTerminals = new WeakSet();
/**
 * GOVERNED FLOATING TERMINAL (⌃⌘K, Option A) — the ext-host registry of LIVE governed
 * sessions opened for the FORK's cursor-anchored floating terminal, keyed by the
 * supervisor-minted runId.
 *
 * WHY A runId-KEYED MAP (AD1/AD8/A4a). The fork hosts the terminal in the renderer and
 * drives the session lifecycle over a COMMAND seam (`startSession` / `stopSession` /
 * `registerOwned`) — it never touches an ext-host object. So the session handle (whose
 * `stop()` finalizes the signed verdict + tears down the bridge child) is held HERE,
 * runId-scoped: `stopSession(runIdA)` can only finalize run A (window B can never
 * finalize window A's run). The entry is deleted on stop so a second stop is a clean
 * idempotent no-op.
 */
const governedFloatingSessions = new Map();
/**
 * GOVERNED FLOATING TERMINAL (⌃⌘K) — the governance-loss subscriptions, runId-keyed.
 *
 * G7/E18 — for each live floating session we subscribe to its {@link
 * GovernedTerminalSession.onGovernanceLoss} so that if the supervisor child/proxy dies
 * MID-SESSION (while the shell is still alive) the ext-host can tell the FORK to drop the
 * green badge + finalize. The detection signal is renderer-UNREACHABLE (the fork has no
 * handle to the bridge child), so this is the seam that closes the "lying-green" gap the
 * fork's `onExit`-only detection missed. We retain the subscription here so it is disposed
 * on stopSession (and never fires after the fork already tore the widget down).
 */
const governedFloatingLossSubs = new Map();
/**
 * GOVERNED FLOATING TERMINAL (⌃⌘K) — runIds the fork has registered as governed-OWNED
 * via `glyphcode.governedTerminal.registerOwned`. A secondary, run-scoped ownership
 * record (the A1 notice's PRIMARY suppression key is the terminal-name marker, since
 * `onDidOpenTerminal` hands a `Terminal`, not a runId). Kept so the seam is honest
 * about which runs it owns and so a future ext-side consumer can scope on it.
 */
const governedFloatingOwnedRunIds = new Set();
/**
 * GOVERNANCE-BOUNDARY LEGIBILITY (⌃⌘U). The set of terminals the user DELIBERATELY opened
 * as explicitly UNGOVERNED via `glyphcode.openUngovernedTerminal`. These are genuinely NOT
 * governed (they are NOT in {@link glyphSpekOwnedTerminals}) — but they were opened ON
 * PURPOSE, so the A1 `onDidOpenTerminal` listener (which exists to catch ACCIDENTAL stock
 * terminals) must SKIP them: the deliberate-open command already shows its own honest
 * one-time confirmation, so re-firing the "did you mean a governed terminal?" steer would
 * be a double-nag. One honest signal per terminal, not two. A WeakSet so a closed terminal
 * is garbage-collected without us tracking close events (no leak). NOTE: membership here
 * does NOT imply governance — it only records intentional ungoverned-ness.
 */
const deliberatelyUngovernedTerminals = new WeakSet();
/**
 * EXPLICITLY UNGOVERNED TERMINAL (⌃⌘U). Open a STOCK VS Code terminal — plain host env,
 * NO governance: NO supervisor proxy (no HTTPS_PROXY/HTTP_PROXY), NO env sanitization
 * (no strictEnv), so it is identical to a terminal the user would open with Ctrl+` and
 * its commands + network egress are NOT traced. This is the honest counterpart to the
 * Governed Terminal — a deliberate "friction follows authority" choice for a plain shell.
 *
 * THE INVARIANT (non-negotiable): this terminal must be VISIBLY, honestly ungoverned and
 * NEVER mistakable for a governed one. So:
 *   - the badge is NEUTRAL/AMBER — a `terminal` codicon (NOT the governed `shield`) and
 *     `terminal.ansiYellow` (a neutral/amber color — NEVER the governed `terminal.ansiGreen`);
 *   - it is deliberately NOT added to {@link glyphSpekOwnedTerminals} — it genuinely is
 *     not governed, so the governed/ungoverned distinction holds end-to-end;
 *   - it IS added to {@link deliberatelyUngovernedTerminals} so the A1 onDidOpenTerminal
 *     listener skips it (this command already shows its own honest one-time notice; the
 *     A1 "did you mean governed?" steer would be a redundant second nag).
 *
 * Persistence (the VS Code default, isTransient unset) is FINE here: unlike the governed
 * terminal, there is no supervisor-bound proxy env to go stale across a window reload.
 *
 * The icon/color are added ONLY when the ThemeIcon/ThemeColor constructors exist (the A1
 * guard pattern) so a minimal host/test stub without them degrades to an unbadged stock
 * terminal instead of throwing. Best-effort + non-fatal end to end.
 */
function openUngovernedTerminal(context) {
    // No env, no strictEnv, no proxy: a plain stock terminal with the full host environment.
    const terminalOptions = {
        name: 'Ungoverned Terminal',
    };
    if (typeof vscode.ThemeIcon === 'function') {
        // `terminal` (NOT `shield`) — a neutral glyph that never reads as governed.
        terminalOptions.iconPath = new vscode.ThemeIcon('terminal');
    }
    if (typeof vscode.ThemeColor === 'function') {
        // `terminal.ansiYellow` (amber/neutral) — NEVER the governed `terminal.ansiGreen`.
        terminalOptions.color = new vscode.ThemeColor('terminal.ansiYellow');
    }
    const terminal = vscode.window.createTerminal(terminalOptions);
    // Deliberately NOT glyphSpekOwnedTerminals.add(...): this terminal is genuinely NOT
    // governed. Record it as deliberately-ungoverned so the A1 listener skips the
    // accidental-terminal steer (its own confirming notice below is the single signal).
    deliberatelyUngovernedTerminals.add(terminal);
    terminal.show();
    // One-time honest CONFIRMING notice. Best-effort + non-fatal: a state-store/UI failure
    // must never break opening the terminal. Mirrors the A1 notice's read-flag /
    // show-with-"Don't show again" / persist-on-dismiss shape.
    try {
        const dismissed = Boolean(context.globalState.get(ungovernedTerminalOpenNotice_1.UNGOVERNED_TERMINAL_OPENED_NOTICE_KEY));
        if ((0, ungovernedTerminalOpenNotice_1.shouldAnnounceUngovernedTerminalOpened)({ dismissed })) {
            void vscode.window
                .showInformationMessage(ungovernedTerminalOpenNotice_1.UNGOVERNED_TERMINAL_OPENED_NOTICE, 'New Governed Terminal', "Don't show again")
                .then((choice) => {
                if (choice === 'New Governed Terminal') {
                    void vscode.commands.executeCommand('glyphcode.openGovernedTerminal');
                }
                else if (choice === "Don't show again") {
                    void context.globalState.update(ungovernedTerminalOpenNotice_1.UNGOVERNED_TERMINAL_OPENED_NOTICE_KEY, true);
                }
            });
        }
    }
    catch {
        /* best-effort: the honest confirming notice must never break opening a terminal */
    }
}
/* ================================================================== *
 * GOVERNED TERMINAL (M7 — the in-IDE Governed Terminal surface).
 *
 * Opens a REAL VS Code terminal the operator drives themselves (running their own
 * `claude` / `codex`), with its egress FORCED through the supervisor-owned
 * metadata-only proxy and its env sanitized of ambient host secrets/capability
 * handles. The supervisor projects the session's egress decisions + boundary
 * model-call METADATA (host, bytes up/down, duration — NO decrypted prompt/response
 * content) into a hash-chained, signed trace and streams it as the SAME `run/event`
 * feed the live Trust Panel renders.
 *
 * TRUST POSTURE (load-bearing, sweep-23 #2): this session is `governed-unsandboxed`
 * — governed + traced but the SOFT boundary, UNSANDBOXED. It can NEVER be presented
 * as product-trusted; the panel renders it honestly (the reducer's
 * boundary_only_cli label + the creation-trust badge) and a `degraded` close-verdict
 * is surfaced as lower-assurance. No product-trust gate is weakened: there is no
 * trusted run to mint here.
 * ================================================================== */
/**
 * Assemble the §10.3 run identity for a governed terminal session. Mirrors
 * assembleBridgeRunRequest but for a CLI actor under the SOFT (local-exec /
 * unsandboxed) boundary: the actorType is the detected CLI (claude-code-cli /
 * codex-cli) or 'native' when none is installed, and the runtime profile is
 * 'local-exec' (the supervisor settles the session into `governed-unsandboxed`
 * regardless — this string never by itself confers product trust).
 *
 * UX (one-click): UNLIKE the heavier governed-RUN path this NEVER pops a folder or
 * policy picker. The cwd is resolved non-interactively (workspace folder, else the
 * active-editor's folder, else os.homedir()) and the policy is the configured
 * glyphcode.policyPath when set, else the DEFAULT policy SHIPPED with the extension.
 * The cwd + policy provenance is surfaced honestly in the output channel. Returns
 * undefined (after surfacing the reason) only when the policy could not be
 * fingerprinted — never because the operator declined a picker (there is none).
 */
function assembleGovernedTerminalRequest(context, output, actorType) {
    // cwd: NON-PROMPTING. The soft terminal is just a cwd to run claude/codex in.
    const cwd = resolveTerminalCwd();
    if (cwd.provenance === 'home-dir-fallback') {
        output.appendLine(`[host] governed terminal cwd: no workspace folder open — using home directory ` +
            `(${cwd.path}). This is a HOME-DIR FALLBACK, not a workspace.`);
    }
    else {
        output.appendLine(`[host] governed terminal cwd: ${cwd.path} (${cwd.provenance}).`);
    }
    // policy: NON-PROMPTING. Configured glyphcode.policyPath, else the shipped default.
    const resolvedPolicy = resolveTerminalPolicy(context);
    if (!resolvedPolicy) {
        // resolveTerminalPolicy already surfaced an error message to the operator.
        output.appendLine('[host] governed terminal aborted: policy could not be fingerprinted.');
        return undefined;
    }
    if (resolvedPolicy.provenance === 'shipped-default') {
        output.appendLine(`[host] governed terminal policy: SHIPPED DEFAULT (deny-by-default; egress is ` +
            `supervisor-owned, not enforced by this file) — ${resolvedPolicy.path} ` +
            `(sha256 ${resolvedPolicy.policyHash}).`);
    }
    else {
        output.appendLine(`[host] governed terminal policy: CONFIGURED glyphcode.policyPath (${resolvedPolicy.scope}) — ` +
            `${resolvedPolicy.path} (sha256 ${resolvedPolicy.policyHash}).`);
    }
    const sourceCommit = resolveSourceCommit(cwd.path);
    return {
        actorType,
        autonomyTier: 'allowlist',
        policyPath: resolvedPolicy.path,
        policyHash: resolvedPolicy.policyHash,
        workspaceRoot: cwd.path,
        // SOFT boundary: the terminal is not run inside a supervisor-owned sandbox. The
        // supervisor settles this into `governed-unsandboxed` (never product-trusted).
        runtimeProfile: 'local-exec',
        extensionPosture: 'sovereign',
        ...(sourceCommit ? { sourceCommit } : { worktreeBase: cwd.path }),
    };
}
/**
 * The absolute fsPaths of the current workspace folders (empty if none). Used to flag
 * a WORKSPACE-LOCAL agent-CLI resolution (sweep-27): a CLI binary living inside the
 * repo being worked on is the red flag for a swapped/planted shim, so the governed
 * chat refuses to auto-run it.
 */
function workspaceFolderPaths() {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}
/**
 * The SHARED governed-terminal core. Starts the supervised session over the bridge
 * (terminal/start — NO client egress field, egress is supervisor-owned), opens a VS
 * Code terminal whose env routes egress through the returned proxy and strips ambient
 * host secrets, streams the session's run/event feed into the Trust Panel LIVE, and
 * finalizes the run (terminal/stop) when the operator closes the terminal.
 *
 * `surface` selects honest framing only. With `surface: 'terminal'` the detected agent
 * CLI is PRE-TYPED (never force-run) and the operator drives it. With `surface: 'chat'`
 * the detected agent CLI is AUTO-RUN INTERACTIVELY (e.g. `claude`\n): the interactive
 * TUI IS the chat — on the user's OWN subscription (auth from ~/.claude; GlyphCode
 * injects NO credential), governed (egress via the proxy, metadata-only), and traced
 * (a governed-unsandboxed run in the Trust Panel + Governed Runs sidebar). Either way
 * the trust posture is identical: governed + traced but UNSANDBOXED, never
 * product-trusted.
 */
async function openGovernedTerminalSurface(context, output, surface, detected) {
    // Returns the created, GlyphCode-OWNED `vscode.Terminal` once createTerminal succeeds (so a
    // caller — e.g. terminal Cmd-K — can acquire the exact governed handle and pre-type into
    // it), or `undefined` if a governed terminal was not opened (request-assembly failure,
    // workspace-local binary refusal, or supervisor terminal/start failure).
    output.show(true);
    const actorType = detected?.agent === 'claude'
        ? 'claude-code-cli'
        : detected?.agent === 'codex'
            ? 'codex-cli'
            : 'native';
    const request = assembleGovernedTerminalRequest(context, output, actorType);
    if (!request)
        return undefined;
    // CHAT BINARY-IDENTITY EVIDENCE (sweep-28 High). For the CHAT surface (which
    // AUTO-RUNS the detected agent CLI) resolve the launch and CAPTURE the binary's
    // identity NOW — immediately before launch — so the run records WHICH bytes/version
    // ran (TOCTOU: bound to the exact on-disk binary about to execute). We thread the
    // evidence ADDITIVELY into the terminal/start request (→ run_opened + trace) and
    // REUSE the same resolution for the actual auto-run sendText below, so the evidence
    // and the launched bytes are the same. A workspace-local resolution is refused HERE
    // (no session opened) exactly as the chat branch would. The TERMINAL surface never
    // auto-runs (it only pre-types), so it captures nothing.
    let chatLaunch;
    if (surface === 'chat' && detected) {
        chatLaunch = (0, agentLaunch_1.resolveAgentLaunch)(detected.path, workspaceFolderPaths());
        if (!chatLaunch.trustedForAutoRun) {
            void vscode.window.showWarningMessage(`GlyphCode Chat: did NOT auto-run your '${detected.agent}' — it resolved to ` +
                `${chatLaunch.launchPath}, which is INSIDE your workspace. A workspace-local CLI ` +
                'could be a swapped/planted binary, so GlyphCode will not launch it for you. ' +
                'The terminal is open and governed; run a trusted agent in it yourself if you intend to.');
            return undefined;
        }
        // Capture immediately before launch (TOCTOU). Never throws; best-effort fields.
        const binary = (0, agentBinaryIdentity_1.captureAgentBinaryIdentity)(chatLaunch.launchPath);
        // Thread ADDITIVELY: the full evidence object, plus the existing actorVersion
        // slot from the captured --version (when available). A consumer that ignores
        // actorBinary still sees actorVersion; both are OPTIONAL.
        request.actorBinary = {
            path: binary.path,
            ...(binary.sha256 ? { sha256: binary.sha256 } : {}),
            ...(binary.sizeBytes !== undefined ? { sizeBytes: binary.sizeBytes } : {}),
            ...(binary.mtimeMs !== undefined ? { mtimeMs: binary.mtimeMs } : {}),
            ...(binary.version ? { version: binary.version } : {}),
        };
        if (binary.version)
            request.actorVersion = binary.version;
        output.appendLine(`[host] governed chat actor binary: ${binary.path} ` +
            `(sha256 ${binary.sha256 ? `${binary.sha256.slice(0, 12)}…` : `unavailable: ${binary.sha256Unavailable}`}; ` +
            `version ${binary.version ?? `unavailable: ${binary.versionUnavailable}`}). ` +
            'Evidence captured at launch on the SOFT (governed-unsandboxed) path — not product-trusted.');
    }
    // Open + reveal the Trust Panel FIRST so it is ready for the live stream.
    // postRunEvent buffers any events that arrive before the webview signals ready.
    const panel = TrustPanel.createOrShow(context.extensionUri, getWebviewGestureGate());
    panel.reveal();
    const progressTitle = surface === 'chat' ? 'GlyphCode: opening governed chat…' : 'GlyphCode: opening governed terminal…';
    const start = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: progressTitle,
    }, () => (0, supervisorBridgeRunner_1.startGovernedTerminalSession)({
        bridgeServerPath: resolveBundledBridgeServerPath(context),
        extensionVersion: resolveExtensionVersion(context),
        runsBase: resolveRunsBase(),
        request,
        output,
        onRunEvent: withAmbientDevModePosture(context, (raw) => panel.postRunEvent(raw)),
    }));
    const surfaceLabel = surface === 'chat' ? 'governed chat' : 'governed terminal';
    if (!start.started || !start.session || !start.proxyUrl || !start.runId) {
        void vscode.window.showErrorMessage(`GlyphCode: could not open a ${surfaceLabel} — ${start.message}`);
        return undefined;
    }
    // Build the governed terminal env: FORCE egress through the supervisor's proxy and
    // STRIP ambient host secrets/capability handles (SSH_AUTH_SOCK, DOCKER_HOST, …) by
    // default. strictEnv makes the provided env the COMPLETE environment — nothing
    // ambient is inherited, so the secret firewall is default-deny (robust to unknown
    // vars). HOME is PRESERVED so the agent CLI authenticates from its OWN on-disk store
    // (~/.claude, ~/.codex — the user's SUBSCRIPTION); we inject NO credential and set NO
    // base-url override (anti-FauxCode).
    const { env: terminalEnv, strictEnv } = (0, governedTerminalEnv_1.buildGovernedTerminalEnv)({
        proxyUrl: start.proxyUrl,
        baseEnv: process.env,
    });
    // isTransient: do NOT let VS Code PERSIST/RESTORE this terminal across a window
    // reload. A governed terminal's HTTPS_PROXY/HTTP_PROXY points at THIS supervisor
    // process's metadata-only egress proxy (e.g. http://127.0.0.1:<port>), which is bound
    // to the supervisor's lifetime. A "Developer: Reload Window" RESTARTS the extension
    // host + supervisor; the old proxy port dies and a new proxy binds a DIFFERENT port.
    // If the terminal were persisted it would come back with that STALE, dead proxy env,
    // and the CLI's first egress (e.g. claude's OAuth token check) would hit the dead
    // port → `OAuth error: ECONNREFUSED`. With isTransient, a reload DROPS the governed
    // terminal; the user opens a fresh one that is wired to the LIVE proxy from
    // terminal/start. (Applies to both `surface === 'chat'` and the governed terminal —
    // both inject the supervisor-bound proxy env.)
    // GOVERNANCE-BOUNDARY LEGIBILITY (A1, visual-only). Badge the governed surface so it is
    // UNMISTAKABLE next to a stock/ungoverned terminal (which carries no icon/color). The
    // `shield` codicon is the same glyph the authority status-bar segment uses for
    // "governed"; `terminal.ansiGreen` is a registered terminal theme color that reads as
    // trusted/traced. Visual only — env/strictEnv/isTransient and all governance behavior
    // are untouched. The icon/color are added ONLY when the ThemeIcon/ThemeColor
    // constructors exist (mirroring the ThemeColor guard used for the status bar) so a
    // minimal host/test stub without them degrades to an unbadged terminal instead of
    // throwing.
    const terminalOptions = {
        name: surface === 'chat' ? 'GlyphCode Chat' : 'GlyphCode Governed Terminal',
        env: terminalEnv,
        strictEnv,
        isTransient: true,
    };
    if (typeof vscode.ThemeIcon === 'function') {
        terminalOptions.iconPath = new vscode.ThemeIcon('shield');
    }
    if (typeof vscode.ThemeColor === 'function') {
        terminalOptions.color = new vscode.ThemeColor('terminal.ansiGreen');
    }
    const terminal = vscode.window.createTerminal(terminalOptions);
    // Record this terminal as GlyphCode-OWNED so the onDidOpenTerminal honesty listener
    // (A1, Part 2) never warns about a surface GlyphCode itself governs + badged. The set
    // is a WeakSet so a closed terminal is collected without us tracking close events.
    glyphSpekOwnedTerminals.add(terminal);
    // Tie the supervised session's lifetime to the terminal: when the operator closes
    // it, FINALIZE the run (terminal/stop → signed verdict incl. assurance) and surface
    // the finalized posture. A `degraded` verdict is shown as lower-assurance and is
    // NEVER presented as fully trusted.
    const session = start.session;
    const closeSub = vscode.window.onDidCloseTerminal(async (closed) => {
        if (closed !== terminal)
            return;
        closeSub.dispose();
        const stop = await session.stop();
        if (!stop.finalized || !stop.verdict) {
            void vscode.window.showWarningMessage(`GlyphCode: ${surfaceLabel} ${session.runId} closed but did not finalize — ${stop.message}`);
            return;
        }
        const degraded = stop.verdict.assurance === 'degraded';
        const verdictLabel = `${stop.verdict.overallVerdict.toUpperCase()} (${degraded ? 'DEGRADED — lower assurance, not fully trusted' : 'assurance: full'})`;
        if (degraded) {
            void vscode.window.showWarningMessage(`GlyphCode: ${surfaceLabel} ${session.runId} finalized ${verdictLabel}. ` +
                'This session was governed + traced but UNSANDBOXED (metadata-only) — never product-trusted.');
        }
        else {
            void vscode.window.showInformationMessage(`GlyphCode: ${surfaceLabel} ${session.runId} finalized — verdict ${verdictLabel}. ` +
                'Governed + traced, metadata-only, UNSANDBOXED — not product-trusted.');
        }
    });
    context.subscriptions.push(closeSub);
    terminal.show();
    // Honest, one-line banner echoed in the terminal so the posture is visible IN the
    // surface (not only in a transient notification). GlyphCode holds no credential.
    const banner = surface === 'chat'
        ? "echo 'GlyphCode Chat — your Claude Code on your subscription, governed (metadata-only egress) + traced. GlyphCode holds no key.'"
        : "echo 'GlyphCode Governed Terminal — egress governed (metadata-only) + traced. UNSANDBOXED; never product-trusted. GlyphCode holds no key.'";
    terminal.sendText(banner, true);
    if (surface === 'chat') {
        // CHAT = a governed terminal running INTERACTIVE Claude Code. The interactive TUI
        // IS the chat: it stays on the user's SUBSCRIPTION (interactive `claude` is exempt
        // from the 2026-06-15 headless `claude -p`/Agent-SDK metering carve-out), so it is
        // cheap + durable.
        //
        // PRE-TYPE, DON'T AUTO-RUN (N2). The chat surface used to AUTO-RUN behind an
        // every-time "Open Chat" modal. We retire that routine interrupt and adopt the
        // user-driven Governed Terminal's pattern: PRE-TYPE the launch command (no newline)
        // and let the operator's own Enter BE the launch gesture. That keeps the launch
        // one-step (no modal) while preserving the anti-silent-launch property — a
        // third-party `executeCommand('glyphcode.openChat')` can stage the command but cannot
        // press Enter, so no actor process starts without the operator.
        //
        // BINARY-SWAP GUARD (sweep-27 High). We do NOT send the BARE name `detected.agent`:
        // the governed terminal PRESERVES PATH (for HOME-based auth), so a bare name is
        // RE-RESOLVED by the shell at exec time — a workspace-local `./claude` or a
        // PATH-injected shim could swap the binary. We send the CANONICALIZED ABSOLUTE path
        // detection already resolved (pre-typed, the operator presses Enter), and we already
        // REFUSED a path that resolves UNDER a workspace folder (caught before this point in
        // openGovernedChat and re-checked above), so the EXACT inode that was detected is the
        // one staged for the operator to run.
        if (detected && chatLaunch) {
            // chatLaunch was resolved + trust-checked + the binary identity captured BEFORE
            // session start (above); a workspace-local resolution already returned there. We
            // pre-type that exact canonical path so the bytes the operator runs match the
            // evidence threaded into run_opened + the trace.
            const launch = chatLaunch;
            terminal.sendText(launch.launchPath, false);
            void vscode.window.showInformationMessage(`GlyphCode Chat: pre-typed ${launch.launchPath} (your interactive '${detected.agent}') — press Enter ` +
                'to run it on YOUR subscription. Egress is governed (metadata-only) and streaming LIVE into the ' +
                'Trust Panel; this session is UNSANDBOXED and never product-trusted. GlyphCode holds no credential.');
        }
        // The no-CLI case never reaches here (the command shows the honest message and only
        // optionally opens this terminal; see openGovernedChat).
        return terminal;
    }
    // surface === 'terminal': honest, non-coercive ergonomics. If an agent CLI is
    // installed, PRE-TYPE its BARE name (without sending) so the operator just hits
    // Enter; never auto-run. We DELIBERATELY keep the bare name here (not the canonical
    // absolute path used by chat auto-run): the operator EXPLICITLY runs it, SEES exactly
    // what is on the command line, and controls when/whether to press Enter — so the
    // binary-swap-between-confirm-and-launch window the chat auto-run closes does not
    // apply (there is no silent auto-run gesture to protect). Otherwise leave the
    // terminal empty and tell the operator their egress is governed.
    if (detected) {
        terminal.sendText(detected.agent, false);
        void vscode.window.showInformationMessage(`GlyphCode: governed terminal ready. Your '${detected.agent}' CLI is pre-typed — press Enter to run it. ` +
            'Its egress is governed (metadata-only) and streaming LIVE into the Trust Panel; this session is ' +
            'UNSANDBOXED and never product-trusted.');
    }
    else {
        void vscode.window.showInformationMessage('GlyphCode: governed terminal ready. Any command you run here has its egress governed (metadata-only) ' +
            'and streamed LIVE into the Trust Panel. This session is UNSANDBOXED and never product-trusted.');
    }
    // Return the created, GlyphCode-owned terminal so a caller (terminal Cmd-K) can pre-type
    // into the exact governed surface just opened.
    return terminal;
}
/**
 * HEADLESS governed-terminal start for the fork's ⌃⌘K floating terminal. A variant of
 * {@link openGovernedTerminalSurface} that performs the bridge handshake +
 * {@link buildGovernedTerminalEnv} and RETURNS the governed env/proxy/cwd contract
 * instead of creating a `vscode.Terminal`. The live session handle is retained in
 * {@link governedFloatingSessions} (runId-keyed) so `stopSession(runId)` can finalize it.
 *
 * Resolve-never-reject (AD3/G1): every failure resolves with {ok:false} + an honest
 * message and opens NOTHING. The session is governed-unsandboxed, never product-trusted.
 */
async function startGovernedFloatingTerminalSession(context, output) {
    // Reuse the SAME non-prompting request assembly (cwd, policy, source-commit) the
    // panel governed terminal uses. The floating terminal is the SOFT, local-exec,
    // sovereign-posture surface — identical posture to the panel governed terminal.
    const request = assembleGovernedTerminalRequest(context, output, 'native');
    if (!request) {
        return { ok: false, message: 'GlyphCode: could not resolve a governed-terminal policy/cwd.' };
    }
    // ANCHOR-SAFE (do NOT reveal the Trust Panel here). The floating terminal anchors to the
    // ACTIVE code editor; TrustPanel.createOrShow + reveal both target
    // activeTextEditor.viewColumn, so opening/revealing the webview makes it the active tab IN
    // THE ANCHOR EDITOR'S COLUMN — hiding that editor and clearing its model. The fork then
    // attaches the terminal to a content widget whose host is no longer in the DOM, and
    // TerminalInstance._open() throws "A container element needs to be set with attachToElement
    // and be part of the DOM" (the "failed to attach" bug). So route live run events to the
    // Trust Panel ONLY if the operator already has it open (read-only peek — never creates,
    // never reveals, never steals the column). The run is fully traced regardless; the Trust
    // Panel is just a viewer the user can open separately.
    const panel = TrustPanel.peekCurrent();
    const start = await (0, supervisorBridgeRunner_1.startGovernedTerminalSession)({
        bridgeServerPath: resolveBundledBridgeServerPath(context),
        extensionVersion: resolveExtensionVersion(context),
        runsBase: resolveRunsBase(),
        request,
        output,
        onRunEvent: withAmbientDevModePosture(context, (raw) => panel?.postRunEvent(raw)),
    });
    // REFUSE-NOT-DEGRADE: a failed/partial handshake returns NO env/proxy. The fork must
    // open NO terminal (never an ungoverned shell in the floating window).
    if (!start.started || !start.session || !start.proxyUrl || !start.runId) {
        return { ok: false, message: start.message || 'governed terminal did not start.' };
    }
    // Build the governed env ext-side over the EXT-HOST process.env (the secret firewall
    // is default-deny via strictEnv). The fork passes this VERBATIM (B1a/AD8).
    const { env: terminalEnv, strictEnv } = (0, governedTerminalEnv_1.buildGovernedTerminalEnv)({
        proxyUrl: start.proxyUrl,
        baseEnv: process.env,
    });
    // Stamp the floating-owned env marker (= runId) so the surface is identifiable as
    // governed-owned even via env (secondary to the name marker). Inert; carried through
    // strictEnv. The fork never has to read renderer env to add this — it is already here.
    terminalEnv[governedFloatingTerminal_1.FLOATING_GOVERNED_TERMINAL_ENV_MARKER] = start.runId;
    // Retain the live session handle, runId-keyed (A4a/B4). stopSession(runId) finalizes it.
    governedFloatingSessions.set(start.runId, start.session);
    governedFloatingOwnedRunIds.add(start.runId);
    // G7/E18 — MID-SESSION governance loss. If the supervisor child/proxy dies while the
    // shell is still alive, the egress proxy is gone and the session can no longer claim to
    // be governed. The detection lives ext-side (the bridge child-exit); the FORK can't see
    // it (no handle to the bridge child), so the ext-host tells the fork over the command
    // seam — mirroring the registerOwned/showError direction. The fork's controller then
    // drops the green badge (markDegraded) and finalizes via stopSession. We forget the live
    // handle here too so the fork's subsequent stopSession is a clean idempotent no-op (the
    // run was already finalized by the supervisor exit). Best-effort; never throws.
    const runId = start.runId;
    const lossSub = start.session.onGovernanceLoss(() => {
        // Drop + DISPOSE the subscription so the loss can only be reported once (no leak, no
        // double-fire), then tell the fork over the command seam. The session HANDLE is left
        // live so the fork's degraded+teardown path (markDegraded → stopSession) still
        // finalizes the run as a DEGRADED verdict (AD5 always-finalize / B4a).
        governedFloatingLossSubs.get(runId)?.dispose();
        governedFloatingLossSubs.delete(runId);
        void vscode.commands.executeCommand('glyphcode.floatingTerminal.governanceLost', runId);
    });
    governedFloatingLossSubs.set(runId, lossSub);
    return {
        ok: true,
        runId: start.runId,
        env: terminalEnv,
        strictEnv,
        proxyUrl: start.proxyUrl,
        cwd: request.workspaceRoot,
        name: governedFloatingTerminal_1.FLOATING_GOVERNED_TERMINAL_NAME,
        envMarker: governedFloatingTerminal_1.FLOATING_GOVERNED_TERMINAL_ENV_MARKER,
        message: '',
    };
}
/**
 * HEADLESS finalize for the fork's ⌃⌘K floating terminal. IDEMPOTENT + runId-SCOPED
 * (A4a/B4/B4a/AD5/G6): every fork teardown path (Esc, editor close/move, window
 * unload, mid-session governance loss, throw-after-runId) calls this. An unknown /
 * already-finalized runId resolves cleanly (not finalized), never throws — so a
 * double-stop or a window-B stop of a window-A runId is a safe no-op. The underlying
 * `session.stop()` is itself idempotent.
 */
async function stopGovernedFloatingTerminalSession(runId) {
    if (typeof runId !== 'string' || runId.length === 0) {
        return { finalized: false, message: 'stopSession: a runId string is required.' };
    }
    const session = governedFloatingSessions.get(runId);
    if (!session) {
        // Unknown / already-stopped: idempotent no-op (the entry was deleted on a prior stop).
        return { finalized: false, message: `no live governed floating session for runId ${runId}.` };
    }
    // Drop the handle BEFORE awaiting so a concurrent second stop sees no session (idempotent).
    governedFloatingSessions.delete(runId);
    governedFloatingOwnedRunIds.delete(runId);
    // Drop the governance-loss subscription so it can never fire after teardown (G7 cleanup).
    governedFloatingLossSubs.get(runId)?.dispose();
    governedFloatingLossSubs.delete(runId);
    const stop = await session.stop();
    if (!stop.finalized || !stop.verdict) {
        return { finalized: false, message: stop.message };
    }
    return {
        finalized: true,
        assurance: stop.verdict.assurance,
        overallVerdict: stop.verdict.overallVerdict,
        message: '',
    };
}
/**
 * Open the in-IDE Governed Terminal: the user-driven surface. Detects an agent CLI
 * (to tag the actor identity + pre-type the command) and delegates to the shared
 * governed-terminal core. The detected CLI is PRE-TYPED for the operator to run —
 * never force-run. Returns the created governed `vscode.Terminal` (or `undefined` if one
 * could not be opened) so terminal Cmd-K can acquire its handle.
 */
async function openGovernedTerminal(context, output) {
    return openGovernedTerminalSurface(context, output, 'terminal', (0, agentCli_1.detectAgentCli)());
}
/**
 * Open GlyphCode CHAT = a governed terminal running INTERACTIVE Claude Code.
 *
 * "Chat can be a terminal." The interactive Claude Code TUI IS a chat. Interactive
 * `claude` stays on the user's SUBSCRIPTION (it is exempt from the 2026-06-15 headless
 * `claude -p`/Agent-SDK metering carve-out), so it is cheap + durable. So GlyphCode
 * Chat is NOT a separate webview or a headless-JSON stream — it is the GOVERNED
 * TERMINAL with the user's interactive agent AUTO-LAUNCHED. This reuses the entire
 * governed-terminal stack (egress proxy, sanitized env with HOME preserved for the
 * ~/.claude subscription auth, run/event projection into the Trust Panel + sidebar).
 *
 * If NO agent CLI is detected we do NOT open a fake chat: we show an HONEST message
 * (install Claude Code / `claude login`, or install Codex) and still open the governed
 * terminal so the operator can install/login inside it. GlyphCode holds NO credential.
 */
async function openGovernedChat(context, output) {
    const detected = (0, agentCli_1.detectAgentCli)();
    if (!detected) {
        // HONEST no-CLI path: never open a fake chat. Tell the truth and link the docs.
        const INSTALL = 'How to install';
        const choice = await vscode.window.showWarningMessage('GlyphCode Chat runs your Claude Code in a governed terminal. Install Claude Code and run ' +
            '`claude login` to chat on your subscription (or install Codex).', INSTALL);
        if (choice === INSTALL) {
            void vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/en/docs/claude-code/setup'));
        }
        // Still open the governed terminal (no auto-run) so they can install/login IN it
        // with egress already governed. detected is undefined → no agent is auto-run.
        await openGovernedTerminalSurface(context, output, 'chat', undefined);
        return;
    }
    // WORKSPACE-LOCAL BINARY RED FLAG (sweep-27 High) — the ONE genuine modal-worthy case,
    // PRESERVED. Resolve the EXACT binary the chat would run NOW (canonicalized absolute
    // path, workspace-local trust decision). If it resolves UNDER a workspace folder it
    // could be a swapped/planted shim, so refuse the chat-launch ergonomics outright (no
    // pre-type, no auto-run) and tell the operator the full path honestly.
    const launch = (0, agentLaunch_1.resolveAgentLaunch)(detected.path, workspaceFolderPaths());
    if (!launch.trustedForAutoRun) {
        void vscode.window.showWarningMessage(`GlyphCode Chat will NOT launch your '${detected.agent}': it resolves to ` +
            `${launch.launchPath}, which is INSIDE your workspace. A workspace-local CLI could be a ` +
            'swapped/planted binary. Open a Governed Terminal and run a trusted agent yourself if you intend to.');
        return;
    }
    // NO ROUTINE LAUNCH MODAL (N2). The chat path used to fire a blocking "Open Chat" modal
    // on EVERY open before launching the user's own `claude`. We retire that every-time
    // interrupt and mirror the Governed Terminal pattern instead: the chat surface now
    // PRE-TYPES the launch command (no newline) and the operator's own Enter IS the launch
    // gesture. That defeats the original concern just as well — a third-party
    // `executeCommand('glyphcode.openChat')` can open a terminal with the command staged,
    // but it CANNOT press Enter, so no actor process is silently launched (same property
    // the user-driven Governed Terminal already relies on). The session stays governed +
    // traced (governed-unsandboxed), never product-trusted. The genuine red-flag modal
    // (workspace-local binary, above) is preserved.
    await openGovernedTerminalSurface(context, output, 'chat', detected);
}
/**
 * Build the production {@link NativeChatSessionFactory} for the native chat window:
 * it opens a {@link ChatSession} against the bundled, hash-pinned bridge-server, which
 * drives chat/send through the GlyphCode model gateway's CODEX backend. No credential
 * is handled here; the supervisor holds none either (Codex authenticates from its own
 * store). A test injects a fake factory instead.
 */
function buildNativeChatSessionFactory(context, output) {
    return {
        open: () => {
            // The open workspace folder is the TRUSTED session root the supervisor binds
            // index/retrieve to (the same source the chat participant passes per-call). When
            // no folder is open, omit it — the supervisor pins the root from the first retrieve.
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            return (0, supervisorBridgeRunner_1.openChatSession)({
                bridgeServerPath: resolveBundledBridgeServerPath(context),
                extensionVersion: resolveExtensionVersion(context),
                runsBase: resolveRunsBase(),
                ...(workspaceRoot ? { workspaceRoot } : {}),
                output,
            });
        },
    };
}
/* ================================================================== *
 * CHAT TERMINAL VIEW WIRING (M7 — the SIDEBAR "chat that's a terminal").
 *
 * The activity-bar `glyphcode.chat` webview-view hosts an xterm.js terminal connected
 * to a real PTY running the user's interactive `claude`, governed. Unlike
 * `glyphcode.openChat` (which opens a VS Code terminal), this surface lives IN the
 * sidebar and OWNS its own terminal — the shape the product wants. It reuses the
 * ENTIRE governed stack: startGovernedTerminalSession (terminal/start, run/event
 * projection into the Trust Panel + Governed Runs sidebar), buildGovernedTerminalEnv
 * (secret firewall + forced proxy + preserved HOME for the ~/.claude subscription),
 * and the resolveAgentLaunch binary-swap guard. The PTY backend is node-pty (proven in
 * spikes/p0-governed-pty); see ptyHost.ts for the load + exec-bit repair.
 * ================================================================== */
/**
 * Login-shell FALLBACK for agent detection, shaped like detectAgentCli's result
 * ({@link DetectedAgentCli}). Tries the KNOWN agents in preference order (claude, then
 * codex) via the user's login shell — which sources their rc/profile and so sees the
 * REAL PATH (e.g. ~/.local/bin) even when the Dock-launched app inherited a stripped
 * one. Returns the first agent whose absolute executable the shell reports, or undefined.
 */
function resolveAgentViaLoginShellAsDetected() {
    for (const agent of agentCli_1.KNOWN_AGENT_CLIS) {
        const resolved = (0, loginShellResolve_1.resolveAgentViaLoginShell)(agent);
        if (resolved)
            return { agent, path: resolved.path };
    }
    return undefined;
}
/**
 * Context-bound wrapper for {@link computeNodePtyBaseDirs} (sweep-30 F4): gather the
 * app/extension inputs from vscode and delegate to the PURE, unit-tested helper. The
 * candidate ORDER is documented on that helper; the load-bearing F4 change is that
 * glyphcode.supervisorPath is NO LONGER a node-pty candidate (a native module must not
 * be dlopen'd from a directory chosen by a general dev setting). The dev-spikes fallback
 * (for `npm test`) is taken from a DEDICATED env hint instead.
 */
function resolveNodePtyBaseDirs(context) {
    return (0, nodePtyBaseDirs_1.computeNodePtyBaseDirs)({
        extensionDir: context.extensionUri.fsPath,
        appRoot: vscode.env.appRoot,
        execPath: process.execPath,
        // SECURITY (F2): only honor the dev-spikes env hint in a Development/Test context.
        // In Production an env var must NOT be able to add a native-module require() search
        // dir, so this resolves to undefined and only packaged first-party paths are used.
        devSpikesRoot: (0, nodePtyBaseDirs_1.devSpikesRootFor)(context.extensionMode, [vscode.ExtensionMode.Development, vscode.ExtensionMode.Test], process.env.GLYPHCODE_DEV_SPIKES_ROOT),
    });
}
/**
 * Build the {@link ChatTerminalDeps} the sidebar Chat view needs. The view is pure
 * transport (xterm ⇄ PTY); this factory supplies the two host-side capabilities:
 *   - startSession(): detect the agent, apply the SAME binary-swap + workspace-local
 *     guards as openGovernedChat, start the governed bridge session, and return the
 *     proxy url + canonical launch path the view runs under the PTY.
 *   - resolveNodePty(): load the proven node-pty backend (or undefined → empty state).
 */
function buildChatTerminalDeps(context, output) {
    return {
        resolveNodePty() {
            return (0, ptyHost_1.loadNodePty)(resolveNodePtyBaseDirs(context));
        },
        async startSession() {
            output.show(true);
            // RESOLUTION ORDER (the Dock-PATH bug). (1) the extension's own PATH scan; (2)
            // FALL BACK to the user's LOGIN shell — when GlyphCode.app is launched from the
            // Dock it inherits a stripped PATH (/usr/bin:/bin:…) that lacks ~/.local/bin where
            // the user's `claude` lives, so the extension-PATH scan finds nothing even though
            // `claude` runs fine in the user's terminal. The login shell sources the user's
            // rc/profile and reports the SAME absolute binary their terminal would.
            const detected = (0, agentCli_1.detectAgentCli)() ?? resolveAgentViaLoginShellAsDetected();
            if (!detected) {
                // HONEST, non-silent: surface the reason in the webview empty state.
                return {
                    error: "Couldn't find Claude Code / Codex on your PATH. Open a terminal and run `claude` once, " +
                        "or make sure it's installed.",
                };
            }
            // BINARY-SWAP GUARD (sweep-27/28). Canonicalize the detected path and REFUSE a
            // workspace-local resolution (the red flag for a planted shim) — exactly as the
            // openGovernedChat command does. The PTY runs the EXACT canonical path.
            const launch = (0, agentLaunch_1.resolveAgentLaunch)(detected.path, workspaceFolderPaths());
            if (!launch.trustedForAutoRun) {
                void vscode.window.showWarningMessage(`GlyphCode Chat will NOT auto-run your '${detected.agent}': it resolves to ` +
                    `${launch.launchPath}, which is INSIDE your workspace. A workspace-local CLI could be ` +
                    'a swapped/planted binary. Run a trusted agent in a Governed Terminal yourself if you intend to.');
                return undefined;
            }
            const actorType = detected.agent === 'claude' ? 'claude-code-cli' : 'codex-cli';
            const request = assembleGovernedTerminalRequest(context, output, actorType);
            if (!request)
                return undefined;
            // Capture the binary identity immediately before launch (TOCTOU) and thread it
            // additively into the run request → run_opened + trace.
            const binary = (0, agentBinaryIdentity_1.captureAgentBinaryIdentity)(launch.launchPath);
            request.actorBinary = {
                path: binary.path,
                ...(binary.sha256 ? { sha256: binary.sha256 } : {}),
                ...(binary.sizeBytes !== undefined ? { sizeBytes: binary.sizeBytes } : {}),
                ...(binary.mtimeMs !== undefined ? { mtimeMs: binary.mtimeMs } : {}),
                ...(binary.version ? { version: binary.version } : {}),
            };
            if (binary.version)
                request.actorVersion = binary.version;
            // Open + reveal the Trust Panel so it is ready for the LIVE run/event stream.
            const panel = TrustPanel.createOrShow(context.extensionUri, getWebviewGestureGate());
            panel.reveal();
            const start = await (0, supervisorBridgeRunner_1.startGovernedTerminalSession)({
                bridgeServerPath: resolveBundledBridgeServerPath(context),
                extensionVersion: resolveExtensionVersion(context),
                runsBase: resolveRunsBase(),
                request,
                output,
                onRunEvent: withAmbientDevModePosture(context, (raw) => panel.postRunEvent(raw)),
            });
            if (!start.started || !start.session || !start.proxyUrl || !start.runId) {
                void vscode.window.showErrorMessage(`GlyphCode Chat: could not start a governed session — ${start.message}`);
                return undefined;
            }
            const session = start.session;
            let stopped = false;
            return {
                runId: start.runId,
                proxyUrl: start.proxyUrl,
                launchPath: launch.launchPath,
                args: [],
                cwd: request.workspaceRoot,
                async stop() {
                    if (stopped)
                        return;
                    stopped = true;
                    const result = await session.stop();
                    if (result.finalized && result.verdict) {
                        const degraded = result.verdict.assurance === 'degraded';
                        output.appendLine(`[chat] governed run ${start.runId} finalized — ${result.verdict.overallVerdict.toUpperCase()} ` +
                            `(${degraded ? 'DEGRADED — lower assurance' : 'assurance: full'}). ` +
                            'Governed + traced, metadata-only, UNSANDBOXED — not product-trusted.');
                    }
                    else {
                        output.appendLine(`[chat] governed run ${start.runId} did not finalize — ${result.message}`);
                    }
                },
            };
        },
    };
}
/**
 * Create + launch a TRUSTED governed run. SECURITY (sweep-19 High #3): this is the
 * trusted-run creation path that prepares the verifier keystore and hands the
 * verifier PRIVATE key to the hash-pinned supervisor so verdicts pin AUTHORITATIVE.
 * It is module-private (never exported, never registered as a command) and it
 * REFUSES unless `gestureToken` consumes as a CURRENT first-party operator gesture
 * from `gestures`. A caller without a valid current-gesture token can never reach
 * the keystore/private-key path — the run is refused before any trusted work.
 */
async function createTrustedGovernedRun(context, supervisorOutput, gestures, gestureToken) {
    // GATE: require a valid CURRENT first-party operator gesture. A request lacking
    // one (e.g. a third-party extension that somehow reached this function) is
    // REFUSED here — before the keystore is touched or the verifier key is passed —
    // so it can never produce a trusted run.
    if (!consumeTrustedRunGesture(gestures, gestureToken, supervisorOutput))
        return;
    {
        // DEV OVERRIDE detection. When glyphcode.supervisorPath is set (user/global
        // only), the operator has explicitly opted into running the UN-BUNDLED,
        // UN-PINNED supervisor from the spikes tree. Otherwise (the default) we run
        // the BUNDLED, hash-pinned supervisor shipped in the .vsix.
        const { path: devSupervisorPath, fromWorkspaceIgnored } = resolveSupervisorPath();
        const isDevOverride = Boolean(devSupervisorPath);
        // A workspace/folder value was supplied and DELIBERATELY ignored — surface
        // it so a repo's silently-overridden setting is visible to the operator
        // (Critical #2: a repo must not redirect the supervisor exec path).
        if (fromWorkspaceIgnored) {
            void vscode.window.showWarningMessage('GlyphCode: a workspace setting tried to set "glyphcode.supervisorPath" and was ignored ' +
                'for security. The supervisor path is taken only from USER (global) settings.');
        }
        // Resolve the actual exec for this run: bundled (default) or dev override.
        const bundledPath = resolveBundledSupervisorPath(context);
        let cliPath;
        if (isDevOverride) {
            cliPath = resolveCliPath(devSupervisorPath);
            // Sanity-check the dev entry up front so a misconfigured override fails
            // loudly with a clear message rather than as an opaque spawn error.
            if (!fs.existsSync(cliPath)) {
                void vscode.window.showErrorMessage(`GlyphCode: dev-override supervisor CLI not found at ${cliPath}. ` +
                    'Fix or clear "glyphcode.supervisorPath" in USER settings (clear it to use the bundled supervisor).');
                return;
            }
            void vscode.window.showWarningMessage('GlyphCode: running the UN-PINNED dev supervisor from "glyphcode.supervisorPath" ' +
                '(not the bundled, hash-pinned one). The verifier key is withheld unless ' +
                '"glyphcode.devSupervisorTrustKey" is enabled.');
        }
        else if (!fs.existsSync(bundledPath)) {
            // The bundled supervisor must ship in the .vsix; a missing bundle is a
            // packaging fault, not an operator misconfiguration.
            void vscode.window.showErrorMessage(`GlyphCode: bundled supervisor missing at ${bundledPath}. ` +
                'This .vsix appears to be packaged incorrectly (run "npm run bundle:supervisor" before packaging).');
            return;
        }
        const repo = await resolveTargetRepo();
        if (!repo)
            return; // user cancelled
        // The picker's policy default is the spikes capstone fixture, which exists
        // only on the dev path; on the bundled path there is no preset default and
        // the operator picks a policy (passing '' yields no defaultUri).
        const resolvedPolicy = await resolvePolicyPath(devSupervisorPath);
        if (!resolvedPolicy)
            return; // user cancelled
        const policy = resolvedPolicy.path;
        // Medium #1 — policy provenance. Always log WHICH policy bytes govern this
        // run (path + sha256) so the run's provenance is visible. A repo-provided
        // policy is legitimate under policy-as-code, but it must not silently win:
        // when the effective value came from a WORKSPACE / WORKSPACE-FOLDER scope
        // (a repo's .vscode/settings.json), require an explicit modal confirmation
        // naming the policy path and its sha256 before launching.
        const policyFp = (0, policyHash_1.policyFileSha256)(policy);
        const policyShaLabel = policyFp.sha256 ?? `(${policyFp.note})`;
        supervisorOutput.appendLine(`[host] policy provenance: scope=${resolvedPolicy.scope} path=${policy} sha256=${policyShaLabel}`);
        if (resolvedPolicy.scope === 'workspace' || resolvedPolicy.scope === 'workspaceFolder') {
            const proceed = await vscode.window.showWarningMessage('GlyphCode: about to run under a REPO-PROVIDED policy (not operator-pinned):\n' +
                `${policy}\n` +
                `sha256: ${policyShaLabel}\n` +
                'Proceed?', { modal: true }, 'Run');
            if (proceed !== 'Run') {
                supervisorOutput.appendLine('[host] run aborted: operator declined the repo-provided policy.');
                return;
            }
        }
        // Mode. The BUNDLED path only runs verify-only this increment; autonomous
        // is gated to the dev-override path (which runs from the spikes tree where
        // its DEFAULT_RUNS_BASE_DIR is user-writable — see governed-run-cli.ts
        // runAutonomous note). A configured 'autonomous' on the bundled path is
        // coerced to verify-only with a heads-up rather than silently doing nothing.
        const requestedMode = resolveSupervisorMode();
        let mode = requestedMode;
        if (!isDevOverride && requestedMode === 'autonomous') {
            mode = 'verify-only';
            void vscode.window.showWarningMessage('GlyphCode: autonomous mode is not yet available on the bundled supervisor; ' +
                'running verify-only. (Autonomous requires the dev-override path this increment.)');
        }
        const outDir = resolveOutputDir(repo);
        const runsBase = resolveRunsBase();
        // Ensure the out-of-band keystore exists and pass its STABLE private key to
        // the CLI so the verifier signs with a key we pin into the panel. A failure
        // here aborts the run (better than running with an unpinned, never-trusted
        // verdict).
        let keystore;
        try {
            keystore = ensureVerifierKeystore();
        }
        catch (err) {
            void vscode.window.showErrorMessage(`GlyphCode: could not prepare the verifier keystore at ${verifierKeystoreDir()}: ` +
                `${String(err?.message ?? err)}`);
            return;
        }
        // Create the output dir AND the runs base up front so the CLI's --out and
        // the child's cwd (=runsBase on the bundled path) always exist.
        try {
            fs.mkdirSync(outDir, { recursive: true });
            fs.mkdirSync(runsBase, { recursive: true });
        }
        catch (err) {
            void vscode.window.showErrorMessage(`GlyphCode: could not create run directories (${outDir} / ${runsBase}): ` +
                `${String(err?.message ?? err)}`);
            return;
        }
        supervisorOutput.show(true);
        // Verifier-key custody.
        //   BUNDLED path: the exec is hash-pinned (supervisorRunner refuses a
        //     mismatched bundle), so its code is trusted by construction — always
        //     hand it the verifier private key so verdicts pin as AUTHORITATIVE.
        //   DEV-OVERRIDE path: the un-pinned spikes-tree exec gets the key ONLY when
        //     the operator explicitly opts in via glyphcode.devSupervisorTrustKey;
        //     otherwise the key is withheld (verdicts fall back to ephemeral and
        //     show UNTRUSTED). A workspace override that was ignored also withholds.
        let passVerifierKey;
        if (!isDevOverride) {
            passVerifierKey = true;
        }
        else {
            // Critical (sweep-15): read the opt-in via inspect() and accept ONLY the
            // user/global (else default) scope — a repo's .vscode/settings.json must
            // never be able to flip this flag true and hand the verifier PRIVATE key
            // to the un-pinned dev supervisor. The merged get() would let a workspace
            // value win; selectGlobalScopedBool() ignores workspace/folder scopes
            // (defense in depth alongside `"scope": "machine"` in package.json).
            const devTrustInspect = vscode.workspace
                .getConfiguration('glyphcode')
                .inspect('devSupervisorTrustKey');
            const devTrust = (0, configScope_1.selectGlobalScopedBool)(devTrustInspect, false);
            const devTrustWorkspaceIgnored = typeof devTrustInspect?.workspaceValue === 'boolean' ||
                typeof devTrustInspect?.workspaceFolderValue === 'boolean';
            if (devTrustWorkspaceIgnored) {
                supervisorOutput.appendLine('[host] a workspace setting tried to set "glyphcode.devSupervisorTrustKey" and was ' +
                    'IGNORED for security — the verifier-key opt-in is honored only from USER (global) settings.');
            }
            passVerifierKey = devTrust === true && !fromWorkspaceIgnored;
            if (!passVerifierKey) {
                supervisorOutput.appendLine('[host] dev-override supervisor: withholding the verifier private key from the ' +
                    'un-pinned exec (enable "glyphcode.devSupervisorTrustKey" to opt in).');
            }
            else {
                supervisorOutput.appendLine('[host] dev-override supervisor: verifier key opt-in is ENABLED — handing the key to ' +
                    'the un-pinned exec (dev only).');
            }
        }
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            cancellable: true,
            title: `GlyphCode: governed run (${mode})…`,
        }, (progress, token) => {
            progress.report({ message: 'launching supervisor…' });
            return (0, supervisorRunner_1.runSupervisor)({
                ...(isDevOverride
                    ? { cliPath: cliPath, cwd: devSupervisorPath }
                    : { bundlePath: bundledPath }),
                repo,
                policy,
                out: outDir,
                mode,
                runsBase,
                ...(passVerifierKey ? { verifierKeyPath: keystore.privateKeyPath } : {}),
                output: supervisorOutput,
                token,
            });
        });
        // Cancellation: do NOT clobber whatever the panel is currently showing.
        if (result.cancelled) {
            void vscode.window.showWarningMessage('GlyphCode: governed run cancelled.');
            return;
        }
        if (result.spawnFailed) {
            // Covers both an actual spawn failure AND the bundled-supervisor hash-gate
            // refusal (supervisorRunner returns spawnFailed with a clear message).
            const hint = isDevOverride
                ? 'Verify Node/tsx are available and "glyphcode.supervisorPath" is correct (or clear it to use the bundled supervisor). '
                : 'If this is a hash mismatch, re-run "npm run bundle:supervisor" and re-package the .vsix. ';
            void vscode.window.showErrorMessage(`GlyphCode: could not start the supervisor. ${result.message} ` +
                hint +
                'See the "GlyphCode Governed Run" output channel for details.');
            return;
        }
        if (result.exitCode !== 0) {
            // A non-zero exit often means Docker is unavailable, or the run errored.
            // The full reason is in the output channel; offer a one-click open.
            const choice = await vscode.window.showErrorMessage(`GlyphCode: governed run failed (exit ${result.exitCode}). ` +
                'A common cause is no reachable Docker daemon. ' +
                'See the output channel for the supervisor log.', 'Show Log');
            if (choice === 'Show Log')
                supervisorOutput.show(true);
            return;
        }
        // Success: open the panel and load the freshly written bundle via the
        // EXISTING seam. The panel re-injects the keystore public key on (re)build,
        // so a verdict signed with the keystore key shows AUTHORITATIVE.
        const panel = TrustPanel.createOrShow(context.extensionUri, getWebviewGestureGate());
        panel.reveal();
        panel.loadBundleFromDirectory(result.bundleDir);
        void vscode.window.showInformationMessage(`GlyphCode: governed run complete — bundle at ${result.bundleDir}.`);
    }
}
function deactivate() {
    // Restore any applied halo chrome tint + clear the glyphcode.authority context-
    // key (Slice 2). The status-bar items are disposed via context.subscriptions.
    // Webview panel disposal is handled per-panel.
    if (runStatusController) {
        void runStatusController.dispose();
        runStatusController = undefined;
    }
    // Drop the provenance-gutter decoration types (Slice 3). attach() also pushed this
    // dispose into context.subscriptions, so this is belt-and-suspenders; clearing the
    // singleton lets a re-activate in the same process build a fresh controller.
    if (provenanceGutterController) {
        provenanceGutterController.dispose();
        provenanceGutterController = undefined;
    }
    // Drop the rail governance-surface registry (Slice 4). Each surface provider's own
    // webview dispose was pushed into context.subscriptions; clearing the singleton lets
    // a re-activate in the same process build a fresh, empty registry.
    governanceSurfaceRegistry = undefined;
    // Clear the friction-tier context-key (PATCH-009) so the native title-bar ladder +
    // the editor-recede chrome return to their neutral (governed/non-receded) state when
    // the extension deactivates. The TierController owns this key for the session.
    if (tierController) {
        tierController.reset();
        tierController = undefined;
    }
}
//# sourceMappingURL=extension.js.map