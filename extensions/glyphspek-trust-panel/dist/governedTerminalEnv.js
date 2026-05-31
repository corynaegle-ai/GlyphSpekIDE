"use strict";
/*
 * GlyphSpek GOVERNED TERMINAL ENV — pure, headlessly-testable env-sanitization for
 * the in-IDE Governed Terminal surface (M7). NO vscode, NO node:* — it takes a
 * plain env record in and returns a plain env record out, so it compiles to dist/
 * and is unit-tested under node:test.
 *
 * This MIRRORS the spike launcher's default-deny env contract
 * (spikes/p0-governed-cli/cli-agent-launcher.ts buildGovernedEnvResult /
 * sanitizeBaseEnv / isPreservedEnvName). The extension is a SEPARATE build package
 * and cannot import the spikes tree at build time, so the SAME secret-firewall
 * semantics are restated here (exactly as RunRequest / the model RPC shapes are
 * mirrored in bridgeProtocol.ts). Keep the allow-list in lock-step with the launcher.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOFT BOUNDARY (sweep-23, governed-unsandboxed). The terminal env FORCES the
 * CLI's egress through the supervisor-owned metadata-only proxy by setting
 * HTTPS_PROXY/HTTP_PROXY = proxyUrl, EXEMPTING ONLY LOOPBACK via
 * NO_PROXY={@link LOOPBACK_NO_PROXY} — so the CLI's external egress is observed into
 * the run's trace while its OWN localhost OAuth callback (e.g. Claude Code's sign-in
 * redirect to 127.0.0.1) is not forced through the proxy and 403/ECONNREFUSED'd.
 * Loopback is the machine talking to itself, not external egress, so the exemption
 * does not weaken external-egress observation — but loopback itself BYPASSES the
 * proxy and is UNOBSERVED (NOT recorded); the session surfaces that honestly as a
 * `loopback_proxy_bypass` run fact. This is the SOFT boundary: a CLI that
 * strips these vars and opens a raw socket bypasses the proxy. Hard containment
 * (per-run network namespace / container with a default-DROP route) is the hard-mode
 * follow-on. We do NOT claim hard containment, and the session is NEVER
 * product-trusted (it settles into the `governed-unsandboxed` posture).
 *
 * CREDENTIAL POSTURE — anti-FauxCode. The CLI authenticates from its OWN on-disk
 * auth store under HOME (~/.claude, ~/.codex). GlyphSpek NEVER holds, injects, or
 * proxies the provider credential, and we set NO base-url override (no
 * ANTHROPIC_BASE_URL / OPENAI_BASE_URL). The proxy observes egress METADATA only;
 * it does not terminate TLS or see the key.
 *
 * DEFAULT-DENY SECRET FIREWALL. The base env is sanitized to a STRICT allow-list of
 * process basics + locale; EVERY other inherited name is DROPPED — including
 * capability HANDLES that grant host authority (SSH_AUTH_SOCK, KUBECONFIG,
 * DOCKER_HOST, GIT_ASKPASS, NETRC, …) and any provider/cloud/VCS token — so the CLI
 * the user runs inherits NO ambient host authority. Adding a name here grants the
 * actor that var; scrutinize additions.
 * ─────────────────────────────────────────────────────────────────────────────
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRESERVED_TERMINAL_ENV_NAMES = exports.LOOPBACK_NO_PROXY = void 0;
exports.isPreservedTerminalEnvName = isPreservedTerminalEnvName;
exports.sanitizeTerminalBaseEnv = sanitizeTerminalBaseEnv;
exports.buildGovernedTerminalEnv = buildGovernedTerminalEnv;
/**
 * The loopback carve-out value for NO_PROXY/no_proxy (F2, sweep-30). MIRROR of the
 * spikes' canonical `LOOPBACK_NO_PROXY` (p0-sandbox/egress-proxy.ts): the extension
 * is a SEPARATE build package and cannot import the spikes tree, exactly as the
 * env-sanitization allow-list and the RPC shapes are mirrored here. A conformance
 * test pins this byte-for-byte equal to the spike constant so the carve-out cannot
 * drift.
 *
 * READ THIS. Loopback exempted here BYPASSES the governed proxy and is therefore
 * UNOBSERVED — the machine talking to itself (local IPC / a CLI's localhost OAuth
 * callback), NOT external egress. Exempting it does not weaken EXTERNAL-egress
 * observation, but it means "every destination is recorded" is FALSE: loopback is
 * not. The session surfaces this honestly as a `loopback_proxy_bypass` run fact.
 */
exports.LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';
/**
 * Environment variable NAMES ALWAYS preserved into the governed terminal — the
 * EXHAUSTIVE allow-list of process basics a CLI needs to run, plus locale (handled
 * separately by {@link isLocaleVar}). PATH/HOME/TERM let the CLI find binaries, its
 * OWN on-disk auth store, and drive a TTY; the rest are OS process basics. The
 * proxy vars are owned/overwritten separately by {@link buildGovernedTerminalEnv}.
 *
 * Byte-for-byte the launcher's PRESERVED_ENV_NAMES. NONE of these is a capability
 * handle: they are inert process basics + paths into the user's own home/temp space.
 * HOME is preserved BY DESIGN — the user's CLI auth (~/.claude, ~/.codex) lives there.
 */
exports.PRESERVED_TERMINAL_ENV_NAMES = [
    'PATH',
    'Path', // Windows casing
    'HOME',
    'TERM',
    'LANG',
    'LANGUAGE',
    // Windows process basics a child needs to start at all.
    'SystemRoot',
    'SystemDrive',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'PATHEXT',
    'COMSPEC',
];
/** True iff `name` is an `LC_*` locale variable (LC_ALL, LC_CTYPE, …). */
function isLocaleVar(name) {
    return /^LC_[A-Z]+$/i.test(name);
}
/** Lowercase set of the explicit proxy var names GlyphSpek OWNS (set, never inherited). */
const PROXY_ENV_LOWER = new Set(['http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);
/** Lowercase set of the explicitly-preserved process-basics names, for O(1) lookup. */
const PRESERVED_TERMINAL_ENV_LOWER = new Set(exports.PRESERVED_TERMINAL_ENV_NAMES.map((n) => n.toLowerCase()));
/**
 * Decide whether an env var NAME is PRESERVED into the sanitized terminal env.
 * PURE; exported for unit-testing the allow-list directly.
 *
 * DEFAULT-DENY: a name is preserved ONLY if it is an explicit process basic
 * ({@link PRESERVED_TERMINAL_ENV_NAMES}) or a locale var ({@link isLocaleVar}).
 * EVERY other name — credential-shaped tokens, provider/cloud namespaces, AND
 * capability handles like SSH_AUTH_SOCK / KUBECONFIG / DOCKER_HOST / GIT_ASKPASS /
 * NETRC, plus any unknown var — is dropped. The proxy vars are excluded here too
 * because {@link buildGovernedTerminalEnv} owns/overwrites them explicitly.
 */
function isPreservedTerminalEnvName(name) {
    const lower = name.toLowerCase();
    if (PROXY_ENV_LOWER.has(lower))
        return false; // owned by buildGovernedTerminalEnv
    if (PRESERVED_TERMINAL_ENV_LOWER.has(lower))
        return true;
    return isLocaleVar(name);
}
/**
 * Sanitize a base env to the STRICT DEFAULT-DENY allow-list: preserve ONLY process
 * basics (PATH/HOME/TERM + OS basics) and locale (LANG/LANGUAGE/LC_*); DROP
 * EVERYTHING ELSE ({@link isPreservedTerminalEnvName}). The GlyphSpek proxy vars are
 * added back by {@link buildGovernedTerminalEnv}. PURE; exported for unit-testing.
 */
function sanitizeTerminalBaseEnv(base) {
    const out = {};
    for (const name of Object.keys(base)) {
        const value = base[name];
        if (value === undefined)
            continue;
        if (!isPreservedTerminalEnvName(name))
            continue; // default-deny
        out[name] = value;
    }
    return out;
}
/**
 * Build the VS Code terminal env that FORCES the CLI's egress through the
 * supervisor-owned governed proxy AND strips ambient host secrets/capability handles.
 *
 * DEFAULT-DENY VIA strictEnv (the hard form). VS Code's `createTerminal` supports
 * `strictEnv`: when true, the terminal's environment is EXACTLY the provided `env`
 * and NOTHING is inherited from the host process or `terminal.integrated.env.*`
 * config. We use that: in the sanitized posture we build the COMPLETE env from a
 * strict allow-list of process basics + locale ({@link sanitizeTerminalBaseEnv}) and
 * add the forced proxy vars — so ambient tokens AND capability handles
 * (SSH_AUTH_SOCK, DOCKER_HOST, KUBECONFIG, GIT_ASKPASS, NETRC, …) are absent because
 * they were never inherited, not merely nulled. This is robust to unknown future
 * vars (default-deny, not deny-known-bad). The CLI authenticates from its OWN on-disk
 * store under the preserved HOME (~/.claude, ~/.codex).
 *
 * AMBIENT OPT-IN (lower fidelity). When `allowAmbientEnv` is true, `env` is a MERGE
 * overlay (strictEnv = false) that forces ONLY the proxy vars; ambient host secrets
 * pass through and the posture is `'untrusted'`. The egress governance still holds.
 *
 * We DELIBERATELY do NOT set ANTHROPIC_BASE_URL / OPENAI_BASE_URL / any base-url
 * override and inject NO credential (anti-FauxCode, v1): the CLI keeps its OWN
 * auth/billing; we only route its network through the metadata-only proxy.
 */
function buildGovernedTerminalEnv(opts) {
    const allowAmbient = opts.allowAmbientEnv ?? false;
    // Base env: the COMPLETE allow-listed set (sanitized posture) or empty (ambient
    // opt-in, where the overlay merges onto the inherited env).
    const env = allowAmbient
        ? {}
        : sanitizeTerminalBaseEnv(opts.baseEnv);
    // OWN the proxy vars (both casings — tools differ on which they read).
    env.HTTPS_PROXY = opts.proxyUrl;
    env.https_proxy = opts.proxyUrl;
    env.HTTP_PROXY = opts.proxyUrl;
    env.http_proxy = opts.proxyUrl;
    // EXEMPT LOOPBACK from the proxy via the ONE shared carve-out value (F2). An empty
    // NO_PROXY would force loopback THROUGH the proxy, which breaks a CLI's localhost
    // OAuth callback (e.g. Claude Code's sign-in listens on 127.0.0.1 and the redirect
    // would hit the proxy → ECONNREFUSED). Loopback is the machine talking to ITSELF,
    // not external egress, so exempting it does NOT weaken external-egress observation
    // (the trace still records every real EXTERNAL destination) — but loopback itself
    // BYPASSES the proxy and is UNOBSERVED, surfaced honestly as a loopback_proxy_bypass
    // run fact so the Trust Panel labels it as unobserved local traffic.
    env.NO_PROXY = exports.LOOPBACK_NO_PROXY;
    env.no_proxy = exports.LOOPBACK_NO_PROXY;
    return {
        env,
        // strictEnv only in the sanitized posture: the env IS the whole environment.
        strictEnv: !allowAmbient,
        posture: allowAmbient ? 'untrusted' : 'sanitized',
    };
}
//# sourceMappingURL=governedTerminalEnv.js.map