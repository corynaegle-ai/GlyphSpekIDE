"use strict";
/*
 * GlyphCode EVIDENCE-GROUNDED AI COMMIT MESSAGE — the vscode-facing command.
 *
 * "GlyphCode: Generate Commit Message" (SCM input sparkle + command palette). It pre-fills the
 * SCM commit input with an AI message that is GROUNDED in the SIGNED evidence of the governed
 * run that produced the staged change — and carries a machine-parseable provenance trailer ONLY
 * when a verdict's signature verifies AND the staged content binds to what that verdict actually
 * verified. It NEVER commits, stages, or pushes (AC11).
 *
 * SEAM REUSE (no new model/crypto/protocol code):
 *   - generation routes through the SAME governed Codex gateway the chat participant + inline
 *     edit + terminal Cmd-K use: an injected {@link ChatGatewaySessionFactory} →
 *     {@link runGatewayTurn} (chatParticipant.ts). A brokered, metadata-TRACED model call on
 *     the user's own subscription — governed, UNSANDBOXED, never product-trusted, no credential
 *     injected (AC9).
 *   - signature verification mirrors spikes/p0-verifier/signing.ts verifyVerdictSignature and
 *     media/app.js verifyVerdictSignature: Ed25519 over canonicalJson({traceRootHash, verdict})
 *     with the verdict's own `signature` field stripped, against the operator's TRUSTED key set
 *     (the `glyphcode.trustedVerifierKeys` setting + the machine keystore public key) AND, only
 *     to label valid-but-untrusted, the bundle-supplied key.
 *   - the trust-critical DECISIONS (correspondence, trailer, sanitize, refusal, secret-firewall
 *     payload) live in the PURE, headless-tested commitMessageLogic.ts.
 *
 * SECRET FIREWALL (AC10/AC31): only the (secret-redacted) staged diff + evidence metadata are
 * sent to the gateway — never process env. The payload shape is built by the pure
 * buildGatewayRequestPayload allow-list.
 *
 * HONEST REFUSALS (AC12–AC17/AC28): not a repo / nothing staged / gateway error|timeout /
 * cancel / empty reply → an honest notice; existing commit text is NEVER clobbered on failure;
 * replace-with-confirm only when the input is already non-empty.
 *
 * CONCURRENCY (AC30): a per-repo in-flight guard ignores a second invocation for the same repo.
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
exports.commitMessageSystemPrompt = commitMessageSystemPrompt;
exports.registerGenerateCommitMessage = registerGenerateCommitMessage;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const chatParticipant_1 = require("./chatParticipant");
const commitMessageLogic_1 = require("./commitMessageLogic");
/* ============================================================== *
 * USER-FACING COPY (AC26 — honest, centralized, never overstates trust)
 *
 * No vscode-nls framework is in use in this extension; user-facing strings are plain English
 * shown via vscode.window.show*Message (mirrors inlineEdit.ts / terminalCmdK.ts). Centralizing
 * them here keeps the copy honest and ready for an l10n bundle. NONE of these assert
 * "verified"/"safe" — a verification claim is carried ONLY by the trailer the pure logic emits.
 * ============================================================== */
const MSG = {
    notARepo: 'GlyphCode: no Git repository here — open a folder under version control to generate a commit message.',
    nothingStaged: 'GlyphCode: nothing is staged. Stage the changes you want to commit first (unstaged work is not used).',
    noGitExtension: 'GlyphCode: the built-in Git extension is unavailable, so a commit message cannot be generated.',
    gatewayFailed: (detail) => `GlyphCode: the governed gateway could not generate a message (${detail}). Your commit input was left unchanged.`,
    emptyReply: 'GlyphCode: the model returned no usable message. Your commit input was left unchanged.',
    cancelled: 'GlyphCode: commit-message generation cancelled. Your commit input was left unchanged.',
    inFlight: 'GlyphCode: a commit message is already being generated for this repository.',
    replaceConfirm: 'Your commit message box already has text. Replace it with the generated message?',
    replaceYes: 'Replace',
    replaceKeep: 'Keep mine',
    progressTitle: 'GlyphCode: generating commit message…',
    noTrailerNote: (reason) => `GlyphCode: ${reason}`,
};
/** The time budget for the governed gateway turn (AC23/AC14). */
const GATEWAY_TIMEOUT_MS = 60_000;
/** Cap on the diff bytes sent to the gateway (AC18). Beyond this, the diff is truncated. */
const MAX_DIFF_BYTES = 60_000;
/**
 * The trusted verifier key set (operator setting + machine keystore), read defensively. A
 * verdict is only treated as signed when one of these (or, valid-but-untrusted, the bundle's
 * own key) verifies it. NEVER reads a workspace-scoped value (machine-scoped setting + we read
 * .globalValue/.defaultValue only) so a repo cannot inject a trust root.
 */
function trustedVerifierKeys() {
    const keys = [];
    try {
        const inspect = vscode.workspace
            .getConfiguration('glyphcode')
            .inspect('trustedVerifierKeys');
        for (const v of [inspect?.defaultValue, inspect?.globalValue]) {
            if (Array.isArray(v))
                for (const k of v)
                    if (typeof k === 'string' && k.trim())
                        keys.push(k);
        }
    }
    catch {
        /* setting unavailable in a minimal host — fall through to keystore */
    }
    try {
        const keystore = path.join(homeDir(), '.glyphcode', 'verifier', 'public.pem');
        if (fs.existsSync(keystore))
            keys.push(fs.readFileSync(keystore, 'utf8'));
    }
    catch {
        /* unreadable keystore is non-fatal */
    }
    return keys;
}
/** The home dir (process.env.HOME / USERPROFILE), best-effort. */
function homeDir() {
    return process.env.HOME || process.env.USERPROFILE || '';
}
/**
 * The canonical message bytes a verdict's signature is computed over. BYTE-FOR-BYTE mirror of
 * spikes/p0-verifier/signing.ts verdictMessage and media/app.js verdictMessageBytes:
 * canonicalJson({ traceRootHash, verdict-without-signature }).
 */
function verdictMessageBytes(verdict) {
    const core = {};
    for (const k of Object.keys(verdict)) {
        if (k === 'signature')
            continue;
        core[k] = verdict[k];
    }
    const json = canonicalJson({ traceRootHash: verdict.traceRootHash, verdict: core });
    return Buffer.from(json, 'utf8');
}
/** Canonical JSON (lexicographically sorted keys, compact) — port of canonical-json.ts. */
function canonicalJson(value) {
    if (value === null)
        return 'null';
    const t = typeof value;
    if (t === 'string')
        return JSON.stringify(value);
    if (t === 'number')
        return Number.isFinite(value) ? String(value) : 'null';
    if (t === 'boolean')
        return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
    }
    if (t === 'object') {
        const obj = value;
        const keys = Object.keys(obj).sort();
        const parts = [];
        for (const k of keys) {
            const v = obj[k];
            if (v === undefined)
                continue;
            parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
        }
        return '{' + parts.join(',') + '}';
    }
    return 'undefined';
}
/** Verify an Ed25519 verdict signature against ONE SPKI PEM/base64 key. Never throws. */
function verifyWithKey(verdict, keyText) {
    const sig = verdict.signature;
    if (!sig || sig.alg !== 'ed25519' || typeof sig.value !== 'string')
        return false;
    let key;
    try {
        const pem = keyText.includes('BEGIN')
            ? keyText
            : `-----BEGIN PUBLIC KEY-----\n${keyText.trim()}\n-----END PUBLIC KEY-----\n`;
        key = (0, node_crypto_1.createPublicKey)(pem);
    }
    catch {
        return false;
    }
    let sigBytes;
    try {
        sigBytes = Buffer.from(sig.value, 'base64');
    }
    catch {
        return false;
    }
    try {
        return (0, node_crypto_1.verify)(null, verdictMessageBytes(verdict), key, sigBytes);
    }
    catch {
        return false;
    }
}
/**
 * Signature-verify a verdict: TRUSTED keys (operator setting + keystore) first; that is the
 * only path that yields signatureVerified:true. The bundle's own key is consulted last only to
 * note "valid-but-untrusted" — it does NOT set signatureVerified (AC8: a bundle-supplied key is
 * not a trust root, so it is treated as no evidence for the verification claim).
 */
function verdictSignatureVerified(verdict, bundleKeyPem) {
    for (const k of trustedVerifierKeys()) {
        if (verifyWithKey(verdict, k))
            return true;
    }
    // A bundle-key match is intentionally NOT trusted for the verification claim.
    void bundleKeyPem;
    return false;
}
/** Read a JSON file, returning undefined on any error. */
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** sha256 hex of a string. Used for the staged-content + verified-content fingerprints. */
function sha256Hex(text) {
    return (0, node_crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
/**
 * Normalize a diff for content fingerprinting: drop volatile lines (index hashes, hunk @@
 * counts) so the staged-diff fingerprint can equal the run's recorded-diff fingerprint when the
 * CONTENT is the same. Conservative — keeps +/-/context content lines and the file headers.
 */
function diffContentFingerprint(diff) {
    const norm = diff
        .split('\n')
        .filter((l) => !/^index [0-9a-f]+\.\.[0-9a-f]+/.test(l))
        .map((l) => l.replace(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@.*$/, '@@'))
        .join('\n')
        .trimEnd();
    return sha256Hex(norm);
}
/**
 * The per-project namespace segment under the runs root. BYTE-FOR-BYTE mirror of
 * extension.ts workspaceRunsKey() — `${basename}-${sha256(folder).slice(0,12)}` for a
 * workspace, `_no-workspace` otherwise. This MUST match exactly: the bundled supervisor
 * writes its run dirs (and now the flat verified bundle) under `<root>/<workspaceRunsKey>/`,
 * so a mismatched namespace here means the commit-message feature scans the WRONG directory
 * and finds no bundle to bind — no trailer ever fires. (Previously this used a 16-hex hash
 * of the folder with no basename prefix and `no-workspace`, which never matched the dir the
 * supervisor actually wrote to.)
 */
function workspaceRunsKeyForCommit() {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws)
        return '_no-workspace';
    const base = path.basename(ws).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'workspace';
    const hash = sha256Hex(ws).slice(0, 12);
    return `${base}-${hash}`;
}
/**
 * The path to the runs base for the current workspace. Mirrors extension.ts resolveRunsBase()'s
 * shape (the machine `glyphcode.runOutputRoot` setting, else ~/.glyphcode/runs), namespaced by
 * the SAME per-project key the supervisor writes under (workspaceRunsKeyForCommit) so a project
 * reads exactly its own runs. Best-effort; returns undefined when no base can be resolved.
 */
function resolveRunsBaseForCommit() {
    let root;
    try {
        const configured = vscode.workspace.getConfiguration('glyphcode').get('runOutputRoot', '');
        root = configured && configured.trim() ? configured.trim() : path.join(homeDir(), '.glyphcode', 'runs');
    }
    catch {
        root = path.join(homeDir(), '.glyphcode', 'runs');
    }
    if (!root)
        return undefined;
    return path.join(root, workspaceRunsKeyForCommit());
}
/**
 * Discover candidate run bundles under the workspace runs base. A bundle directory has a
 * `verdict.json`; we additionally read `verifier-public-key.pem` (bundle key), `actor-claims.json`
 * (claimed changed files), and any recorded diff artifact (for the content binding). Returns
 * newest-first by directory mtime. INJECTABLE via {@link CommitMessageDeps.discoverBundles} for
 * tests; the default reads disk. Best-effort; never throws (returns []).
 */
function defaultDiscoverBundles() {
    const base = resolveRunsBaseForCommit();
    if (!base)
        return [];
    let entries;
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const bundles = [];
    for (const ent of entries) {
        if (!ent.isDirectory())
            continue;
        const dir = path.join(base, ent.name);
        const verdict = readJson(path.join(dir, 'verdict.json'));
        if (!verdict)
            continue;
        let bundleKeyPem;
        try {
            const keyPath = path.join(dir, 'verifier-public-key.pem');
            if (fs.existsSync(keyPath))
                bundleKeyPem = fs.readFileSync(keyPath, 'utf8');
        }
        catch {
            /* no bundle key */
        }
        // Changed files: the actor's self-reported claim (NOT authoritative for trust, but a fine
        // SCOPE source — the content binding is what makes a citation honest). Field name varies by
        // emitter (capstone: claimedFilesChanged; scripted/autonomous: claimedChangedFiles).
        const claims = readJson(path.join(dir, 'actor-claims.json'));
        const changedFiles = extractClaimedFiles(claims);
        // Recorded diff for the content binding, when the bundle persisted one.
        const verifiedContentHash = readBundleDiffFingerprint(dir);
        let finishedAt = 0;
        try {
            finishedAt = fs.statSync(dir).mtimeMs;
        }
        catch {
            /* keep 0 */
        }
        bundles.push({
            dir,
            runId: typeof verdict['runId'] === 'string' ? verdict['runId'] : ent.name,
            verdict,
            bundleKeyPem,
            changedFiles,
            verifiedContentHash,
            finishedAt,
        });
    }
    bundles.sort((a, b) => b.finishedAt - a.finishedAt);
    return bundles;
}
/** Pull the claimed changed-file list out of an actor-claims object, tolerant of field names. */
function extractClaimedFiles(claims) {
    if (!claims)
        return [];
    const candidates = [claims['claimedFilesChanged'], claims['claimedChangedFiles'], claims['changedFiles']];
    for (const c of candidates) {
        if (Array.isArray(c)) {
            const files = c.filter((x) => typeof x === 'string');
            if (files.length)
                return files;
        }
    }
    return [];
}
/** A recorded-diff content fingerprint from a bundle, when a diff artifact exists. */
function readBundleDiffFingerprint(dir) {
    for (const rel of ['diff.patch', 'changes.diff', path.join('diff', 'diff.patch')]) {
        try {
            const p = path.join(dir, rel);
            if (fs.existsSync(p)) {
                const diff = fs.readFileSync(p, 'utf8');
                if (diff.trim().length > 0)
                    return diffContentFingerprint(diff);
            }
        }
        catch {
            /* try the next candidate */
        }
    }
    return undefined;
}
/** Map a discovered bundle to the pure-logic candidate descriptor. */
function toCandidate(b) {
    const verdict = (0, commitMessageLogic_1.normalizeVerdict)(typeof b.verdict.overallVerdict === 'string' ? b.verdict.overallVerdict : undefined, typeof b.verdict.assurance === 'string' ? b.verdict.assurance : undefined);
    return {
        runId: b.runId,
        changedFiles: b.changedFiles,
        ...(b.verifiedContentHash !== undefined ? { verifiedContentHash: b.verifiedContentHash } : {}),
        verdict,
        signatureVerified: verdictSignatureVerified(b.verdict, b.bundleKeyPem),
        committedSince: false, // newest-first scan; refined below if a commit landed after the run
        finishedAt: b.finishedAt,
    };
}
/* ============================================================== *
 * GATEWAY MESSAGE BUILDING (commit-message-specific; secret-firewalled)
 * ============================================================== */
const COMMIT_SYSTEM_PROMPT = 'You are a commit-message generator for a software engineer. Given a staged unified diff and ' +
    'OPTIONAL evidence metadata from a governed verification run, write a clear, accurate Git ' +
    'commit message. Output ONLY the message — a concise imperative subject line, a blank line, ' +
    'then a short body explaining WHAT changed and WHY. Ground every statement in the diff (and ' +
    'evidence) you are given; do NOT invent files, actions, or outcomes that are not shown. Do ' +
    'NOT claim the change was "verified", "tested", or "safe" — provenance is added separately by ' +
    'the tool, not by you. No markdown fences, no preamble like "Here is the commit message".';
/** Exposed for an optional test of the pinned system prompt. */
function commitMessageSystemPrompt() {
    return COMMIT_SYSTEM_PROMPT;
}
/** Build the governed-gateway transcript for ONE commit-message turn from the firewalled payload. */
function buildCommitMessages(diff, evidenceMeta) {
    const payload = (0, commitMessageLogic_1.buildGatewayRequestPayload)({ diff, evidenceMeta });
    const parts = ['Write a commit message for the following STAGED change.', ''];
    const m = payload.evidenceMeta;
    if (m.runId) {
        parts.push('Evidence metadata from the governed run that produced this change:');
        parts.push(`- run id: ${m.runId}`);
        if (m.verdict)
            parts.push(`- verifier verdict: ${m.verdict}`);
        if (typeof m.signatureVerified === 'boolean') {
            parts.push(`- verdict signature verified: ${m.signatureVerified}`);
        }
        if (m.correspondence)
            parts.push(`- correspondence to staged change: ${m.correspondence}`);
        parts.push('(Describe the change factually; do NOT assert verification — the tool adds provenance.)');
        parts.push('');
    }
    parts.push('Staged unified diff:');
    parts.push('```diff');
    parts.push(payload.diff);
    parts.push('```');
    return [
        { role: 'system', content: COMMIT_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n') },
    ];
}
/** Per-repo in-flight guard (AC30). Keyed by the repo root path. */
const inFlight = new Set();
/** Detect whether the staged change includes obvious binary/generated files (AC19), by name. */
function detectBinaryFiles(diff) {
    const out = [];
    const lines = diff.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (m && lines[i + 1] && /^(Binary files|GIT binary patch)/.test(lines[i + 1] ?? '')) {
            out.push(m[2]);
        }
    }
    return out;
}
/** The repo-relative paths of the staged (indexed) changes for a repository. */
function stagedFiles(repo) {
    const root = repo.rootUri.fsPath;
    return repo.state.indexChanges.map((c) => {
        const rel = path.relative(root, c.uri.fsPath).replace(/\\/g, '/');
        return rel;
    });
}
/**
 * Resolve the Git repository the command was invoked FOR (multi-root safe — AC22). The SCM
 * input passes its source-control as the command argument; we match its rootUri to a known
 * repository. Falls back to the single repository when there is exactly one, else undefined
 * (the caller refuses honestly rather than guessing across repos).
 */
function resolveInvokedRepository(api, arg) {
    // The SCM input-box command receives the SourceControl (with a rootUri) as its argument.
    const argRoot = arg && typeof arg === 'object' && 'rootUri' in arg
        ? (arg.rootUri?.toString())
        : undefined;
    if (argRoot) {
        const match = api.repositories.find((r) => r.rootUri.toString() === argRoot);
        if (match)
            return match;
    }
    if (api.repositories.length === 1)
        return api.repositories[0];
    // Multi-root with no usable arg: prefer the repo for the active editor's file, else undefined.
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
        const byActive = api.repositories
            .filter((r) => active.startsWith(r.rootUri.fsPath))
            .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
        if (byActive)
            return byActive;
    }
    return undefined;
}
/**
 * Register `glyphcode.generateCommitMessage`. WIRE this in extension.ts activate() next to the
 * other command registrations (mirrors registerInlineEdit / registerTerminalCmdK).
 *
 * NEVER throws into the host: every failure path resolves to an honest notice and returns,
 * leaving the commit input untouched (AC14).
 */
function registerGenerateCommitMessage(context, deps) {
    const discover = deps.discoverBundles ?? defaultDiscoverBundles;
    const disposable = vscode.commands.registerCommand('glyphcode.generateCommitMessage', (arg) => runGenerate(arg, deps, discover));
    context.subscriptions.push(disposable);
    return disposable;
}
/** The command body. Best-effort + never throws. */
async function runGenerate(arg, deps, discover) {
    const { output } = deps;
    try {
        // (1) Resolve the Git API + the invoked repository (AC22).
        const gitExt = vscode.extensions.getExtension('vscode.git');
        const exports = gitExt?.isActive ? gitExt.exports : await gitExt?.activate();
        const api = exports?.getAPI(1);
        if (!api) {
            void vscode.window.showWarningMessage(MSG.noGitExtension);
            return;
        }
        const repo = resolveInvokedRepository(api, arg);
        // (2) Refusal gate (AC12/AC13/AC28). Not-a-repo when no repository resolved.
        const staged = repo ? stagedFiles(repo) : [];
        const refusal = (0, commitMessageLogic_1.decideRefusal)({ inRepo: repo !== undefined, stagedCount: staged.length });
        if (refusal.kind === 'refuse') {
            const msg = refusal.reason === 'not-a-repo'
                ? MSG.notARepo
                : refusal.reason === 'nothing-staged'
                    ? MSG.nothingStaged
                    : MSG.gatewayFailed('the governed gateway is unavailable');
            void vscode.window.showWarningMessage(msg);
            return;
        }
        // repo is defined past the refusal gate.
        const repository = repo;
        const repoKey = repository.rootUri.toString();
        // (3) Concurrency guard (AC30): ignore a second invocation for the SAME repo.
        if (inFlight.has(repoKey)) {
            void vscode.window.showInformationMessage(MSG.inFlight);
            return;
        }
        inFlight.add(repoKey);
        try {
            await generateForRepository(repository, staged, deps, discover);
        }
        finally {
            inFlight.delete(repoKey);
        }
    }
    catch (err) {
        // Defense-in-depth: a command must NEVER throw into the host, and must NEVER clobber input.
        const detail = String(err?.message ?? err);
        output.appendLine(`[commit-message] threw (input left unchanged): ${detail}`);
        void vscode.window.showErrorMessage(MSG.gatewayFailed(detail));
    }
}
/** The staged-diff → evidence → gateway → sanitize → input flow for ONE repository. */
async function generateForRepository(repository, staged, deps, discover) {
    const { output, sessionFactory } = deps;
    // (4) Read the STAGED diff only (index vs HEAD) — never unstaged work (AC28).
    let fullDiff = '';
    try {
        fullDiff = await repository.diffIndexWithHEAD();
    }
    catch (err) {
        output.appendLine(`[commit-message] could not read the staged diff: ${String(err?.message ?? err)}`);
    }
    // Truncate for context budget (AC18).
    const diffTruncated = Buffer.byteLength(fullDiff, 'utf8') > MAX_DIFF_BYTES;
    const diff = diffTruncated ? fullDiff.slice(0, MAX_DIFF_BYTES) : fullDiff;
    const binaryFiles = detectBinaryFiles(fullDiff);
    // (5) Evidence: discover signed bundles, compute the staged-content fingerprint, and let the
    // PURE logic pick the single corresponding run (content-bound) and grade it.
    const stagedContentHash = fullDiff.trim().length > 0 ? diffContentFingerprint(fullDiff) : undefined;
    let correspondence = {
        run: null,
        grade: 'none',
        unverifiedStagedFiles: [],
        contentDiverged: false,
    };
    let traceRootHash;
    try {
        const bundles = discover();
        const candidates = bundles.map(toCandidate);
        correspondence = (0, commitMessageLogic_1.selectCorrespondingRun)({ stagedFiles: staged, stagedContentHash, candidates });
        if (correspondence.run) {
            const picked = bundles.find((b) => b.runId === correspondence.run.runId);
            const tr = picked?.verdict.traceRootHash;
            if (typeof tr === 'string')
                traceRootHash = tr;
        }
    }
    catch (err) {
        // Evidence selection is NON-fatal: fall back to an honest diff-only message (AC6/AC7).
        output.appendLine(`[commit-message] evidence selection failed (diff-only): ${String(err?.message ?? err)}`);
    }
    const verdict = correspondence.run?.verdict ?? 'fail';
    const evidenceMeta = correspondence.run
        ? {
            runId: correspondence.run.runId,
            verdict,
            signatureVerified: correspondence.run.signatureVerified,
            correspondence: correspondence.grade,
            changedFiles: correspondence.run.changedFiles,
            ...(traceRootHash ? { traceRootHash } : {}),
        }
        : {};
    // (6) Generate via the governed gateway under progress + cancellation (AC9/AC15/AC23).
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: MSG.progressTitle, cancellable: true }, (_progress, token) => requestCommitMessage(diff, evidenceMeta, sessionFactory, output, token));
    if (result.cancelled) {
        void vscode.window.showInformationMessage(MSG.cancelled);
        return; // input untouched (AC15)
    }
    if (!result.ok) {
        void vscode.window.showErrorMessage(MSG.gatewayFailed(result.error ?? 'the gateway did not complete'));
        return; // input untouched (AC14)
    }
    // (7) Sanitize the reply; refuse to fill an empty/garbage message (AC16).
    const body = (0, commitMessageLogic_1.sanitizeCommitMessage)(result.text ?? '', {
        diffTruncated,
        binaryFiles,
        conventionalCommits: conventionalCommitsEnabled(),
    });
    if (body.trim().length === 0) {
        void vscode.window.showWarningMessage(MSG.emptyReply);
        return; // input untouched (AC16)
    }
    // (8) Trailer: emitted ONLY for a signed, corresponding run (AC3/AC4/AC6/AC8/AC27/AC29).
    const trailer = (0, commitMessageLogic_1.decideTrailer)({
        verdict,
        signatureVerified: correspondence.run?.signatureVerified ?? false,
        correspondence,
        trailerEnabled: verifiedTrailerEnabled(),
    }, traceRootHash);
    let finalMessage = trailer ? `${body}\n\n${trailer}` : body;
    // Honest note when staged content diverged from the last verified run (AC27).
    if (!trailer && correspondence.contentDiverged) {
        finalMessage = `${body}\n\n(Note: the staged content has diverged from the last verified run; no verification is claimed.)`;
    }
    // (9) Replace-with-confirm (AC17): only prompt when the input is already non-empty.
    const existing = repository.inputBox.value;
    if (existing.trim().length > 0) {
        const choice = await vscode.window.showWarningMessage(MSG.replaceConfirm, { modal: true }, MSG.replaceYes, MSG.replaceKeep);
        if (choice !== MSG.replaceYes) {
            output.appendLine('[commit-message] user kept their existing commit text; not replaced.');
            return; // existing text preserved (AC17)
        }
    }
    // (10) Pre-fill the input. NEVER commit/stage/push (AC11).
    repository.inputBox.value = finalMessage;
    output.appendLine(`[commit-message] filled commit input (trailer=${trailer ? 'yes' : 'no'}, grade=${correspondence.grade}).`);
}
/** Whether the verified-trailer setting is on (default true). */
function verifiedTrailerEnabled() {
    try {
        return vscode.workspace.getConfiguration('glyphcode').get('commitMessage.verifiedTrailer', true);
    }
    catch {
        return true;
    }
}
/** Whether Conventional-Commits shaping is on (default false). */
function conventionalCommitsEnabled() {
    try {
        return vscode.workspace.getConfiguration('glyphcode').get('commitMessage.conventionalCommits', false);
    }
    catch {
        return false;
    }
}
/**
 * Run ONE governed commit-message turn through the injected session factory (MIRRORS
 * terminalCmdK.ts requestTerminalCommand). Best-effort + NEVER throws; a connect failure, a
 * turn error, a timeout, or a cancellation resolves as {ok:false}/{cancelled:true} so the
 * caller leaves the commit input unchanged. GOVERNED + metadata-traced; secret-firewalled
 * (the messages carry only the redacted diff + evidence metadata).
 */
async function requestCommitMessage(diff, evidenceMeta, sessionFactory, output, token) {
    let session;
    let timer;
    try {
        output.appendLine('[commit-message] governed gateway generation requested.');
        const opened = await sessionFactory.open();
        if (!opened.connected || !opened.session) {
            return { ok: false, error: opened.message || 'could not open the governed gateway session.' };
        }
        if (token?.isCancellationRequested) {
            opened.session.dispose();
            return { ok: false, cancelled: true };
        }
        session = opened.session;
        const messages = buildCommitMessages(diff, evidenceMeta);
        let accumulated = '';
        let turnError;
        // Time budget (AC23/AC14): race the turn against a timeout.
        const turn = (0, chatParticipant_1.runGatewayTurn)(opened.session, messages, (text) => {
            accumulated += text;
        }, (message) => {
            turnError = message;
        });
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ ok: false, message: 'the governed gateway exceeded the time budget.' }), GATEWAY_TIMEOUT_MS);
        });
        const outcome = await Promise.race([turn, timeout]);
        if (token?.isCancellationRequested)
            return { ok: false, cancelled: true };
        if (!outcome.ok) {
            return { ok: false, error: turnError ?? outcome.message ?? 'the governed gateway did not complete.' };
        }
        if (accumulated.trim().length === 0) {
            return { ok: false, error: 'the governed gateway returned an empty reply.' };
        }
        return { ok: true, text: accumulated };
    }
    catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
    }
    finally {
        if (timer)
            clearTimeout(timer);
        try {
            session?.dispose();
        }
        catch {
            /* best-effort teardown */
        }
    }
}
//# sourceMappingURL=commitMessage.js.map