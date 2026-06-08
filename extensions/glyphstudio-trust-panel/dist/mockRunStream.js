"use strict";
/*
 * GlyphStudio mock supervisor run-event stream (pure; NO vscode, NO node).
 *
 * A true end-to-end live supervisor isn't wired into a spawned binary yet, so the
 * live Trust Panel is driven from THIS mock — which emits the EXACT `run/event`
 * envelope shapes (runEventProtocol.ts) the supervisor-side stdio server will
 * produce. When the real server lands, it replaces this module as the source of
 * the same envelopes; the host forwarder (TrustPanel.postRunEvent) and the webview
 * renderer (media/live.js) need no change.
 *
 * Each scenario exercises a distinct path: the isolated-native happy path, plus
 * every DISTINCT failure state the panel must render distinctly (§14):
 *   - 'dev-runtime'       : non-isolated runtime → "NOT TRUSTED — dev runtime"
 *   - 'boundary-cli'      : a CLI actor in boundary-only fidelity
 *   - 'missing-signature' : a verdict with no signature
 *   - 'tampered'          : an upstream verifyChain failure (tampered trace)
 *   - 'stale-verifier'    : a verdict over an OLDER trace_root than the live trace
 *   - 'bridge-mismatch'   : a bridge hash/version mismatch
 *
 * Pure + exported so the host command drives it AND node tests assert that every
 * emitted envelope is a valid RunEvent and that the scenarios carry the
 * trust-load-bearing facts (e.g. dev-runtime is never product-trust-eligible).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MOCK_SCENARIOS = void 0;
exports.mockRunStream = mockRunStream;
const runEventProtocol_1 = require("./runEventProtocol");
exports.MOCK_SCENARIOS = [
    'isolated-native',
    'sovereign-hook-cli',
    'dev-runtime',
    'boundary-cli',
    'missing-signature',
    'tampered',
    'stale-verifier',
    'bridge-mismatch',
];
// Bind to the protocol constant so the mock stream always satisfies the schema-
// version gate (sweep-19 Medium #6); a future bump updates both in lockstep.
const REV = runEventProtocol_1.RUN_EVENT_PROTOCOL_VERSION;
/** A 64-hex placeholder hash derived from a seq (NOT a real chain hash). */
function placeholderHash(seq) {
    return (seq.toString(16) + 'a').padEnd(64, '0').slice(0, 64);
}
/** A 64-hex placeholder root from a label. */
function placeholderRoot(label) {
    let s = '';
    while (s.length < 64)
        s += label;
    return s.slice(0, 64);
}
/**
 * Build the ordered envelope sequence for a scenario. `runId` lets the caller mint
 * a stable id; `now` is injectable so tests are deterministic.
 */
function mockRunStream(scenario, runId, now = 1748539200000) {
    const out = [];
    const ts = (n) => now + n * 1000;
    // --- run_opened: the badge facts, per scenario. ---
    const opened = {
        kind: runEventProtocol_1.RunEventKind.RunOpened,
        runId,
        rev: REV,
        actorType: 'native',
        trust: 'trusted',
        runtimeProfile: 'docker',
        runtimeTrust: 'trusted',
        extensionPosture: 'sovereign',
        cliFidelity: 'n/a',
        state: 'created',
    };
    if (scenario === 'dev-runtime') {
        opened.runtimeProfile = 'local-exec';
        opened.runtimeTrust = 'untrusted';
        opened.trust = 'untrusted';
        opened.extensionPosture = 'developer';
    }
    else if (scenario === 'boundary-cli') {
        opened.actorType = 'claude-code-cli';
        opened.cliFidelity = 'boundary-only';
    }
    else if (scenario === 'sovereign-hook-cli') {
        opened.actorType = 'claude-code-cli';
        opened.cliFidelity = 'per-tool-brokered';
    }
    out.push(opened);
    // --- trace events common to every scenario. ---
    out.push({
        kind: runEventProtocol_1.RunEventKind.TraceEvent,
        runId,
        rev: REV,
        event: {
            v: 1, runId, seq: 0, ts: ts(0), type: 'run_created', prevHash: '', hash: placeholderHash(0),
            payload: { runId, runDir: '.glyphstudio/runs/' + runId, provenanceLabel: 'user' },
        },
    });
    out.push({
        kind: runEventProtocol_1.RunEventKind.StateChanged, runId, rev: REV,
        from: 'created', to: 'sandbox_ready', reason: 'sandbox ready, egress default-deny',
    });
    out.push({
        kind: runEventProtocol_1.RunEventKind.TraceEvent, runId, rev: REV,
        event: {
            v: 1, runId, seq: 1, ts: ts(1), type: 'policy_decision', prevHash: placeholderHash(0), hash: placeholderHash(1),
            payload: { tool: 'command', requestedCapability: 'command:npm', decision: 'allow', provenanceLabel: 'repo', rule: 'allow.commands: ["npm"]' },
        },
    });
    out.push({
        kind: runEventProtocol_1.RunEventKind.TraceEvent, runId, rev: REV,
        event: {
            v: 1, runId, seq: 2, ts: ts(2), type: 'tool_end', prevHash: placeholderHash(1), hash: placeholderHash(2),
            payload: { tool: 'command', argv: ['npm', 'test'], exitCode: 0, durationMs: 8300, changedFiles: [{ path: 'src/date.ts', change: 'M' }, { path: 'test/date.test.ts', change: 'A' }] },
        },
    });
    out.push({
        kind: runEventProtocol_1.RunEventKind.TraceEvent, runId, rev: REV,
        event: {
            v: 1, runId, seq: 3, ts: ts(3), type: 'policy_decision', prevHash: placeholderHash(2), hash: placeholderHash(3),
            payload: { tool: 'network', requestedCapability: 'network:registry.npmjs.org', decision: 'allow', destination: 'https://registry.npmjs.org', provenanceLabel: 'repo' },
        },
    });
    out.push({
        kind: runEventProtocol_1.RunEventKind.StateChanged, runId, rev: REV,
        from: 'sandbox_ready', to: 'completed', reason: 'actor reported complete',
    });
    // --- actor claims (always its OWN envelope, never a verdict). ---
    out.push({
        kind: runEventProtocol_1.RunEventKind.ActorClaims, runId, rev: REV,
        plan: 'Fix date parsing and add a regression test.',
        summary: 'Updated src/date.ts; all tests pass; ready to merge.',
        claimedChangedFiles: ['src/date.ts', 'test/date.test.ts'],
        claimedChecks: [
            { name: 'unit tests', claim: 'pass' },
            { name: 'typecheck', claim: 'pass' },
        ],
    });
    // --- verdict + per-scenario failure signal. ---
    if (scenario === 'missing-signature') {
        out.push({
            kind: runEventProtocol_1.RunEventKind.VerifierVerdict, runId, rev: REV,
            checks: [{ name: 'unit tests', command: ['npm', 'test'], status: 'pass' }],
            overallVerdict: 'pass', traceRootHash: placeholderRoot('deadbeef'),
            // no signature -> the model records a missing_verifier_signature failure.
        });
    }
    else if (scenario === 'tampered') {
        out.push({
            kind: runEventProtocol_1.RunEventKind.VerifierVerdict, runId, rev: REV,
            checks: [{ name: 'unit tests', command: ['npm', 'test'], status: 'pass' }],
            overallVerdict: 'pass', traceRootHash: placeholderRoot('deadbeef'),
            signature: { alg: 'ed25519', value: 'AAAA', keyId: 'k' },
        });
        out.push({
            kind: runEventProtocol_1.RunEventKind.Failure, runId, rev: REV,
            failure: runEventProtocol_1.RunFailureKind.TamperedTrace,
            message: 'trace hash-chain verification failed upstream — the trace was modified.',
            brokenIndex: 2,
        });
    }
    else if (scenario === 'stale-verifier') {
        out.push({
            kind: runEventProtocol_1.RunEventKind.VerifierVerdict, runId, rev: REV,
            checks: [{ name: 'unit tests', command: ['npm', 'test'], status: 'pass' }],
            overallVerdict: 'pass', traceRootHash: placeholderRoot('cafebabe'),
            signature: { alg: 'ed25519', value: 'AAAA', keyId: 'k' },
        });
        out.push({
            kind: runEventProtocol_1.RunEventKind.Failure, runId, rev: REV,
            failure: runEventProtocol_1.RunFailureKind.StaleVerifier,
            message: 'verifier verdict signs over an OLDER trace_root than the live trace.',
            staleRootHash: placeholderRoot('cafebabe'),
        });
    }
    else if (scenario === 'bridge-mismatch') {
        out.push({
            kind: runEventProtocol_1.RunEventKind.Failure, runId, rev: REV,
            failure: runEventProtocol_1.RunFailureKind.BridgeMismatch,
            message: 'supervisor bridge protocol/hash mismatch — refusing to treat this run as trusted.',
        });
    }
    else {
        out.push({
            kind: runEventProtocol_1.RunEventKind.VerifierVerdict, runId, rev: REV,
            checks: [
                { name: 'unit tests', command: ['npm', 'test'], status: 'pass' },
                { name: 'typecheck', command: ['npm', 'run', 'typecheck'], status: 'pass' },
            ],
            overallVerdict: 'pass', traceRootHash: placeholderRoot('feedface'),
            signature: { alg: 'ed25519', value: 'AAAA', keyId: 'verifier/2026-01' },
        });
    }
    out.push({
        kind: runEventProtocol_1.RunEventKind.RunClosed, runId, rev: REV,
        finalState: 'completed', eventCount: 5,
    });
    return out;
}
//# sourceMappingURL=mockRunStream.js.map