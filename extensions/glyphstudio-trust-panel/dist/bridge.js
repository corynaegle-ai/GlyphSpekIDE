"use strict";
/*
 * GlyphStudio authenticated supervisor bridge — CLIENT side (M2).
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
exports.SupervisorBridge = exports.DEFAULT_INDEX_BUILD_TIMEOUT_MS = exports.defaultBridgeSpawn = void 0;
const node_child_process_1 = require("node:child_process");
const supervisorBinary_1 = require("./supervisorBinary");
const bridgeProtocol_1 = require("./bridgeProtocol");
/**
 * The default production spawn: real child process, stdio piped. The child's
 * stderr (operator `[bridge-server]` log lines) is NOT consumed by the bridge,
 * so its pipe is unref'd and continuously drained — an unread, referenced stderr
 * pipe would otherwise keep the host's event loop open and hang `node --test`.
 */
const defaultBridgeSpawn = (command, args, options) => {
    const child = (0, node_child_process_1.spawn)(command, args, options);
    // Drain + unref the unread stderr so a chatty child never blocks on a full pipe
    // and its handle never holds the parent process open at teardown.
    const stderr = child.stderr;
    if (stderr) {
        stderr.on('data', () => {
            /* discard: the bridge surfaces failures via stdout RPCs, not child stderr */
        });
        stderr.on('error', () => {
            /* a broken stderr pipe is benign during teardown */
        });
        stderr.unref?.();
    }
    return child;
};
exports.defaultBridgeSpawn = defaultBridgeSpawn;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * The default `index/build` request timeout (30 minutes). Far longer than the global
 * 30s default because a COLD index build of a real repo is tens of seconds to several
 * MINUTES. This is the INACTIVITY BACKSTOP only: the request resets it on every
 * `index/progress` event, so the real mechanism that keeps a progressing build alive
 * is the reset-on-progress — this cap only fires if the build STALLS with no progress
 * for the whole window. Overridable via the `glyphstudio.index.buildTimeoutMs` setting.
 */
exports.DEFAULT_INDEX_BUILD_TIMEOUT_MS = 1_800_000;
/**
 * Grace period between the polite SIGTERM and the SIGKILL escalation in dispose().
 * The bridge-server exits cleanly on stdin-end/SIGTERM in the normal case; this
 * fallback guarantees a child that ignores SIGTERM (e.g. mid-run with the egress
 * proxy socket still open) is force-reaped so it never leaks past teardown.
 */
const DISPOSE_FORCE_KILL_MS = 1_000;
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
        /** Guards {@link onChildExit} so a child that emits both 'error' and 'close' fires it once. */
        this.childExitFired = false;
        this.opts = options;
        this.spawnFn = options.spawn ?? exports.defaultBridgeSpawn;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }
    /** Register a handler for streamed run-event notifications (Trust Panel feed). */
    setRunEventHandler(handler) {
        this.onRunEvent = handler;
    }
    /**
     * Register a handler fired ONCE when the supervisor child exits unexpectedly (crash /
     * proxy death / the child leaving on its own). The governed floating terminal session
     * uses this to detect MID-SESSION governance loss (G7/E18) — the bridge child dying
     * means the egress proxy is gone. A graceful, dispose()-driven stop CLEARS the handler
     * first (see {@link clearChildExitHandler}) so an intentional teardown does NOT fire it.
     */
    setChildExitHandler(handler) {
        this.onChildExit = handler;
    }
    /** Clear the child-exit handler so an intentional dispose()/stop does NOT fire G7. */
    clearChildExitHandler() {
        this.onChildExit = undefined;
    }
    /**
     * Register a handler for streamed `chat/delta` notifications (M7 chat). After a
     * {@link chatSend} ack, the supervisor emits a sequence of {@link ChatStreamEvent}s
     * tagged with the same `turnId`; this sink receives each one so the chat UI can
     * append `delta.text` and finalize on the terminal `done`/`error`.
     */
    setChatDeltaHandler(handler) {
        this.onChatDelta = handler;
    }
    /**
     * Register a handler for streamed `build/event` notifications (Phase C agentic
     * build). After a {@link startAgenticBuild} ack, the supervisor emits a sequence of
     * {@link AgenticBuildStreamEvent}s tagged with the same `runId`; this sink receives
     * each one so the build UI can surface progress (state/command/summary/fileChange)
     * and finalize on the terminal `result` (carrying the AgenticBuildReview) or `error`.
     */
    setBuildEventHandler(handler) {
        this.onBuildEvent = handler;
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
            // Bind the supervisor's index/retrieve to THIS session's workspace via the
            // trusted handshake channel (when a workspace folder is open). Omitted when
            // absent so the supervisor falls back to first-retrieve pinning.
            ...(typeof this.opts.workspaceRoot === 'string' && this.opts.workspaceRoot.trim().length > 0
                ? { workspaceRoot: this.opts.workspaceRoot.trim() }
                : {}),
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
        // Accept any posture in the canonical RUN_TRUSTS set (including
        // `governed-unsandboxed`, sweep-23 #2) rather than a hardcoded list. Product
        // trust is gated SEPARATELY below by the strict `=== 'trusted'` invariant, so
        // a non-`trusted` posture is surfaced honestly but never product-trusted.
        if (!result || !bridgeProtocol_1.RUN_TRUSTS.includes(result.trust)) {
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
    /* ============================================================== *
     * CHAT GATEWAY RPC (M7 — the native chat window over the model gateway)
     * ============================================================== */
    /**
     * Send ONE chat turn (`chat/send`) to the GlyphStudio-controlled model gateway. The
     * params carry the transcript to answer (WHAT to ask) and `backendId` selects the
     * gateway backend (default 'codex'); there is NO credential field — codex
     * authenticates from its own on-disk store and egress is governed supervisor-side.
     *
     * ACK-THEN-NOTIFICATIONS (mirrors run/start, NOT the synchronous model/call): this
     * method resolves with the supervisor's ACK ({ turnId }). The assistant reply then
     * STREAMS as `chat/delta` notifications tagged with that same `turnId`, delivered to
     * the sink registered via {@link setChatDeltaHandler}. Register the delta handler
     * BEFORE calling this (a delta could race the ack). Resolves (never rejects); a
     * transport/server error resolves as `{ ok: false }` so the chat UI renders an honest
     * failure rather than throwing.
     */
    async chatSend(params) {
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { ok: false, reason };
        }
        if (!Array.isArray(params.messages) || params.messages.length === 0) {
            return { ok: false, reason: 'chatSend requires a non-empty messages array.' };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.ChatSend, params);
        if (response.error) {
            this.opts.log.appendLine(`[bridge] chat/send error ${response.error.code}: ${response.error.message}`);
            return { ok: false, reason: response.error.message };
        }
        const result = response.result;
        if (!result || typeof result.turnId !== 'string' || result.turnId.length === 0) {
            return { ok: false, reason: 'malformed chat/send ack from supervisor (no turnId).' };
        }
        return { ok: true, turnId: result.turnId };
    }
    /**
     * Fetch ONE explicit public http(s) URL for `@Web` context. The extension only sends
     * this bridge RPC; it never performs web egress itself. The supervisor owns URL
     * validation, proxy routing, trace attribution, and content hashing.
     *
     * BEST-EFFORT / HONEST: resolves (never rejects) with a canonical `@Web` failure
     * marker on any transport/server/malformed-result failure so the chat turn can tell
     * the model and user that nothing was fetched.
     */
    async webFetch(params) {
        const originalUrl = typeof params.url === 'string' ? params.url : '';
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return {
                ok: false,
                originalUrl,
                marker: '[@Web: fetch failed — supervisor unavailable]',
                reason,
            };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.WebFetch, params);
        if (response.error) {
            this.opts.log.appendLine(`[bridge] web/fetch error ${response.error.code}: ${response.error.message}`);
            return {
                ok: false,
                originalUrl,
                marker: '[@Web: fetch failed — supervisor unavailable]',
                reason: response.error.message,
            };
        }
        const result = response.result;
        if (!result || typeof result.ok !== 'boolean') {
            return {
                ok: false,
                originalUrl,
                marker: '[@Web: fetch failed — supervisor unavailable]',
                reason: 'malformed web/fetch result from supervisor.',
            };
        }
        if (result.ok) {
            if (typeof result.finalUrl !== 'string' ||
                typeof result.text !== 'string' ||
                typeof result.fullText !== 'string' ||
                typeof result.sha256 !== 'string') {
                return {
                    ok: false,
                    originalUrl,
                    marker: '[@Web: fetch failed — supervisor unavailable]',
                    reason: 'malformed web/fetch success from supervisor.',
                };
            }
            return result;
        }
        if (typeof result.marker !== 'string' || !result.marker.startsWith('[@Web:')) {
            return {
                ok: false,
                originalUrl,
                marker: '[@Web: fetch failed — supervisor unavailable]',
                reason: 'malformed web/fetch failure from supervisor.',
            };
        }
        return result;
    }
    /* ============================================================== *
     * AGENTIC BUILD RPC (Phase C — the chat→ACTOR promotion)
     * ============================================================== */
    /**
     * Start a GOVERNED AGENTIC BUILD (`build/start`). The params carry WHAT to build
     * (`prompt`), WHERE (`cwd`), and the EXPLICIT authority grant (`approved`); there is
     * NO credential field — codex authenticates from its own ~/.codex store and egress
     * is governed supervisor-side.
     *
     * AUTHORITY GATE (the load-bearing invariant): the supervisor REFUSES the build
     * (terminal `build/event` error, codex NOT spawned) unless `approved === true`. This
     * client method does NOT itself synthesize approval — the caller is responsible for
     * the up-front operator approval before passing `approved: true` (see the promotion
     * command). A defensive client-side check refuses to send a request whose `approved`
     * is not strictly `true`, so a malformed/forged params object can never reach the wire
     * as an approved build.
     *
     * ACK-THEN-NOTIFICATIONS (mirrors run/start / chat/send): this method resolves with
     * the supervisor's ACK ({ runId }). The build then STREAMS as `build/event`
     * notifications tagged with that same `runId`, delivered to the sink registered via
     * {@link setBuildEventHandler}. Register the build-event handler BEFORE calling this
     * (an event could race the ack). Resolves (never rejects); a transport/server error
     * resolves as `{ ok: false }` so the build UI renders an honest failure rather than
     * throwing.
     */
    async startAgenticBuild(params) {
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { ok: false, reason };
        }
        if (typeof params.prompt !== 'string' || params.prompt.trim().length === 0) {
            return { ok: false, reason: 'startAgenticBuild requires a non-empty prompt.' };
        }
        if (typeof params.cwd !== 'string' || params.cwd.trim().length === 0) {
            return { ok: false, reason: 'startAgenticBuild requires an absolute cwd.' };
        }
        // DEFENSE-IN-DEPTH AUTHORITY GUARD: never put an un-approved (or non-strictly-true)
        // build request on the wire. The supervisor also refuses, but refusing here means a
        // forged/partial params object cannot even reach the sensitive boundary.
        if (params.approved !== true) {
            return { ok: false, reason: 'startAgenticBuild refused: build is not approved (no authority grant).' };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.AgenticBuildStart, params);
        if (response.error) {
            this.opts.log.appendLine(`[bridge] build/start error ${response.error.code}: ${response.error.message}`);
            return { ok: false, reason: response.error.message };
        }
        const result = response.result;
        if (!result || typeof result.runId !== 'string' || result.runId.length === 0) {
            return { ok: false, reason: 'malformed build/start ack from supervisor (no runId).' };
        }
        return { ok: true, runId: result.runId };
    }
    /* ============================================================== *
     * CODE-INDEX RETRIEVAL RPC (@Codebase repo-aware retrieval)
     * ============================================================== */
    /**
     * Retrieve top-k repo chunks from the workspace's LOCAL code index (`index/retrieve`)
     * for repo-aware chat context. SYNCHRONOUS (request/result, NOT ack-then-stream): the
     * supervisor lazily builds the on-device index for `params.workspaceRoot`, embeds
     * `params.query`, and returns the ranked hits. Everything is LOCAL — nothing egresses
     * code; the result carries non-secret repo SNIPPETS only, never a credential.
     *
     * BEST-EFFORT / NON-FATAL: resolves (never rejects). On an unconnected bridge, a
     * transport/server error, or a malformed result, this resolves to
     * `{ ok:false, hits:[] }` so the caller (chat) degrades to NO repo context rather than
     * failing the turn — retrieval must NEVER break chat.
     */
    async indexRetrieve(params) {
        if (!this.ready || !this.child || this.closed) {
            const error = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { ok: false, hits: [], error };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.IndexRetrieve, params);
        if (response.error) {
            this.opts.log.appendLine(`[bridge] index/retrieve error ${response.error.code}: ${response.error.message}`);
            return { ok: false, hits: [], error: response.error.message };
        }
        const result = response.result;
        if (!result || typeof result.ok !== 'boolean' || !Array.isArray(result.hits)) {
            return { ok: false, hits: [], error: 'malformed index/retrieve result from supervisor.' };
        }
        return result;
    }
    /**
     * BUILD (or rebuild) the workspace's LOCAL code index on demand (`index/build` — the
     * no-CLI "Index Workspace" command). SYNCHRONOUS (request/result): the supervisor builds
     * the on-device index for `params.workspaceRoot` (or rebuilds it) and returns the
     * {@link IndexBuildResult} stats. `params.persist` opts into the 'workspace-encrypted'
     * residency (a persisted, encrypted, workspace-local snapshot). Everything is LOCAL —
     * nothing egresses code; no credential.
     *
     * STREAMING PROGRESS (the no-timeout fix): the build emits `index/progress`
     * notifications as it runs. `opts.onProgress` (when supplied) receives each
     * {@link IndexProgressEvent} so the command can drive a percent notification, and —
     * critically — every event RESETS this request's inactivity timer, so a long but
     * progressing build never times out. `opts.timeoutMs` sets the INACTIVITY BACKSTOP
     * (default {@link DEFAULT_INDEX_BUILD_TIMEOUT_MS} = 30 min); the request resolves on
     * the terminal {@link IndexBuildResult} as before.
     *
     * BEST-EFFORT / NON-FATAL: resolves (never rejects). On an unconnected bridge, a
     * transport/server error, or a malformed result, this resolves to `{ ok:false, error }`
     * so the command path renders an honest failure rather than throwing.
     */
    async indexBuild(params, opts) {
        if (!this.ready || !this.child || this.closed) {
            const error = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { ok: false, error };
        }
        // Mark THIS request as the in-flight index/build so handleLine can correlate the
        // (id-less) index/progress notifications to it. nextId is the id request() will mint.
        const buildId = this.nextId;
        this.indexBuildPendingId = buildId;
        try {
            const response = await this.request(bridgeProtocol_1.BridgeMethod.IndexBuild, params, {
                timeoutMs: opts?.timeoutMs ?? exports.DEFAULT_INDEX_BUILD_TIMEOUT_MS,
                ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
            });
            if (response.error) {
                this.opts.log.appendLine(`[bridge] index/build error ${response.error.code}: ${response.error.message}`);
                return { ok: false, error: response.error.message };
            }
            const result = response.result;
            if (!result || typeof result.ok !== 'boolean') {
                return { ok: false, error: 'malformed index/build result from supervisor.' };
            }
            return result;
        }
        finally {
            // Clear the slot only if it still points at THIS build (a later build may have
            // already claimed it — the command serializes builds, but be defensive).
            if (this.indexBuildPendingId === buildId)
                this.indexBuildPendingId = undefined;
        }
    }
    /* ============================================================== *
     * GOVERNED TERMINAL SESSION RPC (M7 — the in-IDE Governed Terminal)
     * ============================================================== */
    /**
     * Start a GOVERNED TERMINAL SESSION (`terminal/start`). The supervisor stands up
     * the metadata-only egress governance proxy, creates a real run, and begins
     * streaming the SAME `run/event` notifications the live Trust Panel consumes
     * (delivered to {@link setRunEventHandler}). This call returns the supervised
     * session handle ({ runId, proxyUrl, posture, trust }); it does NOT spawn the CLI
     * — that is the UI's job (set HTTPS_PROXY/HTTP_PROXY = proxyUrl on the terminal).
     *
     * The bridge MUST stay alive across this call AND the trailing run/event stream
     * (the caller owns the lifetime and calls {@link terminalStop} when the terminal
     * closes). Resolves (never rejects) with `{ ok, ... }`; a transport/server error
     * or a malformed/credential-bearing result resolves as `{ ok: false }` so the
     * command path never throws and never opens an ungoverned terminal.
     *
     * CREDENTIAL FIREWALL: the result is re-validated with
     * {@link validateTerminalStartResult}; a result carrying a credential-shaped field
     * (which it never should — the proxy is metadata-only) fails closed.
     */
    async terminalStart(params) {
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { ok: false, reason };
        }
        // CLIENT-SIDE §10.3 validation: a partial run request never opens a governed
        // session (mirrors createRun). A missing identity/posture field => refused.
        const validation = (0, bridgeProtocol_1.validateRunRequest)(params.request);
        if (!validation.ok) {
            const reason = `terminal session request missing required field(s): ${validation.missing.join(', ')}`;
            this.opts.log.appendLine(`[bridge] ${reason} — refusing (no governed terminal).`);
            return { ok: false, reason };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.TerminalStart, {
            request: validation.request,
        });
        if (response.error) {
            this.opts.log.appendLine(`[bridge] terminal/start error ${response.error.code}: ${response.error.message}`);
            return { ok: false, reason: response.error.message };
        }
        const result = response.result;
        const shape = (0, bridgeProtocol_1.validateTerminalStartResult)(result);
        if (!shape.ok) {
            const reason = `malformed terminal/start result (${shape.problems.join(', ')}).`;
            this.opts.log.appendLine(`[bridge] ${reason} — treating as not started.`);
            return { ok: false, reason };
        }
        const r = result;
        return { ok: true, runId: r.runId, proxyUrl: r.proxyUrl, posture: r.posture, trust: r.trust };
    }
    /**
     * Stop a governed terminal session (`terminal/stop`). The supervisor closes the
     * egress proxy and FINALIZES the run with the Ed25519-signed verdict over the live
     * trace root. The verdict's `assurance` ('full' | 'degraded') is bound into the
     * SIGNED record (sweep-22 #45): a degraded session must never be presented as
     * fully trusted. Resolves (never rejects); a malformed/credential-bearing verdict
     * fails closed.
     */
    async terminalStop(params) {
        if (!this.ready || !this.child || this.closed) {
            const reason = this.closeReason || 'bridge is not connected (handshake not completed).';
            return { ok: false, reason };
        }
        if (!params.runId) {
            return { ok: false, reason: 'terminalStop requires a runId' };
        }
        const response = await this.request(bridgeProtocol_1.BridgeMethod.TerminalStop, { runId: params.runId });
        if (response.error) {
            this.opts.log.appendLine(`[bridge] terminal/stop error ${response.error.code}: ${response.error.message}`);
            return { ok: false, reason: response.error.message };
        }
        const shape = (0, bridgeProtocol_1.validateTerminalStopResult)(response.result);
        if (!shape.ok) {
            const reason = `malformed terminal/stop result (${shape.problems.join(', ')}).`;
            this.opts.log.appendLine(`[bridge] ${reason} — treating as not finalized.`);
            return { ok: false, reason };
        }
        const r = response.result;
        return { ok: true, runId: r.runId, verdict: r.verdict };
    }
    /**
     * Tear down the child and reject all pending requests. Idempotent.
     *
     * Teardown is made LEAK-PROOF so a disposed bridge never holds the host's event
     * loop open INDEFINITELY (otherwise `node --test` cannot exit and the suite
     * hangs), while still guaranteeing the spawned child is actually reaped:
     *   1. End stdin — the bridge-server exits 0 on stdin 'end' (its normal path).
     *   2. SIGTERM the child (the polite kill). A well-behaved child exits here; its
     *      'close' (wired in wireChild) clears the fallback timer immediately, so the
     *      host loop drains at once.
     *   3. Destroy the stdio pipes so those handles stop referencing the loop right
     *      away (a still-draining child's pipes never hold the host open).
     *   4. Arm a SHORT, REFERENCED SIGKILL fallback so a child that IGNORES SIGTERM
     *      (e.g. mid-run with the egress-proxy socket still open) is force-reaped
     *      within the grace window. The timer is deliberately NOT unref'd: it is the
     *      one thing that must keep the loop alive just long enough to land SIGKILL
     *      and actually reap the child rather than orphaning it. It is a one-shot of
     *      DISPOSE_FORCE_KILL_MS, so the worst case is a brief wind-down, never a hang.
     * destroy()/unref()/kill() are all best-effort (test fakes omit the optionals).
     */
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
        const child = this.child;
        if (!child)
            return;
        // (1) Close stdin: the normal, clean exit path for the bridge-server.
        try {
            child.stdin?.end?.();
        }
        catch {
            /* already gone */
        }
        // (2) Polite SIGTERM.
        try {
            child.kill('SIGTERM');
        }
        catch {
            /* already gone */
        }
        // (3) Detach the stdio pipes so their handles stop referencing the host loop.
        try {
            child.stdout?.destroy?.();
        }
        catch {
            /* already gone */
        }
        try {
            child.stdin?.destroy?.();
        }
        catch {
            /* already gone */
        }
        // (4) SIGKILL fallback for a child that ignores SIGTERM. Kept REFERENCED (and
        //     short) so it reliably fires to reap the child instead of orphaning it;
        //     the child's 'close' (wireChild) clears it the instant the child exits.
        const timer = setTimeout(() => {
            // Send SIGKILL UNCONDITIONALLY: child.killed is set true by the earlier
            // kill('SIGTERM') even when the process IGNORED it, so it cannot gate this.
            // kill() on an already-exited child is a harmless no-op (throws ESRCH, caught).
            try {
                child.kill('SIGKILL');
            }
            catch {
                /* already gone */
            }
            this.killTimer = undefined;
        }, DISPOSE_FORCE_KILL_MS);
        this.killTimer = timer;
    }
    /* ----------------------- internals ----------------------- */
    /** Fire the child-exit handler at most once (governance loss → G7). Never throws. */
    fireChildExit(code) {
        if (this.childExitFired) {
            return;
        }
        this.childExitFired = true;
        const handler = this.onChildExit;
        if (!handler) {
            return;
        }
        try {
            handler(code);
        }
        catch {
            /* best-effort: a governance-loss handler must never break process teardown */
        }
    }
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
            // G7/E18 — a spawn/runtime error is governance loss for a live session.
            this.fireChildExit(null);
        });
        child.on('close', (code) => {
            // The child left on its own — cancel any pending SIGKILL escalation so the
            // dispose() fallback timer never outlives the process it was guarding.
            if (this.killTimer) {
                clearTimeout(this.killTimer);
                this.killTimer = undefined;
            }
            this.closeReason =
                `supervisor exited (code ${code ?? 'null'}) before the request completed.`;
            this.failAllPending(this.closeReason);
            // G7/E18 — the child closing means the egress proxy is gone: governance is lost for
            // a still-live session. A graceful dispose()/stop clears the handler FIRST, so this
            // only fires on an UNEXPECTED exit.
            this.fireChildExit(code);
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
            // Route by notification method: chat/delta feeds the chat UI, build/event feeds
            // the agentic-build progress + review sink, and everything else (run/event) feeds
            // the Trust Panel. Each notification stream is delivered ONLY to its own sink — a
            // build-event is NEVER mis-delivered to the chat or run-event sink (and vice-versa).
            if (note.method === bridgeProtocol_1.BridgeNotification.ChatDelta) {
                if (this.onChatDelta)
                    this.onChatDelta(note.params);
                return;
            }
            if (note.method === bridgeProtocol_1.BridgeNotification.AgenticBuildEvent) {
                if (this.onBuildEvent)
                    this.onBuildEvent(note.params);
                return;
            }
            if (note.method === bridgeProtocol_1.BridgeNotification.IndexProgress) {
                // Correlate to the single in-flight index/build: deliver to its per-request
                // onProgress sink AND reset that request's inactivity timer, so a long but
                // PROGRESSING build never times out. A stray progress with no in-flight build
                // (or after it resolved) is harmlessly dropped.
                const id = this.indexBuildPendingId;
                if (id !== undefined) {
                    const pending = this.pending.get(id);
                    if (pending) {
                        this.resetPendingTimer(id);
                        if (pending.onProgress) {
                            try {
                                pending.onProgress(note.params);
                            }
                            catch {
                                /* a throwing progress sink must never break the stream */
                            }
                        }
                    }
                }
                return;
            }
            if (this.onRunEvent)
                this.onRunEvent(note.params);
            return;
        }
        // Anything else (a request FROM the server, a foreign envelope) is ignored:
        // the client does not accept server-initiated requests.
    }
    /**
     * Send a request and resolve with its response (never rejects).
     *
     * STREAMING SUPPORT (index/build): an optional `opts.onProgress` registers a
     * per-request sink for `index/progress` notifications correlated to THIS request
     * (see {@link handleLine}); every such event ALSO resets the request's inactivity
     * timer (re-armed for `opts.timeoutMs ?? this.requestTimeoutMs`), so a long but
     * PROGRESSING build never times out — only a true stall does. `opts.timeoutMs`
     * overrides the per-request timeout (the index/build backstop cap) without touching
     * the global default that chat/run/model RPCs use.
     */
    request(method, params, opts) {
        return new Promise((resolve) => {
            if (this.closed || !this.child) {
                resolve(this.errorResponse(0, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, this.closeReason || 'bridge not connected'));
                return;
            }
            const id = this.nextId++;
            const envelope = {
                glyphstudio: bridgeProtocol_1.BRIDGE_JSONRPC,
                id,
                method,
                params,
            };
            const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
            const arm = () => {
                const t = setTimeout(() => {
                    if (this.pending.delete(id)) {
                        resolve(this.errorResponse(id, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, `request "${method}" timed out after ${timeoutMs}ms`));
                    }
                }, timeoutMs);
                // Don't keep the event loop alive purely for a pending bridge request.
                t.unref?.();
                return t;
            };
            const timer = arm();
            this.pending.set(id, {
                resolve: resolve,
                timer,
                timeoutMs,
                ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
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
    /**
     * Reset the inactivity timer for a still-pending request (a progress event landed).
     * Clears the old timer and re-arms a fresh one of the SAME length so a long but
     * progressing streaming request (index/build) is kept alive by its own progress.
     */
    resetPendingTimer(id) {
        const pending = this.pending.get(id);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        const t = setTimeout(() => {
            if (this.pending.delete(id)) {
                pending.resolve(this.errorResponse(id, bridgeProtocol_1.BridgeErrorCode.InvalidRequest, `request timed out after ${pending.timeoutMs}ms of inactivity`));
            }
        }, pending.timeoutMs);
        t.unref?.();
        pending.timer = t;
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
        return { glyphstudio: bridgeProtocol_1.BRIDGE_JSONRPC, id, error: { code, message } };
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