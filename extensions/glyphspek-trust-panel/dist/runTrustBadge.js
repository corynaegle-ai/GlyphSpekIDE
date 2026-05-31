"use strict";
/*
 * GlyphSpek RUN-TRUST BADGE MAP — host (Node) side.
 *
 * This is the SHARED, EXHAUSTIVE creation-trust → label/icon map for the
 * extension HOST (the Governed Runs activity-bar tree, governedRunsTree.ts). It is
 * the Node/TypeScript counterpart of the webview's `CREATION_TRUST_BADGE` in
 * media/live.js (sweep-24 #3): the same honest postures, the same "only `trusted`
 * is product-trust-eligible" rule, and the same amber framing for the soft v1
 * postures (governed-unsandboxed, sandboxed-soft-egress). The webview map drives
 * the Trust Panel badges; THIS map drives the sidebar tree. They are kept in sync
 * by a test (test/runTrustBadge.test.mjs) that asserts both cover EXACTLY the
 * RUN_TRUSTS set and agree on which posture is product-trusted.
 *
 * Why a separate copy rather than importing live.js: live.js is browser-world JS
 * the webview loads (it cannot be required from the CommonJS host), and the tree
 * additionally needs a gs-* ICON name per posture — a host-only concern the
 * webview badge map does not carry. Keeping the maps mirrored (and test-pinned)
 * preserves the single source of truth in spirit while respecting the two worlds.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN_TRUSTS = exports.UNKNOWN_TRUST_BADGE = exports.RUN_TRUST_BADGE = void 0;
exports.runTrustBadge = runTrustBadge;
exports.actorIcon = actorIcon;
exports.actorLabel = actorLabel;
const bridgeProtocol_1 = require("./bridgeProtocol");
Object.defineProperty(exports, "RUN_TRUSTS", { enumerable: true, get: function () { return bridgeProtocol_1.RUN_TRUSTS; } });
/**
 * SHARED, EXHAUSTIVE creation-trust → badge map. EVERY RunTrust value MUST appear
 * here (the test asserts the keys equal RUN_TRUSTS exactly) so a new posture can
 * never silently fall through to no icon/label. The labels mirror the webview's
 * CREATION_TRUST_BADGE text; the icons are the host-only gs-* additions.
 */
exports.RUN_TRUST_BADGE = {
    trusted: {
        icon: 'gs-verifier',
        label: 'Trusted (pending gate)',
        description: 'Creation trust: trusted. Runtime reported hard isolation + hard egress. ' +
            'Eligible for a product-authoritative verdict ONLY after the webview Ed25519 ' +
            'signature gate passes.',
        productTrustEligible: true,
    },
    'sandboxed-soft-egress': {
        icon: 'gs-sandbox',
        label: 'Sandboxed (soft egress)',
        description: 'Creation trust: sandboxed-soft-egress. Runs inside an isolation runtime ' +
            '(fs isolation, synthetic HOME, no host secrets) but the egress boundary is ' +
            'SOFT — not hard containment. Never product-trusted.',
        productTrustEligible: false,
    },
    'governed-unsandboxed': {
        icon: 'gs-terminal',
        label: 'Governed (soft) — unsandboxed',
        description: 'Creation trust: governed-unsandboxed. Governed + traced via the metadata-only ' +
            'egress proxy, but UNSANDBOXED (local exec). Evidence is coarser; never ' +
            'product-trusted.',
        productTrustEligible: false,
    },
    untrusted: {
        icon: 'gs-deny',
        label: 'Untrusted',
        description: 'Creation trust: untrusted. The run could not establish a trusted runtime; it ' +
            'cannot be product-trusted.',
        productTrustEligible: false,
    },
    refused: {
        icon: 'gs-deny',
        label: 'Refused',
        description: 'Creation trust: refused. The supervisor refused to create the run (e.g. a ' +
            'missing/invalid posture). No trusted run was produced.',
        productTrustEligible: false,
    },
};
/** The badge shown for a run before any RunOpened has settled its real posture. */
exports.UNKNOWN_TRUST_BADGE = {
    icon: 'gs-run',
    label: 'Starting…',
    description: 'The run has been created but has not yet reported its trust posture ' +
        '(no RunOpened event observed yet).',
    productTrustEligible: false,
};
/**
 * Resolve a creation-trust posture to its badge via the shared exhaustive map.
 * The pre-RunOpened `'unknown'` sentinel resolves to {@link UNKNOWN_TRUST_BADGE};
 * any real RunTrust resolves through RUN_TRUST_BADGE. An unexpected string (which
 * the type system forbids, but defends against a future wire value) falls back to
 * the unknown badge rather than throwing or rendering nothing.
 */
function runTrustBadge(posture) {
    if (!posture || posture === 'unknown')
        return exports.UNKNOWN_TRUST_BADGE;
    const badge = exports.RUN_TRUST_BADGE[posture];
    return badge ?? exports.UNKNOWN_TRUST_BADGE;
}
/** The gs-* icon basename for an actor type (claude/codex/native), for the tree. */
function actorIcon(actorType) {
    if (actorType === 'claude-code-cli')
        return 'gs-claude-actor';
    if (actorType === 'codex-cli')
        return 'gs-codex-actor';
    return 'gs-actors';
}
/** A short, honest actor label for the tree row description. */
function actorLabel(actorType) {
    switch (actorType) {
        case 'claude-code-cli':
            return 'claude-code-cli';
        case 'codex-cli':
            return 'codex-cli';
        case 'native':
            return 'native';
        default:
            return actorType || 'unknown';
    }
}
//# sourceMappingURL=runTrustBadge.js.map