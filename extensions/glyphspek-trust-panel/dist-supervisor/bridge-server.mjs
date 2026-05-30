// ../spikes/p0-supervisor/bridge-server.ts
import { createHash as createHash3 } from "node:crypto";
import { readFileSync as readFileSync3 } from "node:fs";

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

// ../spikes/p0-contracts/trace.ts
var TRACE_EVENT_VERSION = 1;

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
  ModelCall: "model/call"
};
var BridgeNotification = {
  /** A run lifecycle/trace event streamed back to the client for the panel. */
  RunEvent: "run/event"
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
function isPlainObject(value) {
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
  if (isPlainObject(value)) {
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
function readTrace(path2) {
  if (!existsSync(path2)) return [];
  const raw = readFileSync(path2, "utf8");
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
        `readTrace: invalid JSON on line ${i + 1} of ${path2}: ${err.message}`
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
      const path2 = readPath(request.payload);
      if (path2 !== void 0) {
        if (anyGlobMatch(policy.deny.read_paths, path2)) return "deny";
        if (anyGlobMatch(policy.allow.read_paths, path2)) return "allow";
      }
      return verbToDecision(policy.defaults.file_read);
    }
    case "file_write": {
      const path2 = readPath(request.payload);
      if (path2 !== void 0) {
        if (anyGlobMatch(policy.deny.write_paths, path2)) return "deny";
        if (anyGlobMatch(policy.allow.write_paths, path2)) return "allow";
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
  const path2 = sink.path;
  if (typeof path2 === "string") return readTrace(path2);
  return [];
}
function signEphemeral(checks, overallVerdict, traceRootHash, injectedKey) {
  const privateKey = injectedKey ?? generateKeyPairSync2("ed25519").privateKey;
  return signVerdict({ checks, overallVerdict, traceRootHash }, privateKey);
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
    actual = createHash3("sha256").update(readFileSync3(selfPath)).digest("hex");
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
function sinkEvents2(sink) {
  const maybe = sink.events;
  return Array.isArray(maybe) ? maybe : [];
}
function sinkLength(sink) {
  return sinkEvents2(sink).length;
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
var DEFAULT_SUPERVISOR_VERSION = "0.0.0-p0";
var BridgeServer = class {
  supervisorVersion;
  runsBaseDir;
  writeLine;
  logLine;
  selfPath;
  pinnedSha;
  model;
  stdinBuffer = "";
  handshakeDone = false;
  hashChecked = false;
  /** Created runs, keyed by runId (retained for run/event emission). */
  runs = /* @__PURE__ */ new Map();
  constructor(opts) {
    this.supervisorVersion = opts.supervisorVersion ?? DEFAULT_SUPERVISOR_VERSION;
    this.runsBaseDir = opts.runsBaseDir;
    this.writeLine = opts.writeLine;
    this.logLine = opts.logLine ?? (() => {
    });
    this.selfPath = opts.selfPath;
    this.pinnedSha = opts.pinnedSha;
    this.model = opts.model;
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
      creationTrust: serverRun.trust === "trusted" || serverRun.trust === "untrusted" ? serverRun.trust : "refused",
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
    const events = sinkEvents2(sink);
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
