"use strict";
/*
 * GlyphSpek Trust Panel — VS Code / Code-OSS extension host.
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
/** The file names that make up a run bundle, in load order. */
const BUNDLE_FILE_NAMES = [
    'trace.jsonl',
    'verdict.json',
    'verifier-public-key.pem',
    'actor-claims.json',
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
 * The module-private first-party webview gesture gate (sweep-20 High #3). One
 * instance per extension process, created on first use. It owns the operator-
 * gesture registry AND the trusted-run launchers, and is NEVER exported on the
 * public surface. Trusted-run launchers are reached ONLY via
 * gate.launchFromWebview, which TrustPanel calls from its webview message handler —
 * so only a genuine first-party webview gesture (the operator clicking a GlyphSpek
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
 * webview's LADDER_TIERS. Used to validate the `glyphspekTier` message before it
 * reaches the `glyphspek.tier` context-key so the fork chrome only ever sees a known
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
 * `glyphspek.tier` context-key, the one source feeding the two friction views.
 *
 * The friction tier (ask | inline | governed | sensitive | sovereign — §6) is set
 * from exactly two view controls, both of which route through here so there is NO
 * second writer of the context-key:
 *
 *   (1) The NATIVE title-bar Authority Ladder (fork, glyphspekTitleLadder.ts) — its
 *       rung click invokes the `glyphspek.setTier` command, which calls set() here.
 *   (2) The WEBVIEW Trust Panel ladder — its rung click posts `glyphspekTier`, whose
 *       host handler calls set() here.
 *
 * set() (a) de-dups + writes the `glyphspek.tier` context-key (the native ladder + the
 * editor-recede chrome read it), and (b) syncs the Trust Panel webview ladder if one is
 * open (so a native click reflects in the webview, and vice-versa via the no-echo
 * receiver in live.js). It NEVER force-opens the panel — the native ladder is the
 * canonical control and works with no webview present.
 *
 * VIEW-ONLY / ORTHOGONAL (§2.1, §6, §2.4): this is the FRICTION axis only. It carries
 * NO assurance, NEVER touches `glyphspek.authority` (the halo), and grants NOTHING. The
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
            void vscode.commands.executeCommand('setContext', 'glyphspek.tier', tier);
        }
        if (options.syncWebview) {
            TrustPanel.syncLadderTier(tier);
        }
    }
    /** Clear the context-key back to its neutral (unset) state on teardown. */
    reset() {
        if (this.lastTier !== undefined) {
            this.lastTier = undefined;
            void vscode.commands.executeCommand('setContext', 'glyphspek.tier', undefined);
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
 * the `glyphspek.authority` context-key).
 *
 * Owns the vscode side effects for three honest surfaces, all fed by the SAME
 * run/event stream the Trust Panel + Governed Runs view read (TrustPanel.
 * postRunEvent calls notify() on every event):
 *
 *   (1) STATUS-BAR SEGMENTS (§1.12 / §5.10): four items — `authority: <level>`
 *       (colored by ThemeColor to match the halo/assurance), `sandboxed worktree`,
 *       `N traced events`, `policy: .glyphspek/policy.yml`. Computed by the PURE
 *       StatusBarSegments model (statusBarSegments.ts), disposed on deactivate.
 *
 *   (2) HALO FALLBACK (§1.1/§2.2 option 1): an OPT-IN (glyphspek.halo.tintChrome,
 *       default OFF) tint of real chrome edges (titleBar/activityBar/statusBar) to
 *       the assurance color via workbench.colorCustomizations — FULLY REVERSIBLE
 *       (snapshot on first enable, restore on disable/deactivate). When OFF, the
 *       `authority:` segment + Slice 1's header accent are the honest backstop.
 *
 *   (3) The `glyphspek.authority` CONTEXT-KEY: set on every assurance change so the
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
            .getConfiguration('glyphspek')
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
            this.authorityItem.command = 'glyphspek.openTrustPanel';
            this.tracedItem.command = 'glyphspek.openTrustPanel';
            context.subscriptions.push(this.authorityItem, this.sandboxItem, this.tracedItem, this.policyItem);
        }
        // Re-apply/restore the halo + refresh the policy segment when settings change
        // (reversible toggle). Guarded so a stub host without the config event is safe.
        if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
            context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('glyphspek.halo.tintChrome')) {
                    void this.refreshHalo();
                }
                if (e.affectsConfiguration('glyphspek.policyPath')) {
                    const p = vscode.workspace
                        .getConfiguration('glyphspek')
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
     * The Agent View snapshot (glyphspek.runs.snapshot) reads this canonical verified
     * set so its 'verified' row uses the SAME fact the status bar + gutter + cards do.
     */
    isVerified(runId) {
        return this.model.isVerified(runId);
    }
    /**
     * The CANONICAL per-run assurance level — the SAME computation the status bar
     * renders for the focused run, evaluated for any runId. The Agent View per-run
     * detail (glyphspek.runs.detail) reads this so the Slice-4 halo reflects the EXACT
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
                'GlyphSpek assurance level for the focused run. Reflects the computed ' +
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
            void vscode.commands.executeCommand('setContext', 'glyphspek.authority', v.authority);
            void this.refreshHalo();
        }
    }
    /**
     * Apply or restore the OPT-IN chrome tint (glyphspek.halo.tintChrome). When ON,
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
            .getConfiguration('glyphspek')
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
        void vscode.commands.executeCommand('setContext', 'glyphspek.authority', undefined);
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
 * (the `glyphspekAuthority` message → confirmVerified, the amber→blue flip / tamper
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
 * acting→verified flip). The native workbench polls `glyphspek.runs.revision` and
 * re-fetches `glyphspek.runs.snapshot` only when this advances; a command cannot
 * PUSH to the workbench, so this cheap counter is the change signal for the pull
 * transport. Module-scoped so both the model subscription (in activate) and the
 * glyphspekAuthority handler (in TrustPanel) can advance it.
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
    return path.join(os.homedir(), '.glyphspek', 'verifier');
}
/**
 * Ensure ~/.glyphspek/verifier/{private.pem,public.pem} exists, generating a
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
 * webview: the OPERATOR-controlled `glyphspek.trustedVerifierKeys` value PLUS the
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
        .getConfiguration('glyphspek')
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
 * The webview "reduce motion" value derived from the GlyphSpek Halo Motion setting
 * (§14.3 accessibility). `glyphspek.workbench.haloMotion` is the explicit user toggle
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
        .getConfiguration('glyphspek')
        .get('workbench.haloMotion', true);
    return haloMotion === false;
}
/**
 * Read the GlyphSpek icon symbol sprite (media/glyphspek-icons.svg) for inline
 * injection into a webview body (docs/assets/ICON-USAGE.md). The sprite is a
 * static, first-party product asset — never untrusted input — so inlining it is
 * safe and lets same-document <use href="#gs-..."> resolve reliably across the
 * Chromium/webview contexts where external `./file.svg#id` references break and
 * lose `currentColor`. If the asset is ever missing, fall back to an empty string
 * so the panel still renders (icons simply won't show) rather than throwing.
 */
function readIconsSprite(mediaUri) {
    try {
        const iconsPath = vscode.Uri.joinPath(mediaUri, 'glyphspek-icons.svg');
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
     * webview). The Agent View evidence transport (glyphspek.runs.detail) uses this to
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
        const panel = vscode.window.createWebviewPanel('glyphspekTrustPanel', 'GlyphSpek Trust Panel', column, {
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
                // REDUCED-MOTION SETTING (§14.3). Post the current GlyphSpek Halo Motion
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
                void vscode.commands.executeCommand('glyphspek.loadRunBundle');
            }
            else if (msg.type === 'glyphspekPromote') {
                // BLENDED FRICTION SURFACE — "Promote to governed run" (Slice 1, §5.8/§6).
                // The panel's Promote button (shown only at the ask/inline friction tiers)
                // wires the workbench promotion gesture to the agentic-build command we
                // already ship. The button itself does NOT grant authority: this command's
                // OWN modal (confirmBuildAuthority in promoteChatToBuild) is the load-bearing
                // authority gate, and a third party cannot post this message (it can only
                // come from our own webview). We pass no intent so the command prompts for it.
                void vscode.commands.executeCommand('glyphspek.promoteChatToBuild');
            }
            else if (msg.type === 'glyphspekAuthority') {
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
            else if (msg.type === 'glyphspekTier') {
                // FRICTION-TIER PUBLISH (Blended Workbench Phase 1, §A). The panel's
                // Authority Ladder is a VIEW control; the webview posts the effective
                // friction tier (ask | inline | governed | sensitive | sovereign) here so
                // the FORK chrome can react to it — e.g. recede the center editor at Ask
                // (glyphspekTierChrome). We mirror it to the `glyphspek.tier` context-key,
                // exactly as the authority context-key is plumbed.
                //
                // ORTHOGONAL + VIEW-ONLY: this is the FRICTION axis only. It carries NO
                // assurance, NEVER touches `glyphspek.authority` (the halo), and grants
                // NOTHING — receding the editor REDUCES perceived authority, it adds no
                // friction and confers no trust. The promote modal (glyphspekPromote)
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
                // come from our own webview (the operator clicked a GlyphSpek Trust Panel
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
                // The Agent View polls glyphspek.runs.revision and only re-fetches snapshot +
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
     * View detail transport (glyphspek.runs.detail) reads it to project the run's
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
            void vscode.window.showInformationMessage(`GlyphSpek: review decision "${decision}" recorded for run ${runId} (no retained review to act on).`);
            return;
        }
        const { review, preview, cwd } = entry;
        const plan = (0, agenticBuildPromotion_1.planDecisionOutcome)(decision, review);
        // A preview/fixture (or a review with no real cwd) has no real working tree to act
        // on — record the outcome honestly without touching disk.
        if (preview || !cwd) {
            void vscode.window.showInformationMessage(`GlyphSpek: ${plan.traceMarker} recorded for ${preview ? 'PREVIEW ' : ''}run ${runId}. ` +
                `${plan.summary}${preview ? ' (preview — no real changes to apply or revert.)' : ''}`);
            return;
        }
        if (decision === 'accepted') {
            // Keep the changes (already in the working tree). OFFER (do not force) to stage.
            const STAGE = 'Stage Changes';
            const choice = await vscode.window.showInformationMessage(`GlyphSpek: accepted run ${runId} — the agent's changes are kept (already in your ` +
                'working tree). human_accepted recorded.', STAGE);
            if (choice === STAGE) {
                const staged = (0, agenticBuildPromotion_1.stageChangedFiles)(cwd, review.changedFiles);
                if (!staged.ok) {
                    void vscode.window.showWarningMessage(`GlyphSpek: could not stage some files — ${staged.message}`);
                }
            }
            return;
        }
        if (decision === 'changes-requested') {
            // Keep the changes + capture the request. A follow-up build is a later nicety.
            void vscode.window.showInformationMessage(`GlyphSpek: ${plan.traceMarker} recorded for run ${runId}. ${plan.summary}`);
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
            void vscode.window.showWarningMessage(`GlyphSpek: ${cwd} is not a git repository, so the agent's changes cannot be ` +
                `auto-reverted. human_rejected recorded. Revert these ${n} file(s) manually:\n${list}`);
            return;
        }
        const failed = result.files.filter((f) => !f.ok);
        if (failed.length === 0) {
            void vscode.window.showInformationMessage(`GlyphSpek: rejected run ${runId} — reverted the agent's changes to ${n} file(s). ` +
                'human_rejected recorded.');
        }
        else {
            const list = failed.map((f) => `  - ${f.path}: ${f.error ?? 'failed'}`).join('\n');
            void vscode.window.showWarningMessage(`GlyphSpek: reverted ${n - failed.length}/${n} file(s); ${failed.length} could not be ` +
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
                void vscode.window.showErrorMessage(`GlyphSpek: ${name} is ${formatBytes(size)} which exceeds the ` +
                    `${formatBytes(MAX_BUNDLE_FILE_BYTES)} per-file limit. Bundle load aborted.`);
                return;
            }
            // Cap the total bundle size across files, so the single webview message
            // payload stays bounded.
            if (totalBytes + size > MAX_BUNDLE_TOTAL_BYTES) {
                void vscode.window.showErrorMessage(`GlyphSpek: run bundle in ${dir} exceeds the ` +
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
            void vscode.window.showErrorMessage(`GlyphSpek: no run-bundle files found in ${dir}. Expected at least one of: ${BUNDLE_FILE_NAMES.join(', ')}.`);
            return;
        }
        // trace.jsonl or verdict.json is required to render anything meaningful.
        const hasTraceOrVerdict = files.some((f) => f.name === 'trace.jsonl' || f.name === 'verdict.json');
        if (!hasTraceOrVerdict) {
            void vscode.window.showErrorMessage(`GlyphSpek: ${dir} has no trace.jsonl or verdict.json — nothing to verify.`);
            return;
        }
        if (missing.length && missing.includes('verifier-public-key.pem')) {
            void vscode.window.showWarningMessage('GlyphSpek: no verifier-public-key.pem in this bundle — the verdict cannot be verified and will show as UNTRUSTED.');
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
     * echoing `glyphspekTier` back (see live.js `setTier` receiver), so there is no loop.
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
        // NOTE: we deliberately do NOT clear the `glyphspek.tier` context-key here. Since
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
        // GlyphSpek icon system (docs/assets/ICON-USAGE.md). External SVG <use href>
        // is unreliable in VS Code webviews, so we INLINE the symbol sprite into the
        // body and reference it with same-document <use href="#gs-...">. The sprite is
        // static product asset markup (no untrusted input), read from the extension's
        // own media dir; CSS hides it (.gs-icons / first-child aria-hidden svg).
        const iconsSprite = readIconsSprite(mediaUri);
        // Out-of-band trust-root seam (sweep-05 Critical). Resolve the operator's
        // trusted verifier public keys and inject them as a global the webview reads
        // BEFORE app.js loads. The set is the `glyphspek.trustedVerifierKeys` setting
        // PLUS the extension-managed keystore public key (~/.glyphspek/verifier/
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
        const trustedKeysScript = `<script nonce="${nonce}">window.GLYPHSPEK_TRUSTED_VERIFIER_KEYS = ${(0, inlineScript_1.escapeForInlineScript)(trusted)};</script>`;
        // CANONICAL RunTrust SET (sweep-25 #1). Inject the bridgeProtocol RUN_TRUSTS
        // list — the SAME constant the host's validateRunEvent uses — as a nonce-guarded
        // global so the webview's run-event gate (media/live.js) validates
        // run_opened.trust against the canonical five-value vocabulary instead of a
        // hand-kept allowlist that drifted and dropped governed-unsandboxed /
        // sandboxed-soft-egress runs. escapeForInlineScript (not bare JSON.stringify)
        // keeps the inline <script> un-breakable, matching the trusted-keys seam.
        const runTrustsScript = `<script nonce="${nonce}">window.GLYPHSPEK_RUN_TRUSTS = ${(0, inlineScript_1.escapeForInlineScript)(bridgeProtocol_1.RUN_TRUSTS)};</script>`;
        // REDUCED-MOTION SETTING (§14.3). Inject the GlyphSpek Halo Motion toggle (the
        // inverse of glyphspek.workbench.haloMotion) as a nonce-guarded global BEFORE
        // live.js runs, so a user who disabled motion sees NO deny-pulse / trust cross-
        // fade on first paint (no flash). live.js seeds from this global on boot and
        // stays live via the `reduceMotion` message posted on config change below. A
        // boolean cannot break the inline <script>, but we route it through the same
        // escapeForInlineScript seam as the other injected globals for consistency.
        const reduceMotionScript = `<script nonce="${nonce}">window.GLYPHSPEK_REDUCE_MOTION = ${(0, inlineScript_1.escapeForInlineScript)(resolveReduceMotion())};</script>`;
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
            .replace(/\{\{reduceMotionScript\}\}/g, reduceMotionScript);
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
            void vscode.window.showWarningMessage(`GlyphSpek: ignored a malformed run/event (problems: ${validation.problems.join(', ')}).`);
            return;
        }
        if (!this.ready) {
            this.pendingRunEvents.push(validation.event);
            return;
        }
        void this.panel.webview.postMessage({ type: 'runEvent', event: validation.event });
    }
    /**
     * Post the current GlyphSpek Halo Motion setting to the webview (§14.3). Called on
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
 * GOVERNED-RUN COMMAND (glyphspek.runGovernedTask).
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
 * repository could set glyphspek.supervisorPath via .vscode/settings.json,
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
        .getConfiguration('glyphspek')
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
 * Resolve the runs/worktree base passed to the supervisor as --runs-base. Uses
 * the machine-scoped glyphspek.runOutputRoot setting when set, else a stable
 * $HOME-based default (~/.glyphspek/runs). The bundled supervisor cwds here and
 * writes all run state under it, so it never writes under the install dir.
 */
function resolveRunsBase() {
    const configured = vscode.workspace
        .getConfiguration('glyphspek')
        .get('runOutputRoot', '');
    const root = configured && configured.trim() ? configured.trim() : '';
    return root || path.join(os.homedir(), '.glyphspek', 'runs');
}
/** Configured run mode, defaulting to the safe verify-only path. */
function resolveSupervisorMode() {
    const mode = vscode.workspace
        .getConfiguration('glyphspek')
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
 * supervisorPath is empty, so a relative '.glyphspek-fixtures/...' would resolve
 * against the host cwd, not a real policy. The capstone fixture is only offered
 * as the picker DEFAULT when a real dev supervisorPath is set AND the fixture
 * actually exists (see resolveDefaultPolicyCandidate); otherwise the picker has
 * no default and cancel => undefined => clean abort.
 */
async function resolvePolicyPath(supervisorPath) {
    const inspect = vscode.workspace
        .getConfiguration('glyphspek')
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
            ? 'Select the GlyphSpek policy file (defaults to the bundled capstone policy)'
            : 'Select the GlyphSpek policy file',
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
 * (extension/media/). Used by the terminal path when no `glyphspek.policyPath` is
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
 * `glyphspek.policyPath` scope is configured (classified exactly as
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
        .getConfiguration('glyphspek')
        .inspect('policyPath');
    const classified = (0, configScope_1.classifyPolicyPath)(inspect);
    if (classified.scope !== 'none') {
        const fp = (0, policyHash_1.policyFileSha256)(classified.path);
        if (!fp.sha256) {
            void vscode.window.showErrorMessage(`GlyphSpek: the configured glyphspek.policyPath (${classified.path}) could not be ` +
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
        void vscode.window.showErrorMessage(`GlyphSpek: the bundled default governed-terminal policy could not be read ` +
            `(${defaultPath}: ${fp.note}); cannot open a governed terminal.`);
        return undefined;
    }
    return { path: defaultPath, policyHash: fp.sha256, provenance: 'shipped-default', scope: 'default' };
}
/**
 * Resolve the output directory for this run's bundle under the configured
 * run-output root (default: <workspace>/.glyphspek/runs), timestamped per run.
 * Falls back to the OS temp dir when there is no workspace folder.
 */
function resolveOutputDir(repo) {
    const configuredRoot = vscode.workspace
        .getConfiguration('glyphspek')
        .get('runOutputRoot', '');
    let root = configuredRoot && configuredRoot.trim() ? configuredRoot.trim() : '';
    if (!root) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        // Prefer a workspace-local root; else the repo itself; else temp.
        root = path.join(ws ?? repo, '.glyphspek', 'runs');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(root, stamp);
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
        const panel = vscode.window.createWebviewPanel('glyphspekChat', 'GlyphSpek Chat', column, {
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
                status: 'no active run — open a governed run first (GlyphSpek: Run Governed Task).',
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
        const choice = await vscode.window.showInformationMessage(`GlyphSpek: the model proposed an edit to ${ref}. Review and apply?`, { modal: true }, 'Show diff', 'Apply edit');
        if (choice === 'Show diff') {
            // Open a read-only diff between the current selection and the proposal.
            const left = vscode.Uri.parse(`untitled:${ref} (current)`);
            const right = vscode.Uri.parse(`untitled:${ref} (proposed)`);
            const leftDoc = await vscode.workspace.openTextDocument({ content: before });
            const rightDoc = await vscode.workspace.openTextDocument({ content: after });
            void left;
            void right;
            await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, `GlyphSpek edit · ${ref}`);
            return;
        }
        if (choice === 'Apply edit') {
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                await editor.edit((b) => b.replace(editor.selection, after));
            }
            else {
                void vscode.window.showWarningMessage('GlyphSpek: no active selection to apply the edit to — edit not applied.');
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
        // Inline the GlyphSpek icon sprite (see readIconsSprite / ICON-USAGE.md).
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
        const panel = vscode.window.createWebviewPanel('glyphspekNativeChat', 'GlyphSpek Chat', column, {
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
    // ACTIVITY-BAR "Governed Runs" view (first GlyphSpek sidebar surface). A real
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
    //   glyphspek.runs.snapshot  → the AgentRunSnapshot projection (newest-first runs
    //                              + the per-run webview-verified fact), built from the
    //                              SAME GovernedRunsModel the tree/cards render. Pure
    //                              projection (agentRunSnapshot.ts) — never invents a row.
    //   glyphspek.runs.revision  → a monotonic counter bumped on every run-set change
    //                              (and on a webview signature confirmation). The
    //                              workbench polls this cheap counter and only re-fetches
    //                              the full snapshot when it advances — a pull transport
    //                              that matches VS Code's command seam (a command cannot
    //                              PUSH to the workbench) without busy work.
    // The verified fact is read from the canonical RunStatusController set, so the
    // snapshot's 'verified' eligibility uses the SAME signature gate the status bar /
    // gutter / cards use — the workbench mirror re-derives the card state from it.
    context.subscriptions.push(runsModel.onDidChange(() => bumpAgentRunsRevision()));
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.runs.snapshot', () => (0, agentRunSnapshot_1.projectAgentRuns)(runsModel.list(), (runId) => getRunStatusController().isVerified(runId))));
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.runs.revision', () => agentRunsRevision));
    // AGENT VIEW per-run EVIDENCE transport (Slice 2 Part A, design §1/§3). The native
    // Evidence pane reaches ONE run's evidence through a third read-only command:
    //   glyphspek.runs.detail(runId) → the AgentRunDetail projection (rev 2: intent +
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
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.runs.detail', (runId) => {
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
    // STATUS-BAR SEGMENTS + HALO FALLBACK + the glyphspek.authority context-key
    // (Slice 2, §1.12 / §1.1 / §2.2). The controller creates the four status-bar
    // items, sets the context-key the future fork ring reads, and (opt-in behind
    // glyphspek.halo.tintChrome, default OFF) reversibly tints chrome edges. Fed by
    // the SAME run/event stream via TrustPanel.postRunEvent → controller.notify.
    const statusController = getRunStatusController();
    statusController.attach(context);
    context.subscriptions.push({ dispose: () => void statusController.dispose() });
    // PROVENANCE GUTTER (Slice 3, §5.5/§8). The editor-area trust-origin decorations:
    // per-region amber (claimed) / blue (verified) / violet (soft) / slate (human)
    // gutter bars + minimap stripes + whole-line tint over the focused run's changed
    // files. Created here (it needs the extensionUri for the colored-bar icon assets),
    // fed the SAME run/event stream (TrustPanel.postRunEvent → notify), the SAME webview
    // signature-verified confirmation (glyphspekAuthority → confirmVerified — the
    // amber→blue flip / tamper revert), and the agentic build's git diff (the honest
    // hunk source). attach() wires the active-editor change listener and pushes the
    // controller's dispose (which drops the four decoration types) into subscriptions.
    provenanceGutterController = new provenanceGutter_1.ProvenanceGutterController(context.extensionUri);
    provenanceGutterController.attach(context);
    context.subscriptions.push(vscode.window.createTreeView('glyphspek.runs', {
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
    const surfaceOutput = vscode.window.createOutputChannel('GlyphSpek');
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
    // amber→blue trust cross-fades in step with the user's GlyphSpek Halo Motion toggle
    // (glyphspek.workbench.haloMotion): the panel injects the setting as a global on
    // creation and posts it on `ready`; here we POST it again whenever the setting
    // changes so a live toggle takes effect without reopening the panel. Registered as a
    // disposable (no leak) and guarded so a stub host without the config event is safe.
    // View-only — it changes nothing about trust, only whether those two animations play.
    if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('glyphspek.workbench.haloMotion')) {
                TrustPanel.notifyReduceMotion();
            }
        }));
    }
    // ACTIVITY-BAR "Chat" view (the SIDEBAR "chat that's a terminal"). A webview-view
    // hosting an xterm.js terminal connected to a real PTY running the user's
    // interactive `claude`, governed. Reuses the entire governed stack (bridge session,
    // forced-proxy + secret-firewall env, run/event projection into the Trust Panel +
    // Governed Runs view). The PTY backend is node-pty (proven in spikes/p0-governed-pty).
    const chatViewOutput = vscode.window.createOutputChannel('GlyphSpek Chat');
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
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.runs.newGovernedTerminal', () => vscode.commands.executeCommand('glyphspek.openGovernedTerminal')));
    // Title-bar action: Open Trust Panel. Surfaces the existing Trust Panel webview
    // from the sidebar (the lower-risk path: the panel stays a WebviewPanel; the
    // sidebar contributes a prominent action to reveal it).
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.runs.openTrustPanel', () => {
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.openTrustPanel', () => {
        TrustPanel.createOrShow(context.extensionUri, gate);
    }));
    // SET FRICTION TIER (Blended Workbench PATCH-009). The CANONICAL friction control —
    // the native title-bar Authority Ladder (fork, glyphspekTitleLadder.ts) — invokes
    // this on a rung click. It (a) validates the tier, (b) routes through the SINGLE
    // writer (TierController) which sets the `glyphspek.tier` context-key the native
    // ladder + the editor-recede chrome read, and (c) syncs the Trust Panel webview
    // ladder if one is open. It does NOT force-open the panel.
    //
    // VIEW-ONLY (§6, §2.4 "tier is enforced authority, not a UI hint"): selecting a rung
    // changes friction / which evidence is visible. It does NOT grant authority and NEVER
    // touches the assurance axis (`glyphspek.authority` / the halo). The promote modal
    // remains the only authority door. An unknown tier is rejected (fail closed to no-op).
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.setTier', (tier) => {
        if (typeof tier === 'string' && isFrictionTier(tier)) {
            getTierController().set(tier, { syncWebview: true });
        }
    }));
    // Inline edit (Cmd-K-style, DEMO). Takes the active editor selection + an
    // instruction and previews it through the stub gateway. This is still the demo
    // preview surface (not yet brokered or diff-gated); only the primary Chat command
    // was repurposed onto the governed terminal.
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.inlineEdit', async () => {
        const sel = activeEditorSelection();
        if (!sel) {
            void vscode.window.showWarningMessage('GlyphSpek: open a file (and optionally select a region) to use inline edit.');
            return;
        }
        const instruction = await vscode.window.showInputBox({
            prompt: `GlyphSpek inline edit — instruction for ${sel.ref}`,
            placeHolder: 'e.g. "add input validation" — demo preview, not yet brokered or diff-gated',
        });
        if (instruction === undefined)
            return; // cancelled
        const panel = ChatPanel.createOrShow(context.extensionUri, stubModelGateway());
        panel.reveal();
        panel.setRunId(`inline-${Date.now().toString(36)}`);
        panel.seedInlineEdit(sel.ref, sel.text, instruction);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.loadRunBundle', async () => {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Load run bundle',
            title: 'Select a GlyphSpek run bundle directory (trace.jsonl + verdict.json + verifier-public-key.pem)',
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
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.demoLiveRun', async (scenarioArg) => {
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
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.previewAgenticBuildReview', () => {
        const panel = TrustPanel.createOrShow(context.extensionUri, gate);
        panel.reveal();
        panel.postAgenticBuildReview((0, agenticBuildReview_1.previewAgenticBuildReviewFixture)(), true);
    }));
    // GOVERNED AGENTIC BUILD — THE CHAT→ACTOR PROMOTION (Phase C-UI capstone).
    // "GlyphSpek: Build This (Governed Run)". This is the EXPLICIT authority boundary
    // (docs/developer-trust-model.md): chat stays Ask (lightweight); promoting a task into
    // a governed agent run that EDITS FILES and RUNS COMMANDS is where friction belongs. The
    // command resolves the workspace folder as cwd (honest error if none), takes the build
    // intent (an arg from the chat surface, or a quick-input prompt), shows an UP-FRONT
    // authority modal naming the boundary honestly (governed-unsandboxed — traced, NOT
    // sandboxed), and ONLY on explicit confirm starts the build with approved:true. A decline
    // does nothing. As build/event arrives, progress shows in an output channel; the terminal
    // result renders the diff + verdict in the Trust Panel for the second gate (Accept/Reject).
    const buildOutput = vscode.window.createOutputChannel('GlyphSpek Governed Build');
    context.subscriptions.push(buildOutput);
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.promoteChatToBuild', (intentArg) => promoteChatToBuild(context, gate, buildOutput, intentArg)));
    // Output channel for the supervisor's human-readable progress (stderr). One
    // per session; disposed with the extension.
    const supervisorOutput = vscode.window.createOutputChannel('GlyphSpek Governed Run');
    context.subscriptions.push(supervisorOutput);
    // GOVERNED TERMINAL (M7). Opens a REAL VS Code terminal whose egress is FORCED
    // through the supervisor-owned metadata-only proxy and whose env is sanitized of
    // ambient host secrets/capability handles, then streams the session's governed
    // model-call + egress-decision metadata LIVE into the Trust Panel. This surface is
    // honestly GOVERNED (egress proxied, trace signed) but UNSANDBOXED — the
    // `governed-unsandboxed` posture — so it can NEVER mint a product-trusted run and
    // is NOT routed through the trusted-run gesture gate below (there is no product-
    // trust lever to protect). The command opens the governed terminal directly.
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.openGovernedTerminal', () => openGovernedTerminal(context, supervisorOutput)));
    // GlyphSpek CHAT (M7). Chat = a governed terminal running INTERACTIVE Claude Code.
    // The interactive TUI IS the chat: it runs on the user's OWN subscription (auth from
    // ~/.claude; GlyphSpek injects no credential), governed (egress via the supervisor's
    // metadata-only proxy), and traced (a governed-unsandboxed run in the Trust Panel +
    // Governed Runs sidebar). This reuses the EXACT openGovernedTerminal machinery and
    // auto-launches the detected interactive agent CLI. It NO LONGER opens the stub
    // ChatPanel/stubModelGateway — that fake gateway is retired as the chat path. The
    // API-key model broker is a separate, secondary path (parked).
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.openChat', () => openGovernedChat(context, supervisorOutput)));
    // GlyphSpek NATIVE CHAT (M7). The "normal chat window": a webview where the user
    // types a message and sees the assistant reply, GOVERNED through our gateway —
    // bridge chat/send → the GlyphSpek model gateway's CODEX backend on the user's own
    // ChatGPT subscription. This is a brokered, metadata-TRACED model call (governed,
    // UNSANDBOXED, never product-trusted); GlyphSpek injects no credential (Codex
    // authenticates from its own ~/.codex store). Distinct from glyphspek.openChat,
    // which runs interactive Claude Code in a governed terminal.
    const chatOutput = vscode.window.createOutputChannel('GlyphSpek Chat (Gateway)');
    context.subscriptions.push(chatOutput);
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.openNativeChat', () => {
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
    context.subscriptions.push((0, chatParticipant_1.registerGlyphSpekChatAgent)(buildNativeChatSessionFactory(context, chatOutput), chatOutput));
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
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.runGovernedTask', () => {
        offerTrustedRun('governed');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.bridgeSupervisedRun', () => {
        offerTrustedRun('bridge');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('glyphspek.startLiveRun', () => {
        offerTrustedRun('live');
    }));
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
        void vscode.window.showErrorMessage(`GlyphSpek: could not fingerprint the policy file (${policyFp.note}); cannot create a run.`);
        return undefined;
    }
    // Assemble the full §10.3 run request. Exactly one provenance anchor:
    // sourceCommit (git HEAD) when available, else worktreeBase (the repo root).
    const sourceCommit = resolveSourceCommit(repo);
    const runtimeProfile = vscode.workspace
        .getConfiguration('glyphspek')
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
            prompt: 'GlyphSpek — what should the governed agent build? (it WILL edit files + run commands)',
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
        void vscode.window.showWarningMessage(`GlyphSpek: ${preflight.reason}`);
        return;
    }
    const { cwd, prompt } = preflight;
    // (3) UP-FRONT AUTHORITY APPROVAL. This is the operator gesture that grants the build
    // authority — minted via the SAME first-party operator-gesture registry that gates a
    // product-trusted run, so a third-party `executeCommand('glyphspek.promoteChatToBuild')`
    // cannot satisfy the MODAL and thus cannot start a build. The modal names the boundary
    // honestly (governed-unsandboxed). Decline → do NOTHING (no build/start; approved is
    // never sent as anything but true).
    const granted = await (0, agenticBuildPromotion_1.confirmBuildAuthority)(cwd, (message, proceedLabel) => Promise.resolve(vscode.window.showWarningMessage(message, { modal: true }, proceedLabel)));
    if (!granted) {
        output.appendLine(`[host] governed build DECLINED at the authority gate for ${cwd} — nothing started.`);
        return;
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
    // Open + reveal the Trust Panel FIRST so it is ready to receive the review.
    const panel = TrustPanel.createOrShow(context.extensionUri, gate);
    panel.reveal();
    // (4) Start the build (approved:true) and stream progress honestly. Each state/command
    // becomes an output line + a brief status; the terminal result posts the review.
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: 'GlyphSpek: governed agentic build…',
    }, (progress) => (0, supervisorBridgeRunner_1.runAgenticBuild)({
        bridgeServerPath: resolveBundledBridgeServerPath(context),
        extensionVersion: resolveExtensionVersion(context),
        runsBase: resolveRunsBase(),
        prompt,
        cwd,
        approved: true,
        output,
        onBuildEvent: (event) => reportBuildProgress(event, output, progress),
    }));
    if (!result.started) {
        void vscode.window.showErrorMessage(`GlyphSpek: governed build not started — ${result.message}`);
        return;
    }
    if (result.review) {
        // Render the diff + commands + verdict in the Trust Panel for the SECOND gate. Pass
        // the REAL cwd so a Reject scopes its revert to this repo + the review's changedFiles.
        panel.postAgenticBuildReview(result.review, false, cwd);
        void vscode.window.showInformationMessage(`GlyphSpek: governed build ${result.runId ?? ''} complete — review the diff + verdict in the ` +
            'Trust Panel, then Accept or Reject.');
    }
    else {
        void vscode.window.showWarningMessage(`GlyphSpek: governed build ${result.runId ?? ''} ended without a review — ${result.message || 'no result event'}.`);
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
            'A trusted run can only be started by clicking a GlyphSpek Trust Panel button (a first-party ' +
            'webview gesture a third-party extension cannot forge).');
        void vscode.window.showErrorMessage('GlyphSpek: refused to start a trusted run — it must be initiated by clicking "Start run" ' +
            'inside the GlyphSpek Trust Panel (a first-party operator gesture).');
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
        void vscode.window.showErrorMessage(`GlyphSpek: bridge run not created — ${result.message}`);
        return;
    }
    // Reveal the Trust Panel for the (future) live feed and report the real run.
    const panel = TrustPanel.createOrShow(context.extensionUri, getWebviewGestureGate());
    panel.reveal();
    if (result.trust === 'trusted') {
        void vscode.window.showInformationMessage(`GlyphSpek: created a TRUSTED run (${result.runId}) via the spawned supervisor` +
            (result.supervisorVersion ? ` ${result.supervisorVersion}` : '') + '.');
    }
    else {
        void vscode.window.showWarningMessage(`GlyphSpek: created an ${result.trust.toUpperCase()} run (${result.runId ?? 'no id'}) — ${result.message}`);
    }
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
        title: 'GlyphSpek: live supervised run…',
    }, () => (0, supervisorBridgeRunner_1.startRunViaBridge)({
        bridgeServerPath: resolveBundledBridgeServerPath(context),
        extensionVersion: resolveExtensionVersion(context),
        runsBase: resolveRunsBase(),
        request,
        output,
        // The supervisor's streamed envelopes flow straight into the panel's
        // validated feed. postRunEvent fail-closes on a schema-version mismatch.
        onRunEvent: (raw) => panel.postRunEvent(raw),
    }));
    if (!result.connected) {
        void vscode.window.showErrorMessage(`GlyphSpek: live run not started — ${result.message}`);
        return;
    }
    if (!result.started) {
        void vscode.window.showWarningMessage(`GlyphSpek: run ${result.runId ?? '(no id)'} was created but did not stream — ${result.message}`);
        return;
    }
    const trustLabel = result.trust.toUpperCase();
    const finalState = result.finalState ? ` (${result.finalState})` : '';
    if (result.trust === 'trusted') {
        void vscode.window.showInformationMessage(`GlyphSpek: streamed a LIVE TRUSTED run (${result.runId})${finalState} into the Trust Panel` +
            (result.supervisorVersion ? ` — supervisor ${result.supervisorVersion}` : '') + '.');
    }
    else {
        void vscode.window.showWarningMessage(`GlyphSpek: streamed a LIVE ${trustLabel} run (${result.runId})${finalState} into the Trust Panel — ${result.message}`);
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
 * glyphspek.policyPath when set, else the DEFAULT policy SHIPPED with the extension.
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
    // policy: NON-PROMPTING. Configured glyphspek.policyPath, else the shipped default.
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
        output.appendLine(`[host] governed terminal policy: CONFIGURED glyphspek.policyPath (${resolvedPolicy.scope}) — ` +
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
 * TUI IS the chat — on the user's OWN subscription (auth from ~/.claude; GlyphSpek
 * injects NO credential), governed (egress via the proxy, metadata-only), and traced
 * (a governed-unsandboxed run in the Trust Panel + Governed Runs sidebar). Either way
 * the trust posture is identical: governed + traced but UNSANDBOXED, never
 * product-trusted.
 */
async function openGovernedTerminalSurface(context, output, surface, detected) {
    output.show(true);
    const actorType = detected?.agent === 'claude'
        ? 'claude-code-cli'
        : detected?.agent === 'codex'
            ? 'codex-cli'
            : 'native';
    const request = assembleGovernedTerminalRequest(context, output, actorType);
    if (!request)
        return;
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
            void vscode.window.showWarningMessage(`GlyphSpek Chat: did NOT auto-run your '${detected.agent}' — it resolved to ` +
                `${chatLaunch.launchPath}, which is INSIDE your workspace. A workspace-local CLI ` +
                'could be a swapped/planted binary, so GlyphSpek will not launch it for you. ' +
                'The terminal is open and governed; run a trusted agent in it yourself if you intend to.');
            return;
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
    const progressTitle = surface === 'chat' ? 'GlyphSpek: opening governed chat…' : 'GlyphSpek: opening governed terminal…';
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
        onRunEvent: (raw) => panel.postRunEvent(raw),
    }));
    const surfaceLabel = surface === 'chat' ? 'governed chat' : 'governed terminal';
    if (!start.started || !start.session || !start.proxyUrl || !start.runId) {
        void vscode.window.showErrorMessage(`GlyphSpek: could not open a ${surfaceLabel} — ${start.message}`);
        return;
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
    const terminal = vscode.window.createTerminal({
        name: surface === 'chat' ? 'GlyphSpek Chat' : 'GlyphSpek Governed Terminal',
        env: terminalEnv,
        strictEnv,
        isTransient: true,
    });
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
            void vscode.window.showWarningMessage(`GlyphSpek: ${surfaceLabel} ${session.runId} closed but did not finalize — ${stop.message}`);
            return;
        }
        const degraded = stop.verdict.assurance === 'degraded';
        const verdictLabel = `${stop.verdict.overallVerdict.toUpperCase()} (${degraded ? 'DEGRADED — lower assurance, not fully trusted' : 'assurance: full'})`;
        if (degraded) {
            void vscode.window.showWarningMessage(`GlyphSpek: ${surfaceLabel} ${session.runId} finalized ${verdictLabel}. ` +
                'This session was governed + traced but UNSANDBOXED (metadata-only) — never product-trusted.');
        }
        else {
            void vscode.window.showInformationMessage(`GlyphSpek: ${surfaceLabel} ${session.runId} finalized — verdict ${verdictLabel}. ` +
                'Governed + traced, metadata-only, UNSANDBOXED — not product-trusted.');
        }
    });
    context.subscriptions.push(closeSub);
    terminal.show();
    // Honest, one-line banner echoed in the terminal so the posture is visible IN the
    // surface (not only in a transient notification). GlyphSpek holds no credential.
    const banner = surface === 'chat'
        ? "echo 'GlyphSpek Chat — your Claude Code on your subscription, governed (metadata-only egress) + traced. GlyphSpek holds no key.'"
        : "echo 'GlyphSpek Governed Terminal — egress governed (metadata-only) + traced. UNSANDBOXED; never product-trusted. GlyphSpek holds no key.'";
    terminal.sendText(banner, true);
    if (surface === 'chat') {
        // CHAT = a governed terminal running INTERACTIVE Claude Code. The interactive TUI
        // IS the chat: it stays on the user's SUBSCRIPTION (interactive `claude` is exempt
        // from the 2026-06-15 headless `claude -p`/Agent-SDK metering carve-out), so it is
        // cheap + durable. AUTO-RUN it — the whole point of the chat surface is that the
        // agent launches for you.
        //
        // BINARY-SWAP GUARD (sweep-27 High). We do NOT send the BARE name `detected.agent`:
        // the governed terminal PRESERVES PATH (for HOME-based auth), so a bare name is
        // RE-RESOLVED by the shell at exec time — a workspace-local `./claude` or a
        // PATH-injected shim could swap the binary between the modal confirm and the
        // launch. Instead we send the CANONICALIZED ABSOLUTE path detection already
        // resolved, shell-QUOTED, so the EXACT inode that was detected/confirmed is the
        // one that runs regardless of any PATH mutation. AND we REFUSE to auto-run a
        // canonical path that resolves UNDER a workspace folder (the red flag for a
        // repo-supplied shim) — instead we warn with the full path and leave the agent
        // for the operator to launch by hand inside the already-governed terminal.
        if (detected && chatLaunch) {
            // chatLaunch was resolved + trust-checked + the binary identity captured BEFORE
            // session start (above); a workspace-local resolution already returned there, so
            // here it is trusted for auto-run. We REUSE that exact resolution so the bytes we
            // launch match the evidence threaded into run_opened + the trace.
            const launch = chatLaunch;
            // WINDOWS GUARD (sweep-28 Medium). launch.launchCommand uses POSIX single-quote
            // escaping, which is INVALID for PowerShell/cmd (the detector finds claude.cmd/
            // .exe/.bat on win32). Until a platform/shell-aware (or PTY) launch exists, do
            // NOT auto-send on win32: PRE-TYPE the canonical path (no newline) and tell the
            // operator chat auto-run is macOS/Linux for now — they press Enter themselves.
            if (process.platform === 'win32') {
                terminal.sendText(launch.launchPath, false);
                void vscode.window.showInformationMessage(`GlyphSpek Chat: pre-typed ${launch.launchPath} (your '${detected.agent}') — press Enter to run it. ` +
                    'Chat auto-run is macOS/Linux for now (Windows shell quoting differs); your egress is governed ' +
                    '(metadata-only), streaming LIVE into the Trust Panel, UNSANDBOXED and never product-trusted.');
                return;
            }
            // Send the EXACT canonical absolute path, shell-quoted, + Enter (auto-run).
            terminal.sendText(launch.launchCommand, true);
            void vscode.window.showInformationMessage(`GlyphSpek Chat: launched ${launch.launchPath} (your interactive '${detected.agent}') on YOUR ` +
                'subscription. Egress is governed (metadata-only) and streaming LIVE into the Trust Panel; this ' +
                'session is UNSANDBOXED and never product-trusted. GlyphSpek holds no credential.');
        }
        // The no-CLI case never reaches here (the command shows the honest message and only
        // optionally opens this terminal; see openGovernedChat).
        return;
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
        void vscode.window.showInformationMessage(`GlyphSpek: governed terminal ready. Your '${detected.agent}' CLI is pre-typed — press Enter to run it. ` +
            'Its egress is governed (metadata-only) and streaming LIVE into the Trust Panel; this session is ' +
            'UNSANDBOXED and never product-trusted.');
    }
    else {
        void vscode.window.showInformationMessage('GlyphSpek: governed terminal ready. Any command you run here has its egress governed (metadata-only) ' +
            'and streamed LIVE into the Trust Panel. This session is UNSANDBOXED and never product-trusted.');
    }
}
/**
 * Open the in-IDE Governed Terminal: the user-driven surface. Detects an agent CLI
 * (to tag the actor identity + pre-type the command) and delegates to the shared
 * governed-terminal core. The detected CLI is PRE-TYPED for the operator to run —
 * never force-run.
 */
async function openGovernedTerminal(context, output) {
    await openGovernedTerminalSurface(context, output, 'terminal', (0, agentCli_1.detectAgentCli)());
}
/**
 * Open GlyphSpek CHAT = a governed terminal running INTERACTIVE Claude Code.
 *
 * "Chat can be a terminal." The interactive Claude Code TUI IS a chat. Interactive
 * `claude` stays on the user's SUBSCRIPTION (it is exempt from the 2026-06-15 headless
 * `claude -p`/Agent-SDK metering carve-out), so it is cheap + durable. So GlyphSpek
 * Chat is NOT a separate webview or a headless-JSON stream — it is the GOVERNED
 * TERMINAL with the user's interactive agent AUTO-LAUNCHED. This reuses the entire
 * governed-terminal stack (egress proxy, sanitized env with HOME preserved for the
 * ~/.claude subscription auth, run/event projection into the Trust Panel + sidebar).
 *
 * If NO agent CLI is detected we do NOT open a fake chat: we show an HONEST message
 * (install Claude Code / `claude login`, or install Codex) and still open the governed
 * terminal so the operator can install/login inside it. GlyphSpek holds NO credential.
 */
async function openGovernedChat(context, output) {
    const detected = (0, agentCli_1.detectAgentCli)();
    if (!detected) {
        // HONEST no-CLI path: never open a fake chat. Tell the truth and link the docs.
        const INSTALL = 'How to install';
        const choice = await vscode.window.showWarningMessage('GlyphSpek Chat runs your Claude Code in a governed terminal. Install Claude Code and run ' +
            '`claude login` to chat on your subscription (or install Codex).', INSTALL);
        if (choice === INSTALL) {
            void vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/en/docs/claude-code/setup'));
        }
        // Still open the governed terminal (no auto-run) so they can install/login IN it
        // with egress already governed. detected is undefined → no agent is auto-run.
        await openGovernedTerminalSurface(context, output, 'chat', undefined);
        return;
    }
    // FIRST-PARTY LAUNCH GESTURE (sweep-26 High). `glyphspek.openChat` is a globally
    // invokable command and the chat surface AUTO-RUNS a user-authenticated agent CLI
    // (claude/codex from the user's own ~/.claude/~/.codex auth). A globally invokable
    // command must NOT silently launch an actor process: require a fresh, explicit
    // operator confirmation before auto-running. A third-party `executeCommand(
    // 'glyphspek.openChat')` cannot satisfy this MODAL dialog, so it defeats silent
    // agent launch from another extension. This gates only the auto-run — the session
    // is still governed + traced (governed-unsandboxed), never product-trusted. The
    // user-driven Governed Terminal stays one-step (it only PRE-TYPES, never auto-runs,
    // so the operator's Enter is itself the gesture).
    // Resolve the EXACT binary the chat would auto-run NOW (canonicalized absolute path,
    // workspace-local trust decision) so the modal names what will run and so a
    // workspace-local resolution is caught BEFORE the operator even confirms (sweep-27).
    const launch = (0, agentLaunch_1.resolveAgentLaunch)(detected.path, workspaceFolderPaths());
    if (!launch.trustedForAutoRun) {
        // The detected CLI resolves to a workspace-local path — the red flag for a planted
        // shim. Do NOT offer a one-click auto-run launch. Tell the operator the full path
        // honestly and refuse to auto-run; openGovernedTerminalSurface re-checks and would
        // also refuse, but we stop here so no misleading "Open Chat" confirm is shown.
        void vscode.window.showWarningMessage(`GlyphSpek Chat will NOT auto-run your '${detected.agent}': it resolves to ` +
            `${launch.launchPath}, which is INSIDE your workspace. A workspace-local CLI could be a ` +
            'swapped/planted binary. Open a Governed Terminal and run a trusted agent yourself if you intend to.');
        return;
    }
    const OPEN_CHAT = 'Open Chat';
    const confirm = await vscode.window.showInformationMessage(`Launch GlyphSpek Chat? This opens a governed terminal and runs ${launch.launchPath} ` +
        `(your '${detected.agent}') on YOUR subscription — governed (metadata-only egress) + traced, ` +
        'UNSANDBOXED; GlyphSpek holds no key.', { modal: true }, OPEN_CHAT);
    if (confirm !== OPEN_CHAT) {
        // Operator declined the launch gesture — nothing is opened or auto-run.
        return;
    }
    await openGovernedTerminalSurface(context, output, 'chat', detected);
}
/**
 * Build the production {@link NativeChatSessionFactory} for the native chat window:
 * it opens a {@link ChatSession} against the bundled, hash-pinned bridge-server, which
 * drives chat/send through the GlyphSpek model gateway's CODEX backend. No credential
 * is handled here; the supervisor holds none either (Codex authenticates from its own
 * store). A test injects a fake factory instead.
 */
function buildNativeChatSessionFactory(context, output) {
    return {
        open: () => (0, supervisorBridgeRunner_1.openChatSession)({
            bridgeServerPath: resolveBundledBridgeServerPath(context),
            extensionVersion: resolveExtensionVersion(context),
            runsBase: resolveRunsBase(),
            output,
        }),
    };
}
/* ================================================================== *
 * CHAT TERMINAL VIEW WIRING (M7 — the SIDEBAR "chat that's a terminal").
 *
 * The activity-bar `glyphspek.chat` webview-view hosts an xterm.js terminal connected
 * to a real PTY running the user's interactive `claude`, governed. Unlike
 * `glyphspek.openChat` (which opens a VS Code terminal), this surface lives IN the
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
 * glyphspek.supervisorPath is NO LONGER a node-pty candidate (a native module must not
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
        devSpikesRoot: (0, nodePtyBaseDirs_1.devSpikesRootFor)(context.extensionMode, [vscode.ExtensionMode.Development, vscode.ExtensionMode.Test], process.env.GLYPHSPEK_DEV_SPIKES_ROOT),
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
            // FALL BACK to the user's LOGIN shell — when GlyphSpek.app is launched from the
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
                void vscode.window.showWarningMessage(`GlyphSpek Chat will NOT auto-run your '${detected.agent}': it resolves to ` +
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
                onRunEvent: (raw) => panel.postRunEvent(raw),
            });
            if (!start.started || !start.session || !start.proxyUrl || !start.runId) {
                void vscode.window.showErrorMessage(`GlyphSpek Chat: could not start a governed session — ${start.message}`);
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
        // DEV OVERRIDE detection. When glyphspek.supervisorPath is set (user/global
        // only), the operator has explicitly opted into running the UN-BUNDLED,
        // UN-PINNED supervisor from the spikes tree. Otherwise (the default) we run
        // the BUNDLED, hash-pinned supervisor shipped in the .vsix.
        const { path: devSupervisorPath, fromWorkspaceIgnored } = resolveSupervisorPath();
        const isDevOverride = Boolean(devSupervisorPath);
        // A workspace/folder value was supplied and DELIBERATELY ignored — surface
        // it so a repo's silently-overridden setting is visible to the operator
        // (Critical #2: a repo must not redirect the supervisor exec path).
        if (fromWorkspaceIgnored) {
            void vscode.window.showWarningMessage('GlyphSpek: a workspace setting tried to set "glyphspek.supervisorPath" and was ignored ' +
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
                void vscode.window.showErrorMessage(`GlyphSpek: dev-override supervisor CLI not found at ${cliPath}. ` +
                    'Fix or clear "glyphspek.supervisorPath" in USER settings (clear it to use the bundled supervisor).');
                return;
            }
            void vscode.window.showWarningMessage('GlyphSpek: running the UN-PINNED dev supervisor from "glyphspek.supervisorPath" ' +
                '(not the bundled, hash-pinned one). The verifier key is withheld unless ' +
                '"glyphspek.devSupervisorTrustKey" is enabled.');
        }
        else if (!fs.existsSync(bundledPath)) {
            // The bundled supervisor must ship in the .vsix; a missing bundle is a
            // packaging fault, not an operator misconfiguration.
            void vscode.window.showErrorMessage(`GlyphSpek: bundled supervisor missing at ${bundledPath}. ` +
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
            const proceed = await vscode.window.showWarningMessage('GlyphSpek: about to run under a REPO-PROVIDED policy (not operator-pinned):\n' +
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
            void vscode.window.showWarningMessage('GlyphSpek: autonomous mode is not yet available on the bundled supervisor; ' +
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
            void vscode.window.showErrorMessage(`GlyphSpek: could not prepare the verifier keystore at ${verifierKeystoreDir()}: ` +
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
            void vscode.window.showErrorMessage(`GlyphSpek: could not create run directories (${outDir} / ${runsBase}): ` +
                `${String(err?.message ?? err)}`);
            return;
        }
        supervisorOutput.show(true);
        // Verifier-key custody.
        //   BUNDLED path: the exec is hash-pinned (supervisorRunner refuses a
        //     mismatched bundle), so its code is trusted by construction — always
        //     hand it the verifier private key so verdicts pin as AUTHORITATIVE.
        //   DEV-OVERRIDE path: the un-pinned spikes-tree exec gets the key ONLY when
        //     the operator explicitly opts in via glyphspek.devSupervisorTrustKey;
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
                .getConfiguration('glyphspek')
                .inspect('devSupervisorTrustKey');
            const devTrust = (0, configScope_1.selectGlobalScopedBool)(devTrustInspect, false);
            const devTrustWorkspaceIgnored = typeof devTrustInspect?.workspaceValue === 'boolean' ||
                typeof devTrustInspect?.workspaceFolderValue === 'boolean';
            if (devTrustWorkspaceIgnored) {
                supervisorOutput.appendLine('[host] a workspace setting tried to set "glyphspek.devSupervisorTrustKey" and was ' +
                    'IGNORED for security — the verifier-key opt-in is honored only from USER (global) settings.');
            }
            passVerifierKey = devTrust === true && !fromWorkspaceIgnored;
            if (!passVerifierKey) {
                supervisorOutput.appendLine('[host] dev-override supervisor: withholding the verifier private key from the ' +
                    'un-pinned exec (enable "glyphspek.devSupervisorTrustKey" to opt in).');
            }
            else {
                supervisorOutput.appendLine('[host] dev-override supervisor: verifier key opt-in is ENABLED — handing the key to ' +
                    'the un-pinned exec (dev only).');
            }
        }
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            cancellable: true,
            title: `GlyphSpek: governed run (${mode})…`,
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
            void vscode.window.showWarningMessage('GlyphSpek: governed run cancelled.');
            return;
        }
        if (result.spawnFailed) {
            // Covers both an actual spawn failure AND the bundled-supervisor hash-gate
            // refusal (supervisorRunner returns spawnFailed with a clear message).
            const hint = isDevOverride
                ? 'Verify Node/tsx are available and "glyphspek.supervisorPath" is correct (or clear it to use the bundled supervisor). '
                : 'If this is a hash mismatch, re-run "npm run bundle:supervisor" and re-package the .vsix. ';
            void vscode.window.showErrorMessage(`GlyphSpek: could not start the supervisor. ${result.message} ` +
                hint +
                'See the "GlyphSpek Governed Run" output channel for details.');
            return;
        }
        if (result.exitCode !== 0) {
            // A non-zero exit often means Docker is unavailable, or the run errored.
            // The full reason is in the output channel; offer a one-click open.
            const choice = await vscode.window.showErrorMessage(`GlyphSpek: governed run failed (exit ${result.exitCode}). ` +
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
        void vscode.window.showInformationMessage(`GlyphSpek: governed run complete — bundle at ${result.bundleDir}.`);
    }
}
function deactivate() {
    // Restore any applied halo chrome tint + clear the glyphspek.authority context-
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