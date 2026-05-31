"use strict";
/*
 * GlyphSpek AGENT-CLI BINARY IDENTITY EVIDENCE (sweep-28 High) — node-only,
 * headlessly-testable capture of WHICH bytes/version of the agent CLI a governed
 * chat is about to auto-run. Captured IMMEDIATELY BEFORE the chat auto-run
 * `sendText`, so the evidence is bound to the exact on-disk binary that runs
 * (TOCTOU: closing the window between resolution and launch).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS — and IS NOT. agentLaunch.ts already PINS the canonical absolute
 * path (so the shell can't re-resolve a bare name to a swapped binary). This module
 * adds the missing EVIDENCE: the run records no proof of which bytes/version
 * launched. We capture a streaming sha256 of the file, its size + mtime, and a
 * best-effort `--version` string, and thread them ADDITIVELY into the run-opened
 * event + trace so a reviewer can later answer "exactly which binary ran?".
 *
 * HONEST FRAMING (load-bearing): this is evidence captured at launch on the SOFT
 * (governed-unsandboxed) path. It does NOT make the run product-trusted — the
 * session is governed + traced but UNSANDBOXED. Recording the binary's identity is
 * provenance, not a trust upgrade.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NEVER THROWS. Every field is best-effort/OPTIONAL: a hash that can't be read, a
 * file that's too big, a `--version` that times out or errors — each degrades to an
 * `undefined` value plus a short, non-secret `*Unavailable` reason string. The
 * caller always gets a populated {@link AgentBinaryIdentity} it can record.
 *
 * node:fs + node:crypto + node:child_process only (NO vscode), so it compiles to
 * dist/ and is unit-tested under node:test by injecting a fake binary path.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureAgentBinaryIdentity = captureAgentBinaryIdentity;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
/** Default cap on the streaming hash (256 MiB). */
const DEFAULT_MAX_HASH_BYTES = 256 * 1024 * 1024;
/** Default `--version` spawn timeout (2.5s). */
const DEFAULT_VERSION_TIMEOUT_MS = 2500;
/** Read chunk size for the streaming hash (1 MiB). */
const HASH_CHUNK_BYTES = 1024 * 1024;
/**
 * Streaming sha256 of `launchPath` using a fixed-size read buffer (so a large file
 * is hashed in bounded memory), capped at `maxBytes`. Returns the hex digest, or
 * `{ unavailable }` with a short reason. Never throws — every fs failure is caught
 * and degraded to an `unavailable` reason.
 */
function streamingSha256(launchPath, sizeBytes, maxBytes) {
    // Skip hashing an oversize file rather than read it all on the launch hot path.
    if (typeof sizeBytes === 'number' && sizeBytes > maxBytes) {
        return { unavailable: `oversize (${sizeBytes} bytes > ${maxBytes} cap)` };
    }
    let fd;
    try {
        fd = (0, node_fs_1.openSync)(launchPath, 'r');
        const hash = (0, node_crypto_1.createHash)('sha256');
        const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
        let total = 0;
        for (;;) {
            const bytesRead = (0, node_fs_1.readSync)(fd, buf, 0, HASH_CHUNK_BYTES, null);
            if (bytesRead === 0)
                break;
            total += bytesRead;
            // Defense in depth: if the file grew past the cap mid-read, stop honestly.
            if (total > maxBytes) {
                return { unavailable: `oversize (exceeded ${maxBytes} cap while reading)` };
            }
            hash.update(buf.subarray(0, bytesRead));
        }
        return { sha256: hash.digest('hex') };
    }
    catch (err) {
        return { unavailable: `read error: ${String(err?.message ?? err)}` };
    }
    finally {
        if (fd !== undefined) {
            try {
                (0, node_fs_1.closeSync)(fd);
            }
            catch {
                /* best-effort close */
            }
        }
    }
}
/** Default real `--version` spawn (short timeout, no shell, stdout captured). */
function defaultSpawnVersion(launchPath, timeoutMs) {
    const res = (0, node_child_process_1.spawnSync)(launchPath, ['--version'], {
        timeout: timeoutMs,
        encoding: 'utf8',
        // No shell: argv form runs the EXACT file, never a re-parsed command line.
        shell: false,
        // We only want a short version string; bound stdout so a chatty binary can't
        // balloon the buffer.
        maxBuffer: 64 * 1024,
        windowsHide: true,
    });
    return {
        status: res.status,
        stdout: typeof res.stdout === 'string' ? res.stdout : '',
        ...(res.error ? { error: res.error } : {}),
    };
}
/**
 * Best-effort `launchPath --version`: returns the trimmed FIRST stdout line, or
 * `{ unavailable }` with a short reason on timeout / nonzero exit / spawn error.
 * Never throws.
 */
function captureVersion(launchPath, timeoutMs, spawnVersion) {
    let res;
    try {
        res = spawnVersion(launchPath, timeoutMs);
    }
    catch (err) {
        return { unavailable: `spawn error: ${String(err?.message ?? err)}` };
    }
    // A timeout surfaces as error (ETIMEDOUT) and status null.
    if (res.error) {
        return { unavailable: `spawn error: ${String(res.error.message ?? res.error)}` };
    }
    if (res.status === null) {
        return { unavailable: 'no exit status (killed/timed out)' };
    }
    if (res.status !== 0) {
        return { unavailable: `nonzero exit (${res.status})` };
    }
    const firstLine = (res.stdout ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (firstLine.length === 0) {
        return { unavailable: 'empty version output' };
    }
    return { version: firstLine };
}
/**
 * Capture the binary-identity evidence for `launchPath` (a canonical absolute path
 * from resolveAgentLaunch). Streams a size-capped sha256, reads size+mtime via
 * statSync, and best-effort spawns `--version` with a short timeout. NEVER throws;
 * every field is optional with an honest `*Unavailable` reason on failure.
 *
 * Intended to be called IMMEDIATELY BEFORE the chat auto-run sendText, so the
 * recorded evidence describes the exact bytes that are about to run (TOCTOU).
 */
function captureAgentBinaryIdentity(launchPath, opts = {}) {
    const maxHashBytes = opts.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES;
    const versionTimeoutMs = opts.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
    const spawnVersion = opts.spawnVersion ?? defaultSpawnVersion;
    const identity = { path: launchPath };
    // size + mtime (best-effort). A stat failure (missing/vanished file) leaves both
    // undefined and still lets the hash attempt run (it will report its own reason).
    let sizeBytes;
    try {
        const st = (0, node_fs_1.statSync)(launchPath);
        sizeBytes = st.size;
        identity.sizeBytes = st.size;
        identity.mtimeMs = st.mtimeMs;
    }
    catch {
        // No size/mtime — leave undefined; the hash step reports its own unavailability.
    }
    // sha256 (streaming, size-capped, never throws).
    const hashed = streamingSha256(launchPath, sizeBytes, maxHashBytes);
    if (hashed.sha256 !== undefined) {
        identity.sha256 = hashed.sha256;
    }
    else if (hashed.unavailable !== undefined) {
        identity.sha256Unavailable = hashed.unavailable;
    }
    // version (best-effort spawn, short timeout, never throws).
    const versioned = captureVersion(launchPath, versionTimeoutMs, spawnVersion);
    if (versioned.version !== undefined) {
        identity.version = versioned.version;
    }
    else if (versioned.unavailable !== undefined) {
        identity.versionUnavailable = versioned.unavailable;
    }
    return identity;
}
//# sourceMappingURL=agentBinaryIdentity.js.map