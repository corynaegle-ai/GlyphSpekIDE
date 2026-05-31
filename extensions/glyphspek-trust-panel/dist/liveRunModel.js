"use strict";
/*
 * GlyphSpek live-run VIEW MODEL — pure reducer (NO vscode, NO node, NO DOM).
 *
 * This folds the `run/event` stream (runEventProtocol.ts) into a renderable
 * per-run VIEW MODEL the live Trust Panel draws. It is the trust-load-bearing
 * half of the live panel: it decides the BADGES (runtime trust, extension
 * posture, CLI fidelity), tracks the streamed trace/diff/commands/network/policy,
 * keeps actor CLAIMS strictly separate from the verifier VERDICT, and maps each
 * DISTINCT failure to its own rendered state (§14). It deliberately does NOT do
 * the Ed25519 verification — that signature-before-display GATE stays in the
 * webview (media/app.js verifyVerdictSignature / verifyTraceIntegrity over Web
 * Crypto). The model only records the verdict + the runtime-trust facts; the
 * webview's render step applies the crypto gate ON TOP of this model and may only
 * DOWNGRADE, never upgrade, the authority the model already gates on §6.3.
 *
 * Pure + dependency-free so it compiles to dist/ and is unit-tested headlessly,
 * AND the same shapes/derivations can be mirrored 1:1 in media/live.js (the
 * webview cannot import CommonJS). The tests pin the invariants here; live.js is a
 * thin renderer over this exact model.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyRunView = emptyRunView;
exports.reduceRunEvent = reduceRunEvent;
exports.applyRunEvent = applyRunEvent;
exports.deriveCommands = deriveCommands;
exports.deriveNetwork = deriveNetwork;
exports.derivePolicyDecisions = derivePolicyDecisions;
exports.deriveChangedFiles = deriveChangedFiles;
exports.deriveTrustSummary = deriveTrustSummary;
const runEventProtocol_1 = require("./runEventProtocol");
/* ============================================================== *
 * CONSTRUCTION + REDUCTION
 * ============================================================== */
/** A fresh, empty run view for a runId (before any RunOpened arrives). */
function emptyRunView(runId) {
    return {
        runId,
        status: 'unknown',
        badges: {
            runtimeTrust: 'untrusted',
            runtimeProfile: 'unknown',
            extensionPosture: 'developer',
            cliFidelity: 'n/a',
            creationTrust: 'unknown',
            actorType: 'unknown',
            loopbackProxyBypass: false,
        },
        trace: [],
        claims: null,
        verdict: null,
        changedFiles: [],
        commands: [],
        network: [],
        policyDecisions: [],
        failures: [],
        // Default to NOT eligible: until a RunOpened establishes a trusted runtime +
        // trusted creation, no run may show product-authoritative. Fail-closed (§6.3).
        productTrustEligible: false,
        closed: false,
    };
}
/** Map a RunFailureKind to its distinct FailureState. */
function failureKindToState(kind) {
    switch (kind) {
        case runEventProtocol_1.RunFailureKind.TamperedTrace:
            return 'tampered_trace';
        case runEventProtocol_1.RunFailureKind.MissingVerifierSignature:
            return 'missing_verifier_signature';
        case runEventProtocol_1.RunFailureKind.StaleVerifier:
            return 'stale_verifier';
        case runEventProtocol_1.RunFailureKind.NonIsolatedRuntime:
            return 'non_isolated_runtime';
        case runEventProtocol_1.RunFailureKind.BoundaryOnlyCli:
            return 'boundary_only_cli';
        case runEventProtocol_1.RunFailureKind.BridgeMismatch:
            return 'bridge_mismatch';
        default:
            return 'none';
    }
}
/**
 * Apply ONE validated run-event to a run view, returning the NEXT view
 * (immutably-ish: returns a new top-level object so a renderer can diff). Unknown
 * or malformed events are ignored by the caller (it validates first); this
 * assumes a typed event.
 */
function reduceRunEvent(view, event) {
    const next = { ...view };
    switch (event.kind) {
        case runEventProtocol_1.RunEventKind.RunOpened: {
            const o = event;
            next.badges = {
                runtimeTrust: o.runtimeTrust,
                runtimeProfile: o.runtimeProfile,
                extensionPosture: o.extensionPosture,
                cliFidelity: o.cliFidelity,
                creationTrust: o.trust,
                actorType: o.actorType,
                ...(o.actorVersion ? { actorVersion: o.actorVersion } : {}),
                // F2: carry the loopback-bypass posture so the panel can label loopback as
                // unobserved local traffic (the carve-out means it is NOT in the trace).
                loopbackProxyBypass: o.loopbackProxyBypass === true,
                ...(o.loopbackProxyBypassReason
                    ? { loopbackProxyBypassReason: o.loopbackProxyBypassReason }
                    : {}),
            };
            next.status = o.state ?? 'created';
            next.productTrustEligible = (0, runEventProtocol_1.isProductTrustEligible)({
                trust: o.trust,
                runtimeTrust: o.runtimeTrust,
            });
            // A non-isolating runtime is, by itself, a distinct rendered failure: record
            // it so the panel shows "NOT TRUSTED — dev runtime" even before any verdict.
            if (o.runtimeTrust !== 'trusted') {
                next.failures = appendFailure(view.failures, {
                    state: 'non_isolated_runtime',
                    message: 'NOT TRUSTED — dev runtime: ' +
                        o.runtimeProfile +
                        ' is not an approved isolation runtime. This run cannot be product-trusted.',
                });
            }
            // Boundary-only CLI fidelity is likewise a distinct, standing label.
            if (o.cliFidelity === 'boundary-only') {
                next.failures = appendFailure(next.failures, {
                    state: 'boundary_only_cli',
                    message: 'boundary-observed: ' +
                        o.actorType +
                        ' ran boundary-only (no per-tool brokering). Evidence is coarser — diff, transcript, network observation, verdict.',
                });
            }
            return next;
        }
        case runEventProtocol_1.RunEventKind.TraceEvent: {
            next.trace = view.trace.concat([event.event]);
            // Re-derive the cheap projections from the growing trace.
            next.commands = deriveCommands(next.trace);
            next.network = deriveNetwork(next.trace);
            next.policyDecisions = derivePolicyDecisions(next.trace);
            next.changedFiles = deriveChangedFiles(next.trace);
            // Keep run status fresh from any embedded state change.
            if (event.event.type === 'run_state_changed') {
                const p = event.event.payload;
                if (p && typeof p.to === 'string')
                    next.status = p.to;
            }
            return next;
        }
        case runEventProtocol_1.RunEventKind.StateChanged: {
            next.status = event.to;
            return next;
        }
        case runEventProtocol_1.RunEventKind.ActorClaims: {
            // CLAIMS ONLY — never folded into the verdict. Always its own view.
            next.claims = {
                ...(event.plan != null ? { plan: event.plan } : {}),
                ...(event.summary != null ? { summary: event.summary } : {}),
                claimedChangedFiles: Array.isArray(event.claimedChangedFiles)
                    ? event.claimedChangedFiles.slice()
                    : [],
                claimedChecks: Array.isArray(event.claimedChecks)
                    ? event.claimedChecks.map((c) => ({ name: c.name, claim: c.claim }))
                    : [],
            };
            return next;
        }
        case runEventProtocol_1.RunEventKind.VerifierVerdict: {
            // VERDICT ONLY — delivered as evidence. The webview applies the Ed25519
            // gate; the model records it but never marks it authoritative.
            next.verdict = {
                checks: event.checks.slice(),
                overallVerdict: event.overallVerdict,
                traceRootHash: event.traceRootHash,
                ...(event.signature ? { signature: event.signature } : {}),
                ...(event.verifierPublicKey ? { verifierPublicKey: event.verifierPublicKey } : {}),
            };
            // A verdict with no signature is the distinct "missing verifier signature"
            // failure (§14) — recorded so the panel renders it distinctly even before
            // the webview's crypto gate runs.
            if (!event.signature || typeof event.signature.value !== 'string') {
                next.failures = appendFailure(view.failures, {
                    state: 'missing_verifier_signature',
                    message: 'verifier verdict carries no signature — cannot be authoritative.',
                });
            }
            return next;
        }
        case runEventProtocol_1.RunEventKind.RunClosed: {
            next.status = event.finalState;
            next.closed = true;
            return next;
        }
        case runEventProtocol_1.RunEventKind.Failure: {
            next.failures = appendFailure(view.failures, {
                state: failureKindToState(event.failure),
                message: event.message,
                ...(event.staleRootHash ? { staleRootHash: event.staleRootHash } : {}),
                ...(typeof event.brokenIndex === 'number' ? { brokenIndex: event.brokenIndex } : {}),
            });
            // Any failure that bears on runtime trust de-eligibilizes the run for a
            // product-authoritative state (fail-closed). Tamper, stale verifier, a
            // non-isolated runtime, and a bridge mismatch all break the trust floor.
            if (event.failure === runEventProtocol_1.RunFailureKind.NonIsolatedRuntime ||
                event.failure === runEventProtocol_1.RunFailureKind.TamperedTrace ||
                event.failure === runEventProtocol_1.RunFailureKind.StaleVerifier ||
                event.failure === runEventProtocol_1.RunFailureKind.BridgeMismatch) {
                next.productTrustEligible = false;
            }
            return next;
        }
        default:
            return next;
    }
}
/** Append a failure, de-duping by (state, message) so the same one isn't doubled. */
function appendFailure(failures, f) {
    if (failures.some((x) => x.state === f.state && x.message === f.message)) {
        return failures;
    }
    return failures.concat([f]);
}
/**
 * Validate THEN reduce. Returns the next view and whether the event was applied.
 * A malformed event is dropped (never mis-rendered) and reported via `problems`.
 */
function applyRunEvent(view, raw) {
    const validation = (0, runEventProtocol_1.validateRunEvent)(raw);
    if (!validation.ok) {
        return { view, applied: false, problems: validation.problems };
    }
    return { view: reduceRunEvent(view, validation.event), applied: true };
}
/* ============================================================== *
 * TRACE PROJECTIONS (mirror media/app.js derive* so streamed and loaded
 * traces render identically)
 * ============================================================== */
function payloadOf(evt) {
    return (evt.payload ?? {});
}
function deriveCommands(trace) {
    const out = [];
    for (const e of trace) {
        const p = payloadOf(e);
        if (e.type === 'tool_end' && p.tool === 'command') {
            out.push({
                argv: Array.isArray(p.argv) ? p.argv : [],
                ...(typeof p.exitCode === 'number' ? { exitCode: p.exitCode } : {}),
                ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}),
            });
        }
    }
    return out;
}
function deriveNetwork(trace) {
    const out = [];
    for (const e of trace) {
        const p = payloadOf(e);
        if (e.type === 'policy_decision' && p.tool === 'network') {
            // F1: a soft-plane observe-only egress is OBSERVED, not a policy allow.
            // Surface it distinctly so the panel never reads it as "policy: allowed".
            const observeOnly = p.enforcement === 'observe-only';
            out.push({
                destination: String(p.destination ?? p.requestedCapability ?? '(unknown)'),
                decision: String(p.decision ?? ''),
                // An observe-only egress was let THROUGH (not blocked); it is recorded as
                // observed. `blocked` reflects only a real enforced block.
                blocked: observeOnly ? false : Boolean(p.blocked),
                observeOnly,
            });
        }
    }
    return out;
}
function derivePolicyDecisions(trace) {
    const out = [];
    for (const e of trace) {
        if (e.type !== 'policy_decision')
            continue;
        const p = payloadOf(e);
        // F1: carry the observe-only enforcement posture through so a consumer never
        // reads a soft-plane observation's back-compat `decision:'allow'` as a real
        // policy allow.
        const observeOnly = p.enforcement === 'observe-only';
        out.push({
            tool: String(p.tool ?? ''),
            requestedCapability: String(p.requestedCapability ?? ''),
            decision: String(p.decision ?? ''),
            blocked: observeOnly ? false : Boolean(p.blocked),
            ...(p.rule ? { rule: String(p.rule) } : {}),
            ...(p.provenanceLabel ? { provenanceLabel: String(p.provenanceLabel) } : {}),
            ...(observeOnly ? { enforcement: 'observe-only' } : {}),
        });
    }
    return out;
}
/**
 * Derive changed files from the trace. Prefers explicit changed-file lists on
 * tool_end payloads (changedFiles: [{path, change}] or filesChanged: ["path"]);
 * an entry without a known change type is recorded as '?'. This is the
 * pre/post-diff observation the boundary-only CLI mode relies on (§13.2) and the
 * native file-broker emits for hook mode.
 */
function deriveChangedFiles(trace) {
    const byPath = new Map();
    for (const e of trace) {
        const p = payloadOf(e);
        const list = (p.changedFiles ?? p.filesChanged);
        if (!Array.isArray(list))
            continue;
        for (const item of list) {
            if (typeof item === 'string') {
                if (!byPath.has(item))
                    byPath.set(item, '?');
            }
            else if (item && typeof item === 'object') {
                const obj = item;
                if (typeof obj.path === 'string') {
                    const change = normalizeChange(obj.change);
                    byPath.set(obj.path, change);
                }
            }
        }
    }
    return Array.from(byPath.entries()).map(([path, change]) => ({ path, change }));
}
function normalizeChange(c) {
    if (c === 'A' || c === 'added' || c === 'add')
        return 'A';
    if (c === 'M' || c === 'modified' || c === 'modify')
        return 'M';
    if (c === 'D' || c === 'deleted' || c === 'delete')
        return 'D';
    return '?';
}
/* ============================================================== *
 * DERIVED TRUST SUMMARY (what the panel asks of the model)
 * ============================================================== */
/**
 * The PRIMARY trust summary the panel renders, BEFORE the webview crypto gate.
 * Returns whether the run may be presented as product-trust-eligible and the
 * single most-severe failure state to surface. This is the gate the §14 test
 * asserts: a non-isolated-runtime run is NEVER eligible, and each failure has a
 * distinct state.
 *
 * Severity order (most severe first) so the headline failure is deterministic:
 *   non_isolated_runtime > tampered_trace > stale_verifier >
 *   bridge_mismatch > missing_verifier_signature > boundary_only_cli.
 */
const FAILURE_SEVERITY = [
    'non_isolated_runtime',
    'tampered_trace',
    'stale_verifier',
    'bridge_mismatch',
    'missing_verifier_signature',
    'boundary_only_cli',
];
function deriveTrustSummary(view) {
    const present = new Set();
    for (const f of view.failures)
        present.add(f.state);
    let headline = 'none';
    for (const s of FAILURE_SEVERITY) {
        if (present.has(s)) {
            headline = s;
            break;
        }
    }
    return {
        productTrustEligible: view.productTrustEligible,
        headlineFailure: headline,
        failureStates: FAILURE_SEVERITY.filter((s) => present.has(s)),
    };
}
//# sourceMappingURL=liveRunModel.js.map