"use strict";
/*
 * GlyphSpek supervisor BRIDGE runner — extension-host launcher for the packaged,
 * hash-pinned bridge-server artifact (dist-supervisor/bridge-server.mjs).
 *
 * This is the production seam that turns the bridge CLIENT (bridge.ts) into a REAL
 * end-to-end run-creation path: it resolves the bundled bridge-server, constructs a
 * SupervisorBridge pointed at it, drives spawn → hash-pin → bridge/handshake →
 * run/create against the ACTUAL spawned supervisor, and returns the REAL
 * {runId, trust} the supervisor minted — not a mock/stub gateway.
 *
 * It is the bridge counterpart of supervisorRunner.ts (which launches the
 * verify-only/autonomous governed-run CLI). Both:
 *   - re-run the current Electron/Node binary as plain Node (ELECTRON_RUN_AS_NODE),
 *     so no separate Node install is required;
 *   - minimize the child's environment (the supervisor is handed trust-bearing
 *     capabilities, so it must not inherit the host's full env);
 *   - resolve-never-reject: every failure resolves with a populated outcome the
 *     caller can render in the Trust Panel, never a throw into the command path.
 *
 * TRUST DIVISION: this runner does not judge trust. It surfaces EXACTLY the trust
 * posture the supervisor settled the run into (the runtime-trust gate — e.g.
 * local-exec → untrusted — lives server-side in bridge-server.ts). A spawn /
 * hash-pin / handshake failure is surfaced as a distinct, non-trusted outcome.
 *
 * PRIVACY (spec §9): like bridge.ts, this module is imported internally by
 * extension.ts and is NOT re-exported on the extension's public API surface.
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
exports.createRunViaBridge = createRunViaBridge;
exports.startRunViaBridge = startRunViaBridge;
const os = __importStar(require("node:os"));
const bridge_1 = require("./bridge");
const supervisorHash_1 = require("./supervisorHash");
/**
 * Environment-variable names forwarded into the bridge-server child WHEN PRESENT,
 * beyond the always-set ELECTRON_RUN_AS_NODE / PATH / HOME and the two
 * GLYPHSPEK_* knobs this runner sets. Mirrors supervisorRunner's allowlist so the
 * bridge-server can also reach Docker/Colima when a created run later needs it.
 * The rest of process.env is intentionally NOT propagated (env minimization).
 */
const FORWARDED_ENV_KEYS = [
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'GLYPHSPEK_SANDBOX_IMAGE',
    'TMPDIR',
    'LANG',
];
/**
 * Build the MINIMAL environment for the bridge-server child. Mirrors
 * supervisorRunner.buildMinimalEnv: ELECTRON_RUN_AS_NODE=1, host PATH/HOME, the
 * runtime-relevant allowlist, any COLIMA_* var, plus the two GLYPHSPEK_* knobs the
 * bridge-server-cli reads (runs base + reported supervisor version). The rest of
 * process.env is intentionally dropped.
 */
function buildBridgeEnv(opts) {
    const src = process.env;
    const runsBase = opts.runsBase ?? defaultRunsBase();
    const env = {
        ELECTRON_RUN_AS_NODE: '1',
        GLYPHSPEK_RUNS_BASE: runsBase,
    };
    if (opts.supervisorVersion)
        env.GLYPHSPEK_SUPERVISOR_VERSION = opts.supervisorVersion;
    if (src.PATH !== undefined)
        env.PATH = src.PATH;
    if (src.HOME !== undefined)
        env.HOME = src.HOME;
    for (const key of FORWARDED_ENV_KEYS) {
        if (src[key] !== undefined)
            env[key] = src[key];
    }
    for (const key of Object.keys(src)) {
        if (key.startsWith('COLIMA_') && src[key] !== undefined) {
            env[key] = src[key];
        }
    }
    return env;
}
/** The $HOME-based default runs base (mirrors extension.ts resolveRunsBase). */
function defaultRunsBase() {
    return `${os.homedir()}/.glyphspek/runs`;
}
/**
 * Spawn the packaged bridge-server, connect (spawn + hash-pin + handshake), create
 * ONE real run, then dispose the child. Resolves (NEVER rejects) with the real
 * {runId, trust} the supervisor minted, or a distinct non-connected outcome.
 *
 * The child is re-run from process.execPath (the running Electron/Node binary)
 * with ELECTRON_RUN_AS_NODE=1, so no separate Node install is required. The bridge
 * speaks stdio NDJSON JSON-RPC to it (no loopback port).
 */
async function createRunViaBridge(opts) {
    const { output } = opts;
    const env = buildBridgeEnv(opts);
    output.appendLine('');
    output.appendLine('[host] GlyphSpek supervisor bridge — spawning packaged bridge-server.');
    output.appendLine(`[host] bridge-server: ${opts.bridgeServerPath}`);
    output.appendLine(`[host] runs base: ${env.GLYPHSPEK_RUNS_BASE}`);
    const bridge = new bridge_1.SupervisorBridge({
        binaryPath: opts.bridgeServerPath,
        // Pin the BRIDGE-SERVER's own hash (NOT the governed-run default). binaryPath
        // is the bridge-server artifact, so the gate must verify its bytes.
        expectedSha256: supervisorHash_1.BUNDLED_BRIDGE_SERVER_SHA256,
        execPath: process.execPath,
        env,
        cwd: env.GLYPHSPEK_RUNS_BASE,
        extensionVersion: opts.extensionVersion,
        log: output,
        spawn: opts.spawn ?? bridge_1.defaultBridgeSpawn,
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    });
    try {
        // (1) spawn + hash-pin + handshake. Any non-'connected' status is a distinct
        // failure the Trust Panel surfaces; no run is created.
        const connect = await bridge.connect();
        if (connect.status !== 'connected') {
            return {
                connected: false,
                trust: 'refused',
                message: connect.message || `bridge connect failed: ${connect.status}`,
            };
        }
        const supervisorVersion = connect.handshake?.supervisorVersion;
        // (2) create the REAL run. The client re-validates §10.3 locally, the server
        // re-validates independently and applies the runtime-trust gate; we surface
        // EXACTLY what the supervisor settled into.
        const run = await bridge.createRun(opts.request);
        return {
            connected: true,
            trust: run.trust,
            ...(run.runId ? { runId: run.runId } : {}),
            ...(supervisorVersion ? { supervisorVersion } : {}),
            message: run.trust === 'trusted'
                ? ''
                : run.reason ?? `run created with trust=${run.trust}`,
        };
    }
    finally {
        // Always tear down the spawned child. createRunViaBridge creates a run and
        // returns; the LIVE-streaming path (keeping the child alive across run/start)
        // is startRunViaBridge() below.
        bridge.dispose();
    }
}
/**
 * Spawn the packaged bridge-server, create a run, KEEP THE CHILD ALIVE, register
 * the run-event handler, and drive the run so the supervisor streams the LIVE
 * `run/event` sequence (run_opened → state_changed → trace_event(s) → actor_claims
 * → verifier_verdict → run_closed) into {@link StartLiveRunOptions.onRunEvent}.
 *
 * Unlike createRunViaBridge (which disposes immediately after creation), this
 * keeps the bridge child alive for the RUN'S LIFETIME — through run/start and the
 * trailing notification stream — then disposes cleanly once run/start resolves
 * (which is after run_closed has been emitted, because the supervisor emits the
 * whole sequence before acking). Resolve-never-reject: every failure resolves with
 * a populated outcome the Trust Panel can render.
 *
 * REAL-MODEL PLUG-IN POINT (server-side): the supervisor drives the run with a
 * deterministic scripted actor over the REAL pipeline (scripted-run-driver.ts);
 * replacing that with the model-driven agent loop changes nothing here — the same
 * `run/event` stream flows over the same bridge.
 */
async function startRunViaBridge(opts) {
    const { output } = opts;
    const env = buildBridgeEnv(opts);
    output.appendLine('');
    output.appendLine('[host] GlyphSpek supervisor bridge — spawning packaged bridge-server (LIVE run).');
    output.appendLine(`[host] bridge-server: ${opts.bridgeServerPath}`);
    output.appendLine(`[host] runs base: ${env.GLYPHSPEK_RUNS_BASE}`);
    const bridge = new bridge_1.SupervisorBridge({
        binaryPath: opts.bridgeServerPath,
        expectedSha256: supervisorHash_1.BUNDLED_BRIDGE_SERVER_SHA256,
        execPath: process.execPath,
        env,
        cwd: env.GLYPHSPEK_RUNS_BASE,
        extensionVersion: opts.extensionVersion,
        log: output,
        spawn: opts.spawn ?? bridge_1.defaultBridgeSpawn,
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    });
    // Register the live feed BEFORE any RPC so no streamed event is dropped: the
    // supervisor only emits run/event after run/start, but wiring early is the
    // robust ordering. The handler forwards the RAW notification params; the sink
    // (TrustPanel.postRunEvent) runs validateRunEvent + the fail-closed schema gate.
    bridge.setRunEventHandler((params) => {
        try {
            opts.onRunEvent(params);
        }
        catch (err) {
            output.appendLine(`[host] run-event sink threw (ignored): ${String(err?.message ?? err)}`);
        }
    });
    let disposed = false;
    const disposeOnce = () => {
        if (disposed)
            return;
        disposed = true;
        bridge.dispose();
    };
    try {
        const connect = await bridge.connect();
        if (connect.status !== 'connected') {
            disposeOnce();
            return {
                connected: false,
                started: false,
                trust: 'refused',
                message: connect.message || `bridge connect failed: ${connect.status}`,
            };
        }
        const supervisorVersion = connect.handshake?.supervisorVersion;
        const run = await bridge.createRun(opts.request);
        if (!run.runId) {
            disposeOnce();
            return {
                connected: true,
                started: false,
                trust: run.trust,
                ...(supervisorVersion ? { supervisorVersion } : {}),
                message: run.reason ?? `run not created (trust=${run.trust})`,
            };
        }
        // DRIVE the run. The supervisor emits the whole run/event sequence (ending in
        // run_closed) and THEN acks this call, so by the time run/start resolves the
        // panel has received the full stream. Keep the child alive across this call.
        const start = await bridge.runStart(run.runId);
        // Run is closed (or start failed) — tear the child down cleanly (no leak).
        disposeOnce();
        return {
            connected: true,
            started: start.ok,
            trust: run.trust,
            runId: run.runId,
            ...(supervisorVersion ? { supervisorVersion } : {}),
            ...(start.finalState ? { finalState: start.finalState } : {}),
            message: start.ok
                ? run.trust === 'trusted'
                    ? ''
                    : run.reason ?? `run created with trust=${run.trust}`
                : start.reason ?? 'run/start failed',
        };
    }
    catch (err) {
        // Defense-in-depth: any unexpected throw still tears the child down.
        disposeOnce();
        return {
            connected: false,
            started: false,
            trust: 'refused',
            message: `live run failed: ${String(err?.message ?? err)}`,
        };
    }
}
//# sourceMappingURL=supervisorBridgeRunner.js.map