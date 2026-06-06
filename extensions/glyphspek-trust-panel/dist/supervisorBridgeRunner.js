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
exports.CHAT_BACKEND_ID = void 0;
exports.buildBridgeEnv = buildBridgeEnv;
exports.createRunViaBridge = createRunViaBridge;
exports.startRunViaBridge = startRunViaBridge;
exports.startGovernedTerminalSession = startGovernedTerminalSession;
exports.openChatSession = openChatSession;
exports.runAgenticBuild = runAgenticBuild;
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const bridge_1 = require("./bridge");
const supervisorHash_1 = require("./supervisorHash");
const runEventProtocol_1 = require("./runEventProtocol");
/*
 * M5 §14 — when a LIVE-STREAMING session's connect (spawn → hash-pin → handshake)
 * REFUSES, the panel got NO distinct failure card (the run never opened, so no
 * run/event ever streamed): a hash-mismatch / incompatible-version / handshake-auth
 * refusal silently surfaced as just a `refused` outcome the command path reported in
 * a toast. We now ALSO emit a distinct §14 `failure` run-event into the run-event
 * sink so the Trust Panel renders the matching supervisor_hash_mismatch /
 * incompatible_supervisor / bridge_auth_failure card — the same fail-closed,
 * de-authoritated signal the host already emits for bridge_mismatch.
 *
 * The connect failed before the supervisor minted a runId, so we anchor the event to
 * a STABLE synthetic id (a run that never opened); the webview's run-view keys on it
 * fine and the card honestly represents the refused connect. `spawn-failed` maps to
 * no distinct §14 state (bridgeConnectFailureEvent returns null) — it stays a generic
 * refusal. Resolve-never-reject contract is preserved: a throwing sink is swallowed.
 */
function emitBridgeConnectFailure(onRunEvent, status, message, output) {
    const event = (0, runEventProtocol_1.bridgeConnectFailureEvent)(BRIDGE_CONNECT_FAILURE_RUN_ID, status, message);
    if (!event)
        return; // spawn-failed / connected: no distinct §14 state.
    try {
        onRunEvent(event);
    }
    catch (err) {
        output.appendLine(`[host] §14 connect-failure emission sink threw (ignored): ${String(err?.message ?? err)}`);
    }
}
/** Stable synthetic run id for a connect that refused before a run was minted. */
const BRIDGE_CONNECT_FAILURE_RUN_ID = 'bridge-connect-failure';
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
    // The bridge-server child is spawned with cwd = runsBase (see the SupervisorBridge
    // construction below). Node's child_process.spawn reports a MISLEADING
    // `spawn <execPath> ENOENT` when the cwd directory does not exist — and resolveRunsBase()
    // namespaces by workspace, so a freshly-opened project's runs dir has never been created.
    // Create it HERE so EVERY bridge spawn site (chat, run, build) is covered, not just the
    // call sites that remembered to mkdir. Best-effort: a genuine failure surfaces downstream
    // as the spawn's own error rather than throwing out of env-building.
    try {
        fs.mkdirSync(runsBase, { recursive: true });
    }
    catch {
        /* non-fatal: if the dir truly cannot be created, the spawn below reports it */
    }
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
    return path.join(os.homedir(), '.glyphspek', 'runs');
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
            // M5 §14 — surface the refusal as a DISTINCT failure card (hash-mismatch /
            // incompatible-supervisor / bridge-auth-failure) so the panel de-authoritates
            // it, not just a silent `refused` outcome.
            emitBridgeConnectFailure(opts.onRunEvent, connect.status, connect.message, output);
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
/**
 * Spawn the packaged bridge-server, connect (spawn + hash-pin + handshake), call
 * `terminal/start` (no client egress field — egress is supervisor-owned), KEEP THE
 * CHILD ALIVE, register the run-event handler so the supervisor streams the live
 * `run/event` sequence into {@link StartGovernedTerminalOptions.onRunEvent}, and
 * return a session handle whose `stop()` finalizes the run.
 *
 * Resolve-never-reject: every failure resolves with a populated, non-started outcome
 * the Trust Panel + command path can render (and NEVER opens an ungoverned terminal).
 * The session is NEVER product-trusted — `trust` is `governed-unsandboxed`.
 */
async function startGovernedTerminalSession(opts) {
    const { output } = opts;
    const env = buildBridgeEnv(opts);
    output.appendLine('');
    output.appendLine('[host] GlyphSpek governed terminal — spawning packaged bridge-server.');
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
    // Register the live feed BEFORE any RPC so no streamed event is dropped.
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
            // M5 §14 — surface the refusal as a DISTINCT failure card before the session
            // collapses to a `refused` outcome.
            emitBridgeConnectFailure(opts.onRunEvent, connect.status, connect.message, output);
            disposeOnce();
            return {
                started: false,
                trust: 'refused',
                message: connect.message || `bridge connect failed: ${connect.status}`,
            };
        }
        const supervisorVersion = connect.handshake?.supervisorVersion;
        // OPEN the governed terminal session. terminal/start carries the §10.3 run
        // identity ONLY — NO client egress field (egress is supervisor-owned, sweep-23).
        const start = await bridge.terminalStart({ request: opts.request });
        if (!start.ok) {
            disposeOnce();
            return {
                started: false,
                trust: 'governed-unsandboxed',
                ...(supervisorVersion ? { supervisorVersion } : {}),
                message: start.reason,
            };
        }
        // KEEP THE CHILD ALIVE for the session's lifetime. The session handle's stop()
        // calls terminal/stop and disposes the child.
        let stopped = false;
        // G7/E18 — the governance-loss listeners. The bridge fires its child-exit handler
        // ONCE on an UNEXPECTED child/proxy death; we fan it out to subscribers. A graceful
        // stop() CLEARS the bridge handler first so an intentional teardown does not look like
        // governance loss.
        const lossListeners = new Set();
        let lossFired = false;
        bridge.setChildExitHandler(() => {
            if (lossFired || stopped) {
                return;
            }
            lossFired = true;
            for (const l of [...lossListeners]) {
                try {
                    l();
                }
                catch {
                    /* best-effort: a governance-loss subscriber must never break teardown */
                }
            }
        });
        const session = {
            runId: start.runId,
            onGovernanceLoss(listener) {
                lossListeners.add(listener);
                return { dispose: () => { lossListeners.delete(listener); } };
            },
            async stop() {
                if (stopped) {
                    return { finalized: false, message: 'terminal session already stopped.' };
                }
                stopped = true;
                // An intentional teardown must NOT surface as governance loss: clear the bridge's
                // child-exit handler so the disposeOnce() below cannot fire G7.
                bridge.clearChildExitHandler();
                try {
                    const fin = await bridge.terminalStop({ runId: start.runId });
                    if (!fin.ok) {
                        return { finalized: false, message: fin.reason };
                    }
                    return { finalized: true, verdict: fin.verdict, message: '' };
                }
                catch (err) {
                    return {
                        finalized: false,
                        message: `terminal/stop failed: ${String(err?.message ?? err)}`,
                    };
                }
                finally {
                    disposeOnce();
                }
            },
        };
        return {
            started: true,
            runId: start.runId,
            proxyUrl: start.proxyUrl,
            posture: start.posture,
            trust: start.trust,
            ...(supervisorVersion ? { supervisorVersion } : {}),
            message: '',
            session,
        };
    }
    catch (err) {
        disposeOnce();
        return {
            started: false,
            trust: 'refused',
            message: `governed terminal failed: ${String(err?.message ?? err)}`,
        };
    }
}
/** The default chat backend id the native chat window drives (codex exec). */
exports.CHAT_BACKEND_ID = 'codex';
/**
 * Open a native-chat session: spawn the packaged bridge-server, connect (spawn +
 * hash-pin + handshake), and return a {@link ChatSession} whose `sendTurn` drives
 * each turn through chat/send and streams the chat/delta reply. The bridge child is
 * kept ALIVE for the session's lifetime (reused across turns) and torn down by
 * `dispose()`. Resolve-never-reject: a connect failure resolves with a non-connected
 * outcome the command path can render honestly.
 */
async function openChatSession(opts) {
    const { output } = opts;
    // buildBridgeEnv only reads runsBase/supervisorVersion off opts; a chat session
    // carries no §10.3 run request, so pass the env-relevant fields only.
    const env = buildBridgeEnv(opts);
    output.appendLine('');
    output.appendLine('[host] GlyphSpek native chat — spawning packaged bridge-server.');
    output.appendLine(`[host] bridge-server: ${opts.bridgeServerPath}`);
    output.appendLine(`[host] runs base: ${env.GLYPHSPEK_RUNS_BASE}`);
    const bridge = new bridge_1.SupervisorBridge({
        binaryPath: opts.bridgeServerPath,
        expectedSha256: supervisorHash_1.BUNDLED_BRIDGE_SERVER_SHA256,
        execPath: process.execPath,
        env,
        cwd: env.GLYPHSPEK_RUNS_BASE,
        extensionVersion: opts.extensionVersion,
        // Bind the supervisor's index/retrieve to THIS session's workspace via the trusted
        // handshake channel (when a workspace folder is open).
        ...(typeof opts.workspaceRoot === 'string' && opts.workspaceRoot.trim().length > 0
            ? { workspaceRoot: opts.workspaceRoot.trim() }
            : {}),
        log: output,
        spawn: opts.spawn ?? bridge_1.defaultBridgeSpawn,
        ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    });
    // The chat/delta stream is delivered to the CURRENT in-flight turn's sink, which is
    // bound BEFORE chat/send is issued (a delta can arrive synchronously with — or even
    // ahead of — the ack, so we must already be listening). Exactly ONE turn is in
    // flight at a time (the caller awaits each turn's settle before sending the next),
    // so a per-connection serialized stream maps unambiguously to the active turn; we do
    // NOT gate on turnId (which we may not yet know when the first delta lands). The
    // event still CARRIES its turnId for the sink to render/assert.
    let activeSink;
    let settleActive;
    bridge.setChatDeltaHandler((event) => {
        if (!event)
            return;
        try {
            activeSink?.(event);
        }
        catch (err) {
            output.appendLine(`[host] chat-delta sink threw (ignored): ${String(err?.message ?? err)}`);
        }
        if (event.type === 'done')
            settleActive?.({ ok: true });
        else if (event.type === 'error')
            settleActive?.({ ok: false, message: event.message });
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
                message: connect.message || `bridge connect failed: ${connect.status}`,
            };
        }
        const supervisorVersion = connect.handshake?.supervisorVersion;
        // SINGLE-TURN SERIALIZATION (sweep finding #2). The chat/delta stream is a
        // per-connection serialized feed routed to the ONE in-flight turn's sink
        // (activeSink/settleActive are single slots). Two overlapping sendTurn() calls
        // would otherwise both write activeSink and cross their streams / mis-settle.
        // We therefore CHAIN every send behind the previous one: each call appends to a
        // tail promise so a turn only binds the active slots AFTER the prior turn has
        // settled and cleared them. Callers may fire concurrently; the session runs them
        // FIFO, each to completion, with no crossed streams and no hang. The tail never
        // rejects (runOneTurn resolves-never-rejects), so a failed turn does not wedge
        // the queue for the next caller.
        let turnQueue = Promise.resolve();
        const runOneTurn = async (messages, handlers) => {
            if (disposed) {
                return { ok: false, message: 'chat session is closed.' };
            }
            // Bind THIS turn's sink. The ack returns the turnId; deltas for it then
            // flow to handlers.onEvent until the terminal done/error settles the turn.
            let settled = false;
            const settlePromise = new Promise((resolve) => {
                settleActive = (outcome) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve(outcome);
                };
            });
            activeSink = handlers.onEvent;
            const ack = await bridge.chatSend({ backendId: exports.CHAT_BACKEND_ID, messages });
            if (!ack.ok) {
                // No stream will arrive — synthesize a terminal error so the UI finalizes.
                const message = ack.reason;
                activeSink = undefined;
                settleActive = undefined;
                try {
                    handlers.onEvent({ turnId: 'chat-error', type: 'error', message });
                }
                catch {
                    /* sink threw — the outcome below still reports the failure */
                }
                return { ok: false, message };
            }
            const outcome = await settlePromise;
            // The turn settled (done/error delivered). Clear the active binding.
            activeSink = undefined;
            settleActive = undefined;
            return { ok: outcome.ok, turnId: ack.turnId, ...(outcome.message ? { message: outcome.message } : {}) };
        };
        const session = {
            sendTurn(messages, handlers) {
                // Enqueue behind the current tail so turns run strictly FIFO; the next turn
                // starts only after this one resolves and has cleared the active slots.
                const result = turnQueue.then(() => runOneTurn(messages, handlers));
                // Advance the tail with a never-rejecting link so a thrown turn can't wedge
                // the queue. (runOneTurn resolves-never-rejects, but be defensive.)
                turnQueue = result.then(() => undefined, () => undefined);
                return result;
            },
            // Repo-aware retrieval (@Codebase). Delegates straight to the bridge client, which
            // resolves-never-rejects (best-effort): a disposed/failed session yields
            // { ok:false, hits:[] } so the chat handler degrades to NO repo context.
            indexRetrieve(params) {
                if (disposed) {
                    return Promise.resolve({ ok: false, hits: [], error: 'chat session is closed.' });
                }
                return bridge.indexRetrieve(params);
            },
            webFetch(params) {
                if (disposed) {
                    return Promise.resolve({
                        ok: false,
                        originalUrl: params.url,
                        marker: '[@Web: fetch failed — no active governed session]',
                        reason: 'chat session is closed.',
                    });
                }
                return bridge.webFetch(params);
            },
            // On-demand index build/rebuild (the "Index Workspace" command). Same best-effort
            // posture: a disposed/failed session yields { ok:false } so the command never throws.
            // Forwards onProgress/timeoutMs so the build STREAMS progress (the percent + the
            // reset-on-progress that keeps a long build's request alive).
            indexBuild(params, opts) {
                if (disposed) {
                    return Promise.resolve({ ok: false, error: 'chat session is closed.' });
                }
                return bridge.indexBuild(params, opts);
            },
            dispose: disposeOnce,
        };
        return {
            connected: true,
            ...(supervisorVersion ? { supervisorVersion } : {}),
            message: '',
            session,
        };
    }
    catch (err) {
        disposeOnce();
        return {
            connected: false,
            message: `chat session failed: ${String(err?.message ?? err)}`,
        };
    }
}
/**
 * Spawn the packaged bridge-server, connect (spawn + hash-pin + handshake), register
 * the build-event sink, send `build/start` (carrying the up-front authority grant),
 * KEEP THE CHILD ALIVE across the streamed `build/event` sequence, capture the terminal
 * `result` (the AgenticBuildReview) or `error`, then dispose.
 *
 * Resolve-never-reject: a connect/refusal/transport failure resolves with a populated,
 * non-started outcome the command path can render honestly (and NEVER spawns codex when
 * unapproved — the supervisor refuses, and {@link SupervisorBridge.startAgenticBuild}
 * additionally refuses to put an un-approved request on the wire).
 */
async function runAgenticBuild(opts) {
    const { output } = opts;
    const env = buildBridgeEnv(opts);
    output.appendLine('');
    output.appendLine('[host] GlyphSpek governed agentic build — spawning packaged bridge-server.');
    output.appendLine(`[host] bridge-server: ${opts.bridgeServerPath}`);
    output.appendLine(`[host] cwd (REAL, governed-unsandboxed): ${opts.cwd}`);
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
    let disposed = false;
    const disposeOnce = () => {
        if (disposed)
            return;
        disposed = true;
        bridge.dispose();
    };
    // The build is SINGLE-IN-FLIGHT for this connection (one build per runAgenticBuild
    // call), so a per-connection sink maps unambiguously to the active build. Capture the
    // terminal result/error to settle the streamed promise. Register the sink BEFORE any
    // RPC so an event that races the ack is never dropped.
    let capturedReview;
    let settle;
    bridge.setBuildEventHandler((event) => {
        if (!event)
            return;
        try {
            opts.onBuildEvent(event);
        }
        catch (err) {
            output.appendLine(`[host] build-event sink threw (ignored): ${String(err?.message ?? err)}`);
        }
        if (event.type === 'result') {
            capturedReview = event.review;
            settle?.({ ok: true });
        }
        else if (event.type === 'error') {
            settle?.({ ok: false, message: event.message });
        }
    });
    try {
        const connect = await bridge.connect();
        if (connect.status !== 'connected') {
            disposeOnce();
            return {
                started: false,
                message: connect.message || `bridge connect failed: ${connect.status}`,
            };
        }
        const supervisorVersion = connect.handshake?.supervisorVersion;
        // Bind the terminal-event settle BEFORE build/start so a result/error that races the
        // ack still settles the build.
        const settlePromise = new Promise((resolve) => {
            settle = resolve;
        });
        const ack = await bridge.startAgenticBuild({
            prompt: opts.prompt,
            cwd: opts.cwd,
            approved: opts.approved,
        });
        if (!ack.ok) {
            // Refused (unapproved) or transport error — no stream will arrive. Synthesize a
            // terminal error event so the caller's UI finalizes, then return not-started.
            try {
                opts.onBuildEvent({ runId: 'build-refused', type: 'error', message: ack.reason });
            }
            catch {
                /* sink threw — the outcome below still reports the failure */
            }
            disposeOnce();
            return {
                started: false,
                ...(supervisorVersion ? { supervisorVersion } : {}),
                message: ack.reason,
            };
        }
        // The build was accepted; wait for the terminal result/error to settle.
        const outcome = await settlePromise;
        disposeOnce();
        return {
            started: true,
            runId: ack.runId,
            ...(capturedReview ? { review: capturedReview } : {}),
            ...(supervisorVersion ? { supervisorVersion } : {}),
            message: outcome.ok ? '' : (outcome.message ?? 'build failed'),
        };
    }
    catch (err) {
        disposeOnce();
        return {
            started: false,
            message: `governed agentic build failed: ${String(err?.message ?? err)}`,
        };
    }
}
//# sourceMappingURL=supervisorBridgeRunner.js.map