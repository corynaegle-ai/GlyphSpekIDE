// ../spikes/p0-supervisor/bridge-server.ts
import { createHash as createHash3 } from "node:crypto";
import { readFileSync as readFileSync4, statSync as statSync3 } from "node:fs";
import { spawnSync as spawnSync2 } from "node:child_process";
import { join as join8 } from "node:path";

// ../spikes/p0-supervisor/run.ts
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var PKG_ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");
var DEFAULT_RUNS_BASE_DIR = path.join(PKG_ROOT, ".runs");
var RUN_SUBDIRS = ["trace", "diff", "verdict", "logs"];
function newRunId() {
  const tsPrefix = Date.now().toString(36).padStart(9, "0");
  return `${tsPrefix}-${randomUUID()}`;
}
function createRun(baseDir = DEFAULT_RUNS_BASE_DIR) {
  const runId = newRunId();
  const dir = path.join(baseDir, runId);
  for (const sub of RUN_SUBDIRS) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return { runId, dir, state: "created" };
}
function runSubdirPath(runDir, sub) {
  return path.join(runDir, sub);
}

// ../spikes/p0-contracts/lifecycle.ts
var LEGAL_TRANSITIONS = {
  created: ["worktree_ready", "failed", "aborted"],
  worktree_ready: ["sandbox_ready", "failed", "aborted"],
  sandbox_ready: ["executing", "failed", "aborted"],
  executing: ["completed", "failed", "aborted"],
  completed: [],
  failed: [],
  aborted: []
};
function canTransition(from, to) {
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
function isTerminalState(state) {
  return LEGAL_TRANSITIONS[state]?.length === 0;
}

// ../spikes/p0-contracts/provenance.ts
var UNTRUSTED_PROVENANCE = [
  "web",
  "tool-output",
  "mcp"
];

// ../spikes/p0-contracts/policy.ts
var POLICY_DEFAULT_VERBS = ["allow", "deny", "ask"];
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isStringMatrix(v) {
  return Array.isArray(v) && v.every((row) => isStringArray(row));
}
function validateDefaultVerb(value, path4, errors) {
  if (typeof value !== "string" || !POLICY_DEFAULT_VERBS.includes(value)) {
    errors.push(
      `${path4} must be one of ${POLICY_DEFAULT_VERBS.join(" | ")}, got ${describe(value)}`
    );
  }
}
function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function parsePolicy(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { errors: [`policy must be an object, got ${describe(raw)}`] };
  }
  if (typeof raw.version !== "number" || !Number.isFinite(raw.version)) {
    errors.push(`version must be a finite number, got ${describe(raw.version)}`);
  }
  let defaults;
  if (!isPlainObject(raw.defaults)) {
    errors.push(`defaults must be an object, got ${describe(raw.defaults)}`);
  } else {
    const d = raw.defaults;
    validateDefaultVerb(d.file_read, "defaults.file_read", errors);
    validateDefaultVerb(d.file_write, "defaults.file_write", errors);
    validateDefaultVerb(d.command, "defaults.command", errors);
    validateDefaultVerb(d.network, "defaults.network", errors);
    validateDefaultVerb(d.mcp, "defaults.mcp", errors);
    if (errors.length === 0) {
      defaults = {
        file_read: d.file_read,
        file_write: d.file_write,
        command: d.command,
        network: d.network,
        mcp: d.mcp
      };
    }
  }
  let allow;
  if (!isPlainObject(raw.allow)) {
    errors.push(`allow must be an object, got ${describe(raw.allow)}`);
  } else {
    const a = raw.allow;
    if (!isStringArray(a.read_paths)) errors.push("allow.read_paths must be a string[]");
    if (!isStringArray(a.write_paths)) errors.push("allow.write_paths must be a string[]");
    if (!isStringMatrix(a.commands)) errors.push("allow.commands must be a string[][]");
    if (!isStringArray(a.network)) errors.push("allow.network must be a string[]");
    allow = {
      read_paths: isStringArray(a.read_paths) ? a.read_paths : [],
      write_paths: isStringArray(a.write_paths) ? a.write_paths : [],
      commands: isStringMatrix(a.commands) ? a.commands : [],
      network: isStringArray(a.network) ? a.network : []
    };
  }
  let deny;
  if (!isPlainObject(raw.deny)) {
    errors.push(`deny must be an object, got ${describe(raw.deny)}`);
  } else {
    const dn = raw.deny;
    if (!isStringArray(dn.read_paths)) errors.push("deny.read_paths must be a string[]");
    if (!isStringArray(dn.write_paths)) errors.push("deny.write_paths must be a string[]");
    if (!isStringMatrix(dn.commands)) errors.push("deny.commands must be a string[][]");
    deny = {
      read_paths: isStringArray(dn.read_paths) ? dn.read_paths : [],
      write_paths: isStringArray(dn.write_paths) ? dn.write_paths : [],
      commands: isStringMatrix(dn.commands) ? dn.commands : []
    };
  }
  let verify;
  if (!isStringMatrix(raw.verify)) {
    errors.push("verify must be a string[][]");
  } else {
    verify = raw.verify.map((row) => Object.freeze([...row]));
  }
  if (errors.length > 0) {
    return { errors };
  }
  const policy = {
    version: raw.version,
    defaults,
    allow,
    deny,
    verify: Object.freeze(verify)
  };
  return { policy, errors: [] };
}

// ../spikes/p0-contracts/trace.ts
var TRACE_EVENT_VERSION = 1;

// ../spikes/p0-contracts/sandbox.ts
function runtimeCapabilities(runtime, spec) {
  if (typeof runtime.capabilities === "function") {
    return runtime.capabilities(spec);
  }
  return { fsIsolated: false, hardEgress: false };
}

// ../spikes/p0-contracts/model.ts
var DEFAULT_INDEX_RESIDENCY_POLICY = {
  residency: "memory-only",
  highSecurity: false
};

// ../spikes/p0-contracts/bridge.ts
var BRIDGE_PROTOCOL_VERSION = 1;
var BRIDGE_JSONRPC = "glyphspek-jsonrpc/1";
var BridgeMethod = {
  /** Version-compatibility handshake; MUST be the first call after spawn. */
  Handshake: "bridge/handshake",
  /** Create a governed run from a fully-populated run request. */
  CreateRun: "run/create",
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
  StartRun: "run/start",
  /**
   * Query the model-broker allowlist (M6). The UI offers ONLY the models this
   * returns. The result carries NO credential — only non-secret provider/model/
   * endpoint posture. With no configured model broker the allowlist is empty.
   */
  ModelAllowlist: "model/allowlist",
  /**
   * Broker one model call — chat / inline-edit (M6). The request carries WHAT to
   * ask, NEVER how to authenticate: there is deliberately no credential field. The
   * supervisor reads the provider token supervisor-side and the UI/client never
   * receives it, nor the assembled outbound HTTP request. The result is the
   * redacted projection (decision + redacted completion + usage + trace ref).
   */
  ModelCall: "model/call",
  /**
   * Start a GOVERNED TERMINAL SESSION (M7 — the in-IDE Governed Terminal surface).
   * The supervisor starts a metadata-only egress governance proxy (allowlisting the
   * configured model endpoints), creates a real RunLifecycle run, and PROJECTS the
   * proxy's egress activity into the run's hash-chained trace, streaming it as the
   * SAME `run/event` notifications the live Trust Panel already renders. The result
   * carries the supervisor-minted runId, the proxy URL the future terminal UI sets
   * as HTTPS_PROXY/HTTP_PROXY, and the env-sanitization POSTURE the UI must apply.
   *
   * CREDENTIAL POSTURE (anti-FauxCode): the credential NEVER touches the supervisor.
   * The proxy is metadata-only (no TLS termination); the CLI authenticates from its
   * OWN on-disk store. This RPC does NOT spawn the CLI — that is the later UI slice;
   * `terminal/start` only establishes the supervised session + proxy.
   */
  TerminalStart: "terminal/start",
  /**
   * Stop a governed terminal session (M7). The supervisor closes the egress proxy
   * and FINALIZES the run with the Ed25519-signed verifier verdict over the live
   * trace root (the same mechanism live runs use). When the session's trace-health
   * is DEGRADED (an observer/append failure projected the trace incompletely), the
   * finalized verdict is marked DEGRADED / lower-assurance so a consumer cannot
   * present a degraded session as fully trusted (sweep-22 #45). The result carries
   * the runId and the signed verdict.
   */
  TerminalStop: "terminal/stop",
  /**
   * Send ONE chat turn to the GlyphSpek-controlled model gateway (M7 chat — the
   * "terminal that's an IDE" conversational surface). The supervisor drives the
   * turn through the model gateway's CODEX backend and STREAMS the assistant reply
   * back as {@link BridgeNotification.ChatDelta} notifications tagged with the
   * returned `turnId`; this request's RESULT is only the ACK ({ turnId }). The
   * params carry WHAT to ask (the transcript) — NEVER a credential: codex
   * authenticates from its OWN on-disk store and egress is forced through the
   * supervisor's governed proxy. Mirrors the streaming pattern of run/start
   * (ack-then-notifications), not the synchronous model/call.
   */
  ChatSend: "chat/send",
  /**
   * Start a GOVERNED AGENTIC BUILD (Phase B — the chat→ACTOR promotion). Unlike
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
   * ack-then-notifications style.
   */
  AgenticBuildStart: "build/start",
  /**
   * CANCEL an in-flight run (remote-control: the phone's `runs.cancel`). The
   * supervisor ABORTS the run's actor child process (e.g. the agentic build's
   * `codex exec`), transitions the run lifecycle to the terminal `aborted` state,
   * and emits a terminal `build/event {state:'aborted'}` / `run_closed`. Idempotent:
   * cancelling an already-terminal or unknown run is acknowledged without error.
   * The result is only the ACK ({ runId, cancelled }). Additive — existing run
   * lifecycles are unchanged when no cancel is issued.
   */
  RunCancel: "run/cancel",
  /**
   * RESPOND to a PENDING approval (remote-control: the phone's `approvals.respond`).
   * The only interactive approval today is a PENDING governed build: a build request
   * created via {@link AgenticBuildStart} WITHOUT `approved:true` is held as a
   * pending approval (codex NOT spawned) rather than refused. On `allow`, the
   * supervisor GRANTS the authority and starts the held build down the SAME approved
   * path (`approved:true`) — governed codex edits files + the signed verdict streams.
   * On `deny`, the pending build is DISCARDED (a terminal `build/event` error, no
   * codex). The result is only the ACK ({ approvalId, decision, runId? }). Additive:
   * a direct `build/start {approved:true}` still starts immediately as today.
   */
  ApprovalRespond: "approval/respond"
};
var BridgeNotification = {
  /** A run lifecycle/trace event streamed back to the client for the panel. */
  RunEvent: "run/event",
  /**
   * One chat-turn stream event (M7 chat). After a {@link BridgeMethod.ChatSend}
   * ack, the supervisor emits a sequence of these tagged with the same `turnId`:
   * zero or more `delta` events as the assistant answer arrives, then exactly one
   * terminal `done` (full text + optional usage) or `error`. The payload is a
   * {@link ChatStreamEvent} — the chat-turn event discriminated union plus the
   * `turnId`. Carries assistant TEXT (the answer the UI renders), never a
   * credential.
   */
  ChatDelta: "chat/delta",
  /**
   * One agentic-build stream event (Phase B). After a
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
  AgenticBuildEvent: "build/event"
};
var BridgeErrorCode = {
  /** Malformed envelope / JSON parse failure on the wire. */
  ParseError: -32700,
  /** Unknown method or bad params shape. */
  InvalidRequest: -32600,
  /** The supervisor binary's on-disk hash did not match the pinned value. */
  HashMismatch: -32010,
  /** Handshake reported incompatible bridge/supervisor versions. */
  VersionIncompatible: -32011,
  /** A run request was missing a required identity or posture field. */
  IdentityMissing: -32012,
  /** The run was refused for a non-identity policy reason. */
  RunRefused: -32013
};
var ACTOR_TYPES = [
  "native",
  "claude-code-cli",
  "codex-cli"
];
var EXTENSION_POSTURES = [
  "sovereign",
  "developer"
];
var AUTONOMY_TIERS = [
  "disabled",
  "allowlist",
  "auto",
  "turbo"
];
function shapeNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isBuildVerdictSignaturePresent(signature) {
  return !!signature && shapeNonEmptyString(signature.alg) && shapeNonEmptyString(signature.value) && shapeNonEmptyString(signature.keyId);
}
function computeBuildAssurance(input) {
  const independentlyVerified = input.verifierIsolation === "independent-sandboxed" && input.verifyRan === true && input.overall !== "error" && isBuildVerdictSignaturePresent(input.signature);
  return independentlyVerified ? "full" : "degraded";
}
function validateRunRequest(input) {
  const missing = [];
  const req = input ?? {};
  const nonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
  if (!nonEmptyString(req.actorType) || !ACTOR_TYPES.includes(req.actorType)) {
    missing.push("actorType");
  }
  if (!nonEmptyString(req.autonomyTier) || !AUTONOMY_TIERS.includes(req.autonomyTier)) {
    missing.push("autonomyTier");
  }
  if (!nonEmptyString(req.policyPath)) missing.push("policyPath");
  if (!nonEmptyString(req.policyHash)) missing.push("policyHash");
  if (!nonEmptyString(req.workspaceRoot)) missing.push("workspaceRoot");
  if (!nonEmptyString(req.runtimeProfile)) missing.push("runtimeProfile");
  if (!nonEmptyString(req.extensionPosture) || !EXTENSION_POSTURES.includes(req.extensionPosture)) {
    missing.push("extensionPosture");
  }
  const hasCommit = nonEmptyString(req.sourceCommit);
  const hasBase = nonEmptyString(req.worktreeBase);
  if (hasCommit === hasBase) {
    missing.push("sourceCommit|worktreeBase");
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, request: req };
}
function isEnvelope(value) {
  return typeof value === "object" && value !== null && value.glyphspek === BRIDGE_JSONRPC;
}
function isRequest(value) {
  if (!isEnvelope(value)) return false;
  const v = value;
  return typeof v.id === "number" && typeof v.method === "string";
}

// ../spikes/p0-supervisor/lifecycle.ts
var IllegalTransitionError = class extends Error {
  from;
  to;
  constructor(from, to) {
    super(`illegal run state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
};
var RunLifecycle = class {
  _state;
  _history;
  constructor(initial = "created") {
    this._state = initial;
    this._history = [{ state: initial, ts: Date.now() }];
  }
  /** The current run state. */
  get state() {
    return this._state;
  }
  /** True iff the current state is terminal (no outgoing transitions). */
  get isTerminal() {
    return isTerminalState(this._state);
  }
  /** Ordered, defensive copy of the lifecycle history (oldest first). */
  history() {
    return this._history.map((step) => ({ ...step }));
  }
  /** True iff a transition to `next` is currently legal. */
  canTransitionTo(next) {
    return canTransition(this._state, next);
  }
  /**
   * Transition the run into `next`.
   *
   * @throws IllegalTransitionError if the FSM forbids the move.
   * @returns the new (now current) state.
   */
  transition(next, reason) {
    if (!canTransition(this._state, next)) {
      throw new IllegalTransitionError(this._state, next);
    }
    this._state = next;
    this._history.push({ state: next, ts: Date.now(), reason });
    return this._state;
  }
};

// ../spikes/p0-supervisor/scripted-run-driver.ts
import { join as join2 } from "node:path";
import { generateKeyPairSync as generateKeyPairSync2 } from "node:crypto";

// ../spikes/p0-trace/trace-store.ts
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, existsSync, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname } from "node:path";

// ../spikes/p0-trace/canonical-json.ts
function isPlainArray(value) {
  return Array.isArray(value);
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function canonicalJson(obj) {
  return encode(obj);
}
function encode(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  if (t === "boolean") return value ? "true" : "false";
  if (isPlainArray(value)) {
    const parts = value.map(
      (item) => item === void 0 ? "null" : encode(item)
    );
    return `[${parts.join(",")}]`;
  }
  if (isPlainObject2(value)) {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const v = value[key];
      if (v === void 0) continue;
      parts.push(`${JSON.stringify(key)}:${encode(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  if (t === "bigint") {
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  return "undefined";
}

// ../spikes/p0-trace/trace-store.ts
var GENESIS_HASH = "0".repeat(64);
function hashableContent(evt) {
  const content = {
    v: evt.v,
    runId: evt.runId,
    seq: evt.seq,
    ts: evt.ts,
    type: evt.type,
    payload: evt.payload
  };
  if (evt.source !== void 0) {
    content.source = evt.source;
  }
  return content;
}
function computeHash(prevHash, content) {
  const h = createHash("sha256");
  h.update(prevHash);
  h.update(canonicalJson(hashableContent(content)));
  return h.digest("hex");
}
function createTraceWriter(traceFilePath) {
  const dir = dirname(traceFilePath);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync2(dir, { recursive: true });
  }
  let nextSeq = 0;
  let prevHash = GENESIS_HASH;
  if (existsSync(traceFilePath)) {
    const existing = readTrace(traceFilePath);
    if (existing.length > 0) {
      const last = existing[existing.length - 1];
      nextSeq = last.seq + 1;
      prevHash = last.hash;
    }
  }
  const append = (evt) => {
    const seq = nextSeq;
    const ts = Date.now();
    const v = typeof evt.v === "number" ? evt.v : TRACE_EVENT_VERSION;
    const content = {
      v,
      runId: evt.runId,
      seq,
      ts,
      type: evt.type,
      payload: evt.payload
    };
    if (evt.source !== void 0) {
      content.source = evt.source;
    }
    const hash = computeHash(prevHash, content);
    const full = {
      v,
      runId: evt.runId,
      seq,
      ts,
      type: evt.type,
      prevHash,
      hash,
      payload: evt.payload
    };
    if (evt.source !== void 0) {
      full.source = evt.source;
    }
    appendFileSync(traceFilePath, canonicalJson(full) + "\n", "utf8");
    nextSeq = seq + 1;
    prevHash = hash;
    return full;
  };
  return { path: traceFilePath, append };
}
function readTrace(path4) {
  if (!existsSync(path4)) return [];
  const raw = readFileSync(path4, "utf8");
  const events = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `readTrace: invalid JSON on line ${i + 1} of ${path4}: ${err.message}`
      );
    }
    events.push(parsed);
  }
  return events;
}
function computeTraceRoot(events) {
  if (events.length === 0) return GENESIS_HASH;
  return events[events.length - 1].hash;
}
function verifyChain(events) {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.prevHash !== expectedPrev) {
      return { ok: false, brokenIndex: i };
    }
    const recomputed = computeHash(evt.prevHash, hashableContent(evt));
    if (recomputed !== evt.hash) {
      return { ok: false, brokenIndex: i };
    }
    expectedPrev = evt.hash;
  }
  return { ok: true };
}

// ../spikes/p0-verifier/signing.ts
import {
  createHash as createHash2,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
var SIGNATURE_ALG = "ed25519";
function keyIdForPublicKey(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return createHash2("sha256").update(spki).digest("hex").slice(0, 16);
}
function generateVerifierKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, keyId: keyIdForPublicKey(publicKey) };
}
function verdictMessage(core) {
  const { signature: _ignored, ...verdict } = core;
  void _ignored;
  const message = canonicalJson({
    traceRootHash: verdict.traceRootHash,
    verdict
  });
  return Buffer.from(message, "utf8");
}
function signVerdict(core, privateKey, keyId) {
  const signatureBytes = cryptoSign(null, verdictMessage(core), privateKey);
  const resolvedKeyId = keyId ?? keyIdForPublicKey(createPublicKey(privateKey));
  return {
    alg: SIGNATURE_ALG,
    value: signatureBytes.toString("base64"),
    keyId: resolvedKeyId
  };
}

// ../spikes/p0-supervisor/policy/load.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { extname } from "node:path";
function loadPolicy(path4) {
  const ext = extname(path4).toLowerCase();
  if (ext === ".yml" || ext === ".yaml") {
    throw new Error(`P0 uses JSON policy; convert ${path4}`);
  }
  let text;
  try {
    text = readFileSync2(path4, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { errors: [`could not read policy file ${path4}: ${reason}`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { errors: [`policy file ${path4} is not valid JSON: ${reason}`] };
  }
  return parsePolicy(raw);
}

// ../spikes/p0-supervisor/policy/glob.ts
function decompose(p) {
  const norm = p.replace(/\\/g, "/");
  const absolute = norm.startsWith("/");
  const raw = norm.split("/").filter((s) => s.length > 0);
  return { absolute, segs: canonicalizeSegments(raw, absolute) };
}
function canonicalizeSegments(segs, absolute) {
  const out = [];
  for (const seg of segs) {
    if (seg === ".") continue;
    if (seg === "..") {
      const top = out[out.length - 1];
      if (top !== void 0 && top !== "..") {
        out.pop();
      } else if (!absolute) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  return out;
}
function matchSegment(pattern, segment) {
  if (!pattern.includes("*")) {
    return pattern === segment;
  }
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < segment.length) {
    if (pi < pattern.length && (pattern[pi] === segment[si] || pattern[pi] === "*")) {
      if (pattern[pi] === "*") {
        star = pi;
        mark = si;
        pi++;
      } else {
        pi++;
        si++;
      }
    } else if (star !== -1) {
      pi = star + 1;
      mark++;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}
function globMatch(pattern, target) {
  const p = decompose(pattern);
  const t = decompose(target);
  if (p.absolute !== t.absolute) return false;
  return matchSegments(p.segs, 0, t.segs, 0);
}
function matchSegments(pSegs, pi, tSegs, ti) {
  while (pi < pSegs.length) {
    const pat = pSegs[pi];
    if (pat === "**") {
      let nextPi = pi + 1;
      while (nextPi < pSegs.length && pSegs[nextPi] === "**") nextPi++;
      if (nextPi === pSegs.length) return true;
      for (let k = ti; k <= tSegs.length; k++) {
        if (matchSegments(pSegs, nextPi, tSegs, k)) return true;
      }
      return false;
    }
    if (ti >= tSegs.length) return false;
    if (!matchSegment(pat, tSegs[ti])) return false;
    pi++;
    ti++;
  }
  return ti === tSegs.length;
}
function anyGlobMatch(patterns, target) {
  for (const p of patterns) {
    if (globMatch(p, target)) return true;
  }
  return false;
}

// ../spikes/p0-supervisor/policy/decide.ts
function readPath(payload) {
  if (typeof payload === "object" && payload !== null) {
    const p = payload.path;
    if (typeof p === "string") return p;
  }
  return void 0;
}
function readArgv(payload) {
  if (typeof payload === "object" && payload !== null) {
    const a = payload.argv;
    if (Array.isArray(a) && a.every((t) => typeof t === "string")) return a;
  }
  return void 0;
}
function readHost(payload) {
  if (typeof payload === "object" && payload !== null) {
    const h = payload.host;
    if (typeof h === "string") return h;
  }
  return void 0;
}
function matchCommandRule(rule, argv) {
  if (rule.length === 0) return argv.length === 0;
  for (let i = 0; i < rule.length; i++) {
    const tok = rule[i];
    const isLast = i === rule.length - 1;
    if (tok === "*") {
      if (isLast) {
        return argv.length >= rule.length;
      }
      if (i >= argv.length) return false;
      continue;
    }
    if (i >= argv.length || argv[i] !== tok) return false;
  }
  return argv.length === rule.length;
}
function anyCommandMatch(rules, argv) {
  for (const rule of rules) {
    if (matchCommandRule(rule, argv)) return true;
  }
  return false;
}
function verbToDecision(verb) {
  return verb;
}
function applyTaintFirewall(decision, request) {
  if (decision !== "allow") return decision;
  if (request.tool === "file_read") return decision;
  if (UNTRUSTED_PROVENANCE.includes(request.provenanceLabel)) {
    return "force_ask";
  }
  return decision;
}
function decide(policy, request) {
  return applyTaintFirewall(decideRaw(policy, request), request);
}
function decideRaw(policy, request) {
  switch (request.tool) {
    case "file_read": {
      const path4 = readPath(request.payload);
      if (path4 !== void 0) {
        if (anyGlobMatch(policy.deny.read_paths, path4)) return "deny";
        if (anyGlobMatch(policy.allow.read_paths, path4)) return "allow";
      }
      return verbToDecision(policy.defaults.file_read);
    }
    case "file_write": {
      const path4 = readPath(request.payload);
      if (path4 !== void 0) {
        if (anyGlobMatch(policy.deny.write_paths, path4)) return "deny";
        if (anyGlobMatch(policy.allow.write_paths, path4)) return "allow";
      }
      return verbToDecision(policy.defaults.file_write);
    }
    case "command": {
      const argv = readArgv(request.payload);
      if (argv !== void 0) {
        if (anyCommandMatch(policy.deny.commands, argv)) return "deny";
        if (anyCommandMatch(policy.allow.commands, argv)) return "allow";
      }
      return verbToDecision(policy.defaults.command);
    }
    case "network": {
      const host = readHost(request.payload);
      if (host !== void 0 && policy.allow.network.includes(host)) return "allow";
      return verbToDecision(policy.defaults.network);
    }
    default: {
      const _exhaustive = request.tool;
      void _exhaustive;
      return "deny";
    }
  }
}

// ../spikes/p0-supervisor/scripted-run-driver.ts
var RUN_EVENT_PROTOCOL_VERSION = 1;
function builtinScriptedPolicy() {
  return {
    version: 1,
    defaults: {
      file_read: "allow",
      file_write: "allow",
      command: "deny",
      network: "deny",
      mcp: "deny"
    },
    allow: {
      read_paths: ["**"],
      write_paths: ["src/**", "test/**"],
      // argv rules: `npm test` is allowed; `*` matches a single trailing token.
      commands: [["npm", "*"]],
      network: ["registry.npmjs.org"]
    },
    deny: { read_paths: [], write_paths: [], commands: [] },
    verify: [["npm", "test"]]
  };
}
function scriptedSteps(runId) {
  return [
    {
      request: {
        runId,
        tool: "command",
        payload: { argv: ["npm", "test"] },
        provenanceLabel: "repo",
        requestedCapability: "command:npm"
      },
      toolEnd: {
        argv: ["npm", "test"],
        exitCode: 0,
        durationMs: 8300,
        changedFiles: [
          { path: "src/date.ts", change: "M" },
          { path: "test/date.test.ts", change: "A" }
        ]
      }
    },
    {
      request: {
        runId,
        tool: "network",
        payload: { host: "registry.npmjs.org" },
        provenanceLabel: "repo",
        requestedCapability: "network:registry.npmjs.org"
      },
      toolEnd: { destination: "https://registry.npmjs.org" }
    }
  ];
}
async function driveScriptedRun(opts) {
  const { facts, emit } = opts;
  const now = opts.now ?? Date.now;
  const { runId, runDir } = facts;
  const policy = opts.policy ?? builtinScriptedPolicy();
  const lifecycle = opts.lifecycle ?? new RunLifecycle("created");
  const sink = opts.sink ?? createTraceWriter(join2(runSubdirPath(runDir, "trace"), "trace.jsonl"));
  const appendAndStream = (type, payload, source) => {
    const appended = sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      // the writer is authoritative for seq; it overwrites this.
      ts: now(),
      type,
      payload,
      ...source ? { source } : {}
    });
    emit({ rev: RUN_EVENT_PROTOCOL_VERSION, runId, kind: "trace_event", event: appended });
    return appended;
  };
  const transition = (to, reason) => {
    const from = lifecycle.state;
    lifecycle.transition(to, reason);
    emit({ rev: RUN_EVENT_PROTOCOL_VERSION, runId, kind: "state_changed", from, to, reason });
    const payload = { from, to, reason };
    appendAndStream("run_state_changed", payload);
  };
  emit({
    rev: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    kind: "run_opened",
    actorType: facts.actorType,
    trust: facts.creationTrust,
    runtimeProfile: facts.runtimeProfile,
    runtimeTrust: facts.runtimeTrust,
    extensionPosture: facts.extensionPosture,
    cliFidelity: facts.cliFidelity,
    state: lifecycle.state
  });
  const runCreated = { runId, runDir, provenanceLabel: "user" };
  appendAndStream("run_created", runCreated);
  transition("worktree_ready", "worktree provisioned");
  transition("sandbox_ready", "sandbox ready, egress default-deny");
  transition("executing", "entering execution");
  for (const step of scriptedSteps(runId)) {
    const decision = decide(policy, step.request);
    const policyDecision = {
      tool: step.request.tool,
      requestedCapability: step.request.requestedCapability,
      decision,
      ...step.request.provenanceLabel ? { provenanceLabel: step.request.provenanceLabel } : {}
    };
    appendAndStream("policy_decision", policyDecision, "policy");
    if (decision === "allow") {
      const toolEnd = {
        tool: step.request.tool,
        provenanceLabel: step.request.provenanceLabel,
        ...step.toolEnd
      };
      appendAndStream("tool_end", toolEnd);
    }
  }
  emit({
    rev: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    kind: "actor_claims",
    plan: "Fix date parsing and add a regression test.",
    summary: "Updated src/date.ts; all tests pass; ready to merge.",
    claimedChangedFiles: ["src/date.ts", "test/date.test.ts"],
    claimedChecks: [
      { name: "unit tests", claim: "pass" },
      { name: "typecheck", claim: "pass" }
    ]
  });
  transition("completed", "run complete");
  const finalEvents = sinkEvents(sink);
  const chain = verifyChain(finalEvents);
  const traceRootHash = chain.ok ? computeTraceRoot(finalEvents) : "0".repeat(64);
  const checks = policy.verify.map((cmd) => ({
    name: cmd.join(" ") || "(empty)",
    command: [...cmd],
    status: "pass"
  }));
  const overallVerdict = chain.ok ? "pass" : "error";
  const signature = signEphemeral(checks, overallVerdict, traceRootHash, opts.verifierPrivateKey);
  emit({
    rev: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    kind: "verifier_verdict",
    checks: checks.map((c) => ({ name: c.name, command: c.command, status: c.status })),
    overallVerdict,
    traceRootHash,
    signature
  });
  emit({
    rev: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    kind: "run_closed",
    finalState: lifecycle.state,
    eventCount: finalEvents.length
  });
  return {
    runId,
    finalState: lifecycle.state,
    eventCount: finalEvents.length,
    traceRootHash,
    overallVerdict
  };
}
function sinkEvents(sink) {
  const maybe = sink.events;
  if (Array.isArray(maybe)) return maybe;
  const path4 = sink.path;
  if (typeof path4 === "string") return readTrace(path4);
  return [];
}
function signEphemeral(checks, overallVerdict, traceRootHash, injectedKey) {
  const privateKey = injectedKey ?? generateKeyPairSync2("ed25519").privateKey;
  return signVerdict({ checks, overallVerdict, traceRootHash }, privateKey);
}

// ../spikes/p0-supervisor/terminal-session.ts
import { join as join4 } from "node:path";
import { generateKeyPairSync as generateKeyPairSync3 } from "node:crypto";

// ../spikes/p0-sandbox/worktree.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path2 from "node:path";
function createWorktree(repoPath, runId, intoDir) {
  void runId;
  fs.mkdirSync(path2.dirname(intoDir), { recursive: true });
  execFileSync("git", ["-C", repoPath, "worktree", "add", "--detach", intoDir, "HEAD"], {
    stdio: "pipe"
  });
  return { worktreeDir: intoDir };
}
function removeWorktree(repoPath, worktreeDir) {
  try {
    execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", worktreeDir], {
      stdio: "pipe"
    });
  } catch {
  }
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  try {
    execFileSync("git", ["-C", repoPath, "worktree", "prune"], { stdio: "pipe" });
  } catch {
  }
}
function createSyntheticHome(baseDir) {
  const home = path2.join(baseDir, "home");
  fs.mkdirSync(home, { recursive: true });
  return home;
}
var DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
function buildInjectedEnv(allow = []) {
  const env = { PATH: DEFAULT_PATH };
  for (const name of allow) {
    const value = process.env[name];
    if (value !== void 0) {
      env[name] = value;
    }
  }
  return env;
}

// ../spikes/p0-governed-cli/governed-terminal-proxy.ts
import { randomUUID as randomUUID3 } from "node:crypto";

// ../spikes/p0-sandbox/egress-proxy.ts
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { randomUUID as randomUUID2 } from "node:crypto";
import { request as httpRequest } from "node:http";
var LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";
function splitHostPort(authority) {
  const trimmed = authority.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close !== -1) {
      const host = trimmed.slice(0, close + 1);
      const rest = trimmed.slice(close + 1);
      if (rest.startsWith(":")) {
        const port2 = Number(rest.slice(1));
        return Number.isInteger(port2) ? { host, port: port2 } : { host };
      }
      return { host };
    }
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { host: trimmed };
  const portStr = trimmed.slice(idx + 1);
  const port = Number(portStr);
  if (portStr.length > 0 && Number.isInteger(port) && /^\d+$/.test(portStr)) {
    return { host: trimmed.slice(0, idx), port };
  }
  return { host: trimmed };
}
function isIpLiteral(host) {
  const h = host.trim();
  if (h.length === 0) return false;
  if (h.startsWith("[") && h.endsWith("]")) return true;
  if (h.includes(":")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    return v4.slice(1).every((o) => {
      const n = Number(o);
      return n >= 0 && n <= 255;
    });
  }
  return false;
}
function isHostAllowed(allow, host, port) {
  const targetHost = host.toLowerCase();
  for (const entry of allow) {
    const { host: aHost, port: aPort } = splitHostPort(entry);
    if (aHost.toLowerCase() !== targetHost) continue;
    if (aPort === void 0) return true;
    if (aPort === port) return true;
  }
  return false;
}
var DEFAULT_HTTP_PORT = 80;
var DEFAULT_HTTPS_PORT = 443;
function targetForHttp(req) {
  const rawUrl = req.url ?? "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
    try {
      const u = new URL(rawUrl);
      const host = u.hostname;
      const port = u.port ? Number(u.port) : DEFAULT_HTTP_PORT;
      if (host) return { host, port };
    } catch {
    }
  }
  const hostHeader = req.headers.host;
  if (typeof hostHeader === "string" && hostHeader.length > 0) {
    const { host, port } = splitHostPort(hostHeader);
    if (host) return { host, port: port ?? DEFAULT_HTTP_PORT };
  }
  return void 0;
}
function startEgressProxy(options) {
  const allow = options.allow;
  const bindHost = options.bindHost ?? "0.0.0.0";
  const bindPort = options.bindPort ?? 0;
  const denyDirectIp = options.denyDirectIp ?? true;
  const observeAll = options.observeAll ?? false;
  const upstreamLookup = {};
  for (const [k, v] of Object.entries(options.upstreamLookup ?? {})) {
    upstreamLookup[k.toLowerCase()] = v;
  }
  const dialHost = (requestedHost) => upstreamLookup[requestedHost.toLowerCase()] ?? requestedHost;
  const health = {
    decisionFailures: 0,
    tunnelFailures: 0,
    bytesFailures: 0,
    closeFailures: 0
  };
  const emit = (d) => {
    try {
      options.onDecision?.(d);
    } catch {
      health.decisionFailures += 1;
    }
  };
  const server2 = createServer();
  server2.on("request", (clientReq, clientRes) => {
    const target = targetForHttp(clientReq);
    if (!target) {
      emit({
        id: randomUUID2(),
        ts: Date.now(),
        kind: "http",
        decision: "deny",
        host: "",
        port: 0,
        method: clientReq.method,
        reason: "no-target"
      });
      clientRes.writeHead(400, { "content-type": "text/plain" });
      clientRes.end("egress proxy: could not determine target host\n");
      return;
    }
    const allowed = observeAll || isHostAllowed(allow, target.host, target.port);
    if (!observeAll) {
      if (denyDirectIp && isIpLiteral(target.host)) {
        emit({
          id: randomUUID2(),
          ts: Date.now(),
          kind: "http",
          decision: "deny",
          host: target.host,
          port: target.port,
          method: clientReq.method,
          reason: "direct-ip"
        });
        clientRes.writeHead(403, { "content-type": "text/plain" });
        clientRes.end(
          `egress denied: direct IP literal not permitted (use an allowlisted name; the proxy is the controlled resolver): ${target.host}:${target.port}
`
        );
        clientReq.resume();
        return;
      }
    }
    emit({
      id: randomUUID2(),
      ts: Date.now(),
      kind: "http",
      decision: allowed ? "allow" : "deny",
      // Observe-not-block ALLOWS are OBSERVATIONS, not policy authorizations: mark
      // them so a consumer can never mistake a soft-plane observe for a real allow.
      ...observeAll ? { enforcement: "observe-only" } : {},
      host: target.host,
      port: target.port,
      method: clientReq.method,
      reason: observeAll ? "observed" : "allowlist"
    });
    if (!allowed) {
      clientRes.writeHead(403, { "content-type": "text/plain" });
      clientRes.end(
        `egress denied by allowlist: ${target.host}:${target.port}
`
      );
      clientReq.resume();
      return;
    }
    const upstream = httpRequest(
      {
        host: dialHost(target.host),
        port: target.port,
        method: clientReq.method,
        // Strip the absolute-form prefix: upstream expects an origin-form path.
        path: originFormPath(clientReq.url ?? "/"),
        headers: clientReq.headers
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    );
    upstream.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "text/plain" });
      }
      clientRes.end(`egress proxy upstream error: ${err.message}
`);
    });
    clientReq.pipe(upstream);
  });
  server2.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", () => {
    });
    const authority = req.url ?? "";
    const { host, port } = splitHostPort(authority);
    const targetPort = port ?? DEFAULT_HTTPS_PORT;
    if (!observeAll) {
      if (denyDirectIp && host.length > 0 && isIpLiteral(host)) {
        emit({
          id: randomUUID2(),
          ts: Date.now(),
          kind: "connect",
          decision: "deny",
          host,
          port: targetPort,
          reason: "direct-ip"
        });
        clientSocket.write(
          `HTTP/1.1 403 Forbidden\r
Content-Type: text/plain\r
Connection: close\r
\r
egress denied: direct IP literal not permitted (use an allowlisted name; the proxy is the controlled resolver): ${host}:${targetPort}
`
        );
        clientSocket.end();
        return;
      }
    }
    const allowed = host.length > 0 && (observeAll || isHostAllowed(allow, host, targetPort));
    const observeOnly = observeAll && host.length > 0;
    emit({
      id: randomUUID2(),
      ts: Date.now(),
      kind: "connect",
      decision: allowed ? "allow" : "deny",
      ...observeOnly ? { enforcement: "observe-only" } : {},
      host,
      port: targetPort,
      reason: host.length === 0 ? "no-target" : observeAll ? "observed" : "allowlist"
    });
    if (!allowed) {
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r
Content-Type: text/plain\r
Connection: close\r
\r
egress denied by allowlist: ${host}:${targetPort}
`
      );
      clientSocket.end();
      return;
    }
    let observer;
    let bytesUp = 0;
    let bytesDown = 0;
    let openedAt = 0;
    let closed = false;
    const tunnelId = randomUUID2();
    const upstream = netConnect(targetPort, dialHost(host), () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      if (options.onTunnel) {
        try {
          observer = options.onTunnel({ host, port: targetPort, id: tunnelId });
        } catch {
          observer = void 0;
          health.tunnelFailures += 1;
        }
        openedAt = Date.now();
        if (head && head.length > 0) {
          bytesUp += head.length;
          try {
            observer?.onBytes?.("up", head.length);
          } catch {
            health.bytesFailures += 1;
          }
        }
        clientSocket.on("data", (chunk) => {
          bytesUp += chunk.length;
          try {
            observer?.onBytes?.("up", chunk.length);
          } catch {
            health.bytesFailures += 1;
          }
        });
        upstream.on("data", (chunk) => {
          bytesDown += chunk.length;
          try {
            observer?.onBytes?.("down", chunk.length);
          } catch {
            health.bytesFailures += 1;
          }
        });
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const emitClose = () => {
      if (closed || !options.onTunnel || openedAt === 0) return;
      closed = true;
      try {
        observer?.onClose?.({
          bytesUp,
          bytesDown,
          durationMs: Date.now() - openedAt
        });
      } catch {
        health.closeFailures += 1;
      }
    };
    const teardownPair = () => {
      emitClose();
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", teardownPair);
    clientSocket.on("error", teardownPair);
    upstream.on("close", emitClose);
    clientSocket.on("close", emitClose);
  });
  server2.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  return new Promise((resolve2, reject) => {
    server2.once("error", reject);
    server2.listen(bindPort, bindHost, () => {
      server2.removeListener("error", reject);
      const addr = server2.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("egress proxy: failed to resolve bound address"));
        return;
      }
      const port = addr.port;
      const proxyHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
      resolve2({
        port,
        url: `http://${proxyHost}:${port}`,
        proxyHost,
        observerHealth() {
          return { ...health };
        },
        close() {
          return new Promise((res) => {
            server2.close(() => res());
            const anyServer = server2;
            anyServer.closeAllConnections?.();
          });
        }
      });
    });
  });
}
function originFormPath(rawUrl) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl)) {
    try {
      const u = new URL(rawUrl);
      return u.pathname + u.search;
    } catch {
      return rawUrl;
    }
  }
  return rawUrl || "/";
}

// ../spikes/p0-governed-cli/governed-terminal-proxy.ts
var DEFAULT_ORIGIN_ASSURANCE = "narrow-api";
var DEFAULT_MODEL_ENDPOINTS = [
  // NARROW provider API origins: a dedicated host that serves essentially nothing
  // but the model API, so a host match is STRONG model-call evidence.
  { host: "api.anthropic.com", port: 443, provider: "anthropic", model: "anthropic-model (boundary)", originAssurance: "narrow-api" },
  { host: "api.openai.com", port: 443, provider: "openai", model: "openai-model (boundary)", originAssurance: "narrow-api" },
  // Codex CLI on a ChatGPT SUBSCRIPTION sign-in (the common case — see
  // docs/governed-terminal.md §5) does NOT hit api.openai.com: it routes model calls
  // through chatgpt.com/backend-api/codex/responses, tied to the user's ChatGPT plan
  // rate limits. Without this endpoint, a subscription-Codex run's egress to
  // chatgpt.com would be DENIED by the allowlist (it could not reach its model) and
  // its calls would not classify as model_call metadata. We classify the HOST only
  // (metadata-only; we never read the /backend-api path off the encrypted wire), pinned
  // :443. API-KEY Codex auth uses api.openai.com (already classified above).
  //
  // BUT chatgpt.com is a BROAD consumer origin (web app, auth, assets, telemetry) —
  // the model API is only ONE path under it, and the metadata-only proxy cannot see
  // the path. So a host match here is WEAK model-call evidence: marked 'broad-web' so
  // the boundary model_call carries lower assurance and the Trust Panel labels it
  // honestly (host-only evidence, path not verified). We keep it (functionally
  // required for subscription Codex) but never over-claim it as a narrow-API call.
  { host: "chatgpt.com", port: 443, provider: "openai", model: "codex-model (boundary)", originAssurance: "broad-web" },
  {
    host: "generativelanguage.googleapis.com",
    port: 443,
    provider: "google",
    model: "gemini-model (boundary)",
    originAssurance: "narrow-api"
  }
];
var AGENT_SUPPORT_HOSTS = {
  "claude-code-cli": ["claude.ai", "console.anthropic.com", "downloads.claude.ai", "platform.claude.com", "statsig.anthropic.com"],
  "codex-cli": ["auth.openai.com"]
};
function agentSupportAllowEntries(actorType) {
  return (AGENT_SUPPORT_HOSTS[actorType] ?? []).map((h) => `${h}:443`);
}
function classifyModelEndpoint(endpoints, host) {
  const target = host.trim().toLowerCase();
  return endpoints.find((e) => e.host.trim().toLowerCase() === target);
}
async function startGovernedTerminalProxy(opts) {
  const endpoints = opts.modelEndpoints ?? DEFAULT_MODEL_ENDPOINTS;
  const provenanceLabel = opts.provenanceLabel ?? "tool-output";
  const { sink, runId } = opts;
  let appendFailures = 0;
  const emit = (type, payload) => {
    try {
      sink.append({
        v: TRACE_EVENT_VERSION,
        runId,
        seq: 0,
        ts: Date.now(),
        type,
        payload
      });
    } catch {
      appendFailures += 1;
    }
  };
  const onDecision = (d) => {
    const observeOnly = d.enforcement === "observe-only" || d.reason === "observed";
    const payload = {
      tool: "network",
      requestedCapability: `network:${d.host}:${d.port}`,
      decision: d.decision,
      ...observeOnly ? { enforcement: "observe-only" } : {},
      provenanceLabel,
      // Non-secret human-readable rule mirroring the proxy's own reason vocabulary.
      rule: d.decision === "allow" ? observeOnly ? `observed \u2014 soft default-allow, NOT a policy authorization (governed-unsandboxed: metadata-only trace) (${d.kind})` : `egress allowed by allowlist (${d.kind})` : d.reason === "direct-ip" ? "egress denied: direct-IP literal (controlled-resolver bypass)" : d.reason === "no-target" ? "egress denied: no target host" : `egress denied by allowlist (${d.kind})`
    };
    emit("policy_decision", payload);
  };
  const onTunnel = (info) => {
    const endpoint = classifyModelEndpoint(endpoints, info.host);
    if (!endpoint) return;
    return {
      onClose: (summary) => {
        const payload = {
          model: endpoint.model,
          provider: endpoint.provider,
          endpointHost: endpoint.host,
          durationMs: summary.durationMs,
          // Additive boundary fields (ciphertext byte counts only).
          bytesUp: summary.bytesUp,
          bytesDown: summary.bytesDown,
          // tokens/cost are DELIBERATELY ABSENT — metadata-only cannot see them.
          observation: "metadata-only",
          // How strong the host-match is as model-call evidence (sweep-24 #1). A
          // broad-web origin (chatgpt.com) is HOST-ONLY evidence — the path is not
          // visible in metadata mode — so it is carried as lower assurance and the
          // Trust Panel labels it accordingly. Default narrow-api when unset.
          originAssurance: endpoint.originAssurance ?? DEFAULT_ORIGIN_ASSURANCE,
          provenanceLabel
        };
        emit("model_call", payload);
      }
    };
  };
  const proxy = await startEgressProxy({
    allow: opts.allow,
    bindHost: opts.bindHost ?? "127.0.0.1",
    bindPort: opts.bindPort ?? 0,
    denyDirectIp: opts.denyDirectIp,
    ...opts.observeAll !== void 0 ? { observeAll: opts.observeAll } : {},
    onDecision,
    onTunnel
  });
  return {
    proxy,
    url: proxy.url,
    traceHealth() {
      const obs = proxy.observerHealth();
      const observerFailures = obs.decisionFailures + obs.tunnelFailures + obs.bytesFailures + obs.closeFailures;
      return {
        appendFailures,
        degraded: appendFailures > 0 || observerFailures > 0
      };
    },
    close: () => proxy.close()
  };
}

// ../spikes/p0-supervisor/terminal-session.ts
function deriveSandboxTrust(caps) {
  if (caps.fsIsolated && caps.hardEgress) return "trusted";
  if (caps.fsIsolated) return "sandboxed-soft-egress";
  return "governed-unsandboxed";
}
async function startTerminalSession(opts) {
  const { facts, emit } = opts;
  const now = opts.now ?? Date.now;
  const { runId, runDir } = facts;
  const lifecycle = opts.lifecycle ?? new RunLifecycle("created");
  const sink = opts.sink ?? createTraceWriter(join4(runSubdirPath(runDir, "trace"), "trace.jsonl"));
  const endpoints = opts.modelEndpoints ?? DEFAULT_MODEL_ENDPOINTS;
  const isolation = opts.isolation;
  const allow = [
    ...endpoints.map((e) => `${e.host}:${e.port ?? 443}`),
    ...agentSupportAllowEntries(facts.actorType)
  ];
  const appendAndStream = (type, payload, source) => {
    const appended = sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      // the writer is authoritative for seq; it overwrites this.
      ts: now(),
      type,
      payload,
      ...source ? { source } : {}
    });
    emit({ rev: RUN_EVENT_PROTOCOL_VERSION, runId, kind: "trace_event", event: appended });
    return appended;
  };
  const transition = (to, reason) => {
    const from = lifecycle.state;
    lifecycle.transition(to, reason);
    emit({ rev: RUN_EVENT_PROTOCOL_VERSION, runId, kind: "state_changed", from, to, reason });
    const payload = { from, to, reason };
    appendAndStream("run_state_changed", payload, "policy");
  };
  const egressProjector = (d) => {
    const policy = {
      tool: "network",
      requestedCapability: `network:${d.host}:${d.port}`,
      decision: d.decision,
      provenanceLabel: "tool-output",
      rule: d.decision === "allow" ? `egress allowed by allowlist (${d.kind})` : d.reason === "direct-ip" ? "egress denied: direct-IP literal (controlled-resolver bypass)" : d.reason === "no-target" ? "egress denied: no target host" : `egress denied by allowlist (${d.kind})`
    };
    appendAndStream("policy_decision", policy);
    if (d.decision === "allow") {
      const endpoint = classifyModelEndpoint(endpoints, d.host);
      if (endpoint) {
        const call = {
          model: endpoint.model,
          provider: endpoint.provider,
          endpointHost: endpoint.host,
          // Boundary observation: tokens/cost DELIBERATELY absent (we never decrypt).
          observation: "metadata-only",
          // Host-match evidence strength (sweep-24 #1): a broad-web origin is
          // host-only evidence (path unverified in metadata mode). Default narrow-api.
          originAssurance: endpoint.originAssurance ?? DEFAULT_ORIGIN_ASSURANCE,
          provenanceLabel: "tool-output"
        };
        appendAndStream("model_call", call);
      }
    }
  };
  let openedTrust = facts.creationTrust;
  let openedRuntimeTrust = facts.runtimeTrust;
  let isolationRuntime;
  let isolationSpec;
  if (isolation) {
    isolationRuntime = isolation.runtimeFactory(egressProjector);
    isolationSpec = {
      runId,
      // workdir/home filled in once the worktree is provisioned (below); the
      // capability probe does not depend on them, so placeholders are fine and are
      // overwritten before createSandbox.
      workdir: "",
      home: "",
      env: {},
      ...isolation.resourceLimits ? { resourceLimits: isolation.resourceLimits } : {},
      // EXPLICIT soft-egress opt-in: the runtime's allowlist is application-layer on
      // Docker-local, acknowledged here with eyes open (the derived posture reflects
      // it honestly). network:'deny' would be hard but would also cut the actor off
      // from its model endpoint entirely.
      network: { allow, acknowledgeSoftEgress: true }
    };
    const caps = runtimeCapabilities(isolationRuntime, isolationSpec);
    openedTrust = deriveSandboxTrust(caps);
    openedRuntimeTrust = caps.fsIsolated ? "trusted" : "untrusted";
  }
  const loopbackBypass = !isolation;
  emit({
    rev: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    kind: "run_opened",
    actorType: facts.actorType,
    ...facts.actorVersion ? { actorVersion: facts.actorVersion } : {},
    ...facts.actorBinary ? { actorBinary: facts.actorBinary } : {},
    trust: openedTrust,
    runtimeProfile: facts.runtimeProfile,
    runtimeTrust: openedRuntimeTrust,
    extensionPosture: facts.extensionPosture,
    cliFidelity: facts.cliFidelity,
    state: lifecycle.state,
    ...loopbackBypass ? {
      loopbackProxyBypass: true,
      loopbackProxyBypassReason: "loopback (localhost,127.0.0.1,::1) is exempt from the governed egress proxy (local IPC / a CLI localhost OAuth callback, NOT external egress) \u2014 so loopback bypasses the proxy and is NOT recorded in the trace"
    } : {}
  });
  const runCreated = {
    runId,
    runDir,
    // A terminal-launched CLI is an external opaque actor: its egress is
    // boundary-observed (untrusted provenance), recorded honestly.
    provenanceLabel: "tool-output",
    ...facts.actorBinary ? { actorBinary: facts.actorBinary } : {}
  };
  appendAndStream("run_created", runCreated);
  transition("worktree_ready", "governed terminal session opening");
  transition("sandbox_ready", "egress governance proxy starting (metadata-only)");
  const projectionSink = {
    append: (evt) => {
      const appended = sink.append(evt);
      emit({ rev: RUN_EVENT_PROTOCOL_VERSION, runId, kind: "trace_event", event: appended });
      return appended;
    }
  };
  const proxy = await startGovernedTerminalProxy({
    allow,
    sink: projectionSink,
    runId,
    modelEndpoints: endpoints,
    observeAll: true,
    bindHost: opts.bindHost ?? "127.0.0.1",
    ...opts.denyDirectIp !== void 0 ? { denyDirectIp: opts.denyDirectIp } : {}
  });
  transition("executing", "governed terminal session live (proxy bound)");
  let worktreeDir;
  let sandbox;
  let stopped = false;
  let finalVerdict;
  if (isolation && isolationRuntime && isolationSpec) {
    let toolStarted = false;
    try {
      worktreeDir = createWorktree(
        isolation.repoPath,
        runId,
        join4(runDir, "worktree")
      ).worktreeDir;
      const home = createSyntheticHome(join4(runDir, "home"));
      const env = buildInjectedEnv(isolation.envAllow ?? []);
      const spec = { ...isolationSpec, workdir: worktreeDir, home, env };
      sandbox = await isolationRuntime.createSandbox(spec);
      const requestedCapability = `command:${isolation.command[0]}`;
      const toolStart = {
        tool: "command",
        requestedCapability,
        provenanceLabel: "tool-output"
      };
      appendAndStream("tool_start", toolStart);
      toolStarted = true;
      const startedAt = now();
      const result = await sandbox.exec({ command: isolation.command });
      const toolEnd = {
        tool: "command",
        exitCode: result.exitCode,
        durationMs: now() - startedAt,
        provenanceLabel: "tool-output",
        stdoutLength: result.stdout.length
      };
      appendAndStream("tool_end", toolEnd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const refusal = {
          tool: "command",
          requestedCapability: `command:${isolation.command[0]}`,
          decision: "deny",
          provenanceLabel: "tool-output",
          rule: `isolation provisioning failed/refused: ${reason}`
        };
        appendAndStream("policy_decision", refusal, "policy");
        if (toolStarted) {
          const toolEndFail = {
            tool: "command",
            exitCode: -1,
            durationMs: 0,
            provenanceLabel: "tool-output",
            stdoutLength: 0
          };
          appendAndStream("tool_end", toolEndFail);
        }
      } catch {
      }
      await proxy.close();
      if (sandbox) {
        await sandbox.teardown().catch(() => void 0);
      }
      if (worktreeDir) {
        try {
          removeWorktree(isolation.repoPath, worktreeDir);
        } catch {
        }
      }
      finalVerdict = finalizeTerminalRun({
        runId,
        sink,
        lifecycle,
        degraded: true,
        emit,
        now,
        ...opts.verifierPrivateKey ? { verifierPrivateKey: opts.verifierPrivateKey } : {}
      });
      stopped = true;
      throw err instanceof Error ? err : new Error(reason);
    }
  }
  const stop = async () => {
    if (stopped && finalVerdict) return finalVerdict;
    stopped = true;
    const health = proxy.traceHealth();
    await proxy.close();
    if (sandbox) {
      await sandbox.teardown().catch(() => void 0);
    }
    if (isolation && worktreeDir) {
      try {
        removeWorktree(isolation.repoPath, worktreeDir);
      } catch {
      }
    }
    finalVerdict = finalizeTerminalRun({
      runId,
      sink,
      lifecycle,
      degraded: health.degraded,
      emit,
      now,
      ...opts.verifierPrivateKey ? { verifierPrivateKey: opts.verifierPrivateKey } : {}
    });
    return finalVerdict;
  };
  return { runId, proxyUrl: proxy.url, stop };
}
function finalizeTerminalRun(opts) {
  const { runId, sink, lifecycle, emit } = opts;
  const now = opts.now ?? Date.now;
  const from = lifecycle.state;
  if (from === "executing") {
    lifecycle.transition("completed", "governed terminal session stopped");
    emit({
      rev: RUN_EVENT_PROTOCOL_VERSION,
      runId,
      kind: "state_changed",
      from,
      to: "completed",
      reason: "governed terminal session stopped"
    });
    const payload = {
      from,
      to: "completed",
      reason: "governed terminal session stopped"
    };
    const appended = sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      ts: now(),
      type: "run_state_changed",
      payload,
      source: "policy"
    });
    emit({ rev: RUN_EVENT_PROTOCOL_VERSION, runId, kind: "trace_event", event: appended });
  }
  const finalEvents = sinkEvents2(sink);
  const chain = verifyChain(finalEvents);
  const traceRootHash = chain.ok ? computeTraceRoot(finalEvents) : "0".repeat(64);
  const assurance = opts.degraded || !chain.ok ? "degraded" : "full";
  const checks = [
    {
      name: "egress governance + trace projection",
      command: ["glyphspek", "governed-terminal", "verify"],
      status: assurance === "full" && chain.ok ? "pass" : "fail"
    }
  ];
  const overallVerdict = !chain.ok ? "error" : assurance === "full" ? "pass" : "fail";
  const signature = signTerminalVerdict(
    { checks, overallVerdict, traceRootHash, assurance },
    opts.verifierPrivateKey
  );
  const verdict = {
    checks,
    overallVerdict,
    traceRootHash,
    assurance,
    signature
  };
  emit({
    rev: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    kind: "verifier_verdict",
    checks: checks.map((c) => ({ name: c.name, command: c.command, status: c.status })),
    overallVerdict,
    traceRootHash,
    signature
  });
  emit({
    rev: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    kind: "run_closed",
    finalState: lifecycle.state,
    eventCount: finalEvents.length
  });
  return verdict;
}
function sinkEvents2(sink) {
  const maybe = sink.events;
  if (Array.isArray(maybe)) return maybe;
  const path4 = sink.path;
  if (typeof path4 === "string") return readTrace(path4);
  return [];
}
function signTerminalVerdict(core, injectedKey) {
  const privateKey = injectedKey ?? generateKeyPairSync3("ed25519").privateKey;
  return signVerdict(core, privateKey);
}

// ../spikes/p0-governed-cli/cli-agent-launcher.ts
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter as pathDelimiter, join as pathJoin } from "node:path";
import { platform as osPlatform } from "node:os";
function candidateNames(agent) {
  if (osPlatform() === "win32") {
    return [`${agent}.cmd`, `${agent}.exe`, `${agent}.bat`, agent];
  }
  return [agent];
}
function isExecutableFile(p) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    if (osPlatform() !== "win32") accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function resolveOnPath(agent, env = process.env) {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (rawPath.length === 0) return void 0;
  const dirs = rawPath.split(pathDelimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const name of candidateNames(agent)) {
      const full = pathJoin(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return void 0;
}
var PRESERVED_ENV_NAMES = [
  "PATH",
  "Path",
  // Windows casing
  "HOME",
  "TERM",
  "LANG",
  "LANGUAGE",
  // Windows process basics a child needs to start at all.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATHEXT",
  "COMSPEC"
];
function isLocaleVar(name) {
  return /^LC_[A-Z]+$/i.test(name);
}
var PROXY_ENV_LOWER = /* @__PURE__ */ new Set([
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy"
]);
var PRESERVED_ENV_LOWER = new Set(PRESERVED_ENV_NAMES.map((n) => n.toLowerCase()));
function isPreservedEnvName(name) {
  const lower = name.toLowerCase();
  if (PROXY_ENV_LOWER.has(lower)) return false;
  if (PRESERVED_ENV_LOWER.has(lower)) return true;
  return isLocaleVar(name);
}
function sanitizeBaseEnv(base) {
  const out = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === void 0) continue;
    if (!isPreservedEnvName(name)) continue;
    out[name] = value;
  }
  return out;
}
function buildGovernedEnvResult(opts) {
  const rawBase = opts.baseEnv ?? process.env;
  const allowAmbient = opts.allowAmbientEnv ?? false;
  const env = allowAmbient ? { ...rawBase } : sanitizeBaseEnv(rawBase);
  env.HTTPS_PROXY = opts.proxyUrl;
  env.https_proxy = opts.proxyUrl;
  env.HTTP_PROXY = opts.proxyUrl;
  env.http_proxy = opts.proxyUrl;
  env.NO_PROXY = LOOPBACK_NO_PROXY;
  env.no_proxy = LOOPBACK_NO_PROXY;
  return { env, posture: allowAmbient ? "untrusted" : "sanitized" };
}

// ../spikes/p0-supervisor/index-residency.ts
import { resolve, relative, isAbsolute } from "node:path";
function resolveIndexResidency(opts) {
  const { policy } = opts;
  if (policy.highSecurity) {
    return {
      effective: "disabled",
      persists: false,
      note: "high-security mode: code index disabled (no index, in memory or on disk)"
    };
  }
  switch (policy.residency) {
    case "disabled":
      return {
        effective: "disabled",
        persists: false,
        note: "index disabled by policy"
      };
    case "memory-only":
      return {
        effective: "memory-only",
        persists: false,
        note: "index is memory-only: nothing is written to disk (default posture)"
      };
    case "workspace-encrypted": {
      if (!policy.workspaceRoot) {
        throw new Error(
          "index residency: workspace-encrypted requires workspaceRoot (workspace-local enforcement)"
        );
      }
      if (!opts.encryptAtRest) {
        throw new Error(
          "index residency: workspace-encrypted requires an encryptAtRest hook (no plaintext-at-rest path exists)"
        );
      }
      const root = resolve(policy.workspaceRoot);
      const persistDir = resolve(root, ".glyphspek", "index");
      const rel = relative(root, persistDir);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          "index residency: persist dir escapes the workspace root (never user-global / server-side)"
        );
      }
      return {
        effective: "workspace-encrypted",
        persists: true,
        persistDir,
        encryptAtRest: opts.encryptAtRest,
        note: `index persisted ENCRYPTED, workspace-local at ${persistDir}`
      };
    }
    default: {
      const _exhaustive = policy.residency;
      void _exhaustive;
      throw new Error(`index residency: unknown residency ${String(policy.residency)}`);
    }
  }
}
function enforceIndexResidency(decision, _sources) {
  if (!decision.persists) return decision;
  if (!decision.persistDir || !decision.encryptAtRest) {
    throw new Error(
      "index residency: a persisting decision must carry both persistDir and encryptAtRest"
    );
  }
  return decision;
}

// ../spikes/p0-supervisor/model-broker.ts
var REDACTION_PLACEHOLDER2 = "\xABredacted\xBB";
var defaultSecretRedactor = (text) => {
  const matches = [];
  let out = text;
  const patterns = [
    { field: "aws_access_key_id", reason: "matched AKIA access-key pattern", re: /AKIA[0-9A-Z]{16}/g },
    { field: "private_key_block", reason: "matched PEM private-key header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { field: "bearer_token", reason: "matched bearer token", re: /\b(?:sk|pk|ghp|xox[baprs])-[A-Za-z0-9_\-]{12,}\b/g },
    { field: "assigned_secret", reason: "matched SECRET/TOKEN/PASSWORD assignment", re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*[=:]\s*\S+/g }
  ];
  for (const { field, reason, re } of patterns) {
    if (re.test(out)) {
      out = out.replace(re, REDACTION_PLACEHOLDER2);
      matches.push({ field, reason });
    }
  }
  return { text: out, matches };
};
function wrapRequestAsOpenEgress(egress, egressReq, endpointHost) {
  return async () => {
    const result = await egress.request(egressReq);
    if (result.decision !== "allow" || !result.reached) {
      return { decision: result.decision, reached: result.reached, error: result.error };
    }
    let spent = false;
    const capability = {
      endpointHost,
      async send() {
        if (spent) throw new Error("brokered egress capability is single-use and already spent");
        spent = true;
        const routed = await egress.request(egressReq);
        if (routed.decision !== "allow" || !routed.reached) {
          throw new Error(`brokered egress to ${endpointHost} blocked: ${routed.error ?? "denied"}`);
        }
        return { status: 200, body: "", reached: true };
      }
    };
    return { decision: "allow", reached: true, capability };
  };
}
function findAllowed(policy, provider, model) {
  return policy.allowed.find((a) => a.provider === provider && a.model === model);
}
var ModelBroker = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.redactor = ctx.redactor ?? defaultSecretRedactor;
    this.isIgnored = ctx.isIgnored ?? (() => false);
  }
  ctx;
  redactor;
  isIgnored;
  /**
   * The env an actor/sandbox is given. The provider credential is INTENTIONALLY
   * absent — the broker holds it, the actor never does. Exposed so a caller/test
   * can assert the credential is not actor-reachable.
   */
  actorEnv() {
    return Object.freeze({});
  }
  emit(type, runId, payload) {
    return this.ctx.sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      ts: Date.now(),
      type,
      payload
    });
  }
  /**
   * Record a redaction event for each match, at a labeled stage of the fixed
   * pipeline. The payload carries the stage in `location`, never a secret value.
   */
  traceRedactions(runId, location, matches) {
    for (const m of matches) {
      const payload = {
        location,
        reason: m.reason,
        field: m.field
      };
      this.emit("redaction", runId, payload);
    }
  }
  /** Redact one piece of text and trace each match at the given pipeline stage. */
  redactStage(runId, location, text) {
    const { text: cleaned, matches } = this.redactor(text);
    if (matches.length > 0) this.traceRedactions(runId, location, matches);
    return cleaned;
  }
  /**
   * Emit a one-per-stage PIPELINE MARKER so the fixed redaction ordering is
   * always observable in the trace — even when a stage finds nothing to redact
   * (a clean prompt still proves the pipeline RAN, in order). The marker is a
   * `redaction` event carrying only the stage name; it never holds a secret. The
   * four stages, in order, are: 1-before-indexing, 2-before-prompt-assembly,
   * 3-before-model-call, 4-before-trace-write.
   */
  emitStageMarker(runId, stage) {
    const payload = {
      location: `redaction_pipeline.${stage}`,
      reason: "fixed redaction pipeline stage boundary",
      field: stage
    };
    this.emit("redaction", runId, payload);
  }
  /**
   * Wrap a broker-owned egress capability so the provider CREDENTIAL is injected by
   * the BROKER, inside `send`, as an Authorization header — out-of-band from the
   * transport. The transport calls `send` to dispatch its request but never sees,
   * sets, or can omit the credential; this preserves closure custody while keeping
   * the network strictly broker-owned. Pass-through `send` otherwise.
   */
  bindCredential(capability, credential) {
    return {
      endpointHost: capability.endpointHost,
      send: (req) => capability.send({
        ...req,
        headers: {
          ...req.headers ?? {},
          // The broker injects the credential here; the transport supplied none.
          ...credential ? { authorization: `Bearer ${credential}` } : {}
        }
      })
    };
  }
  /**
   * Broker one model call through the full fixed pipeline. Returns a
   * ModelCallResponse; the model is called only on a positive 'allow'.
   */
  async call(req) {
    const { runId, provider, model } = req;
    const provenanceLabel = req.provenanceLabel;
    const capability = req.requestedCapability ?? `model:${provider}/${model}`;
    const allowed = findAllowed(this.ctx.modelPolicy, provider, model);
    const baseDecision = allowed ? "allow" : "deny";
    const decision = baseDecision === "allow" && UNTRUSTED_PROVENANCE.includes(provenanceLabel) ? "force_ask" : baseDecision;
    const decisionPayload = {
      tool: "model",
      requestedCapability: capability,
      decision,
      provider,
      model,
      endpointHost: allowed?.endpointHost,
      provenanceLabel,
      rule: allowed ? "provider/model on allowlist" : "provider/model not on allowlist (default-deny)"
    };
    const decisionEvent = this.emit("policy_decision", runId, decisionPayload);
    if (decision !== "allow" || !allowed) {
      this.emit("tool_end", runId, {
        tool: "model",
        provenanceLabel,
        blocked: true,
        decision
      });
      return {
        decision,
        ok: false,
        traceEventRef: decisionEvent.hash,
        error: decision === "force_ask" ? `model call ${capability} requires confirmation (untrusted provenance '${provenanceLabel}')` : `model ${provider}/${model} not on allowlist (default-deny)`
      };
    }
    this.emitStageMarker(runId, "stage1-before-indexing");
    const indexedRefs = [];
    const survivingSources = [];
    for (const src of req.contextSources ?? []) {
      if (src.ignored || this.isIgnored(src.ref)) {
        this.traceRedactions(runId, "context_source.ignored", [
          { field: src.ref, reason: "excluded by .glyphspekignore" }
        ]);
        continue;
      }
      const cleaned = src.content !== void 0 ? this.redactStage(runId, "context_source.content", src.content) : void 0;
      const survivor = { ...src, content: cleaned };
      survivingSources.push(survivor);
      indexedRefs.push(src.ref);
    }
    const residency = enforceIndexResidency(this.ctx.residency, survivingSources);
    this.emitStageMarker(runId, "stage2-before-prompt-assembly");
    const redactedMessages = req.messages.map((m) => ({
      ...m,
      content: this.redactStage(runId, "message.content", m.content)
    }));
    const assembled = [
      ...survivingSources.filter((s) => s.content !== void 0 && s.content.length > 0).map((s) => ({
        role: "system",
        content: `# context: ${s.ref}
${s.content}`,
        provenanceLabel: s.provenanceLabel
      })),
      ...redactedMessages
    ];
    const assemblyPayload = {
      tool: "model",
      messageCount: assembled.length,
      messages: assembled.map((m) => ({ role: m.role, length: m.content.length })),
      contextRefs: indexedRefs,
      provenanceLabel
    };
    this.emit("prompt", runId, assemblyPayload);
    this.emitStageMarker(runId, "stage3-before-model-call");
    const outboundMessages = assembled.map((m) => ({
      ...m,
      content: this.redactStage(runId, "outbound_prompt.content", m.content)
    }));
    const egressReq = {
      runId,
      tool: "network",
      payload: { host: allowed.endpointHost },
      provenanceLabel,
      requestedCapability: `network:${allowed.endpointHost}`
    };
    const openEgress = this.ctx.egress.openEgress ? () => this.ctx.egress.openEgress(egressReq) : wrapRequestAsOpenEgress(this.ctx.egress, egressReq, allowed.endpointHost);
    const egressResult = await openEgress();
    if (egressResult.decision !== "allow" || !egressResult.reached || !egressResult.capability) {
      this.emit("tool_end", runId, {
        tool: "model",
        provenanceLabel,
        blocked: true,
        decision: "deny",
        reason: "model endpoint egress not permitted"
      });
      return {
        decision: "deny",
        ok: false,
        traceEventRef: decisionEvent.hash,
        error: `model endpoint ${allowed.endpointHost} egress blocked: ${egressResult.error ?? "denied"}`
      };
    }
    const egressCapability = egressResult.capability;
    const endpointPayload = {
      tool: "model",
      provider,
      model,
      endpointHost: allowed.endpointHost,
      credentialPosture: "proxy",
      provenanceLabel
    };
    this.emit("tool_start", runId, endpointPayload);
    const credential = this.ctx.credentials[provider] ?? "";
    const credentialedCapability = this.bindCredential(egressCapability, credential);
    const startedAt = Date.now();
    let completion;
    let usage;
    try {
      const result = await this.ctx.transport({
        model,
        messages: outboundMessages,
        egress: credentialedCapability
      });
      completion = result.completion;
      usage = result.usage;
    } catch (err) {
      const message = String(err.message ?? err);
      this.emit("tool_end", runId, {
        tool: "model",
        provenanceLabel,
        ok: false,
        error: message
      });
      return {
        decision: "allow",
        ok: false,
        traceEventRef: decisionEvent.hash,
        error: message
      };
    }
    this.emitStageMarker(runId, "stage4-before-trace-write");
    const redactedCompletion = this.redactStage(
      runId,
      "completion.content",
      completion
    );
    const callMeta = {
      model,
      provider,
      endpointHost: allowed.endpointHost,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      costMicroUsd: usage?.costMicroUsd,
      durationMs: Date.now() - startedAt,
      provenanceLabel
    };
    this.emit("model_call", runId, callMeta);
    this.emit("tool_end", runId, {
      tool: "model",
      provenanceLabel,
      ok: true,
      durationMs: callMeta.durationMs
    });
    return {
      decision: "allow",
      ok: true,
      completion: redactedCompletion,
      usage,
      traceEventRef: decisionEvent.hash
    };
  }
  /** The index residency decision in effect (for callers/Trust Panel). */
  residency() {
    return this.ctx.residency;
  }
};

// ../spikes/p0-model-gateway/gateway.ts
var ModelGateway = class {
  backends = /* @__PURE__ */ new Map();
  trace;
  constructor(opts = {}) {
    this.trace = opts.trace;
  }
  /** Register (or replace) a backend under its id. Returns the gateway (chainable). */
  register(backend) {
    this.backends.set(backend.id, backend);
    return this;
  }
  /** True iff a backend is registered under `backendId`. */
  has(backendId) {
    return this.backends.has(backendId);
  }
  /** The ids of every registered backend (for an allowlist-style query). */
  backendIds() {
    return [...this.backends.keys()];
  }
  /**
   * Drive ONE chat turn through the named backend, streaming its events and
   * emitting a single `model_call` trace breadcrumb when the turn settles.
   *
   * An unknown backendId yields a single `error` event (and a breadcrumb with
   * outcome 'error') rather than throwing — the caller gets a uniform stream.
   * The breadcrumb's `outcome` is 'error' iff the terminal event was an error
   * (or no terminal event arrived); otherwise 'ok'.
   */
  async *chatTurn(backendId, req, opts) {
    const startedAt = Date.now();
    const backend = this.backends.get(backendId);
    if (!backend) {
      const message = `unknown chat backend "${backendId}"`;
      this.emitTrace({
        backendId,
        ...req.model ? { model: req.model } : {},
        messageCount: req.messages.length,
        outcome: "error",
        durationMs: Date.now() - startedAt,
        error: message
      });
      yield { type: "error", message };
      return;
    }
    let outcome = "error";
    let errorMessage = "chat turn produced no terminal event";
    let inputTokens;
    let outputTokens;
    try {
      for await (const event of backend.chatTurn(req, opts)) {
        if (event.type === "done") {
          outcome = "ok";
          errorMessage = void 0;
          inputTokens = event.usage?.inputTokens;
          outputTokens = event.usage?.outputTokens;
        } else if (event.type === "error") {
          outcome = "error";
          errorMessage = event.message;
        }
        yield event;
      }
    } catch (err) {
      outcome = "error";
      errorMessage = `chat backend "${backendId}" threw: ${String(err?.message ?? err)}`;
      yield { type: "error", message: errorMessage };
    } finally {
      this.emitTrace({
        backendId,
        ...req.model ? { model: req.model } : {},
        messageCount: req.messages.length,
        outcome,
        durationMs: Date.now() - startedAt,
        ...inputTokens !== void 0 ? { inputTokens } : {},
        ...outputTokens !== void 0 ? { outputTokens } : {},
        ...outcome === "error" && errorMessage ? { error: errorMessage } : {}
      });
    }
  }
  /** Emit the per-turn trace breadcrumb, swallowing a sink failure (best-effort). */
  emitTrace(meta) {
    if (!this.trace) return;
    try {
      this.trace.modelCall(meta);
    } catch {
    }
  }
};

// ../spikes/p0-model-gateway/codex-backend.ts
import { spawn as spawn2 } from "node:child_process";
import { isAbsolute as isAbsolute2 } from "node:path";

// ../spikes/p0-model-gateway/prompt-assembly.ts
var CHAT_INSTRUCTION = "You are a conversational coding assistant answering a CHAT message. This is a chat turn, NOT a coding task: answer the user conversationally and concisely in prose. Do NOT modify, create, or delete any files, and do NOT run any mutating or side-effecting commands \u2014 only read if you must. Reply with the answer text only.";
var ROLE_LABEL = {
  system: "System",
  user: "User",
  assistant: "Assistant"
};
function assembleCodexPrompt(messages) {
  const sections = [CHAT_INSTRUCTION];
  for (const m of messages) {
    if (typeof m.content !== "string" || m.content.trim().length === 0) continue;
    sections.push(`=== ${ROLE_LABEL[m.role]} ===
${m.content.trim()}`);
  }
  return sections.join("\n\n");
}

// ../spikes/p0-model-gateway/codex-backend.ts
var DEFAULT_CODEX_TIMEOUT_MS = 12e4;
var STDERR_TAIL_LIMIT = 800;
var REDACTED_TAIL_LIMIT = 240;
function refuseUngovernedEnv(env) {
  if (!env) {
    return "refusing to run codex on the ambient process environment: a chat turn must be GOVERNED (egress forced through the supervisor proxy, ambient secrets stripped). No governed env was provided.";
  }
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? "";
  if (typeof proxy !== "string" || proxy.trim().length === 0) {
    return "refusing to run codex on an UNGOVERNED env: no HTTPS_PROXY/HTTP_PROXY is set, so codex egress would not be brokered through the supervisor proxy.";
  }
  return void 0;
}
function redactStderrTail(raw) {
  let s = raw;
  s = s.replace(/\[[0-9;]*m/g, "");
  s = s.replace(
    /\b(api[_-]?key|apikey|token|secret|password|passwd|authorization|auth[-_]?header|bearer|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|cookie)\b\s*[:=]?\s*("?)[^\s"']+\2/gi,
    "$1 <redacted>"
  );
  s = s.replace(/\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, "$1 <redacted>");
  s = s.replace(/\b(sk-ant-[A-Za-z0-9_\-]{6,}|sk-[A-Za-z0-9_\-]{6,}|gh[pousr]_[A-Za-z0-9]{6,})\b/g, "<redacted>");
  s = s.replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, "<redacted>");
  s = s.replace(/\b[A-Za-z0-9+/_\-]{24,}={0,2}\b/g, "<redacted>");
  s = s.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/]+[\\/])+[^\s\\/]*/g, "<path>");
  s = s.replace(/\\\\[^\s\\/]+\\[^\s]*/g, "<path>");
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > REDACTED_TAIL_LIMIT) {
    s = `\u2026${s.slice(-REDACTED_TAIL_LIMIT)}`;
  }
  return s;
}
function asNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
var CodexChatBackend = class {
  id = "codex";
  /**
   * The ABSOLUTE codex path to spawn, or undefined when the caller could not
   * resolve one. When undefined the backend is UNRESOLVED and FAILS CLOSED — it
   * NEVER falls back to a bare `codex` re-resolved against the ambient PATH
   * (Finding 2: the launched bytes must be the exact ones the supervisor
   * identity-checked).
   */
  codexPath;
  timeoutMs;
  onOperatorLog;
  constructor(opts = {}) {
    this.codexPath = typeof opts.codexPath === "string" && isAbsolute2(opts.codexPath) ? opts.codexPath : void 0;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    this.onOperatorLog = opts.onOperatorLog;
  }
  /**
   * Build the `codex exec` argv for a turn. The prompt is fed on STDIN (we pass
   * `-` so codex reads stdin), so it never appears in argv (process listings stay
   * free of prompt content).
   */
  buildArgs(req) {
    const args = [
      "exec",
      "-",
      // read the prompt from stdin
      "--json",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "--skip-git-repo-check",
      "--ephemeral",
      "-C",
      req.cwd
    ];
    if (req.model && req.model.trim().length > 0) {
      args.push("-m", req.model);
    }
    return args;
  }
  async *chatTurn(req, opts) {
    const prompt = assembleCodexPrompt(req.messages);
    const args = this.buildArgs(req);
    const refusal = refuseUngovernedEnv(opts?.env);
    if (refusal) {
      yield { type: "error", message: refusal };
      return;
    }
    if (this.codexPath === void 0) {
      yield {
        type: "error",
        message: "codex is not available: no absolute codex binary was resolved for this chat turn (refusing to spawn a bare `codex` from the ambient PATH)."
      };
      return;
    }
    const env = {
      ...opts.env,
      CI: "1"
    };
    const child = spawn2(this.codexPath, args, {
      cwd: req.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const events = [];
    let resolveNext;
    let settled = false;
    let finished = false;
    const wake = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = void 0;
        r();
      }
    };
    const push = (e) => {
      events.push(e);
      wake();
    };
    const answerChunks = [];
    let usage;
    let stdoutBuf = "";
    let stderrTail = "";
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
        const text = typeof evt.item.text === "string" ? evt.item.text : "";
        if (text.length > 0) {
          answerChunks.push(text);
          push({ type: "delta", text });
        }
      } else if (evt.type === "turn.completed" && evt.usage) {
        const inputTokens = asNum(evt.usage.input_tokens);
        const outputTokens = asNum(evt.usage.output_tokens);
        if (inputTokens !== void 0 || outputTokens !== void 0) {
          usage = {
            ...inputTokens !== void 0 ? { inputTokens } : {},
            ...outputTokens !== void 0 ? { outputTokens } : {}
          };
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    const settle = (e) => {
      if (settled) return;
      settled = true;
      push(e);
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.timeoutMs);
    if (timer.unref) timer.unref();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      settle({
        type: "error",
        message: `codex spawn failed: ${String(err?.message ?? err)}`
      });
      finished = true;
      wake();
    });
    child.on("close", (code) => {
      cleanup();
      if (stdoutBuf.trim().length > 0) {
        handleLine(stdoutBuf);
        stdoutBuf = "";
      }
      if (timedOut) {
        settle({
          type: "error",
          message: `codex chat turn timed out after ${this.timeoutMs}ms`
        });
      } else if (aborted) {
        settle({ type: "error", message: "codex chat turn aborted" });
      } else if (code === 0) {
        settle({ type: "done", text: answerChunks.join(""), ...usage ? { usage } : {} });
      } else {
        const rawTail = stderrTail.trim();
        if (rawTail && this.onOperatorLog) {
          try {
            this.onOperatorLog(`codex exec exited ${code ?? "null"} (verbatim stderr tail): ${rawTail}`);
          } catch {
          }
        }
        const redacted = rawTail ? redactStderrTail(rawTail) : "";
        settle({
          type: "error",
          message: `codex exec exited ${code ?? "null"}` + (redacted ? ` (redacted detail: ${redacted})` : "")
        });
      }
      finished = true;
      wake();
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(prompt, "utf8");
    let i = 0;
    for (; ; ) {
      while (i < events.length) {
        yield events[i];
        i += 1;
      }
      if (finished && i >= events.length) break;
      await new Promise((resolve2) => {
        resolveNext = resolve2;
      });
    }
  }
};

// ../spikes/p0-model-gateway/governed-agentic-run.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { join as join6 } from "node:path";

// ../spikes/p0-verifier/verifier.ts
import { cpSync, existsSync as existsSync2, readdirSync, rmSync as rmSync2, statSync as statSync2 } from "node:fs";
import * as path3 from "node:path";

// ../spikes/p0-sandbox/docker-runtime.ts
import { spawn as spawn3, spawnSync } from "node:child_process";
import { randomUUID as randomUUID4 } from "node:crypto";
var WORKDIR_MOUNT = "/workspace";
var HOME_MOUNT = "/home/agent";
var DEFAULT_IMAGE = process.env.GLYPHSPEK_SANDBOX_IMAGE ?? "node:22-alpine";
var KEEPALIVE_SECONDS = 86400;
var TIMEOUT_EXIT_CODE = 124;
var SPAWN_FAIL_EXIT_CODE = 1;
function containerNameFor(runId) {
  const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `glyphspek-${safe}`;
}
function envFlags(env) {
  return Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}
var HOST_ALIAS = "host.docker.internal";
function denyNetworkFlags() {
  return ["--network", "none"];
}
function proxyEnv(proxyUrl) {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    // Never route the proxy host through itself; everything else MUST be proxied.
    NO_PROXY: HOST_ALIAS,
    no_proxy: HOST_ALIAS
  };
}
function npmOfflineEnvForDeny() {
  return {
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_progress: "false"
  };
}
function npmQuietEnvForAllow() {
  return {
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false"
  };
}
function resourceFlags(limits) {
  const flags = [];
  if (limits?.cpus !== void 0) flags.push("--cpus", String(limits.cpus));
  if (limits?.memoryMb !== void 0) flags.push("--memory", `${limits.memoryMb}m`);
  return flags;
}
function runDocker(args, timeoutMs) {
  return new Promise((resolve2) => {
    const child = spawn3("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer;
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    child.stdout?.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve2(result);
    };
    child.on("error", (err) => {
      finish({
        exitCode: SPAWN_FAIL_EXIT_CODE,
        stdout,
        stderr: stderr + String(err.message ?? err)
      });
    });
    child.on("close", (code) => {
      const exitCode = timedOut ? TIMEOUT_EXIT_CODE : code === null ? SPAWN_FAIL_EXIT_CODE : code;
      finish({ exitCode, stdout, stderr, ...timedOut ? { timedOut: true } : {} });
    });
  });
}
function denyNetworkConfig() {
  return { flags: denyNetworkFlags(), env: {} };
}
var SOFT_EGRESS_POSTURE_MESSAGE = "egress posture: SOFT application-layer allowlist (proxy-honoring only; NOT a hard boundary; bypassable by proxy-stripping clients)";
var softEgressWarned = false;
function softEgressNotAcknowledgedError() {
  return new Error(
    "DockerSandboxRuntime: network:{ allow } on the Docker-local runtime is an APPLICATION-LAYER (proxy-only) egress allowlist, NOT a hard boundary \u2014 a process that strips the HTTP(S) proxy env vars or opens a raw socket can bypass it. It therefore FAILS CLOSED (no egress) unless explicitly acknowledged. Pass network:{ allow, acknowledgeSoftEgress: true } to opt into the soft allowlist with eyes open, or use network:'deny' for a hard boundary (--network none) / the remote plane for a hard egress allowlist."
  );
}
function signalSoftEgressPosture(onDecision) {
  if (!softEgressWarned) {
    softEgressWarned = true;
    console.warn(`DockerSandboxRuntime: ${SOFT_EGRESS_POSTURE_MESSAGE}`);
  }
  if (onDecision) {
    try {
      onDecision({
        id: randomUUID4(),
        ts: Date.now(),
        kind: "http",
        // 'deny' is the conservative label for a posture note: this entry is not
        // an actual permitted request, it records that the boundary is soft.
        decision: "deny",
        host: "(egress-posture)",
        port: 0,
        method: SOFT_EGRESS_POSTURE_MESSAGE
      });
    } catch {
    }
  }
}
async function allowNetworkConfig(allow, onDecision) {
  let proxy;
  try {
    proxy = await startEgressProxy({
      allow,
      onDecision,
      // A container addresses host-local services via host.docker.internal, but
      // that alias does NOT resolve on the host where this proxy runs. Map it to
      // the host loopback so an allowlisted host-local target (the common test
      // shape, and any host-side service) is actually reachable once permitted.
      // The allow/deny decision is still made on the requested host, not this.
      upstreamLookup: { [HOST_ALIAS]: "127.0.0.1" }
    });
  } catch {
    return denyNetworkConfig();
  }
  const proxyUrlForContainer = `http://${HOST_ALIAS}:${proxy.port}`;
  const flags = ["--add-host", `${HOST_ALIAS}:host-gateway`];
  return { flags, env: proxyEnv(proxyUrlForContainer), proxy };
}
var DockerSandboxRuntime = class {
  /** Informational only; per the contract, callers must not parse this. */
  name = "docker";
  onEgressDecision;
  constructor(options = {}) {
    this.onEgressDecision = options.onEgressDecision;
  }
  /**
   * HONEST capability report for the trust gate (see SandboxCapabilities). The
   * Docker runtime ALWAYS earns fs-isolation: the container sees only the mounted
   * worktree + synthetic HOME, with no host path/secret/env reachable (the bytes
   * are structurally absent), regardless of host backend.
   *
   * hardEgress is the honest, host-dependent part:
   *   - network:'deny' maps to `--network none` — no interface, no route, no DNS —
   *     a HARD container-level boundary no in-container process can defeat. So
   *     hardEgress is TRUE for the deny posture on every backend.
   *   - a network:{ allow } allowlist is enforced ONLY by an application-layer
   *     proxy (HTTP_PROXY/HTTPS_PROXY). On the backend this runtime ships
   *     (standard bridge / Colima NAT) a process can strip the proxy env or open a
   *     raw socket and bypass it, so hardEgress is FALSE for the allow posture.
   *
   * A true default-DROP + allowlist (hardEgress under an `allow` spec) is the
   * Firecracker remote-plane's network-namespace job — the deferred follow-on —
   * NOT this Docker-local runtime. We report what we can structurally enforce, no
   * more, so the trust gate never grants product `trusted` on a soft boundary.
   */
  capabilities(spec) {
    return {
      fsIsolated: true,
      hardEgress: spec.network === "deny"
    };
  }
  async createSandbox(spec) {
    if (spec.network !== "deny" && spec.network.acknowledgeSoftEgress !== true) {
      throw softEgressNotAcknowledgedError();
    }
    const containerName = containerNameFor(spec.runId);
    let net;
    if (spec.network === "deny") {
      net = denyNetworkConfig();
    } else {
      signalSoftEgressPosture(this.onEgressDecision);
      net = await allowNetworkConfig(spec.network.allow, this.onEgressDecision);
    }
    const npmDefaults = spec.network === "deny" ? npmOfflineEnvForDeny() : npmQuietEnvForAllow();
    const mergedEnv = { ...npmDefaults, ...spec.env, ...net.env };
    const runArgs = [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-w",
      WORKDIR_MOUNT,
      "-v",
      `${spec.workdir}:${WORKDIR_MOUNT}`,
      "-v",
      `${spec.home}:${HOME_MOUNT}`,
      "-e",
      `HOME=${HOME_MOUNT}`,
      ...envFlags(mergedEnv),
      ...net.flags,
      ...resourceFlags(spec.resourceLimits),
      DEFAULT_IMAGE,
      "sleep",
      String(KEEPALIVE_SECONDS)
    ];
    const started = spawnSync("docker", runArgs, { encoding: "utf8" });
    if (started.status !== 0) {
      if (net.proxy) await net.proxy.close().catch(() => void 0);
      throw new Error(
        `DockerSandboxRuntime: failed to start container ${containerName}: ${(started.stderr ?? "").trim() || `exit ${started.status}`}`
      );
    }
    let torndown = false;
    const sandbox = {
      spec,
      async exec(req) {
        if (torndown) {
          return {
            exitCode: SPAWN_FAIL_EXIT_CODE,
            stdout: "",
            stderr: "sandbox has been torn down"
          };
        }
        const cwd = req.cwd ?? WORKDIR_MOUNT;
        const args = ["exec", "-w", cwd, containerName, ...req.command];
        const timeoutMs = req.timeoutMs ?? spec.resourceLimits?.timeoutMs;
        return runDocker(args, timeoutMs);
      },
      async teardown() {
        if (torndown) return;
        torndown = true;
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
        if (net.proxy) await net.proxy.close().catch(() => void 0);
      }
    };
    return sandbox;
  }
};

// ../spikes/p0-verifier/verifier.ts
var WORKDIR_MOUNT2 = "/workspace";
var DEFAULT_CHECK_TIMEOUT_MS = 12e4;
function statusForExit(exitCode) {
  return exitCode === 0 ? "pass" : "fail";
}
function checkName(command) {
  return command.join(" ") || "(empty command)";
}
var MIRROR_EXCLUDE_TOPLEVEL = /* @__PURE__ */ new Set([".git"]);
function mirrorDir(src, dest, exclude) {
  const srcEntries = new Set(readdirSync(src).filter((e) => !exclude.has(e)));
  for (const entry of readdirSync(dest)) {
    if (exclude.has(entry)) continue;
    if (!srcEntries.has(entry)) {
      rmSync2(path3.join(dest, entry), { recursive: true, force: true });
    }
  }
  for (const entry of srcEntries) {
    const srcPath = path3.join(src, entry);
    const destPath = path3.join(dest, entry);
    const st = statSync2(srcPath);
    if (st.isDirectory()) {
      if (existsSync2(destPath) && !statSync2(destPath).isDirectory()) {
        rmSync2(destPath, { force: true });
      }
      cpSync(srcPath, destPath, { recursive: true, force: true });
      mirrorDir(srcPath, destPath, /* @__PURE__ */ new Set());
    } else {
      if (existsSync2(destPath) && statSync2(destPath).isDirectory()) {
        rmSync2(destPath, { recursive: true, force: true });
      }
      cpSync(srcPath, destPath, { force: true });
    }
  }
}
function overlaySourceWorktree(sourceWorktree, verifierWorktree) {
  mirrorDir(sourceWorktree, verifierWorktree, MIRROR_EXCLUDE_TOPLEVEL);
}
async function runVerification(input) {
  const { repoPath, sourceWorktree, policyPath, tracePath, privateKey } = input;
  const { policy, errors } = loadPolicy(policyPath);
  if (!policy) {
    throw new Error(
      `verifier: cannot load policy at ${policyPath}: ${errors.join("; ")}`
    );
  }
  const targets = policy.verify;
  const events = readTrace(tracePath);
  const chain = verifyChain(events);
  const traceRootHash = chain.ok ? computeTraceRoot(events) : GENESIS_HASH;
  const runId = newRunId();
  const runDir = path3.join(input.runsBaseDir ?? DEFAULT_RUNS_BASE_DIR, `verifier-${runId}`);
  const verifierWorktree = path3.join(runDir, "worktree");
  const home = createSyntheticHome(runDir);
  const runtime = input.runtime ?? new DockerSandboxRuntime();
  let sandboxTorndown = false;
  let sandbox;
  let worktreeCreated = false;
  const checks = [];
  let anyFail = false;
  let anyError = !chain.ok;
  try {
    createWorktree(repoPath, runId, verifierWorktree);
    worktreeCreated = true;
    if (sourceWorktree) {
      if (!existsSync2(sourceWorktree)) {
        throw new Error(`verifier: sourceWorktree does not exist: ${sourceWorktree}`);
      }
      overlaySourceWorktree(sourceWorktree, verifierWorktree);
    }
    const spec = {
      runId,
      workdir: verifierWorktree,
      home,
      env: buildInjectedEnv(),
      network: "deny"
    };
    sandbox = await runtime.createSandbox(spec);
    for (const target of targets) {
      const command = [...target];
      const name = checkName(command);
      if (command.length === 0) {
        checks.push({ name, command, status: "error" });
        anyError = true;
        continue;
      }
      const result = await sandbox.exec({
        command,
        cwd: WORKDIR_MOUNT2,
        timeoutMs: DEFAULT_CHECK_TIMEOUT_MS
      });
      const status = statusForExit(result.exitCode);
      if (status === "fail") anyFail = true;
      checks.push({ name, command, status });
    }
  } catch (err) {
    anyError = true;
    checks.push({
      name: "verifier-execution",
      command: [],
      status: "error"
    });
    void err;
  } finally {
    if (sandbox && !sandboxTorndown) {
      sandboxTorndown = true;
      await sandbox.teardown();
    }
    if (worktreeCreated) {
      removeWorktree(repoPath, verifierWorktree);
    }
  }
  const overallVerdict = anyError ? "error" : anyFail ? "fail" : "pass";
  const core = { checks, overallVerdict, traceRootHash };
  const signature = signVerdict(core, privateKey);
  return { ...core, signature };
}

// ../spikes/p0-supervisor/verifier-runner.ts
var INDEPENDENT_VERIFIER_ERROR_CHECK_NAME = "independent verifier \u2014 could not run (see operator log)";
async function runIndependentVerification(input) {
  const log = input.onOperatorLog ?? (() => {
  });
  try {
    const verdict = await runVerification({
      repoPath: input.repoPath,
      sourceWorktree: input.sourceWorktree,
      policyPath: input.policyPath,
      tracePath: input.tracePath,
      privateKey: input.privateKey,
      ...input.runtime ? { runtime: input.runtime } : {},
      ...input.runsBaseDir !== void 0 ? { runsBaseDir: input.runsBaseDir } : {}
    });
    return { verdict, ran: verdict.overallVerdict !== "error" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`independent-verifier: could not run \u2014 ${reason}`);
    return {
      verdict: synthesizeErrorVerdict(input.tracePath, input.privateKey),
      ran: false
    };
  }
}
function synthesizeErrorVerdict(tracePath, privateKey) {
  let traceRootHash = GENESIS_HASH;
  try {
    const events = readTrace(tracePath);
    if (events.length > 0 && verifyChain(events).ok) {
      traceRootHash = computeTraceRoot(events);
    }
  } catch {
  }
  const checks = [
    { name: INDEPENDENT_VERIFIER_ERROR_CHECK_NAME, command: [], status: "error" }
  ];
  const core = { checks, overallVerdict: "error", traceRootHash };
  const signature = signVerdict(core, privateKey);
  return { ...core, signature };
}

// ../spikes/p0-model-gateway/agentic-backend.ts
import { spawn as spawn4 } from "node:child_process";
import { execFile } from "node:child_process";
import { isAbsolute as isAbsolute3 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var DEFAULT_AGENTIC_TIMEOUT_MS = 3e5;
var AGENTIC_SANDBOX_MODE = "workspace-write";
var AGENTIC_APPROVAL_POLICY = "never";
var STDERR_TAIL_LIMIT2 = 1200;
function buildAgenticArgs(req) {
  const args = [
    "exec",
    "-",
    // read the prompt from stdin
    "--json",
    "--sandbox",
    AGENTIC_SANDBOX_MODE,
    // workspace-write: codex MAY edit files + run commands
    "-c",
    `approval_policy="${AGENTIC_APPROVAL_POLICY}"`,
    // NOTE: deliberately NO --skip-git-repo-check (we WANT a git repo to diff) and
    // NO --ephemeral (a build may legitimately persist a session; harmless here).
    "-C",
    req.cwd
  ];
  if (req.model && req.model.trim().length > 0) {
    args.push("-m", req.model);
  }
  return args;
}
function asNum2(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function asStr(v) {
  return typeof v === "string" ? v : void 0;
}
async function git(cwd, env, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env,
    maxBuffer: 64 * 1024 * 1024
    // diffs can be large
  });
  return stdout;
}
function porcelainStatus(xy) {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (x === "?" || y === "?") return "?";
  if (y !== " ") return y;
  if (x !== " ") return x;
  return "?";
}
function parsePorcelain(porcelain) {
  const out = [];
  for (const line of porcelain.split("\n")) {
    if (line.length === 0) continue;
    const xy = line.slice(0, 2);
    let pathPart = line.slice(3);
    const arrow = pathPart.indexOf(" -> ");
    if (arrow !== -1) pathPart = pathPart.slice(arrow + 4);
    let p = pathPart.trim();
    if (p.startsWith('"') && p.endsWith('"')) {
      try {
        p = JSON.parse(p);
      } catch {
      }
    }
    if (p.length > 0) out.push({ path: p, status: porcelainStatus(xy) });
  }
  return out;
}
async function gitAllowNonZero(cwd, env, args) {
  try {
    return await git(cwd, env, args);
  } catch (err) {
    const out = err.stdout;
    return typeof out === "string" ? out : "";
  }
}
async function diffUntrackedFile(cwd, env, relPath) {
  const out = await gitAllowNonZero(cwd, env, ["diff", "--no-index", "--", "/dev/null", relPath]);
  return out;
}
async function listUntrackedFiles(cwd, env) {
  const out = await gitAllowNonZero(cwd, env, ["ls-files", "--others", "--exclude-standard"]);
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}
async function captureGitEvidence(cwd, env) {
  const [porcelain, trackedDiff, trackedStat, untracked] = await Promise.all([
    git(cwd, env, ["status", "--porcelain"]),
    git(cwd, env, ["diff"]),
    git(cwd, env, ["diff", "--stat"]),
    listUntrackedFiles(cwd, env)
  ]);
  const changedFiles = parsePorcelain(porcelain);
  let diff = trackedDiff;
  let untrackedStatLines = 0;
  for (const rel of untracked) {
    const block = await diffUntrackedFile(cwd, env, rel);
    if (block.trim().length > 0) {
      if (diff.length > 0 && !diff.endsWith("\n")) diff += "\n";
      diff += block;
      untrackedStatLines += 1;
    }
  }
  let diffStat = trackedStat.trimEnd();
  for (const rel of untracked) {
    const existing = changedFiles.find((f) => f.path === rel);
    if (existing) {
      if (existing.status === "?") existing.status = "A";
    } else {
      changedFiles.push({ path: rel, status: "A" });
    }
  }
  if (untrackedStatLines > 0) {
    const tail = untracked.map((rel) => ` ${rel} | (new file)`).join("\n");
    diffStat = diffStat.length > 0 ? `${diffStat}
${tail}` : tail;
  }
  return { changedFiles, diff, diffStat };
}
async function* runAgenticBuild(req, opts = {}) {
  const refusal = refuseUngovernedEnv(req.env);
  if (refusal) {
    yield { type: "error", message: refusal };
    return;
  }
  if (typeof req.cwd !== "string" || !isAbsolute3(req.cwd)) {
    yield {
      type: "error",
      message: `agentic build requires an absolute cwd (a git repo); got: ${String(req.cwd)}`
    };
    return;
  }
  const codexPath = typeof opts.codexPath === "string" && isAbsolute3(opts.codexPath) ? opts.codexPath : void 0;
  if (codexPath === void 0) {
    yield {
      type: "error",
      message: "codex is not available: no absolute codex binary was resolved for this agentic build (refusing to spawn a bare `codex` from the ambient PATH)."
    };
    return;
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENTIC_TIMEOUT_MS;
  const args = buildAgenticArgs(req);
  const env = { ...req.env, CI: "1" };
  const child = spawn4(codexPath, args, {
    cwd: req.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events = [];
  let resolveNext;
  let finished = false;
  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = void 0;
      r();
    }
  };
  const push = (e) => {
    events.push(e);
    wake();
  };
  const summaries = [];
  const commands = [];
  const fileChangeReports = [];
  let usage;
  let stdoutBuf = "";
  let stderrTail = "";
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }
    const item = evt.item;
    if (evt.type === "item.completed" && item?.type === "agent_message") {
      const text = asStr(item.text) ?? "";
      if (text.length > 0) {
        summaries.push(text);
        push({ type: "summary_delta", text });
      }
    } else if (item?.type === "command_execution") {
      const cmd = asStr(item.command) ?? "";
      if (evt.type === "item.started") {
        push({ type: "command", phase: "start", cmd });
      } else if (evt.type === "item.completed") {
        const exitCode = asNum2(item.exit_code);
        commands.push({ cmd, ...exitCode !== void 0 ? { exitCode } : {} });
        push({ type: "command", phase: "end", cmd, ...exitCode !== void 0 ? { exitCode } : {} });
      }
    } else if (evt.type === "item.completed" && item?.type === "file_change") {
      for (const ch of item.changes ?? []) {
        const path4 = asStr(ch.path);
        const kind = asStr(ch.kind) ?? "unknown";
        if (path4) {
          fileChangeReports.push({ path: path4, kind });
          push({ type: "file_change", path: path4, kind });
        }
      }
    } else if (evt.type === "turn.completed" && evt.usage) {
      const inputTokens = asNum2(evt.usage.input_tokens);
      const outputTokens = asNum2(evt.usage.output_tokens);
      const cachedInputTokens = asNum2(evt.usage.cached_input_tokens);
      if (inputTokens !== void 0 || outputTokens !== void 0 || cachedInputTokens !== void 0) {
        usage = {
          ...inputTokens !== void 0 ? { inputTokens } : {},
          ...outputTokens !== void 0 ? { outputTokens } : {},
          ...cachedInputTokens !== void 0 ? { cachedInputTokens } : {}
        };
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT2);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  if (timer.unref) timer.unref();
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill("SIGKILL");
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  };
  const closed = new Promise((resolve2) => {
    child.on("error", (err) => {
      cleanup();
      push({
        type: "error",
        message: `codex spawn failed: ${String(err?.message ?? err)}`
      });
      finished = true;
      wake();
      resolve2(null);
    });
    child.on("close", (code) => {
      cleanup();
      if (stdoutBuf.trim().length > 0) {
        handleLine(stdoutBuf);
        stdoutBuf = "";
      }
      resolve2(code);
    });
  });
  child.stdin.on("error", () => {
  });
  child.stdin.end(req.prompt, "utf8");
  void (async () => {
    const code = await closed;
    if (finished) return;
    if (timedOut) {
      push({ type: "error", message: `agentic build timed out after ${timeoutMs}ms` });
      finished = true;
      wake();
      return;
    }
    if (aborted) {
      push({ type: "error", message: "agentic build aborted" });
      finished = true;
      wake();
      return;
    }
    let evidence;
    try {
      evidence = await captureGitEvidence(req.cwd, env);
    } catch (err) {
      if (stderrTail.trim() && opts.onOperatorLog) {
        try {
          opts.onOperatorLog(`agentic build stderr tail: ${stderrTail.trim()}`);
        } catch {
        }
      }
      push({
        type: "error",
        message: `agentic build could not capture git evidence in ${req.cwd}: ${String(err?.message ?? err)} (is it a git repo?)`
      });
      finished = true;
      wake();
      return;
    }
    if (code !== 0) {
      if (stderrTail.trim() && opts.onOperatorLog) {
        try {
          opts.onOperatorLog(`codex exec exited ${code ?? "null"} (verbatim stderr tail): ${stderrTail.trim()}`);
        } catch {
        }
      }
    }
    const result = {
      summary: summaries.length > 0 ? summaries[summaries.length - 1] : "",
      commands,
      changedFiles: evidence.changedFiles,
      diff: evidence.diff,
      diffStat: evidence.diffStat,
      fileChangeReports,
      ...usage ? { usage } : {},
      exitCode: code ?? -1
    };
    push({ type: "result", result });
    finished = true;
    wake();
  })();
  let i = 0;
  for (; ; ) {
    while (i < events.length) {
      yield events[i];
      i += 1;
    }
    if (finished && i >= events.length) break;
    await new Promise((resolve2) => {
      resolveNext = resolve2;
    });
  }
}

// ../spikes/p0-model-gateway/governed-agentic-run.ts
var execFileAsync2 = promisify2(execFile2);
var AGENTIC_RUN_POSTURE = "governed-unsandboxed";
var AGENTIC_VERIFIER_ISOLATION = "inline-unsandboxed";
var NOT_VERIFIED_CHECK_NAME = "changed-files only \u2014 NOT independently verified by a build/test";
var VERIFY_DEFAULT_TIMEOUT_MS = 15 * 6e4;
var AGENTIC_AGENT_BACKEND = "codex-cli";
function checkStatusForExit(exitCode) {
  return exitCode === 0 ? "pass" : "fail";
}
async function runVerifyCheck(command, cwd, env, timeoutMs, signal) {
  const name = command.join(" ") || "(empty command)";
  if (command.length === 0) {
    return { name, command: [...command], status: "error" };
  }
  if (signal?.aborted) {
    return {
      name: `${name} \u2014 verifier aborted by run/cancel`,
      command: [...command],
      status: "error"
    };
  }
  try {
    await execFileAsync2(command[0], command.slice(1), {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      ...signal ? { signal } : {}
    });
    return { name, command: [...command], status: "pass" };
  } catch (err) {
    const e = err;
    const aborted = signal?.aborted === true || e.name === "AbortError" || e.code === "ABORT_ERR";
    if (aborted) {
      return {
        name: `${name} \u2014 verifier aborted by run/cancel`,
        command: [...command],
        status: "error"
      };
    }
    const timedOut = e.killed === true || e.signal === "SIGTERM";
    if (timedOut) {
      return {
        name: `${name} \u2014 verifier timed out after ${Math.round(timeoutMs / 1e3)}s`,
        command: [...command],
        status: "error"
      };
    }
    if (typeof e.code === "number") {
      return { name, command: [...command], status: checkStatusForExit(e.code) };
    }
    return { name, command: [...command], status: "error" };
  }
}
async function runGovernedAgenticBuild(opts) {
  const now = opts.now ?? Date.now;
  const emit = opts.emit ?? (() => {
  });
  const endpoints = opts.modelEndpoints ?? DEFAULT_MODEL_ENDPOINTS;
  const verifierKey = opts.verifierPrivateKey ?? generateVerifierKeypair().privateKey;
  let runId;
  let runDir;
  let tracePath;
  let sink;
  if (opts.existingRun) {
    runId = opts.existingRun.runId;
    tracePath = opts.existingRun.tracePath;
    sink = opts.sink ?? opts.existingRun.sink;
    runDir = join6(tracePath, "..", "..");
  } else {
    const created = createRun(opts.runsBaseDir);
    runId = created.runId;
    runDir = created.dir;
    tracePath = join6(runSubdirPath(runDir, "trace"), "trace.jsonl");
    sink = opts.sink ?? createTraceWriter(tracePath);
  }
  let lastTraceHash;
  if (opts.existingRun) {
    try {
      const prior = readTrace(tracePath);
      if (prior.length > 0) lastTraceHash = prior[prior.length - 1].hash;
    } catch {
    }
  }
  const append = (type, payload, source) => {
    const written = sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      // the writer is authoritative for seq
      ts: now(),
      type,
      payload,
      ...source ? { source } : {}
    });
    if (written && typeof written.hash === "string") {
      lastTraceHash = written.hash;
    }
  };
  let state = "created";
  const transition = (to, reason) => {
    const from = state;
    state = to;
    emit({ type: "state", from, to, reason });
    const payload = {
      from,
      to,
      reason
    };
    append("run_state_changed", payload, "policy");
  };
  const allow = [
    ...endpoints.map((e) => `${e.host}:${e.port ?? 443}`),
    ...agentSupportAllowEntries("codex")
  ];
  const proxy = await startGovernedTerminalProxy({
    allow,
    sink,
    runId,
    modelEndpoints: endpoints,
    bindHost: opts.bindHost ?? "127.0.0.1",
    observeAll: true,
    // SOFT governed-unsandboxed boundary: observe + trace, don't block
    ...opts.denyDirectIp !== void 0 ? { denyDirectIp: opts.denyDirectIp } : {}
  });
  const { env: governedEnv, posture: credentialPosture } = buildGovernedEnvResult({
    proxyUrl: proxy.url
  });
  emit({ type: "run_created", runId, runDir, proxyUrl: proxy.url, posture: AGENTIC_RUN_POSTURE });
  const runCreated = {
    runId,
    runDir,
    intent: opts.prompt.slice(0, 200),
    workflowType: "bugfix",
    agentBackend: AGENTIC_AGENT_BACKEND
  };
  append("run_created", runCreated, "supervisor");
  let agentic;
  let buildError;
  try {
    transition("worktree_ready", "run directory + governed proxy ready");
    transition("sandbox_ready", "governed env built (egress brokered, ambient secrets stripped)");
    transition("executing", "agentic codex build started");
    for await (const ev of runAgenticBuild(
      { prompt: opts.prompt, cwd: opts.cwd, env: governedEnv },
      {
        codexPath: opts.codexPath,
        ...opts.timeoutMs !== void 0 ? { timeoutMs: opts.timeoutMs } : {},
        ...opts.signal ? { signal: opts.signal } : {},
        ...opts.onOperatorLog ? { onOperatorLog: opts.onOperatorLog } : {}
      }
    )) {
      emit({ type: "agentic", event: ev });
      if (ev.type === "command") {
        if (ev.phase === "start") {
          const payload = {
            tool: "command",
            requestedCapability: "command:exec",
            provenanceLabel: "tool-output"
          };
          append("tool_start", payload);
        } else {
          const payload = {
            tool: "command",
            ...ev.exitCode !== void 0 ? { exitCode: ev.exitCode } : {},
            provenanceLabel: "tool-output"
          };
          append("tool_end", payload);
        }
      } else if (ev.type === "error") {
        buildError = ev.message;
      } else if (ev.type === "result") {
        agentic = ev.result;
        const call = {
          model: AGENTIC_AGENT_BACKEND,
          ...ev.result.usage?.inputTokens !== void 0 ? { inputTokens: ev.result.usage.inputTokens } : {},
          ...ev.result.usage?.outputTokens !== void 0 ? { outputTokens: ev.result.usage.outputTokens } : {},
          provenanceLabel: "tool-output"
        };
        append("model_call", call);
      }
    }
  } finally {
    await proxy.close();
  }
  const codexOk = agentic !== void 0 && agentic.exitCode === 0 && !buildError;
  transition(codexOk ? "completed" : "failed", codexOk ? "agentic build completed" : `agentic build failed: ${buildError ?? `codex exit ${agentic?.exitCode ?? "unknown"}`}`);
  let verdict;
  let verifyRan;
  let verifierIsolation;
  let verifyCommandSource;
  const independentResult = opts.independentVerifier ? await runIndependentVerification({
    repoPath: opts.independentVerifier.repoPath ?? opts.cwd,
    // The agentic actor edits the cwd IN PLACE, so the cwd IS the actor's result
    // worktree the independent verifier overlays onto its own fresh checkout.
    sourceWorktree: opts.cwd,
    policyPath: opts.independentVerifier.policyPath,
    tracePath,
    privateKey: verifierKey,
    ...opts.independentVerifier.runtime ? { runtime: opts.independentVerifier.runtime } : {},
    ...opts.independentVerifier.runsBaseDir !== void 0 ? { runsBaseDir: opts.independentVerifier.runsBaseDir } : {},
    ...opts.onOperatorLog ? { onOperatorLog: opts.onOperatorLog } : {}
  }) : void 0;
  if (independentResult && independentResult.ran) {
    verdict = independentResult.verdict;
    verifyRan = independentResult.verdict.checks.some(
      (c) => c.status === "pass" || c.status === "fail"
    );
    verifierIsolation = "independent-sandboxed";
    verifyCommandSource = verifyRan ? "override" : "none";
    append(
      "verifier_verdict",
      {
        overallVerdict: verdict.overallVerdict,
        traceRootHash: verdict.traceRootHash,
        checks: verdict.checks
      },
      "verifier"
    );
  } else {
    if (independentResult && !independentResult.ran) {
      (opts.onOperatorLog ?? (() => {
      }))(
        "independent verifier could not run \u2014 falling back to the inline-unsandboxed check"
      );
    }
    const checks = [];
    verifyRan = !!(opts.verifyCommand && opts.verifyCommand.length > 0);
    if (verifyRan) {
      const check = await runVerifyCheck(
        opts.verifyCommand,
        opts.cwd,
        governedEnv,
        // Generous but BOUNDED: Swift/Xcode test builds are slow. We give the check a
        // wide window (default 15 min) yet still hard-bound it, so a hung toolchain
        // surfaces an honest "verifier timed out" rather than hanging the run. A caller
        // may raise it further via `timeoutMs` (e.g. an even larger Xcode build).
        opts.timeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS,
        // CANCELLATION (sweep-47 M1): forward the SAME abort signal the actor used so a
        // run/cancel that lands after the actor exits and the verifier started kills the
        // verifier promptly. An aborted verify is an honest 'error' (never a green pass).
        opts.signal
      );
      checks.push(check);
    } else {
      const changed = agentic?.changedFiles.length ?? 0;
      checks.push({
        name: `${NOT_VERIFIED_CHECK_NAME} (${changed} file(s) changed)`,
        command: [],
        status: "skipped"
      });
    }
    const anyFail = checks.some((c) => c.status === "fail");
    const anyError = checks.some((c) => c.status === "error") || buildError !== void 0;
    const overallVerdict = anyError ? "error" : anyFail ? "fail" : verifyRan ? "pass" : "fail";
    let traceRootHash = lastTraceHash ?? GENESIS_HASH;
    try {
      const events = readTrace(tracePath);
      if (events.length > 0) traceRootHash = computeTraceRoot(events);
    } catch {
    }
    const core = { checks, overallVerdict, traceRootHash };
    const signature = signVerdict(core, verifierKey);
    verdict = { ...core, signature };
    verifierIsolation = AGENTIC_VERIFIER_ISOLATION;
    verifyCommandSource = verifyRan ? opts.verifyCommandSource ?? "override" : "none";
    append("verifier_verdict", { overallVerdict, traceRootHash, checks }, "verifier");
  }
  emit({ type: "verdict", verdict });
  emit({ type: "run_closed", runId, ok: verdict.overallVerdict === "pass" });
  return {
    runId,
    runDir,
    tracePath,
    posture: AGENTIC_RUN_POSTURE,
    credentialPosture,
    ...agentic ? { agentic } : {},
    verdict,
    verifyRan,
    // HONEST ISOLATION: 'independent-sandboxed' iff the separate-trust-domain product
    // verifier produced the verdict; otherwise the inline-unsandboxed fallback.
    verifierIsolation,
    // The verify command's provenance: for the independent path, the REVIEWED policy
    // ('override' when targets ran, 'none' when Policy.verify was empty); for the inline
    // fallback, the stated source when a real check ran, or 'none' when no check ran.
    verifyCommandSource
  };
}

// ../spikes/p0-model-gateway/verify-command.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, readdirSync as readdirSync2 } from "node:fs";
import { join as join7 } from "node:path";
import { execFileSync as execFileSync2 } from "node:child_process";
var VERIFY_OVERRIDE_PATH = ".glyphspek/verify.json";
var defaultVerifyResolverDeps = {
  fileExists: (p) => existsSync3(p),
  readFile: (p) => readFileSync3(p, "utf8"),
  listDir: (dir) => {
    try {
      return readdirSync2(dir);
    } catch {
      return [];
    }
  },
  runXcodebuildList: (cwd) => {
    try {
      return execFileSync2("xcodebuild", ["-list", "-json"], {
        cwd,
        encoding: "utf8",
        // `xcodebuild -list` is metadata-only and fast; keep a tight bound so a
        // missing/hung toolchain falls back to the honest `none` rather than stalling.
        timeout: 3e4,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return void 0;
    }
  }
};
function asStringArray(v) {
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0)) {
    return v;
  }
  return void 0;
}
function readOverride(cwd, deps) {
  const path4 = join7(cwd, VERIFY_OVERRIDE_PATH);
  if (!deps.fileExists(path4)) return void 0;
  let raw;
  try {
    raw = JSON.parse(deps.readFile(path4));
  } catch {
    return void 0;
  }
  const bare = asStringArray(raw);
  if (bare) return bare;
  if (raw && typeof raw === "object") {
    const obj = raw;
    const verify = asStringArray(obj.verify);
    if (verify) return verify;
    for (const field of ["verify", "verificationTargets"]) {
      const matrix = obj[field];
      if (Array.isArray(matrix)) {
        for (const row of matrix) {
          const argv = asStringArray(row);
          if (argv) return argv;
        }
      }
    }
  }
  return void 0;
}
function resolveXcodeScheme(cwd, preferredName, deps) {
  const out = deps.runXcodebuildList(cwd);
  if (!out) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return void 0;
  }
  if (!parsed || typeof parsed !== "object") return void 0;
  const root = parsed;
  const container = root.project ?? root.workspace;
  const schemes = asStringArray(container?.schemes);
  if (!schemes || schemes.length === 0) return void 0;
  if (preferredName) {
    const match = schemes.find((s) => s === preferredName);
    if (match) return match;
  }
  return schemes[0];
}
function xcodeProjectBaseName(entries) {
  const proj = entries.find((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
  if (!proj) return void 0;
  return proj.replace(/\.(xcodeproj|xcworkspace)$/, "");
}
function resolveVerifyCommand(cwd, deps = defaultVerifyResolverDeps) {
  const override = readOverride(cwd, deps);
  if (override) {
    return { command: override, label: override.join(" "), source: "override" };
  }
  const entries = deps.listDir(cwd);
  const has = (name) => deps.fileExists(join7(cwd, name));
  if (has("Package.swift")) {
    return { command: ["swift", "test"], label: "swift test", source: "swiftpm" };
  }
  const hasXcode = entries.some(
    (e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace")
  );
  if (hasXcode) {
    const preferred = xcodeProjectBaseName(entries);
    const scheme = resolveXcodeScheme(cwd, preferred, deps);
    if (!scheme) {
      return {
        source: "none",
        note: `an Xcode project was detected but no scheme could be resolved (xcodebuild may be unavailable, or the project lists no shared scheme). Add ${VERIFY_OVERRIDE_PATH} with the exact check argv, e.g. ["xcodebuild","test","-scheme","<YourScheme>","-destination","platform=macOS"].`
      };
    }
    const command = [
      "xcodebuild",
      "test",
      "-scheme",
      scheme,
      "-destination",
      "platform=macOS"
    ];
    return { command, label: "xcodebuild test", source: "xcode" };
  }
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(deps.readFile(join7(cwd, "package.json")));
      if (pkg.scripts && typeof pkg.scripts.test === "string" && pkg.scripts.test.trim()) {
        return { command: ["npm", "test"], label: "npm test", source: "npm" };
      }
    } catch {
    }
  }
  if (entries.some((e) => /\.test\.(js|ts|mjs)$/.test(e))) {
    return { command: ["node", "--test"], label: "node --test", source: "node" };
  }
  return {
    source: "none",
    note: `no build/test check could be auto-detected for this repo. The verdict will be labeled "changed-files only \u2014 NOT independently verified by a build/test". Add ${VERIFY_OVERRIDE_PATH} (a JSON array of strings) with the exact check argv to get a real verified verdict, e.g. ["npm","test"] or ["xcodebuild","test","-scheme","<YourScheme>","-destination","platform=macOS"].`
  };
}

// ../spikes/p0-supervisor/bridge-server.ts
var APPROVED_ISOLATION_RUNTIMES = [
  "docker",
  "firecracker"
];
function isApprovedIsolationRuntime(runtimeProfile) {
  return APPROVED_ISOLATION_RUNTIMES.includes(runtimeProfile.trim().toLowerCase());
}
function selfHashCheck(selfPath, pinnedSha) {
  if (!pinnedSha) return { ok: true };
  if (!selfPath) {
    return { ok: false, message: "self-hash check: no path to hash but a pin is set" };
  }
  let actual;
  try {
    actual = createHash3("sha256").update(readFileSync4(selfPath)).digest("hex");
  } catch (err) {
    return {
      ok: false,
      message: `self-hash check: cannot read ${selfPath}: ${String(err?.message ?? err)}`
    };
  }
  if (actual !== pinnedSha.toLowerCase()) {
    return {
      ok: false,
      message: `self-hash mismatch: expected ${pinnedSha}, computed ${actual}`
    };
  }
  return { ok: true };
}
var DEFAULT_CHAT_BACKEND_ID = "codex";
var CODEX_HASH_CAP_BYTES = 256 * 1024 * 1024;
function captureCodexBinaryIdentity(codexPath) {
  const identity = { path: codexPath };
  let sizeBytes;
  try {
    const st = statSync3(codexPath);
    sizeBytes = st.size;
    identity.sizeBytes = st.size;
    identity.mtimeMs = st.mtimeMs;
  } catch {
  }
  if (sizeBytes === void 0 || sizeBytes <= CODEX_HASH_CAP_BYTES) {
    try {
      const hash = createHash3("sha256").update(readFileSync4(codexPath)).digest("hex");
      identity.sha256 = hash;
    } catch {
    }
  }
  try {
    const res = spawnSync2(codexPath, ["--version"], {
      timeout: 2500,
      encoding: "utf8",
      shell: false,
      maxBuffer: 64 * 1024,
      windowsHide: true
    });
    if (res.status === 0 && typeof res.stdout === "string") {
      const first = res.stdout.split(/\r?\n/, 1)[0]?.trim();
      if (first) identity.version = first;
    }
  } catch {
  }
  return identity;
}
function createProductionCodexBackend(codexPath, onOperatorLog) {
  return new CodexChatBackend({
    ...codexPath ? { codexPath } : {},
    onOperatorLog
  });
}
var InMemoryTraceSink = class {
  events = [];
  append(evt) {
    const prevHash = this.events.length ? this.events[this.events.length - 1].hash : "";
    const hash = `h${this.events.length}`;
    const full = { ...evt, prevHash, hash };
    this.events.push(full);
    return full;
  }
};
function sinkEvents3(sink) {
  const maybe = sink.events;
  return Array.isArray(maybe) ? maybe : [];
}
function sinkLength(sink) {
  return sinkEvents3(sink).length;
}
function modelEventDetail(e) {
  const p = e.payload ?? {};
  switch (e.type) {
    case "policy_decision": {
      const d = p;
      return {
        tool: d.tool ?? "model",
        decision: d.decision,
        provider: d.provider,
        model: d.model,
        ...d.endpointHost ? { endpointHost: d.endpointHost } : {},
        ...d.rule ? { rule: d.rule } : {},
        ...d.provenanceLabel ? { provenanceLabel: d.provenanceLabel } : {}
      };
    }
    case "tool_start": {
      const t = p;
      return {
        tool: t.tool ?? "model",
        ...t.provider ? { provider: t.provider } : {},
        ...t.model ? { model: t.model } : {},
        ...t.endpointHost ? { endpointHost: t.endpointHost } : {},
        // Credential POSTURE only — never the credential value.
        ...t.credentialPosture ? { credentialPosture: t.credentialPosture } : {}
      };
    }
    case "model_call": {
      const m = p;
      return {
        ...m.provider ? { provider: m.provider } : {},
        ...m.model ? { model: m.model } : {},
        ...m.endpointHost ? { endpointHost: m.endpointHost } : {},
        ...typeof m.inputTokens === "number" ? { inputTokens: m.inputTokens } : {},
        ...typeof m.outputTokens === "number" ? { outputTokens: m.outputTokens } : {},
        ...typeof m.costMicroUsd === "number" ? { costMicroUsd: m.costMicroUsd } : {},
        ...typeof m.durationMs === "number" ? { durationMs: m.durationMs } : {}
      };
    }
    case "redaction": {
      return {
        location: p.location,
        ...p.field ? { field: p.field } : {},
        ...p.reason ? { reason: p.reason } : {}
      };
    }
    case "prompt": {
      return {
        ...typeof p.messageCount === "number" ? { messageCount: p.messageCount } : {},
        ...Array.isArray(p.contextRefs) ? { contextRefs: p.contextRefs } : {},
        ...p.provenanceLabel ? { provenanceLabel: p.provenanceLabel } : {}
      };
    }
    default: {
      const out = {};
      if (typeof p.tool === "string") out.tool = p.tool;
      if (typeof p.decision === "string") out.decision = p.decision;
      if (typeof p.blocked === "boolean") out.blocked = p.blocked;
      if (typeof p.ok === "boolean") out.ok = p.ok;
      return out;
    }
  }
}
function mapGitStatusToReviewStatus(status) {
  const s = (status ?? "").trim().toUpperCase();
  if (s === "A" || s === "?" || s === "??") return "added";
  if (s === "D") return "deleted";
  return "modified";
}
function projectAgenticBuildReview(runId, prompt, result) {
  const agentic = result.agentic;
  const changedFiles = (agentic?.changedFiles ?? []).map((f) => ({
    path: f.path,
    status: mapGitStatusToReviewStatus(f.status)
  }));
  const commands = (agentic?.commands ?? []).map((c) => ({
    cmd: c.cmd,
    ...c.exitCode !== void 0 ? { exitCode: c.exitCode } : {}
  }));
  const egress = readObservedEgress(result);
  const verdict = result.verdict;
  const verifierIsolation = readVerifierIsolation(result);
  const verifyCommandSource = readVerifyCommandSource(result);
  const assurance = computeBuildAssurance({
    verifierIsolation,
    verifyRan: result.verifyRan === true,
    // STRICT (sweep-55 #1): missing/omitted != ran
    overall: verdict.overallVerdict,
    ...verdict.signature ? { signature: verdict.signature } : {}
  });
  return {
    runId,
    intent: prompt,
    actor: "codex",
    posture: "governed-unsandboxed",
    summary: agentic?.summary ?? "",
    changedFiles,
    diff: agentic?.diff ?? "",
    commands,
    egress,
    verdict: {
      overall: verdict.overallVerdict,
      assurance,
      verifierIsolation,
      verifyCommandSource,
      checks: verdict.checks.map((c) => ({ name: c.name, status: c.status })),
      // TRACE-INTEGRITY (High B): carry the SIGNED trace root through the render
      // contract so the mobile/dashboard verdict binds the REAL signed root — not a
      // blank/stale `run.traceRoot`. This is the exact root `signature` was computed
      // over (see p0-verifier signVerdict), so a re-signed mobile verdict still points
      // at the real signed root.
      traceRootHash: verdict.traceRootHash,
      ...verdict.signature ? {
        signature: {
          alg: verdict.signature.alg,
          value: verdict.signature.value,
          keyId: verdict.signature.keyId
        }
      } : {}
    }
  };
}
function readObservedEgress(result) {
  const maybe = result.egress;
  return Array.isArray(maybe) ? maybe.filter((x) => typeof x === "string") : [];
}
function readVerifierIsolation(result) {
  const maybe = result.verifierIsolation;
  return maybe === "independent-sandboxed" ? "independent-sandboxed" : "inline-unsandboxed";
}
function readVerifyCommandSource(result) {
  if (result.verifyRan === false) return "none";
  const maybe = result.verifyCommandSource;
  switch (maybe) {
    case "override":
    case "swiftpm":
    case "xcode":
    case "npm":
    case "node":
    case "none":
      return maybe;
    default:
      return "override";
  }
}
var DEFAULT_SUPERVISOR_VERSION = "0.0.0-p0";
var BridgeServer = class {
  supervisorVersion;
  runsBaseDir;
  writeLine;
  logLine;
  selfPath;
  pinnedSha;
  model;
  chat;
  agentic;
  terminalModelEndpoints;
  stdinBuffer = "";
  handshakeDone = false;
  hashChecked = false;
  /** Created runs, keyed by runId (retained for run/event emission). */
  runs = /* @__PURE__ */ new Map();
  /** The chat gateway, constructed lazily on the first chat/send. */
  chatGateway;
  /** Monotonic counter minting chat turn ids (per connection). */
  chatTurnSeq = 0;
  /**
   * The run the IN-FLIGHT chat turn is anchored to, if any. The gateway's trace
   * seam reads this so a `model_call` breadcrumb is mirrored to the right run's
   * run/event stream. Set per turn (the gateway is reused across turns/runs).
   */
  chatActiveRunId;
  /**
   * The GOVERNED CHAT SESSION (Finding 1): a real supervisor-owned run + metadata-
   * only egress proxy + hash-chained trace, created LAZILY on the first chat/send of
   * the connection and REUSED across turns. The governed env (HTTPS_PROXY/HTTP_PROXY →
   * `proxyUrl`, ambient secrets stripped) the chat backend runs under is built from
   * this session's proxy URL — so a chat turn's codex egress is brokered (the broker
   * owns the network) and the turn is run-bound + trace-backed. Absent until the
   * first turn; a creation failure leaves it undefined and the turn errors honestly.
   */
  chatGovernedSession;
  /** In-flight lazy creation of the governed chat session (de-dupes concurrent turns). */
  chatSessionPromise;
  /**
   * The SINGLE codex LAUNCH object (Finding 2): the absolute path the supervisor
   * resolved + identity-checked, flowing from that ONE resolution step into BOTH
   * the run/trace evidence AND the production {@link CodexChatBackend}'s `spawn`,
   * so the recorded binary identity and the launched bytes cannot drift. Captured
   * by the governed-session step; `codexPath` is undefined when codex is not on
   * PATH (the production backend then fails the turn closed — no bare `codex`).
   */
  codexLaunch;
  /** Monotonic counter minting agentic-build run ids (per connection). */
  buildSeq = 0;
  /**
   * PENDING governed builds awaiting a remote approval decision, keyed by approvalId
   * (remote-control). A non-approved `build/start` in pending mode parks the request
   * here (codex NOT spawned) until `approval/respond` grants/denies it. Empty in the
   * desktop flow (a non-approved build is refused there, not parked).
   */
  pendingBuilds = /* @__PURE__ */ new Map();
  /**
   * REMOTE-ACTION TRACE RECORDER state (trace-integrity High A). The canonical,
   * hash-chained trace for a run is the single source of truth. Remote human
   * actions (mobile approvals, coding messages, diff accept/reject) taken over
   * the gateway are appended into the TARGET RUN's REAL `TraceWriter` — never a
   * display-only breadcrumb. This map memoizes one `TraceWriter` per target runId
   * so the recorder continues (append-only) the same on-disk chain `build/start`
   * uses, and so the chain head stays consistent across a single connection. The
   * build path registers its sink here (see `runApprovedBuild`) so a post-approval
   * remote action chains into the very same trace file the build wrote.
   */
  remoteTraceWriters = /* @__PURE__ */ new Map();
  /** Trace file path per target runId (the run dir's trace.jsonl). */
  remoteTracePaths = /* @__PURE__ */ new Map();
  constructor(opts) {
    this.supervisorVersion = opts.supervisorVersion ?? DEFAULT_SUPERVISOR_VERSION;
    this.runsBaseDir = opts.runsBaseDir;
    this.writeLine = opts.writeLine;
    this.logLine = opts.logLine ?? (() => {
    });
    this.selfPath = opts.selfPath;
    this.pinnedSha = opts.pinnedSha;
    this.model = opts.model;
    this.chat = opts.chat;
    this.agentic = opts.agentic;
    this.terminalModelEndpoints = opts.terminalModelEndpoints;
  }
  /**
   * Resolve the model endpoints a governed terminal session classifies. Explicit
   * config wins; else derive from the configured model allowlist (each allowed
   * model's endpoint host); else fall back to {@link DEFAULT_MODEL_ENDPOINTS}.
   */
  terminalEndpoints() {
    if (this.terminalModelEndpoints) return this.terminalModelEndpoints;
    const allowed = this.model?.modelPolicy.allowed;
    if (allowed && allowed.length > 0) {
      return allowed.map((a) => ({
        host: a.endpointHost,
        // Model APIs are HTTPS/443; pin the port so the terminal allowlist reaches
        // ONLY the model API port on the provider host (sweep-23 #5).
        port: 443,
        provider: a.provider,
        model: `${a.model} (boundary)`
      }));
    }
    return DEFAULT_MODEL_ENDPOINTS;
  }
  /** The actor types this supervisor build can host (reported in the handshake). */
  get supportedActorTypes() {
    return [...ACTOR_TYPES];
  }
  /**
   * Feed a raw chunk of stdin. Splits on newlines (NDJSON) and dispatches each
   * complete line. A partial trailing line is buffered until its newline arrives.
   */
  ingest(chunk) {
    this.stdinBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl;
    while ((nl = this.stdinBuffer.indexOf("\n")) !== -1) {
      const line = this.stdinBuffer.slice(0, nl).replace(/\r$/, "");
      this.stdinBuffer = this.stdinBuffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      this.handleLine(line);
    }
  }
  /**
   * Tear down connection-scoped resources held by this server — currently the lazily
   * opened GOVERNED CHAT SESSION (Finding 1): its egress proxy listener + run trace.
   * In production the bridge child process exits when the extension disposes the chat
   * session (killing the proxy with it); this is the explicit, awaitable teardown so a
   * HEADLESS test that opened a chat session can release the proxy listener (otherwise
   * the open socket keeps the event loop alive). Idempotent; resolve-never-reject.
   */
  async shutdown() {
    const governed = this.chatGovernedSession;
    this.chatGovernedSession = void 0;
    if (governed) {
      try {
        await governed.session.stop();
      } catch {
      }
    }
  }
  /** Parse one NDJSON line and dispatch it (resolve-never-throw). */
  handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logLine(`[bridge-server] dropping non-JSON stdin line`);
      return;
    }
    if (!isEnvelope(parsed)) {
      const maybeId = parsed?.id;
      if (typeof maybeId === "number") {
        this.emit(
          this.errorResponse(
            maybeId,
            BridgeErrorCode.InvalidRequest,
            "foreign envelope: missing or wrong glyphspek dialect tag"
          )
        );
      } else {
        this.logLine("[bridge-server] dropping foreign envelope (no usable id)");
      }
      return;
    }
    if (!isRequest(parsed)) {
      this.logLine("[bridge-server] dropping non-request envelope from client");
      return;
    }
    const req = parsed;
    try {
      this.dispatch(req);
    } catch (err) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `internal supervisor error: ${String(err?.message ?? err)}`
        )
      );
    }
  }
  /** Route a well-formed request to its handler. */
  dispatch(req) {
    switch (req.method) {
      case BridgeMethod.Handshake:
        this.handleHandshake(req);
        return;
      case BridgeMethod.CreateRun:
        this.handleCreateRun(req);
        return;
      case BridgeMethod.StartRun:
        void this.handleStartRun(req);
        return;
      case BridgeMethod.ModelAllowlist:
        this.handleModelAllowlist(req);
        return;
      case BridgeMethod.ModelCall:
        void this.handleModelCall(req);
        return;
      case BridgeMethod.TerminalStart:
        void this.handleTerminalStart(req);
        return;
      case BridgeMethod.TerminalStop:
        void this.handleTerminalStop(req);
        return;
      case BridgeMethod.ChatSend:
        void this.handleChatSend(req);
        return;
      case BridgeMethod.AgenticBuildStart:
        void this.handleAgenticBuildStart(req);
        return;
      case BridgeMethod.RunCancel:
        this.handleRunCancel(req);
        return;
      case BridgeMethod.ApprovalRespond:
        this.handleApprovalRespond(req);
        return;
      default:
        this.emit(
          this.errorResponse(
            req.id,
            BridgeErrorCode.InvalidRequest,
            `unknown method: ${String(req.method)}`
          )
        );
    }
  }
  /**
   * bridge/handshake — MUST be answerable first. Reports this supervisor's
   * protocol version, its own semantic version, and the actor types it can host.
   * Also runs the defense-in-depth self-hash check; a mismatch is surfaced as
   * HashMismatch (-32010) rather than completing the handshake.
   */
  handleHandshake(req) {
    if (!this.hashChecked) {
      const check = this.pinnedSha ? selfHashCheck(this.selfPath, this.pinnedSha) : { ok: true };
      this.hashChecked = true;
      if (!check.ok) {
        this.logLine(`[bridge-server] ${check.message}`);
        this.emit(
          this.errorResponse(req.id, BridgeErrorCode.HashMismatch, check.message)
        );
        return;
      }
    }
    const result = {
      bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      supervisorVersion: this.supervisorVersion,
      supportedActorTypes: this.supportedActorTypes
    };
    this.handshakeDone = true;
    this.logLine(
      `[bridge-server] handshake OK \u2014 supervisor ${this.supervisorVersion}, protocol v${BRIDGE_PROTOCOL_VERSION}.`
    );
    this.emit(this.successResponse(req.id, result));
  }
  /**
   * run/create — independently re-validate the RunRequest, create a real run via
   * the existing lifecycle, and settle a trust posture.
   *
   * Trust decision (the core invariant):
   *   - validation fails (missing identity/posture)  → error IdentityMissing.
   *   - validation passes AND runtime is approved-isolation → trust 'trusted'
   *     (carries a real runId).
   *   - validation passes BUT runtime is non-isolating  → trust 'untrusted'
   *     (still a real run, but downgraded: non-isolating runtime can't be trusted).
   *
   * There is NO field combination that yields a SILENT trusted run.
   */
  handleCreateRun(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "run/create before a completed handshake"
        )
      );
      return;
    }
    const validation = validateRunRequest(req.params);
    if (!validation.ok) {
      const message = `run request missing required field(s): ${validation.missing.join(", ")}`;
      this.logLine(`[bridge-server] ${message} \u2014 IdentityMissing.`);
      this.emit(
        this.errorResponse(req.id, BridgeErrorCode.IdentityMissing, message, {
          missing: validation.missing
        })
      );
      return;
    }
    const request = validation.request;
    const created = createRun(this.runsBaseDir);
    const lifecycle = new RunLifecycle(created.state);
    const isolation = isApprovedIsolationRuntime(request.runtimeProfile);
    const trust = isolation ? "trusted" : "untrusted";
    const reason = isolation ? void 0 : `runtime profile "${request.runtimeProfile}" is not an approved isolation runtime; run is untrusted (non-isolating runtime cannot produce a product-trusted run).`;
    this.runs.set(created.runId, {
      created,
      lifecycle,
      trust,
      request,
      runtimeIsolated: isolation
    });
    const result = {
      runId: created.runId,
      trust,
      ...reason ? { reason } : {}
    };
    this.logLine(
      `[bridge-server] run/create \u2192 ${trust} (runId=${created.runId}, runtime=${request.runtimeProfile}, actor=${request.actorType}).`
    );
    this.emit(this.successResponse(req.id, result));
  }
  /**
   * run/start — DRIVE a previously-created run and STREAM the live `run/event`
   * sequence (M5 live Trust Panel). The run is driven through the REAL supervisor
   * pipeline by the scripted run driver (real lifecycle FSM, real hash-chained
   * trace, real policy decisions, a real signed verdict); only the actor's tool
   * steps are scripted (a real model-driven agent loop replaces them without
   * changing the event grammar — see scripted-run-driver.ts).
   *
   * Each emitted envelope is forwarded as a `run/event` notification; the CLIENT
   * re-validates every envelope against runEventProtocol BEFORE the panel renders
   * it, so a malformed/foreign envelope never reaches the renderer. The response
   * here only ACKNOWLEDGES the start; the evidence arrives on the stream.
   *
   * Single-shot per run: a second run/start for the same run is refused (the run
   * has already been driven to a terminal state).
   */
  async handleStartRun(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "run/start before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const runId = typeof params.runId === "string" ? params.runId : "";
    const serverRun = runId ? this.runs.get(runId) : void 0;
    if (!serverRun) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `run/start for unknown run "${runId || "(missing)"}" \u2014 create the run first`
        )
      );
      return;
    }
    if (serverRun.started) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `run/start for already-started run "${runId}" \u2014 a run is driven once`
        )
      );
      return;
    }
    serverRun.started = true;
    const facts = {
      runId,
      runDir: serverRun.created.dir,
      actorType: serverRun.request.actorType,
      runtimeProfile: serverRun.request.runtimeProfile,
      runtimeTrust: serverRun.runtimeIsolated ? "trusted" : "untrusted",
      extensionPosture: serverRun.request.extensionPosture,
      // Carry the creation-time posture faithfully into the run_opened badge. We
      // drive trusted, untrusted (dev-runtime), governed-unsandboxed (the
      // governed-terminal SOFT posture, sweep-23 #2) AND sandboxed-soft-egress (the
      // M7 isolation-path posture: real fs isolation, soft egress) runs; only a
      // truly unexpected value collapses to 'refused'. Never MISLABEL a real
      // sub-trusted posture as refused — product trust is still gated separately
      // and strictly (=== 'trusted').
      creationTrust: serverRun.trust === "trusted" || serverRun.trust === "sandboxed-soft-egress" || serverRun.trust === "governed-unsandboxed" || serverRun.trust === "untrusted" ? serverRun.trust : "refused",
      // Native runs do not carry CLI fidelity; a CLI adapter would set this from
      // the adapter's detected hook surface (per-tool-brokered vs boundary-only).
      cliFidelity: serverRun.request.actorType === "native" ? "n/a" : "per-tool-brokered"
    };
    try {
      const result = await driveScriptedRun({
        facts,
        // Drive the REAL lifecycle the run/create minted, so the FSM history is
        // continuous (created → … → completed) rather than a fresh machine.
        lifecycle: serverRun.lifecycle,
        emit: (event) => this.emitRunEventEnvelope(event)
      });
      this.logLine(
        `[bridge-server] run/start \u2192 drove ${runId} to ${result.finalState} (${result.eventCount} trace events, verdict=${result.overallVerdict}).`
      );
      this.emit(
        this.successResponse(req.id, {
          runId,
          finalState: result.finalState,
          eventCount: result.eventCount
        })
      );
    } catch (err) {
      this.logLine(`[bridge-server] run/start failed for ${runId}: ${String(err?.message ?? err)}`);
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `run/start failed: ${String(err?.message ?? err)}`
        )
      );
    }
  }
  /* ============================================================== *
   * MODEL BROKER RPC (M6)
   * ============================================================== */
  /**
   * model/allowlist — report the (provider, model, endpoint) tuples the UI may
   * offer. This is the ONLY way the UI learns which models exist; it surfaces
   * EXACTLY these and nothing else. The result carries NO credential — only the
   * non-secret provider/model/endpoint posture. With no configured model broker
   * the allowlist is EMPTY (default-deny: the UI offers nothing).
   */
  handleModelAllowlist(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "model/allowlist before a completed handshake"
        )
      );
      return;
    }
    const models = (this.model?.modelPolicy.allowed ?? []).map((a) => ({
      provider: a.provider,
      model: a.model,
      endpointHost: a.endpointHost,
      label: `${a.provider} / ${a.model}`
    }));
    const result = { models };
    this.emit(this.successResponse(req.id, result));
  }
  /**
   * model/call — broker ONE model call (chat / inline-edit) through the run's
   * {@link ModelBroker}. The flow:
   *   1. require a completed handshake AND a known, created runId;
   *   2. construct (lazily, once) the run's ModelBroker with the SUPERVISOR-SIDE
   *      credentials + the run's TraceSink + the egress broker + the transport;
   *   3. map the RPC params onto a ModelCallRequest and call the broker, which
   *      decides (allowlist + taint firewall), redacts, egress-brokers, "calls"
   *      the (stub) transport with the credential out-of-band, and redacts the
   *      completion before returning it;
   *   4. forward the model trace events to the run/event stream for the panel;
   *   5. return the UI-facing projection: decision + redacted completion + usage +
   *      traceEventRef + error. NO credential is ever in the result.
   *
   * With no configured model broker, every call is DENIED (default-deny).
   */
  async handleModelCall(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "model/call before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const runId = typeof params.runId === "string" ? params.runId : "";
    const serverRun = runId ? this.runs.get(runId) : void 0;
    if (!serverRun) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `model/call for unknown run "${runId || "(missing)"}" \u2014 create the run first`
        )
      );
      return;
    }
    if (!Array.isArray(params.messages) || !params.provider || !params.model) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "model/call requires provider, model, and messages"
        )
      );
      return;
    }
    if (!this.model) {
      const denied = {
        decision: "deny",
        ok: false,
        error: "no model broker is configured on this supervisor (default-deny)"
      };
      this.emit(this.successResponse(req.id, denied));
      return;
    }
    const broker = this.ensureModelBroker(serverRun);
    const sink = serverRun.modelSink;
    const beforeLen = sinkLength(sink);
    let result;
    try {
      const res = await broker.call({
        runId,
        provider: params.provider,
        model: params.model,
        messages: params.messages,
        provenanceLabel: params.provenanceLabel ?? "user",
        ...params.contextSources ? { contextSources: params.contextSources } : {}
      });
      result = {
        decision: res.decision,
        ok: res.ok,
        ...res.completion !== void 0 ? { completion: res.completion } : {},
        ...res.usage !== void 0 ? { usage: res.usage } : {},
        ...res.traceEventRef !== void 0 ? { traceEventRef: res.traceEventRef } : {},
        ...res.error !== void 0 ? { error: res.error } : {}
      };
    } catch (err) {
      result = {
        decision: "deny",
        ok: false,
        error: `model/call failed: ${String(err?.message ?? err)}`
      };
    }
    this.forwardModelTraceEvents(runId, sink, beforeLen);
    this.emit(this.successResponse(req.id, result));
  }
  /**
   * Lazily construct the run's ModelBroker. The credential is read from the
   * supervisor-side {@link ModelBrokerConfig} (closure custody inside the broker);
   * it is never stored on the ServerRun in a UI-reachable form and never traced.
   */
  ensureModelBroker(serverRun) {
    if (serverRun.modelBroker) return serverRun.modelBroker;
    const cfg = this.model;
    const sink = cfg.sinkFor?.(serverRun.created.runId) ?? new InMemoryTraceSink();
    serverRun.modelSink = sink;
    serverRun.modelBroker = new ModelBroker({
      modelPolicy: cfg.modelPolicy,
      sink,
      egress: cfg.egress,
      transport: cfg.transport,
      credentials: cfg.credentials,
      residency: resolveIndexResidency({ policy: DEFAULT_INDEX_RESIDENCY_POLICY })
    });
    return serverRun.modelBroker;
  }
  /**
   * Mirror the model trace events appended since `fromIndex` to the run/event
   * stream as M5-shaped run/event notifications. We map the broker's
   * non-secret payloads to a small, panel-friendly `detail` per event type. The
   * sink already redacted every payload; nothing secret is forwarded.
   */
  forwardModelTraceEvents(runId, sink, fromIndex) {
    const events = sinkEvents3(sink);
    for (let i = fromIndex; i < events.length; i++) {
      const e = events[i];
      this.emitRunEvent({
        runId,
        type: e.type,
        ts: e.ts,
        detail: modelEventDetail(e)
      });
    }
  }
  /* ============================================================== *
   * GOVERNED TERMINAL SESSION RPC (M7 — the in-IDE Governed Terminal)
   * ============================================================== */
  /**
   * terminal/start — open a GOVERNED TERMINAL SESSION. The supervisor:
   *   1. requires a completed handshake AND independently re-validates the §10.3
   *      run request (never trusting the client), settling the run-trust posture
   *      with the SAME gate run/create uses (approved-isolation runtime ⇒ trusted);
   *   2. creates a REAL run via the existing lifecycle (run id + dir + trace dir);
   *   3. starts the METADATA-ONLY governed egress proxy (allowlisting the configured
   *      model endpoints + any extra hosts) and PROJECTS its egress activity into
   *      the run's hash-chained trace, streaming it as the SAME run/event feed the
   *      live panel renders;
   *   4. returns { runId, proxyUrl, posture, trust } — the proxy URL the future
   *      terminal UI sets as HTTPS_PROXY/HTTP_PROXY, and the env-sanitization POSTURE
   *      the UI applies when it later spawns the CLI.
   *
   * CREDENTIAL INVARIANT (anti-FauxCode): the credential NEVER touches the
   * supervisor. The proxy is metadata-only (no TLS termination); the CLI runs on its
   * OWN auth. This RPC does NOT spawn the CLI (that is the later UI slice); the
   * posture is COMPUTED here (from cli-agent-launcher's sanitized-env path) and
   * RETURNED so the UI can apply it — no env is held server-side.
   */
  async handleTerminalStart(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "terminal/start before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const validation = validateRunRequest(params.request);
    if (!validation.ok) {
      const message = `terminal/start run request missing required field(s): ${validation.missing.join(", ")}`;
      this.logLine(`[bridge-server] ${message} \u2014 IdentityMissing.`);
      this.emit(
        this.errorResponse(req.id, BridgeErrorCode.IdentityMissing, message, {
          missing: validation.missing
        })
      );
      return;
    }
    const request = validation.request;
    const created = createRun(this.runsBaseDir);
    const lifecycle = new RunLifecycle(created.state);
    const isolation = isApprovedIsolationRuntime(request.runtimeProfile);
    const trust = "governed-unsandboxed";
    const serverRun = {
      created,
      lifecycle,
      trust,
      request,
      runtimeIsolated: isolation,
      started: true
      // a terminal session is its own driver; run/start is not used.
    };
    this.runs.set(created.runId, serverRun);
    const facts = {
      runId: created.runId,
      runDir: created.dir,
      actorType: request.actorType,
      // Binary-identity evidence (sweep-28 High), threaded ADDITIVELY from the
      // terminal/start request into run_opened + the run_created trace. Both are
      // OPTIONAL: a request without them is unchanged. Provenance on the soft path.
      ...request.actorVersion ? { actorVersion: request.actorVersion } : {},
      ...request.actorBinary ? { actorBinary: request.actorBinary } : {},
      runtimeProfile: request.runtimeProfile,
      runtimeTrust: isolation ? "trusted" : "untrusted",
      extensionPosture: request.extensionPosture,
      creationTrust: trust,
      // A governed terminal observes egress at the boundary (not per-tool hooks).
      cliFidelity: request.actorType === "native" ? "n/a" : "boundary-only"
    };
    try {
      const session = await startTerminalSession({
        facts,
        modelEndpoints: this.terminalEndpoints(),
        lifecycle,
        emit: (event) => this.emitRunEventEnvelope(event)
      });
      serverRun.terminalSession = session;
      const { posture } = buildGovernedEnvResult({
        proxyUrl: session.proxyUrl,
        baseEnv: {}
        // empty base: we only need the posture marker, never real env.
      });
      const result = {
        runId: created.runId,
        proxyUrl: session.proxyUrl,
        posture,
        trust
      };
      this.logLine(
        `[bridge-server] terminal/start \u2192 ${trust} (runId=${created.runId}, proxy=${session.proxyUrl}, posture=${posture}).`
      );
      this.emit(this.successResponse(req.id, result));
    } catch (err) {
      this.logLine(
        `[bridge-server] terminal/start failed for ${created.runId}: ${String(err?.message ?? err)}`
      );
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `terminal/start failed: ${String(err?.message ?? err)}`
        )
      );
    }
  }
  /**
   * terminal/stop — close a governed terminal session and FINALIZE the run with the
   * Ed25519-signed verifier verdict over the live trace root (the same mechanism
   * live runs use). The session's trace-health is read at close and BOUND into the
   * verdict's `assurance` (sweep-22 #45): a degraded projection yields
   * `assurance: 'degraded'` in the SIGNED verdict, so a consumer cannot present a
   * degraded session as fully trusted. Idempotent: a second stop returns the
   * already-finalized verdict.
   */
  async handleTerminalStop(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "terminal/stop before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const runId = typeof params.runId === "string" ? params.runId : "";
    const serverRun = runId ? this.runs.get(runId) : void 0;
    if (!serverRun || !serverRun.terminalSession) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `terminal/stop for unknown terminal session "${runId || "(missing)"}" \u2014 start it first`
        )
      );
      return;
    }
    try {
      const verdict = await serverRun.terminalSession.stop();
      serverRun.terminalVerdict = verdict;
      const result = { runId, verdict };
      this.logLine(
        `[bridge-server] terminal/stop \u2192 finalized ${runId} (verdict=${verdict.overallVerdict}, assurance=${verdict.assurance}).`
      );
      this.emit(this.successResponse(req.id, result));
    } catch (err) {
      this.logLine(
        `[bridge-server] terminal/stop failed for ${runId}: ${String(err?.message ?? err)}`
      );
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `terminal/stop failed: ${String(err?.message ?? err)}`
        )
      );
    }
  }
  /* ============================================================== *
   * CHAT GATEWAY RPC (M7 — conversational chat)
   * ============================================================== */
  /**
   * chat/send — drive ONE chat turn through the GlyphSpek-controlled model
   * gateway and STREAM the assistant reply back as `chat/delta` notifications.
   * The flow mirrors run/start (ack-then-notifications):
   *   1. require a completed handshake;
   *   2. validate the transcript;
   *   3. mint a turnId and RETURN it immediately as the ack;
   *   4. drive the gateway's chosen backend (default 'codex'), emitting each
   *      ChatTurnEvent (delta/done/error) as a `chat/delta` notification tagged
   *      with the turnId. The gateway emits one `model_call` trace breadcrumb per
   *      turn (here, mirrored to the run/event stream when the turn names a run).
   *
   * The ack is returned BEFORE the stream completes; the UI renders deltas as they
   * arrive and finalizes on the terminal `done`/`error` event. No credential is
   * ever held or streamed: codex authenticates from its own store; egress is the
   * governed env.
   */
  async handleChatSend(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "chat/send before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    if (!Array.isArray(params.messages) || params.messages.length === 0 || !params.messages.every(
      (m) => m && typeof m.role === "string" && typeof m.content === "string"
    )) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "chat/send requires a non-empty messages array of {role, content}"
        )
      );
      return;
    }
    const backendId = params.backendId || DEFAULT_CHAT_BACKEND_ID;
    const explicitRunId = typeof params.runId === "string" ? params.runId : void 0;
    const turnId = `chat-${++this.chatTurnSeq}`;
    const ack = { turnId };
    this.emit(this.successResponse(req.id, ack));
    try {
      let runId = explicitRunId;
      let turnEnv = this.chat?.env;
      if (!runId || !this.runs.has(runId)) {
        const governed = await this.ensureChatGovernedSession();
        if (!governed) {
          this.emitChatDelta({
            turnId,
            type: "error",
            message: "could not open a governed chat session (egress proxy + run/trace) \u2014 refusing to run an ungoverned chat turn."
          });
          return;
        }
        runId = governed.runId;
        turnEnv = this.chat?.env ?? governed.env;
      }
      const serverRun = runId ? this.runs.get(runId) : void 0;
      const cwd = serverRun?.created.dir ?? process.cwd();
      const gateway = this.ensureChatGateway();
      this.chatActiveRunId = runId;
      try {
        for await (const event of gateway.chatTurn(
          backendId,
          { messages: params.messages, cwd },
          turnEnv ? { env: turnEnv } : void 0
        )) {
          this.emitChatDelta({ turnId, ...event });
        }
      } finally {
        this.chatActiveRunId = void 0;
      }
    } catch (err) {
      this.logLine(
        `[bridge-server] chat/send turn ${turnId} failed: ${String(err?.message ?? err)}`
      );
      this.emitChatDelta({
        turnId,
        type: "error",
        message: `chat/send stream failed: ${String(err?.message ?? err)}`
      });
    }
  }
  /* ============================================================== *
   * AGENTIC BUILD RPC (Phase B — the chat→ACTOR promotion)
   * ============================================================== */
  /**
   * build/start — START a GOVERNED AGENTIC BUILD and STREAM it as `build/event`
   * notifications. A build crosses the SENSITIVE BOUNDARY (docs/developer-trust-
   * model.md): it MUTATES files and RUNS commands under `cwd` — the assistant→ACTOR
   * transition. Friction belongs at that authority boundary, so:
   *
   *   1. THE GATE. We REFUSE unless `params.approved === true`. A refused build emits
   *      ONLY a terminal `build/event {type:'error'}` whose message is honest about
   *      what the build WOULD have done (edit files + run commands in <cwd>), and NO
   *      codex is spawned. This single up-front approval IS the sensitive-boundary
   *      gate (codex runs `approval_policy="never"`, so it never pauses mid-run; the
   *      diff-accept decision is the SECOND gate, owned by the Phase B UI).
   *   2. RECORD THE GRANT. On approval we record approval_requested + approval_approved
   *      into the run's hash-chained trace BEFORE codex runs — the authority grant is
   *      auditable evidence, ordered ahead of the build.
   *   3. RUN GOVERNED. We drive {@link runGovernedAgenticBuild} (metadata-only egress
   *      proxy, hash-chained trace, signed verifier verdict; honest
   *      `governed-unsandboxed` posture — the diff is the safety net, NOT a sandbox;
   *      NO credential injected), streaming each {@link GovernedAgenticEvent} as a
   *      `build/event` tagged with the runId, then the terminal `{type:'result'}`
   *      carrying the {@link AgenticBuildReview} render contract.
   *
   * Mirrors run/start / chat/send: the RESULT is only the ACK ({ runId }); the build
   * arrives on the notification stream. Post-ack work runs in an outer try/catch so a
   * failure becomes a terminal `error` event (the UI always finalizes honestly).
   */
  async handleAgenticBuildStart(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "build/start before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    if (prompt.trim().length === 0 || cwd.trim().length === 0) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "build/start requires a non-empty prompt and an absolute cwd"
        )
      );
      return;
    }
    const runId = params.runId && typeof params.runId === "string" ? params.runId : `build-${++this.buildSeq}`;
    const ack = { runId };
    this.emit(this.successResponse(req.id, ack));
    if (params.approved === true) {
      await this.runApprovedBuild(runId, prompt, cwd);
      return;
    }
    if (params.pendingApproval === true) {
      const approvalId = `apr-${runId}`;
      const pendingRun = createRun(this.agentic?.runsBaseDir ?? this.runsBaseDir);
      const pendingTracePath = join8(runSubdirPath(pendingRun.dir, "trace"), "trace.jsonl");
      this.remoteTracePaths.set(runId, pendingTracePath);
      this.pendingBuilds.set(approvalId, {
        approvalId,
        runId,
        prompt,
        cwd,
        runDir: pendingRun.dir,
        tracePath: pendingTracePath
      });
      this.logLine(
        `[bridge-server] build/start ${runId} PENDING approval ${approvalId} (cwd=${cwd}).`
      );
      this.emitAgenticBuildEvent({ runId, type: "state", state: `pending_approval:${approvalId}` });
      return;
    }
    this.logLine(
      `[bridge-server] build/start ${runId} REFUSED \u2014 no authority approval (cwd=${cwd}).`
    );
    this.emitAgenticBuildEvent({
      runId,
      type: "error",
      message: `agentic build requires explicit authority approval (it may edit files and run commands in ${cwd})`
    });
  }
  /**
   * Run a GOVERNED AGENTIC BUILD that has been AUTHORIZED (`approved:true`, either
   * up-front or via an `approval/respond` ALLOW of a pending build). This is the
   * extracted approved path of `build/start`: record the authority grant into the
   * run's ONE hash-chained trace, then drive {@link runGovernedAgenticBuild} under an
   * AbortController so `run/cancel` can SIGKILL the `codex exec` child. Everything
   * runs in an outer try/catch so a failure becomes a terminal `error` event.
   */
  async runApprovedBuild(runId, prompt, cwd, existing) {
    const abort = new AbortController();
    try {
      const buildRun = existing ? { runId, dir: existing.runDir, state: "created" } : createRun(this.agentic?.runsBaseDir ?? this.runsBaseDir);
      const tracePath = existing ? existing.tracePath : join8(runSubdirPath(buildRun.dir, "trace"), "trace.jsonl");
      const sink = this.remoteTraceWriters.get(runId) ?? createTraceWriter(tracePath);
      this.remoteTraceWriters.set(runId, sink);
      this.remoteTracePaths.set(runId, tracePath);
      const buildLifecycle = new RunLifecycle(buildRun.state);
      const buildServerRun = {
        created: buildRun,
        lifecycle: buildLifecycle,
        trust: "governed-unsandboxed",
        request: {
          actorType: "codex-cli",
          autonomyTier: "allowlist",
          policyPath: "",
          policyHash: "",
          workspaceRoot: cwd,
          runtimeProfile: "local-exec",
          extensionPosture: "sovereign",
          worktreeBase: cwd
        },
        runtimeIsolated: false,
        started: true,
        buildAbort: abort
      };
      this.runs.set(runId, buildServerRun);
      const approvalId = `apr-${runId}`;
      const requested = {
        approvalId,
        tool: "command",
        requestedCapability: "agentic-build:workspace-write",
        decision: "force_ask"
      };
      sink.append({
        v: TRACE_EVENT_VERSION,
        runId,
        seq: 0,
        ts: Date.now(),
        type: "approval_requested",
        payload: requested,
        source: "human"
      });
      const approved = {
        approvalId,
        note: "up-front authority grant for governed agentic build (sensitive boundary)"
      };
      sink.append({
        v: TRACE_EVENT_VERSION,
        runId,
        seq: 0,
        ts: Date.now(),
        type: "approval_approved",
        payload: approved,
        source: "human"
      });
      this.emitAgenticBuildEvent({ runId, type: "state", state: "approved" });
      const codexPath = this.agentic?.codexPath ?? resolveOnPath("codex") ?? "";
      let verifyCommand = this.agentic?.verifyCommand;
      let verifyCommandSource = verifyCommand ? "override" : "none";
      if (!verifyCommand) {
        const resolved = resolveVerifyCommand(cwd);
        verifyCommandSource = resolved.source;
        if (resolved.command) {
          verifyCommand = resolved.command;
          this.logLine(
            `[bridge-server] [build ${runId}] verify check: ${resolved.label} (source=${resolved.source}).`
          );
        } else {
          this.logLine(
            `[bridge-server] [build ${runId}] NO build/test check resolved (source=${resolved.source}); verdict will be labeled NOT-independently-verified.` + (resolved.note ? ` ${resolved.note}` : "")
          );
        }
      }
      const runner = this.agentic?.runner ?? runGovernedAgenticBuild;
      const result = await runner({
        prompt,
        cwd,
        codexPath,
        // Bind the runner to OUR run (sweep-45 High): one runId end-to-end, ONE trace
        // chain (the approval grant already appended above + the build's events + the
        // signed verdict), and a verdict bound to the REAL accumulated trace root —
        // never a second run id, never GENESIS.
        existingRun: { runId, tracePath, sink },
        // CANCELLATION: thread the run's AbortController signal so run/cancel SIGKILLs
        // the `codex exec` child (runAgenticBuild listens for abort) and the build
        // finalizes honestly rather than hanging.
        signal: abort.signal,
        ...this.agentic?.runsBaseDir ? { runsBaseDir: this.agentic.runsBaseDir } : this.runsBaseDir ? { runsBaseDir: this.runsBaseDir } : {},
        ...verifyCommand ? { verifyCommand, verifyCommandSource } : {},
        ...this.agentic?.denyDirectIp !== void 0 ? { denyDirectIp: this.agentic.denyDirectIp } : {},
        // Stream each governed-run event out as a build/event tagged with our runId.
        emit: (event) => this.streamGovernedAgenticEvent(runId, event),
        onOperatorLog: (line) => this.logLine(`[bridge-server] [build ${runId}] ${line}`)
      });
      if (this.runs.get(runId)?.buildTerminal === true) {
        this.logLine(`[bridge-server] build/start ${runId} was cancelled mid-flight; suppressing result.`);
        return;
      }
      const review = projectAgenticBuildReview(runId, prompt, result);
      this.markRunTerminal(runId, "completed");
      this.emitAgenticBuildEvent({ runId, type: "result", review });
      this.logLine(
        `[bridge-server] build/start ${runId} \u2192 ${review.verdict.overall} (${review.changedFiles.length} changed file(s), ${review.commands.length} command(s)).`
      );
    } catch (err) {
      if (this.runs.get(runId)?.buildTerminal === true) {
        this.logLine(`[bridge-server] build/start ${runId} threw after cancel; suppressing error.`);
        return;
      }
      this.markRunTerminal(runId, "failed");
      this.logLine(
        `[bridge-server] build/start ${runId} failed: ${String(err?.message ?? err)}`
      );
      this.emitAgenticBuildEvent({
        runId,
        type: "error",
        message: `agentic build failed: ${String(err?.message ?? err)}`
      });
    }
  }
  /**
   * Mark a build run terminal: flip `buildTerminal`, clear its AbortController, and
   * best-effort transition the run's lifecycle to the terminal state (legal from any
   * non-terminal state). Idempotent — a second call (e.g. cancel racing completion)
   * is a no-op once terminal.
   */
  markRunTerminal(runId, to) {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.buildTerminal === true) return;
    run.buildTerminal = true;
    run.buildAbort = void 0;
    try {
      if (!run.lifecycle.isTerminal && run.lifecycle.canTransitionTo(to)) {
        run.lifecycle.transition(to, `build ${to}`);
      } else if (!run.lifecycle.isTerminal) {
        if (run.lifecycle.canTransitionTo("executing")) {
          run.lifecycle.transition("executing", "build executing (finalize)");
        }
        if (run.lifecycle.canTransitionTo(to)) run.lifecycle.transition(to, `build ${to}`);
      }
    } catch {
    }
  }
  /**
   * run/cancel — ABORT an in-flight run (remote-control). The supervisor signals the
   * run's AbortController (SIGKILLing the agentic build's `codex exec` child via
   * runAgenticBuild's abort listener), transitions the lifecycle to the terminal
   * `aborted` state, and emits the terminal `build/event {state:'aborted'}`. Idempotent:
   * an unknown or already-terminal run is acknowledged with `cancelled:false` rather
   * than erroring. The result is the ACK only; the run's terminal events stream.
   */
  handleRunCancel(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(req.id, BridgeErrorCode.InvalidRequest, "run/cancel before a completed handshake")
      );
      return;
    }
    const params = req.params ?? {};
    const runId = typeof params.runId === "string" ? params.runId : "";
    if (runId.trim().length === 0) {
      this.emit(
        this.errorResponse(req.id, BridgeErrorCode.InvalidRequest, "run/cancel requires a non-empty runId")
      );
      return;
    }
    const run = this.runs.get(runId);
    if (!run || run.buildTerminal === true || run.buildAbort === void 0) {
      this.emit(this.successResponse(req.id, { runId, cancelled: false }));
      return;
    }
    const controller = run.buildAbort;
    this.markRunTerminal(runId, "aborted");
    try {
      controller.abort();
    } catch {
    }
    this.emitAgenticBuildEvent({ runId, type: "state", state: "aborted" });
    this.emitAgenticBuildEvent({ runId, type: "error", message: "run cancelled by operator" });
    this.logLine(`[bridge-server] run/cancel ${runId} \u2192 aborted.`);
    this.emit(this.successResponse(req.id, { runId, cancelled: true }));
  }
  /**
   * REMOTE-ACTION TRACE RECORDER (trace-integrity High A). Append ONE remote human
   * action (mobile approval, coding message, diff accept/reject) into the TARGET RUN's
   * REAL hash-chained trace — never a display-only breadcrumb, never a no-op. This is
   * the production seam the gateway's `appendTrace` dep routes into: the supervisor (not
   * the gateway) owns the canonical chain, so the supervisor resolves the action's
   * subject id to the target runId and appends to THAT run's `TraceWriter`.
   *
   * ID RESOLUTION: the gateway keys remote_* events to the action's subject — an
   * approvalId (`apr-<runId>`), a diff reviewId (`rev-<runId>`), or a runId/sessionId.
   * We strip the `apr-`/`rev-` prefix to recover the target runId; an already-runId
   * subject passes through. The recorded event's `runId` is REWRITTEN to that target so
   * `remote_*` provenance shares the target run id (the finding's core defect), and
   * `source` is forced to `'human'` (a remote operator is a human reviewer, never the
   * supervisor/verifier).
   *
   * APPEND-ONLY: we reuse (or lazily create) the run's ONE `TraceWriter` so the chain
   * head stays continuous and history is never rewritten. When the run dir is unknown
   * (no pending build, no build yet) we still mint a trace file under the runsBaseDir so
   * the human action is tamper-evident rather than dropped.
   */
  recordRemoteAction(evt) {
    const targetRunId = this.resolveRemoteTargetRunId(evt);
    const sink = this.remoteTraceWriterFor(targetRunId);
    sink.append({
      ...evt,
      runId: targetRunId,
      source: "human"
    });
    this.logLine(
      `[bridge-server] recorded remote ${evt.type} into run ${targetRunId} trace (source=human).`
    );
  }
  /**
   * Resolve a remote action's subject id to the TARGET run id. `apr-<runId>` (approval)
   * and `rev-<runId>` (diff review) both embed the run id; anything else is treated as a
   * runId/sessionId already. We prefer the embedded id over the event's own `runId`
   * field because the gateway historically stamped the subject id (approval/review id)
   * INTO `runId` — that mis-keying is exactly what this finding fixes.
   */
  resolveRemoteTargetRunId(evt) {
    const payload = evt.payload ?? {};
    const strip = (id) => {
      if (id.startsWith("apr-")) return id.slice("apr-".length);
      if (id.startsWith("rev-")) return id.slice("rev-".length);
      return id;
    };
    if (typeof payload.runId === "string" && payload.runId.length > 0) {
      return strip(payload.runId);
    }
    if (typeof evt.runId === "string" && (evt.runId.startsWith("apr-") || evt.runId.startsWith("rev-"))) {
      return strip(evt.runId);
    }
    if (typeof payload.subjectId === "string" && (payload.subjectId.startsWith("apr-") || payload.subjectId.startsWith("rev-"))) {
      return strip(payload.subjectId);
    }
    return strip(evt.runId);
  }
  /**
   * The ONE hash-chained `TraceWriter` for a target run, created lazily and memoized so
   * every remote action (and the build's own events, which register the SAME sink in
   * `runApprovedBuild`) chains into one append-only file. When no run dir is known yet,
   * mint one under the runsBaseDir so the action is still recorded (never dropped).
   */
  remoteTraceWriterFor(runId) {
    const existing = this.remoteTraceWriters.get(runId);
    if (existing) return existing;
    let tracePath = this.remoteTracePaths.get(runId);
    if (!tracePath) {
      const created = createRun(this.agentic?.runsBaseDir ?? this.runsBaseDir);
      tracePath = join8(runSubdirPath(created.dir, "trace"), "trace.jsonl");
      this.remoteTracePaths.set(runId, tracePath);
    }
    const writer = createTraceWriter(tracePath);
    this.remoteTraceWriters.set(runId, writer);
    return writer;
  }
  /**
   * Read back a run's canonical hash-chained trace events (test/inspection helper).
   * Resolves the run's trace file from the recorder's path map and returns the parsed
   * events; returns [] when the run has no trace file yet.
   */
  readRunTrace(runId) {
    const tracePath = this.remoteTracePaths.get(runId);
    if (!tracePath) return [];
    return readTrace(tracePath);
  }
  /**
   * approval/respond — resolve a PENDING governed-build approval (remote-control). On
   * `allow`, GRANT the held build's authority and start it down the SAME approved path
   * (`runApprovedBuild`) — governed codex edits files + the signed verdict streams. On
   * `deny`, DISCARD the pending build (terminal `build/event` error, codex NOT spawned).
   * Idempotent: an unknown approvalId is acknowledged with `resolved:false`.
   */
  handleApprovalRespond(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(req.id, BridgeErrorCode.InvalidRequest, "approval/respond before a completed handshake")
      );
      return;
    }
    const params = req.params ?? {};
    const approvalId = typeof params.approvalId === "string" ? params.approvalId : "";
    const decision = params.decision === "allow" || params.decision === "deny" ? params.decision : void 0;
    if (approvalId.trim().length === 0 || decision === void 0) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "approval/respond requires an approvalId and decision allow|deny"
        )
      );
      return;
    }
    const pending = this.pendingBuilds.get(approvalId);
    if (!pending) {
      this.emit(
        this.successResponse(req.id, { approvalId, decision, resolved: false })
      );
      return;
    }
    this.pendingBuilds.delete(approvalId);
    if (decision === "deny") {
      this.logLine(`[bridge-server] approval/respond ${approvalId} DENIED \u2014 discarding build ${pending.runId}.`);
      this.emitAgenticBuildEvent({
        runId: pending.runId,
        type: "error",
        message: "agentic build authority denied by operator"
      });
      this.emit(
        this.successResponse(req.id, {
          approvalId,
          decision,
          runId: pending.runId,
          resolved: true
        })
      );
      return;
    }
    this.logLine(`[bridge-server] approval/respond ${approvalId} ALLOWED \u2014 starting build ${pending.runId}.`);
    this.emit(
      this.successResponse(req.id, {
        approvalId,
        decision,
        runId: pending.runId,
        resolved: true
      })
    );
    void this.runApprovedBuild(pending.runId, pending.prompt, pending.cwd, {
      runDir: pending.runDir,
      tracePath: pending.tracePath
    });
  }
  /**
   * Map ONE {@link GovernedAgenticEvent} from the runner onto the build/event wire
   * stream tagged with `runId`. Lifecycle markers → `state`; the wrapped agentic
   * progress events → `summary`/`command`/`fileChange`. The terminal `result` is NOT
   * emitted here — it is built from the runner's authoritative return value (so it
   * carries git's ground-truth diff + the signed verdict), in the handler above.
   */
  streamGovernedAgenticEvent(runId, event) {
    switch (event.type) {
      case "run_created":
        this.emitAgenticBuildEvent({ runId, type: "state", state: `run_created:${event.posture}` });
        return;
      case "state":
        this.emitAgenticBuildEvent({ runId, type: "state", state: event.to });
        return;
      case "agentic": {
        const inner = event.event;
        if (inner.type === "summary_delta") {
          this.emitAgenticBuildEvent({ runId, type: "summary", textDelta: inner.text });
        } else if (inner.type === "command") {
          this.emitAgenticBuildEvent({
            runId,
            type: "command",
            cmd: inner.cmd,
            phase: inner.phase,
            ...inner.exitCode !== void 0 ? { exitCode: inner.exitCode } : {}
          });
        } else if (inner.type === "file_change") {
          this.emitAgenticBuildEvent({ runId, type: "fileChange", path: inner.path, status: inner.kind });
        }
        return;
      }
      case "run_closed":
        this.emitAgenticBuildEvent({ runId, type: "state", state: event.ok ? "closed:ok" : "closed:failed" });
        return;
      // 'verdict' is carried by the terminal result.review.verdict — not streamed
      // separately to avoid a second verdict surface on the wire.
      default:
        return;
    }
  }
  /** Emit one build/event notification (no id) carrying an {@link AgenticBuildStreamEvent}. */
  emitAgenticBuildEvent(event) {
    const note = {
      glyphspek: BRIDGE_JSONRPC,
      method: BridgeNotification.AgenticBuildEvent,
      params: event
    };
    this.emit(note);
  }
  /**
   * Lazily create (and reuse) the GOVERNED CHAT SESSION (Finding 1): a real
   * supervisor-owned run + metadata-only egress proxy + hash-chained trace, reusing
   * the EXACT M7 governed-terminal machinery (startTerminalSession) rather than a
   * parallel path. The session is created ONCE per connection and reused across turns.
   *
   * What it establishes for every chat turn bound to it:
   *   - a real run (created via the lifecycle) whose trace the proxy projects into;
   *   - a supervisor-owned governed proxy URL → the governed env (HTTPS_PROXY/
   *     HTTP_PROXY = proxyUrl, ambient secrets stripped via buildGovernedEnvResult)
   *     the codex backend runs under, so codex egress is BROKERED;
   *   - CODEX BINARY IDENTITY (absolute path + sha256 + version), captured before
   *     launch (TOCTOU) and threaded into run_opened + the trace as evidence.
   *
   * The session settles into the honest `governed-unsandboxed` posture (governed +
   * traced, SOFT boundary, UNSANDBOXED — never product-trusted). Resolve-never-reject:
   * a failure resolves `undefined` and the caller errors the turn honestly.
   */
  ensureChatGovernedSession() {
    if (this.chatGovernedSession) return Promise.resolve(this.chatGovernedSession);
    if (this.chatSessionPromise) return this.chatSessionPromise;
    this.chatSessionPromise = (async () => {
      try {
        const codexPath = resolveOnPath("codex");
        const actorBinary = codexPath ? captureCodexBinaryIdentity(codexPath) : void 0;
        this.codexLaunch = { codexPath, ...actorBinary ? { actorBinary } : {} };
        const created = createRun(this.runsBaseDir);
        const lifecycle = new RunLifecycle(created.state);
        const trust = "governed-unsandboxed";
        const serverRun = {
          created,
          lifecycle,
          trust,
          // A minimal §10.3-shaped record for the retained run (codex CLI, local-exec).
          request: {
            actorType: "codex-cli",
            autonomyTier: "allowlist",
            policyPath: "",
            policyHash: "",
            workspaceRoot: created.dir,
            runtimeProfile: "local-exec",
            extensionPosture: "sovereign",
            worktreeBase: created.dir,
            ...actorBinary ? { actorBinary } : {}
          },
          runtimeIsolated: false,
          started: true
        };
        this.runs.set(created.runId, serverRun);
        const facts = {
          runId: created.runId,
          runDir: created.dir,
          actorType: "codex-cli",
          ...actorBinary?.version ? { actorVersion: actorBinary.version } : {},
          ...actorBinary ? { actorBinary } : {},
          runtimeProfile: "local-exec",
          runtimeTrust: "untrusted",
          extensionPosture: "sovereign",
          creationTrust: trust,
          cliFidelity: "boundary-only"
        };
        const session = await startTerminalSession({
          facts,
          modelEndpoints: this.terminalEndpoints(),
          lifecycle,
          emit: (event) => this.emitRunEventEnvelope(event)
        });
        serverRun.terminalSession = session;
        const { env } = buildGovernedEnvResult({ proxyUrl: session.proxyUrl });
        this.logLine(
          `[bridge-server] chat/send \u2192 governed chat session ${created.runId} (proxy=${session.proxyUrl}, trust=${trust}${actorBinary ? `, codex=${actorBinary.path}` : ""}).`
        );
        this.chatGovernedSession = { runId: created.runId, proxyUrl: session.proxyUrl, env, session };
        return this.chatGovernedSession;
      } catch (err) {
        this.logLine(
          `[bridge-server] chat/send governed session failed: ${String(err?.message ?? err)}`
        );
        return void 0;
      } finally {
        this.chatSessionPromise = void 0;
      }
    })();
    return this.chatSessionPromise;
  }
  /**
   * Lazily construct the chat {@link ModelGateway} for this connection. The
   * gateway holds the configured chat backend (default {@link CodexChatBackend})
   * and a trace seam that records each turn's `model_call` breadcrumb — mirrored to
   * the run/event stream when `runId` names a created run so the panel sees the
   * call exactly like the model broker's model_call events. No credential is held.
   */
  ensureChatGateway() {
    if (!this.chatGateway) {
      const trace = {
        modelCall: (meta) => {
          const runId = this.chatActiveRunId;
          if (!runId || !this.runs.has(runId)) return;
          this.emitRunEvent({
            runId,
            type: "model_call",
            ts: Date.now(),
            detail: {
              backendId: meta.backendId,
              ...meta.model ? { model: meta.model } : {},
              messageCount: meta.messageCount,
              outcome: meta.outcome,
              durationMs: meta.durationMs,
              ...typeof meta.inputTokens === "number" ? { inputTokens: meta.inputTokens } : {},
              ...typeof meta.outputTokens === "number" ? { outputTokens: meta.outputTokens } : {}
            }
          });
        }
      };
      const backend = this.chat?.backend ?? createProductionCodexBackend(
        this.codexLaunch?.codexPath,
        (line) => this.logLine(`[bridge-server] [codex-stderr] ${line}`)
      );
      this.chatGateway = new ModelGateway({ trace }).register(backend);
    }
    return this.chatGateway;
  }
  /** Emit one chat/delta notification (no id) carrying a {@link ChatStreamEvent}. */
  emitChatDelta(event) {
    const note = {
      glyphspek: BRIDGE_JSONRPC,
      method: BridgeNotification.ChatDelta,
      params: event
    };
    this.emit(note);
  }
  /**
   * Emit a run/event notification (no id) for the M5 live Trust Panel feed. The
   * shape is stubbed (a trace-event-shaped tag + non-secret detail); the live
   * wiring that streams real lifecycle/trace events is M5 work. Provided so the
   * notification grammar is exercised and the client's notification path has a
   * concrete producer to test against.
   */
  emitRunEvent(params) {
    const note = {
      glyphspek: BRIDGE_JSONRPC,
      method: BridgeNotification.RunEvent,
      params
    };
    this.emit(note);
  }
  /**
   * Emit one M5 live `run/event` envelope (the runEventProtocol grammar) produced
   * by the scripted run driver. The envelope IS the notification's `params`, so the
   * client's notification path delivers it straight to the panel's validateRunEvent
   * gate. Each envelope carries its own `rev`; the client fail-closes on a mismatch.
   */
  emitRunEventEnvelope(event) {
    const note = {
      glyphspek: BRIDGE_JSONRPC,
      method: BridgeNotification.RunEvent,
      params: event
    };
    this.emit(note);
  }
  /** Serialize one envelope to a single stdout line (the ONLY stdout writer). */
  emit(message) {
    this.writeLine(JSON.stringify(message));
  }
  successResponse(id, result) {
    return { glyphspek: BRIDGE_JSONRPC, id, result };
  }
  errorResponse(id, code, message, data) {
    return {
      glyphspek: BRIDGE_JSONRPC,
      id,
      error: { code, message, ...data !== void 0 ? { data } : {} }
    };
  }
};
function serveStdio(proc, options = {}) {
  const server2 = new BridgeServer({
    ...options,
    writeLine: (line) => proc.stdout.write(`${line}
`),
    logLine: (line) => proc.stderr.write(`${line}
`)
  });
  proc.stdin.on("data", (chunk) => server2.ingest(chunk));
  return server2;
}

// ../spikes/p0-supervisor/bridge-server-cli.ts
var supervisorVersion = process.env.GLYPHSPEK_SUPERVISOR_VERSION;
var runsBaseDir = process.env.GLYPHSPEK_RUNS_BASE;
var server = serveStdio(process, {
  ...supervisorVersion ? { supervisorVersion } : {},
  ...runsBaseDir ? { runsBaseDir } : {}
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.exit(0);
});
process.stderr.write("[bridge-server-cli] supervisor bridge ready on stdio.\n");
