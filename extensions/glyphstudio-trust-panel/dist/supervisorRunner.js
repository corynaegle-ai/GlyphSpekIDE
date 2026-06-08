"use strict";
/*
 * GlyphStudio supervisor runner — extension-host bridge to the governed-run CLI.
 *
 * This module is the HOST-side launcher for the supervisor's
 * `governed-run-cli.ts` (the SHARED CONTRACT entry). It spawns the CLI as a
 * child of the current Electron/Node binary (re-run as plain Node via
 * ELECTRON_RUN_AS_NODE), streams the child's human-readable progress (stderr)
 * into a VS Code OutputChannel, and parses the SINGLE final JSON result line the
 * CLI prints to stdout.
 *
 * Trust division (unchanged): the host never parses, judges, or vouches for the
 * run bundle. It only launches the governed run, captures where the bundle was
 * written (--out), and hands that directory to the existing
 * loadBundleFromDirectory() seam — which ships RAW bytes to the webview, where
 * all parsing + Ed25519 verification happens. This runner deliberately produces
 * only a directory path + the CLI's own result object; it does not read or
 * interpret bundle files.
 *
 * Resolve-never-reject: mirroring docker-runtime's runDocker(), the returned
 * promise NEVER rejects. Spawn failure, a non-zero exit, an unparseable result
 * line, a missing Docker daemon — all resolve with a populated SupervisorResult
 * whose exitCode / result fields let the caller decide what to show. This keeps
 * the command handler free of try/catch around the child lifecycle and ensures
 * a failed run never throws into the activation path.
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
exports.containerNameForRunId = containerNameForRunId;
exports.extractRunId = extractRunId;
exports.sweepRunContainer = sweepRunContainer;
exports.buildArgs = buildArgs;
exports.runSupervisor = runSupervisor;
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const supervisorBinary_1 = require("./supervisorBinary");
/** Synthetic exit code used when the child could not be spawned. */
const SPAWN_FAIL_EXIT_CODE = 127;
/** Synthetic exit code used when the run was cancelled. */
const CANCELLED_EXIT_CODE = 130; // 128 + SIGINT, conventional "terminated"
/** Grace period (ms) between SIGTERM and the SIGKILL escalation on cancel. */
const SIGKILL_GRACE_MS = 2_000;
/**
 * Extract the FINAL well-formed JSON object line from accumulated stdout. The
 * CLI contract is "exactly one final JSON result line on stdout"; we scan from
 * the last line backwards and return the first line that parses as a JSON
 * object, tolerating trailing blank lines or stray non-JSON noise.
 */
function parseFinalJsonLine(stdout) {
    const lines = stdout.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line)
            continue;
        if (line[0] !== '{')
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // Not the final JSON line; keep scanning earlier lines.
        }
    }
    return null;
}
/**
 * The container-name prefix the docker-runtime uses (`glyphstudio-<sanitized
 * runId>`). We mirror it ONLY to recognize and SCOPE-filter this one run's
 * container; we never enumerate the whole prefix for removal.
 */
const CONTAINER_NAME_PREFIX = 'glyphstudio-';
/**
 * Discover THIS run's container name from a runId.
 *
 * The docker-runtime derives the container name as `glyphstudio-<runId>` after
 * sanitizing the runId to docker's legal object-name charset
 * ([a-zA-Z0-9][a-zA-Z0-9_.-]*) — we reproduce that sanitization here so a
 * fallback teardown can target EXACTLY this run's container and nothing else.
 * Kept in sync with p0-sandbox/docker-runtime.ts containerNameFor(); we read
 * from what the supervisor emits rather than reaching into the spikes tree.
 */
function containerNameForRunId(runId) {
    const safe = runId.replace(/[^a-zA-Z0-9_.-]/g, '-');
    return `${CONTAINER_NAME_PREFIX}${safe}`;
}
/**
 * Best-effort attempt to extract THIS run's runId from the child's output. The
 * governed-run CLI does not print a dedicated early runId line, but the runId
 * (format `<base36-ts>-<uuidv4>`) surfaces in the final stdout result line and
 * can appear in stderr progress. We scan opportunistically; returning undefined
 * is expected (and safe) when a cancel beats any runId emission.
 */
function extractRunId(text) {
    // First, an explicit JSON "runId":"..." (the result line / any structured log).
    const json = text.match(/"runId"\s*:\s*"([^"]+)"/);
    if (json)
        return json[1];
    // Else a bare container name the CLI/runtime may have echoed.
    const named = text.match(/glyphstudio-([a-z0-9]{6,}-[0-9a-f-]{8,})/i);
    if (named)
        return named[1];
    return undefined;
}
/**
 * Best-effort, SCOPED teardown of THIS run's leftover container after a cancel.
 *
 * SECURITY (sweep-07 Medium #2): the previous implementation force-removed EVERY
 * `glyphstudio-*` container, destroying unrelated/concurrent governed runs. We now
 * target ONLY the container for the supplied runId. The PRIMARY teardown is the
 * child's own `finally` block (SIGTERM lets it run `sandbox.teardown()`, which
 * removes its own container); this scoped `docker rm -f` is a fallback for when
 * the child was SIGKILLed before its teardown completed.
 *
 * When the runId is unknown (a cancel beat any runId emission), we do NOTHING and
 * rely solely on the child's SIGTERM teardown — never falling back to a
 * namespace-wide sweep. Every error is swallowed: hygiene, never load-bearing,
 * and must never throw into the cancel path. No-op when docker is absent.
 */
function sweepRunContainer(runId, output) {
    if (!runId) {
        output?.appendLine('[host] cancel teardown: run id unknown — relying on the child\'s own container ' +
            'teardown (no namespace-wide sweep, to protect concurrent runs).');
        return;
    }
    const name = containerNameForRunId(runId);
    try {
        // Confirm the container actually exists and belongs to THIS run before any
        // removal — filter by the exact name, never the glyphstudio- prefix.
        const listed = (0, node_child_process_1.spawnSync)('docker', ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8' });
        if (listed.status !== 0 || !listed.stdout)
            return;
        const ids = listed.stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (ids.length === 0)
            return;
        output?.appendLine(`[host] cancel fallback: force-removing this run's container ${name} (${ids.length}).`);
        (0, node_child_process_1.spawnSync)('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
    }
    catch {
        // Docker missing / unreachable: nothing to sweep, and never fatal.
    }
}
/**
 * Build the argv for the governed-run child (everything AFTER the node binary).
 *
 * DEFAULT (bundled) path — opts.bundlePath set: argv is `<bundlePath> --repo …`.
 * No `--import tsx`: the bundle is plain ESM run directly by the node binary.
 * `--runs-base <runsBase>` is appended so the bundled supervisor writes run state
 * under a caller-supplied, user-writable base (never the install dir).
 *
 * DEV-OVERRIDE path — opts.cliPath set: argv is `--import tsx <cliPath> --repo …`
 * (the existing un-bundled behavior). `--runs-base` is still appended when a base
 * is supplied so the dev path can also be redirected.
 *
 * The --verifier-key flag is appended ONLY when a key path is supplied, so
 * omitting it preserves the CLI's ephemeral-keypair fallback.
 *
 * Exported for unit tests (pure argv construction; no spawn).
 */
function buildArgs(opts) {
    const args = [];
    if (opts.bundlePath) {
        // Bundled ESM run directly by node — no tsx loader.
        args.push(opts.bundlePath);
    }
    else if (opts.cliPath) {
        // Dev override: load tsx and run the .ts entry from the spikes tree.
        args.push('--import', 'tsx', opts.cliPath);
    }
    args.push('--repo', opts.repo, '--policy', opts.policy, '--out', opts.out, '--mode', opts.mode);
    if (opts.runsBase) {
        args.push('--runs-base', opts.runsBase);
    }
    if (opts.verifierKeyPath) {
        args.push('--verifier-key', opts.verifierKeyPath);
    }
    return args;
}
/**
 * Environment-variable names forwarded into the child WHEN PRESENT, beyond the
 * always-set ELECTRON_RUN_AS_NODE / PATH / HOME. Everything else in the host
 * process.env is dropped (sweep-08/09 env-minimization): the supervisor is
 * spawned with the verifier private key, so it must not inherit the host's full
 * environment (tokens, editor internals, etc.). These are the variables the
 * Docker/Colima runtime legitimately needs to reach the daemon plus a couple of
 * locale/temp knobs the sandbox image honors.
 */
const FORWARDED_ENV_KEYS = [
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CONTEXT',
    'GLYPHSTUDIO_SANDBOX_IMAGE',
    'TMPDIR',
    'LANG',
];
/**
 * Build the MINIMAL environment for the child. Starts from ELECTRON_RUN_AS_NODE=1
 * (so the Electron/Node binary behaves as plain Node), the host PATH and HOME
 * (needed to find `docker` and resolve ~), then additively forwards the
 * runtime-relevant keys in {@link FORWARDED_ENV_KEYS} plus any COLIMA_* var (the
 * Colima docker context relies on a family of COLIMA_* env). The rest of
 * process.env is intentionally NOT propagated.
 */
function buildMinimalEnv() {
    const src = process.env;
    const env = {
        ELECTRON_RUN_AS_NODE: '1',
    };
    if (src.PATH !== undefined)
        env.PATH = src.PATH;
    if (src.HOME !== undefined)
        env.HOME = src.HOME;
    for (const key of FORWARDED_ENV_KEYS) {
        if (src[key] !== undefined)
            env[key] = src[key];
    }
    // The Colima docker context is configured via a family of COLIMA_* vars; carry
    // any of them through (still additive, still allowlist-shaped by prefix).
    for (const key of Object.keys(src)) {
        if (key.startsWith('COLIMA_') && src[key] !== undefined) {
            env[key] = src[key];
        }
    }
    return env;
}
/**
 * Launch one governed run and resolve (NEVER reject) with its outcome.
 *
 * The child is spawned from process.execPath (the running VS Code/Electron
 * binary) with ELECTRON_RUN_AS_NODE=1 so it behaves as a plain Node — no
 * separate Node install is required. stdin is ignored; stdout is captured for
 * the final JSON line; stderr is streamed line-by-line into the OutputChannel.
 */
function runSupervisor(opts) {
    return new Promise((resolve) => {
        const { output } = opts;
        const bundled = Boolean(opts.bundlePath);
        const args = buildArgs(opts);
        output.appendLine('');
        output.appendLine(`[host] GlyphStudio governed run — mode: ${opts.mode} (${bundled ? 'bundled+pinned' : 'dev-override, un-pinned'})`);
        output.appendLine(`[host] repo:   ${opts.repo}`);
        output.appendLine(`[host] policy: ${opts.policy}`);
        output.appendLine(`[host] out:    ${opts.out}`);
        if (opts.runsBase)
            output.appendLine(`[host] runs base: ${opts.runsBase}`);
        output.appendLine(`[host] verifier key: ${opts.verifierKeyPath ?? '(ephemeral per-run fallback)'}`);
        // HASH GATE (bundled path only): the bundle's on-disk bytes must match the
        // sha256 the build step pinned into the extension, or we REFUSE to spawn —
        // never run unverified code with the verifier private key. The dev-override
        // tsx path is intentionally not gated (the operator opted into it explicitly).
        if (bundled) {
            const mismatch = (0, supervisorBinary_1.verifyBundleHash)(opts.bundlePath);
            if (mismatch) {
                output.appendLine(`[host] ${mismatch}`);
                resolve({
                    exitCode: SPAWN_FAIL_EXIT_CODE,
                    bundleDir: opts.out,
                    result: null,
                    cancelled: false,
                    spawnFailed: true,
                    message: mismatch,
                });
                return;
            }
            output.appendLine('[host] bundled supervisor hash verified (pinned sha256 match).');
        }
        // Bundled path runs with cwd = runsBase (a user-writable base; the bundle
        // resolves nothing relative to cwd). Dev override keeps cwd = spikes root so
        // tsx resolves the CLI's relative imports.
        const cwd = bundled ? opts.runsBase : opts.cwd;
        const env = buildMinimalEnv();
        output.appendLine(`[host] spawn: ${path.basename(process.execPath)} ${args.join(' ')}`);
        output.appendLine('');
        let child;
        try {
            child = (0, node_child_process_1.spawn)(process.execPath, args, {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            const message = `failed to spawn supervisor: ${String(err?.message ?? err)}`;
            output.appendLine(`[host] ${message}`);
            resolve({
                exitCode: SPAWN_FAIL_EXIT_CODE,
                bundleDir: opts.out,
                result: null,
                cancelled: false,
                spawnFailed: true,
                message,
            });
            return;
        }
        let stdout = '';
        let stderrBuffer = '';
        let stderrAll = '';
        let cancelled = false;
        let settled = false;
        let killTimer;
        let tokenSub;
        // THIS run's id, captured opportunistically from the child's output so a
        // cancel teardown can target ONLY this run's container (Medium #2). Stays
        // undefined when a cancel beats any runId emission.
        let runId;
        const finish = (res) => {
            if (settled)
                return;
            settled = true;
            if (killTimer)
                clearTimeout(killTimer);
            tokenSub?.dispose();
            resolve(res);
        };
        // Cancellation: SIGTERM, then escalate to SIGKILL after a grace period, then
        // sweep any leftover containers. Resolving still happens via the 'close'/
        // 'error' handlers below; we just nudge the child to exit.
        if (opts.token) {
            if (opts.token.isCancellationRequested) {
                cancelled = true;
            }
            tokenSub = opts.token.onCancellationRequested(() => {
                if (cancelled)
                    return;
                cancelled = true;
                output.appendLine('[host] cancellation requested — terminating supervisor (SIGTERM)…');
                try {
                    child.kill('SIGTERM');
                }
                catch {
                    /* already gone */
                }
                killTimer = setTimeout(() => {
                    output.appendLine('[host] supervisor still alive — escalating to SIGKILL…');
                    try {
                        child.kill('SIGKILL');
                    }
                    catch {
                        /* already gone */
                    }
                }, SIGKILL_GRACE_MS);
            });
            // Pre-cancelled before the child even started: tear it down immediately.
            if (cancelled) {
                try {
                    child.kill('SIGTERM');
                }
                catch {
                    /* ignore */
                }
            }
        }
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            // Capture this run's id as soon as it appears, so a later cancel can scope
            // teardown to exactly this container.
            runId ??= extractRunId(stdout);
        });
        // Stream stderr to the OutputChannel line-by-line so partial chunks don't
        // split a line across appendLine calls.
        child.stderr?.on('data', (chunk) => {
            const text = chunk.toString('utf8');
            stderrAll += text;
            runId ??= extractRunId(stderrAll);
            stderrBuffer += text;
            let nl;
            while ((nl = stderrBuffer.indexOf('\n')) !== -1) {
                const line = stderrBuffer.slice(0, nl).replace(/\r$/, '');
                stderrBuffer = stderrBuffer.slice(nl + 1);
                output.appendLine(line);
            }
        });
        child.on('error', (err) => {
            // Spawn-time failure surfaced asynchronously (e.g. ENOENT on execPath).
            const message = `supervisor process error: ${String(err?.message ?? err)}`;
            output.appendLine(`[host] ${message}`);
            finish({
                exitCode: SPAWN_FAIL_EXIT_CODE,
                bundleDir: opts.out,
                result: null,
                cancelled,
                spawnFailed: true,
                message,
            });
        });
        child.on('close', (code, signal) => {
            // Flush any trailing stderr that lacked a newline.
            if (stderrBuffer.length) {
                output.appendLine(stderrBuffer.replace(/\r$/, ''));
                stderrBuffer = '';
            }
            if (cancelled) {
                // The child's own finally teardown (triggered by SIGTERM) is the primary
                // cleanup; this is a SCOPED fallback for THIS run's container only —
                // never the whole glyphstudio-* namespace (Medium #2).
                output.appendLine('[host] supervisor terminated by cancellation; scoped container teardown…');
                runId ??= extractRunId(stdout) ?? extractRunId(stderrAll);
                sweepRunContainer(runId, output);
                finish({
                    exitCode: CANCELLED_EXIT_CODE,
                    bundleDir: opts.out,
                    result: null,
                    cancelled: true,
                    spawnFailed: false,
                    message: 'Run cancelled.',
                });
                return;
            }
            const result = parseFinalJsonLine(stdout);
            const exitCode = code === null ? SPAWN_FAIL_EXIT_CODE : code;
            if (exitCode === 0 && result === null) {
                output.appendLine('[host] supervisor exited 0 but printed no parseable final JSON result line.');
                finish({
                    exitCode,
                    bundleDir: opts.out,
                    result: null,
                    cancelled: false,
                    spawnFailed: false,
                    message: 'Supervisor finished but produced no machine-readable result line; the bundle may still be present.',
                });
                return;
            }
            if (exitCode !== 0) {
                const sigNote = signal ? ` (signal ${signal})` : '';
                output.appendLine(`[host] supervisor exited with code ${exitCode}${sigNote}.`);
            }
            else {
                output.appendLine('[host] supervisor completed; bundle written.');
            }
            finish({
                exitCode,
                bundleDir: opts.out,
                result,
                cancelled: false,
                spawnFailed: false,
                message: exitCode === 0 ? '' : `Supervisor exited with code ${exitCode}.`,
            });
        });
    });
}
//# sourceMappingURL=supervisorRunner.js.map