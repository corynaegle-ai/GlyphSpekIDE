"use strict";
/*
 * GlyphStudio live run-event protocol — SHARED CONTRACT (pure; NO vscode, NO node).
 *
 * This is the message grammar for the supervisor→client `run/event` notification
 * stream (BridgeNotification.RunEvent in bridgeProtocol.ts) that drives the LIVE
 * Trust Panel (docs/ide-build-design.md §13/§14, milestone M5). bridgeProtocol.ts
 * defines run CREATION (`run/create`) and the trust posture a run SETTLES into at
 * creation; this module defines the EVENT ENVELOPES streamed AFTER creation so the
 * panel can render a governed run as it happens.
 *
 * It is deliberately dependency-free so that:
 *   1. the extension host can import + validate it,
 *   2. the LATER supervisor-side stdio server (a SEPARATE task — M2/M6) can import
 *      the EXACT same contract and emit a matching stream, AND
 *   3. it is unit-testable headlessly under node:test against compiled dist/.
 *
 * DESIGN RULE — claims are NOT verdicts (§6.4), signature-before-display (§6.5),
 * runtime trust is explicit (§6.3): the envelope CARRIES the actor's self-reported
 * plan/claims and the verifier's verdict in SEPARATE, distinctly-typed events that
 * a renderer must never conflate, and it carries the runtime-trust profile so a
 * non-isolated runtime can never present a product-authoritative "trusted" state.
 * The wire shape makes these invariants representable but the GATE (the in-webview
 * Ed25519 verify) still lives in the webview — this module is the grammar only.
 *
 * COMPATIBILITY: this contract is keyed to BRIDGE_PROTOCOL_VERSION (the handshake
 * already refuses a mismatched peer), so a `run/event` envelope is only ever
 * processed after a compatible handshake. Every envelope additionally carries its
 * own {@link RUN_EVENT_PROTOCOL_VERSION} so a future additive change is detectable.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN_FAILURE_KINDS = exports.RunFailureKind = exports.RunEventKind = exports.CLI_FIDELITY_VALUES = exports.STREAM_EXTENSION_POSTURES = exports.RUNTIME_TRUST_VALUES = exports.RUN_EVENT_PROTOCOL_VERSION = void 0;
exports.validateRunEvent = validateRunEvent;
exports.isProductTrustEligible = isProductTrustEligible;
exports.bridgeConnectStatusToFailureKind = bridgeConnectStatusToFailureKind;
exports.bridgeConnectFailureEvent = bridgeConnectFailureEvent;
exports.detectAmbientExtensionsDevMode = detectAmbientExtensionsDevMode;
exports.ambientExtensionsDevModeFailureEvent = ambientExtensionsDevModeFailureEvent;
const bridgeProtocol_1 = require("./bridgeProtocol");
/* ============================================================== *
 * VERSIONING
 * ============================================================== */
/**
 * The run-event stream schema version. Bumped on any breaking change to a
 * `run/event` envelope shape. Carried on every envelope so a renderer can refuse
 * or down-render an envelope it does not understand rather than mis-rendering it.
 * Distinct from BRIDGE_PROTOCOL_VERSION (the transport/handshake grammar).
 */
exports.RUN_EVENT_PROTOCOL_VERSION = 1;
/** The full set, for validation. */
exports.RUNTIME_TRUST_VALUES = ['trusted', 'untrusted'];
/** The full set, for validation. */
exports.STREAM_EXTENSION_POSTURES = [
    'sovereign',
    'developer',
];
/** The full set, for validation. */
exports.CLI_FIDELITY_VALUES = [
    'per-tool-brokered',
    'boundary-only',
    'n/a',
];
/* ============================================================== *
 * RUN-EVENT ENVELOPE KINDS
 * ============================================================== */
/**
 * The kinds of `run/event` notification the supervisor streams. Each is a
 * DISTINCT envelope so the panel can switch exhaustively and so claims, verdict,
 * and runtime-trust facts are carried by separate, non-conflatable messages.
 */
exports.RunEventKind = {
    /**
     * Run opened: carries the run identity + trust facts the panel badges. Mirrors
     * the §10.3 run-request fields plus the runtime-trust profile. This is the
     * FIRST event for a run; it establishes the badges BEFORE any trace renders.
     */
    RunOpened: 'run_opened',
    /** One hash-chained trace event appended to the run's trace. */
    TraceEvent: 'trace_event',
    /** A run state transition (created→…→completed), for the run-list status. */
    StateChanged: 'state_changed',
    /**
     * The actor's self-reported plan/claims (amber, NOT authoritative). Carried as
     * its OWN envelope so it can never be delivered as a verdict.
     */
    ActorClaims: 'actor_claims',
    /**
     * The independent verifier's verdict + its out-of-band public key REFERENCE.
     * The panel still VERIFIES the signature in-browser before showing it as
     * authoritative — this envelope only DELIVERS the verdict; it never asserts it.
     */
    VerifierVerdict: 'verifier_verdict',
    /** Run finished (terminal). Carries the final lifecycle state + summary counts. */
    RunClosed: 'run_closed',
    /**
     * A DISTINCT failure/degradation signal (tamper detected upstream, stale
     * verifier, bridge mismatch, boundary-only mode, non-isolated runtime). The
     * panel renders each {@link RunFailureKind} distinctly and de-authoritates.
     */
    Failure: 'failure',
};
/**
 * The DISTINCT failure states the panel must render distinctly (§14). Several are
 * detected IN the webview (tamper via verifyChain, missing/invalid signature via
 * the Ed25519 gate) and need no stream signal; the ones here are facts only the
 * supervisor/bridge knows and must hand to the panel so they render distinctly
 * too — never collapsed into a generic "failed".
 */
exports.RunFailureKind = {
    /** verifyChain failed upstream / trace tampered → render UNTRUSTED. */
    TamperedTrace: 'tampered_trace',
    /** The verifier verdict has no signature or an invalid one. */
    MissingVerifierSignature: 'missing_verifier_signature',
    /** Verdict signs over a DIFFERENT (older) trace_root than the live trace. */
    StaleVerifier: 'stale_verifier',
    /**
     * The runtime is NOT an approved isolation runtime → "NOT TRUSTED — dev
     * runtime". A run with this failure can NEVER show product-authoritative.
     */
    NonIsolatedRuntime: 'non_isolated_runtime',
    /** CLI actor ran boundary-only (coarser evidence; not per-tool brokered). */
    BoundaryOnlyCli: 'boundary_only_cli',
    /** Bridge supervisor-binary hash OR protocol-version mismatch. */
    BridgeMismatch: 'bridge_mismatch',
    /*
     * M5 §14 — the four HOST-DETECTED states the panel renders distinctly but only
     * the host can detect. The webview (media/live.js) is already render-ready for all
     * of them (FAILURE_LABELS / FAILURE_SEVERITY / failureKindToState); these strings
     * MUST match the webview's verbatim. (untrusted_verifier_key is the fifth §14 state
     * but is DERIVED webview-side from the signature gate — it is NOT host-emitted, so
     * it is intentionally absent from RUN_FAILURE_KINDS.)
     */
    /**
     * The supervisor binary's on-disk hash did NOT match the pinned build, so the
     * bridge client REFUSED to spawn (bridge connect status 'hash-mismatch',
     * {@link import('./bridgeProtocol').BridgeErrorCode.HashMismatch}). The stream
     * cannot be attributed to the trusted supervisor → the run is de-authoritated.
     */
    SupervisorHashMismatch: 'supervisor_hash_mismatch',
    /**
     * The bridge handshake could not AUTHENTICATE/establish the channel (connect
     * status 'handshake-failed': the handshake RPC errored, closed early, or returned
     * a malformed result before the channel reached `ready`). An unauthenticated
     * stream is never rendered as a current, trusted run.
     */
    BridgeAuthFailure: 'bridge_auth_failure',
    /**
     * The handshake reported an INCOMPATIBLE bridge/supervisor protocol version
     * (connect status 'version-incompatible',
     * {@link import('./bridgeProtocol').BridgeErrorCode.VersionIncompatible}). The
     * supervisor speaks a protocol this panel does not support → de-authoritated.
     */
    IncompatibleSupervisor: 'incompatible_supervisor',
    /**
     * The extension host activated in a TRUST-DEGRADING ambient posture (Developer
     * extension mode), where ambient/non-curated extensions are enabled and the
     * governed surfaces sit outside a curated, sovereign extension set. A posture
     * WARNING — it does not by itself tamper a run, but no run created in this host
     * can be product-trusted. Detected at activation by {@link detectAmbientExtensionsDevMode}.
     */
    AmbientExtensionsDevMode: 'ambient_extensions_dev_mode',
};
/** The full set, for validation. */
exports.RUN_FAILURE_KINDS = [
    exports.RunFailureKind.TamperedTrace,
    exports.RunFailureKind.MissingVerifierSignature,
    exports.RunFailureKind.StaleVerifier,
    exports.RunFailureKind.NonIsolatedRuntime,
    exports.RunFailureKind.BoundaryOnlyCli,
    exports.RunFailureKind.BridgeMismatch,
    // M5 §14 — the four host-detected states (see above).
    exports.RunFailureKind.SupervisorHashMismatch,
    exports.RunFailureKind.BridgeAuthFailure,
    exports.RunFailureKind.IncompatibleSupervisor,
    exports.RunFailureKind.AmbientExtensionsDevMode,
];
const RUN_EVENT_KINDS = [
    exports.RunEventKind.RunOpened,
    exports.RunEventKind.TraceEvent,
    exports.RunEventKind.StateChanged,
    exports.RunEventKind.ActorClaims,
    exports.RunEventKind.VerifierVerdict,
    exports.RunEventKind.RunClosed,
    exports.RunEventKind.Failure,
];
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
function validateRunEvent(input) {
    const problems = [];
    const e = (input ?? {});
    // SCHEMA-VERSION GATE (sweep-19 Medium #6 — FAIL CLOSED). `rev` is the documented
    // compatibility gate; enforce it BEFORE shape validation so an envelope from a
    // future/foreign stream schema is REFUSED rather than mis-rendered as a current
    // event. A missing or mismatched `rev` is a distinct, fatal problem — we do not
    // attempt to interpret the rest of an envelope we cannot vouch is this schema.
    if (e.rev !== exports.RUN_EVENT_PROTOCOL_VERSION) {
        return { ok: false, problems: ['rev'] };
    }
    if (!nonEmptyString(e.runId))
        problems.push('runId');
    if (!nonEmptyString(e.kind) || !RUN_EVENT_KINDS.includes(e.kind)) {
        problems.push('kind');
        // Without a known kind we cannot validate the rest; fail early.
        return { ok: false, problems };
    }
    switch (e.kind) {
        case exports.RunEventKind.RunOpened: {
            const o = e;
            if (!nonEmptyString(o.actorType))
                problems.push('actorType');
            // Validate `trust` against the canonical RUN_TRUSTS set (bridgeProtocol.ts)
            // rather than a hardcoded list, so EVERY valid posture is accepted —
            // including `governed-unsandboxed` (the governed terminal posture, sweep-23
            // #2). Product-trust is gated SEPARATELY by isProductTrustEligible (strict
            // `trusted`), so accepting the value here never confers product authority.
            if (!bridgeProtocol_1.RUN_TRUSTS.includes(o.trust)) {
                problems.push('trust');
            }
            if (!nonEmptyString(o.runtimeProfile))
                problems.push('runtimeProfile');
            if (!exports.RUNTIME_TRUST_VALUES.includes(o.runtimeTrust)) {
                problems.push('runtimeTrust');
            }
            if (!exports.STREAM_EXTENSION_POSTURES.includes(o.extensionPosture)) {
                problems.push('extensionPosture');
            }
            if (!exports.CLI_FIDELITY_VALUES.includes(o.cliFidelity)) {
                problems.push('cliFidelity');
            }
            break;
        }
        case exports.RunEventKind.TraceEvent: {
            const t = e;
            const ev = t.event;
            if (!ev || typeof ev !== 'object') {
                problems.push('event');
            }
            else {
                if (typeof ev.seq !== 'number')
                    problems.push('event.seq');
                if (!nonEmptyString(ev.type))
                    problems.push('event.type');
                if (typeof ev.hash !== 'string')
                    problems.push('event.hash');
                if (typeof ev.prevHash !== 'string')
                    problems.push('event.prevHash');
            }
            break;
        }
        case exports.RunEventKind.StateChanged: {
            const s = e;
            if (!nonEmptyString(s.from))
                problems.push('from');
            if (!nonEmptyString(s.to))
                problems.push('to');
            break;
        }
        case exports.RunEventKind.VerifierVerdict: {
            const v = e;
            if (!Array.isArray(v.checks))
                problems.push('checks');
            if (v.overallVerdict !== 'pass' && v.overallVerdict !== 'fail' && v.overallVerdict !== 'error') {
                problems.push('overallVerdict');
            }
            if (!nonEmptyString(v.traceRootHash))
                problems.push('traceRootHash');
            break;
        }
        case exports.RunEventKind.RunClosed: {
            const c = e;
            if (!nonEmptyString(c.finalState))
                problems.push('finalState');
            break;
        }
        case exports.RunEventKind.Failure: {
            const f = e;
            if (!exports.RUN_FAILURE_KINDS.includes(f.failure))
                problems.push('failure');
            if (!nonEmptyString(f.message))
                problems.push('message');
            break;
        }
        case exports.RunEventKind.ActorClaims:
            // All fields optional; a claims event with nothing is still well-formed
            // (it just renders an empty claims panel). No required fields.
            break;
    }
    if (problems.length > 0)
        return { ok: false, problems };
    return { ok: true, event: e };
}
/* ============================================================== *
 * PRODUCT-TRUST ELIGIBILITY (the runtime-trust gate, §6.3)
 * ============================================================== */
/**
 * Whether a run is EVEN ELIGIBLE for a product-authoritative "trusted" panel
 * state, based on the facts known at run-open. This is the wire-level half of the
 * §6.3 invariant ("runtime trust is explicit; non-isolating local runtime is
 * test-only"): a run on an `untrusted` runtime, or whose creation trust is not
 * `trusted`, is NEVER eligible — independent of any later verifier verdict. The
 * webview still runs the signature-before-display gate on top of this; eligibility
 * is a NECESSARY-not-sufficient precondition.
 *
 * Pure + exported so both the panel and tests assert the same predicate: a
 * non-isolated-runtime run can never reach product-authoritative.
 */
function isProductTrustEligible(opened) {
    return opened.runtimeTrust === 'trusted' && opened.trust === 'trusted';
}
function bridgeConnectStatusToFailureKind(status) {
    switch (status) {
        // The supervisor binary failed the pinned-hash gate — the client refused to spawn.
        case 'hash-mismatch':
            return exports.RunFailureKind.SupervisorHashMismatch;
        // The handshake reported incompatible bridge/supervisor protocol versions.
        case 'version-incompatible':
            return exports.RunFailureKind.IncompatibleSupervisor;
        // The handshake (the channel's only authentication: it BINDS the stream to a
        // hash-pinned supervisor over the spawned stdio) errored / closed early / was
        // malformed before the channel reached `ready` — the stream is unauthenticated.
        case 'handshake-failed':
            return exports.RunFailureKind.BridgeAuthFailure;
        case 'connected':
        case 'spawn-failed':
        default:
            return null;
    }
}
/**
 * Construct a well-formed §14 {@link FailureEvent} for a non-connected bridge
 * connect (or `null` when the status has no distinct §14 state). The returned event
 * passes {@link validateRunEvent} verbatim and the webview renders it as the matching
 * distinct card. The host emits it into the run-event sink (TrustPanel.postRunEvent)
 * exactly like any other failure.
 */
function bridgeConnectFailureEvent(runId, status, message) {
    const failure = bridgeConnectStatusToFailureKind(status);
    if (failure === null)
        return null;
    return {
        rev: exports.RUN_EVENT_PROTOCOL_VERSION,
        runId: nonEmptyString(runId) ? runId : 'unknown-run',
        kind: exports.RunEventKind.Failure,
        failure,
        message: nonEmptyString(message) ? message : `bridge connect failed: ${status}`,
    };
}
/**
 * M5 §14 — detect the `ambient_extensions_dev_mode` trust-degrading posture at
 * activation. CONSERVATIVE by construction: it fires ONLY when the extension host is
 * in Development mode (vscode.ExtensionMode.Development) — i.e. the extension is being
 * run from source / an unpacked dev host (Extension Development Host, `--extensionDevelopmentPath`).
 * A normal user install runs as Production (and `npm test`/integration runs as Test);
 * NEITHER fires this, so a real install never sees a false ambient-extensions card.
 *
 * Why this heuristic: in a Development host the workbench enables AMBIENT, non-curated
 * extensions and the governed surfaces sit OUTSIDE a sovereign/curated set, so a run
 * created there cannot be product-trusted — the per-run envelope is not the whole host
 * (per-run-envelope-not-whole-IDE). We do NOT try to enumerate third-party extensions
 * (vscode.extensions.all) here: that is noisy (every install has bundled extensions),
 * non-deterministic, and would over-fire. Development mode is the single, robust,
 * conservative signal. Returns `true` iff the posture is degrading.
 */
function detectAmbientExtensionsDevMode(inputs) {
    return inputs.extensionMode === inputs.developmentMode;
}
/**
 * Construct the §14 `ambient_extensions_dev_mode` {@link FailureEvent} for a run
 * (or `null` when the posture is NOT degrading, per {@link detectAmbientExtensionsDevMode}).
 * The returned event passes {@link validateRunEvent} verbatim.
 */
function ambientExtensionsDevModeFailureEvent(runId, inputs) {
    if (!detectAmbientExtensionsDevMode(inputs))
        return null;
    return {
        rev: exports.RUN_EVENT_PROTOCOL_VERSION,
        runId: nonEmptyString(runId) ? runId : 'unknown-run',
        kind: exports.RunEventKind.Failure,
        failure: exports.RunFailureKind.AmbientExtensionsDevMode,
        message: 'this run executed with the workbench in Developer posture, where AMBIENT ' +
            '(non-curated) extensions are enabled. Extension surfaces outside the per-run ' +
            'envelope are NOT governed, so this run cannot be product-trusted.',
    };
}
//# sourceMappingURL=runEventProtocol.js.map