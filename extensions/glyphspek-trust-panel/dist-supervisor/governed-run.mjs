// ../spikes/p0-supervisor/governed-run-cli.ts
import { mkdirSync as mkdirSync6 } from "node:fs";
import * as os from "node:os";
import * as path6 from "node:path";

// ../spikes/p0-sandbox/docker-runtime.ts
import { spawn, spawnSync } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";

// ../spikes/p0-sandbox/egress-proxy.ts
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
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
  const server = createServer();
  server.on("request", (clientReq, clientRes) => {
    const target = targetForHttp(clientReq);
    if (!target) {
      emit({
        id: randomUUID(),
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
          id: randomUUID(),
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
      id: randomUUID(),
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
  server.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", () => {
    });
    const authority = req.url ?? "";
    const { host, port } = splitHostPort(authority);
    const targetPort = port ?? DEFAULT_HTTPS_PORT;
    if (!observeAll) {
      if (denyDirectIp && host.length > 0 && isIpLiteral(host)) {
        emit({
          id: randomUUID(),
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
      id: randomUUID(),
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
    const tunnelId = randomUUID();
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
  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  return new Promise((resolve3, reject) => {
    server.once("error", reject);
    server.listen(bindPort, bindHost, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("egress proxy: failed to resolve bound address"));
        return;
      }
      const port = addr.port;
      const proxyHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
      resolve3({
        port,
        url: `http://${proxyHost}:${port}`,
        proxyHost,
        observerHealth() {
          return { ...health };
        },
        close() {
          return new Promise((res) => {
            server.close(() => res());
            const anyServer = server;
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

// ../spikes/p0-sandbox/docker-runtime.ts
var WORKDIR_MOUNT = "/workspace";
var HOME_MOUNT = "/home/agent";
var DEFAULT_IMAGE = process.env.GLYPHSPEK_SANDBOX_IMAGE ?? "node:22-alpine";
var KEEPALIVE_SECONDS = 86400;
var TIMEOUT_EXIT_CODE = 124;
var SPAWN_FAIL_EXIT_CODE = 1;
function dockerAvailable() {
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
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
  return new Promise((resolve3) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
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
      resolve3(result);
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
        id: randomUUID2(),
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

// ../spikes/p0-sandbox/worktree.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
function createWorktree(repoPath, runId, intoDir) {
  void runId;
  fs.mkdirSync(path.dirname(intoDir), { recursive: true });
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
  const home = path.join(baseDir, "home");
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

// ../spikes/p0-trace/trace-store.ts
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, existsSync, mkdirSync as mkdirSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";

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
function validateDefaultVerb(value, path7, errors) {
  if (typeof value !== "string" || !POLICY_DEFAULT_VERBS.includes(value)) {
    errors.push(
      `${path7} must be one of ${POLICY_DEFAULT_VERBS.join(" | ")}, got ${describe(value)}`
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
  const dir = dirname2(traceFilePath);
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
function readTrace(path7) {
  if (!existsSync(path7)) return [];
  const raw = readFileSync(path7, "utf8");
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
        `readTrace: invalid JSON on line ${i + 1} of ${path7}: ${err.message}`
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

// ../spikes/p0-verifier/verifier.ts
import { cpSync, existsSync as existsSync2, readdirSync, rmSync as rmSync2, statSync } from "node:fs";
import * as path3 from "node:path";

// ../spikes/p0-supervisor/policy/load.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { extname } from "node:path";
function loadPolicy(path7) {
  const ext = extname(path7).toLowerCase();
  if (ext === ".yml" || ext === ".yaml") {
    throw new Error(`P0 uses JSON policy; convert ${path7}`);
  }
  let text;
  try {
    text = readFileSync2(path7, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { errors: [`could not read policy file ${path7}: ${reason}`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { errors: [`policy file ${path7} is not valid JSON: ${reason}`] };
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
      const path7 = readPath(request.payload);
      if (path7 !== void 0) {
        if (anyGlobMatch(policy.deny.read_paths, path7)) return "deny";
        if (anyGlobMatch(policy.allow.read_paths, path7)) return "allow";
      }
      return verbToDecision(policy.defaults.file_read);
    }
    case "file_write": {
      const path7 = readPath(request.payload);
      if (path7 !== void 0) {
        if (anyGlobMatch(policy.deny.write_paths, path7)) return "deny";
        if (anyGlobMatch(policy.allow.write_paths, path7)) return "allow";
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

// ../spikes/p0-supervisor/run.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdirSync as mkdirSync3 } from "node:fs";
import * as path2 from "node:path";
import { fileURLToPath } from "node:url";
var PKG_ROOT = path2.join(fileURLToPath(new URL(".", import.meta.url)), "..");
var DEFAULT_RUNS_BASE_DIR = path2.join(PKG_ROOT, ".runs");
var RUN_SUBDIRS = ["trace", "diff", "verdict", "logs"];
function newRunId() {
  const tsPrefix = Date.now().toString(36).padStart(9, "0");
  return `${tsPrefix}-${randomUUID3()}`;
}
function createRun(baseDir = DEFAULT_RUNS_BASE_DIR) {
  const runId = newRunId();
  const dir = path2.join(baseDir, runId);
  for (const sub of RUN_SUBDIRS) {
    mkdirSync3(path2.join(dir, sub), { recursive: true });
  }
  return { runId, dir, state: "created" };
}
function runSubdirPath(runDir, sub) {
  return path2.join(runDir, sub);
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
function verifyVerdictSignature(verdict, publicKey) {
  const sig = verdict.signature;
  if (!sig || sig.alg !== SIGNATURE_ALG || typeof sig.value !== "string") {
    return false;
  }
  const { signature: _ignored, ...core } = verdict;
  void _ignored;
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(sig.value, "base64");
  } catch {
    return false;
  }
  try {
    return cryptoVerify(null, verdictMessage(core), publicKey, signatureBytes);
  } catch {
    return false;
  }
}

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
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      if (existsSync2(destPath) && !statSync(destPath).isDirectory()) {
        rmSync2(destPath, { force: true });
      }
      cpSync(srcPath, destPath, { recursive: true, force: true });
      mirrorDir(srcPath, destPath, /* @__PURE__ */ new Set());
    } else {
      if (existsSync2(destPath) && statSync(destPath).isDirectory()) {
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

// ../spikes/p0-supervisor/bundle.ts
import { cpSync as cpSync2, mkdirSync as mkdirSync4, readFileSync as readFileSync3, writeFileSync } from "node:fs";
import * as path4 from "node:path";
import {
  createHash as createHash3,
  createPrivateKey,
  createPublicKey as createPublicKey2
} from "node:crypto";
function keyIdForPublicKey2(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return createHash3("sha256").update(spki).digest("hex").slice(0, 16);
}
function resolveVerifierKeypair(verifierKeyPath) {
  if (verifierKeyPath === void 0) {
    return generateVerifierKeypair();
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync3(verifierKeyPath, "utf8"));
  } catch (err) {
    throw new Error(
      `bundle: failed to load verifier private key from ${verifierKeyPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const publicKey = createPublicKey2(privateKey);
  return { privateKey, publicKey, keyId: keyIdForPublicKey2(publicKey) };
}
function writeVerifiedBundle(input) {
  const { outDir, tracePath, verdict, publicKey, actorClaim, readme } = input;
  mkdirSync4(outDir, { recursive: true });
  cpSync2(tracePath, path4.join(outDir, "trace.jsonl"), { force: true });
  writeFileSync(
    path4.join(outDir, "verdict.json"),
    JSON.stringify(verdict, null, 2) + "\n",
    "utf8"
  );
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(path4.join(outDir, "verifier-public-key.pem"), publicKeyPem, "utf8");
  writeFileSync(
    path4.join(outDir, "actor-claims.json"),
    JSON.stringify(actorClaim, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(path4.join(outDir, "README.md"), readme, "utf8");
}

// ../spikes/p0-supervisor/autonomous-capstone.ts
import * as path5 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// ../spikes/p0-supervisor/agent-loop.ts
import { join as join5 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// ../spikes/p0-supervisor/file-broker.ts
import { readFileSync as readFileSync4, writeFileSync as writeFileSync2, mkdirSync as mkdirSync5, existsSync as existsSync3 } from "node:fs";
import { resolve, relative, dirname as dirname3, isAbsolute } from "node:path";
function createFileBroker(opts) {
  const { policy, sink, runId } = opts;
  const root = resolve(opts.worktreeDir);
  const emit = (type, payload) => {
    sink.append({ v: TRACE_EVENT_VERSION, runId, seq: 0, ts: Date.now(), type, payload });
  };
  const within = (relPath) => {
    const abs = resolve(root, relPath);
    const rel = relative(root, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return void 0;
    return abs;
  };
  const broker = (tool, relPath, provenanceLabel, act) => {
    const request = {
      runId,
      tool,
      payload: { path: relPath },
      provenanceLabel,
      requestedCapability: `${tool}:${relPath}`
    };
    const decision = decide(policy, request);
    emit("policy_decision", {
      tool,
      requestedCapability: request.requestedCapability,
      decision,
      provenanceLabel,
      path: relPath
    });
    if (decision !== "allow") {
      emit("tool_end", { tool, provenanceLabel, blocked: true, decision });
      return { decision, ok: false, error: `policy decision: ${decision}` };
    }
    const abs = within(relPath);
    if (abs === void 0) {
      emit("tool_end", { tool, provenanceLabel, blocked: true, decision, reason: "path escapes worktree" });
      return { decision, ok: false, error: "path escapes worktree" };
    }
    emit("tool_start", { tool, requestedCapability: request.requestedCapability, provenanceLabel });
    try {
      const content = act(abs);
      emit("tool_end", {
        tool,
        provenanceLabel,
        ok: true,
        ...content !== void 0 ? { contentLength: content.length } : {}
      });
      return { decision, ok: true, content };
    } catch (err) {
      const message = String(err.message ?? err);
      emit("tool_end", { tool, provenanceLabel, ok: false, error: message });
      return { decision, ok: false, error: message };
    }
  };
  return {
    readFile(relPath, provenanceLabel = "user") {
      return broker("file_read", relPath, provenanceLabel, (abs) => {
        if (!existsSync3(abs)) throw new Error(`no such file: ${relPath}`);
        return readFileSync4(abs, "utf8");
      });
    },
    writeFile(relPath, content, provenanceLabel = "user") {
      return broker("file_write", relPath, provenanceLabel, (abs) => {
        mkdirSync5(dirname3(abs), { recursive: true });
        writeFileSync2(abs, content, "utf8");
        return void 0;
      });
    }
  };
}

// ../spikes/p0-supervisor/ollama.ts
var DEFAULT_HOST = "http://127.0.0.1:11434";
async function ollamaChat(opts) {
  const host = opts.host ?? DEFAULT_HOST;
  const res = await fetch(`${host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools,
      stream: false,
      options: { temperature: opts.temperature ?? 0 }
    })
  });
  if (!res.ok) {
    throw new Error(`ollama /api/chat ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.message) throw new Error("ollama /api/chat: response had no message");
  return data.message;
}
function parseToolArgs(args) {
  if (typeof args === "object" && args !== null) return args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      return void 0;
    }
  }
  return void 0;
}
function stripCodeFence(text) {
  const t = text.trim();
  const m = /^```[^\n`]*\n?([\s\S]*?)(?:\n?```)?$/.exec(t);
  return m ? m[1].trim() : t;
}
function findJsonCandidates(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let opener = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) {
        start = i;
        opener = ch;
      }
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const closer = opener === "{" ? "}" : "]";
          if (ch === closer) out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}
function coerceToolCall(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const obj = value;
  const rawName = typeof obj.name === "string" ? obj.name : typeof obj.tool === "string" ? obj.tool : void 0;
  if (rawName === void 0 || rawName.length === 0) return void 0;
  const rawArgs = obj.arguments ?? obj.args ?? obj.parameters;
  const args = parseToolArgs(rawArgs) ?? {};
  return { function: { name: rawName, arguments: args } };
}
function collectFromValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((v) => collectFromValue(v));
  }
  if (typeof value !== "object" || value === null) return [];
  const obj = value;
  if (Array.isArray(obj.tool_calls)) {
    return obj.tool_calls.flatMap((entry) => {
      if (typeof entry === "object" && entry !== null) {
        const fn = entry.function;
        if (typeof fn === "object" && fn !== null) {
          const coerced2 = coerceToolCall(fn);
          if (coerced2) return [coerced2];
        }
      }
      const coerced = coerceToolCall(entry);
      return coerced ? [coerced] : [];
    });
  }
  if (typeof obj.function === "object" && obj.function !== null) {
    const coerced = coerceToolCall(obj.function);
    if (coerced) return [coerced];
  }
  const single = coerceToolCall(obj);
  return single ? [single] : [];
}
function parseToolCallsFromContent(content) {
  if (typeof content !== "string" || content.trim().length === 0) return [];
  const calls = [];
  const unfenced = stripCodeFence(content);
  for (const source of unfenced === content.trim() ? [content] : [unfenced, content]) {
    try {
      calls.push(...collectFromValue(JSON.parse(source.trim())));
    } catch {
    }
    if (calls.length > 0) return calls;
  }
  const candidates = findJsonCandidates(unfenced);
  if (unfenced !== content) candidates.push(...findJsonCandidates(content));
  for (const candidate of candidates) {
    try {
      calls.push(...collectFromValue(JSON.parse(candidate)));
    } catch {
    }
  }
  return calls;
}

// ../spikes/p0-supervisor/agent-loop.ts
var PKG_ROOT2 = join5(fileURLToPath2(new URL(".", import.meta.url)), "..");
var DEFAULT_POLICY_PATH = join5(
  PKG_ROOT2,
  ".glyphspek-fixtures",
  "policy.example.json"
);
function truncate(s, max) {
  return s.length > max ? `${s.slice(0, max)}
\u2026[truncated ${s.length - max} chars]` : s;
}
var AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the worktree. Path is relative to the repo root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path, e.g. src/interval.js" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write (create or overwrite) a UTF-8 text file in the worktree. Path is relative to the repo root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative path, e.g. src/interval.js" },
          content: { type: "string", description: "Full new file contents." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: 'Run a command in the sandbox as an argv array (no shell). Use ["npm","test"] to run the tests.',
      parameters: {
        type: "object",
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            description: 'Argument vector; argv[0] is the executable, e.g. ["npm","test"].'
          }
        },
        required: ["argv"]
      }
    }
  }
];
function loadPolicyOrThrow(policyPath) {
  const result = loadPolicy(policyPath);
  if (!result.policy) {
    throw new Error(
      `createAgentSession: failed to load policy ${policyPath}: ${result.errors.join("; ")}`
    );
  }
  return result.policy;
}
async function createAgentSession(opts) {
  const { repoPath, baseDir, policyPath = DEFAULT_POLICY_PATH, runtime } = opts;
  const run = baseDir === void 0 ? createRun() : createRun(baseDir);
  const { runId, dir } = run;
  const tracePath = join5(runSubdirPath(dir, "trace"), "trace.jsonl");
  const sink = createTraceWriter(tracePath);
  const lifecycle = new RunLifecycle(run.state);
  const emitStateChanged = (from, to, reason) => {
    const payload = { from, to, reason };
    sink.append({ v: TRACE_EVENT_VERSION, runId, seq: 0, ts: Date.now(), type: "run_state_changed", payload });
  };
  const runCreated = { runId, runDir: dir, provenanceLabel: "user" };
  sink.append({ v: TRACE_EVENT_VERSION, runId, seq: 0, ts: Date.now(), type: "run_created", payload: runCreated });
  const policy = loadPolicyOrThrow(policyPath);
  let worktreeDir;
  let sandbox;
  try {
    {
      const from = lifecycle.state;
      worktreeDir = createWorktree(repoPath, runId, join5(dir, "worktree")).worktreeDir;
      const to = lifecycle.transition("worktree_ready");
      emitStateChanged(from, to, "worktree provisioned");
    }
    const home = createSyntheticHome(dir);
    const env = buildInjectedEnv([]);
    {
      const from = lifecycle.state;
      sandbox = await runtime.createSandbox({
        runId,
        workdir: worktreeDir,
        home,
        env,
        network: "deny"
      });
      const to = lifecycle.transition("sandbox_ready");
      emitStateChanged(from, to, "sandbox provisioned");
    }
    {
      const from = lifecycle.state;
      const to = lifecycle.transition("executing");
      emitStateChanged(from, to, "entering execution");
    }
  } catch (err) {
    if (sandbox) await sandbox.teardown();
    if (worktreeDir) removeWorktree(repoPath, worktreeDir);
    throw err;
  }
  const fileBroker = createFileBroker({ worktreeDir, policy, sink, runId });
  const liveSandbox = sandbox;
  const counters = {
    validToolCalls: 0,
    invalidToolCalls: 0,
    commandsRun: 0,
    commandsBlocked: 0
  };
  let finalized = false;
  let torndown = false;
  let finishResult;
  const finalizeSession = async () => {
    if (finalized) {
      if (finishResult) return finishResult;
      const events2 = readTrace(tracePath);
      return { traceRootHash: computeTraceRoot(events2), eventCount: events2.length };
    }
    finalized = true;
    const from = lifecycle.state;
    const to = lifecycle.transition("completed");
    emitStateChanged(from, to, "run complete");
    const events = readTrace(tracePath);
    finishResult = { traceRootHash: computeTraceRoot(events), eventCount: events.length };
    return finishResult;
  };
  const teardownSession = async () => {
    if (torndown) return;
    torndown = true;
    await liveSandbox.teardown();
    if (worktreeDir) removeWorktree(repoPath, worktreeDir);
  };
  const readPathArg = (args) => {
    const p = args?.path;
    return typeof p === "string" && p.length > 0 ? p : void 0;
  };
  const readArgvArg = (args) => {
    const a = args?.argv;
    if (Array.isArray(a) && a.length > 0 && a.every((t) => typeof t === "string")) {
      return a;
    }
    return void 0;
  };
  const dispatchRunCommand = async (argv, provenanceLabel) => {
    const request = {
      runId,
      tool: "command",
      payload: { argv },
      provenanceLabel,
      requestedCapability: `command:${argv[0]}`
    };
    const decision = decide(policy, request);
    const policyDecision = {
      tool: request.tool,
      requestedCapability: request.requestedCapability,
      decision,
      provenanceLabel,
      command: argv
    };
    sink.append({ v: TRACE_EVENT_VERSION, runId, seq: 0, ts: Date.now(), type: "policy_decision", payload: policyDecision });
    if (decision !== "allow") {
      counters.commandsBlocked += 1;
      const blockedEnd = {
        tool: request.tool,
        provenanceLabel,
        blocked: true,
        decision
      };
      sink.append({ v: TRACE_EVENT_VERSION, runId, seq: 0, ts: Date.now(), type: "tool_end", payload: blockedEnd });
      return `blocked by policy: ${decision}`;
    }
    const toolStart = {
      tool: request.tool,
      requestedCapability: request.requestedCapability,
      provenanceLabel
    };
    sink.append({ v: TRACE_EVENT_VERSION, runId, seq: 0, ts: Date.now(), type: "tool_start", payload: toolStart });
    const startedAt = Date.now();
    const result = await liveSandbox.exec({ command: argv });
    counters.commandsRun += 1;
    const toolEnd = {
      tool: request.tool,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      provenanceLabel,
      stdoutLength: result.stdout.length
    };
    sink.append({ v: TRACE_EVENT_VERSION, runId, seq: 0, ts: Date.now(), type: "tool_end", payload: toolEnd });
    const out = truncate(result.stdout, 2e3);
    const errOut = truncate(result.stderr, 2e3);
    return `exit code: ${result.exitCode}
stdout:
${out}
stderr:
${errOut}`;
  };
  const session = {
    runId,
    dir,
    worktreeDir,
    sandbox: liveSandbox,
    get validToolCalls() {
      return counters.validToolCalls;
    },
    get invalidToolCalls() {
      return counters.invalidToolCalls;
    },
    get commandsRun() {
      return counters.commandsRun;
    },
    get commandsBlocked() {
      return counters.commandsBlocked;
    },
    async dispatchToolCall(name, args, provenanceLabel = "user") {
      switch (name) {
        case "read_file": {
          const path7 = readPathArg(args);
          if (path7 === void 0) {
            counters.invalidToolCalls += 1;
            return 'error: read_file requires a non-empty string "path"';
          }
          counters.validToolCalls += 1;
          const res = fileBroker.readFile(path7, provenanceLabel);
          if (res.ok && res.content !== void 0) return truncate(res.content, 4e3);
          return `error: ${res.error ?? `read failed (${res.decision})`}`;
        }
        case "write_file": {
          const path7 = readPathArg(args);
          const content = args?.content;
          if (path7 === void 0 || typeof content !== "string") {
            counters.invalidToolCalls += 1;
            return 'error: write_file requires string "path" and string "content"';
          }
          counters.validToolCalls += 1;
          const res = fileBroker.writeFile(path7, content, provenanceLabel);
          if (res.ok) return `ok: wrote ${path7} (${content.length} chars)`;
          return `${res.decision === "allow" ? "error" : "blocked"}: ${res.error ?? res.decision}`;
        }
        case "run_command": {
          const argv = readArgvArg(args);
          if (argv === void 0) {
            counters.invalidToolCalls += 1;
            return 'error: run_command requires a non-empty string[] "argv"';
          }
          counters.validToolCalls += 1;
          return dispatchRunCommand(argv, provenanceLabel);
        }
        default: {
          counters.invalidToolCalls += 1;
          return `error: unknown tool "${name}"`;
        }
      }
    },
    finalize: finalizeSession,
    teardown: teardownSession,
    async finish() {
      try {
        return await finalizeSession();
      } finally {
        await teardownSession();
      }
    }
  };
  return session;
}
function systemPrompt() {
  return [
    "You are a coding agent working inside an isolated sandbox on a git repository.",
    "The repository has FAILING tests caused by a bug in the source. Fix the bug.",
    "You may ONLY act through the provided tools: read_file, write_file, run_command.",
    "Workflow: read the relevant source and test files, edit the source with write_file",
    'to fix the bug, then run the tests with run_command(["npm","test"]) to verify.',
    "Make the smallest change that makes the tests pass. When the tests pass, stop and",
    "briefly say you are done. Do not ask the user questions; just use the tools."
  ].join(" ");
}
async function runAgentLoop(opts) {
  const {
    repoPath,
    model,
    task,
    maxTurns = 8,
    runtime,
    host,
    baseDir,
    policyPath,
    deferTeardown = false
  } = opts;
  const session = await createAgentSession({ repoPath, baseDir, policyPath, runtime });
  let turns = 0;
  let toolCalls = 0;
  try {
    const messages = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: task }
    ];
    for (let turn = 0; turn < maxTurns; turn++) {
      const msg = await ollamaChat({ model, messages, tools: AGENT_TOOLS, host });
      turns += 1;
      messages.push(msg);
      const calls = msg.tool_calls && msg.tool_calls.length > 0 ? msg.tool_calls : parseToolCallsFromContent(msg.content);
      if (calls.length === 0) break;
      for (const call of calls) {
        toolCalls += 1;
        const name = call.function.name;
        const args = parseToolArgs(call.function.arguments);
        const result = await session.dispatchToolCall(name, args, "user");
        messages.push({ role: "tool", content: result, tool_name: name });
      }
    }
    const finalCheck = await session.sandbox.exec({ command: ["npm", "test"] });
    const finalTestsPassed = finalCheck.exitCode === 0;
    const baseMetrics = {
      runId: session.runId,
      turns,
      toolCalls,
      validToolCalls: session.validToolCalls,
      invalidToolCalls: session.invalidToolCalls,
      commandsRun: session.commandsRun,
      commandsBlocked: session.commandsBlocked,
      finalTestsPassed
    };
    if (deferTeardown) {
      const tracePath = join5(runSubdirPath(session.dir, "trace"), "trace.jsonl");
      const fin2 = await session.finalize();
      const deferred = {
        ...baseMetrics,
        traceRootHash: fin2.traceRootHash,
        eventCount: fin2.eventCount,
        worktreeDir: session.worktreeDir,
        tracePath,
        // session.teardown() is idempotent, so the catch path below can also
        // release resources safely on a later throw.
        teardown: async () => {
          await session.teardown();
        }
      };
      return deferred;
    }
    const fin = await session.finish();
    return {
      ...baseMetrics,
      traceRootHash: fin.traceRootHash,
      eventCount: fin.eventCount
    };
  } catch (err) {
    await session.finish().catch(() => void 0);
    throw err;
  }
}

// ../spikes/p0-supervisor/autonomous-capstone.ts
var PKG_ROOT3 = path5.join(fileURLToPath3(new URL(".", import.meta.url)), "..");
var REPO_ROOT = path5.join(PKG_ROOT3, "..");
var DEMO_REPO_PATH = path5.join(PKG_ROOT3, "demo-repo");
var CAPSTONE_POLICY_PATH = path5.join(
  PKG_ROOT3,
  ".glyphspek-fixtures",
  "capstone-policy.json"
);
var DEFAULT_OUT_DIR = path5.join(
  REPO_ROOT,
  "demo-output",
  "autonomous-capstone"
);
var TASK = 'The tests in this repository are failing. Investigate the source under src/, find and fix the bug, and run ["npm","test"] until the tests pass.';
async function runAutonomousCapstone(options = {}) {
  const {
    model = "qwen2.5-coder:7b",
    maxTurns = 8,
    baseDir,
    outDir = DEFAULT_OUT_DIR,
    host,
    repoPath = DEMO_REPO_PATH,
    policyPath = CAPSTONE_POLICY_PATH,
    verifierKeyPath
  } = options;
  const runtime = new DockerSandboxRuntime();
  const loop = await runAgentLoop({
    repoPath,
    model,
    task: TASK,
    maxTurns,
    runtime,
    host,
    baseDir,
    policyPath,
    deferTeardown: true
  });
  const { runId, worktreeDir, tracePath, teardown } = loop;
  const actorClaim = {
    actor: "local-model",
    model,
    task: TASK,
    summary: loop.finalTestsPassed ? `The local model (${model}) read the source, applied a fix through the file broker, and the supervisor\u2019s authoritative npm test then passed.` : `The local model (${model}) attempted a fix through the file broker; the supervisor\u2019s authoritative npm test did NOT pass.`,
    metrics: {
      turns: loop.turns,
      toolCalls: loop.toolCalls,
      validToolCalls: loop.validToolCalls,
      invalidToolCalls: loop.invalidToolCalls,
      commandsRun: loop.commandsRun,
      commandsBlocked: loop.commandsBlocked,
      finalTestsPassed: loop.finalTestsPassed
    }
  };
  const keypair = resolveVerifierKeypair(verifierKeyPath);
  const privateKey = keypair.privateKey;
  let verdict;
  try {
    verdict = await runVerification({
      repoPath,
      sourceWorktree: worktreeDir,
      policyPath,
      tracePath,
      privateKey
    });
  } finally {
    await teardown();
  }
  const events = readTrace(tracePath);
  const traceVerifies = verifyChain(events).ok;
  const traceRootHash = computeTraceRoot(events);
  const signatureVerifies = verifyVerdictSignature(verdict, keypair.publicKey);
  const readme = buildReadme({
    runId,
    model,
    overallVerdict: verdict.overallVerdict,
    traceRootHash,
    keyId: keypair.keyId,
    modelFixedBug: loop.finalTestsPassed,
    turns: loop.turns,
    validToolCalls: loop.validToolCalls,
    traceVerifies,
    signatureVerifies
  });
  writeVerifiedBundle({
    outDir,
    tracePath,
    verdict,
    publicKey: keypair.publicKey,
    actorClaim,
    readme
  });
  return {
    runId,
    bundlePath: outDir,
    modelFixedBug: loop.finalTestsPassed,
    turns: loop.turns,
    validToolCalls: loop.validToolCalls,
    overallVerdict: verdict.overallVerdict,
    traceRootHash,
    eventCount: events.length,
    signatureVerifies
  };
}
function buildReadme(info) {
  return `# GlyphSpek P0 AUTONOMOUS Capstone Bundle

This directory is the verified evidence bundle for one **fully autonomous**
governed-and-verified run of the GlyphSpek P0 spike against \`demo-repo\` (a
dependency-free repo with a seeded off-by-one bug in \`src/interval.js\`'s
\`overlaps()\`).

## The AUTONOMOUS variant

Unlike the scripted capstone (which applies a deterministic edit through the
broker), **the fix in this run was produced by a LOCAL MODEL \u2014 not a script.**
The model \`${info.model}\` was given the task and drove the whole fix itself
through the brokered / sandboxed agent loop (\`read_file\`, \`write_file\`,
\`run_command\`): it read the source, wrote the correction, and re-ran the tests.
Every tool call was policy-checked and recorded in the trace; the run executed
inside a real \`network:'deny'\` Docker sandbox.

## What happened

1. **Autonomous governed actor run.** A run was minted with an append-only,
   hash-chained trace. An ephemeral git worktree of \`demo-repo\` was checked
   out, a synthetic empty HOME and a minimal allowlisted environment were
   prepared, and a real \`network:'deny'\` Docker sandbox was provisioned over the
   worktree. The model drove the fix through the brokered tools across
   ${info.turns} turn(s) (${info.validToolCalls} valid tool call(s)). After the
   loop, the **SUPERVISOR** re-ran \`npm test\` itself (never trusting the
   model's claim) to decide the authoritative outcome. Model fixed the bug:
   ${info.modelFixedBug}.

2. **Independent verification.** A separate trust domain generated its own
   Ed25519 keypair, provisioned its OWN fresh worktree and its OWN
   \`network:'deny'\` container, overlaid the MODEL'S result, and re-ran the
   \`Policy.verify\` targets (\`npm run build\`, \`npm test\`) \u2014 and ONLY those.
   It emitted a signed verdict the actor cannot forge.

## Files

- \`trace.jsonl\` \u2014 verbatim copy of the actor's append-only, hash-chained trace.
- \`verdict.json\` \u2014 the signed \`VerifierVerdict\` (authoritative outcome).
- \`verifier-public-key.pem\` \u2014 the verifier's Ed25519 public key (SPKI PEM).
  Resolve this out-of-band (keyId \`${info.keyId}\`) to verify the signature
  before trusting the verdict.
- \`actor-claims.json\` \u2014 the model's SELF-REPORTED claim and loop metrics. This
  is NOT authoritative; it is included so a reviewer can compare what the model
  said against what the independent verifier found.
- \`README.md\` \u2014 this file.

## Verified facts (recomputed independently)

- Run id: \`${info.runId}\`
- Fix produced by: local model \`${info.model}\` (autonomous, not scripted)
- Model fixed the bug (supervisor's authoritative npm test passed): ${info.modelFixedBug}
- Overall verifier verdict: **${info.overallVerdict}**
- Trace-root hash: \`${info.traceRootHash}\`
- Trace chain verifies (tamper-evident, intact): ${info.traceVerifies}
- Verdict signature verifies against the public key: ${info.signatureVerifies}
`;
}

// ../spikes/p0-supervisor/governed-run-cli.ts
function progress(message) {
  process.stderr.write(`${message}
`);
}
function emitResult(result) {
  process.stdout.write(`${JSON.stringify(result)}
`);
}
function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === void 0 || value.startsWith("--")) {
      throw new Error(`flag --${key} requires a value`);
    }
    raw[key] = value;
    i += 1;
  }
  const repo = raw.repo;
  const policy = raw.policy;
  const out = raw.out;
  if (!repo) throw new Error("--repo <absPath> is required");
  if (!policy) throw new Error("--policy <absPath> is required");
  if (!out) throw new Error("--out <absDir> is required");
  const modeRaw = raw.mode ?? "verify-only";
  if (modeRaw !== "verify-only" && modeRaw !== "autonomous") {
    throw new Error(`--mode must be 'verify-only' or 'autonomous', got '${modeRaw}'`);
  }
  return {
    // Resolve to absolute so downstream worktree/docker mounts are unambiguous.
    repo: path6.resolve(repo),
    policy: path6.resolve(policy),
    out: path6.resolve(out),
    mode: modeRaw,
    verifierKey: raw["verifier-key"] ? path6.resolve(raw["verifier-key"]) : void 0,
    runsBase: raw["runs-base"] ? path6.resolve(raw["runs-base"]) : void 0
  };
}
function effectiveRunsBase(args) {
  return args.runsBase ?? process.env.GLYPHSPEK_RUNS_BASE ?? path6.join(os.homedir(), ".glyphspek", "runs");
}
function verifyOnlyClaim(repo, policy) {
  return {
    mode: "verify-only",
    actor: "none",
    repoPath: repo,
    policyPath: policy,
    summary: "verify-only run: NO source edit was made. The repo was checked out into an ephemeral governed worktree and the policy.verify targets were re-run by the independent verifier in a separate clean network:deny container.",
    claimedFilesChanged: []
  };
}
function buildVerifyOnlyReadme(info) {
  const checkLines = info.checks.map((c) => `  - \`${c.name}\` -> **${c.status}**`).join("\n");
  return `# GlyphSpek Verified Bundle (verify-only)

This directory is the verified evidence bundle for one **verify-only** governed
run of GlyphSpek against \`${info.repoPath}\`.

## What happened

1. **Governed run (no source edit).** A run was minted with an append-only,
   hash-chained trace and driven through the legal lifecycle
   (\`created -> worktree_ready -> sandbox_ready -> executing -> completed\`). An
   ephemeral git worktree of the repo was checked out. **No file was edited** \u2014
   verify-only deliberately makes no change to the source.

2. **Independent verification.** A separate trust domain provisioned its OWN
   fresh worktree and its OWN \`--network none\` Docker container, overlaid the
   governed worktree, and re-ran the policy's \`verify\` targets \u2014 and ONLY those.
   It emitted a signed verdict bound to the trace root that the actor cannot
   forge.

## Files

- \`trace.jsonl\` \u2014 verbatim copy of the run's append-only, hash-chained trace.
- \`verdict.json\` \u2014 the signed \`VerifierVerdict\` (authoritative outcome).
- \`verifier-public-key.pem\` \u2014 the verifier's Ed25519 public key (SPKI PEM).
  Resolve this out-of-band (keyId \`${info.keyId}\`) to verify the signature
  before trusting the verdict.
- \`actor-claims.json\` \u2014 the actor's self-reported claim (verify-only: NO edit).
- \`README.md\` \u2014 this file.

## Verified facts (recomputed independently)

- Run id: \`${info.runId}\`
- Policy: \`${info.policyPath}\`
- Overall verifier verdict: **${info.overallVerdict}**
- Verify checks:
${checkLines || "  - (none defined in policy.verify)"}
- Trace-root hash: \`${info.traceRootHash}\`
- Trace chain verifies (tamper-evident, intact): ${info.traceVerifies}
- Verdict signature verifies against the public key: ${info.signatureVerifies}
`;
}
var WORKDIR_MOUNT3 = "/workspace";
async function runVerifyOnly(args) {
  const { policy, errors } = loadPolicy(args.policy);
  if (!policy) {
    throw new Error(`failed to load policy ${args.policy}: ${errors.join("; ")}`);
  }
  const runsBase = effectiveRunsBase(args);
  mkdirSync6(runsBase, { recursive: true });
  progress(`verify-only: minting governed run (runs base ${runsBase})`);
  const run = createRun(runsBase);
  const { runId, dir } = run;
  const tracePath = path6.join(runSubdirPath(dir, "trace"), "trace.jsonl");
  const sink = createTraceWriter(tracePath);
  const lifecycle = new RunLifecycle(run.state);
  const runCreated = { runId, runDir: dir, provenanceLabel: "user" };
  sink.append({
    v: TRACE_EVENT_VERSION,
    runId,
    seq: 0,
    // writer is authoritative for seq; placeholder here.
    ts: Date.now(),
    type: "run_created",
    payload: runCreated
  });
  const emitStateChanged = (from, to, reason) => {
    const payload = { from, to, reason };
    sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      ts: Date.now(),
      type: "run_state_changed",
      payload
    });
  };
  let actorWorktreeDir;
  let sandbox;
  let sandboxTorndown = false;
  try {
    {
      const from = lifecycle.state;
      actorWorktreeDir = createWorktree(
        args.repo,
        runId,
        path6.join(dir, "worktree")
      ).worktreeDir;
      const to = lifecycle.transition("worktree_ready");
      emitStateChanged(from, to, "worktree provisioned (verify-only, no edit)");
      progress(`verify-only: worktree provisioned for ${args.repo}`);
    }
    const home = createSyntheticHome(path6.join(dir, "home"));
    const env = buildInjectedEnv([]);
    {
      const from = lifecycle.state;
      sandbox = await new DockerSandboxRuntime().createSandbox({
        runId,
        workdir: actorWorktreeDir,
        home,
        env,
        network: "deny"
      });
      const to = lifecycle.transition("sandbox_ready");
      emitStateChanged(from, to, "sandbox provisioned (docker, network:deny)");
      progress("verify-only: sandbox provisioned (docker, network:deny)");
    }
    {
      const from = lifecycle.state;
      const to = lifecycle.transition("executing");
      emitStateChanged(from, to, "entering execution (verify-only)");
    }
    {
      const from = lifecycle.state;
      const to = lifecycle.transition("completed");
      emitStateChanged(from, to, "run complete (verify-only)");
    }
    void WORKDIR_MOUNT3;
  } catch (err) {
    if (sandbox && !sandboxTorndown) {
      sandboxTorndown = true;
      await sandbox.teardown();
    }
    if (actorWorktreeDir) {
      removeWorktree(args.repo, actorWorktreeDir);
    }
    throw err;
  }
  const keypair = resolveVerifierKeypair(args.verifierKey);
  const privateKey = keypair.privateKey;
  progress(
    args.verifierKey ? `verify-only: signing with stable key (keyId ${keypair.keyId})` : `verify-only: signing with ephemeral key (keyId ${keypair.keyId})`
  );
  let verdict;
  try {
    progress("verify-only: running independent verification (separate network:deny container)");
    verdict = await runVerification({
      repoPath: args.repo,
      sourceWorktree: actorWorktreeDir,
      policyPath: args.policy,
      tracePath,
      privateKey,
      // Verifier writes its OWN fresh worktree under the SAME effective base so
      // the bundled launch path never touches the install dir.
      runsBaseDir: runsBase
    });
  } finally {
    if (sandbox && !sandboxTorndown) {
      sandboxTorndown = true;
      await sandbox.teardown();
    }
    if (actorWorktreeDir) {
      removeWorktree(args.repo, actorWorktreeDir);
    }
  }
  const events = readTrace(tracePath);
  const traceVerifies = verifyChain(events).ok;
  const traceRootHash = computeTraceRoot(events);
  const signatureVerifies = verifyVerdictSignature(verdict, keypair.publicKey);
  const readme = buildVerifyOnlyReadme({
    runId,
    repoPath: args.repo,
    policyPath: args.policy,
    overallVerdict: verdict.overallVerdict,
    traceRootHash,
    keyId: keypair.keyId,
    traceVerifies,
    signatureVerifies,
    checks: verdict.checks
  });
  writeVerifiedBundle({
    outDir: args.out,
    tracePath,
    verdict,
    publicKey: keypair.publicKey,
    actorClaim: verifyOnlyClaim(args.repo, args.policy),
    readme
  });
  progress(`verify-only: bundle written to ${args.out}`);
  return {
    mode: "verify-only",
    runId,
    bundlePath: args.out,
    overallVerdict: verdict.overallVerdict,
    traceRootHash,
    eventCount: events.length,
    traceVerifies,
    signatureVerifies
  };
}
async function runAutonomous(args) {
  progress("autonomous: running local-model capstone (this requires Ollama + Docker)");
  const result = await runAutonomousCapstone({
    repoPath: args.repo,
    policyPath: args.policy,
    verifierKeyPath: args.verifierKey,
    outDir: args.out
  });
  progress(`autonomous: bundle written to ${args.out}`);
  return { mode: "autonomous", ...result };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!dockerAvailable()) {
    emitResult({ error: "docker-unavailable" });
    process.exitCode = 1;
    return;
  }
  const result = args.mode === "verify-only" ? await runVerifyOnly(args) : await runAutonomous(args);
  emitResult(result);
}
main().catch((err) => {
  progress(err instanceof Error ? err.stack ?? err.message : String(err));
  emitResult({ error: "run-failed", message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
