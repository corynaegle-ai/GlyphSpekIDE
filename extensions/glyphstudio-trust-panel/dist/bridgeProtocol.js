"use strict";
/*
 * GlyphStudio supervisor bridge — RPC CONTRACT (extension-side mirror; pure; NO
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
exports.TERMINAL_VERDICT_ASSURANCES = exports.TERMINAL_ENV_POSTURES = exports.MODEL_CREDENTIAL_FIELD_RE = exports.MAX_RECORD_HUMAN_PAYLOAD_BYTES = exports.RECORD_HUMAN_EVENT_TYPES = exports.MCP_CALL_STATUSES = exports.MCP_SERVER_STATUSES = exports.MAX_MCP_RESULT_JSON_BYTES = exports.MAX_MCP_ARGS_JSON_BYTES = exports.MAX_MCP_TOOL_NAME_CHARS = exports.MAX_MCP_SERVER_NAME_CHARS = exports.MAX_MCP_TOOLS_PER_SERVER = exports.MAX_MCP_SERVERS = exports.MAX_PLAN_FILE_CHARS = exports.MAX_PLAN_FILES_PER_STEP = exports.MAX_PLAN_RISK_CHARS = exports.MAX_PLAN_RISKS = exports.MAX_PLAN_STEP_DETAIL_CHARS = exports.MAX_PLAN_STEP_TITLE_CHARS = exports.MAX_PLAN_GOAL_CHARS = exports.MAX_PLAN_STEPS = exports.PLAN_PARSE_STATUSES = exports.CHANGE_REVIEW_PARSE_STATUSES = exports.CHANGE_REVIEW_SCOPES = exports.INDEX_PROGRESS_PHASES = exports.RUN_TRUSTS = exports.AUTONOMY_TIERS = exports.EXTENSION_POSTURES = exports.ACTOR_TYPES = exports.BridgeErrorCode = exports.BridgeNotification = exports.BridgeMethod = exports.BRIDGE_JSONRPC = exports.BRIDGE_PROTOCOL_VERSION = void 0;
exports.isHandshakeCompatible = isHandshakeCompatible;
exports.assertBuildPlanWellFormed = assertBuildPlanWellFormed;
exports.mcpCapability = mcpCapability;
exports.assertMcpCallWellFormed = assertMcpCallWellFormed;
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
 * The JSON-RPC dialect tag carried in every envelope. We use a GlyphStudio-scoped
 * marker rather than the bare "2.0" so a stray generic JSON-RPC peer on the same
 * stream is rejected as foreign by {@link isEnvelope} — the stdio transport is
 * private to this client/server pair and is not a generic JSON-RPC endpoint.
 */
exports.BRIDGE_JSONRPC = 'glyphstudio-jsonrpc/1';
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
    /**
     * Send ONE chat turn to the GlyphStudio-controlled model gateway (M7 chat — the
     * "terminal that's an IDE" conversational surface). The supervisor drives the
     * turn through the model gateway's CODEX backend and STREAMS the assistant reply
     * back as {@link BridgeNotification.ChatDelta} notifications tagged with the
     * returned `turnId`; this request's RESULT is only the ACK ({ turnId }). The
     * params carry WHAT to ask (the transcript) — NEVER a credential: codex
     * authenticates from its OWN on-disk store and egress is forced through the
     * supervisor's governed proxy. Mirrors the streaming pattern of run/start
     * (ack-then-notifications), not the synchronous model/call.
     */
    ChatSend: 'chat/send',
    /**
     * DISCOVER the chat backends this supervisor can route a {@link ChatSend} turn
     * to (the model-picker surface). SYNCHRONOUS request/result: the supervisor
     * PROBES each known backend AT REQUEST TIME and reports an HONEST per-backend
     * status — `'ok'` only when the probe succeeded; `'unavailable'` with a short
     * non-secret `detail` otherwise. `models` lists the LOCAL backend's installed
     * model names (capped; names only) when enumerable. NO PHANTOM BACKENDS: the
     * result never lists a backend the supervisor cannot actually route to, and
     * never invents a model name. Carries non-secret ids/names only, NEVER a
     * credential. MIRRORS the canonical spikes/p0-contracts/bridge.ts.
     */
    ChatBackends: 'chat/backends',
    /**
     * Fetch one explicit http(s) URL for `@Web` chat context. Synchronous
     * request/result, handled supervisor-side only: the extension never fetches web
     * content directly. Mirrors the canonical spikes/p0-contracts/bridge.ts.
     */
    WebFetch: 'web/fetch',
    /**
     * Start a GOVERNED AGENTIC BUILD (Phase C — the chat→ACTOR promotion). Unlike
     * {@link ChatSend} (Ask-only, read-only), a build crosses from assistant to ACTOR:
     * it edits files and runs commands under `cwd`. Per the developer trust doctrine
     * (docs/developer-trust-model.md) that authority boundary requires friction — an
     * EXPLICIT up-front authority grant. The request therefore carries
     * `approved: boolean`; the supervisor REFUSES (terminal `build/event` error, codex
     * NOT spawned) unless it is `true`. On approval the supervisor records the grant
     * (approval_requested + approval_approved trace events), runs codex agentically
     * under a governed run (metadata-only egress proxy, hash-chained trace, signed
     * verifier verdict; honest `governed-unsandboxed` posture — the diff is the safety
     * net, NOT a sandbox; no credential injected), and STREAMS the build as
     * {@link BridgeNotification.AgenticBuildEvent} notifications tagged with the runId.
     * This request's RESULT is only the ACK ({ runId }); the terminal stream event
     * carries the {@link AgenticBuildReview} render contract. Mirrors run/start's
     * ack-then-notifications style. MIRRORS the canonical spikes/p0-contracts/bridge.ts.
     */
    AgenticBuildStart: 'build/start',
    /**
     * Abort an in-flight run (the remote-control / agentic build engine). SIGKILLs the
     * run's actor child (e.g. `codex exec`), transitions the lifecycle to `aborted`, and
     * emits a terminal run/build event. Idempotent: an unknown/already-terminal run acks
     * `cancelled:false` (never errors). Additive; mirrors the canonical contract.
     */
    RunCancel: 'run/cancel',
    /**
     * Resolve a PENDING approval. Two kinds share this one RPC: a PENDING governed
     * build's up-front authority grant (the remote-coding flow: a pending `build/start`
     * parks a build awaiting approval — `allow` starts it down the approved path,
     * `deny` discards it), and a HELD `mcp/call` whose policy decision was
     * ask/force_ask (#9 Slice 2: the desktop approval modal's verdict — `allow`
     * executes the brokered call exactly like an up-front allow; `deny`/timeout
     * yields an honest 'denied' {@link McpCallResult}). Additive; mirrors the
     * canonical contract.
     */
    ApprovalRespond: 'approval/respond',
    /**
     * Retrieve top-k chunks from the workspace's LOCAL code index (@Codebase repo-aware
     * retrieval). SYNCHRONOUS request/result (NOT ack-then-stream): the supervisor lazily
     * builds the on-device index for `workspaceRoot` on first use (local embedder +
     * brute-force store, memory-only residency), embeds `query`, and returns the top-k
     * cosine-similar chunks. Everything is LOCAL — nothing in the index path egresses
     * code. The result carries non-secret repo SNIPPETS only, NEVER a credential.
     * Best-effort: on ANY error the result is `{ ok:false, hits:[] }` so chat degrades to
     * NO repo context. MIRRORS the canonical spikes/p0-contracts/bridge.ts.
     */
    IndexRetrieve: 'index/retrieve',
    /**
     * BUILD (or rebuild) the workspace's LOCAL code index on demand (the no-CLI "Index
     * Workspace" command). SYNCHRONOUS request/result: the supervisor builds (or
     * incrementally rebuilds) the SESSION'S OWN on-device index for `workspaceRoot` and
     * returns the {@link IndexBuildStats} (files / chunks / embedded / reused / embedMs /
     * totalMs). Session-bound EXACTLY like {@link IndexRetrieve} (completed-handshake gate
     * + the same session-root binding) and shares the SAME per-workspace server-side index
     * the chat retrieval + repo-aware FIM use (never a parallel index). `persist` opts the
     * build into the 'workspace-encrypted' residency (an encrypted, workspace-local
     * snapshot that survives session restarts) instead of the memory-only default.
     * Everything is LOCAL — nothing egresses code. Best-effort: on ANY error the result is
     * `{ ok:false }` with a short non-secret `error`. MIRRORS the canonical
     * spikes/p0-contracts/bridge.ts.
     */
    IndexBuild: 'index/build',
    /**
     * INCREMENTALLY UPDATE the workspace's LOCAL code index from a batch of saved/
     * watched file changes (the index-freshness loop). SYNCHRONOUS request/result:
     * the supervisor filters the batch through the SAME discovery/ignore gates a full
     * build uses, re-embeds ONLY the windows whose content hash differs (per-window-
     * hash diff), and EVICTS windows for deleted files. Session-bound EXACTLY like
     * {@link IndexRetrieve}/{@link IndexBuild}; only an EXISTING session index is
     * updated (no index yet → honest `{ ok:false }` refusal — never a cold build).
     * Memory-only mutation; nothing egresses code. Best-effort: on ANY error the
     * result is `{ ok:false }` with a short non-secret `error`. MIRRORS the canonical
     * spikes/p0-contracts/bridge.ts.
     */
    IndexUpdate: 'index/update',
    /**
     * Start a GOVERNED CHANGE REVIEW (#7 — "Review Changes (Verifier-Backed)"): ONE
     * governed run over the workspace's PROPOSED state (the working tree, or a branch
     * vs a base ref) producing a signed review artifact with TWO never-blurring
     * layers — ADVISORY model findings plus the deterministic INDEPENDENT-VERIFIER
     * verdict. The `review_findings` trace event is appended BEFORE the verifier
     * runs, so the signed verdict's `traceRootHash` COMMITS to the findings. Mirrors
     * build/start's ack-then-notifications style: the RESULT is only the ACK
     * ({ runId }); the review STREAMS back as
     * {@link BridgeNotification.ChangeReviewEvent} notifications, the terminal
     * `result` carrying the {@link ChangeReview} render contract. MIRRORS the
     * canonical spikes/p0-contracts/bridge.ts.
     */
    ChangeReviewStart: 'review/start',
    /**
     * Start a GOVERNED PLAN RUN (#8 — plan mode): pre-build governed planning. The
     * supervisor mints a run + hash-chained trace, runs ONE governed READ-ONLY model
     * turn producing a structured {@link BuildPlan}, appends the `plan_proposed`
     * trace event, and PARKS the run (the PendingBuild idiom) — no file is edited and
     * no build starts. The user reviews/edits the plan in the IDE; a later
     * {@link BridgeMethod.AgenticBuildStart} with the SAME `runId` carrying a
     * `planApproval` resolves the parked run (the server mints the approvalId and
     * appends `plan_approved` BEFORE executing, so the build runs on the SAME trace),
     * or a {@link BridgeMethod.BuildPlanReject} appends `plan_rejected` and closes
     * the run. A plan is MODEL OPINION: advisory, tamper-evident via the chain,
     * NEVER an assurance input. Mirrors review/start's ack-then-notifications style:
     * the RESULT is only the ACK ({ runId }); the plan STREAMS back as
     * {@link BridgeNotification.BuildPlanEvent} notifications, the terminal `result`
     * carrying the {@link BuildPlanProposal} render contract. Read-only over the
     * workspace (no authority grant needed: the planner edits nothing); carries no
     * credential. MIRRORS the canonical spikes/p0-contracts/bridge.ts.
     */
    BuildPlanStart: 'plan/start',
    /**
     * REJECT a PARKED plan run (#8). The supervisor appends the `plan_rejected`
     * trace event (with the optional non-secret reason) and closes the run — no
     * build ever starts on it. The result is only the ACK ({ runId, rejected }).
     * Mirrors run/cancel's lightweight params/ack shape conventions. MIRRORS the
     * canonical spikes/p0-contracts/bridge.ts.
     */
    BuildPlanReject: 'plan/reject',
    /**
     * LIST the MCP servers + tools brokered for the session's workspace (#9 —
     * governed MCP brokering). SYNCHRONOUS request/result: the supervisor — the
     * ONLY component that owns MCP stdio server children (the extension/UI never
     * spawns or speaks to one) — reports each server configured in
     * `.glyphstudio/mcp.json` with an HONEST per-server status
     * ('ok' | 'spawn-failed' | 'init-failed' | 'disabled') and its discovered
     * tools. Tool input schemas cross the wire as RAW JSON STRINGS
     * ({@link McpToolInfo.inputSchemaJson}) — third-party schemas we do not vouch
     * for, never lifted into typed contract shapes. Carries non-secret
     * names/descriptions only, NEVER a credential. MIRRORS the canonical
     * spikes/p0-contracts/bridge.ts.
     */
    McpList: 'mcp/list',
    /**
     * BROKER one MCP tool call (#9). SYNCHRONOUS request/result: the supervisor
     * routes EVERY call through the policy engine's decide() as tool kind 'mcp'
     * with the capability string `mcp/<server>/<tool>` (see {@link mcpCapability})
     * and traces it with the EXISTING policy_decision/tool_start/tool_end trace
     * event types — ZERO new trace event types (a headline property of the MCP
     * design). The result's raw JSON output carries the 'mcp' (UNTRUSTED)
     * provenance label downstream: instruction-demoted data, never system/
     * developer instructions. TRUST POSTURE: brokering governs the CALL boundary;
     * the MCP server binary itself is third-party code running on the host —
     * brokered calls ≠ a sandboxed server. Carries no credential on the wire.
     * MIRRORS the canonical spikes/p0-contracts/bridge.ts.
     */
    McpCall: 'mcp/call',
    /**
     * APPEND one HUMAN-ORIGIN event to a run's hash-chained trace (#10 Slice 1 —
     * the apply/diff decision + session-checkpoint record path). SYNCHRONOUS
     * request/result: the supervisor appends EXACTLY ONE event of the requested
     * {@link RecordHumanParams.type} to the run's trace — through the run's LIVE
     * TraceWriter when the run is still open, or by REHYDRATING the persisted
     * trace.jsonl tail when the run has already closed — and returns the appended
     * event's chain position ({ ok, seq, hash }): EVIDENCE the append really
     * happened, not a claim. TRUST POSTURE: `source` is FORCED to 'human'
     * SERVER-SIDE — a client cannot mint a supervisor/verifier-attributed event
     * through this RPC; the payload is DATA, NOT AUTHORITY (a human event can
     * never carry a verdict). Appends are REFUSED with an honest JSON-RPC error —
     * NEVER a silent success — for an unknown runId, a missing trace file, or an
     * unparseable/tamper-suspect chain tail. MIRRORS the canonical
     * spikes/p0-contracts/bridge.ts.
     */
    RecordHuman: 'run/recordHuman',
};
/** Server→client notification methods (no response expected). */
exports.BridgeNotification = {
    /** A run lifecycle/trace event streamed back to the client for the panel. */
    RunEvent: 'run/event',
    /**
     * One chat-turn stream event (M7 chat). After a {@link BridgeMethod.ChatSend}
     * ack, the supervisor emits a sequence of these tagged with the same `turnId`:
     * zero or more `delta` events as the assistant answer arrives, then exactly one
     * terminal `done` (full text + optional usage) or `error`. The payload is a
     * {@link ChatStreamEvent} — the chat-turn event discriminated union plus the
     * `turnId`. Carries assistant TEXT (the answer the UI renders), never a
     * credential.
     */
    ChatDelta: 'chat/delta',
    /**
     * One agentic-build stream event (Phase C). After a
     * {@link BridgeMethod.AgenticBuildStart} ack, the supervisor emits a sequence of
     * these tagged with the same `runId`: `state` lifecycle markers, `summary` text
     * deltas, `command` start/end pairs (with exit codes), `fileChange` events, then
     * exactly one terminal `result` (carrying the {@link AgenticBuildReview} render
     * contract) or `error`. A REFUSED build (missing authority approval) emits ONLY a
     * terminal `error` and no codex is spawned. The payload is an
     * {@link AgenticBuildStreamEvent} — the build event discriminated union plus the
     * `runId`. Carries non-secret build EVIDENCE (summary/commands/diff/verdict),
     * never a credential.
     */
    AgenticBuildEvent: 'build/event',
    /**
     * One `index/build` PROGRESS event (the "Index Workspace" command). After an
     * {@link BridgeMethod.IndexBuild} request is accepted, the supervisor STREAMS a
     * sequence of these (one per phase/batch) carrying the {@link IndexProgressEvent}
     * counts, then resolves the request with the final {@link IndexBuildResult}. The
     * client routes each event to a per-request `onProgress` callback AND resets the
     * request's inactivity timeout on every event — so a long, progressing build never
     * times out. Carries non-secret build COUNTS only (done/total/phase), never a
     * credential and never any code/chunk text.
     */
    IndexProgress: 'index/progress',
    /**
     * One change-review stream event (#7). After a
     * {@link BridgeMethod.ChangeReviewStart} ack, the supervisor emits a sequence of
     * these tagged with the same `runId`: `state` lifecycle markers, then exactly one
     * terminal `result` (carrying the {@link ChangeReview} render contract — advisory
     * findings + the signed verifier verdict) or `error`. The payload is a
     * {@link ChangeReviewStreamEvent}. Carries non-secret review EVIDENCE, never a
     * credential. MIRRORS the canonical spikes/p0-contracts/bridge.ts.
     */
    ChangeReviewEvent: 'review/event',
    /**
     * One plan-run stream event (#8). After a {@link BridgeMethod.BuildPlanStart}
     * ack, the supervisor emits a sequence of these tagged with the same `runId`:
     * `state` lifecycle markers, an optional `plan` event carrying the parsed
     * {@link BuildPlan} as soon as it exists, then exactly one terminal `result`
     * (the run is now PARKED awaiting approval/rejection; carries the
     * {@link BuildPlanProposal} render contract) or `error`. The payload is a
     * {@link BuildPlanStreamEvent} — the plan event discriminated union plus the
     * `runId`. Carries non-secret plan TEXT (goal/steps/risks the UI renders),
     * never a credential. MIRRORS the canonical spikes/p0-contracts/bridge.ts.
     */
    BuildPlanEvent: 'plan/event',
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
    'sandboxed-soft-egress',
    'governed-unsandboxed',
    'untrusted',
    'refused',
];
/**
 * The discrete BUILD PHASES an `index/build` streams progress for (MIRROR of the
 * canonical contract). A coarse `discover` → `chunk` → `embed` sequence; the embed
 * phase (the long pole) carries the meaningful percent and is streamed per BATCH.
 */
exports.INDEX_PROGRESS_PHASES = ['discover', 'chunk', 'embed'];
/** The full set of change-review scopes, for validation. */
exports.CHANGE_REVIEW_SCOPES = [
    'working-tree',
    'branch',
];
/** The full set of findings parse statuses, for validation. */
exports.CHANGE_REVIEW_PARSE_STATUSES = [
    'ok',
    'parse-failed',
    'unavailable',
];
/** The full set of plan parse statuses, for validation. */
exports.PLAN_PARSE_STATUSES = [
    'ok',
    'parse-failed',
    'unavailable',
];
// --- plan caps (the cap values assertBuildPlanWellFormed enforces). MIRROR the
// canonical values exactly — the conformance gate pins the method vocabulary and
// the planDocument round-trip tests pin the gate behavior.
/** Hard cap on the number of steps a single plan may carry. */
exports.MAX_PLAN_STEPS = 20;
/** Hard cap on a plan goal's length (chars). */
exports.MAX_PLAN_GOAL_CHARS = 300;
/** Hard cap on a plan step title's length (chars). */
exports.MAX_PLAN_STEP_TITLE_CHARS = 120;
/** Hard cap on a plan step detail's length (chars). */
exports.MAX_PLAN_STEP_DETAIL_CHARS = 600;
/** Hard cap on the number of risks a single plan may carry. */
exports.MAX_PLAN_RISKS = 10;
/** Hard cap on a single risk's length (chars). */
exports.MAX_PLAN_RISK_CHARS = 300;
/** Hard cap on the number of files a single plan step may name. */
exports.MAX_PLAN_FILES_PER_STEP = 10;
/** Hard cap on a plan step's file-path length (chars). */
exports.MAX_PLAN_FILE_CHARS = 260;
/** True iff `p` looks like an absolute path (POSIX or Windows drive/UNC). */
function planPathLooksAbsolute(p) {
    return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}
/** True iff `p` contains a `..` traversal segment. */
function planPathHasTraversal(p) {
    return p.split(/[\\/]/).some((seg) => seg === '..');
}
/**
 * CONTRACT-LEVEL ASSERTION for a {@link BuildPlan} — STRICT structural
 * validation plus cap enforcement at the trust boundary, MIRRORING the
 * canonical assertBuildPlanWellFormed byte-for-byte in behavior. Shared so the
 * CLIENT can refuse to send a malformed/oversized plan (the server
 * independently re-validates what arrived on the wire). STRICT, NEVER
 * REPAIRING: a plan crossing the boundary is either exactly well-formed or
 * REJECTED — it THROWS with the comma-joined dotted problem tags.
 */
function assertBuildPlanWellFormed(plan) {
    if (!isModelObj(plan)) {
        throw new Error('malformed BuildPlan: not-an-object');
    }
    const problems = [];
    // goal — required, non-empty, capped.
    if (!modelNonEmptyString(plan.goal)) {
        problems.push('plan.goal');
    }
    else if (plan.goal.length > exports.MAX_PLAN_GOAL_CHARS) {
        problems.push('plan.goal.over-cap');
    }
    // steps — required, a NON-EMPTY array (a plan with no steps plans nothing),
    // capped in count; every member strictly validated.
    if (!Array.isArray(plan.steps)) {
        problems.push('plan.steps');
    }
    else if (plan.steps.length === 0) {
        problems.push('plan.steps.empty');
    }
    else if (plan.steps.length > exports.MAX_PLAN_STEPS) {
        problems.push('plan.steps.over-cap');
    }
    else {
        plan.steps.forEach((step, i) => {
            if (!isModelObj(step)) {
                problems.push(`plan.steps[${i}]`);
                return;
            }
            if (!modelNonEmptyString(step.title)) {
                problems.push(`plan.steps[${i}].title`);
            }
            else if (step.title.length > exports.MAX_PLAN_STEP_TITLE_CHARS) {
                problems.push(`plan.steps[${i}].title.over-cap`);
            }
            if (!modelNonEmptyString(step.detail)) {
                problems.push(`plan.steps[${i}].detail`);
            }
            else if (step.detail.length > exports.MAX_PLAN_STEP_DETAIL_CHARS) {
                problems.push(`plan.steps[${i}].detail.over-cap`);
            }
            // files — OPTIONAL; when present: capped count, every path a non-empty,
            // bounded, workspace-relative string (the review finding conventions).
            if (step.files !== undefined) {
                if (!Array.isArray(step.files)) {
                    problems.push(`plan.steps[${i}].files`);
                }
                else if (step.files.length > exports.MAX_PLAN_FILES_PER_STEP) {
                    problems.push(`plan.steps[${i}].files.over-cap`);
                }
                else {
                    step.files.forEach((file, j) => {
                        if (typeof file !== 'string' ||
                            file.trim().length === 0 ||
                            file.length > exports.MAX_PLAN_FILE_CHARS ||
                            planPathLooksAbsolute(file) ||
                            planPathHasTraversal(file)) {
                            problems.push(`plan.steps[${i}].files[${j}]`);
                        }
                    });
                }
            }
        });
    }
    // risks — OPTIONAL; when present: capped count, every member a non-empty,
    // bounded string.
    if (plan.risks !== undefined) {
        if (!Array.isArray(plan.risks)) {
            problems.push('plan.risks');
        }
        else if (plan.risks.length > exports.MAX_PLAN_RISKS) {
            problems.push('plan.risks.over-cap');
        }
        else {
            plan.risks.forEach((risk, i) => {
                if (typeof risk !== 'string' || risk.trim().length === 0) {
                    problems.push(`plan.risks[${i}]`);
                }
                else if (risk.length > exports.MAX_PLAN_RISK_CHARS) {
                    problems.push(`plan.risks[${i}].over-cap`);
                }
            });
        }
    }
    if (problems.length > 0) {
        throw new Error(`malformed BuildPlan: ${problems.join(', ')}`);
    }
}
/* ============================================================== *
 * MCP BROKERING RPC (#9 — governed MCP tool brokering) — MIRROR
 *
 * Mirrors the canonical spikes/p0-contracts/bridge.ts MCP section. The
 * supervisor OWNS the MCP stdio server children (config:
 * `.glyphstudio/mcp.json` `{"mcpServers":{name:{command,args,env}}}`); the
 * extension/UI never spawns or speaks to an MCP server directly.
 *
 * TRUST POSTURE (load-bearing): every call is policy-brokered (tool kind
 * 'mcp', capability `mcp/<server>/<tool>`) and traced with the EXISTING
 * policy_decision/tool_start/tool_end trace event types — ZERO new trace
 * event types. Results carry the 'mcp' (UNTRUSTED) provenance label. The
 * server binary is third-party code on the host — brokered calls ≠ a
 * sandboxed server. Tool input schemas stay RAW JSON strings (never vouched
 * for). No shape carries a credential; server env (including any tokens) is
 * configured supervisor-side and never crosses this wire.
 * ============================================================== */
// --- MCP caps (the cap values assertMcpCallWellFormed and the supervisor-side
// loader/list projection enforce). MIRROR the canonical values exactly — the
// conformance gate pins the vocabulary, the caps, and the gate behavior.
/** Hard cap on the number of configured MCP servers brokered per workspace. */
exports.MAX_MCP_SERVERS = 16;
/** Hard cap on the number of tools listed per MCP server. */
exports.MAX_MCP_TOOLS_PER_SERVER = 64;
/** Hard cap on an MCP server name's length (chars) — the mcp.json key. */
exports.MAX_MCP_SERVER_NAME_CHARS = 64;
/** Hard cap on an MCP tool name's length (chars). */
exports.MAX_MCP_TOOL_NAME_CHARS = 128;
/** Hard cap on a call's argsJson payload (UTF-8 bytes). */
exports.MAX_MCP_ARGS_JSON_BYTES = 32768;
/**
 * Hard cap on a brokered result's resultJson payload (UTF-8 bytes). The
 * supervisor truncates an over-cap third-party result HONESTLY (a non-secret
 * truncation marker in `reason`), never silently.
 */
exports.MAX_MCP_RESULT_JSON_BYTES = 262144;
/** The full set of MCP server statuses, for validation. */
exports.MCP_SERVER_STATUSES = [
    'ok',
    'spawn-failed',
    'init-failed',
    'disabled',
];
/** The full set of MCP call statuses, for validation. */
exports.MCP_CALL_STATUSES = [
    'ok',
    'denied',
    'error',
];
/**
 * Build the capability string a brokered MCP call requests:
 * `mcp/<server>/<tool>`. The SINGLE owner of the format so policy matching,
 * tracing, and the UI can never drift on the prefix/separator.
 */
function mcpCapability(server, tool) {
    return `mcp/${server}/${tool}`;
}
/** UTF-8 byte length of a string, dependency-free (mirrors the canonical helper). */
function mcpUtf8ByteLength(s) {
    let bytes = 0;
    for (let i = 0; i < s.length; i += 1) {
        const code = s.codePointAt(i);
        if (code <= 0x7f)
            bytes += 1;
        else if (code <= 0x7ff)
            bytes += 2;
        else if (code <= 0xffff)
            bytes += 3;
        else {
            bytes += 4;
            i += 1; // surrogate pair consumed two UTF-16 units
        }
    }
    return bytes;
}
/**
 * CONTRACT-LEVEL ASSERTION for {@link McpCallParams} — STRICT structural
 * validation plus cap enforcement at the trust boundary, MIRRORING the
 * canonical assertMcpCallWellFormed byte-for-byte in behavior. STRICT, NEVER
 * REPAIRING: a call crossing the boundary is either exactly well-formed or
 * REJECTED — it THROWS with the comma-joined dotted problem tags. `argsJson`
 * must PARSE as JSON and the parsed value must be a JSON OBJECT (the MCP
 * `arguments` shape); a string that merely resembles JSON is rejected.
 */
function assertMcpCallWellFormed(call) {
    if (!isModelObj(call)) {
        throw new Error('malformed McpCallParams: not-an-object');
    }
    const problems = [];
    // server — required, non-empty, capped.
    if (!modelNonEmptyString(call.server)) {
        problems.push('call.server');
    }
    else if (call.server.length > exports.MAX_MCP_SERVER_NAME_CHARS) {
        problems.push('call.server.over-cap');
    }
    // tool — required, non-empty, capped.
    if (!modelNonEmptyString(call.tool)) {
        problems.push('call.tool');
    }
    else if (call.tool.length > exports.MAX_MCP_TOOL_NAME_CHARS) {
        problems.push('call.tool.over-cap');
    }
    // argsJson — required STRING, byte-capped, parseable, a JSON object.
    if (typeof call.argsJson !== 'string') {
        problems.push('call.argsJson');
    }
    else if (mcpUtf8ByteLength(call.argsJson) > exports.MAX_MCP_ARGS_JSON_BYTES) {
        problems.push('call.argsJson.over-cap');
    }
    else {
        let parsed;
        let parseFailed = false;
        try {
            parsed = JSON.parse(call.argsJson);
        }
        catch {
            parseFailed = true;
        }
        if (parseFailed) {
            problems.push('call.argsJson.not-json');
        }
        else if (!isModelObj(parsed)) {
            problems.push('call.argsJson.not-object');
        }
    }
    if (problems.length > 0) {
        throw new Error(`malformed McpCallParams: ${problems.join(', ')}`);
    }
}
/** The full set of record-human event types, for validation. */
exports.RECORD_HUMAN_EVENT_TYPES = [
    'human_accepted',
    'human_rejected',
    'human_corrected_output',
    'checkpoint_created',
    'checkpoint_restored',
];
/**
 * Hard cap on a record-human payload (UTF-8 bytes of its JSON serialization).
 * Payloads are small structured summaries (decision, file counts, a checkpoint
 * sha) — NEVER diff/file content. An over-cap payload is REFUSED honestly,
 * never truncated. MIRRORS the canonical spikes/p0-contracts/bridge.ts.
 */
exports.MAX_RECORD_HUMAN_PAYLOAD_BYTES = 16384;
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
        value.glyphstudio === exports.BRIDGE_JSONRPC);
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