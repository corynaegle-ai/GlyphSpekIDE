var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../spikes/p0-sandbox/egress-proxy.ts
import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { randomUUID as randomUUID2 } from "node:crypto";
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
  return new Promise((resolve5, reject) => {
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
      resolve5({
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
var LOOPBACK_NO_PROXY, DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT;
var init_egress_proxy = __esm({
  "../spikes/p0-sandbox/egress-proxy.ts"() {
    LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";
    DEFAULT_HTTP_PORT = 80;
    DEFAULT_HTTPS_PORT = 443;
  }
});

// ../spikes/p0-supervisor/code-index/discover.ts
var discover_exports = {};
__export(discover_exports, {
  discoverFiles: () => discoverFiles,
  filterIndexablePaths: () => filterIndexablePaths
});
import { promises as fs2 } from "node:fs";
import * as path3 from "node:path";
function isBackupSegment(seg) {
  return /\.(bak|backup|old|orig)$/i.test(seg) || // trailing: app.bak, src.backup, x.old, m.orig
  /\.(bak|backup)[.-]/i.test(seg) || // infix: VSCode-darwin-arm64.bak-pre-slice1, db.backup.2026
  seg.endsWith("~");
}
function parseIgnoreFile(body) {
  const patterns = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("!")) continue;
    if (line.startsWith("*.")) {
      patterns.push({ kind: "ext", value: line.slice(2).toLowerCase() });
      continue;
    }
    if (line.endsWith("/")) {
      const value = line.replace(/^\/+/, "").replace(/\/+$/, "");
      if (value.length > 0) patterns.push({ kind: "dir", value });
      continue;
    }
    if (line.includes("/")) {
      patterns.push({ kind: "prefix", value: line.replace(/^\/+/, "") });
      continue;
    }
    patterns.push({ kind: "name", value: line });
  }
  return patterns;
}
function compileExtraIgnore(globs) {
  if (!globs || globs.length === 0) return [];
  return parseIgnoreFile(globs.join("\n"));
}
function matchesIgnore(relPath, segments, patterns) {
  if (patterns.length === 0) return false;
  const basename = segments[segments.length - 1] ?? "";
  const lowerBasename = basename.toLowerCase();
  for (const p of patterns) {
    switch (p.kind) {
      case "ext":
        if (lowerBasename.endsWith(`.${p.value}`)) return true;
        break;
      case "dir":
        if (segments.includes(p.value)) return true;
        break;
      case "prefix":
        if (relPath === p.value || relPath.startsWith(`${p.value}/`)) return true;
        break;
      case "name":
        if (basename === p.value || segments.includes(p.value)) return true;
        break;
    }
  }
  return false;
}
function isHardDenied(segments) {
  for (const seg of segments) {
    if (DENY_SEGMENTS.has(seg)) return true;
    if (isBackupSegment(seg)) return true;
  }
  const basename = segments[segments.length - 1] ?? "";
  for (const predicate of DENY_FILENAME_PREDICATES) {
    if (predicate(basename)) return true;
  }
  for (const predicate of GENERATED_FILENAME_PREDICATES) {
    if (predicate(basename)) return true;
  }
  return false;
}
function isAllowedTextFile(basename) {
  const dot2 = basename.lastIndexOf(".");
  if (dot2 <= 0) return false;
  const ext = basename.slice(dot2 + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}
async function looksBinary(absPath) {
  let handle;
  try {
    handle = await fs2.open(absPath, "r");
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle?.close();
  }
}
async function readRootIgnore(workspaceRoot, name) {
  try {
    const body = await fs2.readFile(path3.join(workspaceRoot, name), "utf8");
    return parseIgnoreFile(body);
  } catch {
    return [];
  }
}
async function discoverFiles(opts) {
  const root = await fs2.realpath(path3.resolve(opts.workspaceRoot));
  const ignorePatterns = [
    ...await readRootIgnore(root, ".gitignore"),
    ...await readRootIgnore(root, ".glyphstudioignore"),
    ...compileExtraIgnore(opts.extraIgnore)
  ];
  const results = [];
  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await fs2.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const relPath = relDir.length === 0 ? name : `${relDir}/${name}`;
      const segments = relPath.split("/");
      if (isHardDenied(segments)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (matchesIgnore(relPath, segments, ignorePatterns)) continue;
        await walk(path3.join(absDir, name), relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchesIgnore(relPath, segments, ignorePatterns)) continue;
      if (!isAllowedTextFile(name)) continue;
      const absPath = path3.join(absDir, name);
      if (absPath !== root && !absPath.startsWith(root + path3.sep)) continue;
      let size;
      try {
        const st = await fs2.stat(absPath);
        size = st.size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      try {
        if (await looksBinary(absPath)) continue;
      } catch {
        continue;
      }
      results.push({ path: relPath, absPath });
    }
  }
  await walk(root, "");
  results.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return results;
}
function normalizeRelPath(raw) {
  if (typeof raw !== "string") return void 0;
  const posix = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (posix.length === 0 || posix === ".") return void 0;
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return void 0;
  const segments = posix.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) return void 0;
  return posix;
}
async function filterIndexablePaths(workspaceRoot, relPaths, opts) {
  const mode = opts?.mode ?? "existing";
  let root;
  try {
    root = await fs2.realpath(path3.resolve(workspaceRoot));
  } catch {
    return [];
  }
  const ignorePatterns = [
    ...await readRootIgnore(root, ".gitignore"),
    ...await readRootIgnore(root, ".glyphstudioignore"),
    ...compileExtraIgnore(opts?.extraIgnore)
  ];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of relPaths) {
    const relPath = normalizeRelPath(raw);
    if (relPath === void 0 || seen.has(relPath)) continue;
    seen.add(relPath);
    const segments = relPath.split("/");
    if (isHardDenied(segments)) continue;
    if (matchesIgnore(relPath, segments, ignorePatterns)) continue;
    if (!isAllowedTextFile(segments[segments.length - 1] ?? "")) continue;
    const joined = path3.join(root, ...segments);
    if (mode === "path-only") {
      out.push({ path: relPath, absPath: joined });
      continue;
    }
    try {
      const lst = await fs2.lstat(joined);
      if (lst.isSymbolicLink() || !lst.isFile()) continue;
      const real = await fs2.realpath(joined);
      if (real !== root && !real.startsWith(root + path3.sep)) continue;
      if (lst.size > MAX_FILE_BYTES) continue;
      if (await looksBinary(joined)) continue;
    } catch {
      continue;
    }
    out.push({ path: relPath, absPath: joined });
  }
  out.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return out;
}
var DENY_SEGMENTS, DENY_FILENAME_PREDICATES, GENERATED_FILENAME_PREDICATES, TEXT_EXTENSIONS, MAX_FILE_BYTES, BINARY_SNIFF_BYTES;
var init_discover = __esm({
  "../spikes/p0-supervisor/code-index/discover.ts"() {
    DENY_SEGMENTS = /* @__PURE__ */ new Set([
      ".git",
      // VCS internals (config can hold credentials/remotes)
      "node_modules",
      // vendored dependencies — never index
      "dist",
      // build output
      "dist-supervisor",
      // supervisor bundle output
      "out",
      // build output
      "out-build",
      // build output
      "out-vscode",
      // build output
      "bin",
      // .NET build output (generated/build noise) — segment match only
      "obj",
      // .NET build output: holds generated AssemblyInfo.cs etc. (build noise)
      ".glyphstudio",
      // the index's OWN home — never index ourselves
      ".vscode-test",
      // VS Code integration-test scratch
      ".ssh"
      // SSH key directory — anything under it is a secret
    ]);
    DENY_FILENAME_PREDICATES = [
      // Dotenv: exactly `.env`, or `.env.<anything>` (`.env.local`, `.env.production`).
      (name) => name === ".env" || name.startsWith(".env."),
      // Private-key / certificate extensions.
      (name) => /\.(pem|key|p12|pfx)$/i.test(name),
      // Default SSH private/public key files regardless of directory.
      (name) => /^id_rsa/i.test(name),
      // Substring secrets — deliberately broad. Any of these tokens anywhere in the
      // basename denies the file (e.g. `mySecret.ts`, `password.txt`).
      (name) => {
        const lower = name.toLowerCase();
        return lower.includes("secret") || lower.includes("credential") || lower.includes("password");
      }
    ];
    GENERATED_FILENAME_PREDICATES = [
      // .NET generated assembly-attributes file (commonly under obj/, also seen at root).
      (name) => /^assemblyinfo\.cs$/i.test(name),
      // Generated C# partials: *.Designer.cs, *.generated.cs, *.g.cs, *.g.i.cs.
      (name) => /\.(designer|generated|g|g\.i)\.cs$/i.test(name),
      // Minified web bundles + source maps.
      (name) => /\.min\.(js|css)$/i.test(name),
      (name) => /\.map$/i.test(name),
      // .NET restore lockfile.
      (name) => name.toLowerCase() === "packages.lock.json"
    ];
    TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "md",
      "mdx",
      "json",
      "jsonc",
      "css",
      "scss",
      "html",
      "sh",
      "bash",
      "zsh",
      "py",
      "go",
      "rs",
      "java",
      "kt",
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "cs",
      "rb",
      "php",
      "swift",
      "sql",
      "yml",
      "yaml",
      "toml",
      "ini",
      "txt"
    ]);
    MAX_FILE_BYTES = 1024 * 1024;
    BINARY_SNIFF_BYTES = 4096;
  }
});

// ../spikes/p0-supervisor/code-index/structure-chunk.ts
function rulesFor(relPath) {
  const dot2 = relPath.lastIndexOf(".");
  if (dot2 < 0) return void 0;
  return BOUNDARY_RULES[relPath.slice(dot2 + 1).toLowerCase()];
}
function chunkFileStructure(relPath, text, opts) {
  const rules = rulesFor(relPath);
  if (!rules) return chunkFileLines(relPath, text, opts);
  const lines = text.split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return [];
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (rules.some((r) => r.test(line))) boundaries.push(i);
  }
  if (boundaries.length === 0) return chunkFileLines(relPath, text, opts);
  const units = [];
  if (boundaries[0] > 0) units.push({ start: 0, end: boundaries[0] - 1 });
  for (let b = 0; b < boundaries.length; b++) {
    units.push({
      start: boundaries[b],
      end: b + 1 < boundaries.length ? boundaries[b + 1] - 1 : lines.length - 1
    });
  }
  const chunkLinesCap = Math.max(1, opts?.chunkLines ?? DEFAULT_CHUNK_LINES);
  const maxChars = Math.max(1, opts?.maxChars ?? DEFAULT_MAX_CHARS);
  const prefix = new Array(lines.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < lines.length; i++) prefix[i + 1] = prefix[i] + lines[i].length + 1;
  const joinedChars = (a, b) => prefix[b + 1] - prefix[a] - 1;
  const merged = [];
  for (const u of units) {
    const prev = merged[merged.length - 1];
    if (prev !== void 0 && u.end - prev.start + 1 <= chunkLinesCap && joinedChars(prev.start, u.end) <= maxChars) {
      prev.end = u.end;
    } else {
      merged.push({ ...u });
    }
  }
  const chunks = [];
  for (const u of merged) {
    const unitLineCount = u.end - u.start + 1;
    const unitText = lines.slice(u.start, u.end + 1).join("\n");
    if (unitLineCount <= STRUCTURE_MAX_UNIT_LINES && unitText.length <= maxChars) {
      const trimmed = unitText.trim();
      if (trimmed.length > 0) chunks.push(makeChunk(relPath, u.start + 1, u.end + 1, trimmed));
    } else {
      chunks.push(...windowLines(relPath, lines.slice(u.start, u.end + 1), u.start + 1, opts));
    }
  }
  return chunks;
}
var STRUCTURE_MAX_UNIT_LINES, MOD, BRACE_DECL, ARROW_ASSIGN, PY_RULES, MD_RULES, JS_RULES, BRACE_RULES, BOUNDARY_RULES;
var init_structure_chunk = __esm({
  "../spikes/p0-supervisor/code-index/structure-chunk.ts"() {
    init_chunk();
    STRUCTURE_MAX_UNIT_LINES = 120;
    MOD = String.raw`(?:(?:export|default|declare|public|private|protected|internal|static|final|abstract|override|sealed|partial|virtual|open|data|inline|unsafe|extern|async|pub(?:\([^)]*\))?)\s+)*`;
    BRACE_DECL = new RegExp(
      String.raw`^[ \t]*${MOD}(?:function|class|interface|enum|struct|trait|impl|fn|func|fun|type|namespace|protocol|extension|record|object|union)\s+[A-Za-z_$<(\[]`
    );
    ARROW_ASSIGN = /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*[^=]*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=>]*)?=>|[A-Za-z_$][\w$]*\s*=>)/;
    PY_RULES = [/^[ \t]*(?:async\s+)?def\s+[A-Za-z_]/, /^[ \t]*class\s+[A-Za-z_]/];
    MD_RULES = [/^#{1,6}\s/];
    JS_RULES = [BRACE_DECL, ARROW_ASSIGN];
    BRACE_RULES = [BRACE_DECL];
    BOUNDARY_RULES = {
      ts: JS_RULES,
      tsx: JS_RULES,
      js: JS_RULES,
      jsx: JS_RULES,
      mjs: JS_RULES,
      cjs: JS_RULES,
      go: BRACE_RULES,
      rs: BRACE_RULES,
      java: BRACE_RULES,
      kt: BRACE_RULES,
      c: BRACE_RULES,
      h: BRACE_RULES,
      cc: BRACE_RULES,
      cpp: BRACE_RULES,
      hpp: BRACE_RULES,
      cs: BRACE_RULES,
      swift: BRACE_RULES,
      php: BRACE_RULES,
      py: PY_RULES,
      md: MD_RULES,
      mdx: MD_RULES
      // Everything else (json, yaml, css, sh, sql, txt, …): no entry → no
      // boundaries → bit-for-bit 'lines' fallback.
    };
  }
});

// ../spikes/p0-supervisor/code-index/chunk.ts
var chunk_exports = {};
__export(chunk_exports, {
  DEFAULT_CHUNK_LINES: () => DEFAULT_CHUNK_LINES,
  DEFAULT_MAX_CHARS: () => DEFAULT_MAX_CHARS,
  DEFAULT_OVERLAP: () => DEFAULT_OVERLAP,
  chunkFile: () => chunkFile,
  chunkFileLines: () => chunkFileLines,
  makeChunk: () => makeChunk,
  windowLines: () => windowLines
});
import { createHash as createHash4 } from "node:crypto";
function sha256Hex(text) {
  return createHash4("sha256").update(text, "utf8").digest("hex");
}
function makeChunk(relPath, startLine, endLine, text) {
  return {
    id: `${relPath}:${startLine}-${endLine}`,
    path: relPath,
    startLine,
    endLine,
    text,
    hash: sha256Hex(text)
  };
}
function chunkFile(relPath, text, opts) {
  if (opts?.strategy === "lines") return chunkFileLines(relPath, text, opts);
  return chunkFileStructure(relPath, text, opts);
}
function chunkFileLines(relPath, text, opts) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return [];
  return windowLines(relPath, lines, 1, opts);
}
function windowLines(relPath, lines, firstLineNumber, opts) {
  const chunkLines = Math.max(1, opts?.chunkLines ?? DEFAULT_CHUNK_LINES);
  const overlap = Math.max(0, opts?.overlap ?? DEFAULT_OVERLAP);
  const maxChars = Math.max(1, opts?.maxChars ?? DEFAULT_MAX_CHARS);
  const step = Math.max(1, chunkLines - overlap);
  const chunks = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + chunkLines, lines.length);
    const windowText = lines.slice(start, end).join("\n");
    const startLine = firstLineNumber + start;
    const endLine = firstLineNumber + end - 1;
    if (windowText.length <= maxChars) {
      const trimmed = windowText.trim();
      if (trimmed.length > 0) {
        chunks.push(makeChunk(relPath, startLine, endLine, trimmed));
      }
    } else {
      const pieces = [];
      for (let i = 0; i < windowText.length; i += maxChars) {
        pieces.push(windowText.slice(i, i + maxChars));
      }
      const kept = [];
      for (const piece of pieces) {
        const trimmed = piece.trim();
        if (trimmed.length > 0) kept.push(trimmed);
      }
      if (kept.length === 1) {
        chunks.push(makeChunk(relPath, startLine, endLine, kept[0]));
      } else {
        kept.forEach((pieceText, idx) => {
          const base = makeChunk(relPath, startLine, endLine, pieceText);
          chunks.push({ ...base, id: `${base.id}#${idx}` });
        });
      }
    }
    if (end >= lines.length) break;
  }
  return chunks;
}
var DEFAULT_CHUNK_LINES, DEFAULT_OVERLAP, DEFAULT_MAX_CHARS;
var init_chunk = __esm({
  "../spikes/p0-supervisor/code-index/chunk.ts"() {
    init_structure_chunk();
    DEFAULT_CHUNK_LINES = 40;
    DEFAULT_OVERLAP = 8;
    DEFAULT_MAX_CHARS = 2e3;
  }
});

// ../spikes/p0-sandbox/firecracker-egress-rules.ts
function splitEntry(entry) {
  const trimmed = entry.trim();
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
  if (portStr.length > 0 && /^\d+$/.test(portStr) && Number.isInteger(port)) {
    const head = trimmed.slice(0, idx);
    if (head.includes(":")) return { host: trimmed };
    return { host: head, port };
  }
  return { host: trimmed };
}
function isCidrLiteral(host) {
  const slash = host.lastIndexOf("/");
  if (slash === -1) return false;
  const addr = host.slice(0, slash);
  const prefix = host.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) return false;
  return isIpLiteral(addr);
}
function rulesForEntry(entry, resolved) {
  const { host, port } = splitEntry(entry);
  if (host.length === 0) return [];
  const mkRule = (cidr, hostname) => port === void 0 ? { cidr, origin: { entry, ...hostname ? { hostname } : {} } } : { cidr, port, protocol: "tcp", origin: { entry, ...hostname ? { hostname } : {} } };
  if (isCidrLiteral(host) || isIpLiteral(host)) {
    return [mkRule(host)];
  }
  const addrs = resolved?.get(host) ?? resolved?.get(host.toLowerCase());
  if (!addrs || addrs.length === 0) return [];
  return addrs.map((ip) => mkRule(ip, host));
}
function compileEgressRuleset(input, ctx) {
  const base = {
    nsName: ctx.nsName,
    guestIp: ctx.guestIp,
    basePolicy: "drop"
    // fail-closed default-DENY — always.
  };
  if (input.network === "deny") {
    return { ...base, egressMode: "hard-deny", accept: [], hardenedFromSoftMode: false };
  }
  const { allow, egressMode } = input.network;
  const hardenedFromSoftMode = egressMode === "soft-proxy-allow";
  if (egressMode === "hard-deny") {
    return { ...base, egressMode, accept: [], hardenedFromSoftMode: false };
  }
  if (allow.length === 0) {
    return { ...base, egressMode, accept: [], hardenedFromSoftMode };
  }
  const accept = [];
  for (const entry of allow) {
    accept.push(...rulesForEntry(entry, input.resolved));
  }
  return { ...base, egressMode, accept, hardenedFromSoftMode };
}
function toCidr(addr) {
  const a = addr.trim();
  if (a.includes("/")) return a.replace(/^\[|\]$/g, "");
  const unwrapped = a.replace(/^\[|\]$/g, "");
  const isV6 = unwrapped.includes(":");
  return `${unwrapped}/${isV6 ? 128 : 32}`;
}
function serializeNftRuleset(r) {
  const lines = [];
  const table = `glyph_${sanitize(r.nsName)}`;
  lines.push(`# hard egress ruleset for ns=${r.nsName} guest=${r.guestIp} mode=${r.egressMode}`);
  if (r.hardenedFromSoftMode) {
    lines.push(`# note: requested 'soft-proxy-allow' was HARDENED into a hard allowlist`);
  }
  lines.push(`table inet ${table} {`);
  lines.push(`  chain output {`);
  lines.push(`    type filter hook output priority 0; policy ${r.basePolicy};`);
  lines.push(`    ip saddr ${r.guestIp} jump glyph_egress`);
  lines.push(`  }`);
  lines.push(`  chain forward {`);
  lines.push(`    type filter hook forward priority 0; policy ${r.basePolicy};`);
  lines.push(`    ip saddr ${r.guestIp} jump glyph_egress`);
  lines.push(`  }`);
  lines.push(`  chain glyph_egress {`);
  if (r.accept.length === 0) {
    lines.push(`    # deny-all: no ACCEPT exceptions (fail-closed)`);
  }
  for (const rule of r.accept) {
    const cidr = toCidr(rule.cidr);
    const fam = cidr.includes(":") ? "ip6" : "ip";
    if (rule.port === void 0) {
      lines.push(`    ${fam} daddr ${cidr} accept`);
    } else {
      const proto = rule.protocol ?? "tcp";
      lines.push(`    ${fam} daddr ${cidr} ${proto} dport ${rule.port} accept`);
    }
  }
  lines.push(`  }`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}
function sanitize(name) {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}
var init_firecracker_egress_rules = __esm({
  "../spikes/p0-sandbox/firecracker-egress-rules.ts"() {
    init_egress_proxy();
  }
});

// ../spikes/p0-sandbox/firecracker-netns.ts
var firecracker_netns_exports = {};
__export(firecracker_netns_exports, {
  allocRunNet: () => allocRunNet,
  compileHostIptables: () => compileHostIptables,
  liveLaunch: () => liveLaunch,
  writeRunArtifact: () => writeRunArtifact
});
import { spawn as spawn6 } from "node:child_process";
import { createConnection } from "node:net";
import { copyFile, mkdir as mkdir2, writeFile as writeFile2, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join12 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function siblingFile(name) {
  return join12(fileURLToPath2(new URL(".", import.meta.url)), name);
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve5) => {
    const child = spawn6(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer;
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("error", (e) => resolve5({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve5({ code: code ?? 1, stdout, stderr });
    });
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, opts.timeoutMs);
    }
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
async function sudo(args, opts = {}) {
  const r = await run("sudo", ["-n", ...args], opts);
  if (r.code !== 0) {
    throw new Error(`sudo ${args.join(" ")} failed (code ${r.code}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
async function fcApi(apiSock, path6, body) {
  const r = await run("sudo", [
    "-n",
    "curl",
    "-s",
    "--show-error",
    "--fail",
    "--unix-socket",
    apiSock,
    "-X",
    "PUT",
    `http://localhost${path6}`,
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify(body)
  ]);
  if (r.code !== 0) {
    throw new Error(`firecracker API ${path6} failed: ${r.stderr || r.stdout}`);
  }
}
function runIndex(runId) {
  let h = 0;
  for (let i = 0; i < runId.length; i++) h = h * 31 + runId.charCodeAt(i) & 65535;
  return h % 250 + 1;
}
function allocRunNet(runId) {
  const idx = runIndex(runId);
  return {
    idx,
    tap: `gstap${idx}`,
    hostIp: `172.30.${idx}.1`,
    guestIp: `172.30.${idx}.2`,
    netmask: "255.255.255.252",
    prefix: 30,
    cid: 3e4 + idx,
    table: `glyph_fc_${idx}`
  };
}
async function defaultEgressIface() {
  const r = await run("ip", ["route", "get", "1.1.1.1"]);
  const m = r.stdout.match(/\bdev\s+(\S+)/);
  return m ? m[1] : "eth0";
}
function compileHostIptables(net, ruleset, egressIface) {
  const forwardInsert = [];
  forwardInsert.push([
    "FORWARD",
    "-d",
    net.guestIp,
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-j",
    "ACCEPT"
  ]);
  for (const rule of ruleset.accept) {
    const dst = rule.cidr.includes("/") ? rule.cidr : rule.cidr.includes(":") ? `${rule.cidr}/128` : `${rule.cidr}/32`;
    if (dst.includes(":")) continue;
    const args = ["FORWARD", "-s", net.guestIp, "-d", dst];
    if (rule.port !== void 0) {
      args.push("-p", rule.protocol ?? "tcp", "--dport", String(rule.port));
    }
    args.push("-j", "ACCEPT");
    forwardInsert.push(args);
  }
  forwardInsert.push(["FORWARD", "-s", net.guestIp, "-j", "DROP"]);
  const natAppend = [
    ["-t", "nat", "POSTROUTING", "-s", net.guestIp, "-o", egressIface, "-j", "MASQUERADE"]
  ];
  const comment = serializeHostRules(net, forwardInsert, natAppend);
  return { forwardInsert, natAppend, comment };
}
function serializeHostRules(net, forwardInsert, natAppend) {
  const out = [`# host-side egress confinement for guest=${net.guestIp} (run idx ${net.idx})`];
  for (const r of [...forwardInsert].reverse()) out.push(`iptables -I ${r.join(" ")}`);
  for (const r of natAppend) out.push(`iptables -A ${r.join(" ")}`);
  return out.join("\n") + "\n";
}
async function provisionHost(runId, ruleset, mountPlan, resources) {
  const net = allocRunNet(runId);
  await mkdir2(FC_RUN_DIR, { recursive: true });
  const base = join12(FC_RUN_DIR, `run-${net.idx}`);
  const apiSock = `${base}.api`;
  const vsockUds = `${base}.vsock`;
  const rootfs = `${base}.ext4`;
  const logPath = `${base}.log`;
  const fcPidFile = `${base}.pid`;
  const rulesPath = `${base}.rules`;
  const egressIface = await defaultEgressIface();
  const { forwardInsert, natAppend, comment } = compileHostIptables(net, ruleset, egressIface);
  const mountImages = mountPlan.mounts.map((m) => ({
    hostPath: m.hostPath,
    guestPath: m.guestPath,
    tag: m.tag,
    readonly: m.readonly,
    imagePath: `${base}.${m.tag}.ext4`
  }));
  const handles = {
    net,
    apiSock,
    vsockUds,
    rootfs,
    logPath,
    fcPidFile,
    rulesPath,
    forwardInsert,
    natAppend,
    mountImages
  };
  await teardownHost(handles).catch(() => {
  });
  await copyFile(FC_BASE_ROOTFS, rootfs);
  await injectGuestPayload(rootfs);
  for (const m of mountImages) {
    await buildMountImage(m.hostPath, m.imagePath);
  }
  await sudo(["ip", "tuntap", "add", "dev", net.tap, "mode", "tap"]);
  await sudo(["ip", "addr", "add", `${net.hostIp}/${net.prefix}`, "dev", net.tap]);
  await sudo(["ip", "link", "set", net.tap, "up"]);
  await sudo(["sysctl", "-w", "net.ipv4.ip_forward=1"]);
  await writeFile2(rulesPath, comment);
  for (const args of [...forwardInsert].reverse()) {
    await sudo(["iptables", "-I", ...args]);
  }
  for (const args of natAppend) {
    const [tableFlag, tableName, chain, ...rest] = args;
    await sudo(["iptables", tableFlag, tableName, "-A", chain, ...rest]);
  }
  await bootFirecracker(handles, mountPlan, resources);
  await waitForAgent(vsockUds);
  return handles;
}
async function injectGuestPayload(rootfs) {
  const agentSrc = siblingFile("firecracker-guest-agent.cjs");
  const initSrc = siblingFile("firecracker-guest-init.sh");
  const mnt = join12(tmpdir(), `gs-fcmnt-${process.pid}-${Date.now()}`);
  await sudo(["mkdir", "-p", mnt]);
  try {
    await sudo(["mount", "-o", "loop", rootfs, mnt]);
    await sudo(["mkdir", "-p", join12(mnt, "opt")]);
    await sudo(["cp", agentSrc, join12(mnt, "opt", "glyph-guest-agent.cjs")]);
    await sudo(["cp", initSrc, join12(mnt, "glyph-init")]);
    await sudo(["chmod", "0755", join12(mnt, "glyph-init")]);
    await sudo(["mkdir", "-p", join12(mnt, "workspace"), join12(mnt, "home", "agent")]);
  } finally {
    await sudo(["umount", mnt]).catch(() => {
    });
    await sudo(["rmdir", mnt]).catch(() => {
    });
  }
}
async function buildMountImage(hostDir, imagePath) {
  const du = await run("du", ["-sm", hostDir]);
  const usedMb = Number.parseInt(du.stdout.split("	")[0] ?? "1", 10) || 1;
  const sizeMb = Math.max(64, Math.ceil(usedMb * 1.25) + 16);
  await writeFile2(imagePath, Buffer.alloc(0));
  await truncate(imagePath, sizeMb * 1024 * 1024);
  const r = await run("mkfs.ext4", ["-F", "-q", "-d", hostDir, imagePath]);
  if (r.code !== 0) {
    throw new Error(
      `mkfs.ext4 -d ${hostDir} -> ${imagePath} failed (code ${r.code}): ${r.stderr || r.stdout}`
    );
  }
}
async function writeBackMounts(handles) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  for (const m of handles.mountImages) {
    if (m.readonly) continue;
    try {
      await stat(m.imagePath);
    } catch {
      continue;
    }
    const mnt = join12(tmpdir(), `gs-fcwb-${process.pid}-${handles.net.idx}-${m.tag}`);
    await sudo(["mkdir", "-p", mnt]);
    try {
      await sudo(["mount", "-o", "loop", m.imagePath, mnt]);
      await sudo(["rsync", "-a", "--delete", "--exclude", "/lost+found", `${mnt}/`, `${m.hostPath}/`]);
      await sudo(["chown", "-R", `${uid}:${gid}`, m.hostPath]);
    } finally {
      await sudo(["umount", mnt]).catch(() => {
      });
      await sudo(["rmdir", mnt]).catch(() => {
      });
    }
  }
}
async function bootFirecracker(handles, _mountPlan, resources) {
  const { net, apiSock, vsockUds, rootfs, logPath, fcPidFile } = handles;
  await sudo(["rm", "-f", apiSock, vsockUds]);
  const launch = `setsid firecracker --api-sock ${apiSock} --id vm-glyph-${net.idx} >${logPath} 2>&1 & echo $! >${fcPidFile}`;
  await sudo(["sh", "-c", launch]);
  for (let i = 0; i < 100; i++) {
    try {
      await stat(apiSock);
      break;
    } catch {
      await delay(50);
    }
  }
  const guestMac = `AA:FC:00:00:${(net.idx >> 8 & 255).toString(16).padStart(2, "0")}:${(net.idx & 255).toString(16).padStart(2, "0")}`.toUpperCase();
  const bootArgs = `console=ttyS0 reboot=k panic=1 pci=off init=/glyph-init ip=${net.guestIp}::${net.hostIp}:${net.netmask}:glyph:eth0:off`;
  await fcApi(apiSock, "/boot-source", {
    kernel_image_path: FC_KERNEL,
    boot_args: bootArgs
  });
  await fcApi(apiSock, "/drives/rootfs", {
    drive_id: "rootfs",
    path_on_host: rootfs,
    is_root_device: true,
    is_read_only: false
  });
  for (const m of handles.mountImages) {
    await fcApi(apiSock, `/drives/${m.tag}`, {
      drive_id: m.tag,
      path_on_host: m.imagePath,
      is_root_device: false,
      is_read_only: m.readonly
    });
  }
  await fcApi(apiSock, "/machine-config", {
    vcpu_count: resources?.vcpus ?? DEFAULT_GUEST_VCPUS,
    mem_size_mib: resources?.memMib ?? DEFAULT_GUEST_MEM_MIB
  });
  await fcApi(apiSock, "/network-interfaces/eth0", {
    iface_id: "eth0",
    guest_mac: guestMac,
    host_dev_name: net.tap
  });
  await fcApi(apiSock, "/vsock", { guest_cid: net.cid, uds_path: vsockUds });
  await fcApi(apiSock, "/actions", { action_type: "InstanceStart" });
  for (let i = 0; i < 100; i++) {
    try {
      await stat(vsockUds);
      break;
    } catch {
      await delay(50);
    }
  }
  await sudo(["chmod", "0666", vsockUds]).catch(() => {
  });
}
function connectVsock(vsockUds, timeoutMs = 15e3) {
  return new Promise((resolve5, reject) => {
    const sock = createConnection(vsockUds, () => {
      sock.write(`CONNECT ${GUEST_VSOCK_PORT}
`);
    });
    let acc = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`vsock handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (d) => {
      acc = Buffer.concat([acc, d]);
      const nl = acc.indexOf(10);
      if (nl === -1) return;
      const line = acc.subarray(0, nl).toString("utf8");
      if (line.startsWith("OK")) {
        settled = true;
        clearTimeout(timer);
        sock.removeListener("data", onData);
        resolve5({ socket: sock, leftover: acc.subarray(nl + 1) });
      } else {
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        reject(new Error(`vsock handshake refused: ${line}`));
      }
    };
    sock.on("data", onData);
    sock.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}
async function waitForAgent(vsockUds, timeoutMs = 6e4) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never connected";
  while (Date.now() < deadline) {
    try {
      const { socket } = await connectVsock(vsockUds, 3e3);
      socket.destroy();
      return;
    } catch (e) {
      lastErr = String(e.message ?? e);
      await delay(500);
    }
  }
  throw new Error(`guest agent never became ready on ${vsockUds}: ${lastErr}`);
}
async function execOverVsock(vsockUds, req) {
  const { socket, leftover } = await connectVsock(vsockUds);
  return new Promise((resolve5, reject) => {
    let acc = leftover;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.on("data", (d) => {
      acc = Buffer.concat([acc, d]);
      let frames;
      try {
        ({ frames, rest: acc } = decodeFrames(acc));
      } catch (e) {
        finish(() => reject(e));
        return;
      }
      if (frames.length > 0) finish(() => resolve5(frames[0]));
    });
    socket.on("error", (e) => finish(() => reject(e)));
    socket.on("close", () => finish(() => reject(new Error("vsock closed before a result frame"))));
    socket.write(encodeFrame(req));
  });
}
async function teardownHost(handles, opts = {}) {
  const { net, apiSock, vsockUds, rootfs, fcPidFile, rulesPath, forwardInsert, natAppend } = handles;
  await run("sudo", ["-n", "sh", "-c", `[ -f ${fcPidFile} ] && kill -9 $(cat ${fcPidFile}) 2>/dev/null; true`]);
  await run("sudo", ["-n", "pkill", "-9", "-f", `vm-glyph-${net.idx}`]);
  let writeBackError;
  if (opts.writeBack) {
    await writeBackMounts(handles).catch((e) => {
      writeBackError = e;
    });
  }
  for (const args of forwardInsert) {
    await run("sudo", ["-n", "iptables", "-D", ...args]);
  }
  for (const args of natAppend) {
    const [tableFlag, tableName, chain, ...rest] = args;
    await run("sudo", ["-n", "iptables", tableFlag, tableName, "-D", chain, ...rest]);
  }
  await run("sudo", ["-n", "ip", "link", "del", net.tap]);
  const mountImagePaths = handles.mountImages.map((m) => m.imagePath);
  await run("sudo", ["-n", "rm", "-f", apiSock, vsockUds, rootfs, fcPidFile, rulesPath, ...mountImagePaths]);
  if (writeBackError) {
    throw new Error(`teardown completed but mount write-back failed: ${writeBackError.message}`);
  }
}
async function liveLaunch(args) {
  const { runId, ruleset, mountPlan, resources } = args;
  void serializeNftRuleset(ruleset);
  const handles = await provisionHost(runId, ruleset, mountPlan, resources);
  let closed = false;
  return {
    async exec(req) {
      if (closed) return { exitCode: 1, stdout: "", stderr: "transport closed" };
      return execOverVsock(handles.vsockUds, req);
    },
    async close() {
      if (closed) return;
      closed = true;
      await teardownHost(handles, { writeBack: true });
    }
  };
}
async function writeRunArtifact(name, contents) {
  const dir = join12(tmpdir(), "glyph-fc-artifacts");
  await mkdir2(dir, { recursive: true });
  const p = join12(dir, name);
  await writeFile2(p, contents);
  return p;
}
var FC_KERNEL, FC_BASE_ROOTFS, FC_RUN_DIR, GUEST_VSOCK_PORT, delay;
var init_firecracker_netns = __esm({
  "../spikes/p0-sandbox/firecracker-netns.ts"() {
    init_firecracker_egress_rules();
    init_firecracker_vsock();
    FC_KERNEL = process.env.GLYPHSTUDIO_FC_KERNEL ?? "/opt/firecracker/kernels/vmlinux-5.10";
    FC_BASE_ROOTFS = process.env.GLYPHSTUDIO_FC_ROOTFS ?? "/opt/firecracker/rootfs/build-small.ext4";
    FC_RUN_DIR = process.env.GLYPHSTUDIO_FC_RUN_DIR ?? join12(tmpdir(), "glyph-fc-runs");
    GUEST_VSOCK_PORT = 5e3;
    delay = (ms) => new Promise((r) => setTimeout(r, ms));
  }
});

// ../spikes/p0-sandbox/firecracker-vsock.ts
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(
      `encodeFrame: frame body of ${body.length} bytes exceeds the ${MAX_FRAME_BYTES}-byte limit`
    );
  }
  const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (buf.length - offset >= LENGTH_PREFIX_BYTES) {
    const len = buf.readUInt32BE(offset);
    if (len > MAX_FRAME_BYTES) {
      throw new Error(
        `decodeFrames: frame length ${len} exceeds the ${MAX_FRAME_BYTES}-byte limit`
      );
    }
    const bodyStart = offset + LENGTH_PREFIX_BYTES;
    const bodyEnd = bodyStart + len;
    if (bodyEnd > buf.length) break;
    const body = buf.subarray(bodyStart, bodyEnd).toString("utf8");
    frames.push(JSON.parse(body));
    offset = bodyEnd;
  }
  const rest = Buffer.from(buf.subarray(offset));
  return { frames, rest };
}
function guestResources(spec) {
  const limits = spec.resourceLimits;
  const vcpusRaw = limits?.cpus ?? DEFAULT_GUEST_VCPUS;
  const memRaw = limits?.memoryMb ?? DEFAULT_GUEST_MEM_MIB;
  const vcpus = Math.max(1, Math.min(MAX_GUEST_VCPUS, Math.floor(vcpusRaw) || 1));
  const memMib = Math.max(
    MIN_GUEST_MEM_MIB,
    Math.min(MAX_GUEST_MEM_MIB, Math.floor(memRaw) || DEFAULT_GUEST_MEM_MIB)
  );
  return { vcpus, memMib };
}
var MAX_FRAME_BYTES, LENGTH_PREFIX_BYTES, DEFAULT_GUEST_VCPUS, DEFAULT_GUEST_MEM_MIB, MAX_GUEST_VCPUS, MAX_GUEST_MEM_MIB, MIN_GUEST_MEM_MIB, realVsockLauncher;
var init_firecracker_vsock = __esm({
  "../spikes/p0-sandbox/firecracker-vsock.ts"() {
    MAX_FRAME_BYTES = 64 * 1024 * 1024;
    LENGTH_PREFIX_BYTES = 4;
    DEFAULT_GUEST_VCPUS = 1;
    DEFAULT_GUEST_MEM_MIB = 256;
    MAX_GUEST_VCPUS = 8;
    MAX_GUEST_MEM_MIB = 8192;
    MIN_GUEST_MEM_MIB = 128;
    realVsockLauncher = async (args) => {
      if (process.platform !== "linux") {
        throw new Error(
          `FirecrackerSandboxRuntime live VM bring-up requires Linux+KVM \u2014 refusing to provision on platform '${process.platform}'.`
        );
      }
      const { liveLaunch: liveLaunch2 } = await Promise.resolve().then(() => (init_firecracker_netns(), firecracker_netns_exports));
      return liveLaunch2({
        runId: args.spec.runId,
        ruleset: args.ruleset,
        mountPlan: args.mountPlan,
        resources: guestResources(args.spec)
      });
    };
  }
});

// ../spikes/p0-supervisor/bridge-server.ts
import { createHash as createHash9 } from "node:crypto";
import { existsSync as existsSync9, readFileSync as readFileSync8, statSync as statSync4, realpathSync } from "node:fs";
import { spawnSync as spawnSync2 } from "node:child_process";
import { join as join17, resolve as resolve4 } from "node:path";

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
function validateDefaultVerb(value, path6, errors) {
  if (typeof value !== "string" || !POLICY_DEFAULT_VERBS.includes(value)) {
    errors.push(
      `${path6} must be one of ${POLICY_DEFAULT_VERBS.join(" | ")}, got ${describe(value)}`
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
function requestedEgressMode(spec) {
  return spec.network === "deny" ? "hard-deny" : spec.network.egressMode;
}
function negotiateEgress(runtime, spec) {
  const requested = requestedEgressMode(spec);
  const supported = typeof runtime.supportedEgressModes === "function" ? runtime.supportedEgressModes() : ["hard-deny"];
  if (supported.includes(requested)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `runtime '${runtime.name}' cannot honor egressMode '${requested}': it supports only [${supported.join(", ")}]. Refusing to provision rather than silently downgrading the egress guarantee.`
  };
}
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
var BRIDGE_JSONRPC = "glyphstudio-jsonrpc/1";
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
  ChatSend: "chat/send",
  /**
   * DISCOVER the chat backends this supervisor can route a {@link ChatSend} turn
   * to (the model-picker surface). SYNCHRONOUS request/result: the supervisor
   * PROBES each known backend AT REQUEST TIME and reports an HONEST per-backend
   * status — `'ok'` only when the probe succeeded (codex: its binary resolves on
   * PATH; ollama: the local daemon answered) and `'unavailable'` with a short
   * non-secret `detail` otherwise. `models` lists the LOCAL backend's installed
   * model names (capped; names only) when the probe succeeded; a frontier CLI
   * backend that picks its own model omits it. NO PHANTOM BACKENDS: the result
   * never lists a backend the supervisor cannot actually route to, and never
   * invents a model name. Carries non-secret ids/names only, NEVER a credential.
   */
  ChatBackends: "chat/backends",
  /**
   * Fetch one explicit http(s) URL for `@Web` chat context. Synchronous
   * request/result, handled supervisor-side only: the extension never fetches web
   * content directly. The supervisor refuses unless a governed chat session already
   * exists, then fetches through that session's governed egress proxy and appends
   * metadata + content hash to the run trace. Result text is untrusted context data;
   * raw body is never persisted to trace.
   */
  WebFetch: "web/fetch",
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
   * RESPOND to a PENDING approval (remote-control: the phone's `approvals.respond`;
   * desktop: the MCP approval modal). Two pending-approval kinds resolve here:
   *   - a PENDING governed build: a build request created via
   *     {@link AgenticBuildStart} WITHOUT `approved:true` is held as a pending
   *     approval (codex NOT spawned) rather than refused. On `allow`, the
   *     supervisor GRANTS the authority and starts the held build down the SAME
   *     approved path (`approved:true`) — governed codex edits files + the signed
   *     verdict streams. On `deny`, the pending build is DISCARDED (a terminal
   *     `build/event` error, no codex).
   *   - a HELD `mcp/call` (#9 Slice 2): an ask/force_ask policy decision parks
   *     the brokered MCP call (surfaced via the mirrored `approval_requested`
   *     trace event) until this RPC's verdict — `allow` executes it exactly like
   *     an up-front allow; `deny` (or the supervisor's approval timeout) yields
   *     an honest 'denied' {@link McpCallResult}.
   * The result is only the ACK ({ approvalId, decision, runId? }). Additive:
   * a direct `build/start {approved:true}` still starts immediately as today.
   */
  ApprovalRespond: "approval/respond",
  /**
   * Retrieve top-k chunks from the workspace's LOCAL code index (@Codebase repo-aware
   * retrieval). SYNCHRONOUS request/result (NOT ack-then-stream): the supervisor
   * lazily builds the on-device index for `workspaceRoot` on first use (Ollama/ONNX
   * embedder + brute-force store, memory-only residency), embeds `query`, and returns
   * the top-k cosine-similar chunks ({path,startLine,endLine,text,score}). Everything
   * is LOCAL by construction — nothing in the index path egresses code (contrast
   * Cursor's server-side embedding). The result carries non-secret repo SNIPPETS
   * (already secret-redacted at chunk time), NEVER a credential. Retrieval MUST be
   * best-effort and NON-fatal: on ANY error (e.g. embedder daemon down, build failure)
   * the result is `{ ok:false, hits:[] }` so chat falls back to NO repo context rather
   * than failing the turn.
   */
  IndexRetrieve: "index/retrieve",
  /**
   * BUILD (or rebuild) the workspace's LOCAL code index on demand (the no-CLI "Index
   * Workspace" experience). SYNCHRONOUS request/result: the supervisor builds (or
   * incrementally rebuilds) the SESSION'S OWN on-device index for `workspaceRoot` and
   * returns the {@link IndexStats} (files / chunks / embedded / reused / embedMs /
   * totalMs). Session-bound EXACTLY like {@link IndexRetrieve}: it refuses before a
   * completed handshake and refuses any `workspaceRoot` that does not resolve to the
   * session's bound root — it shares the SAME per-workspace server-side index the chat
   * retrieval + repo-aware FIM use (never a parallel index). `persist` opts the build
   * into the 'workspace-encrypted' residency (an encrypted, workspace-local snapshot
   * that survives session restarts) instead of the memory-only default. Everything is
   * LOCAL — nothing egresses code. Best-effort: on ANY error the result is
   * `{ ok:false }` with a short non-secret `error` (the command path never throws).
   */
  IndexBuild: "index/build",
  /**
   * INCREMENTALLY UPDATE the workspace's LOCAL code index from a batch of saved/
   * watched file changes (the index-freshness loop). SYNCHRONOUS request/result:
   * the supervisor filters the batch through the SAME discovery/ignore gates a full
   * build uses (hard secret denylist, root .gitignore/.glyphstudioignore, text-source
   * allowlist, size/binary caps), re-chunks the surviving changed files, re-embeds
   * ONLY the windows whose content hash differs (per-window-hash diff — unchanged
   * sibling windows keep their vectors), and EVICTS windows for deleted files.
   * Session-bound EXACTLY like {@link IndexRetrieve}/{@link IndexBuild} (completed-
   * handshake gate + the same canonical session-root binding) and it only ever
   * updates the EXISTING per-workspace server-side index — when no index has been
   * built for the session yet, it refuses (`{ ok:false }`) rather than triggering a
   * cold build. Memory-only mutation: an encrypted persisted snapshot (if any) is
   * refreshed by the NEXT full `index/build`, not by this RPC. Everything is LOCAL —
   * nothing egresses code. Best-effort: on ANY error the result is `{ ok:false }`
   * with a short non-secret `error` (the watch path never throws and never toasts).
   */
  IndexUpdate: "index/update",
  /**
   * Start a GOVERNED CHANGE REVIEW (#7 — "Review Changes (Verifier-Backed)"): ONE
   * governed run over the workspace's PROPOSED state (the working tree, or a branch
   * vs a base ref) producing a signed review artifact with TWO never-blurring
   * layers — ADVISORY model findings plus the deterministic INDEPENDENT-VERIFIER
   * verdict over the proposed state. COMPOSITION RULE: the `review_findings` trace
   * event is appended BEFORE the verifier runs, so the signed verdict's
   * `traceRootHash` COMMITS to the findings — tampering breaks the chain (see the
   * ordering invariant in trace.ts). Findings are OPINIONS and never carry or
   * influence assurance vocabulary. Mirrors build/start's ack-then-notifications
   * style: the RESULT is only the ACK ({ runId }); the review STREAMS back as
   * {@link BridgeNotification.ChangeReviewEvent} notifications, the terminal
   * `result` carrying the {@link ChangeReview} render contract. Read-only over the
   * proposed state (no authority grant needed: the reviewer edits nothing); carries
   * no credential.
   */
  ChangeReviewStart: "review/start",
  /**
   * Start a GOVERNED PLAN RUN (#8 — plan mode): pre-build governed planning. The
   * supervisor mints a run + hash-chained trace, runs ONE governed READ-ONLY model
   * turn producing a structured {@link BuildPlan}, appends the `plan_proposed`
   * trace event, and PARKS the run (the PendingBuild idiom) — no file is edited and
   * no build starts. The user reviews/edits the plan in the IDE; a later
   * {@link BridgeMethod.AgenticBuildStart} with the SAME `runId` carrying a
   * `planApproval` resolves the parked run (the server mints the approvalId and
   * appends `plan_approved` BEFORE executing, so the build runs on the SAME trace
   * and the verifier verdict root-binds the whole plan history — see the ordering
   * invariant in trace.ts), or a {@link BridgeMethod.BuildPlanReject} appends
   * `plan_rejected` and closes the run. A plan is MODEL OPINION: advisory,
   * tamper-evident via the chain, NEVER an assurance input. Mirrors review/start's
   * ack-then-notifications style: the RESULT is only the ACK ({ runId }); the plan
   * STREAMS back as {@link BridgeNotification.BuildPlanEvent} notifications, the
   * terminal `result` carrying the {@link BuildPlanProposal} render contract.
   * Read-only over the workspace (no authority grant needed: the planner edits
   * nothing); carries no credential.
   */
  BuildPlanStart: "plan/start",
  /**
   * REJECT a PARKED plan run (#8). The supervisor appends the `plan_rejected`
   * trace event (with the optional non-secret reason) and closes the run — no
   * build ever starts on it. The result is only the ACK ({ runId, rejected }).
   * Mirrors run/cancel's lightweight params/ack shape conventions.
   */
  BuildPlanReject: "plan/reject",
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
   * names/descriptions only, NEVER a credential (server env, including any
   * tokens, is configured supervisor-side and never crosses this wire).
   */
  McpList: "mcp/list",
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
   */
  McpCall: "mcp/call",
  /**
   * APPEND one HUMAN-ORIGIN event to a run's hash-chained trace (#10 Slice 1 —
   * the apply/diff decision + session-checkpoint record path). SYNCHRONOUS
   * request/result: the supervisor appends EXACTLY ONE event of the requested
   * {@link RecordHumanParams.type} to the run's trace — through the run's LIVE
   * TraceWriter when the run is still open, or by REHYDRATING the persisted
   * trace.jsonl tail (adopting its hash/seq as the chain position) when the run
   * has already closed — and returns the appended event's chain position
   * ({ ok, seq, hash }): EVIDENCE the append really happened, not a claim.
   *
   * TRUST POSTURE: `source` is FORCED to 'human' SERVER-SIDE — a client cannot
   * mint a supervisor/verifier-attributed event through this RPC. The payload
   * is DATA, NOT AUTHORITY: a human event can never carry a verdict, never
   * counts as verifier evidence, and never changes a run's assurance level
   * (see the TraceEventSource invariants in trace.ts). Appends are REFUSED
   * with an honest JSON-RPC error — NEVER a silent success — for an unknown
   * runId, a missing trace file, or an unparseable/tamper-suspect chain tail
   * (a tail whose last line cannot be parsed or lacks its hash-chain fields).
   */
  RecordHuman: "run/recordHuman"
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
  AgenticBuildEvent: "build/event",
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
  IndexProgress: "index/progress",
  /**
   * One change-review stream event (#7). After a
   * {@link BridgeMethod.ChangeReviewStart} ack, the supervisor emits a sequence of
   * these tagged with the same `runId`: `state` lifecycle markers, then exactly one
   * terminal `result` (carrying the {@link ChangeReview} render contract — advisory
   * findings + the signed verifier verdict) or `error`. The payload is a
   * {@link ChangeReviewStreamEvent} — the review event discriminated union plus the
   * `runId`. Carries non-secret review EVIDENCE (findings/verdict), never a
   * credential.
   */
  ChangeReviewEvent: "review/event",
  /**
   * One plan-run stream event (#8). After a {@link BridgeMethod.BuildPlanStart}
   * ack, the supervisor emits a sequence of these tagged with the same `runId`:
   * `state` lifecycle markers, an optional `plan` event carrying the parsed
   * {@link BuildPlan} as soon as it exists, then exactly one terminal `result`
   * (the run is now PARKED awaiting approval/rejection; carries the
   * {@link BuildPlanProposal} render contract) or `error`. The payload is a
   * {@link BuildPlanStreamEvent} — the plan event discriminated union plus the
   * `runId`. Carries non-secret plan TEXT (goal/steps/risks the UI renders),
   * never a credential.
   */
  BuildPlanEvent: "plan/event"
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
function isShapeObj(o) {
  return typeof o === "object" && o !== null && !Array.isArray(o);
}
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
function assertBuildReviewVerdictWellFormed(verdict) {
  const problems = [];
  if (!isShapeObj(verdict)) return { ok: false, problems: ["not-an-object"] };
  const overall = verdict.overall;
  if (overall !== "pass" && overall !== "fail" && overall !== "error") {
    problems.push("verdict.overall");
  }
  const assurance = verdict.assurance;
  if (assurance !== "full" && assurance !== "degraded") {
    problems.push("verdict.assurance");
  }
  const isolation = verdict.verifierIsolation;
  if (isolation !== "inline-unsandboxed" && isolation !== "independent-sandboxed") {
    problems.push("verdict.verifierIsolation");
  }
  if (!shapeNonEmptyString(verdict.traceRootHash)) problems.push("verdict.traceRootHash");
  if (assurance === "full") {
    if (isolation !== "independent-sandboxed") {
      problems.push("assurance:full-requires-independent-sandboxed");
    }
    if (verdict.verifyRan !== true) {
      problems.push("assurance:full-requires-verifyRan");
    }
    if (overall === "error") {
      problems.push("assurance:full-cannot-be-error");
    }
    if (!isBuildVerdictSignaturePresent(verdict.signature)) {
      problems.push("assurance:full-requires-signature");
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}
var CHANGE_REVIEW_SCOPES = [
  "working-tree",
  "branch"
];
var CHANGE_REVIEW_PARSE_STATUSES = [
  "ok",
  "parse-failed",
  "unavailable"
];
function assertChangeReviewWellFormed(review) {
  if (!isShapeObj(review)) return { ok: false, problems: ["not-an-object"] };
  const problems = [];
  if (!shapeNonEmptyString(review.runId)) problems.push("review.runId");
  if (!CHANGE_REVIEW_SCOPES.includes(review.scope)) {
    problems.push("review.scope");
  }
  if (!shapeNonEmptyString(review.diffSha256)) problems.push("review.diffSha256");
  const findings = review.findings;
  if (!isShapeObj(findings)) {
    problems.push("review.findings");
  } else {
    if (findings.advisory !== true) problems.push("review.findings.advisory");
    if (!CHANGE_REVIEW_PARSE_STATUSES.includes(
      findings.parseStatus
    )) {
      problems.push("review.findings.parseStatus");
    }
    if (!Array.isArray(findings.items)) problems.push("review.findings.items");
  }
  if (!isShapeObj(review.verdict)) {
    problems.push("review.verdict");
  } else {
    const verdict = assertBuildReviewVerdictWellFormed(review.verdict);
    if (verdict.ok === false) problems.push(...verdict.problems);
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}
var PLAN_PARSE_STATUSES = [
  "ok",
  "parse-failed",
  "unavailable"
];
var MAX_PLAN_STEPS = 20;
var MAX_PLAN_GOAL_CHARS = 300;
var MAX_PLAN_STEP_TITLE_CHARS = 120;
var MAX_PLAN_STEP_DETAIL_CHARS = 600;
var MAX_PLAN_RISKS = 10;
var MAX_PLAN_RISK_CHARS = 300;
var MAX_PLAN_FILES_PER_STEP = 10;
var MAX_PLAN_FILE_CHARS = 260;
function planPathLooksAbsolute(p) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
function planPathHasTraversal(p) {
  return p.split(/[\\/]/).some((seg) => seg === "..");
}
function assertBuildPlanWellFormed(plan) {
  if (!isShapeObj(plan)) {
    throw new Error("malformed BuildPlan: not-an-object");
  }
  const problems = [];
  if (!shapeNonEmptyString(plan.goal)) {
    problems.push("plan.goal");
  } else if (plan.goal.length > MAX_PLAN_GOAL_CHARS) {
    problems.push("plan.goal.over-cap");
  }
  if (!Array.isArray(plan.steps)) {
    problems.push("plan.steps");
  } else if (plan.steps.length === 0) {
    problems.push("plan.steps.empty");
  } else if (plan.steps.length > MAX_PLAN_STEPS) {
    problems.push("plan.steps.over-cap");
  } else {
    plan.steps.forEach((step, i) => {
      if (!isShapeObj(step)) {
        problems.push(`plan.steps[${i}]`);
        return;
      }
      if (!shapeNonEmptyString(step.title)) {
        problems.push(`plan.steps[${i}].title`);
      } else if (step.title.length > MAX_PLAN_STEP_TITLE_CHARS) {
        problems.push(`plan.steps[${i}].title.over-cap`);
      }
      if (!shapeNonEmptyString(step.detail)) {
        problems.push(`plan.steps[${i}].detail`);
      } else if (step.detail.length > MAX_PLAN_STEP_DETAIL_CHARS) {
        problems.push(`plan.steps[${i}].detail.over-cap`);
      }
      if (step.files !== void 0) {
        if (!Array.isArray(step.files)) {
          problems.push(`plan.steps[${i}].files`);
        } else if (step.files.length > MAX_PLAN_FILES_PER_STEP) {
          problems.push(`plan.steps[${i}].files.over-cap`);
        } else {
          step.files.forEach((file, j) => {
            if (typeof file !== "string" || file.trim().length === 0 || file.length > MAX_PLAN_FILE_CHARS || planPathLooksAbsolute(file) || planPathHasTraversal(file)) {
              problems.push(`plan.steps[${i}].files[${j}]`);
            }
          });
        }
      }
    });
  }
  if (plan.risks !== void 0) {
    if (!Array.isArray(plan.risks)) {
      problems.push("plan.risks");
    } else if (plan.risks.length > MAX_PLAN_RISKS) {
      problems.push("plan.risks.over-cap");
    } else {
      plan.risks.forEach((risk, i) => {
        if (typeof risk !== "string" || risk.trim().length === 0) {
          problems.push(`plan.risks[${i}]`);
        } else if (risk.length > MAX_PLAN_RISK_CHARS) {
          problems.push(`plan.risks[${i}].over-cap`);
        }
      });
    }
  }
  if (problems.length > 0) {
    throw new Error(`malformed BuildPlan: ${problems.join(", ")}`);
  }
}
var MAX_MCP_SERVERS = 16;
var MAX_MCP_TOOLS_PER_SERVER = 64;
var MAX_MCP_SERVER_NAME_CHARS = 64;
var MAX_MCP_TOOL_NAME_CHARS = 128;
var MAX_MCP_ARGS_JSON_BYTES = 32768;
var MAX_MCP_RESULT_JSON_BYTES = 262144;
function mcpCapability(server2, tool) {
  return `mcp/${server2}/${tool}`;
}
function mcpUtf8ByteLength(s) {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.codePointAt(i);
    if (code <= 127) bytes += 1;
    else if (code <= 2047) bytes += 2;
    else if (code <= 65535) bytes += 3;
    else {
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
}
function assertMcpCallWellFormed(call) {
  if (!isShapeObj(call)) {
    throw new Error("malformed McpCallParams: not-an-object");
  }
  const problems = [];
  if (!shapeNonEmptyString(call.server)) {
    problems.push("call.server");
  } else if (call.server.length > MAX_MCP_SERVER_NAME_CHARS) {
    problems.push("call.server.over-cap");
  }
  if (!shapeNonEmptyString(call.tool)) {
    problems.push("call.tool");
  } else if (call.tool.length > MAX_MCP_TOOL_NAME_CHARS) {
    problems.push("call.tool.over-cap");
  }
  if (typeof call.argsJson !== "string") {
    problems.push("call.argsJson");
  } else if (mcpUtf8ByteLength(call.argsJson) > MAX_MCP_ARGS_JSON_BYTES) {
    problems.push("call.argsJson.over-cap");
  } else {
    let parsed;
    let parseFailed = false;
    try {
      parsed = JSON.parse(call.argsJson);
    } catch {
      parseFailed = true;
    }
    if (parseFailed) {
      problems.push("call.argsJson.not-json");
    } else if (!isShapeObj(parsed)) {
      problems.push("call.argsJson.not-object");
    }
  }
  if (problems.length > 0) {
    throw new Error(`malformed McpCallParams: ${problems.join(", ")}`);
  }
}
var RECORD_HUMAN_EVENT_TYPES = [
  "human_accepted",
  "human_rejected",
  "human_corrected_output",
  "checkpoint_created",
  "checkpoint_restored"
];
var MAX_RECORD_HUMAN_PAYLOAD_BYTES = 16384;
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
  return typeof value === "object" && value !== null && value.glyphstudio === BRIDGE_JSONRPC;
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
function readTrace(path6) {
  if (!existsSync(path6)) return [];
  const raw = readFileSync(path6, "utf8");
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
        `readTrace: invalid JSON on line ${i + 1} of ${path6}: ${err.message}`
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
function loadPolicy(path6) {
  const ext = extname(path6).toLowerCase();
  if (ext === ".yml" || ext === ".yaml") {
    throw new Error(`P0 uses JSON policy; convert ${path6}`);
  }
  let text;
  try {
    text = readFileSync2(path6, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { errors: [`could not read policy file ${path6}: ${reason}`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { errors: [`policy file ${path6} is not valid JSON: ${reason}`] };
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

// ../spikes/p0-supervisor/network-allowlist.ts
function networkSpecFromPolicy(policy, opts = {}) {
  const allow = dedupeHosts(policy.allow.network);
  if (allow.length === 0) {
    return "deny";
  }
  return {
    allow,
    egressMode: opts.hard ? "hard-allowlist" : "soft-proxy-allow"
  };
}
function splitHostPortEntry(entry) {
  const trimmed = entry.trim();
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { host: trimmed };
  const portStr = trimmed.slice(idx + 1);
  if (/^\d+$/.test(portStr)) return { host: trimmed.slice(0, idx), port: Number(portStr) };
  return { host: trimmed };
}
function networkAllowMatches(allow, host, port) {
  const target = host.trim().toLowerCase();
  for (const entry of allow) {
    const { host: aHost, port: aPort } = splitHostPortEntry(entry);
    if (aHost.toLowerCase() !== target) continue;
    if (aPort === void 0) return true;
    if (aPort === port) return true;
  }
  return false;
}
function dedupeHosts(hosts) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of hosts) {
    const host = raw.trim();
    if (host.length === 0) continue;
    const key = host.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(host);
  }
  return out;
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
function readPort(payload) {
  if (typeof payload === "object" && payload !== null) {
    const p = payload.port;
    if (typeof p === "number" && Number.isInteger(p) && p > 0) return p;
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
      const path6 = readPath(request.payload);
      if (path6 !== void 0) {
        if (anyGlobMatch(policy.deny.read_paths, path6)) return "deny";
        if (anyGlobMatch(policy.allow.read_paths, path6)) return "allow";
      }
      return verbToDecision(policy.defaults.file_read);
    }
    case "file_write": {
      const path6 = readPath(request.payload);
      if (path6 !== void 0) {
        if (anyGlobMatch(policy.deny.write_paths, path6)) return "deny";
        if (anyGlobMatch(policy.allow.write_paths, path6)) return "allow";
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
      const port = readPort(request.payload);
      if (host !== void 0 && networkAllowMatches(policy.allow.network, host, port)) return "allow";
      return verbToDecision(policy.defaults.network);
    }
    case "mcp": {
      return verbToDecision(policy.defaults.mcp);
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
  const path6 = sink.path;
  if (typeof path6 === "string") return readTrace(path6);
  return [];
}
function signEphemeral(checks, overallVerdict, traceRootHash, injectedKey) {
  const privateKey = injectedKey ?? generateKeyPairSync2("ed25519").privateKey;
  return signVerdict({ checks, overallVerdict, traceRootHash }, privateKey);
}

// ../spikes/p0-supervisor/terminal-session.ts
import { join as join5 } from "node:path";
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
init_egress_proxy();
import { randomUUID as randomUUID3 } from "node:crypto";
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
  },
  // Claude on Google Vertex AI (CLAUDE_CODE_USE_VERTEX) — a company-mandated path.
  // The Vertex Claude API is a NARROW provider-API origin. Listing it here BOTH
  // allowlists egress (govern builds its allowlist from these host:443 entries) AND
  // classifies the tunnel as a model_call, so a Vertex setup runs FIRST-CLASS under
  // `glyphstudio govern -- claude` (TRUSTED posture; no --allow-ambient-env, no manual
  // --allow). global + multi-region (us/eu) hosts are pinned below; a SPECIFIC
  // single-region host ({region}-aiplatform.googleapis.com) is reached by adding one
  // `--allow {region}-aiplatform.googleapis.com:443` (still TRUSTED; it just won't
  // classify as model_call since host-matching is exact).
  { host: "aiplatform.googleapis.com", port: 443, provider: "google-vertex", model: "claude-vertex-model (boundary)", originAssurance: "narrow-api" },
  { host: "aiplatform.us.rep.googleapis.com", port: 443, provider: "google-vertex", model: "claude-vertex-model (boundary)", originAssurance: "narrow-api" },
  { host: "aiplatform.eu.rep.googleapis.com", port: 443, provider: "google-vertex", model: "claude-vertex-model (boundary)", originAssurance: "narrow-api" }
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

// ../spikes/p0-sandbox/mount-prep.ts
import { readdirSync, rmSync as rmSync2 } from "node:fs";
import { join as join4, relative, sep } from "node:path";
function toRelPosix(worktreeDir, abs) {
  return relative(worktreeDir, abs).split(sep).join("/");
}
function isDeniedRead(policy, relPath, runId) {
  const decision = decide(policy, {
    runId,
    tool: "file_read",
    payload: { path: relPath },
    provenanceLabel: "user",
    requestedCapability: `file_read:${relPath}`
  });
  return decision === "deny";
}
function walkAndMask(worktreeDir, dir, policy, runId, onMasked, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join4(dir, entry.name);
    const relPosix = toRelPosix(worktreeDir, abs);
    if (relPosix === ".git" || relPosix.startsWith(".git/")) continue;
    if (entry.isSymbolicLink()) {
      if (isDeniedRead(policy, relPosix, runId)) {
        mask(abs, relPosix, "symlink", onMasked, out);
      }
      continue;
    }
    if (entry.isDirectory()) {
      walkAndMask(worktreeDir, abs, policy, runId, onMasked, out);
      continue;
    }
    if (isDeniedRead(policy, relPosix, runId)) {
      mask(abs, relPosix, "file", onMasked, out);
    }
  }
}
function mask(abs, relPosix, kind, onMasked, out) {
  const record = { path: relPosix, decision: "deny", kind };
  out.push(record);
  if (onMasked) {
    try {
      onMasked(record);
    } catch {
    }
  }
  rmSync2(abs, { force: true });
}
function sanitizeMount(opts) {
  const { worktreeDir, policy, runId, onMasked } = opts;
  const masked = [];
  walkAndMask(worktreeDir, worktreeDir, policy, runId, onMasked, masked);
  return { masked };
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
  const sink = opts.sink ?? createTraceWriter(join5(runSubdirPath(runDir, "trace"), "trace.jsonl"));
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
  let openedRuntimeTrust = "untrusted";
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
      // Docker-local, chosen here with eyes open via egressMode:'soft-proxy-allow'
      // (the derived posture reflects it honestly). network:'deny' would be hard but
      // would also cut the actor off from its model endpoint entirely.
      network: { allow, egressMode: "soft-proxy-allow" }
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
        join5(runDir, "worktree")
      ).worktreeDir;
      let maskedCount = 0;
      sanitizeMount({
        worktreeDir,
        policy: isolation.policy,
        runId,
        onMasked: (m) => {
          maskedCount += 1;
          const payload = {
            tool: "file_read",
            requestedCapability: `file_read:${m.path}`,
            decision: m.decision,
            // The session's existing label convention for boundary-governance
            // events (egressProjector, provisioning refusal): 'tool-output'.
            provenanceLabel: "tool-output",
            path: m.path,
            // Distinguishes this HARD, provision-time structural removal from a
            // soft per-access broker decision: the file is gone from the mount.
            enforcement: "structural_mount_mask",
            kind: m.kind
          };
          appendAndStream("policy_decision", payload, "policy");
        }
      });
      void maskedCount;
      const home = createSyntheticHome(join5(runDir, "home"));
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
  return { runId, proxyUrl: proxy.url, stop, appendTraceEvent: appendAndStream };
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
      command: ["glyphstudio", "governed-terminal", "verify"],
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
  const path6 = sink.path;
  if (typeof path6 === "string") return readTrace(path6);
  return [];
}
function signTerminalVerdict(core, injectedKey) {
  const privateKey = injectedKey ?? generateKeyPairSync3("ed25519").privateKey;
  return signVerdict(core, privateKey);
}

// ../spikes/p0-governed-cli/cli-agent-launcher.ts
init_egress_proxy();
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
var PRESERVED_VERTEX_CONFIG_NAMES = [
  "CLAUDE_CODE_USE_VERTEX",
  // the use-Vertex flag
  "ANTHROPIC_VERTEX_PROJECT_ID",
  // GCP project id (an identifier, not a secret)
  "CLOUD_ML_REGION"
  // the Vertex region (global / us / eu / <region>)
];
var PRESERVED_VERTEX_CONFIG_LOWER = new Set(PRESERVED_VERTEX_CONFIG_NAMES.map((n) => n.toLowerCase()));
function isVertexConfigVar(name) {
  if (PRESERVED_VERTEX_CONFIG_LOWER.has(name.toLowerCase())) return true;
  return /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/i.test(name) || /^VERTEX_REGION_[A-Z0-9_]+$/i.test(name);
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
  if (isVertexConfigVar(name)) return true;
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
import { resolve, relative as relative2, isAbsolute } from "node:path";
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
      const persistDir = resolve(root, ".glyphstudio", "index");
      const rel = relative2(root, persistDir);
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
          { field: src.ref, reason: "excluded by .glyphstudioignore" }
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

// ../spikes/p0-supervisor/code-index/indexer.ts
import { readFile as readFile2 } from "node:fs/promises";

// ../spikes/p0-supervisor/code-index/index-crypto.ts
import {
  createCipheriv,
  createDecipheriv,
  createHash as createHash3,
  randomBytes
} from "node:crypto";
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync3,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname3, join as join6, resolve as resolve2 } from "node:path";
var ALGORITHM = "aes-256-gcm";
var KEY_BYTES = 32;
var IV_BYTES = 12;
var TAG_BYTES = 16;
function encryptBlob(key, plaintext) {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `index-crypto: key must be ${KEY_BYTES} bytes (got ${key.length})`
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}
function decryptBlob(key, blob) {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `index-crypto: key must be ${KEY_BYTES} bytes (got ${key.length})`
    );
  }
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error("index-crypto: ciphertext blob too short (missing iv/tag)");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function defaultKeyDir() {
  return join6(homedir(), ".glyphstudio", "index-keys");
}
function keyFileFor(keyDir, workspaceRoot) {
  const canonical = resolve2(workspaceRoot);
  const digest = createHash3("sha256").update(canonical).digest("hex");
  return join6(keyDir, `${digest}.key`);
}
function getWorkspaceKey(workspaceRoot, keyDir) {
  const dir = keyDir ?? defaultKeyDir();
  const keyFile = keyFileFor(dir, workspaceRoot);
  if (existsSync2(keyFile)) {
    const existing = readFileSync3(keyFile);
    if (existing.length !== KEY_BYTES) {
      throw new Error(
        `index-crypto: key file ${keyFile} is ${existing.length} bytes, expected ${KEY_BYTES}`
      );
    }
    return existing;
  }
  mkdirSync4(dirname3(keyFile), { recursive: true, mode: 448 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyFile, key, { mode: 384 });
  return key;
}

// ../spikes/p0-supervisor/code-index/persisted-store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync as existsSync3 } from "node:fs";
import { join as join7 } from "node:path";
var INDEX_FILE = "index.enc";
var MAGIC = Buffer.from("GSI2", "ascii");
var MAGIC_LEGACY = Buffer.from("GSI1", "ascii");
function isSnapshotable(store) {
  return !Array.isArray(store) && typeof store.snapshot === "function";
}
function chunksOf(store) {
  if (Array.isArray(store)) {
    return store;
  }
  if (isSnapshotable(store)) {
    return store.snapshot();
  }
  throw new Error(
    "persisted-store: a VectorStore must expose snapshot() to be persisted; pass the EmbeddedChunk[] directly instead"
  );
}
function serializeChunks(chunks, embedderId) {
  const dims = chunks.length > 0 ? chunks[0].vector.length : 0;
  const embedderIdBuf = Buffer.from(embedderId, "utf8");
  const parts = [];
  const header = Buffer.allocUnsafe(4 + 4 + embedderIdBuf.length + 4 + 4);
  let h = 0;
  MAGIC.copy(header, h);
  h += 4;
  header.writeUInt32LE(embedderIdBuf.length, h);
  h += 4;
  embedderIdBuf.copy(header, h);
  h += embedderIdBuf.length;
  header.writeUInt32LE(dims, h);
  h += 4;
  header.writeUInt32LE(chunks.length, h);
  h += 4;
  parts.push(header);
  for (const chunk of chunks) {
    if (chunk.vector.length !== dims) {
      throw new Error(
        `persisted-store: inconsistent vector dims (${chunk.vector.length} vs ${dims}) for chunk ${chunk.id}`
      );
    }
    const id = Buffer.from(chunk.id, "utf8");
    const path6 = Buffer.from(chunk.path, "utf8");
    const hash = Buffer.from(chunk.hash, "utf8");
    const text = Buffer.from(chunk.text, "utf8");
    const fixed = Buffer.allocUnsafe(4 * 6);
    let o = 0;
    fixed.writeUInt32LE(id.length, o);
    o += 4;
    fixed.writeUInt32LE(path6.length, o);
    o += 4;
    fixed.writeUInt32LE(chunk.startLine >>> 0, o);
    o += 4;
    fixed.writeUInt32LE(chunk.endLine >>> 0, o);
    o += 4;
    fixed.writeUInt32LE(hash.length, o);
    o += 4;
    fixed.writeUInt32LE(text.length, o);
    o += 4;
    const vec = Buffer.allocUnsafe(dims * 4);
    for (let i = 0; i < dims; i++) {
      vec.writeFloatLE(chunk.vector[i], i * 4);
    }
    parts.push(fixed, id, path6, hash, text, vec);
  }
  return Buffer.concat(parts);
}
function deserializeChunks(buf) {
  if (buf.length < 16 || !buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error("persisted-store: bad snapshot magic (not a GSI2 blob)");
  }
  let off = 4;
  const need = (n) => {
    if (off + n > buf.length) {
      throw new Error("persisted-store: truncated snapshot");
    }
  };
  need(4);
  const embedderIdLen = buf.readUInt32LE(off);
  off += 4;
  need(embedderIdLen);
  const embedderId = buf.toString("utf8", off, off + embedderIdLen);
  off += embedderIdLen;
  need(4);
  const dims = buf.readUInt32LE(off);
  off += 4;
  need(4);
  const count = buf.readUInt32LE(off);
  off += 4;
  const chunks = [];
  for (let c = 0; c < count; c++) {
    need(4 * 6);
    const idLen = buf.readUInt32LE(off);
    off += 4;
    const pathLen = buf.readUInt32LE(off);
    off += 4;
    const startLine = buf.readUInt32LE(off);
    off += 4;
    const endLine = buf.readUInt32LE(off);
    off += 4;
    const hashLen = buf.readUInt32LE(off);
    off += 4;
    const textLen = buf.readUInt32LE(off);
    off += 4;
    need(idLen);
    const id = buf.toString("utf8", off, off + idLen);
    off += idLen;
    need(pathLen);
    const path6 = buf.toString("utf8", off, off + pathLen);
    off += pathLen;
    need(hashLen);
    const hash = buf.toString("utf8", off, off + hashLen);
    off += hashLen;
    need(textLen);
    const text = buf.toString("utf8", off, off + textLen);
    off += textLen;
    need(dims * 4);
    const vector = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
      vector[i] = buf.readFloatLE(off + i * 4);
    }
    off += dims * 4;
    chunks.push({ id, path: path6, startLine, endLine, hash, text, vector });
  }
  return { embedderId, dims, chunks };
}
async function saveIndex(opts) {
  const chunks = chunksOf(opts.store);
  const plaintext = serializeChunks(chunks, opts.embedderId);
  const blob = encryptBlob(opts.key, plaintext);
  await mkdir(opts.persistDir, { recursive: true });
  const file = join7(opts.persistDir, INDEX_FILE);
  await writeFile(file, blob);
  return file;
}
async function loadIndex(opts) {
  const file = join7(opts.persistDir, INDEX_FILE);
  if (!existsSync3(file)) {
    return null;
  }
  const blob = await readFile(file);
  const plaintext = decryptBlob(opts.key, blob);
  if (plaintext.length >= 4 && plaintext.subarray(0, 4).equals(MAGIC_LEGACY)) {
    return null;
  }
  const snapshot = deserializeChunks(plaintext);
  if (snapshot.embedderId !== opts.expectedEmbedderId || snapshot.dims !== opts.expectedDims) {
    return null;
  }
  return snapshot.chunks;
}

// ../spikes/p0-supervisor/code-index/indexer.ts
var DEFAULT_EMBED_PROGRESS_BATCH = 64;
async function buildIndex(opts) {
  const totalStart = performance.now();
  const { workspaceRoot, embedder, store } = opts;
  const report = (p) => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress(p);
    } catch {
    }
  };
  const policy = opts.residency ?? { residency: "memory-only", highSecurity: false };
  const wantsEncryptedPersist = policy.residency === "workspace-encrypted" && !policy.highSecurity;
  const persistKey = wantsEncryptedPersist && policy.workspaceRoot ? getWorkspaceKey(policy.workspaceRoot, opts.keyDir) : void 0;
  const decision = resolveIndexResidency({
    policy,
    encryptAtRest: persistKey ? (plaintext) => encryptAtRestHook(persistKey, plaintext) : void 0
  });
  if (decision.effective === "disabled") {
    return {
      files: 0,
      chunks: 0,
      embedded: 0,
      reused: 0,
      embedMs: 0,
      totalMs: performance.now() - totalStart,
      embedderId: embedder.id,
      residency: decision.effective
    };
  }
  const loadedById = /* @__PURE__ */ new Map();
  if (decision.persists && decision.persistDir && persistKey) {
    const prior = await loadIndex({
      persistDir: decision.persistDir,
      key: persistKey,
      expectedEmbedderId: embedder.id,
      expectedDims: embedder.dims
    });
    if (prior && prior.length > 0) {
      store.upsert(prior);
      for (const chunk of prior) {
        loadedById.set(chunk.id, chunk);
      }
    }
  }
  report({ phase: "discover", done: 0, total: 1 });
  const loadChunks = opts.loadChunks ?? defaultLoadChunks;
  const freshChunks = await loadChunks(
    workspaceRoot,
    opts.discoverOptions,
    opts.chunkOptions
  );
  report({ phase: "discover", done: 1, total: 1 });
  const freshPaths = /* @__PURE__ */ new Set();
  for (const chunk of freshChunks) {
    freshPaths.add(chunk.path);
  }
  const files = freshPaths.size;
  report({ phase: "chunk", done: freshChunks.length, total: freshChunks.length });
  const manifest = store.manifest();
  const manifestIdsByPath = /* @__PURE__ */ new Map();
  for (const id of manifest.keys()) {
    const p = pathFromChunkId(id);
    const set = manifestIdsByPath.get(p);
    if (set) {
      set.add(id);
    } else {
      manifestIdsByPath.set(p, /* @__PURE__ */ new Set([id]));
    }
  }
  const toEmbed = [];
  let reused = 0;
  const freshIdsByPath = /* @__PURE__ */ new Map();
  for (const chunk of freshChunks) {
    const set = freshIdsByPath.get(chunk.path);
    if (set) {
      set.add(chunk.id);
    } else {
      freshIdsByPath.set(chunk.path, /* @__PURE__ */ new Set([chunk.id]));
    }
  }
  for (const chunk of freshChunks) {
    const storedHash = manifest.get(chunk.id);
    if (storedHash === void 0 || storedHash !== chunk.hash) {
      toEmbed.push(chunk);
    } else {
      reused++;
    }
  }
  const pathsToRemove = [];
  for (const [path6, priorIds] of manifestIdsByPath) {
    const freshIds = freshIdsByPath.get(path6);
    if (freshIds === void 0) {
      pathsToRemove.push(path6);
      continue;
    }
    let hasOrphan = false;
    for (const priorId of priorIds) {
      if (!freshIds.has(priorId)) {
        hasOrphan = true;
        break;
      }
    }
    if (hasOrphan) {
      pathsToRemove.push(path6);
      const already = new Set(toEmbed.map((c) => c.id));
      for (const chunk of freshChunks) {
        if (chunk.path === path6 && !already.has(chunk.id)) {
          toEmbed.push(chunk);
          reused--;
        }
      }
    }
  }
  if (pathsToRemove.length > 0) {
    store.removeByPath(pathsToRemove);
  }
  let embedMs = 0;
  let embeddedNow = [];
  if (toEmbed.length > 0) {
    const total = toEmbed.length;
    const embedStart = performance.now();
    const vectors = [];
    if (opts.onProgress) {
      report({ phase: "embed", done: 0, total });
      for (let i = 0; i < total; i += DEFAULT_EMBED_PROGRESS_BATCH) {
        const slice = toEmbed.slice(i, i + DEFAULT_EMBED_PROGRESS_BATCH);
        const batchVectors = await embedder.embed(slice.map((c) => c.text));
        if (batchVectors.length !== slice.length) {
          throw new Error(
            `indexer: embedder returned ${batchVectors.length} vectors for ${slice.length} texts (order/count must match)`
          );
        }
        for (const v of batchVectors) vectors.push(v);
        report({ phase: "embed", done: vectors.length, total });
      }
    } else {
      const batch = await embedder.embed(toEmbed.map((c) => c.text));
      for (const v of batch) vectors.push(v);
    }
    embedMs = performance.now() - embedStart;
    if (vectors.length !== total) {
      throw new Error(
        `indexer: embedder returned ${vectors.length} vectors for ${total} texts (order/count must match)`
      );
    }
    embeddedNow = toEmbed.map((chunk, i) => ({
      ...chunk,
      vector: vectors[i]
    }));
    store.upsert(embeddedNow);
  }
  if (opts.keywordIndex) {
    if (pathsToRemove.length > 0) {
      opts.keywordIndex.removeByPath(pathsToRemove);
    }
    opts.keywordIndex.add(freshChunks);
  }
  if (decision.persists && decision.persistDir && persistKey) {
    const removed = new Set(pathsToRemove);
    const byId = /* @__PURE__ */ new Map();
    for (const chunk of loadedById.values()) {
      if (!removed.has(chunk.path)) {
        byId.set(chunk.id, chunk);
      }
    }
    for (const chunk of embeddedNow) {
      byId.set(chunk.id, chunk);
    }
    await saveIndex({
      store: [...byId.values()],
      persistDir: decision.persistDir,
      key: persistKey,
      embedderId: embedder.id
    });
  }
  return {
    files,
    chunks: freshChunks.length,
    embedded: toEmbed.length,
    reused,
    embedMs,
    totalMs: performance.now() - totalStart,
    embedderId: embedder.id,
    residency: decision.effective
  };
}
async function updateIndex(opts) {
  const totalStart = performance.now();
  const { workspaceRoot, embedder, store } = opts;
  const filterPaths = opts.filterPaths ?? (await Promise.resolve().then(() => (init_discover(), discover_exports))).filterIndexablePaths;
  const loadChunksForFiles = opts.loadChunksForFiles ?? defaultLoadChunksForFiles;
  const deletedSet = new Set(opts.deletedPaths);
  const changedSet = new Set(opts.changedPaths.filter((p) => !deletedSet.has(p)));
  const inputCount = changedSet.size + deletedSet.size;
  if (inputCount === 0) {
    return zeroUpdateStats(performance.now() - totalStart);
  }
  const survivors = await filterPaths(workspaceRoot, [...changedSet], {
    mode: "existing",
    ...opts.extraIgnore ? { extraIgnore: opts.extraIgnore } : {}
  });
  const survivorPaths = new Set(survivors.map((f) => f.path));
  const deletables = await filterPaths(workspaceRoot, [...deletedSet], {
    mode: "path-only",
    ...opts.extraIgnore ? { extraIgnore: opts.extraIgnore } : {}
  });
  const manifest = store.manifest();
  const manifestPaths = /* @__PURE__ */ new Set();
  for (const id of manifest.keys()) manifestPaths.add(pathFromChunkId(id));
  const evictPaths = /* @__PURE__ */ new Set();
  for (const f of deletables) {
    if (manifestPaths.has(f.path)) evictPaths.add(f.path);
  }
  for (const p of changedSet) {
    if (!survivorPaths.has(p) && manifestPaths.has(p)) evictPaths.add(p);
  }
  const ignored = inputCount - survivorPaths.size - evictPaths.size >= 0 ? inputCount - survivorPaths.size - evictPaths.size : 0;
  const freshChunks = survivors.length > 0 ? await loadChunksForFiles(survivors, opts.chunkOptions) : [];
  const manifestIdsByPath = /* @__PURE__ */ new Map();
  for (const id of manifest.keys()) {
    const p = pathFromChunkId(id);
    const set = manifestIdsByPath.get(p);
    if (set) set.add(id);
    else manifestIdsByPath.set(p, /* @__PURE__ */ new Set([id]));
  }
  const freshIdsByPath = /* @__PURE__ */ new Map();
  for (const chunk of freshChunks) {
    const set = freshIdsByPath.get(chunk.path);
    if (set) set.add(chunk.id);
    else freshIdsByPath.set(chunk.path, /* @__PURE__ */ new Set([chunk.id]));
  }
  const toEmbed = [];
  let reused = 0;
  for (const chunk of freshChunks) {
    const storedHash = manifest.get(chunk.id);
    if (storedHash === void 0 || storedHash !== chunk.hash) toEmbed.push(chunk);
    else reused++;
  }
  const pathsToRemove = [...evictPaths];
  for (const file of survivors) {
    const priorIds = manifestIdsByPath.get(file.path);
    if (!priorIds) continue;
    const freshIds = freshIdsByPath.get(file.path) ?? /* @__PURE__ */ new Set();
    let hasOrphan = false;
    for (const priorId of priorIds) {
      if (!freshIds.has(priorId)) {
        hasOrphan = true;
        break;
      }
    }
    if (!hasOrphan) continue;
    pathsToRemove.push(file.path);
    const already = new Set(toEmbed.map((c) => c.id));
    for (const chunk of freshChunks) {
      if (chunk.path === file.path && !already.has(chunk.id)) {
        toEmbed.push(chunk);
        reused--;
      }
    }
  }
  if (pathsToRemove.length > 0) {
    store.removeByPath(pathsToRemove);
  }
  let embedMs = 0;
  if (toEmbed.length > 0) {
    const embedStart = performance.now();
    const vectors = await embedder.embed(toEmbed.map((c) => c.text));
    embedMs = performance.now() - embedStart;
    if (vectors.length !== toEmbed.length) {
      throw new Error(
        `indexer: embedder returned ${vectors.length} vectors for ${toEmbed.length} texts (order/count must match)`
      );
    }
    store.upsert(toEmbed.map((chunk, i) => ({ ...chunk, vector: vectors[i] })));
  }
  if (opts.keywordIndex) {
    if (pathsToRemove.length > 0) {
      opts.keywordIndex.removeByPath(pathsToRemove);
    }
    if (freshChunks.length > 0) {
      opts.keywordIndex.add(freshChunks);
    }
  }
  return {
    files: survivors.length,
    ignored,
    embedded: toEmbed.length,
    reused,
    evictedPaths: evictPaths.size,
    embedMs,
    totalMs: performance.now() - totalStart
  };
}
function zeroUpdateStats(totalMs) {
  return { files: 0, ignored: 0, embedded: 0, reused: 0, evictedPaths: 0, embedMs: 0, totalMs };
}
var defaultLoadChunksForFiles = async (files, chunkOptions) => {
  const { chunkFile: chunkFile2 } = await Promise.resolve().then(() => (init_chunk(), chunk_exports));
  const chunks = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile2(file.absPath, "utf8");
    } catch {
      continue;
    }
    chunks.push(...chunkFile2(file.path, text, chunkOptions));
  }
  return chunks;
};
function encryptAtRestHook(key, plaintext) {
  return encryptBlob(key, Buffer.from(plaintext, "utf8"));
}
function pathFromChunkId(id) {
  const match = /^(.*):\d+-\d+$/.exec(id);
  return match ? match[1] : id;
}
var defaultLoadChunks = async (workspaceRoot, discoverOptions, chunkOptions) => {
  const { discoverFiles: discoverFiles2 } = await Promise.resolve().then(() => (init_discover(), discover_exports));
  const { chunkFile: chunkFile2 } = await Promise.resolve().then(() => (init_chunk(), chunk_exports));
  const discovered = await discoverFiles2({
    workspaceRoot,
    ...discoverOptions
  });
  const chunks = [];
  for (const file of discovered) {
    const text = await readFile2(file.absPath, "utf8");
    chunks.push(...chunkFile2(file.path, text, chunkOptions));
  }
  return chunks;
};

// ../spikes/p0-supervisor/code-index/retriever.ts
var DEFAULT_K = 8;
var DEFAULT_ADJACENCY_GAP = 8;
var DEFAULT_MAX_MERGED_LINES = 200;
var DEFAULT_MAX_MERGED_CHARS = 8e3;
var RRF_K = 60;
var DEFAULT_MIN_RELEVANCE = 0.25;
function cosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  let dot2 = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    dot2 += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  const denom = Math.sqrt(aa) * Math.sqrt(bb);
  return denom > 0 ? dot2 / denom : 0;
}
function poolSize(k) {
  return Math.max(k, 30);
}
async function retrieve(opts) {
  const { query, embedder, store, keywordIndex } = opts;
  const k = opts.k ?? DEFAULT_K;
  const minRelevance = opts.minRelevance ?? DEFAULT_MIN_RELEVANCE;
  const vectors = await embedder.embed([query]);
  const queryVector = vectors[0];
  if (queryVector === void 0) {
    throw new Error("retriever: embedder returned no vector for the query");
  }
  if (keywordIndex === void 0) {
    return applyRelevanceFloor(store.search(queryVector, k), minRelevance);
  }
  const pool = poolSize(k);
  const vectorHits = store.search(queryVector, pool);
  const keywordHits = keywordIndex.search(query, pool);
  const fused = fuseByReciprocalRank([vectorHits, keywordHits], pool);
  const cosineById = /* @__PURE__ */ new Map();
  for (const hit of vectorHits) {
    if (hit.relevance !== void 0) cosineById.set(hit.chunk.id, hit.relevance);
  }
  const withRelevance = fused.map((hit) => {
    const cosine = cosineById.get(hit.chunk.id) ?? cosineFromStore(store, queryVector, hit.chunk.id);
    return cosine === void 0 ? hit : { ...hit, relevance: cosine };
  });
  const merged = dedupeAdjacentHits(withRelevance);
  const floored = applyRelevanceFloor(merged, minRelevance);
  return k >= floored.length ? floored : floored.slice(0, k);
}
function cosineFromStore(store, queryVector, id) {
  const vec = store.getVector?.(id);
  return vec === void 0 ? void 0 : cosineSim(queryVector, vec);
}
function applyRelevanceFloor(hits, minRelevance) {
  return hits.filter((h) => h.relevance === void 0 || h.relevance >= minRelevance);
}
function dedupeAdjacentHits(hits, opts = {}) {
  const adjacencyGap = opts.adjacencyGap ?? DEFAULT_ADJACENCY_GAP;
  const maxLines = opts.maxMergedLines ?? DEFAULT_MAX_MERGED_LINES;
  const maxChars = opts.maxMergedChars ?? DEFAULT_MAX_MERGED_CHARS;
  if (hits.length <= 1) return hits.slice();
  const byPath = /* @__PURE__ */ new Map();
  for (const hit of hits) {
    const group = byPath.get(hit.chunk.path);
    if (group) group.push(hit);
    else byPath.set(hit.chunk.path, [hit]);
  }
  const regions = [];
  for (const group of byPath.values()) {
    if (group.length === 1) {
      regions.push(group[0]);
      continue;
    }
    const sorted = group.slice().sort((a, b) => a.chunk.startLine - b.chunk.startLine || a.chunk.endLine - b.chunk.endLine);
    let run2 = [sorted[0]];
    const flush = () => {
      regions.push(run2.length === 1 ? run2[0] : mergeRegion(run2));
      run2 = [];
    };
    for (let i = 1; i < sorted.length; i++) {
      const prev = run2[run2.length - 1];
      const cur = sorted[i];
      const overlapOrAdjacent = cur.chunk.startLine <= prev.chunk.endLine + 1 + adjacencyGap;
      if (!overlapOrAdjacent) {
        flush();
        run2 = [cur];
        continue;
      }
      const start = run2[0].chunk.startLine;
      const end = Math.max(run2[run2.length - 1].chunk.endLine, cur.chunk.endLine);
      const projectedLines = end - start + 1;
      const projectedChars = projectedMergedChars([...run2, cur]);
      if (projectedLines > maxLines || projectedChars > maxChars) {
        flush();
        run2 = [cur];
        continue;
      }
      run2.push(cur);
    }
    flush();
  }
  regions.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
  });
  return regions;
}
function buildMergedText(run2) {
  const lineByNumber = /* @__PURE__ */ new Map();
  let minLine = Infinity;
  let maxLine = -Infinity;
  for (const hit of run2) {
    const lines = hit.chunk.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineNo = hit.chunk.startLine + i;
      if (!lineByNumber.has(lineNo)) lineByNumber.set(lineNo, lines[i]);
      if (lineNo < minLine) minLine = lineNo;
      if (lineNo > maxLine) maxLine = lineNo;
    }
  }
  const out = [];
  for (let n = minLine; n <= maxLine; n++) {
    const line = lineByNumber.get(n);
    if (line !== void 0) out.push(line);
  }
  return out.join("\n");
}
function projectedMergedChars(run2) {
  return buildMergedText(run2).length;
}
function mergeRegion(run2) {
  const path6 = run2[0].chunk.path;
  const startLine = Math.min(...run2.map((h) => h.chunk.startLine));
  const endLine = Math.max(...run2.map((h) => h.chunk.endLine));
  const text = buildMergedText(run2);
  const score = Math.max(...run2.map((h) => h.score));
  const relevances = run2.map((h) => h.relevance).filter((r) => r !== void 0);
  const relevance = relevances.length > 0 ? Math.max(...relevances) : void 0;
  const chunk = {
    id: `${path6}:${startLine}-${endLine}`,
    path: path6,
    startLine,
    endLine,
    text,
    // Synthetic region — not a stored chunk. Carry the first constituent's hash as
    // an informational placeholder (no incremental-index lookup uses a region id).
    hash: run2[0].chunk.hash
  };
  return relevance === void 0 ? { chunk, score } : { chunk, score, relevance };
}
function fuseByReciprocalRank(lists, k) {
  if (k <= 0) return [];
  const fusedScore = /* @__PURE__ */ new Map();
  const chunkById = /* @__PURE__ */ new Map();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank];
      const id = hit.chunk.id;
      fusedScore.set(id, (fusedScore.get(id) ?? 0) + 1 / (RRF_K + rank));
      if (!chunkById.has(id)) {
        chunkById.set(id, hit.chunk);
      }
    }
  }
  const fused = [];
  for (const [id, score] of fusedScore) {
    const chunk = chunkById.get(id);
    if (chunk) fused.push({ chunk, score });
  }
  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
  });
  return k >= fused.length ? fused : fused.slice(0, k);
}

// ../spikes/p0-supervisor/code-index/embedder.ts
import { createHash as createHash5 } from "node:crypto";
var DEFAULT_HOST = "http://127.0.0.1:11434";
var DEFAULT_MODEL = "nomic-embed-text";
var DEFAULT_DIMS = 768;
var DEFAULT_BATCH_SIZE = 16;
var OllamaEmbedder = class {
  id;
  dims;
  host;
  model;
  batchSize;
  constructor(opts = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dims = opts.dims ?? DEFAULT_DIMS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.id = `ollama:${this.model}`;
  }
  async embed(texts) {
    if (texts.length === 0) return [];
    const out = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.embedBatch(batch);
      for (const v of vectors) out.push(v);
    }
    return out;
  }
  /** Embed a single batch via one `/api/embed` request. */
  async embedBatch(batch) {
    const res = await fetch(`${this.host}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: batch })
    });
    if (!res.ok) {
      throw new Error(`ollama /api/embed ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const rows = data.embeddings;
    if (!Array.isArray(rows)) {
      throw new Error("ollama /api/embed: response had no embeddings array");
    }
    if (rows.length !== batch.length) {
      throw new Error(
        `ollama /api/embed: expected ${batch.length} embeddings, got ${rows.length}`
      );
    }
    return rows.map((row, idx) => {
      if (!Array.isArray(row) || row.length !== this.dims) {
        throw new Error(
          `ollama /api/embed: vector ${idx} has length ${Array.isArray(row) ? row.length : "n/a"}, expected ${this.dims} (model/dims mismatch?)`
        );
      }
      return Float32Array.from(row);
    });
  }
};

// ../spikes/p0-supervisor/code-index/vector-store.ts
function l2Norm(vector) {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares);
}
function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += a[i] * b[i];
  }
  return acc;
}
var BruteForceVectorStore = class {
  /** id -> stored entry (chunk + cached norm). */
  entries = /* @__PURE__ */ new Map();
  /** Number of chunks currently held. */
  get size() {
    return this.entries.size;
  }
  /**
   * Insert or replace by `chunk.id`. Recomputes & caches the L2 norm for each
   * upserted vector; an existing id is overwritten (its old entry, including the
   * stale norm, is fully replaced).
   */
  upsert(chunks) {
    for (const chunk of chunks) {
      this.entries.set(chunk.id, { chunk, norm: l2Norm(chunk.vector) });
    }
  }
  /**
   * Top-k chunks by cosine similarity to `queryVector`, sorted by score
   * descending. Cosine = dot(q, v) / (||q|| · ||v||); a zero-norm query or
   * stored vector yields score 0 (can't divide by zero, and a zero vector has
   * no direction). Returns `[]` for an empty store or k<=0; if k>size, returns
   * every stored chunk (still sorted).
   */
  search(queryVector, k) {
    if (k <= 0 || this.entries.size === 0) {
      return [];
    }
    const queryNorm = l2Norm(queryVector);
    const hits = [];
    for (const { chunk, norm } of this.entries.values()) {
      let score = 0;
      const denom = queryNorm * norm;
      if (denom > 0) {
        score = dot(queryVector, chunk.vector) / denom;
      }
      hits.push({ chunk, score, relevance: score });
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
    });
    return k >= hits.length ? hits : hits.slice(0, k);
  }
  /**
   * Fetch a stored chunk's embedding vector by id, or undefined if not held. Used
   * by the hybrid retriever to compute a DISPLAY cosine for keyword-only / fused
   * hits whose cosine the vector search did not already supply. Returns the stored
   * Float32Array directly (no copy) — callers MUST treat it as read-only.
   */
  getVector(id) {
    return this.entries.get(id)?.chunk.vector;
  }
  /**
   * Drop every chunk whose `path` is in `paths` (incremental file change/delete).
   * Uses a Set for O(1) membership, so this is O(size) regardless of |paths|.
   */
  removeByPath(paths) {
    if (paths.length === 0) {
      return;
    }
    const drop = new Set(paths);
    for (const [id, entry] of this.entries) {
      if (drop.has(entry.chunk.path)) {
        this.entries.delete(id);
      }
    }
  }
  /**
   * id -> hash for everything stored (incremental diff against fresh chunks).
   * Returns a fresh Map; mutating it does not affect the store.
   */
  manifest() {
    const out = /* @__PURE__ */ new Map();
    for (const { chunk } of this.entries.values()) {
      out.set(chunk.id, chunk.hash);
    }
    return out;
  }
};

// ../spikes/p0-supervisor/code-index/flat-vector-store.ts
function l2NormSlice(data, off, dims) {
  let sumSquares = 0;
  for (let i = 0; i < dims; i++) {
    const v = data[off + i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares);
}
function l2Norm2(vector) {
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares);
}
var FlatVectorStore = class {
  /** Vector dimensionality, fixed at first upsert (0 until then). */
  dims = 0;
  /** Number of live rows. */
  count = 0;
  /** Packed vectors: row r at [r*dims, r*dims+dims). Capacity = data.length/dims. */
  data = new Float32Array(0);
  /** Precomputed L2 norm per row (parallel to chunks). */
  norms = new Float32Array(0);
  /** Chunk metadata per row (parallel to the packed slab). */
  chunks = [];
  /** chunk.id -> row index. */
  idToRow = /* @__PURE__ */ new Map();
  get size() {
    return this.count;
  }
  /** Row capacity currently allocated in the slab. */
  get capacity() {
    return this.dims > 0 ? this.data.length / this.dims : 0;
  }
  /**
   * Grow the slab + norms to hold at least `needRows` rows (geometric doubling so a
   * bulk upsert is amortized O(1) per row). Preserves existing rows verbatim.
   */
  ensureCapacity(needRows) {
    if (needRows <= this.capacity) {
      return;
    }
    let newCap = Math.max(this.capacity, 8);
    while (newCap < needRows) {
      newCap *= 2;
    }
    const nextData = new Float32Array(newCap * this.dims);
    nextData.set(this.data.subarray(0, this.count * this.dims));
    this.data = nextData;
    const nextNorms = new Float32Array(newCap);
    nextNorms.set(this.norms.subarray(0, this.count));
    this.norms = nextNorms;
  }
  /**
   * Insert or replace by `chunk.id`. The first upsert fixes `dims` (the embedder's
   * dimensionality); a later chunk whose vector length differs is rejected (defensive —
   * the indexer only ever feeds one embedder's output). An existing id is overwritten
   * IN PLACE (its row's vector + norm + metadata are replaced); a new id appends a row.
   */
  upsert(chunks) {
    if (chunks.length === 0) {
      return;
    }
    if (this.dims === 0) {
      this.dims = chunks[0].vector.length;
    }
    this.ensureCapacity(this.count + chunks.length);
    for (const chunk of chunks) {
      if (chunk.vector.length !== this.dims) {
        throw new Error(
          `FlatVectorStore: inconsistent vector dims (${chunk.vector.length} vs ${this.dims}) for chunk ${chunk.id}`
        );
      }
      const existing = this.idToRow.get(chunk.id);
      const row = existing ?? this.count;
      if (existing === void 0) {
        this.count += 1;
        this.idToRow.set(chunk.id, row);
      }
      const off = row * this.dims;
      this.data.set(chunk.vector, off);
      this.norms[row] = l2NormSlice(this.data, off, this.dims);
      this.chunks[row] = chunk;
    }
  }
  /**
   * Top-k chunks by cosine similarity to `queryVector`, sorted by score descending.
   * Cosine = dot(q, v) / (||q|| · ||v||); a zero-norm query or stored vector yields
   * score 0. Returns `[]` for an empty store or k<=0; if k>size returns every chunk
   * (sorted). EXACT: identical ranking + cosine values to the brute-force store.
   *
   * The hot path is a single tight loop over the packed slab — no per-chunk object
   * deref, sequential memory access — then a partial top-k selection (a bounded
   * insertion into a small sorted array) so we don't sort all N hits when k << N.
   */
  search(queryVector, k) {
    if (k <= 0 || this.count === 0) {
      return [];
    }
    const { data, norms, dims, count } = this;
    const queryNorm = l2Norm2(queryVector);
    const scores = new Float32Array(count);
    if (queryNorm > 0) {
      for (let r = 0; r < count; r++) {
        const vNorm = norms[r];
        if (vNorm <= 0) {
          scores[r] = 0;
          continue;
        }
        const off = r * dims;
        let acc = 0;
        for (let i = 0; i < dims; i++) {
          acc += queryVector[i] * data[off + i];
        }
        scores[r] = acc / (queryNorm * vNorm);
      }
    }
    const order = new Array(count);
    for (let r = 0; r < count; r++) {
      order[r] = r;
    }
    const chunks = this.chunks;
    order.sort((a, b) => {
      const sa = scores[a];
      const sb = scores[b];
      if (sb !== sa) {
        return sb - sa;
      }
      const ia = chunks[a].id;
      const ib = chunks[b].id;
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
    const take = k >= count ? count : k;
    const hits = new Array(take);
    for (let i = 0; i < take; i++) {
      const r = order[i];
      const score = scores[r];
      hits[i] = { chunk: chunks[r], score, relevance: score };
    }
    return hits;
  }
  /**
   * Fetch a stored chunk's embedding vector by id, or undefined if not held. Returns a
   * COPY (a fresh Float32Array) of the packed row, so a caller cannot mutate the slab.
   */
  getVector(id) {
    const row = this.idToRow.get(id);
    if (row === void 0) {
      return void 0;
    }
    const off = row * this.dims;
    return this.data.slice(off, off + this.dims);
  }
  /**
   * Drop every chunk whose `path` is in `paths` (incremental file change/delete).
   * Compacts via swap-remove so [0, count) stays dense (no tombstones in the hot loop):
   * a dropped row is overwritten by the current LAST live row, then the count shrinks.
   */
  removeByPath(paths) {
    if (paths.length === 0 || this.count === 0) {
      return;
    }
    const drop = new Set(paths);
    let r = 0;
    while (r < this.count) {
      const here = this.chunks[r];
      if (!drop.has(here.path)) {
        r += 1;
        continue;
      }
      this.idToRow.delete(here.id);
      const last = this.count - 1;
      if (r !== last) {
        const dstOff = r * this.dims;
        const srcOff = last * this.dims;
        this.data.copyWithin(dstOff, srcOff, srcOff + this.dims);
        this.norms[r] = this.norms[last];
        const moved = this.chunks[last];
        this.chunks[r] = moved;
        this.idToRow.set(moved.id, r);
      }
      this.chunks.pop();
      this.count -= 1;
    }
  }
  /**
   * id -> hash for everything stored (incremental diff against fresh chunks).
   * Returns a fresh Map; mutating it does not affect the store.
   */
  manifest() {
    const out = /* @__PURE__ */ new Map();
    for (let r = 0; r < this.count; r++) {
      const c = this.chunks[r];
      out.set(c.id, c.hash);
    }
    return out;
  }
};

// ../spikes/p0-supervisor/code-index/ivf-vector-store.ts
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function l2Norm3(vector) {
  let s = 0;
  for (let i = 0; i < vector.length; i++) {
    s += vector[i] * vector[i];
  }
  return Math.sqrt(s);
}
var IvfVectorStore = class {
  dims = 0;
  count = 0;
  /** Packed RAW vectors (row r at [r*dims, r*dims+dims)). */
  data = new Float32Array(0);
  /** Precomputed L2 norm per row (for exact cosine on probed candidates). */
  norms = new Float32Array(0);
  /** Chunk metadata per row. */
  chunks = [];
  idToRow = /* @__PURE__ */ new Map();
  /** Packed UNIT-normalized vectors (for centroid training + assignment). */
  unit = new Float32Array(0);
  /** Trained centroids: nlist rows of `dims` (unit-ish). Empty until trained. */
  centroids = new Float32Array(0);
  nlist = 0;
  /** Inverted lists: postings[c] = row indices assigned to centroid c. */
  postings = [];
  /** Set when the corpus changed since the last train (forces a lazy retrain). */
  dirty = true;
  opt;
  constructor(options = {}) {
    this.opt = {
      nlist: options.nlist ?? 0,
      // 0 → derive ~sqrt(N) at train time
      nprobe: options.nprobe ?? 8,
      trainIters: options.trainIters ?? 10,
      seed: options.seed ?? 2654435769
    };
  }
  get size() {
    return this.count;
  }
  get capacity() {
    return this.dims > 0 ? this.data.length / this.dims : 0;
  }
  ensureCapacity(needRows) {
    if (needRows <= this.capacity) {
      return;
    }
    let newCap = Math.max(this.capacity, 8);
    while (newCap < needRows) {
      newCap *= 2;
    }
    const nextData = new Float32Array(newCap * this.dims);
    nextData.set(this.data.subarray(0, this.count * this.dims));
    this.data = nextData;
    const nextUnit = new Float32Array(newCap * this.dims);
    nextUnit.set(this.unit.subarray(0, this.count * this.dims));
    this.unit = nextUnit;
    const nextNorms = new Float32Array(newCap);
    nextNorms.set(this.norms.subarray(0, this.count));
    this.norms = nextNorms;
  }
  upsert(chunks) {
    if (chunks.length === 0) {
      return;
    }
    if (this.dims === 0) {
      this.dims = chunks[0].vector.length;
    }
    this.ensureCapacity(this.count + chunks.length);
    for (const chunk of chunks) {
      if (chunk.vector.length !== this.dims) {
        throw new Error(
          `IvfVectorStore: inconsistent vector dims (${chunk.vector.length} vs ${this.dims}) for chunk ${chunk.id}`
        );
      }
      const existing = this.idToRow.get(chunk.id);
      const row = existing ?? this.count;
      if (existing === void 0) {
        this.count += 1;
        this.idToRow.set(chunk.id, row);
      }
      const off = row * this.dims;
      this.data.set(chunk.vector, off);
      const norm = l2Norm3(chunk.vector);
      this.norms[row] = norm;
      if (norm > 0) {
        const inv = 1 / norm;
        for (let i = 0; i < this.dims; i++) {
          this.unit[off + i] = chunk.vector[i] * inv;
        }
      } else {
        for (let i = 0; i < this.dims; i++) {
          this.unit[off + i] = 0;
        }
      }
      this.chunks[row] = chunk;
    }
    this.dirty = true;
  }
  getVector(id) {
    const row = this.idToRow.get(id);
    if (row === void 0) {
      return void 0;
    }
    const off = row * this.dims;
    return this.data.slice(off, off + this.dims);
  }
  removeByPath(paths) {
    if (paths.length === 0 || this.count === 0) {
      return;
    }
    const drop = new Set(paths);
    let r = 0;
    while (r < this.count) {
      const here = this.chunks[r];
      if (!drop.has(here.path)) {
        r += 1;
        continue;
      }
      this.idToRow.delete(here.id);
      const last = this.count - 1;
      if (r !== last) {
        const dstOff = r * this.dims;
        const srcOff = last * this.dims;
        this.data.copyWithin(dstOff, srcOff, srcOff + this.dims);
        this.unit.copyWithin(dstOff, srcOff, srcOff + this.dims);
        this.norms[r] = this.norms[last];
        const moved = this.chunks[last];
        this.chunks[r] = moved;
        this.idToRow.set(moved.id, r);
      }
      this.chunks.pop();
      this.count -= 1;
    }
    this.dirty = true;
  }
  manifest() {
    const out = /* @__PURE__ */ new Map();
    for (let r = 0; r < this.count; r++) {
      const c = this.chunks[r];
      out.set(c.id, c.hash);
    }
    return out;
  }
  /**
   * Top-k by cosine, APPROXIMATE: scan only the `nprobe` buckets nearest the query, but
   * score candidates EXACTLY. For a corpus too small to cluster (count < nlist target)
   * or k>=size, fall back to an exact full scan so small repos stay exact.
   */
  search(queryVector, k) {
    if (k <= 0 || this.count === 0) {
      return [];
    }
    const queryNorm = l2Norm3(queryVector);
    if (queryNorm === 0) {
      return this.exactScan(queryVector, queryNorm, k);
    }
    this.ensureTrained();
    if (this.nlist === 0 || k >= this.count) {
      return this.exactScan(queryVector, queryNorm, k);
    }
    const invQ = 1 / queryNorm;
    const uq = new Float32Array(this.dims);
    for (let i = 0; i < this.dims; i++) {
      uq[i] = queryVector[i] * invQ;
    }
    const nprobe = Math.max(1, Math.min(this.opt.nprobe, this.nlist));
    const centScores = new Array(this.nlist);
    for (let c = 0; c < this.nlist; c++) {
      const coff = c * this.dims;
      let acc = 0;
      for (let i = 0; i < this.dims; i++) {
        acc += uq[i] * this.centroids[coff + i];
      }
      centScores[c] = { c, s: acc };
    }
    centScores.sort((a, b) => b.s - a.s);
    const hits = [];
    const data = this.data;
    const dims = this.dims;
    for (let p = 0; p < nprobe; p++) {
      const list = this.postings[centScores[p].c];
      for (let j = 0; j < list.length; j++) {
        const r = list[j];
        const vNorm = this.norms[r];
        let score = 0;
        if (vNorm > 0) {
          const off = r * dims;
          let acc = 0;
          for (let i = 0; i < dims; i++) {
            acc += queryVector[i] * data[off + i];
          }
          score = acc / (queryNorm * vNorm);
        }
        hits.push({ chunk: this.chunks[r], score, relevance: score });
      }
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
    });
    return k >= hits.length ? hits : hits.slice(0, k);
  }
  /** Exact full scan (fallback path), identical semantics to the brute-force store. */
  exactScan(queryVector, queryNorm, k) {
    const hits = new Array(this.count);
    const data = this.data;
    const dims = this.dims;
    for (let r = 0; r < this.count; r++) {
      const vNorm = this.norms[r];
      let score = 0;
      if (queryNorm > 0 && vNorm > 0) {
        const off = r * dims;
        let acc = 0;
        for (let i = 0; i < dims; i++) {
          acc += queryVector[i] * data[off + i];
        }
        score = acc / (queryNorm * vNorm);
      }
      hits[r] = { chunk: this.chunks[r], score, relevance: score };
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
    });
    return k >= hits.length ? hits : hits.slice(0, k);
  }
  /** Train (or retrain) centroids + inverted lists from the current unit vectors. */
  ensureTrained() {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    const target = this.opt.nlist > 0 ? this.opt.nlist : Math.max(1, Math.round(Math.sqrt(this.count)));
    if (this.count < Math.max(64, target * 4)) {
      this.nlist = 0;
      this.centroids = new Float32Array(0);
      this.postings = [];
      return;
    }
    const nlist = Math.min(target, this.count);
    const dims = this.dims;
    const rng = mulberry32(this.opt.seed ^ this.count * 2654435761);
    const centroids = new Float32Array(nlist * dims);
    const chosen = /* @__PURE__ */ new Set();
    for (let c = 0; c < nlist; c++) {
      let row = Math.floor(rng() * this.count);
      let guard = 0;
      while (chosen.has(row) && guard < this.count) {
        row = (row + 1) % this.count;
        guard += 1;
      }
      chosen.add(row);
      centroids.set(this.unit.subarray(row * dims, row * dims + dims), c * dims);
    }
    const assign = new Int32Array(this.count);
    const counts = new Int32Array(nlist);
    for (let iter = 0; iter < this.opt.trainIters; iter++) {
      let moved = 0;
      for (let r = 0; r < this.count; r++) {
        const roff = r * dims;
        let best = -1;
        let bestDot = -Infinity;
        for (let c = 0; c < nlist; c++) {
          const coff = c * dims;
          let acc = 0;
          for (let i = 0; i < dims; i++) {
            acc += this.unit[roff + i] * centroids[coff + i];
          }
          if (acc > bestDot) {
            bestDot = acc;
            best = c;
          }
        }
        if (assign[r] !== best) {
          moved += 1;
        }
        assign[r] = best;
      }
      centroids.fill(0);
      counts.fill(0);
      for (let r = 0; r < this.count; r++) {
        const c = assign[r];
        counts[c] += 1;
        const coff = c * dims;
        const roff = r * dims;
        for (let i = 0; i < dims; i++) {
          centroids[coff + i] += this.unit[roff + i];
        }
      }
      for (let c = 0; c < nlist; c++) {
        const coff = c * dims;
        if (counts[c] === 0) {
          const row = Math.floor(rng() * this.count);
          centroids.set(this.unit.subarray(row * dims, row * dims + dims), coff);
          continue;
        }
        let n = 0;
        for (let i = 0; i < dims; i++) {
          n += centroids[coff + i] * centroids[coff + i];
        }
        n = Math.sqrt(n);
        if (n > 0) {
          const inv = 1 / n;
          for (let i = 0; i < dims; i++) {
            centroids[coff + i] *= inv;
          }
        }
      }
      if (iter > 0 && moved === 0) {
        break;
      }
    }
    const postings = new Array(nlist);
    for (let c = 0; c < nlist; c++) {
      postings[c] = [];
    }
    for (let r = 0; r < this.count; r++) {
      const roff = r * dims;
      let best = 0;
      let bestDot = -Infinity;
      for (let c = 0; c < nlist; c++) {
        const coff = c * dims;
        let acc = 0;
        for (let i = 0; i < dims; i++) {
          acc += this.unit[roff + i] * centroids[coff + i];
        }
        if (acc > bestDot) {
          bestDot = acc;
          best = c;
        }
      }
      postings[best].push(r);
    }
    this.centroids = centroids;
    this.nlist = nlist;
    this.postings = postings;
  }
};

// ../spikes/p0-supervisor/code-index/vector-store-factory.ts
var VECTOR_STORE_KINDS = ["brute", "flat", "ann"];
var DEFAULT_VECTOR_STORE_KIND = "flat";
function resolveVectorStoreKind(value) {
  return typeof value === "string" && VECTOR_STORE_KINDS.includes(value) ? value : DEFAULT_VECTOR_STORE_KIND;
}
function createVectorStore(kind = DEFAULT_VECTOR_STORE_KIND, annOptions) {
  switch (kind) {
    case "brute":
      return new BruteForceVectorStore();
    case "flat":
      return new FlatVectorStore();
    case "ann":
      return new IvfVectorStore(annOptions);
    default:
      return new BruteForceVectorStore();
  }
}

// ../spikes/p0-supervisor/code-index/keyword-index.ts
var K1 = 1.2;
var B = 0.75;
function tokenizeCodeAware(text) {
  const tokens = [];
  const idRuns = text.match(/[A-Za-z0-9_]+/g);
  if (idRuns === null) return tokens;
  for (const run2 of idRuns) {
    const seen = /* @__PURE__ */ new Set();
    const emit = (tok) => {
      if (tok.length === 0 || seen.has(tok)) return;
      seen.add(tok);
      tokens.push(tok);
    };
    emit(run2.replace(/_/g, "").toLowerCase());
    for (const piece of run2.split("_")) {
      if (piece.length === 0) continue;
      for (const part of splitIdentifier(piece)) {
        if (part.length > 0) emit(part.toLowerCase());
      }
    }
  }
  return tokens;
}
function splitIdentifier(run2) {
  return run2.split(
    /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/
  );
}
var BM25KeywordIndex = class {
  /** id -> stored doc (chunk + per-term frequencies + length). */
  docs = /* @__PURE__ */ new Map();
  /** term -> number of docs containing it (document frequency). */
  docFreq = /* @__PURE__ */ new Map();
  /** Running sum of all doc lengths, so avgdl = totalLength / docs.size. */
  totalLength = 0;
  /** Number of chunks currently held. */
  get size() {
    return this.docs.size;
  }
  /** Average document length over the corpus (avgdl), or 0 for an empty corpus. */
  get avgDocLength() {
    return this.docs.size === 0 ? 0 : this.totalLength / this.docs.size;
  }
  /**
   * Insert or replace by `chunk.id`. Re-adding the same id REPLACES the prior doc:
   * we first retract its contribution to the corpus stats (df, totalLength) then
   * add the fresh tokenization, so the inverted index and the length stats stay
   * exactly correct across edits.
   */
  add(chunks) {
    for (const chunk of chunks) {
      const prior = this.docs.get(chunk.id);
      if (prior) {
        this.retract(prior);
      }
      const tokens = tokenizeCodeAware(chunk.text);
      const termFreqs = /* @__PURE__ */ new Map();
      for (const tok of tokens) {
        termFreqs.set(tok, (termFreqs.get(tok) ?? 0) + 1);
      }
      const doc = { chunk, termFreqs, length: tokens.length };
      this.docs.set(chunk.id, doc);
      this.totalLength += doc.length;
      for (const term of termFreqs.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
  }
  /**
   * Drop every chunk whose `path` is in `paths` (incremental file change/delete),
   * retracting each dropped doc's contribution to the corpus stats so scoring of
   * the surviving docs stays correct.
   */
  removeByPath(paths) {
    if (paths.length === 0) return;
    const drop = new Set(paths);
    for (const [id, doc] of this.docs) {
      if (drop.has(doc.chunk.path)) {
        this.retract(doc);
        this.docs.delete(id);
      }
    }
  }
  /**
   * Retract one doc's contribution from the corpus stats: subtract its length from
   * the running total and decrement each of its distinct terms' document frequency
   * (deleting a term's entry when it reaches zero, so `docFreq` never retains dead
   * terms). Does NOT remove the doc from `docs` — the caller does that (so this is
   * reusable by both the replace path in {@link add} and the delete path in
   * {@link removeByPath}).
   */
  retract(doc) {
    this.totalLength -= doc.length;
    for (const term of doc.termFreqs.keys()) {
      const next = (this.docFreq.get(term) ?? 0) - 1;
      if (next <= 0) {
        this.docFreq.delete(term);
      } else {
        this.docFreq.set(term, next);
      }
    }
  }
  /**
   * Top-k chunks by BM25 relevance to `query`, sorted by score descending. Only
   * docs containing AT LEAST ONE query term are scored (BM25 of a doc with no
   * query term is 0). Returns `[]` for an empty corpus, a query with no tokens, or
   * k<=0; if k>matches, returns every matching doc (still sorted). Ties break on
   * chunk.id for determinism, mirroring the vector store.
   */
  search(query, k) {
    if (k <= 0 || this.docs.size === 0) return [];
    const queryTokens = tokenizeCodeAware(query);
    if (queryTokens.length === 0) return [];
    const queryTerms = new Set(queryTokens);
    const N = this.docs.size;
    const avgdl = this.avgDocLength;
    const scores = /* @__PURE__ */ new Map();
    for (const term of queryTerms) {
      const df = this.docFreq.get(term);
      if (df === void 0 || df === 0) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const doc of this.docs.values()) {
        const f = doc.termFreqs.get(term);
        if (f === void 0) continue;
        const denom = f + K1 * (1 - B + B * doc.length / (avgdl || 1));
        const contribution = idf * (f * (K1 + 1) / denom);
        scores.set(doc.chunk.id, (scores.get(doc.chunk.id) ?? 0) + contribution);
      }
    }
    const hits = [];
    for (const [id, score] of scores) {
      const doc = this.docs.get(id);
      if (doc) hits.push({ chunk: doc.chunk, score });
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0;
    });
    return k >= hits.length ? hits : hits.slice(0, k);
  }
};

// ../spikes/p0-supervisor/mcp-config.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { join as join9 } from "node:path";
var MCP_CONFIG_RELATIVE_PATH = ".glyphstudio/mcp.json";
var TRANSPORT_ISH_KEYS = ["url", "serverUrl", "transport", "type", "headers"];
var KNOWN_ENTRY_KEYS = ["command", "args", "env"];
function isPlainObject3(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function loadEntry(name, raw) {
  if (!isPlainObject3(raw)) {
    return { name, ok: false, reason: "entry is not an object" };
  }
  const command = raw.command;
  const hasCommand = typeof command === "string" && command.trim().length > 0;
  const transportIsh = TRANSPORT_ISH_KEYS.filter((k) => raw[k] !== void 0);
  if (!hasCommand && transportIsh.length > 0) {
    return {
      name,
      ok: false,
      reason: `unsupported transport (entry carries ${transportIsh.join(", ")}) \u2014 v1 brokers stdio servers only (command + args + env)`
    };
  }
  if (!hasCommand) {
    return { name, ok: false, reason: 'entry has no non-empty string "command"' };
  }
  let args = [];
  if (raw.args !== void 0) {
    if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) {
      return { name, ok: false, reason: '"args" must be an array of strings' };
    }
    args = raw.args;
  }
  let env = {};
  if (raw.env !== void 0) {
    if (!isPlainObject3(raw.env)) {
      return { name, ok: false, reason: '"env" must be an object of string values' };
    }
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== "string") {
        return {
          name,
          ok: false,
          reason: `"env.${k}" is not a string \u2014 env values are LITERAL strings only`
        };
      }
      env[k] = v;
    }
  }
  const ignoredKeys = Object.keys(raw).filter((k) => !KNOWN_ENTRY_KEYS.includes(k));
  return {
    name,
    ok: true,
    spec: { name, command: command.trim(), args, env, ignoredKeys }
  };
}
function loadMcpConfig(workspaceRoot) {
  const path6 = join9(workspaceRoot, MCP_CONFIG_RELATIVE_PATH);
  let rawText;
  try {
    rawText = readFileSync4(path6, "utf8");
  } catch {
    return { entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      entries: [],
      fileError: `${MCP_CONFIG_RELATIVE_PATH} is not valid JSON: ${String(err?.message ?? err)}`
    };
  }
  if (!isPlainObject3(parsed)) {
    return { entries: [], fileError: `${MCP_CONFIG_RELATIVE_PATH} top level is not an object` };
  }
  const serversRaw = parsed.mcpServers;
  if (serversRaw === void 0) {
    return { entries: [] };
  }
  if (!isPlainObject3(serversRaw)) {
    return { entries: [], fileError: '"mcpServers" is not an object' };
  }
  const entries = [];
  let usable = 0;
  for (const [name, raw] of Object.entries(serversRaw)) {
    if (name.length > MAX_MCP_SERVER_NAME_CHARS) {
      entries.push({
        name: name.slice(0, MAX_MCP_SERVER_NAME_CHARS),
        ok: false,
        reason: `server name exceeds ${MAX_MCP_SERVER_NAME_CHARS} chars (${name.length})`
      });
      continue;
    }
    if (name.trim().length === 0) {
      entries.push({ name, ok: false, reason: "server name is empty" });
      continue;
    }
    if (usable >= MAX_MCP_SERVERS) {
      entries.push({
        name,
        ok: false,
        reason: `over the ${MAX_MCP_SERVERS}-server cap \u2014 entry not brokered`
      });
      continue;
    }
    const entry = loadEntry(name, raw);
    if (entry.ok) usable += 1;
    entries.push(entry);
  }
  return { entries };
}

// ../spikes/p0-supervisor/mcp-client.ts
import { spawn as spawn2 } from "node:child_process";
var MCP_PROTOCOL_VERSION = "2025-03-26";
var DEFAULT_MCP_CALL_TIMEOUT_MS = 3e4;
var DEFAULT_MCP_INIT_TIMEOUT_MS = 1e4;
var DISPOSE_KILL_GRACE_MS = 2e3;
function buildMcpSpawnEnv(configEnv, baseEnv = process.env) {
  const out = {};
  if (baseEnv.PATH !== void 0) out.PATH = baseEnv.PATH;
  if (baseEnv.HOME !== void 0) out.HOME = baseEnv.HOME;
  for (const [k, v] of Object.entries(configEnv)) out[k] = v;
  return out;
}
function utf8Bytes(s) {
  return Buffer.byteLength(s, "utf8");
}
var McpStdioClient = class {
  spec;
  callTimeoutMs;
  initTimeoutMs;
  logLine;
  child;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  stdoutBuffer = "";
  /** In-flight lazy start (de-dupes concurrent first uses). */
  startPromise;
  statusValue = "idle";
  statusReasonValue;
  negotiatedVersion;
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
    this.initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_MCP_INIT_TIMEOUT_MS;
    this.logLine = opts.logLine ?? (() => {
    });
  }
  /** The server name this client brokers. */
  get name() {
    return this.spec.name;
  }
  /**
   * The HONEST status `mcp/list` reports for this client right now:
   * 'ok' once initialized, 'spawn-failed' / 'init-failed' after a failure
   * (including a crash/EOF after a successful start — the child is GONE, so
   * the next list reports it as failed, never as silently healthy).
   */
  get status() {
    if (this.statusValue === "ok") return "ok";
    if (this.statusValue === "init-failed") return "init-failed";
    return "spawn-failed";
  }
  /** Short, non-secret reason accompanying a non-'ok' {@link status}. */
  get statusReason() {
    return this.statusReasonValue;
  }
  /** The protocolVersion the server answered initialize with (once started). */
  get protocolVersion() {
    return this.negotiatedVersion;
  }
  /**
   * Spec identity, used by the broker to detect a config edit (a changed
   * command/args/env must produce a NEW child, never reuse a stale one).
   */
  get specIdentity() {
    return JSON.stringify({
      command: this.spec.command,
      args: this.spec.args,
      env: this.spec.env
    });
  }
  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */
  /** Lazily spawn + initialize the child. Rejects with the honest failure reason. */
  ensureStarted() {
    if (this.statusValue === "ok") return Promise.resolve();
    if (this.statusValue === "disposed") {
      return Promise.reject(new Error("client is disposed"));
    }
    if (this.statusValue === "spawn-failed" || this.statusValue === "init-failed") {
      return Promise.reject(
        new Error(this.statusReasonValue ?? `server is ${this.statusValue}`)
      );
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => {
      this.startPromise = void 0;
    });
    return this.startPromise;
  }
  async start() {
    const env = buildMcpSpawnEnv(this.spec.env);
    let child;
    try {
      child = spawn2(this.spec.command, [...this.spec.args], {
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      this.fail("spawn-failed", `spawn failed: ${String(err?.message ?? err)}`);
      throw new Error(this.statusReasonValue);
    }
    this.child = child;
    child.on("error", (err) => {
      this.fail("spawn-failed", `spawn failed: ${String(err?.message ?? err)}`);
    });
    child.on("exit", (code, signal) => {
      const why = `MCP server '${this.spec.name}' exited (code ${code ?? "null"}, signal ${signal ?? "null"})`;
      if (this.statusValue !== "disposed") {
        this.fail(this.statusValue === "ok" ? "spawn-failed" : "init-failed", why);
      } else {
        this.rejectAllPending(new Error(why));
      }
    });
    child.stdout?.on("data", (chunk) => this.ingest(chunk));
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text.length > 0) this.logLine(`[mcp:${this.spec.name}] ${text}`);
    });
    try {
      const initResult = await this.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "glyphstudio-supervisor", version: "0.0.0-p0" }
        },
        this.initTimeoutMs
      );
      const serverVersion = initResult && typeof initResult.protocolVersion === "string" ? initResult.protocolVersion : void 0;
      if (!serverVersion) {
        throw new Error("initialize result carries no protocolVersion");
      }
      this.negotiatedVersion = serverVersion;
      this.notify("notifications/initialized", {});
      this.statusValue = "ok";
      this.statusReasonValue = void 0;
    } catch (err) {
      const reason = `initialize failed: ${String(err?.message ?? err)}`;
      this.fail("init-failed", reason);
      this.killChild();
      throw new Error(this.statusReasonValue ?? reason);
    }
  }
  /**
   * Record a failure state + settle all in-flight calls honestly. FIRST
   * FAILURE WINS: a later, derived failure (e.g. the initialize request
   * rejecting BECAUSE the spawn errored) never re-labels the root cause.
   */
  fail(status, reason) {
    if (this.statusValue === "disposed" || this.statusValue === "spawn-failed" || this.statusValue === "init-failed") {
      this.rejectAllPending(new Error(reason));
      return;
    }
    this.statusValue = status;
    this.statusReasonValue = reason;
    this.rejectAllPending(new Error(reason));
  }
  rejectAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
  killChild() {
    try {
      this.child?.kill("SIGKILL");
    } catch {
    }
  }
  /**
   * Dispose the client: SIGTERM the child, SIGKILL after a grace period,
   * settle anything in flight. Idempotent; resolve-never-reject.
   */
  async dispose() {
    if (this.statusValue === "disposed") return;
    this.statusValue = "disposed";
    this.statusReasonValue = "disposed";
    this.rejectAllPending(new Error("client disposed"));
    const child = this.child;
    this.child = void 0;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve5) => {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, DISPOSE_KILL_GRACE_MS);
      killTimer.unref?.();
      const floorTimer = setTimeout(() => resolve5(), DISPOSE_KILL_GRACE_MS + 1e3);
      floorTimer.unref?.();
      child.once("exit", () => {
        clearTimeout(killTimer);
        clearTimeout(floorTimer);
        resolve5();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        clearTimeout(floorTimer);
        resolve5();
      }
    });
  }
  /* ---------------------------------------------------------------- *
   * Wire (newline-delimited JSON-RPC 2.0)
   * ---------------------------------------------------------------- */
  ingest(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    let nl;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      this.handleLine(line);
    }
  }
  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logLine(`[mcp:${this.spec.name}] dropping non-JSON stdout line`);
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg;
    if (typeof m.id === "number" && (m.result !== void 0 || m.error !== void 0)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error !== void 0) {
        const e = m.error;
        p.reject(
          new Error(
            `server error ${String(e?.code ?? "?")}: ${String(e?.message ?? "unknown error")}`
          )
        );
      } else {
        p.resolve(m.result);
      }
      return;
    }
    if (typeof m.id === "number" && typeof m.method === "string") {
      this.send({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32601, message: `method not supported by this client: ${m.method}` }
      });
      return;
    }
  }
  send(obj) {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return;
    try {
      stdin.write(`${JSON.stringify(obj)}
`);
    } catch {
    }
  }
  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve5, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve5, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  /* ---------------------------------------------------------------- *
   * MCP surface
   * ---------------------------------------------------------------- */
  /**
   * List the server's tools (spawning/initializing lazily). Enforces
   * {@link MAX_MCP_TOOLS_PER_SERVER} and {@link MAX_MCP_TOOL_NAME_CHARS}:
   * over-cap tools are DROPPED with the count reported (never silent).
   * Throws (with the honest reason) when the server cannot serve.
   */
  async listTools() {
    await this.ensureStarted();
    const result = await this.request("tools/list", {}, this.initTimeoutMs);
    const rawTools = Array.isArray(result?.tools) ? result.tools : [];
    const tools = [];
    let dropped = 0;
    for (const raw of rawTools) {
      if (typeof raw !== "object" || raw === null) {
        dropped += 1;
        continue;
      }
      const t = raw;
      const name = typeof t.name === "string" ? t.name : "";
      if (name.length === 0 || name.length > MAX_MCP_TOOL_NAME_CHARS) {
        dropped += 1;
        continue;
      }
      if (tools.length >= MAX_MCP_TOOLS_PER_SERVER) {
        dropped += 1;
        continue;
      }
      const info = { name };
      if (typeof t.description === "string") info.description = t.description;
      if (typeof t.inputSchema === "object" && t.inputSchema !== null) {
        try {
          info.inputSchemaJson = JSON.stringify(t.inputSchema);
        } catch {
        }
      }
      tools.push(info);
    }
    return { tools, droppedTools: dropped };
  }
  /**
   * Call one tool (spawning/initializing lazily). `argsJson` MUST already have
   * passed `assertMcpCallWellFormed` (the caller's gate). The outcome is
   * honest and never throws:
   *   - 'ok' + the result's `content` array serialized to JSON, byte-capped at
   *     {@link MAX_MCP_RESULT_JSON_BYTES} (over-cap → 'error' with the sizes —
   *     NEVER a silent truncation);
   *   - 'error' + reason on tool error (`isError`), timeout, crash/EOF, or an
   *     unusable server.
   */
  async callTool(tool, argsJson, timeoutMs) {
    try {
      await this.ensureStarted();
    } catch (err) {
      return { status: "error", reason: String(err?.message ?? err) };
    }
    let result;
    try {
      result = await this.request(
        "tools/call",
        { name: tool, arguments: JSON.parse(argsJson) },
        timeoutMs ?? this.callTimeoutMs
      );
    } catch (err) {
      return { status: "error", reason: String(err?.message ?? err) };
    }
    const r = typeof result === "object" && result !== null ? result : {};
    const content = Array.isArray(r.content) ? r.content : [];
    let resultJson;
    try {
      resultJson = JSON.stringify(content);
    } catch (err) {
      return {
        status: "error",
        reason: `tool result is not JSON-serializable: ${String(err?.message ?? err)}`
      };
    }
    const bytes = utf8Bytes(resultJson);
    if (bytes > MAX_MCP_RESULT_JSON_BYTES) {
      return {
        status: "error",
        reason: `tool result exceeds the ${MAX_MCP_RESULT_JSON_BYTES}-byte cap (${bytes} bytes) \u2014 refusing to truncate silently`
      };
    }
    if (r.isError === true) {
      const firstText = content.map((c) => typeof c === "object" && c !== null ? c.text : void 0).find((t) => typeof t === "string");
      return {
        status: "error",
        resultJson,
        reason: `tool reported an error${firstText ? `: ${firstText.slice(0, 200)}` : ""}`
      };
    }
    return { status: "ok", resultJson };
  }
};

// ../spikes/p0-supervisor/trust-gate.ts
function trustFromCapabilities(caps) {
  if (!caps.fsIsolated) return "untrusted";
  return caps.hardEgress ? "trusted" : "sandboxed-soft-egress";
}

// ../spikes/p0-supervisor/record-human.ts
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "node:fs";
var RecordHumanRefusal = class extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.name = "RecordHumanRefusal";
    this.kind = kind;
  }
};
var TAIL_UNREADABLE_MESSAGE = "trace tail unreadable \u2014 refusing to append (possible tamper or truncation)";
function assertRecordHumanWellFormed(type, payload) {
  if (!RECORD_HUMAN_EVENT_TYPES.includes(type)) {
    throw new RecordHumanRefusal(
      "invalid-type",
      `run/recordHuman type must be one of [${RECORD_HUMAN_EVENT_TYPES.join(", ")}], got '${String(type)}'`
    );
  }
  if (payload === void 0) return 0;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RecordHumanRefusal(
      "payload-not-serializable",
      "run/recordHuman payload must be a plain JSON object when present"
    );
  }
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (err) {
    throw new RecordHumanRefusal(
      "payload-not-serializable",
      `run/recordHuman payload is not JSON-serializable: ${String(err?.message ?? err)}`
    );
  }
  if (typeof serialized !== "string") {
    throw new RecordHumanRefusal(
      "payload-not-serializable",
      "run/recordHuman payload is not JSON-serializable"
    );
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_RECORD_HUMAN_PAYLOAD_BYTES) {
    throw new RecordHumanRefusal(
      "payload-over-cap",
      `run/recordHuman payload is ${bytes} bytes \u2014 over the ${MAX_RECORD_HUMAN_PAYLOAD_BYTES}-byte cap; refusing (payloads are small summaries, never content)`
    );
  }
  return bytes;
}
function rehydrateAppendHumanEvent(tracePath, req) {
  assertRecordHumanWellFormed(req.type, req.payload);
  if (!existsSync4(tracePath)) {
    throw new RecordHumanRefusal(
      "no-trace-file",
      `no trace file exists for this run (${tracePath}) \u2014 refusing to append`
    );
  }
  let raw;
  try {
    raw = readFileSync5(tracePath, "utf8");
  } catch (err) {
    throw new RecordHumanRefusal(
      "fs-error",
      `failed to read the run trace: ${String(err?.message ?? err)}`
    );
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    throw new RecordHumanRefusal("tail-unreadable", TAIL_UNREADABLE_MESSAGE);
  }
  let tail;
  try {
    tail = JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new RecordHumanRefusal("tail-unreadable", TAIL_UNREADABLE_MESSAGE);
  }
  const tailEvt = tail;
  if (tailEvt === null || typeof tailEvt !== "object" || typeof tailEvt.hash !== "string" || tailEvt.hash.length === 0 || typeof tailEvt.seq !== "number") {
    throw new RecordHumanRefusal("tail-unreadable", TAIL_UNREADABLE_MESSAGE);
  }
  let appended;
  try {
    const writer = createTraceWriter(tracePath);
    appended = writer.append({
      v: TRACE_EVENT_VERSION,
      runId: req.runId,
      seq: 0,
      // writer-authoritative; overwritten with tail.seq + 1
      ts: 0,
      // writer-authoritative; overwritten with Date.now()
      type: req.type,
      payload: req.payload ?? {},
      source: "human"
      // FORCED here — never caller-supplied
    });
  } catch (err) {
    if (err instanceof RecordHumanRefusal) throw err;
    throw new RecordHumanRefusal(
      "tail-unreadable",
      `${TAIL_UNREADABLE_MESSAGE}: ${String(err?.message ?? err)}`
    );
  }
  if (appended.prevHash !== tailEvt.hash || appended.seq !== tailEvt.seq + 1) {
    throw new RecordHumanRefusal(
      "fs-error",
      "append continuity check failed \u2014 the trace changed during the append; the chain position is not trustworthy"
    );
  }
  return appended;
}

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
    const resolvedModel = req.model ?? backend.defaultModel;
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
        ...resolvedModel ? { model: resolvedModel } : {},
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
import { spawn as spawn3 } from "node:child_process";
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
    const child = spawn3(this.codexPath, args, {
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
      await new Promise((resolve5) => {
        resolveNext = resolve5;
      });
    }
  }
};

// ../spikes/p0-model-gateway/ollama-backend.ts
var DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
var DEFAULT_OLLAMA_CHAT_MODEL = "qwen2.5-coder:7b";
var OLLAMA_MODEL_LIST_CAP = 16;
var ERROR_BODY_CAP = 300;
var OLLAMA_NUM_PREDICT_MIN = 1;
var OLLAMA_NUM_PREDICT_CAP = 8192;
function clampNumPredict(maxOutputTokens) {
  if (typeof maxOutputTokens !== "number" || !Number.isFinite(maxOutputTokens)) return void 0;
  const n = Math.floor(maxOutputTokens);
  return Math.min(OLLAMA_NUM_PREDICT_CAP, Math.max(OLLAMA_NUM_PREDICT_MIN, n));
}
function isLoopbackHost(host) {
  let url;
  try {
    url = new URL(host);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}
async function probeOllamaModels(host = DEFAULT_OLLAMA_HOST, cap = OLLAMA_MODEL_LIST_CAP) {
  if (!isLoopbackHost(host)) {
    return { ok: false, detail: `non-loopback ollama host "${host}" refused (local backend is loopback-only in v1)` };
  }
  let res;
  try {
    res = await fetch(`${host}/api/tags`);
  } catch (err) {
    return { ok: false, detail: `ollama daemon unreachable at ${host}: ${String(err?.message ?? err)}` };
  }
  if (!res.ok) {
    return { ok: false, detail: `ollama /api/tags HTTP ${res.status}` };
  }
  try {
    const data = await res.json();
    const names = (Array.isArray(data.models) ? data.models : []).map((m) => typeof m?.name === "string" ? m.name : void 0).filter((n) => typeof n === "string" && n.length > 0).slice(0, cap);
    return { ok: true, models: names };
  } catch (err) {
    return { ok: false, detail: `ollama /api/tags returned an unparseable body: ${String(err?.message ?? err)}` };
  }
}
var OllamaChatBackend = class {
  id = "ollama";
  /** The model used when a turn has no override — surfaced so the gateway's trace breadcrumb names it. */
  defaultModel;
  host;
  timeoutMs;
  /** Set at construction when `host` failed the loopback guard; fails every turn honestly. */
  hostError;
  constructor(opts = {}) {
    this.host = opts.host ?? DEFAULT_OLLAMA_HOST;
    this.defaultModel = opts.model ?? DEFAULT_OLLAMA_CHAT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? 12e4;
    this.hostError = isLoopbackHost(this.host) ? void 0 : `refusing non-loopback ollama host "${this.host}": the local chat backend is loopback-only in v1 (a remote daemon would silently turn the sovereign-local leg into network egress).`;
  }
  async *chatTurn(req, opts) {
    if (this.hostError) {
      yield { type: "error", message: this.hostError };
      return;
    }
    const model = req.model ?? this.defaultModel;
    const numPredict = clampNumPredict(req.maxOutputTokens);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const abortMessage = () => timedOut ? `ollama chat turn timed out after ${this.timeoutMs}ms` : "ollama chat turn aborted";
    try {
      let res;
      try {
        res = await fetch(`${this.host}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            // Content-only projection: role/content exactly (no extra fields leak).
            messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
            stream: true,
            ...numPredict !== void 0 ? { options: { num_predict: numPredict } } : {}
          }),
          signal: controller.signal
        });
      } catch (err) {
        if (controller.signal.aborted) {
          yield { type: "error", message: abortMessage() };
          return;
        }
        yield {
          type: "error",
          message: `ollama daemon unreachable at ${this.host}: ${String(err?.message ?? err)}`
        };
        return;
      }
      if (!res.ok) {
        let tail = "";
        try {
          tail = (await res.text()).slice(0, ERROR_BODY_CAP);
        } catch {
        }
        yield { type: "error", message: `ollama /api/chat HTTP ${res.status}${tail ? `: ${tail}` : ""}` };
        return;
      }
      if (!res.body) {
        yield { type: "error", message: "ollama /api/chat returned no response body to stream" };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let usage;
      let sawDone = false;
      const handleLine = (line) => {
        let chunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          return {
            type: "error",
            message: `ollama /api/chat emitted a malformed NDJSON line (${line.slice(0, 80)}\u2026) \u2014 failing the turn rather than skipping unverified output`
          };
        }
        if (chunk.error !== void 0) {
          return { type: "error", message: `ollama /api/chat reported an error: ${String(chunk.error).slice(0, ERROR_BODY_CAP)}` };
        }
        const content = chunk.message?.content;
        if (typeof content === "string" && content.length > 0) {
          fullText += content;
          if (chunk.done !== true) return { type: "delta", text: content };
        }
        if (chunk.done === true) {
          sawDone = true;
          const input = typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : void 0;
          const output = typeof chunk.eval_count === "number" ? chunk.eval_count : void 0;
          if (input !== void 0 || output !== void 0) {
            usage = {
              ...input !== void 0 ? { inputTokens: input } : {},
              ...output !== void 0 ? { outputTokens: output } : {}
            };
          }
        }
        return void 0;
      };
      while (true) {
        let step;
        try {
          step = await reader.read();
        } catch (err) {
          yield {
            type: "error",
            message: controller.signal.aborted ? abortMessage() : `ollama /api/chat stream failed mid-turn: ${String(err?.message ?? err)}`
          };
          return;
        }
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = handleLine(line);
          if (event) {
            yield event;
            if (event.type === "error") return;
          }
          if (sawDone) break;
        }
        if (sawDone) break;
      }
      const trailing = (buffer + decoder.decode()).trim();
      if (!sawDone && trailing) {
        const event = handleLine(trailing);
        if (event) {
          yield event;
          if (event.type === "error") return;
        }
      }
      if (!sawDone) {
        yield {
          type: "error",
          message: "ollama /api/chat stream ended without a terminal done chunk \u2014 the turn is incomplete"
        };
        return;
      }
      yield { type: "done", text: fullText, ...usage ? { usage } : {} };
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
};

// ../spikes/p0-model-gateway/governed-agentic-run.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { join as join13 } from "node:path";
import { existsSync as existsSync6, mkdirSync as mkdirSync6, writeFileSync as writeFileSync3 } from "node:fs";
import { createPublicKey as createPublicKey3 } from "node:crypto";

// ../spikes/p0-supervisor/bundle.ts
import { cpSync as cpSync2, mkdirSync as mkdirSync5, readFileSync as readFileSync6, writeFileSync as writeFileSync2 } from "node:fs";
import * as path5 from "node:path";
import {
  createHash as createHash6,
  createPrivateKey,
  createPublicKey as createPublicKey2
} from "node:crypto";

// ../spikes/p0-verifier/verifier.ts
import { cpSync, existsSync as existsSync5, readdirSync as readdirSync2, rmSync as rmSync3, statSync as statSync2 } from "node:fs";
import * as path4 from "node:path";

// ../spikes/p0-sandbox/docker-runtime.ts
import { spawn as spawn4, spawnSync } from "node:child_process";
import { randomUUID as randomUUID4 } from "node:crypto";
init_egress_proxy();
var WORKDIR_MOUNT = "/workspace";
var HOME_MOUNT = "/home/agent";
var DEFAULT_IMAGE = process.env.GLYPHSTUDIO_SANDBOX_IMAGE ?? "node:22-alpine";
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
  return `glyphstudio-${safe}`;
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
  return new Promise((resolve5) => {
    const child = spawn4("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
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
      resolve5(result);
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
function softEgressNotAcknowledgedError(reason) {
  return new Error(
    `DockerSandboxRuntime: ${reason} On the Docker-local runtime a network:{ allow } spec is an APPLICATION-LAYER (proxy-only) egress allowlist, NOT a hard boundary \u2014 a process that strips the HTTP(S) proxy env vars or opens a raw socket can bypass it. Pass network:{ allow, egressMode: 'soft-proxy-allow' } to opt into the soft allowlist with eyes open, or use network:'deny' for a hard boundary (--network none); a hard egress allowlist (egressMode:'hard-allowlist') is the remote plane's job, not this runtime's.`
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
  /**
   * The egress modes the Docker-local runtime can STRUCTURALLY honor:
   *   - 'hard-deny'        — `--network none`: no interface/route/DNS (hard).
   *   - 'soft-proxy-allow' — the application-layer (proxy-only) allowlist.
   * It deliberately does NOT list 'hard-allowlist': a hard network-namespace
   * default-DROP allowlist is the Firecracker remote-plane's job, so a spec
   * requesting it is rejected by {@link negotiateEgress} rather than silently
   * downgraded to the soft proxy posture.
   */
  supportedEgressModes() {
    return ["hard-deny", "soft-proxy-allow"];
  }
  async createSandbox(spec) {
    const negotiated = negotiateEgress(this, spec);
    if (!negotiated.ok) {
      throw softEgressNotAcknowledgedError(negotiated.reason);
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
  const srcEntries = new Set(readdirSync2(src).filter((e) => !exclude.has(e)));
  for (const entry of readdirSync2(dest)) {
    if (exclude.has(entry)) continue;
    if (!srcEntries.has(entry)) {
      rmSync3(path4.join(dest, entry), { recursive: true, force: true });
    }
  }
  for (const entry of srcEntries) {
    const srcPath = path4.join(src, entry);
    const destPath = path4.join(dest, entry);
    const st = statSync2(srcPath);
    if (st.isDirectory()) {
      if (existsSync5(destPath) && !statSync2(destPath).isDirectory()) {
        rmSync3(destPath, { force: true });
      }
      cpSync(srcPath, destPath, { recursive: true, force: true });
      mirrorDir(srcPath, destPath, /* @__PURE__ */ new Set());
    } else {
      if (existsSync5(destPath) && statSync2(destPath).isDirectory()) {
        rmSync3(destPath, { recursive: true, force: true });
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
  const runDir = path4.join(input.runsBaseDir ?? DEFAULT_RUNS_BASE_DIR, `verifier-${runId}`);
  const verifierWorktree = path4.join(runDir, "worktree");
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
      if (!existsSync5(sourceWorktree)) {
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

// ../spikes/p0-model-gateway/agentic-backend.ts
import { spawn as spawn5 } from "node:child_process";
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
  const child = spawn5(codexPath, args, {
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
        const path6 = asStr(ch.path);
        const kind = asStr(ch.kind) ?? "unknown";
        if (path6) {
          fileChangeReports.push({ path: path6, kind });
          push({ type: "file_change", path: path6, kind });
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
  const closed = new Promise((resolve5) => {
    child.on("error", (err) => {
      cleanup();
      push({
        type: "error",
        message: `codex spawn failed: ${String(err?.message ?? err)}`
      });
      finished = true;
      wake();
      resolve5(null);
    });
    child.on("close", (code) => {
      cleanup();
      if (stdoutBuf.trim().length > 0) {
        handleLine(stdoutBuf);
        stdoutBuf = "";
      }
      resolve5(code);
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
    await new Promise((resolve5) => {
      resolveNext = resolve5;
    });
  }
}

// ../spikes/p0-supervisor/bundle.ts
function keyIdForPublicKey2(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return createHash6("sha256").update(spki).digest("hex").slice(0, 16);
}
function resolveVerifierKeypair(verifierKeyPath2) {
  if (verifierKeyPath2 === void 0) {
    return generateVerifierKeypair();
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync6(verifierKeyPath2, "utf8"));
  } catch (err) {
    throw new Error(
      `bundle: failed to load verifier private key from ${verifierKeyPath2}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const publicKey = createPublicKey2(privateKey);
  return { privateKey, publicKey, keyId: keyIdForPublicKey2(publicKey) };
}
function writeVerifiedBundle(input) {
  const { outDir, tracePath, verdict, publicKey, actorClaim, readme, diff } = input;
  mkdirSync5(outDir, { recursive: true });
  cpSync2(tracePath, path5.join(outDir, "trace.jsonl"), { force: true });
  writeFileSync2(
    path5.join(outDir, "verdict.json"),
    JSON.stringify(verdict, null, 2) + "\n",
    "utf8"
  );
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync2(path5.join(outDir, "verifier-public-key.pem"), publicKeyPem, "utf8");
  writeFileSync2(
    path5.join(outDir, "actor-claims.json"),
    JSON.stringify(actorClaim, null, 2) + "\n",
    "utf8"
  );
  writeFileSync2(path5.join(outDir, "README.md"), readme, "utf8");
  if (typeof diff === "string" && diff.trim().length > 0) {
    writeFileSync2(path5.join(outDir, "diff.patch"), diff, "utf8");
  }
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

// ../spikes/p0-sandbox/runtime-select.ts
import { accessSync as accessSync2, statSync as statSync3, constants as fsConstants2 } from "node:fs";
import { join as pathJoin2, delimiter as pathDelimiter2 } from "node:path";

// ../spikes/p0-sandbox/firecracker-runtime.ts
import { lookup } from "node:dns/promises";
init_firecracker_egress_rules();

// ../spikes/p0-sandbox/firecracker-rootfs.ts
var GUEST_WORKSPACE = "/workspace";
var GUEST_HOME = "/home/agent";
function isAbsolutePath(p) {
  return typeof p === "string" && p.startsWith("/") && p.trim().length > 0;
}
function buildMountPlan(input) {
  const { worktreeDir, homeDir } = input;
  if (!isAbsolutePath(worktreeDir)) {
    throw new Error(
      "buildMountPlan: worktreeDir is missing or not an absolute host path; refusing to build a mount plan with no workspace."
    );
  }
  if (!isAbsolutePath(homeDir)) {
    throw new Error(
      "buildMountPlan: homeDir is missing or not an absolute host path; refusing to build a mount plan with no synthetic HOME."
    );
  }
  if (worktreeDir === homeDir) {
    throw new Error(
      "buildMountPlan: worktreeDir and homeDir are the same host path; the worktree and synthetic HOME must be SEPARATE shares so neither can be reached through the other's guest path."
    );
  }
  const mounts = [
    { hostPath: worktreeDir, guestPath: GUEST_WORKSPACE, readonly: false, tag: "workspace" },
    { hostPath: homeDir, guestPath: GUEST_HOME, readonly: false, tag: "home" }
  ];
  return { mounts, secretsBaked: false };
}

// ../spikes/p0-sandbox/firecracker-runtime.ts
init_firecracker_vsock();
var defaultResolveHosts = async (hosts) => {
  const resolved = /* @__PURE__ */ new Map();
  await Promise.all(
    hosts.map(async (host) => {
      try {
        const records = await lookup(host, { all: true, verbatim: true });
        const ips = records.map((r) => r.address);
        if (ips.length > 0) resolved.set(host, ips);
      } catch {
      }
    })
  );
  return resolved;
};
var DEFAULT_MAX_CONCURRENT_VMS = 8;
var DEFAULT_MAX_TOTAL_GUEST_MEM_MIB = 16384;
function allowedHostnames(spec) {
  if (spec.network === "deny") return [];
  return spec.network.allow.map((entry) => hostOf(entry));
}
function hostOf(entry) {
  const trimmed = entry.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close !== -1) return trimmed.slice(0, close + 1);
    return trimmed;
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return trimmed;
  const portStr = trimmed.slice(idx + 1);
  const head = trimmed.slice(0, idx);
  if (/^\d+$/.test(portStr) && !head.includes(":")) return head;
  return trimmed;
}
var PLACEHOLDER_GUEST_IP = "169.254.0.2";
function placeholderNsName(runId) {
  return `glyph-fc-${runId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
var FirecrackerSandboxRuntime = class {
  /** Informational only; per the contract, callers must not parse this. */
  name = "firecracker";
  launcher;
  resolveHosts;
  maxConcurrentVms;
  maxTotalGuestMemMib;
  /** Live-guest accounting (the plane capacity cap). */
  liveVms = 0;
  committedGuestMemMib = 0;
  constructor(options = {}) {
    this.launcher = options.launcher ?? realVsockLauncher;
    this.resolveHosts = options.resolveHosts ?? defaultResolveHosts;
    this.maxConcurrentVms = Math.max(1, options.maxConcurrentVms ?? DEFAULT_MAX_CONCURRENT_VMS);
    this.maxTotalGuestMemMib = Math.max(
      1,
      options.maxTotalGuestMemMib ?? DEFAULT_MAX_TOTAL_GUEST_MEM_MIB
    );
  }
  /**
   * The egress modes this runtime can STRUCTURALLY honor: a no-egress namespace
   * ('hard-deny') and a default-DROP + allowlist ('hard-allowlist'). It does NOT
   * list 'soft-proxy-allow' — that soft, application-layer posture is the
   * Docker-local runtime's, and a spec requesting it is rejected by
   * {@link negotiateEgress} rather than silently hardened or downgraded.
   */
  supportedEgressModes() {
    return ["hard-deny", "hard-allowlist"];
  }
  /**
   * HONEST capability report for the trust gate. This runtime ALWAYS earns
   * fs-isolation (the guest sees only the two-mount rootfs — worktree + synthetic
   * HOME — and its env is exactly spec.env + HOME, never the host's), and it earns
   * HARD egress for both hard postures it supports: a 'deny' namespace and a
   * 'hard-allowlist' default-DROP allowlist. (A 'soft-proxy-allow' allow spec never
   * reaches a sandbox here — it is rejected by negotiation — so it is not a posture
   * this runtime reports hardEgress for.)
   */
  capabilities(spec) {
    const hardEgress = spec.network === "deny" || spec.network.egressMode === "hard-allowlist";
    return { fsIsolated: true, hardEgress };
  }
  async createSandbox(spec) {
    const negotiated = negotiateEgress(this, spec);
    if (!negotiated.ok) {
      throw new Error(
        `FirecrackerSandboxRuntime: ${negotiated.reason} This runtime provides only HARD egress postures: network:'deny' (no egress) or network:{ allow, egressMode: 'hard-allowlist' } (a network-namespace default-DROP allowlist). The soft, application-layer allowlist ('soft-proxy-allow') is the Docker-local runtime's posture, not this one's.`
      );
    }
    const resources = guestResources(spec);
    if (this.liveVms + 1 > this.maxConcurrentVms) {
      throw new Error(
        `FirecrackerSandboxRuntime: plane at capacity \u2014 ${this.liveVms} live VMs of a ${this.maxConcurrentVms}-VM cap. Refusing to provision; retry after a running sandbox tears down.`
      );
    }
    if (this.committedGuestMemMib + resources.memMib > this.maxTotalGuestMemMib) {
      throw new Error(
        `FirecrackerSandboxRuntime: plane at memory capacity \u2014 ${this.committedGuestMemMib} MiB committed of a ${this.maxTotalGuestMemMib} MiB cap; this guest needs ${resources.memMib} MiB. Refusing to provision; retry after a running sandbox tears down.`
      );
    }
    this.liveVms += 1;
    this.committedGuestMemMib += resources.memMib;
    let reservationHeld = true;
    const releaseReservation = () => {
      if (!reservationHeld) return;
      reservationHeld = false;
      this.liveVms -= 1;
      this.committedGuestMemMib -= resources.memMib;
    };
    const mountPlan = buildMountPlan({ worktreeDir: spec.workdir, homeDir: spec.home });
    let transport;
    try {
      const resolved = spec.network === "deny" ? /* @__PURE__ */ new Map() : await this.resolveHosts(allowedHostnames(spec));
      const ruleset = compileEgressRuleset(
        { network: spec.network, resolved },
        { guestIp: PLACEHOLDER_GUEST_IP, nsName: placeholderNsName(spec.runId) }
      );
      transport = await this.launcher({ spec, mountPlan, ruleset });
    } catch (err) {
      releaseReservation();
      throw err;
    }
    let torndown = false;
    const sandbox = {
      spec,
      async exec(req) {
        if (torndown) {
          return { exitCode: 1, stdout: "", stderr: "sandbox has been torn down" };
        }
        return transport.exec({
          command: req.command,
          cwd: req.cwd ?? GUEST_WORKSPACE,
          env: { ...spec.env, HOME: GUEST_HOME },
          timeoutMs: req.timeoutMs
        });
      },
      async teardown() {
        if (torndown) return;
        torndown = true;
        try {
          await transport.close();
        } finally {
          releaseReservation();
        }
      }
    };
    return sandbox;
  }
};

// ../spikes/p0-sandbox/local-runtime.ts
import { spawn as spawn7 } from "node:child_process";
var SIGNAL_EXIT_CODE = 1;
var TIMEOUT_EXIT_CODE2 = 124;
function runChild(command, cwd, env, timeoutMs) {
  return new Promise((resolve5) => {
    const [executable, ...args] = command;
    const child = spawn7(executable, args, {
      cwd,
      env,
      // ONLY the injected env; process.env is intentionally NOT inherited.
      stdio: ["ignore", "pipe", "pipe"]
    });
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
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve5(result);
    };
    child.on("error", (err) => {
      finish({
        exitCode: SIGNAL_EXIT_CODE,
        stdout,
        stderr: stderr + String(err.message ?? err)
      });
    });
    child.on("close", (code, signal) => {
      let exitCode;
      if (timedOut) {
        exitCode = TIMEOUT_EXIT_CODE2;
      } else if (code === null) {
        exitCode = SIGNAL_EXIT_CODE;
      } else {
        exitCode = code;
      }
      void signal;
      finish({
        exitCode,
        stdout,
        stderr,
        ...timedOut ? { timedOut: true } : {}
      });
    });
  });
}
var LocalExecRuntime = class {
  /**
   * Informational identifier only. Per the SandboxRuntime contract this MUST
   * NOT be parsed by callers to special-case behavior.
   */
  name = "local-exec";
  async createSandbox(spec) {
    const sandbox = {
      spec,
      async exec(req) {
        const cwd = req.cwd ?? spec.workdir;
        const env = { ...spec.env, HOME: spec.home };
        const timeoutMs = req.timeoutMs ?? spec.resourceLimits?.timeoutMs;
        return runChild(req.command, cwd, env, timeoutMs);
      },
      async teardown() {
      }
    };
    return sandbox;
  }
};

// ../spikes/p0-sandbox/runtime-select.ts
var FIRECRACKER_BINARIES = ["firecracker", "jailer"];
var KVM_DEVICE = "/dev/kvm";
function defaultKvmAccessible() {
  try {
    accessSync2(KVM_DEVICE, fsConstants2.R_OK);
    return true;
  } catch {
    return false;
  }
}
function defaultHasBinary(name) {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  if (rawPath.length === 0) return false;
  const dirs = rawPath.split(pathDelimiter2).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const full = pathJoin2(dir, name);
    try {
      const st = statSync3(full);
      if (!st.isFile()) continue;
      accessSync2(full, fsConstants2.X_OK);
      return true;
    } catch {
    }
  }
  return false;
}
var REAL_AVAILABILITY_DEPS = {
  platform: process.platform,
  kvmAccessible: defaultKvmAccessible,
  hasBinary: defaultHasBinary
};
function firecrackerAvailable(deps = {}) {
  const { platform, kvmAccessible, hasBinary } = { ...REAL_AVAILABILITY_DEPS, ...deps };
  if (platform !== "linux") return false;
  if (!kvmAccessible()) return false;
  return FIRECRACKER_BINARIES.every((bin) => hasBinary(bin));
}
function selectSandboxRuntime(opts = {}) {
  const prefer = opts.prefer;
  const fcAvailable = opts.firecrackerAvailable ?? false;
  const dockerOk = opts.dockerAvailable ?? false;
  if (prefer === "firecracker" && fcAvailable) {
    return { backend: "firecracker", runtime: new FirecrackerSandboxRuntime() };
  }
  if (dockerOk) {
    return { backend: "docker", runtime: new DockerSandboxRuntime() };
  }
  return { backend: "local", runtime: new LocalExecRuntime() };
}
function parseSandboxRuntimePreference(raw) {
  return raw === "auto" || raw === "docker" || raw === "firecracker" || raw === "off" ? raw : void 0;
}
function resolveIsolatedSandboxRuntime(opts = {}) {
  const prefer = opts.prefer ?? "auto";
  if (prefer === "off") {
    return {
      available: false,
      reason: "runtime preference 'off' \u2014 sandboxed verification disabled by configuration"
    };
  }
  const fcOk = prefer === "firecracker" && (opts.firecrackerAvailable ?? (() => firecrackerAvailable()))();
  const dockerOk = (opts.dockerAvailable ?? dockerAvailable)();
  const selected = selectSandboxRuntime({
    ...prefer === "firecracker" ? { prefer: "firecracker" } : {},
    firecrackerAvailable: fcOk,
    dockerAvailable: dockerOk
  });
  if (selected.backend === "local") {
    return {
      available: false,
      reason: prefer === "firecracker" ? "firecracker unavailable on this host (requires linux + /dev/kvm + firecracker/jailer on PATH) and docker daemon not running" : "docker daemon not running"
    };
  }
  return { available: true, backend: selected.backend, runtime: selected.runtime };
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
function writeEphemeralVerifyPolicy(verifyCommand, runDir) {
  const dir = join13(runDir, "verifier-policy");
  mkdirSync6(dir, { recursive: true });
  const policyPath = join13(dir, "verify-policy.json");
  writeFileSync3(
    policyPath,
    JSON.stringify(
      {
        version: 1,
        defaults: { file_read: "deny", file_write: "deny", command: "deny", network: "deny", mcp: "deny" },
        allow: { read_paths: [], write_paths: [], commands: [], network: [] },
        deny: { read_paths: [], write_paths: [], commands: [] },
        // The reviewed verification target — exactly the resolved verify command.
        verify: [[...verifyCommand]]
      },
      null,
      2
    ),
    "utf8"
  );
  return policyPath;
}
function formatPlanClaim(plan) {
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join("  ");
  return `${plan.goal} \u2014 steps: ${steps}`;
}
function buildAgenticBundleReadme(info) {
  const independent = info.verifierIsolation === "independent-sandboxed";
  const isolationNote = independent ? "(independent sandboxed product verifier \u2014 may reach assurance:full)." : "(inline check over the actor worktree \u2014 a real but NOT independent signal; it can NEVER reach assurance:full).";
  const diffLine = info.hasDiff ? '- `diff.patch` \u2014 the per-run unified git diff (the IDE binds a "Verified:" trailer against this; content-fingerprint match vs the staged diff).' : "- (no `diff.patch`: verify-only / non-git / no edit \u2014 no trailer is claimed.)";
  return [
    "# GlyphStudio verified-evidence bundle (governed agentic build)",
    "",
    `- run id: ${info.runId}`,
    `- intent: ${info.intent.slice(0, 200)}`,
    `- posture: ${AGENTIC_RUN_POSTURE} (the actor edited the real working tree; the git diff is the review surface, NOT a sandbox \u2014 this run is NOT product-trusted).`,
    `- overall verdict: ${info.overallVerdict}`,
    `- verifier isolation: ${info.verifierIsolation} ${isolationNote}`,
    `- real build/test check ran: ${info.verifyRan ? "yes" : "no"}`,
    `- trace root hash: ${info.traceRootHash}`,
    `- signing key id: ${info.keyId}`,
    "",
    "## Files",
    "- `trace.jsonl` \u2014 the actor's append-only, hash-chained trace (verbatim).",
    "- `verdict.json` \u2014 the SIGNED VerifierVerdict (authoritative outcome).",
    "- `verifier-public-key.pem` \u2014 the verifier's SPKI public key (resolve out-of-band).",
    "- `actor-claims.json` \u2014 the actor's SELF-REPORTED claim (NOT authoritative).",
    diffLine,
    "- `README.md` \u2014 this file.",
    ""
  ].join("\n");
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
    runDir = join13(tracePath, "..", "..");
  } else {
    const created = createRun(opts.runsBaseDir);
    runId = created.runId;
    runDir = created.dir;
    tracePath = join13(runSubdirPath(runDir, "trace"), "trace.jsonl");
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
  let agentic2;
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
        agentic2 = ev.result;
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
  const codexOk = agentic2 !== void 0 && agentic2.exitCode === 0 && !buildError;
  transition(codexOk ? "completed" : "failed", codexOk ? "agentic build completed" : `agentic build failed: ${buildError ?? `codex exit ${agentic2?.exitCode ?? "unknown"}`}`);
  let verdict;
  let verifyRan;
  let verifierIsolation;
  let verifyCommandSource;
  const autoOpt = opts.autoIndependentVerifier;
  const autoEnabled = autoOpt !== false;
  const autoCfg = typeof autoOpt === "object" ? autoOpt : void 0;
  const resolvedVerifyCommand = opts.verifyCommand && opts.verifyCommand.length > 0 ? opts.verifyCommand : void 0;
  let isolationUnavailableReason;
  let independentResult;
  if (opts.independentVerifier) {
    independentResult = await runIndependentVerification({
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
    });
  } else if (!autoEnabled) {
    isolationUnavailableReason = "auto independent verifier disabled (autoIndependentVerifier:false)";
  } else if (!resolvedVerifyCommand) {
    isolationUnavailableReason = "no verify command resolved \u2014 nothing for the independent verifier to run";
  } else {
    let runtimeUp;
    let selectedRuntime = autoCfg?.runtime;
    if (autoCfg?.runtimeAvailable) {
      runtimeUp = autoCfg.runtimeAvailable();
      if (!runtimeUp) {
        isolationUnavailableReason = "Docker unavailable (injected runtime probe reported down)";
      }
    } else {
      const resolution = resolveIsolatedSandboxRuntime({ prefer: opts.verifierRuntime ?? "auto" });
      runtimeUp = resolution.available;
      if (resolution.available) {
        selectedRuntime = selectedRuntime ?? resolution.runtime;
      } else {
        isolationUnavailableReason = resolution.reason;
      }
    }
    if (runtimeUp) {
      const policyPath = writeEphemeralVerifyPolicy(resolvedVerifyCommand, runDir);
      independentResult = await runIndependentVerification({
        repoPath: opts.cwd,
        sourceWorktree: opts.cwd,
        policyPath,
        tracePath,
        privateKey: verifierKey,
        ...selectedRuntime ? { runtime: selectedRuntime } : {},
        ...autoCfg?.runsBaseDir !== void 0 ? { runsBaseDir: autoCfg.runsBaseDir } : {},
        ...opts.onOperatorLog ? { onOperatorLog: opts.onOperatorLog } : {}
      });
    } else {
      (opts.onOperatorLog ?? (() => {
      }))(
        `${isolationUnavailableReason ?? "no isolating runtime available"} \u2014 using the inline-unsandboxed check (degraded; not independently verified)`
      );
    }
  }
  if (independentResult && independentResult.ran) {
    verdict = independentResult.verdict;
    verifyRan = independentResult.verdict.checks.some(
      (c) => c.status === "pass" || c.status === "fail"
    );
    verifierIsolation = "independent-sandboxed";
    verifyCommandSource = verifyRan ? opts.independentVerifier ? "override" : opts.verifyCommandSource ?? "override" : "none";
    append(
      "verifier_verdict",
      {
        overallVerdict: verdict.overallVerdict,
        traceRootHash: verdict.traceRootHash,
        checks: verdict.checks,
        verifierIsolation,
        verifyCommandSource,
        ...verdict.signature ? { keyId: verdict.signature.keyId } : {}
      },
      "verifier"
    );
  } else {
    if (independentResult && !independentResult.ran) {
      isolationUnavailableReason ??= "independent verifier could not run (error) \u2014 fell back to the inline-unsandboxed check";
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
      const changed = agentic2?.changedFiles.length ?? 0;
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
    append(
      "verifier_verdict",
      {
        overallVerdict,
        traceRootHash,
        checks,
        verifierIsolation,
        verifyCommandSource,
        keyId: signature.keyId
      },
      "verifier"
    );
  }
  emit({ type: "verdict", verdict });
  emit({ type: "run_closed", runId, ok: verdict.overallVerdict === "pass" });
  try {
    if (existsSync6(tracePath)) {
      const verifierPublicKey = createPublicKey3(verifierKey);
      const actorClaim = {
        actor: AGENTIC_AGENT_BACKEND,
        intent: opts.prompt.slice(0, 200),
        // The APPROVED plan this build executed against (#8 plan mode — ADDITIVE;
        // absent when no plan was approved). A claims-panel STRING (the panel's
        // fieldBlock('Plan', c.plan) renders text): goal + numbered step titles,
        // compact. Advisory provenance only — NEVER an assurance input.
        ...opts.approvedPlan ? { plan: formatPlanClaim(opts.approvedPlan) } : {},
        summary: agentic2?.summary ?? "",
        claimedChangedFiles: (agentic2?.changedFiles ?? []).map((f) => f.path),
        commandsRun: (agentic2?.commands ?? []).map((c) => c.cmd)
      };
      const readme = buildAgenticBundleReadme({
        runId,
        intent: opts.prompt,
        overallVerdict: verdict.overallVerdict,
        traceRootHash: verdict.traceRootHash,
        keyId: verdict.signature?.keyId ?? "(unsigned)",
        verifierIsolation,
        verifyRan,
        hasDiff: typeof agentic2?.diff === "string" && agentic2.diff.trim().length > 0
      });
      writeVerifiedBundle({
        outDir: runDir,
        tracePath,
        verdict,
        publicKey: verifierPublicKey,
        actorClaim,
        readme,
        ...agentic2?.diff && agentic2.diff.trim().length > 0 ? { diff: agentic2.diff } : {}
      });
    }
  } catch (err) {
    (opts.onOperatorLog ?? (() => {
    }))(
      `bundle persist skipped (best-effort): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return {
    runId,
    runDir,
    tracePath,
    posture: AGENTIC_RUN_POSTURE,
    credentialPosture,
    ...agentic2 ? { agentic: agentic2 } : {},
    verdict,
    verifyRan,
    // HONEST ISOLATION: 'independent-sandboxed' iff the separate-trust-domain product
    // verifier produced the verdict; otherwise the inline-unsandboxed fallback.
    verifierIsolation,
    // The verify command's provenance: for the independent path, the REVIEWED policy
    // ('override' when targets ran, 'none' when Policy.verify was empty); for the inline
    // fallback, the stated source when a real check ran, or 'none' when no check ran.
    verifyCommandSource,
    // STRUCTURED honest-degrade reason (Track A / Slice 1): WHY independent
    // verification did not engage. Present ⇒ isolation is inline/degraded; an
    // independent-sandboxed result NEVER carries one (belt-and-braces guard here).
    ...verifierIsolation === "inline-unsandboxed" && isolationUnavailableReason ? { isolationUnavailableReason } : {}
  };
}

// ../spikes/p0-model-gateway/governed-review-run.ts
import { execFile as execFile3 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
import { join as join15 } from "node:path";
import { existsSync as existsSync8, mkdirSync as mkdirSync7, rmSync as rmSync4 } from "node:fs";
import { createHash as createHash7, createPublicKey as createPublicKey4 } from "node:crypto";

// ../spikes/p0-model-gateway/verify-command.ts
import { existsSync as existsSync7, readFileSync as readFileSync7, readdirSync as readdirSync3 } from "node:fs";
import { join as join14 } from "node:path";
import { execFileSync as execFileSync2 } from "node:child_process";
var VERIFY_OVERRIDE_PATH = ".glyphstudio/verify.json";
var defaultVerifyResolverDeps = {
  fileExists: (p) => existsSync7(p),
  readFile: (p) => readFileSync7(p, "utf8"),
  listDir: (dir) => {
    try {
      return readdirSync3(dir);
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
  const path6 = join14(cwd, VERIFY_OVERRIDE_PATH);
  if (!deps.fileExists(path6)) return void 0;
  let raw;
  try {
    raw = JSON.parse(deps.readFile(path6));
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
  const has = (name) => deps.fileExists(join14(cwd, name));
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
      const pkg = JSON.parse(deps.readFile(join14(cwd, "package.json")));
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

// ../spikes/p0-model-gateway/review-findings.ts
var MAX_REVIEW_FINDINGS = 25;
var MAX_FINDING_TITLE_CHARS = 120;
var MAX_FINDING_DETAIL_CHARS = 600;
var MAX_FINDING_FILE_CHARS = 260;
function buildFindingsPrompt(redactedDiff, opts) {
  const scopeLine = opts.scope === "working-tree" ? "The unified diff below is the WORKING TREE vs HEAD (staged + unstaged changes)." : `The unified diff below is a BRANCH review: merge-base(${opts.baseRef ?? "the default branch"})..HEAD.`;
  const truncatedLine = opts.truncated ? "NOTE: the diff was TRUNCATED to a byte cap \u2014 review only what is shown; do not guess about elided content." : "";
  return [
    "You are a precise code reviewer. Review the proposed change below and report concrete findings.",
    "",
    scopeLine,
    ...truncatedLine ? [truncatedLine] : [],
    "",
    "OUTPUT CONTRACT \u2014 follow it exactly:",
    "- Reply with EXACTLY ONE fenced code block, fenced as ```json, and nothing else of significance.",
    "- The block must contain a single JSON ARRAY of finding objects.",
    "- Each finding object has exactly these fields:",
    '    "file"      (string, REQUIRED) \u2014 the workspace-relative path exactly as it appears in the diff (no leading ./, never absolute).',
    '    "startLine" (number, optional) \u2014 the 1-based line in the NEW file where the finding starts.',
    '    "severity"  (string, REQUIRED) \u2014 one of "info" | "warn" | "high".',
    '    "title"     (string, REQUIRED) \u2014 a short summary.',
    '    "detail"    (string, REQUIRED) \u2014 the explanation, grounded in the diff.',
    "",
    "SEVERITY DEFINITIONS:",
    '- "info": a minor observation worth knowing (style-adjacent, naming, small clarity issue).',
    '- "warn": a likely bug, risk, or correctness concern that deserves a fix or a second look.',
    '- "high": a serious defect or security problem with concrete supporting evidence in the diff.',
    "",
    "HARD CAPS (enforced by the parser \u2014 output beyond them is discarded):",
    `- At most ${MAX_REVIEW_FINDINGS} findings.`,
    `- "title" at most ${MAX_FINDING_TITLE_CHARS} characters.`,
    `- "detail" at most ${MAX_FINDING_DETAIL_CHARS} characters.`,
    "",
    "GROUNDING RULES:",
    "- Report ONLY what the diff itself evidences. Report nothing speculative.",
    "- Do not report findings about code you cannot see.",
    "- An EMPTY ARRAY [] is a valid (and good) answer when the change is clean.",
    "",
    "THE DIFF UNDER REVIEW:",
    "```diff",
    redactedDiff,
    "```"
  ].join("\n");
}
function clampText(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}
function looksAbsolute(p) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
function hasTraversal(p) {
  return p.split(/[\\/]/).some((seg) => seg === "..");
}
function validateFinding(candidate) {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return void 0;
  }
  const c = candidate;
  if (typeof c.file !== "string") return void 0;
  let file = c.file.trim();
  while (file.startsWith("./")) file = file.slice(2);
  if (file.length === 0 || file.length > MAX_FINDING_FILE_CHARS || looksAbsolute(file) || hasTraversal(file)) {
    return void 0;
  }
  const severity = c.severity;
  if (severity !== "info" && severity !== "warn" && severity !== "high") {
    return void 0;
  }
  if (typeof c.title !== "string") return void 0;
  const title = clampText(c.title.trim(), MAX_FINDING_TITLE_CHARS);
  if (title.length === 0) return void 0;
  if (typeof c.detail !== "string") return void 0;
  const detail = clampText(c.detail.trim(), MAX_FINDING_DETAIL_CHARS);
  let startLine;
  if (typeof c.startLine === "number" && Number.isFinite(c.startLine) && c.startLine >= 1) {
    startLine = Math.floor(c.startLine);
  }
  return {
    file,
    ...startLine !== void 0 ? { startLine } : {},
    severity,
    title,
    detail
  };
}
function parseFindingsResponse(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { parseStatus: "parse-failed", reason: "empty model response" };
  }
  const fenceRe = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = fenceRe.exec(text)) !== null) blocks.push(m[1]);
  if (blocks.length === 0) {
    return { parseStatus: "parse-failed", reason: "no fenced JSON block found in the model response" };
  }
  if (blocks.length > 1) {
    return {
      parseStatus: "parse-failed",
      reason: `expected exactly one fenced JSON block, found ${blocks.length}`
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(blocks[0]);
  } catch (err) {
    return {
      parseStatus: "parse-failed",
      reason: `fenced block is not valid JSON: ${err instanceof Error ? err.message.slice(0, 120) : "parse error"}`
    };
  }
  let candidates;
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.findings)) {
    candidates = parsed.findings;
  } else {
    return {
      parseStatus: "parse-failed",
      reason: 'fenced JSON is neither an array of findings nor { "findings": [...] }'
    };
  }
  if (candidates.length === 0) {
    return { parseStatus: "ok", findings: [] };
  }
  const bounded = candidates.slice(0, MAX_REVIEW_FINDINGS);
  const findings = [];
  for (const candidate of bounded) {
    const valid = validateFinding(candidate);
    if (valid) findings.push(valid);
  }
  if (findings.length === 0) {
    return {
      parseStatus: "parse-failed",
      reason: `all ${bounded.length} finding(s) failed schema validation`
    };
  }
  return { parseStatus: "ok", findings };
}
function redactObviousSecretsInDiff(diff) {
  if (typeof diff !== "string" || diff.length === 0) return "";
  const lines = diff.split("\n");
  const out = [];
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const body = line.slice(1);
      let redacted = body;
      redacted = redacted.replace(
        /^(\s*authorization\s*[:=]\s*(?:bearer|basic|token)\s+).+$/i,
        (_m, pre) => `${pre}***REDACTED***`
      );
      if (redacted === body) {
        redacted = redacted.replace(
          /^(\s*['"]?[A-Za-z0-9_.-]*?)(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth(?:orization)?)([A-Za-z0-9_.-]*['"]?\s*[:=]\s*)(.+)$/i,
          (_m, pre, mid, post) => `${pre}${mid}${post}***REDACTED***`
        );
      }
      if (redacted === body) {
        redacted = redacted.replace(
          /\b([A-Za-z0-9_-]{32,}|AKIA[0-9A-Z]{12,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
          "***REDACTED***"
        );
      }
      out.push("+" + redacted);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// ../spikes/p0-model-gateway/governed-review-run.ts
var execFileAsync3 = promisify3(execFile3);
var REVIEW_RUN_POSTURE = "governed-unsandboxed";
var REVIEW_ACTOR = "codex";
var INJECTED_FINDINGS_BACKEND = "injected-findings-backend";
var REVIEW_DIFF_BYTE_CAP = 256 * 1024;
async function git2(cwd, args) {
  const { stdout } = await execFileAsync3("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
}
async function detectDefaultBaseRef(cwd) {
  try {
    const ref = (await git2(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (ref.length > 0) return ref;
  } catch {
  }
  for (const candidate of ["main", "master"]) {
    try {
      await git2(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
      return candidate;
    } catch {
    }
  }
  throw new Error(
    "change review: no baseRef was provided and no default branch could be detected (no origin/HEAD, no local 'main'/'master'). Pass an explicit baseRef."
  );
}
function capUtf8Bytes(s, cap) {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= cap) return { text: s, truncated: false };
  let end = Math.max(0, cap);
  while (end > 0 && (buf[end - 1] & 192) === 128) end -= 1;
  if (end > 0 && (buf[end - 1] & 192) === 192) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}
async function captureReviewDiff(cwd, scope, baseRef, byteCap) {
  let raw;
  let resolvedBase;
  if (scope === "working-tree") {
    raw = await git2(cwd, ["diff", "HEAD"]);
  } else {
    resolvedBase = baseRef ?? await detectDefaultBaseRef(cwd);
    const mergeBase = (await git2(cwd, ["merge-base", resolvedBase, "HEAD"])).trim();
    raw = await git2(cwd, ["diff", mergeBase, "HEAD"]);
  }
  const redacted = redactObviousSecretsInDiff(raw);
  const { text, truncated } = capUtf8Bytes(redacted, byteCap);
  const exactBytes = Buffer.from(text, "utf8");
  return {
    diff: text,
    sha256: createHash7("sha256").update(exactBytes).digest("hex"),
    bytes: exactBytes.byteLength,
    truncated,
    ...resolvedBase !== void 0 ? { baseRef: resolvedBase } : {}
  };
}
async function snapshotHeadTree(cwd, runDir) {
  const dir = join15(runDir, "review-head-snapshot");
  mkdirSync7(dir, { recursive: true });
  const tarPath = join15(runDir, "review-head-snapshot.tar");
  await execFileAsync3("git", ["-C", cwd, "archive", "--format=tar", "-o", tarPath, "HEAD"]);
  await execFileAsync3("tar", ["-xf", tarPath, "-C", dir]);
  rmSync4(tarPath, { force: true });
  return dir;
}
function shortReason(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}
async function codexFindingsTurn(prompt, cwd, codexPath, env, timeoutMs, signal, onOperatorLog) {
  const backend = new CodexChatBackend({
    codexPath,
    ...timeoutMs !== void 0 ? { timeoutMs } : {},
    ...onOperatorLog ? { onOperatorLog } : {}
  });
  for await (const ev of backend.chatTurn(
    { messages: [{ role: "user", content: prompt }], cwd },
    { env, ...signal ? { signal } : {} }
  )) {
    if (ev.type === "done") return { text: ev.text, ...ev.usage ? { usage: ev.usage } : {} };
    if (ev.type === "error") throw new Error(ev.message);
  }
  throw new Error("codex findings turn ended without a terminal event");
}
function buildReviewBundleReadme(info) {
  const independent = info.verifierIsolation === "independent-sandboxed";
  const isolationNote = independent ? "(independent sandboxed product verifier \u2014 may reach assurance:full)." : "(inline check \u2014 a real but NOT independent signal; it can NEVER reach assurance:full).";
  return [
    "# GlyphStudio verified-evidence bundle (governed CHANGE REVIEW)",
    "",
    "- review context: this run REVIEWED a proposed state \u2014 it did not build/edit anything.",
    `- run id: ${info.runId}`,
    `- scope: ${info.scope}${info.baseRef ? ` (base ref: ${info.baseRef})` : ""}`,
    `- reviewed diff sha256: ${info.diffSha256} (truncated: ${info.truncated ? "yes" : "no"})`,
    `- advisory findings: parseStatus=${info.parseStatus}, ${info.findingsCount} finding(s) \u2014 OPINIONS only; the trace \`review_findings\` event is committed to by the signed root and NEVER carries or influences assurance.`,
    `- overall verdict: ${info.overallVerdict}`,
    `- verifier isolation: ${info.verifierIsolation} ${isolationNote}`,
    `- real build/test check ran: ${info.verifyRan ? "yes" : "no"}`,
    `- trace root hash: ${info.traceRootHash}`,
    `- signing key id: ${info.keyId}`,
    "",
    "## Files",
    "- `trace.jsonl` \u2014 the run's append-only, hash-chained trace (review_requested \u2192 review_findings \u2192 verifier_verdict).",
    "- `verdict.json` \u2014 the SIGNED VerifierVerdict (authoritative outcome).",
    "- `verifier-public-key.pem` \u2014 the verifier's SPKI public key (resolve out-of-band).",
    "- `actor-claims.json` \u2014 the advisory actor's claim metadata (NOT authoritative).",
    "- `diff.patch` \u2014 the EXACT (redacted, possibly truncated) diff bytes the review ran over (sha256 above).",
    "- `README.md` \u2014 this file.",
    ""
  ].join("\n");
}
async function runGovernedChangeReview(opts) {
  const now = opts.now ?? Date.now;
  const emit = opts.emit ?? (() => {
  });
  const endpoints = opts.modelEndpoints ?? DEFAULT_MODEL_ENDPOINTS;
  const verifierKey = opts.verifierPrivateKey ?? generateVerifierKeypair().privateKey;
  const log = opts.onOperatorLog ?? (() => {
  });
  let runId;
  let runDir;
  let tracePath;
  let sink;
  if (opts.existingRun) {
    runId = opts.existingRun.runId;
    tracePath = opts.existingRun.tracePath;
    sink = opts.sink ?? opts.existingRun.sink;
    runDir = join15(tracePath, "..", "..");
  } else {
    const created = createRun(opts.runsBaseDir);
    runId = created.runId;
    runDir = created.dir;
    tracePath = join15(runSubdirPath(runDir, "trace"), "trace.jsonl");
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
  const captured = await captureReviewDiff(
    opts.cwd,
    opts.scope,
    opts.scope === "branch" ? opts.baseRef : void 0,
    opts.diffByteCap ?? REVIEW_DIFF_BYTE_CAP
  );
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
    ...opts.denyDirectIp !== void 0 ? { denyDirectIp: opts.denyDirectIp } : {}
  });
  const { env: governedEnv, posture: credentialPosture } = buildGovernedEnvResult({
    proxyUrl: proxy.url
  });
  emit({ type: "run_created", runId, runDir, proxyUrl: proxy.url, posture: REVIEW_RUN_POSTURE });
  const intent = `change review (${opts.scope}${captured.baseRef ? ` vs ${captured.baseRef}` : ""})`;
  const runCreated = {
    runId,
    runDir,
    intent,
    workflowType: "review",
    agentBackend: opts.generateFindings ? INJECTED_FINDINGS_BACKEND : "codex-cli"
  };
  append("run_created", runCreated, "supervisor");
  const reviewRequested = {
    scope: opts.scope,
    ...captured.baseRef !== void 0 ? { baseRef: captured.baseRef } : {},
    diffSha256: captured.sha256,
    diffBytes: captured.bytes,
    truncated: captured.truncated
  };
  append("review_requested", reviewRequested, "supervisor");
  let findingsPayload;
  try {
    transition("worktree_ready", "review diff captured + governed proxy ready");
    transition("sandbox_ready", "governed env built (egress brokered, ambient secrets stripped)");
    transition("executing", "advisory findings turn started");
    if (captured.bytes === 0) {
      findingsPayload = {
        actor: REVIEW_ACTOR,
        advisory: true,
        parseStatus: "unavailable",
        reason: "empty diff \u2014 nothing to review; the advisory model was not consulted",
        findings: []
      };
    } else {
      const prompt = buildFindingsPrompt(captured.diff, {
        scope: opts.scope,
        ...captured.baseRef !== void 0 ? { baseRef: captured.baseRef } : {},
        truncated: captured.truncated
      });
      try {
        let responseText;
        let usage;
        if (opts.generateFindings) {
          responseText = await opts.generateFindings(prompt);
        } else if (opts.codexPath) {
          const turn = await codexFindingsTurn(
            prompt,
            opts.cwd,
            opts.codexPath,
            governedEnv,
            opts.timeoutMs,
            opts.signal,
            opts.onOperatorLog
          );
          responseText = turn.text;
          usage = turn.usage;
        } else {
          throw new Error(
            "no findings backend available: neither generateFindings nor codexPath was provided"
          );
        }
        const call = {
          model: opts.generateFindings ? INJECTED_FINDINGS_BACKEND : "codex-cli",
          ...usage?.inputTokens !== void 0 ? { inputTokens: usage.inputTokens } : {},
          ...usage?.outputTokens !== void 0 ? { outputTokens: usage.outputTokens } : {},
          provenanceLabel: "tool-output"
        };
        append("model_call", call);
        const parsed = parseFindingsResponse(responseText);
        findingsPayload = parsed.parseStatus === "ok" ? {
          actor: REVIEW_ACTOR,
          advisory: true,
          parseStatus: "ok",
          findings: parsed.findings
        } : {
          actor: REVIEW_ACTOR,
          advisory: true,
          parseStatus: "parse-failed",
          reason: parsed.reason,
          findings: []
        };
      } catch (err) {
        const reason = shortReason(err);
        log(`review findings turn unavailable: ${reason}`);
        findingsPayload = {
          actor: REVIEW_ACTOR,
          advisory: true,
          parseStatus: "unavailable",
          reason,
          findings: []
        };
      }
    }
  } finally {
    await proxy.close();
  }
  append("review_findings", findingsPayload, "supervisor");
  emit({ type: "findings", payload: findingsPayload });
  transition(
    "completed",
    `advisory findings turn finished (parseStatus: ${findingsPayload.parseStatus})`
  );
  let resolvedVerifyCommand;
  let resolvedSource;
  if (opts.verifyCommand && opts.verifyCommand.length > 0) {
    resolvedVerifyCommand = opts.verifyCommand;
    resolvedSource = opts.verifyCommandSource ?? "override";
  } else {
    const resolved = resolveVerifyCommand(
      opts.cwd,
      opts.verifyResolverDeps ?? defaultVerifyResolverDeps
    );
    resolvedVerifyCommand = resolved.command && resolved.command.length > 0 ? resolved.command : void 0;
    resolvedSource = resolved.source;
    if (!resolvedVerifyCommand && resolved.note) log(`verify-command resolution: ${resolved.note}`);
  }
  let verifySourceTree = opts.cwd;
  if (opts.scope === "branch") {
    try {
      verifySourceTree = await snapshotHeadTree(opts.cwd, runDir);
    } catch (err) {
      log(`branch HEAD snapshot failed: ${shortReason(err)}`);
      verifySourceTree = "";
    }
  }
  const autoOpt = opts.autoIndependentVerifier;
  const autoEnabled = autoOpt !== false;
  const autoCfg = typeof autoOpt === "object" ? autoOpt : void 0;
  let isolationUnavailableReason;
  let independentResult;
  if (!autoEnabled) {
    isolationUnavailableReason = "auto independent verifier disabled (autoIndependentVerifier:false)";
  } else if (!resolvedVerifyCommand) {
    isolationUnavailableReason = "no verify command resolved \u2014 nothing for the independent verifier to run";
  } else if (opts.scope === "branch" && verifySourceTree === "") {
    isolationUnavailableReason = "branch HEAD snapshot could not be created \u2014 independent verification skipped";
  } else {
    let runtimeUp;
    let selectedRuntime = autoCfg?.runtime;
    if (autoCfg?.runtimeAvailable) {
      runtimeUp = autoCfg.runtimeAvailable();
      if (!runtimeUp) {
        isolationUnavailableReason = "Docker unavailable (injected runtime probe reported down)";
      }
    } else {
      const resolution = resolveIsolatedSandboxRuntime({ prefer: opts.verifierRuntime ?? "auto" });
      runtimeUp = resolution.available;
      if (resolution.available) {
        selectedRuntime = selectedRuntime ?? resolution.runtime;
      } else {
        isolationUnavailableReason = resolution.reason;
      }
    }
    if (runtimeUp) {
      const policyPath = writeEphemeralVerifyPolicy(resolvedVerifyCommand, runDir);
      independentResult = await runIndependentVerification({
        repoPath: opts.cwd,
        sourceWorktree: verifySourceTree,
        policyPath,
        tracePath,
        privateKey: verifierKey,
        ...selectedRuntime ? { runtime: selectedRuntime } : {},
        ...autoCfg?.runsBaseDir !== void 0 ? { runsBaseDir: autoCfg.runsBaseDir } : {},
        ...opts.onOperatorLog ? { onOperatorLog: opts.onOperatorLog } : {}
      });
    } else {
      log(
        `${isolationUnavailableReason ?? "no isolating runtime available"} \u2014 using the inline-unsandboxed check (degraded; not independently verified)`
      );
    }
  }
  let verdict;
  let verifyRan;
  let verifierIsolation;
  let verifyCommandSource;
  if (independentResult && independentResult.ran) {
    verdict = independentResult.verdict;
    verifyRan = independentResult.verdict.checks.some(
      (c) => c.status === "pass" || c.status === "fail"
    );
    verifierIsolation = "independent-sandboxed";
    verifyCommandSource = verifyRan ? resolvedSource : "none";
    append(
      "verifier_verdict",
      {
        overallVerdict: verdict.overallVerdict,
        traceRootHash: verdict.traceRootHash,
        checks: verdict.checks,
        verifierIsolation,
        verifyCommandSource,
        ...verdict.signature ? { keyId: verdict.signature.keyId } : {}
      },
      "verifier"
    );
  } else {
    if (independentResult && !independentResult.ran) {
      isolationUnavailableReason ??= "independent verifier could not run (error) \u2014 fell back to the inline-unsandboxed check";
      log("independent verifier could not run \u2014 falling back to the inline-unsandboxed check");
    }
    const checks = [];
    verifyRan = !!resolvedVerifyCommand;
    if (resolvedVerifyCommand) {
      const inlineCwd = opts.scope === "branch" && verifySourceTree !== "" ? verifySourceTree : opts.cwd;
      const check = await runVerifyCheck(
        resolvedVerifyCommand,
        inlineCwd,
        governedEnv,
        opts.timeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS,
        opts.signal
      );
      checks.push(check);
    } else {
      checks.push({
        name: `${NOT_VERIFIED_CHECK_NAME} (change review)`,
        command: [],
        status: "skipped"
      });
    }
    const anyFail = checks.some((c) => c.status === "fail");
    const anyError = checks.some((c) => c.status === "error");
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
    verifierIsolation = "inline-unsandboxed";
    verifyCommandSource = verifyRan ? resolvedSource : "none";
    append(
      "verifier_verdict",
      {
        overallVerdict,
        traceRootHash,
        checks,
        verifierIsolation,
        verifyCommandSource,
        keyId: signature.keyId
      },
      "verifier"
    );
  }
  emit({ type: "verdict", verdict });
  try {
    if (existsSync8(tracePath)) {
      const verifierPublicKey = createPublicKey4(verifierKey);
      const actorClaim = {
        actor: REVIEW_ACTOR,
        intent,
        scope: opts.scope,
        ...captured.baseRef !== void 0 ? { baseRef: captured.baseRef } : {},
        diffSha256: captured.sha256,
        truncated: captured.truncated,
        parseStatus: findingsPayload.parseStatus,
        findingsCount: findingsPayload.findings.length
      };
      const readme = buildReviewBundleReadme({
        runId,
        scope: opts.scope,
        ...captured.baseRef !== void 0 ? { baseRef: captured.baseRef } : {},
        diffSha256: captured.sha256,
        truncated: captured.truncated,
        parseStatus: findingsPayload.parseStatus,
        findingsCount: findingsPayload.findings.length,
        overallVerdict: verdict.overallVerdict,
        traceRootHash: verdict.traceRootHash,
        keyId: verdict.signature?.keyId ?? "(unsigned)",
        verifierIsolation,
        verifyRan
      });
      writeVerifiedBundle({
        outDir: runDir,
        tracePath,
        verdict,
        publicKey: verifierPublicKey,
        actorClaim,
        readme,
        ...captured.diff.trim().length > 0 ? { diff: captured.diff } : {}
      });
    }
  } catch (err) {
    log(`bundle persist skipped (best-effort): ${shortReason(err)}`);
  }
  const assurance = computeBuildAssurance({
    verifierIsolation,
    verifyRan,
    overall: verdict.overallVerdict,
    ...verdict.signature ? { signature: verdict.signature } : {}
  });
  const reviewVerdict = {
    overall: verdict.overallVerdict,
    assurance,
    verifierIsolation,
    verifyCommandSource,
    verifyRan,
    ...verifierIsolation === "inline-unsandboxed" && isolationUnavailableReason ? { isolationUnavailableReason } : {},
    checks: verdict.checks.map((c) => ({ name: c.name, status: c.status })),
    traceRootHash: verdict.traceRootHash,
    ...verdict.signature ? { signature: verdict.signature } : {}
  };
  const review = {
    runId,
    scope: opts.scope,
    ...captured.baseRef !== void 0 ? { baseRef: captured.baseRef } : {},
    diffSha256: captured.sha256,
    findings: {
      parseStatus: findingsPayload.parseStatus,
      ...findingsPayload.reason !== void 0 ? { reason: findingsPayload.reason } : {},
      advisory: true,
      items: findingsPayload.findings
    },
    verdict: reviewVerdict
  };
  const gate = assertChangeReviewWellFormed(review);
  if (gate.ok === false) {
    throw new Error(`runGovernedChangeReview produced a malformed ChangeReview: ${gate.problems.join(", ")}`);
  }
  emit({ type: "result", review });
  emit({ type: "run_closed", runId, ok: verdict.overallVerdict === "pass" });
  return {
    review,
    runId,
    runDir,
    tracePath,
    posture: REVIEW_RUN_POSTURE,
    credentialPosture,
    verdict,
    verifyRan,
    verifierIsolation,
    verifyCommandSource,
    ...verifierIsolation === "inline-unsandboxed" && isolationUnavailableReason ? { isolationUnavailableReason } : {},
    findings: findingsPayload,
    truncated: captured.truncated,
    diffBytes: captured.bytes
  };
}

// ../spikes/p0-model-gateway/governed-plan-run.ts
import { join as join16 } from "node:path";

// ../spikes/p0-model-gateway/plan-generation.ts
function buildPlanPrompt(userPrompt) {
  return [
    "You are a precise senior engineer PLANNING a code change. Produce a concrete,",
    "minimal build plan for the task below. You have READ-ONLY access to the",
    "repository in the working directory: read code to ground the plan, but you",
    "cannot edit files or run state-changing commands \u2014 this turn plans, it does",
    "not build.",
    "",
    "OUTPUT CONTRACT \u2014 follow it exactly:",
    "- Reply with EXACTLY ONE fenced code block, fenced as ```json, and nothing else of significance.",
    "- The block must contain a single JSON OBJECT with exactly these fields:",
    '    "goal"  (string, REQUIRED) \u2014 what the plan sets out to achieve.',
    '    "steps" (array, REQUIRED)  \u2014 the ordered plan steps (at least one).',
    '    "risks" (array of strings, optional) \u2014 concrete risks, when any.',
    "- Each step object has exactly these fields:",
    '    "title"  (string, REQUIRED) \u2014 a short step summary.',
    '    "detail" (string, REQUIRED) \u2014 what the step does and why, grounded in the code you read.',
    '    "files"  (array of strings, optional) \u2014 workspace-relative paths the step expects to touch (no leading ./, never absolute, no .. segments).',
    "",
    "HARD CAPS (enforced by the parser \u2014 output beyond them is discarded):",
    `- At most ${MAX_PLAN_STEPS} steps.`,
    `- "goal" at most ${MAX_PLAN_GOAL_CHARS} characters.`,
    `- "title" at most ${MAX_PLAN_STEP_TITLE_CHARS} characters.`,
    `- "detail" at most ${MAX_PLAN_STEP_DETAIL_CHARS} characters.`,
    `- At most ${MAX_PLAN_FILES_PER_STEP} files per step, each path at most ${MAX_PLAN_FILE_CHARS} characters.`,
    `- At most ${MAX_PLAN_RISKS} risks, each at most ${MAX_PLAN_RISK_CHARS} characters.`,
    "",
    "HONESTY RULES:",
    "- Plan only what the codebase actually needs; do not invent steps.",
    '- "files" lists are relative paths you ACTUALLY expect to touch \u2014 name a file only when you expect the step to change or create it.',
    "- Ground every step in code you actually read; do not speculate about code you have not seen.",
    '- List a risk only when it is concrete; an absent "risks" field is a valid answer.',
    "",
    "THE TASK TO PLAN:",
    userPrompt
  ].join("\n");
}
function clampText2(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}
function looksAbsolute2(p) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
function hasTraversal2(p) {
  return p.split(/[\\/]/).some((seg) => seg === "..");
}
function validatePlanFile(candidate) {
  if (typeof candidate !== "string") return void 0;
  let file = candidate.trim();
  while (file.startsWith("./")) file = file.slice(2);
  if (file.length === 0 || file.length > MAX_PLAN_FILE_CHARS || looksAbsolute2(file) || hasTraversal2(file)) {
    return void 0;
  }
  return file;
}
function validatePlanStep(candidate) {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return void 0;
  }
  const c = candidate;
  if (typeof c.title !== "string") return void 0;
  const title = clampText2(c.title.trim(), MAX_PLAN_STEP_TITLE_CHARS);
  if (title.length === 0) return void 0;
  if (typeof c.detail !== "string") return void 0;
  const detail = clampText2(c.detail.trim(), MAX_PLAN_STEP_DETAIL_CHARS);
  if (detail.length === 0) return void 0;
  let files;
  if (Array.isArray(c.files)) {
    const bounded = c.files.slice(0, MAX_PLAN_FILES_PER_STEP);
    const valid = [];
    for (const f of bounded) {
      const ok = validatePlanFile(f);
      if (ok !== void 0) valid.push(ok);
    }
    if (valid.length > 0) files = valid;
  }
  return { title, detail, ...files !== void 0 ? { files } : {} };
}
function parsePlanResponse(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { parseStatus: "parse-failed", reason: "empty model response" };
  }
  const fenceRe = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = fenceRe.exec(raw)) !== null) blocks.push(m[1]);
  if (blocks.length === 0) {
    return { parseStatus: "parse-failed", reason: "no fenced JSON block found in the model response" };
  }
  if (blocks.length > 1) {
    return {
      parseStatus: "parse-failed",
      reason: `expected exactly one fenced JSON block, found ${blocks.length}`
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(blocks[0]);
  } catch (err) {
    return {
      parseStatus: "parse-failed",
      reason: `fenced block is not valid JSON: ${err instanceof Error ? err.message.slice(0, 120) : "parse error"}`
    };
  }
  let candidate;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed;
    const inner = obj.plan;
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner) && obj.goal === void 0 && obj.steps === void 0) {
      candidate = inner;
    } else {
      candidate = obj;
    }
  } else {
    return {
      parseStatus: "parse-failed",
      reason: 'fenced JSON is neither a plan object nor { "plan": { ... } }'
    };
  }
  if (typeof candidate.goal !== "string" || candidate.goal.trim().length === 0) {
    return { parseStatus: "parse-failed", reason: "plan goal is missing or empty" };
  }
  const goal = clampText2(candidate.goal.trim(), MAX_PLAN_GOAL_CHARS);
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    return { parseStatus: "parse-failed", reason: "plan steps are missing or empty" };
  }
  const bounded = candidate.steps.slice(0, MAX_PLAN_STEPS);
  const steps = [];
  for (const step of bounded) {
    const valid = validatePlanStep(step);
    if (valid) steps.push(valid);
  }
  if (steps.length === 0) {
    return {
      parseStatus: "parse-failed",
      reason: `all ${bounded.length} plan step(s) failed schema validation`
    };
  }
  let risks;
  if (Array.isArray(candidate.risks)) {
    const boundedRisks = candidate.risks.slice(0, MAX_PLAN_RISKS);
    const valid = [];
    for (const r of boundedRisks) {
      if (typeof r !== "string") continue;
      const trimmed = r.trim();
      if (trimmed.length === 0) continue;
      valid.push(clampText2(trimmed, MAX_PLAN_RISK_CHARS));
    }
    if (valid.length > 0) risks = valid;
  }
  const plan = { goal, steps, ...risks !== void 0 ? { risks } : {} };
  try {
    assertBuildPlanWellFormed(plan);
  } catch (err) {
    return {
      parseStatus: "parse-failed",
      reason: `internal: clamped plan failed the contract gate: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
    };
  }
  return { parseStatus: "ok", plan };
}

// ../spikes/p0-model-gateway/governed-plan-run.ts
var PLAN_RUN_POSTURE = "governed-unsandboxed";
var PLAN_ACTOR = "codex";
var INJECTED_PLAN_BACKEND = "injected-plan-backend";
async function runGovernedPlanTurn(opts) {
  const now = opts.now ?? Date.now;
  const emit = opts.emit ?? (() => {
  });
  const endpoints = opts.modelEndpoints ?? DEFAULT_MODEL_ENDPOINTS;
  const log = opts.onOperatorLog ?? (() => {
  });
  let runId;
  let runDir;
  let tracePath;
  let sink;
  if (opts.existingRun) {
    runId = opts.existingRun.runId;
    tracePath = opts.existingRun.tracePath;
    sink = opts.sink ?? opts.existingRun.sink;
    runDir = join16(tracePath, "..", "..");
  } else {
    const created = createRun(opts.runsBaseDir);
    runId = created.runId;
    runDir = created.dir;
    tracePath = join16(runSubdirPath(runDir, "trace"), "trace.jsonl");
    sink = opts.sink ?? createTraceWriter(tracePath);
  }
  const append = (type, payload, source) => {
    sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      // the writer is authoritative for seq
      ts: now(),
      type,
      payload,
      ...source ? { source } : {}
    });
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
    ...opts.denyDirectIp !== void 0 ? { denyDirectIp: opts.denyDirectIp } : {}
  });
  const { env: governedEnv, posture: credentialPosture } = buildGovernedEnvResult({
    proxyUrl: proxy.url
  });
  emit({ type: "run_created", runId, runDir, proxyUrl: proxy.url, posture: PLAN_RUN_POSTURE });
  const runCreated = {
    runId,
    runDir,
    intent: opts.prompt.slice(0, 200),
    workflowType: "plan",
    agentBackend: opts.generatePlan ? INJECTED_PLAN_BACKEND : "codex-cli"
  };
  append("run_created", runCreated, "supervisor");
  let proposed;
  try {
    transition("worktree_ready", "plan turn reads the existing workspace + governed proxy ready");
    transition("sandbox_ready", "governed env built (egress brokered, ambient secrets stripped)");
    transition("executing", "advisory plan turn started");
    const prompt = buildPlanPrompt(opts.prompt);
    try {
      let responseText;
      let usage;
      if (opts.generatePlan) {
        responseText = await opts.generatePlan(prompt);
      } else if (opts.codexPath) {
        const turn = await codexFindingsTurn(
          prompt,
          opts.cwd,
          opts.codexPath,
          governedEnv,
          opts.timeoutMs,
          opts.signal,
          opts.onOperatorLog
        );
        responseText = turn.text;
        usage = turn.usage;
      } else {
        throw new Error(
          "no plan backend available: neither generatePlan nor codexPath was provided"
        );
      }
      const call = {
        model: opts.generatePlan ? INJECTED_PLAN_BACKEND : "codex-cli",
        ...usage?.inputTokens !== void 0 ? { inputTokens: usage.inputTokens } : {},
        ...usage?.outputTokens !== void 0 ? { outputTokens: usage.outputTokens } : {},
        provenanceLabel: "tool-output"
      };
      append("model_call", call);
      const parsed = parsePlanResponse(responseText);
      proposed = parsed.parseStatus === "ok" ? { actor: PLAN_ACTOR, advisory: true, parseStatus: "ok", plan: parsed.plan } : { actor: PLAN_ACTOR, advisory: true, parseStatus: "parse-failed", reason: parsed.reason };
    } catch (err) {
      const reason = shortReason(err);
      log(`plan turn unavailable: ${reason}`);
      proposed = { actor: PLAN_ACTOR, advisory: true, parseStatus: "unavailable", reason };
    }
  } finally {
    await proxy.close();
  }
  append("plan_proposed", proposed, "supervisor");
  if (proposed.parseStatus === "ok" && proposed.plan) {
    emit({ type: "plan", plan: proposed.plan });
  }
  const proposal = {
    runId,
    advisory: true,
    parseStatus: proposed.parseStatus,
    ...proposed.reason !== void 0 ? { reason: proposed.reason } : {},
    ...proposed.plan !== void 0 ? { plan: proposed.plan } : {}
  };
  emit({ type: "result", proposal });
  return {
    proposal,
    runId,
    runDir,
    tracePath,
    parseStatus: proposed.parseStatus,
    ...proposed.plan !== void 0 ? { plan: proposed.plan } : {},
    posture: PLAN_RUN_POSTURE,
    credentialPosture
  };
}

// ../spikes/p0-supervisor/web-fetch.ts
import { createHash as createHash8 } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest2 } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect2, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { URL as URL2 } from "node:url";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
var WEB_DEFAULT_MAX_FETCH_KB = 2048;
var WEB_DEFAULT_MAX_CONTEXT_KB = 50;
var WEB_DEFAULT_TIMEOUT_MS = 1e4;
var WEB_DEFAULT_MAX_REDIRECTS = 5;
var WEB_DEFAULT_IDLE_TIMEOUT_MS = 5e3;
var WEB_DEFAULT_MAX_DECOMPRESSION_RATIO = 8;
function marker(reason) {
  return `[@Web: ${reason}]`;
}
function fail(originalUrl, reason, attemptedHost) {
  return { ok: false, originalUrl, marker: marker(reason), reason, ...attemptedHost ? { attemptedHost } : {} };
}
function safeInt(value, fallback, min, max) {
  if (!Number.isFinite(value) || value === void 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function prepareWebUrl(raw) {
  let url;
  try {
    url = new URL2(String(raw || "").trim());
  } catch {
    return { error: marker("refused \u2014 not a valid URL"), reason: "refused \u2014 not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    const scheme = url.protocol.replace(/:$/, "");
    return { error: marker(`refused \u2014 unsupported scheme '${scheme}'`), reason: `refused \u2014 unsupported scheme '${scheme}'` };
  }
  if (url.username || url.password) {
    return { error: marker("refused \u2014 credentials in URL not allowed"), reason: "refused \u2014 credentials in URL not allowed" };
  }
  url.hash = "";
  const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  if (port !== 80 && port !== 443) {
    return { error: marker("refused \u2014 non-default port"), reason: "refused \u2014 non-default port" };
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) {
    return { error: marker("refused \u2014 not a valid URL"), reason: "refused \u2014 not a valid URL" };
  }
  url.hostname = host;
  return { url, host, port };
}
function ipv4ToNumber(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return void 0;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return void 0;
    n = (n << 8) + v;
  }
  return n >>> 0;
}
function inRange(n, base, bits) {
  const b = ipv4ToNumber(base);
  if (b === void 0) return false;
  const mask2 = bits === 0 ? 0 : 4294967295 << 32 - bits >>> 0;
  return (n & mask2) === (b & mask2);
}
function uint32ToDottedQuad(n) {
  return `${n >>> 24 & 255}.${n >>> 16 & 255}.${n >>> 8 & 255}.${n & 255}`;
}
function normalizeIpLiteral(host) {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (/^0x[0-9a-f]+$/.test(h)) {
    const n = Number.parseInt(h.slice(2), 16);
    if (Number.isInteger(n) && n >= 0 && n <= 4294967295) return uint32ToDottedQuad(n);
    return h;
  }
  if (/^0[0-7]+$/.test(h)) {
    const n = Number.parseInt(h, 8);
    if (Number.isInteger(n) && n >= 0 && n <= 4294967295) return uint32ToDottedQuad(n);
    return h;
  }
  if (/^[1-9][0-9]*$/.test(h) || h === "0") {
    const n = Number(h);
    if (Number.isInteger(n) && n >= 0 && n <= 4294967295) return uint32ToDottedQuad(n);
    return h;
  }
  if (/^0[0-7.]+$/.test(h) && h.includes(".")) {
    const parts = h.split(".").map((p) => Number.parseInt(p || "0", 8));
    if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
      return parts.join(".");
    }
  }
  if (h.startsWith("::ffff:")) return h.slice("::ffff:".length);
  return h;
}
function isPublicAddress(address) {
  const ip = normalizeIpLiteral(address);
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToNumber(ip);
    if (n === void 0) return false;
    const ranges = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
      ["192.0.2.0", 24],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4]
    ];
    return !ranges.some(([base, bits]) => inRange(n, base, bits));
  }
  if (family === 6) {
    const h = ip.toLowerCase();
    if (h === "::" || h === "::1") return false;
    if (h.startsWith("fe80:") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return false;
    if (h.startsWith("fc") || h.startsWith("fd")) return false;
    if (h.startsWith("ff")) return false;
    if (h.startsWith("2001:db8")) return false;
    return true;
  }
  return false;
}
async function resolvePublic(host, lookup2) {
  if (host === "localhost" || host.endsWith(".localhost")) return void 0;
  const literal = normalizeIpLiteral(host);
  if (isIP(literal)) return isPublicAddress(literal) ? literal : void 0;
  const records = await lookup2(host, { all: true, verbatim: true });
  const publicRecord = records.find((r) => isPublicAddress(r.address));
  return publicRecord?.address;
}
function decodeBody(body, encoding) {
  const enc = encoding.toLowerCase();
  if (enc.includes("gzip")) return gunzipSync(body);
  if (enc.includes("br")) return brotliDecompressSync(body);
  if (enc.includes("deflate")) return inflateSync(body);
  return body;
}
function resolveCharset(body, contentType, isHtml) {
  const fromHeader = /charset\s*=\s*"?([\w:.+-]+)"?/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.trim().toLowerCase();
  if (isHtml) {
    const head = body.subarray(0, 1024).toString("latin1");
    const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.+-]+)/i.exec(head)?.[1] ?? /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w:.+-]+)/i.exec(head)?.[1];
    if (meta) return meta.trim().toLowerCase();
  }
  return "utf-8";
}
function decodeCharset(body, charset) {
  const cs = charset.replace(/[^a-z0-9]/g, "");
  if (cs === "utf8" || cs === "utf" || cs === "") {
    const text = body.toString("utf8");
    if (Buffer.byteLength(text, "utf8") !== body.byteLength && text.includes("\uFFFD")) {
      return void 0;
    }
    return text;
  }
  try {
    return new TextDecoder(charset, { fatal: true }).decode(body);
  } catch {
    return void 0;
  }
}
function extractText(body, contentType) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type && !type.startsWith("text/html") && !type.startsWith("text/plain") && !type.startsWith("text/markdown") && type !== "application/json" && !type.endsWith("+json")) {
    return { unsupported: true, boilerplateStripped: false };
  }
  const isHtml = type.startsWith("text/html");
  const charset = resolveCharset(body, contentType, isHtml);
  const decoded = decodeCharset(body, charset);
  if (decoded === void 0) {
    return { unsupported: true, boilerplateStripped: false };
  }
  let raw = decoded;
  if (type.startsWith("text/html")) {
    raw = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    return { text: raw.replace(/\s+/g, " ").trim(), boilerplateStripped: true };
  }
  return { text: raw.trim(), boilerplateStripped: false };
}
function proxyPort(proxy) {
  if (proxy.port) return Number(proxy.port);
  return proxy.protocol === "https:" ? 443 : 80;
}
function authorityHost(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}
function connectHttpsThroughProxy(proxy, target, resolvedAddress, timeoutMs, idleTimeoutMs, recordConnect) {
  return new Promise((resolve5, reject) => {
    const raw = netConnect2({
      host: proxy.hostname,
      port: proxyPort(proxy)
    });
    let settled = false;
    let buffered = Buffer.alloc(0);
    const targetAuthority = `${authorityHost(resolvedAddress)}:${Number(target.port || 443)}`;
    const hostAuthority = `${target.hostname}:${Number(target.port || 443)}`;
    recordConnect?.({ host: resolvedAddress, port: Number(target.port || 443), servername: target.hostname });
    const fail2 = (err) => {
      if (settled) return;
      settled = true;
      raw.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail2(new Error(`timed out after ${Math.round(timeoutMs / 1e3)}s`)), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    raw.on("connect", () => {
      raw.write(
        [
          `CONNECT ${targetAuthority} HTTP/1.1`,
          `Host: ${hostAuthority}`,
          "User-Agent: GlyphStudio-WebContext/1",
          "Connection: close",
          "",
          ""
        ].join("\r\n")
      );
    });
    raw.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffered.subarray(0, headerEnd).toString("latin1");
      const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(header)?.[1];
      if (!status || Number(status) < 200 || Number(status) >= 300) {
        fail2(new Error(`proxy CONNECT failed${status ? ` \u2014 HTTP ${status}` : ""}`));
        return;
      }
      raw.removeAllListeners("data");
      raw.removeAllListeners("error");
      raw.removeAllListeners("timeout");
      clearTimeout(timer);
      const tls = tlsConnect({
        socket: raw,
        servername: target.hostname,
        rejectUnauthorized: true
      });
      tls.once("secureConnect", () => {
        if (settled) return;
        settled = true;
        resolve5(tls);
      });
      tls.once("error", (err) => {
        if (/certificate|tls|ssl|self[- ]signed|unable to verify/i.test(String(err.message))) {
          fail2(new Error("TLS validation failed"));
        } else {
          fail2(err);
        }
      });
    });
    raw.once("timeout", () => fail2(new Error(`timed out after ${Math.round(timeoutMs / 1e3)}s`)));
    raw.once("error", fail2);
    raw.setTimeout(Math.min(idleTimeoutMs, timeoutMs));
  });
}
function runRequest(client, options, maxBytes, idleTimeoutMs) {
  return new Promise((resolve5, reject) => {
    const idleSecs = Math.round(idleTimeoutMs / 1e3);
    const req = client(options, (res) => {
      const chunks = [];
      let bytes = 0;
      const armIdle = () => {
        if (typeof res.setTimeout === "function") {
          res.setTimeout(
            idleTimeoutMs,
            () => req.destroy(new Error(`timed out after ${idleSecs}s`))
          );
        }
      };
      armIdle();
      res.on("data", (chunk) => {
        armIdle();
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy(new Error(`response exceeded maxFetchKB`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve5({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
        bytesRead: bytes
      }));
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${Math.round(Number(options.timeout ?? 0) / 1e3)}s`)));
    req.setTimeout(Math.min(idleTimeoutMs, Number(options.timeout ?? idleTimeoutMs)));
    req.on("error", reject);
    req.end();
  });
}
function proxyRequest(proxy, target, resolvedAddress, o) {
  const headers = {
    Host: target.host,
    Accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": "GlyphStudio-WebContext/1"
  };
  if (target.protocol === "https:") {
    return connectHttpsThroughProxy(proxy, target, resolvedAddress, o.timeoutMs, o.idleTimeoutMs, o.recordConnect).then((tlsSocket) => runRequest(
      httpsRequest,
      {
        protocol: "https:",
        hostname: target.hostname,
        port: Number(target.port || 443),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
        timeout: o.timeoutMs,
        createConnection: () => tlsSocket
      },
      o.maxBytes,
      o.idleTimeoutMs
    ));
  }
  o.recordConnect?.({ host: resolvedAddress, port: Number(target.port || 80), servername: target.hostname });
  return runRequest(
    httpRequest2,
    {
      protocol: "http:",
      hostname: proxy.hostname,
      port: proxyPort(proxy),
      path: `http://${authorityHost(resolvedAddress)}:${Number(target.port || 80)}${target.pathname}${target.search}`,
      method: "GET",
      headers,
      timeout: o.timeoutMs
    },
    o.maxBytes,
    o.idleTimeoutMs
  );
}
async function governedWebFetch(opts) {
  const originalUrl = String(opts.url || "").trim();
  const lookup2 = opts.lookup ?? dnsLookup;
  const maxFetchBytes = safeInt(opts.maxFetchKB, WEB_DEFAULT_MAX_FETCH_KB, 1, 16384) * 1024;
  const maxContextBytes = safeInt(opts.maxContextKB, WEB_DEFAULT_MAX_CONTEXT_KB, 1, 1024) * 1024;
  const timeoutMs = safeInt(opts.timeoutMs, WEB_DEFAULT_TIMEOUT_MS, 100, 6e4);
  const idleTimeoutMs = safeInt(opts.idleTimeoutMs, WEB_DEFAULT_IDLE_TIMEOUT_MS, 100, 6e4);
  const totalTimeoutMs = safeInt(opts.totalTimeoutMs, timeoutMs, 100, 12e4);
  const deadline = Date.now() + totalTimeoutMs;
  const totalSecs = Math.round(totalTimeoutMs / 1e3);
  const maxRedirects = safeInt(opts.maxRedirects, WEB_DEFAULT_MAX_REDIRECTS, 0, 10);
  const proxy = new URL2(opts.proxyUrl);
  let current = originalUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (Date.now() >= deadline) return fail(originalUrl, `fetch failed \u2014 timed out after ${totalSecs}s`);
    const prepared = prepareWebUrl(current);
    if ("error" in prepared) return { ok: false, originalUrl, marker: prepared.error, reason: prepared.reason };
    const { url, host, port } = prepared;
    let resolved;
    try {
      resolved = await resolvePublic(host, lookup2);
    } catch (err) {
      return fail(originalUrl, `fetch failed \u2014 ${String(err.message || "DNS failure")}`, host);
    }
    if (!resolved) return fail(originalUrl, "refused \u2014 non-public target", host);
    const connectAddress = opts.rebindConnectTarget ? opts.rebindConnectTarget(resolved) : resolved;
    if (!isPublicAddress(connectAddress)) return fail(originalUrl, "refused \u2014 non-public target", host);
    const remaining = Math.max(100, deadline - Date.now());
    const hopTimeout = Math.min(timeoutMs, remaining);
    opts.onAttempt?.({ url: url.toString(), host, port });
    let response;
    try {
      response = await proxyRequest(proxy, url, connectAddress, {
        timeoutMs: hopTimeout,
        idleTimeoutMs: Math.min(idleTimeoutMs, hopTimeout),
        maxBytes: maxFetchBytes,
        ...opts.recordConnect ? { recordConnect: opts.recordConnect } : {}
      });
    } catch (err) {
      const msg = String(err.message ?? err);
      if (Date.now() >= deadline) return fail(originalUrl, `fetch failed \u2014 timed out after ${totalSecs}s`, host);
      if (/timed out/i.test(msg)) return fail(originalUrl, `fetch failed \u2014 ${msg}`, host);
      return fail(originalUrl, `fetch failed \u2014 ${msg.slice(0, 120)}`, host);
    }
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const loc = response.headers.location;
      const location = Array.isArray(loc) ? loc[0] : loc;
      if (!location) return fail(originalUrl, `fetch failed \u2014 HTTP ${response.statusCode}`, host);
      if (hop === maxRedirects) return fail(originalUrl, "fetch failed \u2014 too many redirects", host);
      const next = new URL2(location, url);
      if (url.protocol === "https:" && next.protocol === "http:") {
        return fail(originalUrl, "refused \u2014 non-public target", host);
      }
      current = next.toString();
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return fail(originalUrl, `fetch failed \u2014 HTTP ${response.statusCode}`, host);
    }
    const contentEncoding = String(response.headers["content-encoding"] ?? "");
    let decoded;
    try {
      decoded = decodeBody(response.body, contentEncoding);
    } catch {
      return fail(originalUrl, "unsupported content type \u2014 encoded body");
    }
    const wasCompressed = /gzip|br|deflate/i.test(contentEncoding) && response.bytesRead > 0;
    if (decoded.byteLength > maxFetchBytes * WEB_DEFAULT_MAX_DECOMPRESSION_RATIO) {
      return fail(originalUrl, "fetch failed \u2014 response exceeded decompressed limit", host);
    }
    if (wasCompressed && decoded.byteLength > response.bytesRead * WEB_DEFAULT_MAX_DECOMPRESSION_RATIO) {
      return fail(originalUrl, "fetch failed \u2014 response exceeded decompressed limit", host);
    }
    const contentType = String(response.headers["content-type"] ?? "text/plain");
    const extracted = extractText(decoded, contentType);
    if (extracted.unsupported) return fail(originalUrl, `unsupported content type \u2014 ${contentType.split(";")[0] || "unknown"}`, host);
    const fullText = extracted.text ?? "";
    if (!fullText.trim()) return fail(originalUrl, `no readable content at ${url.toString()}`, host);
    const fullBytes = Buffer.byteLength(fullText, "utf8");
    const truncated = fullBytes > maxContextBytes;
    const text = truncated ? `${Buffer.from(fullText).subarray(0, maxContextBytes).toString("utf8")}
... [truncated]` : fullText;
    const sha256 = createHash8("sha256").update(fullText, "utf8").digest("hex");
    opts.onAttempt?.({ url: url.toString(), host, port, contentSha256: sha256 });
    return {
      ok: true,
      originalUrl,
      finalUrl: url.toString(),
      contentType,
      text,
      fullText,
      sha256,
      bytesRead: response.bytesRead,
      extractedBytes: fullBytes,
      truncated,
      boilerplateStripped: extracted.boilerplateStripped
    };
  }
  return fail(originalUrl, "fetch failed \u2014 too many redirects");
}

// ../spikes/p0-supervisor/bridge-server.ts
var APPROVED_ISOLATION_RUNTIMES = [
  "docker",
  "firecracker"
];
function isApprovedIsolationRuntime(runtimeProfile) {
  return APPROVED_ISOLATION_RUNTIMES.includes(runtimeProfile.trim().toLowerCase());
}
function capabilitiesForProfile(runtimeProfile, network) {
  const profile = runtimeProfile.trim().toLowerCase();
  switch (profile) {
    case "docker":
      return { fsIsolated: true, hardEgress: network === "deny" };
    case "firecracker":
      return { fsIsolated: true, hardEgress: isHardNetworkSpec(network) };
    default:
      return { fsIsolated: false, hardEgress: false };
  }
}
function isHardNetworkSpec(network) {
  if (network === "deny") return true;
  return network.egressMode === "hard-allowlist";
}
function settleCreateRunTrust(request) {
  let network;
  let policyLoadError;
  try {
    const loaded = loadPolicy(request.policyPath);
    if (loaded.policy) {
      network = networkSpecFromPolicy(loaded.policy);
    } else {
      policyLoadError = loaded.errors.join("; ");
      network = { allow: ["(unknown)"], egressMode: "soft-proxy-allow" };
    }
  } catch (err) {
    policyLoadError = err instanceof Error ? err.message : String(err);
    network = { allow: ["(unknown)"], egressMode: "soft-proxy-allow" };
  }
  if (policyLoadError !== void 0) {
    return {
      trust: "untrusted",
      capabilities: { fsIsolated: false, hardEgress: false },
      network,
      policyLoadError
    };
  }
  const capabilities = capabilitiesForProfile(request.runtimeProfile, network);
  const trust = trustFromCapabilities(capabilities);
  return { trust, capabilities, network };
}
function trustReasonForCreate(verdict) {
  if (verdict.trust === "trusted") return void 0;
  if (verdict.trust === "sandboxed-soft-egress") {
    return "runtime is fs-isolated but egress is SOFT (application-layer allowlist; raw-socket bypass possible on Docker/Colima); run is sandboxed-soft-egress, NOT product-trusted. A hard egress allowlist is the Firecracker remote plane (future work).";
  }
  if (verdict.policyLoadError) {
    return `run policy could not be loaded, so the supervisor cannot attest the run's egress allowlist / verify scope / policy hash; the run is untrusted (a run whose policy bytes are unreadable cannot be trusted). (policy load error: ${verdict.policyLoadError})`;
  }
  return "runtime is non-isolating (no filesystem boundary the actor cannot escape); run is untrusted (a non-isolating runtime cannot produce a product-trusted run).";
}
function selfHashCheck(selfPath, pinnedSha) {
  if (!pinnedSha) return { ok: true };
  if (!selfPath) {
    return { ok: false, message: "self-hash check: no path to hash but a pin is set" };
  }
  let actual;
  try {
    actual = createHash9("sha256").update(readFileSync8(selfPath)).digest("hex");
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
function createGovernedChangeReviewRunner(config = {}) {
  return async (opts) => {
    const codexPath = config.codexPath ?? resolveOnPath("codex") ?? void 0;
    const result = await runGovernedChangeReview({
      cwd: opts.cwd,
      scope: opts.scope,
      ...opts.baseRef ? { baseRef: opts.baseRef } : {},
      // ONE RUN, ONE TRACE: bind the runner to the handler's run so the
      // review_requested → review_findings → verifier_verdict chain lands in the
      // handler-owned trace under the ack runId.
      existingRun: opts.existingRun,
      // CANCELLATION: run/cancel's AbortController signal stops the findings
      // turn / inline check promptly; the handler suppresses post-cancel emission.
      signal: opts.signal,
      ...config.generateFindings ? { generateFindings: config.generateFindings } : {},
      ...codexPath ? { codexPath } : {},
      ...config.verifierPrivateKey ? { verifierPrivateKey: config.verifierPrivateKey } : {},
      // A config-injected check is an operator override ('override' is the
      // runner's own default source for an explicit verifyCommand).
      ...config.verifyCommand ? { verifyCommand: config.verifyCommand } : {},
      ...config.denyDirectIp !== void 0 ? { denyDirectIp: config.denyDirectIp } : {},
      ...config.autoIndependentVerifier !== void 0 ? { autoIndependentVerifier: config.autoIndependentVerifier } : {},
      ...config.verifierRuntime !== void 0 ? { verifierRuntime: config.verifierRuntime } : {},
      ...config.runsBaseDir ? { runsBaseDir: config.runsBaseDir } : {},
      emit: (event) => {
        switch (event.type) {
          case "run_created":
            opts.emit(`run_created:${event.posture}`);
            return;
          case "state":
            opts.emit(event.to);
            return;
          case "findings":
            opts.emit(`findings:${event.payload.parseStatus}`);
            return;
          case "run_closed":
            opts.emit(event.ok ? "closed:ok" : "closed:failed");
            return;
          // 'verdict'/'result' are carried by the terminal result.review — not
          // streamed separately (no second verdict surface on the wire).
          default:
            return;
        }
      },
      ...opts.onOperatorLog ? { onOperatorLog: opts.onOperatorLog } : {}
    });
    return result.review;
  };
}
function createGovernedBuildPlanRunner(config = {}) {
  return async (opts) => {
    const codexPath = config.codexPath ?? resolveOnPath("codex") ?? void 0;
    const result = await runGovernedPlanTurn({
      cwd: opts.cwd,
      prompt: opts.prompt,
      // ONE RUN, ONE TRACE: bind the runner to the handler's run so the
      // plan_proposed record (and the model-turn breadcrumbs) chain into the
      // handler-owned trace under the ack runId — the SAME chain the later
      // plan_approved + build + verdict continue.
      existingRun: opts.existingRun,
      // CANCELLATION: run/cancel's AbortController signal stops the plan turn
      // promptly; the handler suppresses post-cancel emission.
      signal: opts.signal,
      ...config.generatePlan ? { generatePlan: config.generatePlan } : {},
      ...codexPath ? { codexPath } : {},
      ...config.denyDirectIp !== void 0 ? { denyDirectIp: config.denyDirectIp } : {},
      ...config.runsBaseDir ? { runsBaseDir: config.runsBaseDir } : {},
      emit: (event) => {
        switch (event.type) {
          case "run_created":
            opts.emit(`run_created:${event.posture}`);
            return;
          case "state":
            opts.emit(event.to);
            return;
          case "result":
            opts.emit(`plan:${event.proposal.parseStatus}`);
            return;
          // 'plan' is carried by the handler's gate-checked plan/event — not
          // streamed separately (no second plan surface on the wire).
          default:
            return;
        }
      },
      ...opts.onOperatorLog ? { onOperatorLog: opts.onOperatorLog } : {}
    });
    return result.proposal;
  };
}
var DEFAULT_INDEX_RETRIEVE_K = 6;
var MAX_SESSION_WORKSPACE_ROOTS = 16;
var DEFAULT_MCP_APPROVAL_TIMEOUT_MS = 12e4;
var DEFAULT_MCP_POLICY = {
  version: 1,
  defaults: { file_read: "ask", file_write: "ask", command: "ask", network: "deny", mcp: "ask" },
  allow: { read_paths: [], write_paths: [], commands: [], network: [] },
  deny: { read_paths: [], write_paths: [], commands: [] },
  verify: Object.freeze([])
};
var MAX_INDEX_UPDATE_BATCH_PATHS = 4096;
function sanitizeRelPathBatch(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
    if (out.length >= MAX_INDEX_UPDATE_BATCH_PATHS) break;
  }
  return out;
}
var DEFAULT_CHAT_BACKEND_ID = "codex";
var CODEX_HASH_CAP_BYTES = 256 * 1024 * 1024;
function captureCodexBinaryIdentity(codexPath) {
  const identity = { path: codexPath };
  let sizeBytes;
  try {
    const st = statSync4(codexPath);
    sizeBytes = st.size;
    identity.sizeBytes = st.size;
    identity.mtimeMs = st.mtimeMs;
  } catch {
  }
  if (sizeBytes === void 0 || sizeBytes <= CODEX_HASH_CAP_BYTES) {
    try {
      const hash = createHash9("sha256").update(readFileSync8(codexPath)).digest("hex");
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
  const agentic2 = result.agentic;
  const changedFiles = (agentic2?.changedFiles ?? []).map((f) => ({
    path: f.path,
    status: mapGitStatusToReviewStatus(f.status)
  }));
  const commands = (agentic2?.commands ?? []).map((c) => ({
    cmd: c.cmd,
    ...c.exitCode !== void 0 ? { exitCode: c.exitCode } : {}
  }));
  const egress = readObservedEgress(result);
  const verdict = result.verdict;
  const verifierIsolation = readVerifierIsolation(result);
  const verifyCommandSource = readVerifyCommandSource(result);
  const isolationUnavailableReason = verifierIsolation === "inline-unsandboxed" ? readIsolationUnavailableReason(result) : void 0;
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
    summary: agentic2?.summary ?? "",
    changedFiles,
    diff: agentic2?.diff ?? "",
    commands,
    egress,
    verdict: {
      overall: verdict.overallVerdict,
      assurance,
      verifierIsolation,
      verifyCommandSource,
      ...isolationUnavailableReason ? { isolationUnavailableReason } : {},
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
function readIsolationUnavailableReason(result) {
  const maybe = result.isolationUnavailableReason;
  return typeof maybe === "string" && maybe.trim().length > 0 ? maybe : void 0;
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
var MAX_STEERING_RULES = 64;
var MAX_STEERING_FIELD_LENGTH = 512;
var SHA256_HEX_RE = /^[0-9a-f]{64}$/;
function validateSteeringPayload(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
  const obj = raw;
  const surface = obj.surface;
  if (surface !== "chat" && surface !== "inline-edit" && surface !== "agentic") return void 0;
  if (typeof obj.blockSha256 !== "string" || !SHA256_HEX_RE.test(obj.blockSha256)) {
    return void 0;
  }
  if (!Array.isArray(obj.rules) || obj.rules.length === 0 || obj.rules.length > MAX_STEERING_RULES) {
    return void 0;
  }
  const rules = [];
  for (const entry of obj.rules) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return void 0;
    const rule = entry;
    const { name, scope, reason, sha256 } = rule;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_STEERING_FIELD_LENGTH) {
      return void 0;
    }
    if (typeof scope !== "string" || scope.length === 0 || scope.length > MAX_STEERING_FIELD_LENGTH) {
      return void 0;
    }
    if (typeof reason !== "string" || reason.length === 0 || reason.length > MAX_STEERING_FIELD_LENGTH) {
      return void 0;
    }
    if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) return void 0;
    rules.push({ name, scope, reason, sha256 });
  }
  return { surface, rules, blockSha256: obj.blockSha256 };
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
  review;
  plan;
  terminalModelEndpoints;
  index;
  mcp;
  stdinBuffer = "";
  handshakeDone = false;
  hashChecked = false;
  /**
   * The CANONICAL session workspace root SET `index/retrieve` is BOUND to (the index/
   * disclosure boundary) — one entry per workspace root of a (possibly MULTI-ROOT)
   * workspace. Established at the trusted handshake channel and then PINNED:
   *   - PREFERRED: from the handshake (`HandshakeParams.workspaceRoots`, plus the
   *     legacy single-root `HandshakeParams.workspaceRoot` — both bind into the set),
   *     each entry canonicalized (realpath) at handshake; uncanonicalizable entries
   *     are skipped (resolve-never-throw) and the set is capped at
   *     {@link MAX_SESSION_WORKSPACE_ROOTS} (extras logged + ignored). Index RPCs then
   *     accept any MEMBER root and refuse every other directory.
   *   - FALLBACK: when the handshake bound NO root (older client / no workspace folder
   *     open), the set is pinned from the FIRST post-handshake index call (the
   *     legitimate extension's warm-up, fired on session open before any adversary can
   *     interpose). A later call with a DIFFERENT canonical root is refused.
   * Once non-empty, a request whose canonical root is NOT a member is refused WITHOUT
   * indexing or reading that root — so the local index can only ever index the
   * first-party session's own workspace root(s), never an arbitrary readable absolute
   * directory. Insertion order is preserved (the first-bound root is the session's
   * PRIMARY root, used where a single representative root is needed, e.g. mcp/call's
   * lazy broker).
   */
  sessionWorkspaceRoots = /* @__PURE__ */ new Set();
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
  /** Monotonic counter minting change-review run ids (per connection). */
  reviewSeq = 0;
  /** Monotonic counter minting plan run ids (per connection). */
  planSeq = 0;
  /**
   * PARKED governed plan runs awaiting approve/reject, keyed by runId (#8 — the
   * plan-mode mirror of {@link pendingBuilds}). A `plan/start` parks its run here
   * after `plan_proposed` is appended; a `build/start` carrying the SAME runId +
   * `planApproval` consumes it (→ `plan_approved` → the build executes on the
   * SAME trace), `plan/reject` closes it, and `run/cancel` discards it.
   */
  parkedPlans = /* @__PURE__ */ new Map();
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
  /**
   * The CONNECTION-SCOPED MCP broker state (#9 — governed MCP brokering): the
   * session workspace's loaded `.glyphstudio/mcp.json` entries plus ONE
   * supervisor-owned {@link McpStdioClient} (server child process) per usable
   * entry, keyed by server name. Established lazily by `mcp/list` (or a first
   * `mcp/call`) against the SAME pinned session root the index RPCs bind to.
   * The server children are connection-scoped: {@link shutdown} disposes every
   * client (SIGTERM → SIGKILL), so MCP children die with the connection —
   * mirroring the governed-chat-session / remoteTraceWriters lifecycle.
   */
  mcpBroker;
  /**
   * In-flight `mcp/call`s HELD on an ask/force_ask policy decision, awaiting the
   * operator's `approval/respond` verdict (#9 Slice 2), keyed by approvalId.
   * Each resolver settles the held call EXACTLY ONCE (allow / deny / honest
   * timeout); {@link shutdown} denies any survivor so a closing connection
   * never leaves a call parked forever. The MCP analogue of pendingBuilds —
   * the SAME approval/respond RPC resolves both.
   */
  pendingMcpApprovals = /* @__PURE__ */ new Map();
  /** Monotonic per-connection counter minting unique MCP approval ids. */
  mcpApprovalSeq = 0;
  /**
   * Per-workspace LOCAL code index (@Codebase). Keyed by absolute workspaceRoot, each
   * entry holds the brute-force vector store + the BM25 keyword index + the in-flight
   * build promise, so the HYBRID index is built ONCE per workspace and concurrent
   * retrievals de-dupe onto the same build (the first retrieve for a workspace triggers
   * the lazy buildIndex; later ones reuse the cached store + keyword index). Both
   * structures are populated in the SAME buildIndex call so they stay in lockstep.
   * Memory-only residency: nothing is written to disk by this seam.
   */
  indexStores = /* @__PURE__ */ new Map();
  /**
   * The DEFAULT embedder for `index/retrieve`, constructed ONCE on first use (a loopback
   * {@link OllamaEmbedder}) when no embedder was injected via `index.embedder`. Lazy so a
   * supervisor that never retrieves never constructs it.
   */
  defaultEmbedder;
  /**
   * Serialization tail for `index/update`: each incremental update CHAINS behind the
   * previous one so two batches can never interleave their evict/re-embed mutations
   * on the shared store (the extension coalesces batches, but the server must not
   * rely on client behavior at a trust boundary). Never-rejecting links — a failed
   * update logs + answers honestly and the tail stays usable. No timer, no handle:
   * an idle tail is just a settled promise and can never hold the process open.
   */
  indexUpdateTail = Promise.resolve();
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
    this.review = opts.review;
    this.plan = opts.plan;
    this.terminalModelEndpoints = opts.terminalModelEndpoints;
    this.index = opts.index;
    this.mcp = opts.mcp;
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
   * opened GOVERNED CHAT SESSION and any live governed terminal sessions: their
   * egress proxy listeners + run traces.
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
    for (const serverRun of this.runs.values()) {
      if (!serverRun.terminalSession || serverRun.terminalVerdict) continue;
      try {
        serverRun.terminalVerdict = await serverRun.terminalSession.stop();
      } catch {
      }
    }
    for (const resolve5 of [...this.pendingMcpApprovals.values()]) {
      try {
        resolve5("deny", "connection shut down before an operator decision \u2014 denied");
      } catch {
      }
    }
    this.pendingMcpApprovals.clear();
    const mcpBroker = this.mcpBroker;
    this.mcpBroker = void 0;
    if (mcpBroker) {
      for (const client of mcpBroker.clients.values()) {
        try {
          await client.dispose();
        } catch {
        }
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
            "foreign envelope: missing or wrong glyphstudio dialect tag"
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
      case BridgeMethod.ChatBackends:
        void this.handleChatBackends(req);
        return;
      case BridgeMethod.WebFetch:
        void this.handleWebFetch(req);
        return;
      case BridgeMethod.AgenticBuildStart:
        void this.handleAgenticBuildStart(req);
        return;
      case BridgeMethod.ChangeReviewStart:
        void this.handleChangeReviewStart(req);
        return;
      case BridgeMethod.BuildPlanStart:
        void this.handleBuildPlanStart(req);
        return;
      case BridgeMethod.BuildPlanReject:
        this.handleBuildPlanReject(req);
        return;
      case BridgeMethod.RunCancel:
        this.handleRunCancel(req);
        return;
      case BridgeMethod.ApprovalRespond:
        this.handleApprovalRespond(req);
        return;
      case BridgeMethod.IndexRetrieve:
        void this.handleIndexRetrieve(req);
        return;
      case BridgeMethod.IndexBuild:
        void this.handleIndexBuild(req);
        return;
      case BridgeMethod.IndexUpdate:
        void this.handleIndexUpdate(req);
        return;
      case BridgeMethod.McpList:
        void this.handleMcpList(req);
        return;
      case BridgeMethod.McpCall:
        void this.handleMcpCall(req);
        return;
      case BridgeMethod.RecordHuman:
        this.handleRecordHuman(req);
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
    const params = req.params ?? {};
    const requestedRoots = [];
    if (typeof params.workspaceRoot === "string" && params.workspaceRoot.trim().length > 0) {
      requestedRoots.push(params.workspaceRoot.trim());
    }
    if (Array.isArray(params.workspaceRoots)) {
      for (const r of params.workspaceRoots) {
        if (typeof r === "string" && r.trim().length > 0) requestedRoots.push(r.trim());
      }
    }
    for (const requested of requestedRoots) {
      if (this.sessionWorkspaceRoots.size >= MAX_SESSION_WORKSPACE_ROOTS) {
        this.logLine(
          `[bridge-server] handshake workspace-root cap reached (${MAX_SESSION_WORKSPACE_ROOTS}); ignoring extra root(s).`
        );
        break;
      }
      const canonical = this.canonicalDir(requested);
      if (canonical) {
        if (!this.sessionWorkspaceRoots.has(canonical)) {
          this.sessionWorkspaceRoots.add(canonical);
          this.logLine(`[bridge-server] session workspace root bound from handshake: ${canonical}`);
        }
      } else {
        this.logLine(
          `[bridge-server] handshake workspaceRoot is not a readable directory; skipped.`
        );
      }
    }
    if (requestedRoots.length > 0 && this.sessionWorkspaceRoots.size === 0) {
      this.logLine(
        `[bridge-server] no handshake workspace root was bindable; deferring index/retrieve binding to first post-handshake retrieve.`
      );
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
    const verdict = settleCreateRunTrust(request);
    const trust = verdict.trust;
    const isolation = verdict.capabilities.fsIsolated;
    const reason = trustReasonForCreate(verdict);
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
      `[bridge-server] run/create \u2192 ${trust} (runId=${created.runId}, runtime=${request.runtimeProfile}, actor=${request.actorType}, fsIsolated=${verdict.capabilities.fsIsolated}, hardEgress=${verdict.capabilities.hardEgress}).`
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
    this.remoteTracePaths.set(
      created.runId,
      join17(runSubdirPath(created.dir, "trace"), "trace.jsonl")
    );
    const namesApprovedRuntime = isApprovedIsolationRuntime(request.runtimeProfile);
    const runtimeIsolated = false;
    const trust = "governed-unsandboxed";
    const serverRun = {
      created,
      lifecycle,
      trust,
      request,
      runtimeIsolated,
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
      // No sandbox is provisioned here, so the runtime-trust badge is 'untrusted'
      // regardless of the profile name. (startTerminalSession also derives the badge
      // honestly from real capabilities on the isolation path; on this host path it
      // forces 'untrusted'. We pass the honest value so the facts never imply
      // isolation the session does not provide.)
      runtimeTrust: runtimeIsolated ? "trusted" : "untrusted",
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
        `[bridge-server] terminal/start \u2192 ${trust} (runId=${created.runId}, proxy=${session.proxyUrl}, posture=${posture}, runtimeIsolated=${runtimeIsolated}${namesApprovedRuntime ? ` [profile '${request.runtimeProfile}' names an approved runtime but is NOT provisioned on the host path]` : ""}).`
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
   * chat/send — drive ONE chat turn through the GlyphStudio-controlled model
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
      if (params.steering !== void 0 && runId) {
        const steering = validateSteeringPayload(params.steering);
        if (!steering) {
          this.logLine(
            `[bridge-server] chat/send turn ${turnId}: malformed steering payload ignored (turn unaffected).`
          );
        } else {
          this.appendSteeringToRun(runId, steering, `chat/send turn ${turnId}`);
        }
      }
      const serverRun = runId ? this.runs.get(runId) : void 0;
      const cwd = serverRun?.created.dir ?? process.cwd();
      const gateway = this.ensureChatGateway();
      this.chatActiveRunId = runId;
      try {
        const model = typeof params.model === "string" && params.model.trim().length > 0 ? params.model.trim() : void 0;
        const maxOutputTokens = typeof params.maxOutputTokens === "number" && Number.isFinite(params.maxOutputTokens) && params.maxOutputTokens > 0 ? Math.floor(params.maxOutputTokens) : void 0;
        for await (const event of gateway.chatTurn(
          backendId,
          {
            messages: params.messages,
            cwd,
            ...model ? { model } : {},
            ...maxOutputTokens !== void 0 ? { maxOutputTokens } : {}
          },
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
  /**
   * chat/backends — DISCOVER the chat backends a `chat/send` can route to (the
   * model-picker surface). Handshake-gated like the other introspection RPCs
   * (model/allowlist). Every status is PROBED AT REQUEST TIME — never cached,
   * never assumed:
   *   - codex ('frontier'): available iff its binary resolves — the SAME
   *     `resolveOnPath('codex')` check the chat session's launch path performs
   *     (a test stubs it via {@link ChatGatewayConfig.resolveCodexPath}). No
   *     `models` list: codex picks its own model out-of-band.
   *   - ollama ('local'): available iff the LOOPBACK daemon answers `/api/tags`;
   *     `models` is the installed-model NAMES from that response, capped at
   *     {@link OLLAMA_MODEL_LIST_CAP}.
   * NO PHANTOM BACKENDS: a failed probe reports 'unavailable' with an honest
   * non-secret detail — never an invented model name. The result carries
   * ids/names only, NEVER a credential.
   */
  async handleChatBackends(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "chat/backends before a completed handshake"
        )
      );
      return;
    }
    const resolveCodex = this.chat?.resolveCodexPath ?? (() => resolveOnPath("codex"));
    let codexInfo;
    try {
      const codexPath = resolveCodex();
      codexInfo = codexPath ? { id: "codex", status: "ok", kind: "frontier" } : {
        id: "codex",
        status: "unavailable",
        kind: "frontier",
        detail: "codex binary not found on PATH"
      };
    } catch (err) {
      codexInfo = {
        id: "codex",
        status: "unavailable",
        kind: "frontier",
        detail: `codex probe failed: ${String(err?.message ?? err)}`
      };
    }
    const probe = await probeOllamaModels(
      this.chat?.ollamaHost ?? DEFAULT_OLLAMA_HOST,
      OLLAMA_MODEL_LIST_CAP
    );
    const ollamaInfo = probe.ok ? { id: "ollama", status: "ok", kind: "local", models: probe.models } : { id: "ollama", status: "unavailable", kind: "local", detail: probe.detail };
    const result = { backends: [codexInfo, ollamaInfo] };
    this.emit(this.successResponse(req.id, result));
  }
  /**
   * web/fetch — supervisor-owned `@Web` fetch. This deliberately does NOT create a
   * governed chat session: v4 locks no-active-session behavior to fail-closed. A
   * successful fetch appends metadata + content hash only to the active chat run's
   * trace; fetched body is returned to the caller for one-turn untrusted context
   * injection and is never persisted here.
   */
  async handleWebFetch(req) {
    const fail2 = (result) => {
      this.emit(this.successResponse(req.id, result));
    };
    if (!this.handshakeDone) {
      fail2({
        ok: false,
        originalUrl: "",
        marker: "[@Web: fetch failed \u2014 supervisor unavailable]",
        reason: "web/fetch before a completed handshake"
      });
      return;
    }
    const governed = this.chatGovernedSession;
    if (!governed || !this.runs.has(governed.runId)) {
      fail2({
        ok: false,
        originalUrl: typeof req.params?.url === "string" ? req.params.url : "",
        marker: "[@Web: fetch failed \u2014 no active governed session]",
        reason: "no active governed session"
      });
      return;
    }
    const params = req.params ?? {};
    const originalUrl = typeof params.url === "string" ? params.url : "";
    if (!originalUrl.trim()) {
      fail2({
        ok: false,
        originalUrl,
        marker: "[@Web: refused \u2014 not a valid URL]",
        reason: "refused \u2014 not a valid URL"
      });
      return;
    }
    const run2 = this.runs.get(governed.runId);
    const tracePath = run2?.created?.dir ? join17(runSubdirPath(run2.created.dir, "trace"), "trace.jsonl") : void 0;
    const sink = tracePath ? createTraceWriter(tracePath) : void 0;
    const seen = /* @__PURE__ */ new Set();
    const recordAttempt = (attempt) => {
      if (!sink) return;
      const key = `${attempt.host}:${attempt.port}:${attempt.contentSha256 ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      const payload = {
        tool: "network",
        requestedCapability: `network:${attempt.host}:${attempt.port}`,
        destination: `${attempt.host}:${attempt.port}`,
        decision: "allow",
        enforcement: "observe-only",
        provenanceLabel: "web",
        rule: "observed \u2014 @Web public-document fetch through governed soft egress; NOT a hard allowlist authorization",
        ...attempt.contentSha256 ? { contentSha256: attempt.contentSha256 } : {}
      };
      const appended = sink.append({
        v: TRACE_EVENT_VERSION,
        runId: governed.runId,
        seq: 0,
        ts: Date.now(),
        type: "policy_decision",
        payload
      });
      this.emitRunEventEnvelope({
        rev: RUN_EVENT_PROTOCOL_VERSION,
        runId: governed.runId,
        kind: "trace_event",
        event: appended
      });
    };
    try {
      const result = await governedWebFetch({
        url: originalUrl,
        proxyUrl: governed.proxyUrl,
        ...typeof params.maxFetchKB === "number" ? { maxFetchKB: params.maxFetchKB } : {},
        ...typeof params.maxContextKB === "number" ? { maxContextKB: params.maxContextKB } : {},
        ...typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : {},
        ...typeof params.maxRedirects === "number" ? { maxRedirects: params.maxRedirects } : {},
        onAttempt: recordAttempt
      });
      const response = result.ok ? { ...result, runId: governed.runId } : result;
      this.emit(this.successResponse(req.id, response));
    } catch (err) {
      this.logLine(`[bridge-server] web/fetch failed: ${String(err?.message ?? err)}`);
      fail2({
        ok: false,
        originalUrl,
        marker: "[@Web: fetch failed \u2014 supervisor unavailable]",
        reason: "supervisor unavailable"
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
    let steering;
    if (params.steering !== void 0) {
      steering = validateSteeringPayload(params.steering);
      if (!steering) {
        this.logLine(
          `[bridge-server] build/start ${runId}: malformed steering payload ignored (build unaffected).`
        );
      }
    }
    const ack = { runId };
    this.emit(this.successResponse(req.id, ack));
    const parked = this.parkedPlans.get(runId);
    if (params.planApproval !== void 0 && !parked) {
      this.logLine(
        `[bridge-server] build/start ${runId} REFUSED \u2014 planApproval without a parked plan run.`
      );
      this.emitAgenticBuildEvent({
        runId,
        type: "error",
        message: `build/start carried a planApproval but '${runId}' is not a parked plan run (already resolved, cancelled, or never parked) \u2014 refused`
      });
      return;
    }
    if (parked) {
      if (params.planApproval === void 0) {
        this.logLine(
          `[bridge-server] build/start ${runId} REFUSED \u2014 parked plan run without a planApproval; run stays parked.`
        );
        this.emitAgenticBuildEvent({
          runId,
          type: "error",
          message: `'${runId}' is a parked plan run \u2014 build/start on it requires a planApproval (or plan/reject to close it); the run stays parked`
        });
        return;
      }
      if (params.approved !== true) {
        this.logLine(
          `[bridge-server] build/start ${runId} REFUSED \u2014 plan resume without the authority grant; run stays parked.`
        );
        this.emitAgenticBuildEvent({
          runId,
          type: "error",
          message: `agentic build requires explicit authority approval (it may edit files and run commands in ${cwd}) \u2014 an approved plan never substitutes for the grant; the run stays parked`
        });
        return;
      }
      if (cwd !== parked.cwd) {
        this.logLine(
          `[bridge-server] build/start ${runId} REFUSED \u2014 cwd '${cwd}' \u2260 planned cwd '${parked.cwd}'; run stays parked.`
        );
        this.emitAgenticBuildEvent({
          runId,
          type: "error",
          message: `plan resume refused: build cwd '${cwd}' does not match the planned repo '${parked.cwd}' \u2014 the run stays parked`
        });
        return;
      }
      try {
        assertBuildPlanWellFormed(params.planApproval.plan);
      } catch (gateErr) {
        this.logLine(
          `[bridge-server] build/start ${runId} REFUSED by the plan gate: ${String(gateErr?.message ?? gateErr)}; run stays parked.`
        );
        this.emitAgenticBuildEvent({
          runId,
          type: "error",
          message: `plan approval refused \u2014 ${String(gateErr?.message ?? gateErr)}; the run stays parked`
        });
        return;
      }
      this.parkedPlans.delete(runId);
      const planApprovalId = `plan-apr-${runId}`;
      const approvedPlan = {
        approvalId: planApprovalId,
        plan: params.planApproval.plan,
        edited: params.planApproval.edited === true
        // planMarkdownSha256 deliberately unset in v1 (see the NOTE above).
      };
      parked.sink.append({
        v: TRACE_EVENT_VERSION,
        runId,
        seq: 0,
        ts: Date.now(),
        type: "plan_approved",
        payload: approvedPlan,
        source: "supervisor"
      });
      this.emitAgenticBuildEvent({ runId, type: "state", state: `plan_approved:${planApprovalId}` });
      this.logLine(
        `[bridge-server] build/start ${runId} resuming parked plan run (plan_approved ${planApprovalId}, edited=${approvedPlan.edited}).`
      );
      await this.runApprovedBuild(
        runId,
        prompt,
        cwd,
        {
          runDir: parked.runDir,
          tracePath: parked.tracePath,
          approvedPlan: params.planApproval.plan
        },
        steering
      );
      return;
    }
    if (params.approved === true) {
      await this.runApprovedBuild(runId, prompt, cwd, void 0, steering);
      return;
    }
    if (params.pendingApproval === true) {
      const approvalId = `apr-${runId}`;
      const pendingRun = createRun(this.agentic?.runsBaseDir ?? this.runsBaseDir);
      const pendingTracePath = join17(runSubdirPath(pendingRun.dir, "trace"), "trace.jsonl");
      this.remoteTracePaths.set(runId, pendingTracePath);
      this.pendingBuilds.set(approvalId, {
        approvalId,
        runId,
        prompt,
        cwd,
        runDir: pendingRun.dir,
        tracePath: pendingTracePath,
        ...steering ? { steering } : {}
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
  async runApprovedBuild(runId, prompt, cwd, existing, steering) {
    const abort = new AbortController();
    try {
      const buildRun = existing ? { runId, dir: existing.runDir, state: "created" } : createRun(this.agentic?.runsBaseDir ?? this.runsBaseDir);
      const tracePath = existing ? existing.tracePath : join17(runSubdirPath(buildRun.dir, "trace"), "trace.jsonl");
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
      if (steering) {
        this.appendSteeringToRun(runId, steering, `build/start ${runId}`);
      }
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
        // TRUSTED SIGNING KEY (the chat→build "Verified:" trailer fix): when the
        // operator's machine keystore key was forwarded to this supervisor, sign the
        // verdict with it so its already-pinned public key earns signatureVerified:true
        // in the IDE. Absent ⇒ the runner falls back to a per-run ephemeral key. This
        // key reaches ONLY the verifier here; the actor's env is firewalled (see the
        // AgenticBuildConfig.verifierPrivateKey doc + cli-agent-launcher sanitizeBaseEnv).
        ...this.agentic?.verifierPrivateKey ? { verifierPrivateKey: this.agentic.verifierPrivateKey } : {},
        ...verifyCommand ? { verifyCommand, verifyCommandSource } : {},
        ...this.agentic?.denyDirectIp !== void 0 ? { denyDirectIp: this.agentic.denyDirectIp } : {},
        // Deterministic verifier-isolation posture for tests: forward the injectable
        // Docker probe so inline-posture assertions don't flip on Docker-up hosts.
        ...this.agentic?.autoIndependentVerifier !== void 0 ? { autoIndependentVerifier: this.agentic.autoIndependentVerifier } : {},
        // Pluggable verifier-runtime preference (Track A / Slice 1): forward the
        // operator's machine-scoped choice so the runner's runtime selection (and
        // its honest degraded reason) reflects it. Absent ⇒ the runner's 'auto'.
        ...this.agentic?.verifierRuntime !== void 0 ? { verifierRuntime: this.agentic.verifierRuntime } : {},
        // The operator-APPROVED plan (#8 plan-mode resume): claims-only — the
        // bundle's actor-claims render the formatPlanClaim summary; the chain
        // already carries the structured plan via plan_approved.
        ...existing?.approvedPlan ? { approvedPlan: existing.approvedPlan } : {},
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
    const run2 = this.runs.get(runId);
    if (!run2) return;
    if (run2.buildTerminal === true) return;
    run2.buildTerminal = true;
    run2.buildAbort = void 0;
    try {
      if (!run2.lifecycle.isTerminal && run2.lifecycle.canTransitionTo(to)) {
        run2.lifecycle.transition(to, `build ${to}`);
      } else if (!run2.lifecycle.isTerminal) {
        if (run2.lifecycle.canTransitionTo("executing")) {
          run2.lifecycle.transition("executing", "build executing (finalize)");
        }
        if (run2.lifecycle.canTransitionTo(to)) run2.lifecycle.transition(to, `build ${to}`);
      }
    } catch {
    }
  }
  /* ============================================================== *
   * CHANGE REVIEW RPC (#7 — "Review Changes (Verifier-Backed)")
   * ============================================================== */
  /**
   * review/start — START a GOVERNED CHANGE REVIEW and STREAM it as `review/event`
   * notifications. Mirrors `build/start`'s shape exactly (handshake gate →
   * synchronous ack `{runId}` → streamed events → ONE terminal result/error), with
   * ONE deliberate divergence:
   *
   * NO APPROVAL MODAL (frozen design decision). A review is READ-ONLY over the
   * repo, explicitly user-invoked, and its only egress is the same governed
   * gateway turn the commit-message feature already uses modal-free. Friction
   * follows authority — a review grants none, so no authority gate interposes.
   * The invocation is still recorded honestly in the run's hash-chained trace:
   * the runner's `review_requested` event (scope + baseRef + diffSha256) is the
   * auditable record, appended through the SAME trace writer this handler mints.
   *
   * THE RUNNER IS INJECTED (`ChangeReviewConfig.runner`, mirroring
   * `AgenticBuildConfig.runner`): Track A's real governed review runner binds in
   * the integration slice. Until a runner is configured, this handler answers
   * with an honest JSON-RPC error ("review runner not wired") BEFORE acking — it
   * never fabricates a review and never dies silently.
   *
   * HONESTY GATE: the runner's returned {@link ChangeReview} is run through the
   * contract gate {@link assertChangeReviewWellFormed} before it is streamed — an
   * over-claiming or malformed review becomes a terminal `error` event (with the
   * gate's problem tags), never a rendered result.
   *
   * CANCELLATION: the run registers in the SAME generic run registry `run/cancel`
   * uses (an AbortController threaded into the runner). The run is marked
   * `reviewRun:true`, so a cancel's terminal aborted/error markers are emitted as
   * honest `review/event`s (the stream this run's client listens on) — same
   * marker vocabulary as a cancelled build, different (correct) stream.
   */
  async handleChangeReviewStart(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "review/start before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (cwd.length === 0) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "review/start requires a non-empty absolute cwd (the git repo to review)"
        )
      );
      return;
    }
    const scope = params.scope;
    if (!CHANGE_REVIEW_SCOPES.includes(scope)) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `review/start requires scope \u2208 {${CHANGE_REVIEW_SCOPES.join(", ")}} (got ${JSON.stringify(params.scope ?? null)})`
        )
      );
      return;
    }
    const baseRef = typeof params.baseRef === "string" && params.baseRef.trim().length > 0 ? params.baseRef.trim() : void 0;
    const runner = this.review?.runner;
    if (!runner) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "review runner not wired \u2014 this supervisor build has no change-review runner configured (the governed review runner binds in the integration slice)"
        )
      );
      return;
    }
    const runId = `review-${++this.reviewSeq}`;
    const ack = { runId };
    this.emit(this.successResponse(req.id, ack));
    const abort = new AbortController();
    try {
      const created = createRun(this.review?.runsBaseDir ?? this.runsBaseDir);
      const reviewRun = { runId, dir: created.dir, state: created.state };
      const tracePath = join17(runSubdirPath(reviewRun.dir, "trace"), "trace.jsonl");
      const sink = createTraceWriter(tracePath);
      const reviewLifecycle = new RunLifecycle(reviewRun.state);
      const reviewServerRun = {
        created: reviewRun,
        lifecycle: reviewLifecycle,
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
        buildAbort: abort,
        // Mark the run as a REVIEW so run/cancel's terminal markers ride the
        // review/event stream (the stream this run's client listens on).
        reviewRun: true
      };
      this.runs.set(runId, reviewServerRun);
      this.emitChangeReviewEvent({ runId, type: "state", state: "review_started" });
      this.logLine(`[bridge-server] review/start ${runId} (scope=${scope}, cwd=${cwd}).`);
      const review = await runner({
        cwd,
        scope,
        ...baseRef ? { baseRef } : {},
        existingRun: { runId, tracePath, sink },
        signal: abort.signal,
        emit: (state) => this.emitChangeReviewEvent({ runId, type: "state", state }),
        onOperatorLog: (line) => this.logLine(`[bridge-server] [review ${runId}] ${line}`)
      });
      if (this.runs.get(runId)?.buildTerminal === true) {
        this.logLine(`[bridge-server] review/start ${runId} was cancelled mid-flight; suppressing result.`);
        return;
      }
      const gate = assertChangeReviewWellFormed(review);
      if (gate.ok === false) {
        this.markRunTerminal(runId, "failed");
        this.logLine(
          `[bridge-server] review/start ${runId} REFUSED by the honesty gate: ${gate.problems.join(", ")}.`
        );
        this.emitChangeReviewEvent({
          runId,
          type: "error",
          message: `review result failed the contract honesty gate: ${gate.problems.join(", ")}`
        });
        return;
      }
      if (review.runId !== runId) {
        this.markRunTerminal(runId, "failed");
        this.emitChangeReviewEvent({
          runId,
          type: "error",
          message: `review runner returned a review bound to a different run id ('${review.runId}' \u2260 '${runId}') \u2014 refused (one runId end-to-end)`
        });
        return;
      }
      this.markRunTerminal(runId, "completed");
      this.emitChangeReviewEvent({ runId, type: "result", review });
      this.logLine(
        `[bridge-server] review/start ${runId} \u2192 verdict ${review.verdict.overall} (${review.findings.items.length} advisory finding(s), parseStatus=${review.findings.parseStatus}).`
      );
    } catch (err) {
      if (this.runs.get(runId)?.buildTerminal === true) {
        this.logLine(`[bridge-server] review/start ${runId} threw after cancel; suppressing error.`);
        return;
      }
      this.markRunTerminal(runId, "failed");
      this.logLine(
        `[bridge-server] review/start ${runId} failed: ${String(err?.message ?? err)}`
      );
      this.emitChangeReviewEvent({
        runId,
        type: "error",
        message: `change review failed: ${String(err?.message ?? err)}`
      });
    }
  }
  /** Emit one review/event notification (no id) carrying a {@link ChangeReviewStreamEvent}. */
  emitChangeReviewEvent(event) {
    const note = {
      glyphstudio: BRIDGE_JSONRPC,
      method: BridgeNotification.ChangeReviewEvent,
      params: event
    };
    this.emit(note);
  }
  /* ============================================================== *
   * BUILD PLAN RPC (#8 — "Plan & Build (Governed)")
   * ============================================================== */
  /**
   * plan/start — START a GOVERNED PLAN RUN and STREAM it as `plan/event`
   * notifications, then PARK the run awaiting the user's approve/reject. Mirrors
   * `review/start`'s shape exactly (handshake gate → synchronous ack `{runId}` →
   * streamed events → ONE terminal result/error), with the park replacing the
   * review's terminal close.
   *
   * NO APPROVAL MODAL (frozen director decision — the same rule documented on
   * `review/start`). Plan generation is READ-ONLY over the repo: ONE governed
   * model turn that edits nothing and runs nothing. Friction follows authority,
   * and planning grants none, so no authority gate interposes BEFORE planning.
   * The authority gate is NOT skipped — it fires at `build/start`, exactly as it
   * does for a plan-less build (a plan is advisory provenance, never authority
   * and never assurance). The invocation is recorded honestly in the run's
   * hash-chained trace: this handler appends the `plan_proposed` event itself.
   *
   * THE RUNNER IS INJECTED (`BuildPlanConfig.runner`, mirroring
   * `ChangeReviewConfig.runner`): Track A's real governed plan runner binds in
   * the integration slice. Until a runner is configured, this handler answers
   * with an honest JSON-RPC error ("plan runner not wired") BEFORE acking — it
   * never fabricates a plan and never dies silently.
   *
   * HONESTY GATE: the runner's returned {@link BuildPlanProposal} is validated
   * before it streams — runId binding (one id end-to-end), the `advisory: true`
   * literal, a known parseStatus, and (for parseStatus 'ok') a plan that passes
   * {@link assertBuildPlanWellFormed}. A malformed/over-cap proposal becomes a
   * terminal `error` event (with the gate's problem tags) and the run is NOT
   * parked — never a rendered, approvable result.
   *
   * PARK + RESUME (the PendingBuild idiom): on success the handler appends
   * `plan_proposed` to the run's hash-chained trace, registers a {@link ParkedPlan}
   * (holding the run dir, trace path, and the LIVE trace writer — also registered
   * in `remoteTraceWriters`, the same keep-the-writer registry `runApprovedBuild`
   * reuses), and emits the terminal `result`. The run stays REGISTERED and
   * NON-TERMINAL: it resolves via `build/start` (same runId + planApproval →
   * `plan_approved` → the EXISTING approved-build execution on the SAME trace),
   * `plan/reject` (→ `plan_rejected`, honest close), or `run/cancel`.
   *
   * CANCELLATION: the run registers in the SAME generic run registry `run/cancel`
   * uses and is marked `planRun: true`, so a cancel's terminal aborted/error
   * markers are emitted as honest `plan/event`s (the stream this run's client
   * listens on) — the exact stream-mismatch bug #7 fixed post-hoc in 770ebf1,
   * handled up front here.
   */
  async handleBuildPlanStart(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "plan/start before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (cwd.length === 0) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "plan/start requires a non-empty absolute cwd (the git repo to plan against)"
        )
      );
      return;
    }
    const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
    if (prompt.length === 0) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "plan/start requires a non-empty prompt (the task to plan)"
        )
      );
      return;
    }
    const runner = this.plan?.runner;
    if (!runner) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "plan runner not wired \u2014 this supervisor build has no build-plan runner configured (the governed plan runner binds in the integration slice)"
        )
      );
      return;
    }
    const runId = `plan-${++this.planSeq}`;
    const ack = { runId };
    this.emit(this.successResponse(req.id, ack));
    const abort = new AbortController();
    try {
      const created = createRun(this.plan?.runsBaseDir ?? this.runsBaseDir);
      const planRun = { runId, dir: created.dir, state: created.state };
      const tracePath = join17(runSubdirPath(planRun.dir, "trace"), "trace.jsonl");
      const sink = createTraceWriter(tracePath);
      this.remoteTraceWriters.set(runId, sink);
      this.remoteTracePaths.set(runId, tracePath);
      const planLifecycle = new RunLifecycle(planRun.state);
      const planServerRun = {
        created: planRun,
        lifecycle: planLifecycle,
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
        buildAbort: abort,
        // Mark the run as a PLAN so run/cancel's terminal markers ride the
        // plan/event stream (the stream this run's client listens on).
        planRun: true
      };
      this.runs.set(runId, planServerRun);
      this.emitBuildPlanEvent({ runId, type: "state", state: "plan_started" });
      this.logLine(`[bridge-server] plan/start ${runId} (cwd=${cwd}).`);
      const proposal = await runner({
        cwd,
        prompt,
        existingRun: { runId, tracePath, sink },
        signal: abort.signal,
        emit: (state) => this.emitBuildPlanEvent({ runId, type: "state", state }),
        onOperatorLog: (line) => this.logLine(`[bridge-server] [plan ${runId}] ${line}`)
      });
      if (this.runs.get(runId)?.buildTerminal === true) {
        this.logLine(`[bridge-server] plan/start ${runId} was cancelled mid-flight; suppressing result.`);
        return;
      }
      const refuse = (message) => {
        this.markRunTerminal(runId, "failed");
        this.logLine(`[bridge-server] plan/start ${runId} REFUSED: ${message}`);
        this.emitBuildPlanEvent({ runId, type: "error", message });
      };
      if (proposal.runId !== runId) {
        refuse(
          `plan runner returned a proposal bound to a different run id ('${proposal.runId}' \u2260 '${runId}') \u2014 refused (one runId end-to-end)`
        );
        return;
      }
      if (proposal.advisory !== true) {
        refuse("plan proposal failed the contract gate: advisory must be the literal true");
        return;
      }
      if (!PLAN_PARSE_STATUSES.includes(proposal.parseStatus)) {
        refuse(
          `plan proposal failed the contract gate: unknown parseStatus ${JSON.stringify(proposal.parseStatus ?? null)}`
        );
        return;
      }
      if (proposal.parseStatus === "ok") {
        try {
          assertBuildPlanWellFormed(proposal.plan);
        } catch (gateErr) {
          refuse(
            `plan proposal failed the contract gate: ${String(gateErr?.message ?? gateErr)}`
          );
          return;
        }
      } else if (proposal.plan !== void 0) {
        refuse(
          `plan proposal failed the contract gate: parseStatus '${proposal.parseStatus}' must not carry a plan`
        );
        return;
      }
      const runnerRecordedProposal = readTrace(tracePath).some(
        (t) => t.type === "plan_proposed"
      );
      if (!runnerRecordedProposal) {
        const proposed = {
          actor: "codex",
          advisory: true,
          parseStatus: proposal.parseStatus,
          ...proposal.reason ? { reason: proposal.reason } : {},
          ...proposal.plan ? { plan: proposal.plan } : {}
        };
        sink.append({
          v: TRACE_EVENT_VERSION,
          runId,
          seq: 0,
          ts: Date.now(),
          type: "plan_proposed",
          payload: proposed,
          source: "supervisor"
        });
      }
      if (proposal.plan) {
        this.emitBuildPlanEvent({ runId, type: "plan", plan: proposal.plan });
      }
      this.parkedPlans.set(runId, {
        runId,
        proposal,
        cwd,
        prompt,
        runDir: planRun.dir,
        tracePath,
        sink
      });
      this.emitBuildPlanEvent({ runId, type: "result", proposal });
      this.logLine(
        `[bridge-server] plan/start ${runId} \u2192 PARKED (parseStatus=${proposal.parseStatus}, ${proposal.plan ? `${proposal.plan.steps.length} step(s)` : "no plan"}).`
      );
    } catch (err) {
      if (this.runs.get(runId)?.buildTerminal === true) {
        this.logLine(`[bridge-server] plan/start ${runId} threw after cancel; suppressing error.`);
        return;
      }
      this.markRunTerminal(runId, "failed");
      this.logLine(
        `[bridge-server] plan/start ${runId} failed: ${String(err?.message ?? err)}`
      );
      this.emitBuildPlanEvent({
        runId,
        type: "error",
        message: `plan run failed: ${String(err?.message ?? err)}`
      });
    }
  }
  /**
   * plan/reject — REJECT a PARKED plan run (#8). Appends the `plan_rejected`
   * trace event (with the optional non-secret reason) to the SAME hash-chained
   * trace that holds `plan_proposed`, closes the run honestly (a terminal
   * plan/event marker — the rejection is visible on the stream, never silent),
   * and acks `{ runId, rejected: true }`. An unknown/unparked runId is a
   * SPECIFIC JSON-RPC error: rejecting a run that is not parked is a caller bug
   * worth surfacing, not an idempotent no-op.
   */
  handleBuildPlanReject(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "plan/reject before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const runId = typeof params.runId === "string" ? params.runId.trim() : "";
    if (runId.length === 0) {
      this.emit(
        this.errorResponse(req.id, BridgeErrorCode.InvalidRequest, "plan/reject requires a non-empty runId")
      );
      return;
    }
    const parked = this.parkedPlans.get(runId);
    if (!parked) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `plan/reject: '${runId}' is not a parked plan run (already resolved, cancelled, or never parked)`
        )
      );
      return;
    }
    this.parkedPlans.delete(runId);
    const reason = typeof params.reason === "string" && params.reason.trim().length > 0 ? params.reason.trim() : void 0;
    const rejected = {
      approvalId: `plan-apr-${runId}`,
      ...reason ? { reason } : {}
    };
    parked.sink.append({
      v: TRACE_EVENT_VERSION,
      runId,
      seq: 0,
      ts: Date.now(),
      type: "plan_rejected",
      payload: rejected,
      source: "supervisor"
    });
    this.markRunTerminal(runId, "completed");
    this.emitBuildPlanEvent({ runId, type: "state", state: "rejected" });
    this.logLine(`[bridge-server] plan/reject ${runId} \u2192 plan_rejected recorded; run closed.`);
    const ack = { runId, rejected: true };
    this.emit(this.successResponse(req.id, ack));
  }
  /** Emit one plan/event notification (no id) carrying a {@link BuildPlanStreamEvent}. */
  emitBuildPlanEvent(event) {
    const note = {
      glyphstudio: BRIDGE_JSONRPC,
      method: BridgeNotification.BuildPlanEvent,
      params: event
    };
    this.emit(note);
  }
  /**
   * run/cancel — ABORT an in-flight run (remote-control). The supervisor signals the
   * run's AbortController (SIGKILLing the agentic build's `codex exec` child via
   * runAgenticBuild's abort listener; stopping a change review's findings turn /
   * inline check), transitions the lifecycle to the terminal `aborted` state, and
   * emits the terminal aborted/error markers on the run's OWN stream — `build/event`
   * for a build, `review/event` for a change review (`reviewRun:true`). Idempotent:
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
    const run2 = this.runs.get(runId);
    if (!run2 || run2.buildTerminal === true || run2.buildAbort === void 0) {
      this.emit(this.successResponse(req.id, { runId, cancelled: false }));
      return;
    }
    const controller = run2.buildAbort;
    const isReview = run2.reviewRun === true;
    const isPlan = run2.planRun === true;
    this.markRunTerminal(runId, "aborted");
    try {
      controller.abort();
    } catch {
    }
    if (isPlan) {
      this.parkedPlans.delete(runId);
      this.emitBuildPlanEvent({ runId, type: "state", state: "aborted" });
      this.emitBuildPlanEvent({ runId, type: "error", message: "run cancelled by operator" });
    } else if (isReview) {
      this.emitChangeReviewEvent({ runId, type: "state", state: "aborted" });
      this.emitChangeReviewEvent({ runId, type: "error", message: "run cancelled by operator" });
    } else {
      this.emitAgenticBuildEvent({ runId, type: "state", state: "aborted" });
      this.emitAgenticBuildEvent({ runId, type: "error", message: "run cancelled by operator" });
    }
    this.logLine(`[bridge-server] run/cancel ${runId} \u2192 aborted.`);
    this.emit(this.successResponse(req.id, { runId, cancelled: true }));
  }
  /* ============================================================== *
   * CODE-INDEX RETRIEVAL (@Codebase repo-aware retrieval)
   * ============================================================== */
  /**
   * The DEFAULT embedder for `index/retrieve`: the injected `index.embedder` if present,
   * else a lazily-constructed, REUSED loopback {@link OllamaEmbedder}. Constructing it
   * once (not per request) means the index for a workspace is always built + queried
   * with the SAME embedder (a different embedder/model would produce incompatible
   * vectors against a cached store).
   */
  resolveEmbedder() {
    if (this.index?.embedder) return this.index.embedder;
    if (!this.defaultEmbedder) {
      this.defaultEmbedder = new OllamaEmbedder();
    }
    return this.defaultEmbedder;
  }
  /**
   * Get-or-build the LOCAL code index for a workspace. The vector store, the BM25
   * keyword index, and the in-flight build promise are cached per absolute
   * workspaceRoot so the HYBRID index is built EXACTLY ONCE and concurrent retrievals
   * (and the chat warm-up) de-dupe onto the same `built` promise rather than
   * triggering parallel builds. The keyword index is populated ALONGSIDE the vector
   * store in the SAME buildIndex call (one pass over the fresh chunks), so they stay
   * in lockstep. Memory-only residency: nothing is persisted by this seam. The caller
   * awaits `built` before querying either structure.
   */
  /**
   * Canonicalize a requested directory path to its REAL absolute path, or return
   * `undefined` when it does not exist / is not a directory / cannot be resolved.
   * Resolve-then-realpath collapses `..`/symlinks so a path-escape (`/repo/../etc`)
   * or a symlink out of the workspace canonicalizes to its true target and is then
   * compared against the pinned session root — it cannot smuggle a different
   * directory past the equality check. Resolve-never-throw: any fs error (ENOENT,
   * EACCES, ENOTDIR) yields `undefined`, which the caller maps to a refusal WITHOUT
   * reading the path.
   */
  canonicalDir(requested) {
    try {
      const real = realpathSync(resolve4(requested));
      if (!statSync4(real).isDirectory()) return void 0;
      return real;
    } catch {
      return void 0;
    }
  }
  /**
   * Resolve + ENFORCE the index/disclosure boundary for a requested `workspaceRoot`,
   * shared by `index/retrieve` and `index/build` so they bind to the SAME session root by
   * the SAME machinery. On success returns the canonical (realpath'd) root; otherwise a
   * short non-secret refusal reason WITHOUT reading the requested root:
   *   - empty/missing → refused;
   *   - non-existent / not a directory → refused;
   *   - no session root yet bound → PIN this canonical root (the legitimate extension's
   *     warm-up), then enforce it for every later call;
   *   - a canonical root that differs from the bound session root → refused (cross-root).
   * The caller MUST have already passed the completed-handshake gate.
   */
  bindSessionRoot(requestedRaw, surface) {
    const workspaceRoot = typeof requestedRaw === "string" ? requestedRaw.trim() : "";
    if (workspaceRoot.length === 0) {
      return { ok: false, reason: `${surface} requires a non-empty workspaceRoot` };
    }
    const canonicalRoot = this.canonicalDir(workspaceRoot);
    if (!canonicalRoot) {
      return { ok: false, reason: `${surface} workspaceRoot does not exist or is not a directory` };
    }
    if (this.sessionWorkspaceRoots.size === 0) {
      this.sessionWorkspaceRoots.add(canonicalRoot);
      this.logLine(`[bridge-server] session workspace root pinned from first ${surface}: ${canonicalRoot}`);
      return { ok: true, root: canonicalRoot };
    }
    if (!this.sessionWorkspaceRoots.has(canonicalRoot)) {
      this.logLine(
        `[bridge-server] ${surface} refused: requested root resolves outside the session workspace (bound to a different directory).`
      );
      return { ok: false, reason: `${surface} workspaceRoot is not the session workspace root` };
    }
    return { ok: true, root: canonicalRoot };
  }
  /**
   * The session's PRIMARY workspace root: the FIRST root bound into
   * {@link sessionWorkspaceRoots} (Set preserves insertion order), or undefined when
   * none is bound yet. Single-root sessions behave exactly as before (the one bound
   * root IS the primary); used where one representative root is needed (mcp/call's
   * lazy broker establishment).
   */
  primarySessionRoot() {
    for (const root of this.sessionWorkspaceRoots) return root;
    return void 0;
  }
  /**
   * Resolve the residency policy for an index build on `workspaceRoot`. Default is the
   * memory-only (no-disk) posture (today's behavior). When `persist` is true (the
   * `glyphstudio.index.persist` setting flowing through `index/build`'s params), build with
   * the 'workspace-encrypted' residency so the index survives a session restart as an
   * encrypted, workspace-LOCAL snapshot (index-residency.ts refuses any path outside the
   * workspace, and the build refuses to persist without the per-workspace AES key).
   */
  indexResidencyFor(workspaceRoot, persist) {
    return persist ? { residency: "workspace-encrypted", highSecurity: false, workspaceRoot } : { residency: "memory-only", highSecurity: false };
  }
  /**
   * Build the ONE shared per-workspace index (fresh store + keyword index) under the
   * given residency, cache it keyed by canonical workspaceRoot, and return the entry
   * whose `built` resolves with the build's {@link IndexStats}. The SAME entry backs
   * `index/build`, `index/retrieve`, and repo-aware FIM — there is exactly one index per
   * workspace (never a parallel one). `forSurface` only labels the operator log line.
   */
  /**
   * Resolve the effective vector-store kind for a build: an explicit per-request kind
   * (validated) wins; else the supervisor's configured default; else the module default.
   * Always lands on a valid kind ('brute' fallback is always available).
   */
  resolveStoreKind(requested) {
    if (requested !== void 0) {
      return resolveVectorStoreKind(requested);
    }
    return this.index?.defaultVectorStore ?? DEFAULT_VECTOR_STORE_KIND;
  }
  startIndexBuild(workspaceRoot, embedder, residency, forSurface, onProgress, storeKind = this.resolveStoreKind()) {
    const store = createVectorStore(storeKind);
    const keywordIndex = new BM25KeywordIndex();
    const built = buildIndex({
      workspaceRoot,
      embedder,
      store,
      keywordIndex,
      residency,
      ...this.index?.keyDir ? { keyDir: this.index.keyDir } : {},
      // STREAM PROGRESS (index/build only — index/retrieve's lazy build passes no
      // sink). The indexer's progress tick shape IS the wire event shape, so we
      // forward it straight through to the per-request `onProgress`.
      ...onProgress ? { onProgress } : {}
    }).then((stats) => {
      this.logLine(
        `[bridge-server] ${forSurface} built local hybrid index for ${workspaceRoot}: ${stats.files} files, ${stats.chunks} chunks (embedded ${stats.embedded}, reused ${stats.reused}, residency ${stats.residency}, embedder ${stats.embedderId}, vectorStore ${storeKind}, keyword ${keywordIndex.size} chunks).`
      );
      return stats;
    });
    const entry = { store, keywordIndex, built };
    this.indexStores.set(workspaceRoot, entry);
    return entry;
  }
  getOrBuildIndex(workspaceRoot, embedder, residency = { residency: "memory-only", highSecurity: false }, storeKind = this.resolveStoreKind()) {
    const existing = this.indexStores.get(workspaceRoot);
    if (existing) return existing;
    return this.startIndexBuild(workspaceRoot, embedder, residency, "index/retrieve", void 0, storeKind);
  }
  /**
   * index/retrieve — fetch top-k repo chunks from the workspace's LOCAL code index for
   * repo-aware chat context (@Codebase). Lazily builds the on-device index for the
   * SESSION'S OWN workspace on first use (de-duped per workspace), embeds the query
   * with the SAME local embedder, and returns the top-k cosine-similar chunks.
   *
   * SECURITY — INDEX/DISCLOSURE BOUNDARY (the load-bearing rule). This method reads
   * source files and returns chunk TEXT, so it MUST only ever index/read the
   * FIRST-PARTY SESSION'S OWN workspace, and only AFTER a completed handshake. Two
   * gates run BEFORE any discovery / file read / embed:
   *   1. COMPLETED-HANDSHAKE GATE. Pre-handshake → `{ ok:false, hits:[] }`, no read.
   *   2. SESSION-ROOT BINDING. The requested `workspaceRoot` is canonicalized (realpath,
   *      collapsing `..`/symlinks) and must EQUAL the session's bound root:
   *        - PREFERRED: the root pinned from the trusted handshake channel; or
   *        - FALLBACK: the root pinned from the FIRST post-handshake retrieve (the
   *          legitimate extension's warm-up), then enforced for every later call.
   *      A request that does not exist / is not a directory, or whose canonical root
   *      differs from the bound root → `{ ok:false, hits:[] }` WITHOUT indexing,
   *      reading, or embedding that root.
   *      MULTI-ROOT (additive `workspaceRoots`): every entry must canonicalize AND be
   *      a member of the session's bound root SET (handshake-bound) — any failure
   *      refuses the WHOLE call (fail-closed). Per-root retrieval is merged by
   *      RANK-INTERLEAVE (round-robin in params order, capped at k) and each hit
   *      carries the additive `workspaceRoot` it came from.
   *
   * BEST-EFFORT / NON-FATAL: retrieval must NEVER crash chat. On ANY error — a refusal
   * above, the embedder daemon down, a build failure — the result is `{ ok:false,
   * hits:[] }` with a short non-secret `error`, so the chat turn proceeds with NO repo
   * context instead of failing. Nothing here egresses code (the index path is local by
   * construction); the result carries non-secret repo snippets, no credential.
   */
  async handleIndexRetrieve(req) {
    const fail2 = (error) => {
      const result = { ok: false, hits: [], error };
      this.emit(this.successResponse(req.id, result));
    };
    try {
      if (!this.handshakeDone) {
        fail2("index/retrieve before a completed handshake");
        return;
      }
      const params = req.params ?? {};
      const query = typeof params.query === "string" ? params.query : "";
      const multiRequested = Array.isArray(params.workspaceRoots) && params.workspaceRoots.length > 0;
      const canonicalRoots = [];
      if (multiRequested) {
        for (const requested of params.workspaceRoots) {
          const raw = typeof requested === "string" ? requested.trim() : "";
          if (raw.length === 0) {
            fail2("index/retrieve workspaceRoots entries must be non-empty strings");
            return;
          }
          const canonical = this.canonicalDir(raw);
          if (!canonical) {
            fail2("index/retrieve workspaceRoots entry does not exist or is not a directory");
            return;
          }
          if (!this.sessionWorkspaceRoots.has(canonical)) {
            this.logLine(
              `[bridge-server] index/retrieve refused: a requested root resolves outside the session workspace (not a bound session root).`
            );
            fail2("index/retrieve workspaceRoots entry is not a session workspace root");
            return;
          }
          if (!canonicalRoots.includes(canonical)) canonicalRoots.push(canonical);
        }
      } else {
        const bound = this.bindSessionRoot(params.workspaceRoot, "index/retrieve");
        if (!bound.ok) {
          fail2(bound.reason);
          return;
        }
        canonicalRoots.push(bound.root);
      }
      if (query.trim().length === 0) {
        this.emit(this.successResponse(req.id, { ok: true, hits: [] }));
        return;
      }
      const k = typeof params.k === "number" && Number.isFinite(params.k) && params.k > 0 ? Math.floor(params.k) : this.index?.defaultK ?? DEFAULT_INDEX_RETRIEVE_K;
      const embedder = this.resolveEmbedder();
      const storeKind = this.resolveStoreKind(params.vectorStore);
      const perRootHits = await Promise.all(
        canonicalRoots.map(async (root) => {
          const entry = this.getOrBuildIndex(root, embedder, void 0, storeKind);
          await entry.built;
          const hits = await retrieve({
            query,
            embedder,
            store: entry.store,
            keywordIndex: entry.keywordIndex,
            k
          });
          return hits.map((h) => ({
            path: h.chunk.path,
            startLine: h.chunk.startLine,
            endLine: h.chunk.endLine,
            text: h.chunk.text,
            score: h.score,
            // Display cosine for the citation UI; fall back to score (vector-only path
            // already has relevance == cosine, so the ?? only fires if it's unset).
            relevance: h.relevance ?? h.score,
            // MULTI-ROOT ONLY: name the canonical root each hit came from so the
            // consumer can resolve the workspace-relative path. Single-root responses
            // stay byte-for-byte unchanged (no field).
            ...multiRequested ? { workspaceRoot: root } : {}
          }));
        })
      );
      const merged = [];
      const longest = Math.max(...perRootHits.map((l) => l.length));
      outer: for (let rank = 0; rank < longest; rank++) {
        for (const list of perRootHits) {
          if (rank >= list.length) continue;
          merged.push(list[rank]);
          if (merged.length >= k) break outer;
        }
      }
      const result = { ok: true, hits: merged };
      this.logLine(
        `[bridge-server] index/retrieve ${canonicalRoots.join(", ")}: ${result.hits.length} hit(s) for query (len ${query.length}).`
      );
      this.emit(this.successResponse(req.id, result));
    } catch (err) {
      const message = String(err?.message ?? err);
      const p = req.params;
      const rawRoots = [];
      if (typeof p?.workspaceRoot === "string") rawRoots.push(p.workspaceRoot.trim());
      if (Array.isArray(p?.workspaceRoots)) {
        for (const r of p.workspaceRoots) {
          if (typeof r === "string") rawRoots.push(r.trim());
        }
      }
      for (const raw of rawRoots) {
        const wsRoot = raw ? this.canonicalDir(raw) : void 0;
        if (wsRoot) this.indexStores.delete(wsRoot);
      }
      this.logLine(`[bridge-server] index/retrieve failed (non-fatal): ${message}`);
      fail2(`index/retrieve failed: ${message}`);
    }
  }
  /**
   * index/build — BUILD (or rebuild) the SESSION'S OWN local code index on demand (the
   * no-CLI "Index Workspace" command). It shares the SAME per-workspace server-side index
   * `index/retrieve` + repo-aware FIM use (never a parallel one): it builds a FRESH store
   * + keyword index, caches it keyed by the canonical session root (replacing any prior
   * cached index so a reindex is a true rebuild), and returns the build {@link IndexStats}
   * the command surfaces as a toast / status-bar label.
   *
   * SECURITY — the SAME index/disclosure boundary as `index/retrieve`:
   *   1. COMPLETED-HANDSHAKE GATE. Pre-handshake → `{ ok:false }`, no read.
   *   2. SESSION-ROOT BINDING (the shared {@link bindSessionRoot}). The requested
   *      `workspaceRoot` is canonicalized and must equal the session's bound root; a
   *      cross-root / missing / non-dir request is refused WITHOUT reading it.
   *
   * RESIDENCY. `persist` (the `glyphstudio.index.persist` setting carried in the params)
   * selects the residency: default false → memory-only (today's no-disk behavior); true →
   * 'workspace-encrypted' (an encrypted, workspace-local snapshot under
   * <workspaceRoot>/.glyphstudio/index that survives a session restart).
   *
   * BEST-EFFORT / NON-FATAL: never throws. On ANY error (a refusal above, the embedder
   * daemon down, a build failure) the result is `{ ok:false, error }`; the poisoned cache
   * entry is dropped so a later build can retry. Nothing here egresses code; the result
   * carries only non-secret build COUNTS, no credential.
   */
  async handleIndexBuild(req) {
    const fail2 = (error) => {
      const result = { ok: false, error };
      this.emit(this.successResponse(req.id, result));
    };
    let canonicalRoot;
    try {
      if (!this.handshakeDone) {
        fail2("index/build before a completed handshake");
        return;
      }
      const params = req.params ?? {};
      const bound = this.bindSessionRoot(params.workspaceRoot, "index/build");
      if (!bound.ok) {
        fail2(bound.reason);
        return;
      }
      canonicalRoot = bound.root;
      const persist = params.persist === true;
      const residency = this.indexResidencyFor(canonicalRoot, persist);
      const embedder = this.resolveEmbedder();
      const storeKind = this.resolveStoreKind(params.vectorStore);
      this.indexStores.delete(canonicalRoot);
      const entry = this.startIndexBuild(
        canonicalRoot,
        embedder,
        residency,
        "index/build",
        (p) => this.emitIndexProgress(p),
        storeKind
      );
      const stats = await entry.built;
      const result = {
        ok: true,
        stats: {
          files: stats.files,
          chunks: stats.chunks,
          embedded: stats.embedded,
          reused: stats.reused,
          embedMs: stats.embedMs,
          totalMs: stats.totalMs,
          embedderId: stats.embedderId,
          residency: stats.residency
        }
      };
      this.logLine(
        `[bridge-server] index/build ${canonicalRoot}: ${stats.files} files, ${stats.chunks} chunks (persist=${persist}, residency ${stats.residency}).`
      );
      this.emit(this.successResponse(req.id, result));
    } catch (err) {
      const message = String(err?.message ?? err);
      if (canonicalRoot) this.indexStores.delete(canonicalRoot);
      this.logLine(`[bridge-server] index/build failed (non-fatal): ${message}`);
      fail2(`index/build failed: ${message}`);
    }
  }
  /**
   * index/update — INCREMENTALLY apply one debounced save/watch batch (the index-
   * freshness loop) to the session's ALREADY-BUILT local code index. Serialized
   * behind {@link indexUpdateTail} so batches never interleave store mutations.
   *
   * SECURITY — the SAME index/disclosure boundary as `index/retrieve`/`index/build`:
   *   1. COMPLETED-HANDSHAKE GATE. Pre-handshake → `{ ok:false }`, no read.
   *   2. SESSION-ROOT BINDING (the shared {@link bindSessionRoot}); a cross-root /
   *      missing / non-dir request is refused WITHOUT reading anything.
   *   3. NO COLD BUILD: only an EXISTING per-workspace index is updated. No index
   *      yet (or a residency-'disabled' build) → honest refusal, zero file reads —
   *      this RPC can never be used to make the supervisor index a workspace the
   *      user did not ask to index.
   *   4. The batch paths are filtered SUPERVISOR-SIDE through the SAME discovery
   *      gates a full build uses (updateIndex → discover.filterIndexablePaths):
   *      hard secret denylist, root .gitignore/.glyphstudioignore, text-source
   *      allowlist, size/binary caps, symlink/containment rules. A saved `.env`
   *      can never enter the index through the freshness side door.
   *
   * BEST-EFFORT / NON-FATAL: never throws. On ANY error the result is
   * `{ ok:false, error }` and the CACHED INDEX IS KEPT (unlike a failed full build
   * there is no poisoned build promise — the store still holds the last good state
   * and the next save batch simply retries). Nothing egresses code; the result
   * carries only non-secret COUNTS, never a credential and never file text.
   */
  async handleIndexUpdate(req) {
    const fail2 = (error) => {
      const result = { ok: false, error };
      this.emit(this.successResponse(req.id, result));
    };
    const run2 = this.indexUpdateTail.then(async () => {
      try {
        if (!this.handshakeDone) {
          fail2("index/update before a completed handshake");
          return;
        }
        const params = req.params ?? {};
        const bound = this.bindSessionRoot(params.workspaceRoot, "index/update");
        if (!bound.ok) {
          fail2(bound.reason);
          return;
        }
        const canonicalRoot = bound.root;
        const changed = sanitizeRelPathBatch(params.changed);
        const deleted = sanitizeRelPathBatch(params.deleted);
        if (changed.length === 0 && deleted.length === 0) {
          const result2 = {
            ok: true,
            stats: { files: 0, ignored: 0, embedded: 0, reused: 0, evictedPaths: 0, embedMs: 0, totalMs: 0 }
          };
          this.emit(this.successResponse(req.id, result2));
          return;
        }
        const entry = this.indexStores.get(canonicalRoot);
        if (!entry) {
          fail2("index/update: no index has been built for this session yet");
          return;
        }
        const builtStats = await entry.built;
        if (builtStats.residency === "disabled") {
          fail2("index/update: index residency is disabled for this workspace");
          return;
        }
        const embedder = this.resolveEmbedder();
        const stats = await updateIndex({
          workspaceRoot: canonicalRoot,
          embedder,
          store: entry.store,
          keywordIndex: entry.keywordIndex,
          changedPaths: changed,
          deletedPaths: deleted
        });
        this.logLine(
          `[bridge-server] index/update ${canonicalRoot}: ${stats.files} file(s) re-indexed, ${stats.embedded} window(s) re-embedded, ${stats.reused} reused, ${stats.evictedPaths} path(s) evicted, ${stats.ignored} ignored (${stats.totalMs.toFixed(0)}ms).`
        );
        const result = { ok: true, stats };
        this.emit(this.successResponse(req.id, result));
      } catch (err) {
        const message = String(err?.message ?? err);
        this.logLine(`[bridge-server] index/update failed (non-fatal): ${message}`);
        fail2(`index/update failed: ${message}`);
      }
    });
    this.indexUpdateTail = run2.then(
      () => void 0,
      () => void 0
    );
    return run2;
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
    const streamToKnownRun = this.runs.has(targetRunId) || this.remoteTracePaths.has(targetRunId);
    const sink = this.remoteTraceWriterFor(targetRunId);
    const appended = sink.append({
      ...evt,
      runId: targetRunId,
      source: "human"
    });
    if (streamToKnownRun) {
      this.emitRunEventEnvelope({
        rev: RUN_EVENT_PROTOCOL_VERSION,
        runId: targetRunId,
        kind: "trace_event",
        event: appended
      });
    }
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
      tracePath = join17(runSubdirPath(created.dir, "trace"), "trace.jsonl");
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
   * Append ONE VALIDATED `steering_rules_applied` event to a governed run's
   * hash-chained trace (advise-vs-enforce slice) and mirror it to a live panel.
   *
   * BEST-EFFORT BY DESIGN: when no live chain head anchors the run (no terminal
   * session and no registered writer — e.g. an inline-edit turn with no governed
   * run), the append is SKIPPED with a logged line and nothing fails. Two live
   * append paths, never a second writer on the same file (a fork of the chain
   * head):
   *   - a run with a live {@link TerminalSession} (the governed chat session)
   *     appends through the session's OWN sink via `appendTraceEvent`, which
   *     also mirrors to the run/event stream;
   *   - a run with a registered `remoteTraceWriters` writer (the agentic-build /
   *     parked-plan idiom) appends through that writer, mirrored here with the
   *     same still-live gate `run/recordHuman` uses.
   *
   * TRUST POSTURE: the event is ADVISORY provenance of the steering layer — it
   * records what steering was SENT to the model. It NEVER claims the model
   * obeyed, it is NOT a policy decision, and the source is the supervisor
   * default (omitted), not 'human' / 'policy'.
   */
  appendSteeringToRun(runId, steering, context) {
    const run2 = this.runs.get(runId);
    let appended;
    try {
      const sessionAppend = run2?.terminalSession?.appendTraceEvent;
      if (sessionAppend) {
        appended = sessionAppend("steering_rules_applied", steering);
      } else {
        const live = this.remoteTraceWriters.get(runId);
        if (!live) {
          this.logLine(
            `[bridge-server] ${context}: steering provided but run '${runId}' has no live trace chain head \u2014 steering append skipped (best-effort by design).`
          );
          return void 0;
        }
        appended = live.append({
          v: TRACE_EVENT_VERSION,
          runId,
          seq: 0,
          // writer-authoritative
          ts: Date.now(),
          // writer-authoritative
          type: "steering_rules_applied",
          payload: steering
        });
        const stillLive = run2 !== void 0 && run2.buildTerminal !== true && !run2.lifecycle.isTerminal;
        if (stillLive) {
          this.emitRunEventEnvelope({
            rev: RUN_EVENT_PROTOCOL_VERSION,
            runId,
            kind: "trace_event",
            event: appended
          });
        }
      }
    } catch (err) {
      this.logLine(
        `[bridge-server] ${context}: steering append failed (turn/build unaffected): ${String(err?.message ?? err)}`
      );
      return void 0;
    }
    this.logLine(
      `[bridge-server] ${context}: steering_rules_applied \u2192 run ${runId} trace seq ${appended.seq} (surface=${steering.surface}, rules=${steering.rules.length}; advisory).`
    );
    return appended;
  }
  /**
   * run/recordHuman (#10 Slice 1) — append ONE HUMAN-ORIGIN event (diff
   * decision / checkpoint marker) to a run's hash-chained trace and return the
   * appended event's CHAIN POSITION ({ ok, seq, hash }) as evidence. This is
   * the RPC whose absence made the old "human_accepted recorded" notification
   * a hollow claim — the append is now real or HONESTLY refused.
   *
   * APPEND PATHS:
   *   - LIVE: the run's one registered `remoteTraceWriters` writer holds the
   *     chain head in memory — append through it (the recordRemoteAction /
   *     parked-plan idiom; the chain head never forks).
   *   - REHYDRATE: the run is closed (no live writer) — resolve its persisted
   *     trace.jsonl (the memoized `remoteTracePaths` entry, else derived from
   *     the run dir) and graft onto the validated chain tail via
   *     {@link rehydrateAppendHumanEvent}.
   *
   * TRUST POSTURE: `source` is FORCED to 'human' server-side on BOTH paths; the
   * payload is data-not-authority. REFUSALS are honest JSON-RPC errors with
   * DISTINCT messages (unknown runId/no trace file; unreadable/tamper-suspect
   * tail; over-cap payload; type outside the record-human set) — NEVER a
   * silent success.
   *
   * NOTIFICATION CHOICE: the appended event is ALSO emitted as a `run/event`
   * trace_event envelope IFF the run is still open (registered and
   * non-terminal) so a live Trust Panel renders it in stream order. A CLOSED
   * run gets NO notification — the append is durable in the trace file, and
   * that durability (not a transient toast) is the point; replay/inspection
   * surfaces read the file.
   */
  handleRecordHuman(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "run/recordHuman before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const runId = typeof params.runId === "string" ? params.runId.trim() : "";
    if (runId.length === 0) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "run/recordHuman requires a non-empty runId"
        )
      );
      return;
    }
    try {
      assertRecordHumanWellFormed(params.type, params.payload);
    } catch (err) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          String(err?.message ?? err)
        )
      );
      return;
    }
    const type = params.type;
    let appended;
    const live = this.remoteTraceWriters.get(runId);
    if (live) {
      try {
        appended = live.append({
          v: TRACE_EVENT_VERSION,
          runId,
          seq: 0,
          // writer-authoritative
          ts: Date.now(),
          // writer-authoritative
          type,
          payload: params.payload ?? {},
          source: "human"
          // FORCED server-side — never caller-supplied
        });
      } catch (err) {
        this.emit(
          this.errorResponse(
            req.id,
            BridgeErrorCode.InvalidRequest,
            `run/recordHuman failed to append to the live trace: ${String(err?.message ?? err)}`
          )
        );
        return;
      }
    } else {
      const run3 = this.runs.get(runId);
      let tracePath = this.remoteTracePaths.get(runId) ?? (run3 ? join17(runSubdirPath(run3.created.dir, "trace"), "trace.jsonl") : void 0);
      if (tracePath === void 0 && this.runsBaseDir !== void 0) {
        if (/^[A-Za-z0-9-]+$/.test(runId)) {
          const candidate = join17(this.runsBaseDir, runId, "trace", "trace.jsonl");
          if (existsSync9(candidate)) tracePath = candidate;
        }
      }
      if (tracePath === void 0) {
        this.emit(
          this.errorResponse(
            req.id,
            BridgeErrorCode.InvalidRequest,
            `run/recordHuman: unknown runId '${runId}' and no trace file \u2014 nothing to append to`
          )
        );
        return;
      }
      try {
        appended = rehydrateAppendHumanEvent(tracePath, {
          runId,
          type,
          payload: params.payload
        });
      } catch (err) {
        const message = err instanceof RecordHumanRefusal ? `run/recordHuman refused: ${err.message}` : `run/recordHuman failed: ${String(err?.message ?? err)}`;
        this.emit(this.errorResponse(req.id, BridgeErrorCode.InvalidRequest, message));
        return;
      }
    }
    const run2 = this.runs.get(runId);
    const stillLive = run2 !== void 0 && run2.buildTerminal !== true && !run2.lifecycle.isTerminal;
    if (stillLive) {
      this.emitRunEventEnvelope({
        rev: RUN_EVENT_PROTOCOL_VERSION,
        runId,
        kind: "trace_event",
        event: appended
      });
    }
    this.logLine(
      `[bridge-server] run/recordHuman ${type} \u2192 run ${runId} trace seq ${appended.seq} (source=human${stillLive ? "; streamed" : "; run closed \u2014 durable append only"}).`
    );
    const result = { ok: true, seq: appended.seq, hash: appended.hash };
    this.emit(this.successResponse(req.id, result));
  }
  /**
   * approval/respond — resolve a PENDING approval. Two kinds share this ONE RPC:
   *   - a PENDING governed-build approval (remote-control): on `allow`, GRANT the
   *     held build's authority and start it down the SAME approved path
   *     (`runApprovedBuild`) — governed codex edits files + the signed verdict
   *     streams; on `deny`, DISCARD the pending build (terminal `build/event`
   *     error, codex NOT spawned);
   *   - a HELD `mcp/call` whose policy decision was ask/force_ask (#9 Slice 2):
   *     the verdict settles the awaiting handler, which traces
   *     approval_approved/approval_denied and executes or refuses honestly.
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
    const pendingMcp = this.pendingMcpApprovals.get(approvalId);
    if (pendingMcp) {
      this.logLine(
        `[bridge-server] approval/respond ${approvalId} ${decision.toUpperCase()} \u2014 resolving held MCP call.`
      );
      pendingMcp(decision);
      this.emit(
        this.successResponse(req.id, { approvalId, decision, resolved: true })
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
    void this.runApprovedBuild(
      pending.runId,
      pending.prompt,
      pending.cwd,
      {
        runDir: pending.runDir,
        tracePath: pending.tracePath
      },
      pending.steering
    );
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
      glyphstudio: BRIDGE_JSONRPC,
      method: BridgeNotification.AgenticBuildEvent,
      params: event
    };
    this.emit(note);
  }
  /* ============================================================== *
   * MCP BROKERING RPC (#9 — governed MCP tool brokering, Slice 1)
   * ============================================================== */
  /**
   * Ensure the connection's MCP broker state exists for `root` (the pinned
   * session workspace root): load `.glyphstudio/mcp.json` and RECONCILE the
   * supervisor-owned server clients against it. Clients are LAZY (a client is
   * constructed here but its child is only spawned on first list/call), reused
   * across calls while their spec is unchanged, and REPLACED (old child
   * disposed) when a config edit changes their command/args/env. Clients whose
   * entry disappeared are disposed. Never throws — config problems surface as
   * honest per-entry/file errors.
   */
  ensureMcpBroker(root) {
    const loaded = loadMcpConfig(root);
    const prevClients = this.mcpBroker?.root === root ? this.mcpBroker.clients : void 0;
    if (this.mcpBroker && this.mcpBroker.root !== root) {
      for (const client of this.mcpBroker.clients.values()) void client.dispose();
    }
    const clients = /* @__PURE__ */ new Map();
    for (const entry of loaded.entries) {
      if (!entry.ok) continue;
      const spec = entry.spec;
      const specIdentity = JSON.stringify({ command: spec.command, args: spec.args, env: spec.env });
      const existing = prevClients?.get(entry.name);
      if (existing && existing.specIdentity === specIdentity) {
        clients.set(entry.name, existing);
        prevClients?.delete(entry.name);
        continue;
      }
      clients.set(
        entry.name,
        new McpStdioClient(spec, {
          ...this.mcp?.callTimeoutMs !== void 0 ? { callTimeoutMs: this.mcp.callTimeoutMs } : {},
          logLine: (line) => this.logLine(`[bridge-server] ${line}`)
        })
      );
    }
    if (prevClients) {
      for (const stale of prevClients.values()) void stale.dispose();
    }
    this.mcpBroker = {
      root,
      entries: loaded.entries,
      ...loaded.fileError !== void 0 ? { fileError: loaded.fileError } : {},
      clients
    };
    if (loaded.fileError) {
      this.logLine(`[bridge-server] mcp config error for ${root}: ${loaded.fileError}`);
    }
    return this.mcpBroker;
  }
  /**
   * mcp/list — report the brokered MCP servers + tools for the session
   * workspace's `.glyphstudio/mcp.json`, with an HONEST per-server status.
   *
   * NO POLICY GATE ON LISTING — deliberately. Listing is local config
   * introspection plus tool DISCOVERY: it executes no tool, mutates nothing,
   * and discloses only what the operator's own mcp.json configured (plus the
   * third-party server's self-reported tool names/schemas). The governed
   * boundary is per-CALL: every `tools/call` goes through decide() in
   * {@link handleMcpCall}. Honesty note: discovery DOES spawn the configured
   * server child (third-party code, under the sanitized PATH/HOME-only env) —
   * that is the unavoidable cost of asking a stdio server what tools it has,
   * and it is exactly what the operator opted into by writing the config entry.
   *
   * Session-bound like the index RPCs: the requested workspaceRoot must
   * resolve to the connection's pinned session root (bindSessionRoot).
   */
  async handleMcpList(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "mcp/list before a completed handshake"
        )
      );
      return;
    }
    const params = req.params ?? {};
    const bound = this.bindSessionRoot(params.workspaceRoot, "mcp/list");
    if (!bound.ok) {
      this.emit(this.errorResponse(req.id, BridgeErrorCode.InvalidRequest, bound.reason));
      return;
    }
    try {
      const broker = this.ensureMcpBroker(bound.root);
      const servers = [];
      for (const entry of broker.entries) {
        if (!entry.ok) {
          servers.push({ name: entry.name, status: "disabled", reason: entry.reason, tools: [] });
          continue;
        }
        const client = broker.clients.get(entry.name);
        if (!client) {
          servers.push({ name: entry.name, status: "disabled", reason: "no client (internal)", tools: [] });
          continue;
        }
        try {
          const listing = await client.listTools();
          const notes = [];
          if (entry.spec.ignoredKeys.length > 0) {
            notes.push(`ignored unsupported config field(s): ${entry.spec.ignoredKeys.join(", ")}`);
          }
          if (listing.droppedTools > 0) {
            notes.push(`${listing.droppedTools} tool(s) dropped at the cap gate`);
          }
          servers.push({
            name: entry.name,
            status: "ok",
            ...notes.length > 0 ? { reason: notes.join("; ") } : {},
            tools: listing.tools
          });
        } catch (err) {
          servers.push({
            name: entry.name,
            status: client.status,
            reason: client.statusReason ?? String(err?.message ?? err),
            tools: []
          });
        }
      }
      const result = { servers };
      this.emit(this.successResponse(req.id, result));
    } catch (err) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          `mcp/list failed: ${String(err?.message ?? err)}`
        )
      );
    }
  }
  /**
   * mcp/call — broker ONE MCP tool call (#9). The supervisor:
   *   1. RE-VALIDATES the wire shape with the contract gate
   *      {@link assertMcpCallWellFormed} (malformed → JSON-RPC error carrying
   *      the gate's dotted problem tags — never repaired);
   *   2. routes the call through decide() as tool kind 'mcp' with capability
   *      `mcp/<server>/<tool>` BEFORE anything reaches the third-party server.
   *      The request's provenance is 'user' (the first-party UI asks on the
   *      operator's behalf — the agent-loop dispatch default); the RESULT data
   *      is what carries the 'mcp' (UNTRUSTED) provenance label;
   *   3. TRACES with EXISTING event types only — policy_decision before
   *      execution, tool_start/tool_end around it — on the SAME hash-chained
   *      trace the connection's governed chat session uses (lazily opened via
   *      {@link ensureChatGovernedSession} exactly like chat/send; no session
   *      → the call is REFUSED with an honest error, never brokered untraced).
   *
   * Decision mapping (Slice 2 — the interactive approval flow is live):
   *   - allow      → execute via the server client; 'ok'/'error' honestly.
   *   - deny       → status 'denied' (an honest RESULT, not a JSON-RPC error).
   *   - ask / force_ask → the call is HELD ({@link awaitMcpApprovalVerdict}):
   *     approval_requested is appended/mirrored (the EXISTING event type — the
   *     extension renders the modal off the run/event mirror), and the handler
   *     awaits the operator's `approval/respond` verdict. Allow →
   *     approval_approved (source 'human') then execute EXACTLY like an
   *     up-front allow; deny → approval_denied (source 'human') + an honest
   *     'denied by operator' result; no verdict within
   *     {@link DEFAULT_MCP_APPROVAL_TIMEOUT_MS} (or the injected
   *     approvalTimeoutMs) → approval_denied + an honest timed-out 'denied'
   *     result. ZERO new trace event types.
   *   - any other decision verb → 'denied' (fail-closed, named honestly).
   */
  async handleMcpCall(req) {
    if (!this.handshakeDone) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          "mcp/call before a completed handshake"
        )
      );
      return;
    }
    let call;
    try {
      assertMcpCallWellFormed(req.params);
      call = req.params;
    } catch (gateErr) {
      this.emit(
        this.errorResponse(
          req.id,
          BridgeErrorCode.InvalidRequest,
          String(gateErr?.message ?? gateErr)
        )
      );
      return;
    }
    const respond = (result) => {
      this.emit(this.successResponse(req.id, result));
    };
    try {
      let broker = this.mcpBroker;
      if (!broker) {
        const primaryRoot = this.primarySessionRoot();
        if (!primaryRoot) {
          respond({
            status: "error",
            reason: "no MCP configuration is loaded for this session \u2014 call mcp/list first"
          });
          return;
        }
        broker = this.ensureMcpBroker(primaryRoot);
      }
      const entry = broker.entries.find((e) => e.name === call.server);
      if (!entry) {
        respond({
          status: "error",
          reason: `unknown MCP server '${call.server}' (not in .glyphstudio/mcp.json)`
        });
        return;
      }
      if (!entry.ok) {
        respond({ status: "error", reason: `server '${call.server}' is disabled: ${entry.reason}` });
        return;
      }
      const client = broker.clients.get(call.server);
      if (!client) {
        respond({ status: "error", reason: `server '${call.server}' has no client (internal)` });
        return;
      }
      const governed = await this.ensureChatGovernedSession();
      if (!governed || !this.runs.has(governed.runId)) {
        respond({
          status: "error",
          reason: "could not open a governed session (run + hash-chained trace) \u2014 refusing to broker an untraced MCP call"
        });
        return;
      }
      const runId = governed.runId;
      const run2 = this.runs.get(runId);
      const tracePath = run2?.created?.dir ? join17(runSubdirPath(run2.created.dir, "trace"), "trace.jsonl") : void 0;
      if (!tracePath) {
        respond({
          status: "error",
          reason: "governed session has no trace path \u2014 refusing to broker an untraced MCP call"
        });
        return;
      }
      const sink = createTraceWriter(tracePath);
      const appendAndMirror = (type, payload, source) => {
        const appended = sink.append({
          v: TRACE_EVENT_VERSION,
          runId,
          seq: 0,
          ts: Date.now(),
          type,
          payload,
          ...source !== void 0 ? { source } : {}
        });
        this.emitRunEventEnvelope({
          rev: RUN_EVENT_PROTOCOL_VERSION,
          runId,
          kind: "trace_event",
          event: appended
        });
      };
      const policy = this.mcp?.policy ?? DEFAULT_MCP_POLICY;
      const request = {
        runId,
        tool: "mcp",
        payload: { server: call.server, tool: call.tool, argsJson: call.argsJson },
        provenanceLabel: "user",
        requestedCapability: mcpCapability(call.server, call.tool)
      };
      const decision = decide(policy, request);
      const policyDecision = {
        tool: request.tool,
        requestedCapability: request.requestedCapability,
        decision,
        provenanceLabel: request.provenanceLabel,
        server: call.server,
        mcpTool: call.tool
      };
      appendAndMirror("policy_decision", policyDecision);
      if (decision !== "allow") {
        const refuse = (reason) => {
          const blockedEnd = {
            tool: request.tool,
            provenanceLabel: request.provenanceLabel,
            blocked: true,
            decision
          };
          appendAndMirror("tool_end", blockedEnd);
          respond({ status: "denied", reason });
        };
        if (decision === "deny") {
          refuse(`denied by policy (${request.requestedCapability})`);
          return;
        }
        if (decision !== "ask" && decision !== "force_ask") {
          refuse(`policy decision '${decision}' is not executable for an MCP call \u2014 denied`);
          return;
        }
        const verdict = await this.awaitMcpApprovalVerdict(call, request, decision, appendAndMirror);
        if (verdict.verdict !== "allow") {
          refuse(verdict.reason);
          return;
        }
      }
      const toolStart = {
        tool: request.tool,
        requestedCapability: request.requestedCapability,
        provenanceLabel: request.provenanceLabel
      };
      appendAndMirror("tool_start", toolStart);
      const startedAt = Date.now();
      const outcome = await client.callTool(call.tool, call.argsJson, this.mcp?.callTimeoutMs);
      const toolEnd = {
        tool: request.tool,
        durationMs: Date.now() - startedAt,
        provenanceLabel: "mcp",
        status: outcome.status,
        ...outcome.resultJson !== void 0 ? { resultBytes: Buffer.byteLength(outcome.resultJson, "utf8") } : {}
      };
      appendAndMirror("tool_end", toolEnd);
      if (outcome.status === "ok") {
        respond({
          status: "ok",
          ...outcome.resultJson !== void 0 ? { resultJson: outcome.resultJson } : {}
        });
      } else {
        respond({
          status: "error",
          ...outcome.reason !== void 0 ? { reason: outcome.reason } : {}
        });
      }
    } catch (err) {
      this.logLine(`[bridge-server] mcp/call failed: ${String(err?.message ?? err)}`);
      respond({
        status: "error",
        reason: `mcp/call failed: ${String(err?.message ?? err)}`
      });
    }
  }
  /**
   * HOLD one ask/force_ask `mcp/call` for an interactive operator verdict (#9
   * Slice 2). Appends `approval_requested` (the EXISTING event type, carrying
   * approvalId + server/tool so the extension's modal can correlate — argsJson
   * is NOT traced here; the extension already holds it and the redaction-at-write
   * posture keeps free-form values out of the chain), parks a single-shot
   * resolver in {@link pendingMcpApprovals} for `approval/respond`, and arms the
   * honest timeout. Resolution appends `approval_approved` / `approval_denied`
   * (source 'human' for a real operator verdict; source-less for the
   * timeout/shutdown denial — no human acted). ZERO new trace event types.
   * Resolve-never-reject.
   */
  awaitMcpApprovalVerdict(call, request, decision, appendAndMirror) {
    const approvalId = `mcp-apr-${++this.mcpApprovalSeq}-${Date.now()}`;
    const timeoutMs = this.mcp?.approvalTimeoutMs ?? DEFAULT_MCP_APPROVAL_TIMEOUT_MS;
    const requested = {
      approvalId,
      tool: request.tool,
      requestedCapability: request.requestedCapability,
      decision,
      provenanceLabel: request.provenanceLabel,
      server: call.server,
      mcpTool: call.tool
    };
    appendAndMirror("approval_requested", requested);
    this.logLine(
      `[bridge-server] mcp/call ${request.requestedCapability} HELD for approval ${approvalId} (policy decision: ${decision}, timeout ${timeoutMs}ms).`
    );
    return new Promise((resolve5) => {
      const timer = setTimeout(() => {
        this.pendingMcpApprovals.delete(approvalId);
        const reason = `not approved \u2014 no operator decision within ${timeoutMs}ms (policy decision: ${decision}) \u2014 denied`;
        const denied = { approvalId, reason };
        appendAndMirror("approval_denied", denied);
        resolve5({ verdict: "deny", reason });
      }, timeoutMs);
      this.pendingMcpApprovals.set(approvalId, (verdict, reasonOverride) => {
        clearTimeout(timer);
        this.pendingMcpApprovals.delete(approvalId);
        if (verdict === "allow") {
          const approved = {
            approvalId,
            note: `operator approved governed MCP call (${request.requestedCapability})`
          };
          appendAndMirror("approval_approved", approved, "human");
          resolve5({ verdict: "allow" });
          return;
        }
        const reason = reasonOverride ?? `denied by operator (${request.requestedCapability})`;
        const denied = { approvalId, reason };
        appendAndMirror("approval_denied", denied, reasonOverride === void 0 ? "human" : void 0);
        resolve5({ verdict: "deny", reason });
      });
    });
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
      const ollama = new OllamaChatBackend(
        this.chat?.ollamaHost ? { host: this.chat.ollamaHost } : {}
      );
      this.chatGateway = new ModelGateway({ trace }).register(ollama).register(backend);
    }
    return this.chatGateway;
  }
  /** Emit one chat/delta notification (no id) carrying a {@link ChatStreamEvent}. */
  emitChatDelta(event) {
    const note = {
      glyphstudio: BRIDGE_JSONRPC,
      method: BridgeNotification.ChatDelta,
      params: event
    };
    this.emit(note);
  }
  /**
   * Emit one index/progress notification (no id) carrying an {@link IndexProgressEvent}
   * during an in-flight `index/build`. Mirrors {@link emitChatDelta}: a no-id
   * notification the client routes to the request's `onProgress` callback (and uses to
   * reset the request's inactivity timeout). Carries NON-SECRET COUNTS only.
   */
  emitIndexProgress(event) {
    const note = {
      glyphstudio: BRIDGE_JSONRPC,
      method: BridgeNotification.IndexProgress,
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
      glyphstudio: BRIDGE_JSONRPC,
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
      glyphstudio: BRIDGE_JSONRPC,
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
    return { glyphstudio: BRIDGE_JSONRPC, id, result };
  }
  errorResponse(id, code, message, data) {
    return {
      glyphstudio: BRIDGE_JSONRPC,
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
var supervisorVersion = process.env.GLYPHSTUDIO_SUPERVISOR_VERSION;
var runsBaseDir = process.env.GLYPHSTUDIO_RUNS_BASE;
var verifierKeyPath = process.env.GLYPHSTUDIO_VERIFIER_KEY;
var verifierPrivateKey;
if (verifierKeyPath) {
  verifierPrivateKey = resolveVerifierKeypair(verifierKeyPath).privateKey;
}
var verifierRuntimeRaw = process.env.GLYPHSTUDIO_VERIFIER_RUNTIME;
var verifierRuntime = parseSandboxRuntimePreference(verifierRuntimeRaw);
if (verifierRuntimeRaw && !verifierRuntime) {
  process.stderr.write(
    `[bridge-server-cli] ignoring unknown GLYPHSTUDIO_VERIFIER_RUNTIME=${JSON.stringify(verifierRuntimeRaw)} (expected auto|docker|firecracker|off); using the default 'auto'.
`
  );
}
var agentic = {
  ...verifierPrivateKey ? { verifierPrivateKey } : {},
  ...verifierRuntime ? { verifierRuntime } : {}
};
var server = serveStdio(process, {
  ...supervisorVersion ? { supervisorVersion } : {},
  ...runsBaseDir ? { runsBaseDir } : {},
  ...Object.keys(agentic).length > 0 ? { agentic } : {},
  // THE REAL CHANGE-REVIEW RUNNER (#7 integration slice): bind `review/start`
  // to the governed review runner via the production adapter, configured from
  // the SAME knobs as the build path (codex resolved on PATH inside the
  // adapter; absent codex ⇒ honest findings-'unavailable', verifier still runs).
  review: { runner: createGovernedChangeReviewRunner(agentic) },
  // THE REAL BUILD-PLAN RUNNER (#8 integration slice): bind `plan/start` to the
  // governed plan runner via the production adapter, configured from the SAME
  // `agentic` object (no config drift; the plan turn has no verifier knobs to
  // drift anyway — codex resolved on PATH inside the adapter; absent codex ⇒ an
  // honest parseStatus:'unavailable' proposal, never a fabricated plan).
  plan: { runner: createGovernedBuildPlanRunner(agentic) }
});
if (verifierRuntime) {
  process.stderr.write(`[bridge-server-cli] verifier runtime preference: ${verifierRuntime}
`);
}
process.stdin.resume();
process.stdin.on("end", () => {
  process.exit(0);
});
process.stderr.write("[bridge-server-cli] supervisor bridge ready on stdio.\n");
