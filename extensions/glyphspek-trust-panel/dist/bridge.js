"use strict";
/*
 * GlyphSpek authenticated supervisor bridge — CLIENT side (M2).
 *
 * This is the FIRST-PARTY extension's PRIVATE client for the supervisor RPC. It
 * implements the spec §10 transport + auth for a governed run's CREATION step:
 *
 *   1. Hash-pin the packaged supervisor binary BEFORE spawn (§10.1) — a mismatch
 *      REFUSES to spawn (never runs unverified code that gets the verifier key).
 *   2. Spawn the supervisor as a CHILD PROCESS and speak stdio JSON-RPC over its
 *      stdin/stdout (§10.1 preferred transport). There is NO ambient loopback TCP
 *      port: the only peer that can talk to this supervisor is the process that
 *      owns the child's stdio streams — i.e. this extension host. A foreign local
 *      process cannot attach (security acceptance test §18.3).
 *   3. Perform a VERSION-COMPATIBILITY HANDSHAKE on connect (§10.2/§10 M2). On an
 *      incompatible version the bridge REFUSES the run and surfaces a DISTINCT
 *      failure state — never a silent degraded run.
 *   4. Send the typed RUN-CREATION RPC carrying every §10.3 field. If a required
 *      identity/posture field is missing, the bridge marks the run
 *      untrusted/refused — never a silent TRUSTED run.
 *
 * TRANSPORT FRAMING: newline-delimited JSON (one JSON object per line) over the
 * child's stdout (server→client) and stdin (client→server). NDJSON is chosen over
 * Content-Length framing for inspectability (the spec calls for a "simple,
 * inspectable" v1 shape) and because the supervisor already emits a single final
 * JSON line on stdout for the legacy verify-only path. The dialect tag
 * ({@link BRIDGE_JSONRPC}) on every envelope rejects a stray foreign JSON-RPC peer
 * on the same stream.
 *
 * PRIVACY (spec §9): this module is NOT exported from the extension's public API
 * surface. extension.ts imports it internally; nothing in package.json's
 * `contributes`/`extensionExports` exposes a way for a third-party extension to
 * obtain a bridge and invoke a trusted supervisor capability. Keeping the client
 * private to the first-party bundle is the caller-attribution boundary — stock VS
 * Code extension APIs are not a security boundary (§10.3).
 *
 * SCOPE / FOLLOW-UP: this is the CLIENT only. The SUPERVISOR-SIDE stdio JSON-RPC
 * SERVER that answers `bridge/handshake` and `run/create` is a SEPARATE task (see
 * the contract notes at the bottom of bridgeProtocol.ts and the report). This
 * client is written against the shared bridgeProtocol.ts contract so that server
 * can implement the exact same grammar.
 *
 * Resolve-never-reject: like supervisorRunner.runSupervisor(), the public methods
 * resolve with a populated outcome object rather than throwing, so the command
 * handler never wraps the bridge in try/catch around process lifecycle.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupervisorBridge = exports.defaultBridgeSpawn = void 0;
const node_child_process_1 = require("node:child_process");
const supervisorBinary_1 = require("./supervisorBinary");
const bridgeProtocol_1 = require("./bridgeProtocol");
/** The default production spawn: real child process, stdio piped. */
const defaultBridgeSpawn = (command, args, options) => (0, node_child_process_1.spawn)(command, args, options);
exports.defaultBridgeSpawn = defaultBridgeSpawn;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * The private supervisor bridge client. Construct, then `connect()` (spawn +
 * hash-pin + handshake), then `createRun()`. Always `dispose()` to tear down the
 * child. The class is NOT exported as a public extension API (see file header).
 */
class SupervisorBridge {
    constructor(options) {
        this.nextId = 1;
        this.pending = new Map();
        this.stdoutBuffer = '';
        this.closed = false;
        this.closeReason = '';
        /** Set once a compatible handshake completes; gates createRun(). */
        this.ready = false;
        this.opts = options;
        this.spawnFn = options.spawn ?? exports.defaultBridgeSpawn;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }
    /** Register a handler for streamed run-event notifications (Trust Panel feed). */
    setRunEventHandler(handler) {
        this.onRunEvent = handler;
    }
    /**
     * Connect to the supervisor: hash-pin the binary, spawn it, and run the
     * version-compatibility handshake. Resolves (never rejects) with a distinct
     * status. On any non-'connected' status the child (if spawned) is torn down.
     */
    async connect() {
        // (1) HASH-PIN BEFORE SPAWN. A mismatch refuses to spawn — we never run
        // unverified supervisor code (which would receive the verifier private key).
        const mismatch = this.opts.expectedSha256
            ? (0, supervisorBinary_1.verifyBundleHash)(this.opts.binaryPath, this.opts.expectedSha256)
            : (0, supervisorBinary_1.verifyBundleHash)(this.opts.binaryPath);
        if (mismatch) {
            this.opts.log.appendLine(`[bridge] ${mismatch}`);
            return { status: 'hash-mismatch', message: mismatch };
        }
        this.opts.log.appendLine('[bridge] supervisor binary hash verified (pinned sha256 match).');
        // (2) SPAWN over stdio. No loopback port; the child's stdio is the only seam.
        const execPath = this.opts.execPath ?? process.execPath;
        const args = [
            ...(this.opts.execArgs ?? []),
            this.opts.binaryPath,
            ...(this.opts.serveArgs ?? []),
        ];
        this.opts.log.appendLine(`[bridge] spawn: ${execPath} ${args.join(' ')}`);
        try {
            this.child = this.spawnFn(execPath, args, {
                cwd: this.opts.cwd,
                env: this.opts.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            const message = `failed to spawn supervisor: ${String(err?.message ?? err)}`;
            this.opts.log.appendLine(`[bridge] ${message}`);
            return { status: 'spawn-failed', message };
        }
        this.wireChild();
        // (3) HANDSHAKE. Refuse on incompatible versions with a DISTINCT status.
        const handshakeParams = {
            bridgeProtocolVersion: bridgeProtocol_1.BRIDGE_PROTOCOL_VERSION,
            extensionVersion: this.opts.extensionVersion,
        };
        const response = await this.request(bridgeProtocol_1.BridgeMethod.Handshake, handshakeParams);
        if (response.error) {
            const message = `handshake failed: ${response.error.message}`;
            this.opts.log.appendLine(`[bridge] ${message}`);
            this.dispose();
            return { status: 'handshake-failed', message };
        }
        const handshake = response.result;
        if (!handshake ||
            typeof handshake.bridgeProtocolVersion !== 'number' ||
            typeof handshake.supervisorVersion !== 'string') {
            const message = 'handshake failed: malformed handshake result from supervisor.';
            this.opts.log.appendLine(`[bridge] ${message}`);
            this.dispose();
            return { status: 'handshake-failed', message };
        }
        if (!(0, bridgeProtocol_1.isHandshakeCompatible)(bridgeProtocol_1.BRIDGE_PROTOCOL_VERSION, handshake.bridgeProtocolVersion)) {
            const message = `incompatible supervisor: bridge protocol v${bridgeProtocol_1.BRIDGE_PROTOCOL_VERSION} ` +
                `but supervisor speaks v${handshake.bridgeProtocolVersion} ` +
                `(supervisor ${handshake.supervisorVersion}). Refusing the run — no ` +
                `degraded run is started.`;
            this.opts.log.appendLine(`[bridge] ${message}`);
            this.dispose();
            return { status: 'version-incompatible', handshake, message };
        }
        this.ready = true;
        this.opts.log.appendLine(`[bridge] handshake OK — supervisor ${handshake.supervisorVersion}, ` +
            `protocol v${handshake.bridgeProtocolVersion}.`);
        return { status: 'connected', handshake, message: '' };
    }
    /**
     * Start (drive) a previously-created run. The supervisor runs the run's actor
     * pipeline and STREAMS the lifecycle/trace/claims/verdict back as `run/event`
     * notifications (delivered to {@link setRunEventHandler}) until run_closed; this
     * call only returns the supervisor's ACK that the run was accepted/driven.
     *
     * The bridge MUST stay alive (do NOT dispose) across this call and the trailing
     * notification stream — the caller owns the lifetime and disposes after the run
     * is closed. Resolves (never rejects) with `{ ok, finalState? }`; a transport or
     * server error resolves as `{ ok: false }` so the panel renders a stalled run
     * rather than throwing.
     */
    async runStart(runId) {
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { ok: false, reason };
        }
        if (!runId) {
            return { ok: false, reason: 'runStart requires a runId' };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.StartRun, { runId });
        if (response.error) {
            this.opts.log.appendLine(`[bridge] run/start error ${response.error.code}: ${response.error.message}`);
            return { ok: false, reason: response.error.message };
        }
        const result = response.result;
        return {
            ok: true,
            ...(result && typeof result.finalState === 'string' ? { finalState: result.finalState } : {}),
        };
    }
    /**
     * Create a governed run. The request is VALIDATED against the §10.3
     * required-field contract on the CLIENT before it is sent: a request missing a
     * required identity/posture field NEVER goes to the wire as a trusted run —
     * it resolves locally as REFUSED with the missing-field list, so the bridge
     * cannot produce a silent trusted run from a partial request.
     *
     * A run/create may only be issued after a compatible handshake; calling it on
     * an unconnected/incompatible bridge resolves as refused.
     */
    async createRun(request) {
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { trust: 'refused', reason };
        }
        // CLIENT-SIDE §10.3 validation. A missing identity/posture field => refused,
        // never a silent trusted run. The server is expected to re-validate
        // independently (it does not trust the client to have checked), but the
        // client refusing early gives a precise, local failure state.
        const validation = (0, bridgeProtocol_1.validateRunRequest)(request);
        if (!validation.ok) {
            const reason = `run request missing required field(s): ${validation.missing.join(', ')}`;
            this.opts.log.appendLine(`[bridge] ${reason} — refusing (no trusted run).`);
            return { trust: 'refused', reason, missing: validation.missing };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.CreateRun, validation.request);
        if (response.error) {
            // Map the server's identity/refusal error codes to a non-trusted outcome.
            const code = response.error.code;
            const reason = response.error.message;
            this.opts.log.appendLine(`[bridge] run/create error ${code}: ${reason}`);
            if (code === bridgeProtocol_1.BridgeErrorCode.IdentityMissing) {
                return { trust: 'untrusted', reason };
            }
            return { trust: 'refused', reason };
        }
        const result = response.result;
        if (!result || (result.trust !== 'trusted' && result.trust !== 'untrusted' && result.trust !== 'refused')) {
            const reason = 'malformed run/create result from supervisor.';
            this.opts.log.appendLine(`[bridge] ${reason} — treating as refused.`);
            return { trust: 'refused', reason };
        }
        // INVARIANT GUARD: the bridge never reports `trusted` for a run the supervisor
        // did not give a runId for. A trusted run must be a real, identified run.
        if (result.trust === 'trusted' && (!result.runId || result.runId.length === 0)) {
            const reason = 'supervisor reported trusted but no runId — treating as refused.';
            this.opts.log.appendLine(`[bridge] ${reason}`);
            return { trust: 'refused', reason };
        }
        return {
            trust: result.trust,
            ...(result.runId ? { runId: result.runId } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
        };
    }
    /* ============================================================== *
     * MODEL BROKER RPC (M6 — chat + inline-edit UI)
     * ============================================================== */
    /**
     * Query the model-broker allowlist. Returns the models the UI may offer — and
     * ONLY those. The result carries NO credential (the contract has no field for
     * one). On an unconnected bridge or a server error this resolves to an EMPTY
     * allowlist (fail-closed: the UI offers nothing rather than guessing a model).
     */
    async requestModelAllowlist() {
        if (!this.ready || !this.child || this.closed) {
            return { models: [] };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.ModelAllowlist, {});
        if (response.error || !response.result || !Array.isArray(response.result.models)) {
            this.opts.log.appendLine(`[bridge] model/allowlist failed: ${response.error?.message ?? 'malformed result'}`);
            return { models: [] };
        }
        return { models: response.result.models };
    }
    /**
     * Broker one model call (chat / inline-edit). The params carry WHAT to ask; the
     * supervisor reads the provider credential supervisor-side and the client never
     * receives it. Resolves (never rejects) with the redacted projection: decision +
     * redacted completion + usage + traceEventRef. A transport/connection failure
     * resolves as a `deny` outcome so the UI renders a blocked state rather than
     * throwing.
     *
     * INVARIANT GUARD: as a defense-in-depth check, the request envelope this method
     * sends NEVER contains a credential field (the ModelCallParams type has none);
     * the UI is structurally incapable of attaching a token here.
     */
    async requestModelCall(params) {
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { decision: 'deny', ok: false, error: reason };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.ModelCall, params);
        if (response.error) {
            this.opts.log.appendLine(`[bridge] model/call error ${response.error.code}: ${response.error.message}`);
            return { decision: 'deny', ok: false, error: response.error.message };
        }
        const result = response.result;
        if (!result || typeof result.decision !== 'string' || typeof result.ok !== 'boolean') {
            return { decision: 'deny', ok: false, error: 'malformed model/call result from supervisor.' };
        }
        return result;
    }
    /** Tear down the child and reject all pending requests. Idempotent. */
    dispose() {
        if (this.closed)
            return;
        this.closed = true;
        this.ready = false;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.resolve(this.errorResponse(0, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, 'bridge disposed'));
        }
        this.pending.clear();
        try {
            this.child?.stdin?.end?.();
        }
        catch {
            /* already gone */
        }
        try {
            this.child?.kill('SIGTERM');
        }
        catch {
            /* already gone */
        }
    }
    /* ----------------------- internals ----------------------- */
    /** Wire the child's stdout (NDJSON in) + error/close handlers. */
    wireChild() {
        const child = this.child;
        if (!child)
            return;
        child.stdout?.on('data', (chunk) => {
            this.stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            let nl;
            while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
                const line = this.stdoutBuffer.slice(0, nl).replace(/\r$/, '');
                this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
                if (line.trim().length === 0)
                    continue;
                this.handleLine(line);
            }
        });
        child.on('error', (err) => {
            this.failAllPending(`supervisor process error: ${String(err?.message ?? err)}`);
        });
        child.on('close', (code) => {
            this.closeReason =
                `supervisor exited (code ${code ?? 'null'}) before the request completed.`;
            this.failAllPending(this.closeReason);
        });
    }
    /** Parse one NDJSON line and dispatch a response or a notification. */
    handleLine(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            // Non-JSON noise on stdout (e.g. a stray log line). Ignore — the contract
            // is one JSON envelope per line; foreign lines are not protocol traffic.
            return;
        }
        if ((0, bridgeProtocol_1.isResponse)(parsed)) {
            const id = parsed.id;
            const pending = this.pending.get(id);
            if (!pending)
                return; // unmatched / late response — drop
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.resolve(parsed);
            return;
        }
        if ((0, bridgeProtocol_1.isNotification)(parsed)) {
            const note = parsed;
            if (this.onRunEvent)
                this.onRunEvent(note.params);
            return;
        }
        // Anything else (a request FROM the server, a foreign envelope) is ignored:
        // the client does not accept server-initiated requests.
    }
    /** Send a request and resolve with its response (never rejects). */
    request(method, params) {
        return new Promise((resolve) => {
            if (this.closed || !this.child) {
                resolve(this.errorResponse(0, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, this.closeReason || 'bridge not connected'));
                return;
            }
            const id = this.nextId++;
            const envelope = {
                glyphspek: bridgeProtocol_1.BRIDGE_JSONRPC,
                id,
                method,
                params,
            };
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    resolve(this.errorResponse(id, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, `request "${method}" timed out after ${this.requestTimeoutMs}ms`));
                }
            }, this.requestTimeoutMs);
            // Don't keep the event loop alive purely for a pending bridge request.
            timer.unref?.();
            this.pending.set(id, {
                resolve: resolve,
                timer,
            });
            try {
                this.child.stdin?.write(`${JSON.stringify(envelope)}\n`);
            }
            catch (err) {
                if (this.pending.delete(id)) {
                    clearTimeout(timer);
                    resolve(this.errorResponse(id, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, `failed to write request: ${String(err?.message ?? err)}`));
                }
            }
        });
    }
    /** Resolve every in-flight request with an error (used on close/process error). */
    failAllPending(message) {
        for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.resolve(this.errorResponse(id, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, message));
        }
        this.pending.clear();
    }
    /** Build a synthetic error response envelope (for local failures). */
    errorResponse(id, code, message) {
        return { glyphspek: bridgeProtocol_1.BRIDGE_JSONRPC, id, error: { code, message } };
    }
}
exports.SupervisorBridge = SupervisorBridge;
/* ============================================================== *
 * NOTE: there is intentionally NO module-level export of a singleton or factory
 * that a third-party extension could reach. extension.ts constructs a
 * SupervisorBridge directly for the first-party command path; nothing here is
 * registered as a public extension export.
 * ============================================================== */
//# sourceMappingURL=bridge.js.map