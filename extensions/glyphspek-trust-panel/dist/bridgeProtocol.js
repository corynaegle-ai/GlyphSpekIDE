"use strict";
/*
 * GlyphSpek supervisor bridge — RPC CONTRACT (extension-side mirror; pure; NO
 * vscode, NO node).
 *
 * This module defines the stdio JSON-RPC protocol the first-party extension's
 * bridge CLIENT (bridge.ts) speaks to the packaged supervisor's stdio SERVER.
 *
 * CONTRACT OWNERSHIP (sweep-19 Finding 5): the CANONICAL owner of this wire
 * grammar is the spike module `spikes/p0-contracts/bridge.ts`, which the
 * supervisor server (`spikes/p0-supervisor/bridge-server.ts`) imports directly.
 * The extension is a SEPARATE build package and cannot import the spikes tree at
 * build time, so THIS module is a hand-kept MIRROR of that canonical contract. The
 * two are held in lock-step by a conformance test
 * (`extension/test/bridgeContractConformance.test.mjs`) that loads BOTH this
 * mirror and the canonical module and FAILS CI if they diverge on the protocol
 * version, the method/notification/error vocabularies, or `validateRunRequest`
 * behavior. Update BOTH together; the conformance test is the drift alarm.
 *
 * It defines:
 *   - the JSON-RPC envelope shapes (request / success-response / error-response /
 *     notification),
 *   - the version-compatibility handshake (method, params, result, and the
 *     compatibility predicate both ends evaluate),
 *   - the run-creation RPC (the §10.3 run-request fields + the typed result),
 *   - the trusted/untrusted/refused trust posture a run can settle into,
 *   - the canonical error codes a hash/version/identity failure maps to.
 *
 * It is deliberately dependency-free (no `vscode`, no `node:*`) so that:
 *   1. the extension host can import the client side, AND
 *   2. the LATER supervisor-side stdio server (a SEPARATE follow-up task — see
 *      `docs/ide-build-design.md` §10 M2; NOT implemented here) can import the
 *      EXACT same contract and implement a matching server, AND
 *   3. the contract is unit-testable headlessly under plain node:test against the
 *      compiled dist/ output (mirrors configScope.ts / policyHash.ts).
 *
 * SECURITY framing (spec §10.3, §6.1, §9): the supervisor is the ONLY component
 * that creates TRUSTED runs. This contract makes the trust gate explicit on the
 * wire — every run request carries the actor identity + extension posture, and a
 * request missing a REQUIRED identity/posture field is marked untrusted/dev or
 * refused by the server. There is NO field combination that yields a SILENT
 * trusted run. The transport itself (child-process stdio, no loopback TCP) is the
 * caller-identity boundary (bridge.ts); this module is the message grammar.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERMINAL_VERDICT_ASSURANCES = exports.TERMINAL_ENV_POSTURES = exports.MODEL_CREDENTIAL_FIELD_RE = exports.RUN_TRUSTS = exports.AUTONOMY_TIERS = exports.EXTENSION_POSTURES = exports.ACTOR_TYPES = exports.BridgeErrorCode = exports.BridgeNotification = exports.BridgeMethod = exports.BRIDGE_JSONRPC = exports.BRIDGE_PROTOCOL_VERSION = void 0;
exports.isHandshakeCompatible = isHandshakeCompatible;
exports.findCredentialField = findCredentialField;
exports.validateModelCallParams = validateModelCallParams;
exports.validateModelCallResult = validateModelCallResult;
exports.validateModelAllowlistResult = validateModelAllowlistResult;
exports.validateTerminalStartResult = validateTerminalStartResult;
exports.validateTerminalStopResult = validateTerminalStopResult;
exports.validateRunRequest = validateRunRequest;
exports.isEnvelope = isEnvelope;
exports.isResponse = isResponse;
exports.isNotification = isNotification;
/* ============================================================== *
 * VERSIONING
 * ============================================================== */
/**
 * The bridge PROTOCOL version this build of the contract speaks. Bumped on any
 * breaking change to the envelope, the handshake, or the run-request shape. Both
 * ends exchange their value in the handshake and refuse to proceed when they are
 * not compatible (see {@link isHandshakeCompatible}).
 *
 * This is the CONTRACT version (the wire grammar), distinct from the extension's
 * package.json version (the product build) and from the supervisor binary's own
 * semantic version (reported separately in the handshake result).
 */
exports.BRIDGE_PROTOCOL_VERSION = 1;
/**
 * The JSON-RPC dialect tag carried in every envelope. We use a GlyphSpek-scoped
 * marker rather than the bare "2.0" so a stray generic JSON-RPC peer on the same
 * stream is rejected as foreign by {@link isEnvelope} — the stdio transport is
 * private to this client/server pair and is not a generic JSON-RPC endpoint.
 */
exports.BRIDGE_JSONRPC = 'glyphspek-jsonrpc/1';
/* ============================================================== *
 * RPC METHOD NAMES
 * ============================================================== */
/** The fixed set of request methods the supervisor stdio server must implement. */
exports.BridgeMethod = {
    /** Version-compatibility handshake; MUST be the first call after spawn. */
    Handshake: 'bridge/handshake',
    /** Create a governed run from a fully-populated run request. */
    CreateRun: 'run/create',
    /**
     * Start (drive) a previously-created run (M5 live Trust Panel). The supervisor
     * runs the run's actor pipeline and STREAMS the lifecycle/trace/claims/verdict
     * as `run/event` notifications (runEventProtocol grammar) until run_closed. The
     * response acknowledges acceptance; the run's evidence arrives on the
     * notification stream, not in this result. P0 drives a DETERMINISTIC scripted
     * in-supervisor actor over the REAL pipeline (real trace hash-chain + real
     * policy decisions + a real signed verdict); a real model-driven agent loop
     * replaces the scripted actor without changing this RPC or the event grammar.
     */
    StartRun: 'run/start',
    /**
     * Query the model-broker allowlist (M6). The UI offers ONLY the models this
     * returns. The result carries NO credential — only non-secret provider/model/
     * endpoint posture. With no configured model broker the allowlist is empty.
     */
    ModelAllowlist: 'model/allowlist',
    /**
     * Broker one model call — chat / inline-edit (M6). The request carries WHAT to
     * ask (provider/model/messages/provenance/context), NEVER how to authenticate:
     * there is deliberately no credential field. The supervisor reads the provider
     * token supervisor-side and the UI/client never receives it, nor the assembled
     * outbound HTTP request. The result is the redacted projection (decision +
     * redacted completion + usage + trace ref).
     */
    ModelCall: 'model/call',
    /**
     * Start a GOVERNED TERMINAL SESSION (M7 — the in-IDE Governed Terminal surface).
     * The supervisor starts a metadata-only egress governance proxy (allowlisting the
     * configured model endpoints), creates a real run, and PROJECTS the proxy's egress
     * activity into the run's hash-chained trace, streaming it as the SAME `run/event`
     * notifications the live Trust Panel already renders. The result carries the
     * runId, the proxy URL the future terminal UI sets as HTTPS_PROXY/HTTP_PROXY, and
     * the env-sanitization POSTURE the UI applies. The credential NEVER touches the
     * supervisor (the proxy is metadata-only); this RPC does NOT spawn the CLI.
     */
    TerminalStart: 'terminal/start',
    /**
     * Stop a governed terminal session (M7). The supervisor closes the proxy and
     * FINALIZES the run with the Ed25519-signed verdict over the live trace root. A
     * DEGRADED trace-health is bound into the verdict (`assurance: 'degraded'`,
     * sweep-22 #45) so a consumer cannot present a degraded session as fully trusted.
     */
    TerminalStop: 'terminal/stop',
};
/** Server→client notification methods (no response expected). */
exports.BridgeNotification = {
    /** A run lifecycle/trace event streamed back to the client for the panel. */
    RunEvent: 'run/event',
};
/* ============================================================== *
 * ERROR CODES
 * ============================================================== */
/**
 * Canonical bridge error codes. Negative integers in the JSON-RPC
 * server-error band so they never collide with a transport-level parse error.
 * These are the DISTINCT failure states the spec requires the bridge to surface
 * (no silent degraded run): a hash mismatch, an incompatible version, and a
 * missing/invalid identity-or-posture each map to their own code.
 */
exports.BridgeErrorCode = {
    /** Malformed envelope / JSON parse failure on the wire. */
    ParseError: -32700,
    /** Unknown method or bad params shape. */
    InvalidRequest: -32600,
    /**
     * The supervisor binary's on-disk hash did not match the pinned value. The
     * client REFUSES to spawn in this case, so this code is reserved for a server
     * that ALSO self-checks; the client-side block is surfaced as
     * {@link BridgeOutcome.HashMismatch} without ever reaching the wire.
     */
    HashMismatch: -32010,
    /** Handshake reported incompatible bridge/supervisor versions. */
    VersionIncompatible: -32011,
    /** A run request was missing a required identity or posture field. */
    IdentityMissing: -32012,
    /** The run was refused for a non-identity policy reason. */
    RunRefused: -32013,
};
/**
 * The version-compatibility predicate, evaluated identically by BOTH ends so the
 * decision can never diverge. v1 requires an EXACT protocol-version match: there
 * is no negotiated-down compatibility window yet, and the spec forbids a silent
 * degraded run — a mismatch must refuse. Widen this (e.g. a min/max range) only
 * with a deliberate, tested contract change.
 *
 * @param clientVersion the client's BRIDGE_PROTOCOL_VERSION
 * @param serverVersion the supervisor's reported bridgeProtocolVersion
 */
function isHandshakeCompatible(clientVersion, serverVersion) {
    return (Number.isInteger(clientVersion) &&
        Number.isInteger(serverVersion) &&
        clientVersion === serverVersion);
}
/** The full set of actor types, for validation. */
exports.ACTOR_TYPES = [
    'native',
    'claude-code-cli',
    'codex-cli',
];
/** The full set of postures, for validation. */
exports.EXTENSION_POSTURES = [
    'sovereign',
    'developer',
];
/** The full set of autonomy tiers, for validation. */
exports.AUTONOMY_TIERS = [
    'disabled',
    'allowlist',
    'auto',
    'turbo',
];
/** The full set of run-trust postures, for validation. */
exports.RUN_TRUSTS = [
    'trusted',
    'governed-unsandboxed',
    'untrusted',
    'refused',
];
/* ============================================================== *
 * MODEL RPC RUNTIME VALIDATORS (MIRROR of spikes/p0-contracts/model.ts).
 *
 * These give the extension a runtime predicate over the SAME shared JSON fixtures
 * the canonical side validates (test/modelRpcFixtureConformance.test.mjs), so model
 * param/result drift — and especially CREDENTIAL-ADJACENT drift — is caught in CI
 * rather than at runtime. They MUST stay byte-for-byte equivalent in behavior to the
 * canonical validators; the fixture conformance test fails if they diverge.
 * ============================================================== */
/**
 * Field-name pattern for credential-shaped keys that must NEVER appear anywhere in a
 * model RPC param/result. Mirrors the canonical MODEL_CREDENTIAL_FIELD_RE and the
 * webview scrubber pattern (chatView.js) so host, webview, and supervisor agree.
 */
exports.MODEL_CREDENTIAL_FIELD_RE = /^(credential|token|api[_-]?key|apikey|authorization|auth[_-]?header|secret|bearer|access[_-]?token|provider[_-]?token)$/i;
/** True iff `o` is a non-null object (and not an array). */
function isModelObj(o) {
    return typeof o === 'object' && o !== null && !Array.isArray(o);
}
/**
 * Recursively scan `value` for any credential-shaped KEY. Returns the dotted path of
 * the first offender, or undefined. Walks plain objects and arrays only.
 */
function findCredentialField(value, pathPrefix = '') {
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            const hit = findCredentialField(value[i], `${pathPrefix}[${i}]`);
            if (hit)
                return hit;
        }
        return undefined;
    }
    if (isModelObj(value)) {
        for (const key of Object.keys(value)) {
            if (exports.MODEL_CREDENTIAL_FIELD_RE.test(key))
                return pathPrefix ? `${pathPrefix}.${key}` : key;
            const hit = findCredentialField(value[key], pathPrefix ? `${pathPrefix}.${key}` : key);
            if (hit)
                return hit;
        }
    }
    return undefined;
}
function modelNonEmptyString(v) {
    return typeof v === 'string' && v.trim().length > 0;
}
/** Validate a {@link ModelCallParams} payload (model/call request). */
function validateModelCallParams(input) {
    const problems = [];
    if (!isModelObj(input))
        return { ok: false, problems: ['not-an-object'] };
    if (!modelNonEmptyString(input.runId))
        problems.push('runId');
    if (!modelNonEmptyString(input.provider))
        problems.push('provider');
    if (!modelNonEmptyString(input.model))
        problems.push('model');
    if (!modelNonEmptyString(input.provenanceLabel))
        problems.push('provenanceLabel');
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
        problems.push('messages');
    }
    else {
        for (const m of input.messages) {
            if (!isModelObj(m) || !modelNonEmptyString(m.role) || typeof m.content !== 'string') {
                problems.push('messages');
                break;
            }
        }
    }
    if (input.contextSources !== undefined && !Array.isArray(input.contextSources)) {
        problems.push('contextSources');
    }
    const cred = findCredentialField(input);
    if (cred)
        problems.push(`credential:${cred}`);
    return problems.length ? { ok: false, problems } : { ok: true };
}
/** Validate a {@link ModelCallResult} payload (model/call result). */
function validateModelCallResult(input) {
    const problems = [];
    if (!isModelObj(input))
        return { ok: false, problems: ['not-an-object'] };
    if (!modelNonEmptyString(input.decision))
        problems.push('decision');
    if (typeof input.ok !== 'boolean')
        problems.push('ok');
    if (input.completion !== undefined && typeof input.completion !== 'string')
        problems.push('completion');
    if (input.error !== undefined && typeof input.error !== 'string')
        problems.push('error');
    if (input.traceEventRef !== undefined && typeof input.traceEventRef !== 'string')
        problems.push('traceEventRef');
    if (input.usage !== undefined && !isModelObj(input.usage))
        problems.push('usage');
    const cred = findCredentialField(input);
    if (cred)
        problems.push(`credential:${cred}`);
    return problems.length ? { ok: false, problems } : { ok: true };
}
/** Validate a {@link ModelAllowlistResult} payload (model/allowlist result). */
function validateModelAllowlistResult(input) {
    const problems = [];
    if (!isModelObj(input))
        return { ok: false, problems: ['not-an-object'] };
    if (!Array.isArray(input.models)) {
        problems.push('models');
    }
    else {
        for (const m of input.models) {
            if (!isModelObj(m) ||
                !modelNonEmptyString(m.provider) ||
                !modelNonEmptyString(m.model) ||
                !modelNonEmptyString(m.endpointHost) ||
                !modelNonEmptyString(m.label)) {
                problems.push('models');
                break;
            }
        }
    }
    const cred = findCredentialField(input);
    if (cred)
        problems.push(`credential:${cred}`);
    return problems.length ? { ok: false, problems } : { ok: true };
}
/** The full set of terminal env postures, for validation. */
exports.TERMINAL_ENV_POSTURES = [
    'sanitized',
    'untrusted',
];
/** The full set of assurance levels, for validation. */
exports.TERMINAL_VERDICT_ASSURANCES = [
    'full',
    'degraded',
];
/** Validate a {@link TerminalStartResult} payload (credential firewall + shape). */
function validateTerminalStartResult(input) {
    const problems = [];
    if (!isModelObj(input))
        return { ok: false, problems: ['not-an-object'] };
    if (!modelNonEmptyString(input.runId))
        problems.push('runId');
    if (!modelNonEmptyString(input.proxyUrl))
        problems.push('proxyUrl');
    if (!modelNonEmptyString(input.posture) ||
        !exports.TERMINAL_ENV_POSTURES.includes(input.posture)) {
        problems.push('posture');
    }
    if (!exports.RUN_TRUSTS.includes(input.trust)) {
        problems.push('trust');
    }
    const cred = findCredentialField(input);
    if (cred)
        problems.push(`credential:${cred}`);
    return problems.length ? { ok: false, problems } : { ok: true };
}
/** Validate a {@link TerminalStopResult} payload (credential firewall + shape). */
function validateTerminalStopResult(input) {
    const problems = [];
    if (!isModelObj(input))
        return { ok: false, problems: ['not-an-object'] };
    if (!modelNonEmptyString(input.runId))
        problems.push('runId');
    const v = input.verdict;
    if (!isModelObj(v)) {
        problems.push('verdict');
    }
    else {
        if (!Array.isArray(v.checks))
            problems.push('verdict.checks');
        if (v.overallVerdict !== 'pass' && v.overallVerdict !== 'fail' && v.overallVerdict !== 'error') {
            problems.push('verdict.overallVerdict');
        }
        if (!modelNonEmptyString(v.traceRootHash))
            problems.push('verdict.traceRootHash');
        if (!modelNonEmptyString(v.assurance) ||
            !exports.TERMINAL_VERDICT_ASSURANCES.includes(v.assurance)) {
            problems.push('verdict.assurance');
        }
    }
    const cred = findCredentialField(input);
    if (cred)
        problems.push(`credential:${cred}`);
    return problems.length ? { ok: false, problems } : { ok: true };
}
/**
 * Validate a run request against the §10.3 required-field contract. Pure and
 * shared so the CLIENT can refuse to send an incomplete request AND the future
 * SERVER can independently re-validate what arrived on the wire (never trusting
 * the client to have checked).
 *
 * Required for a request to be even ELIGIBLE for trust:
 *   - actorType        ∈ ACTOR_TYPES
 *   - autonomyTier     ∈ AUTONOMY_TIERS
 *   - policyPath       non-empty string
 *   - policyHash       non-empty string
 *   - workspaceRoot    non-empty string
 *   - runtimeProfile   non-empty string
 *   - extensionPosture ∈ EXTENSION_POSTURES
 *   - exactly one of sourceCommit / worktreeBase is a non-empty string
 *
 * A FAILED validation never yields a trusted run: the caller maps it to
 * {@link RunTrust} 'untrusted' or 'refused'. The optional `actorVersion` is not
 * required (it is "where available" per §10.3).
 */
function validateRunRequest(input) {
    const missing = [];
    const req = (input ?? {});
    const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
    if (!nonEmptyString(req.actorType) || !exports.ACTOR_TYPES.includes(req.actorType)) {
        missing.push('actorType');
    }
    if (!nonEmptyString(req.autonomyTier) ||
        !exports.AUTONOMY_TIERS.includes(req.autonomyTier)) {
        missing.push('autonomyTier');
    }
    if (!nonEmptyString(req.policyPath))
        missing.push('policyPath');
    if (!nonEmptyString(req.policyHash))
        missing.push('policyHash');
    if (!nonEmptyString(req.workspaceRoot))
        missing.push('workspaceRoot');
    if (!nonEmptyString(req.runtimeProfile))
        missing.push('runtimeProfile');
    if (!nonEmptyString(req.extensionPosture) ||
        !exports.EXTENSION_POSTURES.includes(req.extensionPosture)) {
        missing.push('extensionPosture');
    }
    // Exactly one base anchor (a commit OR a worktree base) is required: a run
    // with neither has no provenance anchor; a run claiming both is ambiguous.
    const hasCommit = nonEmptyString(req.sourceCommit);
    const hasBase = nonEmptyString(req.worktreeBase);
    if (hasCommit === hasBase) {
        missing.push('sourceCommit|worktreeBase');
    }
    if (missing.length > 0) {
        return { ok: false, missing };
    }
    return { ok: true, request: req };
}
/* ============================================================== *
 * ENVELOPE GUARDS (used by the transport on the receive path)
 * ============================================================== */
/** Type guard: a value is a well-formed bridge envelope (right dialect tag). */
function isEnvelope(value) {
    return (typeof value === 'object' &&
        value !== null &&
        value.glyphspek === exports.BRIDGE_JSONRPC);
}
/** Type guard: a value is a response (has an id and a result/error). */
function isResponse(value) {
    if (!isEnvelope(value))
        return false;
    const v = value;
    return typeof v.id === 'number' && ('result' in v || 'error' in v);
}
/** Type guard: a value is a server→client notification. */
function isNotification(value) {
    if (!isEnvelope(value))
        return false;
    const v = value;
    return v.id === undefined && typeof v.method === 'string';
}
//# sourceMappingURL=bridgeProtocol.js.map