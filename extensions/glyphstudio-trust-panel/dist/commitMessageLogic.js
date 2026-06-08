"use strict";
/*
 * GlyphStudio EVIDENCE-GROUNDED AI COMMIT MESSAGE — the PURE, headless-testable core.
 *
 * commitMessage.ts is the vscode-facing command (Git API, gateway, input box, progress);
 * THIS module is its vscode-free decision core. Per docs/commit-message-acceptance-criteria.md
 * the trust-critical decisions live here so they are unit-PROVEN rather than GUI-only:
 *
 *   - selectCorrespondingRun  — "Corresponds" gate (covers files + most-recent-no-intervening
 *                               -commit + CONTENT binding). AC1/AC7/AC8/AC20/AC27/AC29.
 *   - decideTrailer           — emit a verification trailer ONLY when a verdict's signature
 *                               verified AND it corresponds to the staged content.
 *                               AC3/AC4/AC6/AC8/AC25/AC27/AC29.
 *   - sanitizeCommitMessage   — raw reply → final message; strip fences, enforce subject
 *                               length, optional Conventional-Commits shaping, note
 *                               truncation, never assert beyond inputs. AC5/AC16/AC18/AC19.
 *   - decideRefusal           — repo? staged? gateway ok? → generate vs honest refuse.
 *                               AC12/AC13/AC14.
 *   - buildGatewayRequestPayload — secret-firewall request shape: ONLY diff + evidence
 *                               metadata, best-effort secret redaction, NEVER env. AC10/AC31.
 *   - TRAILER format constant + parse helper — deterministic, machine-parseable. AC25.
 *
 * PURITY: this module imports NOTHING from `vscode`, `node:*`, or the DOM. The content
 * fingerprint is supplied by the caller (the imperative layer hashes the staged diff with
 * node:crypto), so this core only COMPARES fingerprints — it never computes a hash itself.
 * The test imports the compiled dist/ output DIRECTLY, exactly like terminalCommandGen.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVIDENCE_META_KEYS = exports.TRAILER_SEP = exports.TRACE_TRAILER_PREFIX = exports.VERIFIED_TRAILER_PREFIX = void 0;
exports.normalizeVerdict = normalizeVerdict;
exports.selectCorrespondingRun = selectCorrespondingRun;
exports.decideTrailer = decideTrailer;
exports.parseTrailer = parseTrailer;
exports.sanitizeCommitMessage = sanitizeCommitMessage;
exports.decideRefusal = decideRefusal;
exports.redactObviousSecrets = redactObviousSecrets;
exports.buildGatewayRequestPayload = buildGatewayRequestPayload;
/**
 * Map a raw verifier `overallVerdict` (+ optional assurance) onto the three states the
 * commit trailer reflects. PURE. A `pass` with `degraded` assurance is honestly reported as
 * `degraded` (never a clean pass). `error` and anything unrecognized collapse to `fail` so a
 * non-passing verdict is NEVER reflected as a pass (AC4).
 */
function normalizeVerdict(overall, assurance) {
    if (overall === 'pass') {
        return assurance === 'degraded' ? 'degraded' : 'pass';
    }
    if (overall === 'degraded')
        return 'degraded';
    // 'fail', 'error', undefined, or anything else → honest non-pass.
    return 'fail';
}
/** Normalize a path list to a de-duped, comparable set (forward slashes, trimmed). */
function normalizePaths(paths) {
    const out = new Set();
    if (!Array.isArray(paths))
        return out;
    for (const p of paths) {
        if (typeof p !== 'string')
            continue;
        const norm = p.replace(/\\/g, '/').trim();
        if (norm.length > 0)
            out.add(norm);
    }
    return out;
}
/** True iff `sub` is a non-empty subset of `sup`. */
function isSubset(sub, sup) {
    if (sub.size === 0)
        return false;
    for (const x of sub) {
        if (!sup.has(x))
            return false;
    }
    return true;
}
/**
 * Select the SINGLE run that corresponds to the staged change, per the domain definition:
 *   (a) its (signed) verdict covers the staged file set,
 *   (b) it is the most recent such run with NO intervening commit, AND
 *   (c) the staged CONTENT matches what the verdict actually verified (content binding) —
 *       filename overlap alone does NOT count.
 *
 * PURE + the highest-value trust test. Returns the best run + a grade:
 *   - A run is ELIGIBLE only if signatureVerified (AC8: unsigned/tampered ⇒ no evidence) and
 *     it has NOT been superseded by an intervening commit (AC7).
 *   - FULL correspondence: an eligible run whose changedFiles ⊇ the staged files AND whose
 *     verifiedContentHash === the staged content fingerprint (a real content binding).
 *   - PARTIAL correspondence: an eligible run whose changedFiles are a SUBSET of the staged
 *     files (the run verified only some of what's staged) AND the content binds. The whole
 *     change is not verified (AC29). Full beats partial.
 *   - Among equally-graded candidates, selection is DETERMINISTIC: highest finishedAt wins,
 *     ties broken by runId (AC20).
 *   - contentDiverged is reported when an eligible run COVERS the staged files but the content
 *     fingerprint does NOT bind (post-run hand edit — AC27) and no better match exists, so the
 *     caller can fall back to diff-only and honestly note the divergence.
 *
 * NEVER throws; malformed inputs degrade to grade 'none'.
 */
function selectCorrespondingRun(input) {
    const none = {
        run: null,
        grade: 'none',
        unverifiedStagedFiles: [],
        contentDiverged: false,
    };
    const staged = normalizePaths(input?.stagedFiles);
    if (staged.size === 0)
        return none; // nothing staged ⇒ nothing to correspond to (AC13/AC28)
    const stagedHash = typeof input?.stagedContentHash === 'string' ? input.stagedContentHash : undefined;
    const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
    const fullMatches = [];
    const partialMatches = [];
    let sawCoveringButDiverged = false;
    for (const cand of candidates) {
        if (!cand || typeof cand.runId !== 'string')
            continue;
        // (a-pre) AC8: an unsigned/tampered bundle is treated as NO evidence — never eligible.
        if (cand.signatureVerified !== true)
            continue;
        // (b) AC7: a run superseded by an intervening commit is stale — never eligible.
        if (cand.committedSince === true)
            continue;
        const runFiles = normalizePaths(cand.changedFiles);
        if (runFiles.size === 0)
            continue;
        const covers = isSubset(staged, runFiles); // run changed >= every staged file
        const subsetOfStaged = isSubset(runFiles, staged); // run changed only some staged files
        // (c) CONTENT binding: the staged fingerprint must equal what the verdict verified.
        const contentBinds = stagedHash !== undefined &&
            typeof cand.verifiedContentHash === 'string' &&
            cand.verifiedContentHash.length > 0 &&
            cand.verifiedContentHash === stagedHash;
        if (covers) {
            if (contentBinds) {
                fullMatches.push(cand);
            }
            else {
                // Covered the files but the content does NOT bind: a post-run hand edit (AC27) — or
                // the bundle records no bindable content. Record it so the caller can fall back to
                // diff-only and honestly note the divergence if nothing better corresponds.
                sawCoveringButDiverged = true;
            }
        }
        else if (subsetOfStaged && contentBinds) {
            // The run verified only a SUBSET of the staged files (AC29). Partial, content-bound.
            partialMatches.push({ run: cand, verified: runFiles });
        }
    }
    // Deterministic recency ordering: highest finishedAt first, ties by runId (AC20).
    const byRecency = (a, b) => {
        const fa = typeof a.finishedAt === 'number' ? a.finishedAt : -Infinity;
        const fb = typeof b.finishedAt === 'number' ? b.finishedAt : -Infinity;
        if (fa !== fb)
            return fb - fa;
        return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
    };
    if (fullMatches.length > 0) {
        fullMatches.sort(byRecency);
        return { run: fullMatches[0], grade: 'full', unverifiedStagedFiles: [], contentDiverged: false };
    }
    if (partialMatches.length > 0) {
        partialMatches.sort((x, y) => byRecency(x.run, y.run));
        const best = partialMatches[0];
        const unverified = [];
        for (const f of staged) {
            if (!best.verified.has(f))
                unverified.push(f);
        }
        unverified.sort();
        return {
            run: best.run,
            grade: 'partial',
            unverifiedStagedFiles: unverified,
            contentDiverged: false,
        };
    }
    // Nothing corresponds. Surface contentDiverged only when a SIGNED run covered the staged
    // files but the content failed to bind (the AC27 post-run-edit case), so the caller can add
    // the honest divergence note. A plain "no evidence" case leaves it false.
    return { ...none, contentDiverged: sawCoveringButDiverged };
}
/* ============================================================== *
 * PROVENANCE TRAILER (AC25 — single consistent, machine-parseable format)
 * ============================================================== */
/**
 * The provenance trailer format (LOCKED). A `Verified:` line citing the verdict + run id, and
 * a separate `Trace:` line citing the trace-root hash. Kept as a constant so the builder, the
 * parser, and the test all agree byte-for-byte (deterministic citation — AC25).
 *
 * Example:
 *   Verified: pass · run abc123
 *   Trace: 6d7e8f90…
 */
exports.VERIFIED_TRAILER_PREFIX = 'Verified:';
exports.TRACE_TRAILER_PREFIX = 'Trace:';
/** The middot separator between the verdict and the run citation. */
exports.TRAILER_SEP = ' · ';
/**
 * Decide the provenance trailer to append, or null for NO trailer. PURE; the highest-value
 * honesty gate.
 *
 *   - NO trailer (null) when: the setting is off; OR no run corresponds (grade 'none' — AC6/
 *     AC7/AC8/AC27); OR the selected run's signature did not verify (AC3/AC8); OR there is no
 *     run at all.
 *   - A trailer is emitted ONLY when signatureVerified AND a run corresponds (full or
 *     partial). The trailer states the verdict HONESTLY: a 'fail'/'degraded' verdict is
 *     reflected as such, never as a pass (AC4).
 *   - PARTIAL correspondence (AC29) annotates the verdict as e.g. `pass (partial)` so the
 *     trailer never claims the WHOLE staged change was verified.
 *   - Always two lines: the `Verified:` citation and the `Trace:` root-hash citation (when a
 *     trace root is known). Deterministic for the same run (AC25).
 *
 * Returns the multi-line trailer string (no trailing newline) or null.
 */
function decideTrailer(input, traceRootHash) {
    if (!input || input.trailerEnabled !== true)
        return null;
    const corr = input.correspondence;
    if (!corr || corr.run === null || corr.grade === 'none')
        return null;
    // AC3/AC8: a verification claim REQUIRES a verified signature on the cited run.
    if (input.signatureVerified !== true || corr.run.signatureVerified !== true)
        return null;
    // AC4: reflect the verdict honestly. AC29: scope a partial claim.
    const verdictText = corr.grade === 'partial' ? `${input.verdict} (partial)` : input.verdict;
    const verifiedLine = `${exports.VERIFIED_TRAILER_PREFIX} ${verdictText}${exports.TRAILER_SEP}run ${corr.run.runId}`;
    const lines = [verifiedLine];
    if (typeof traceRootHash === 'string' && traceRootHash.trim().length > 0) {
        lines.push(`${exports.TRACE_TRAILER_PREFIX} ${traceRootHash.trim()}`);
    }
    return lines.join('\n');
}
/**
 * Parse a provenance trailer back into its fields (the inverse of {@link decideTrailer}).
 * Machine-parseable + deterministic (AC25). Scans the given text for the `Verified:` line
 * (and an adjacent `Trace:` line); returns null when no well-formed `Verified:` line is found.
 * Tolerant of surrounding commit body text so a reviewer's tool can parse a full message.
 */
function parseTrailer(text) {
    if (typeof text !== 'string')
        return null;
    const lines = text.split(/\r?\n/);
    let verdict;
    let partial = false;
    let runId;
    let traceRootHash;
    for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith(exports.VERIFIED_TRAILER_PREFIX)) {
            const rest = line.slice(exports.VERIFIED_TRAILER_PREFIX.length).trim();
            // <verdict>[ (partial)] · run <id>
            const sepIdx = rest.indexOf('·');
            if (sepIdx < 0)
                continue;
            let verdictPart = rest.slice(0, sepIdx).trim();
            const runPart = rest.slice(sepIdx + 1).trim().replace(/^run\s+/i, '').trim();
            const partialMatch = verdictPart.match(/\(partial\)\s*$/i);
            if (partialMatch) {
                partial = true;
                verdictPart = verdictPart.slice(0, partialMatch.index).trim();
            }
            if (verdictPart.length > 0 && runPart.length > 0) {
                verdict = verdictPart;
                runId = runPart;
            }
        }
        else if (line.startsWith(exports.TRACE_TRAILER_PREFIX)) {
            const h = line.slice(exports.TRACE_TRAILER_PREFIX.length).trim();
            if (h.length > 0)
                traceRootHash = h;
        }
    }
    if (verdict === undefined || runId === undefined)
        return null;
    return {
        verdict,
        partial,
        runId,
        ...(traceRootHash !== undefined ? { traceRootHash } : {}),
    };
}
/** Allowed Conventional-Commits types (the subject is coerced to one of these when enabled). */
const CONVENTIONAL_TYPES = [
    'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
];
/** A line matching `type(scope): summary` or `type: summary` for a valid Conventional subject. */
const CONVENTIONAL_RE = new RegExp(`^(${CONVENTIONAL_TYPES.join('|')})(\\([^)]*\\))?!?: .+`);
/**
 * Turn a raw gateway reply into the final commit message body. PURE + unit-tested. NEVER
 * asserts beyond its inputs (AC5): it only cleans/shapes the model's own text and appends
 * honest, input-derived notes (truncation, binary files). It does NOT add the provenance
 * trailer — the caller appends {@link decideTrailer}'s output so the trailer can NEVER be
 * fabricated by the model.
 *
 *   1. Strip a wrapping ``` … ``` fence (models often wrap the whole message), or a partial
 *      opening/closing fence.
 *   2. Drop a leading "Commit message:" / "Here is…" style preamble line if present.
 *   3. Enforce the subject (first non-empty line) length; if it exceeds the cap, hard-truncate
 *      with an ellipsis and append an honest "(subject truncated)" note in the body.
 *   4. Optionally coerce the subject to Conventional Commits: if it is not already a valid
 *      `type(...): …` line, prefix `chore: ` (a conservative, non-asserting default — never
 *      invents a scope or a more specific type).
 *   5. Append honest, input-derived notes: a truncated-diff note (AC18) and a binary/generated
 *      files note (AC19) when those inputs say so and the message doesn't already mention them.
 *
 * Returns '' when nothing usable remains (AC16) — the caller refuses to fill the input with an
 * empty/garbage message and shows the honest "no message could be generated" note.
 */
function sanitizeCommitMessage(raw, opts = {}) {
    if (typeof raw !== 'string')
        return '';
    const maxSubject = typeof opts.maxSubjectLength === 'number' && opts.maxSubjectLength > 0
        ? Math.floor(opts.maxSubjectLength)
        : 72;
    let text = raw;
    // (1) Drop a leading preamble line ("Commit message:", "Here is the commit message:", …)
    //     FIRST, so a "Here is the message:\n```…```" reply is handled before fence stripping.
    const preamble = /^(here(?:'s| is)?\b.*|commit message\s*:?|sure\b.*|certainly\b.*)$/i;
    {
        const pre = text.split(/\r?\n/);
        while (pre.length > 0 && pre[0].trim().length === 0)
            pre.shift();
        if (pre.length > 1 && preamble.test(pre[0].trim())) {
            pre.shift();
            while (pre.length > 0 && pre[0].trim().length === 0)
                pre.shift();
            text = pre.join('\n');
        }
    }
    // (2) Strip a wrapping fenced block if the (remaining) reply is fenced; else drop a partial
    //     fence (opening fence with/without a dangling close).
    const fenced = text.match(/^\s*```[^\n]*\n([\s\S]*?)```\s*$/);
    if (fenced) {
        text = fenced[1];
    }
    else {
        const openFence = text.match(/^\s*```[^\n]*\n([\s\S]*)$/);
        if (openFence)
            text = openFence[1].replace(/\n?\s*```\s*$/u, '');
    }
    // Split into lines; drop leading blank lines.
    const lines = text.split(/\r?\n/);
    while (lines.length > 0 && lines[0].trim().length === 0)
        lines.shift();
    if (lines.length === 0)
        return '';
    // A second-pass preamble guard in case the preamble lived INSIDE the fence.
    if (lines.length > 1 && preamble.test(lines[0].trim())) {
        lines.shift();
        while (lines.length > 0 && lines[0].trim().length === 0)
            lines.shift();
    }
    if (lines.length === 0)
        return '';
    // (3) Subject = first non-empty line; enforce length.
    let subject = lines[0].trim();
    if (subject.length === 0)
        return '';
    let subjectTruncated = false;
    const body = lines.slice(1);
    // (4) Optional Conventional-Commits shaping (before length enforcement so the prefix counts).
    if (opts.conventionalCommits === true && !CONVENTIONAL_RE.test(subject)) {
        // Conservative, non-asserting default: never invent a scope or a more specific type.
        subject = `chore: ${subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')}`;
    }
    if (subject.length > maxSubject) {
        // Hard-truncate with an ellipsis; the honest note is appended to the body.
        subject = subject.slice(0, Math.max(1, maxSubject - 1)).trimEnd() + '…';
        subjectTruncated = true;
    }
    // Reassemble: subject, a blank line, then the (trimmed) body.
    const out = [subject];
    // Trim leading/trailing blank lines from the body.
    while (body.length > 0 && body[0].trim().length === 0)
        body.shift();
    while (body.length > 0 && body[body.length - 1].trim().length === 0)
        body.pop();
    if (body.length > 0) {
        out.push('');
        for (const b of body)
            out.push(b.replace(/\s+$/u, ''));
    }
    const notes = [];
    if (subjectTruncated)
        notes.push('(subject truncated)');
    if (opts.diffTruncated === true) {
        notes.push('(diff summarized/truncated for context budget; message describes a representative summary)');
    }
    const binaries = normalizePaths(opts.binaryFiles);
    if (binaries.size > 0) {
        const joined = [...binaries].sort();
        const already = out.join('\n');
        const unmentioned = joined.filter((f) => !already.includes(f));
        if (unmentioned.length > 0) {
            notes.push(`Binary/generated files (referenced by name): ${unmentioned.join(', ')}`);
        }
    }
    if (notes.length > 0) {
        out.push('');
        for (const n of notes)
            out.push(n);
    }
    return out.join('\n').trimEnd();
}
/**
 * Decide whether to generate or refuse, with an honest reason. PURE.
 *   - not in a repo → refuse 'not-a-repo' (AC12); no text is fabricated.
 *   - in a repo with 0 staged → refuse 'nothing-staged' (AC13/AC28); never silently use
 *     unstaged work.
 *   - gatewayReachable === false → refuse 'gateway-unreachable' (AC14, the up-front case);
 *     a runtime gateway failure is handled by the caller WITHOUT clobbering the input.
 *   - otherwise → generate.
 */
function decideRefusal(input) {
    if (!input || input.inRepo !== true)
        return { kind: 'refuse', reason: 'not-a-repo' };
    const staged = typeof input.stagedCount === 'number' ? input.stagedCount : 0;
    if (staged <= 0)
        return { kind: 'refuse', reason: 'nothing-staged' };
    if (input.gatewayReachable === false)
        return { kind: 'refuse', reason: 'gateway-unreachable' };
    return { kind: 'generate' };
}
/**
 * Best-effort secret-shaped-line redaction over a diff before it leaves the machine (AC31).
 * PURE + conservative: it redacts the VALUE on ADDED ('+') lines that look like a secret
 * assignment (`KEY=...`, `key: ...`, `Authorization: Bearer …`) or a long high-entropy token,
 * replacing the value with `***REDACTED***` while preserving the diff structure (so the diff
 * stays auditable per AC31). It NEVER drops lines and NEVER touches '-'/context lines' meaning
 * beyond the value. This does not claim to catch every secret — it only avoids amplifying the
 * obvious ones the feature itself introduced into the request.
 */
function redactObviousSecrets(diff) {
    if (typeof diff !== 'string' || diff.length === 0)
        return '';
    const SECRET_KEY = /(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth)/i;
    const lines = diff.split('\n');
    const out = [];
    for (const line of lines) {
        // Only consider ADDED lines (the content this change introduces). Diff headers
        // ('+++ b/…') start with '+++' and are left intact.
        if (line.startsWith('+') && !line.startsWith('+++')) {
            const body = line.slice(1);
            let redacted = body;
            // Authorization: Bearer/Basic/Token <token> (header-style) FIRST so the scheme keyword
            // is preserved and the generic KEY=VALUE rule below doesn't swallow it.
            redacted = redacted.replace(/^(\s*authorization\s*[:=]\s*(?:bearer|basic|token)\s+).+$/i, (_m, pre) => `${pre}***REDACTED***`);
            // KEY=VALUE / KEY: VALUE where KEY looks secret-y (only if not already redacted above).
            if (redacted === body) {
                redacted = redacted.replace(/^(\s*['"]?[A-Za-z0-9_.-]*?)(pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth(?:orization)?)([A-Za-z0-9_.-]*['"]?\s*[:=]\s*)(.+)$/i, (_m, pre, mid, post) => `${pre}${mid}${post}***REDACTED***`);
            }
            // A bare long high-entropy token on its own (e.g. an AWS-key-shaped string).
            if (redacted === body) {
                redacted = redacted.replace(/\b([A-Za-z0-9_\-]{32,}|AKIA[0-9A-Z]{12,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '***REDACTED***');
            }
            out.push('+' + redacted);
            if (SECRET_KEY.test(body) && redacted === body) {
                // Key looked secret-y but no value pattern matched — leave as-is (avoid mangling).
            }
        }
        else {
            out.push(line);
        }
    }
    return out.join('\n');
}
/**
 * Build the governed-gateway request payload. SECRET FIREWALL (AC10/AC31): the returned object
 * contains ONLY the (secret-redacted) staged diff and the explicitly-allowed evidence metadata
 * fields. It NEVER includes process environment, tokens, or any field outside
 * {@link EvidenceMeta}. PURE — the caller passes the diff + metadata; this assembles + redacts.
 *
 * The evidenceMeta is rebuilt field-by-field from an allow-list so an accidental extra property
 * on the caller's object can never ride along to the gateway.
 */
function buildGatewayRequestPayload(input) {
    const diff = typeof input?.diff === 'string' ? input.diff : '';
    const src = input?.evidenceMeta ?? {};
    // ALLOW-LIST rebuild — only these fields can leave. No env, no extras.
    const evidenceMeta = {};
    if (typeof src.runId === 'string')
        evidenceMeta.runId = src.runId;
    if (src.verdict === 'pass' || src.verdict === 'fail' || src.verdict === 'degraded') {
        evidenceMeta.verdict = src.verdict;
    }
    if (typeof src.signatureVerified === 'boolean')
        evidenceMeta.signatureVerified = src.signatureVerified;
    if (src.correspondence === 'full' || src.correspondence === 'partial' || src.correspondence === 'none') {
        evidenceMeta.correspondence = src.correspondence;
    }
    if (Array.isArray(src.changedFiles)) {
        evidenceMeta.changedFiles = src.changedFiles.filter((f) => typeof f === 'string');
    }
    if (typeof src.traceRootHash === 'string')
        evidenceMeta.traceRootHash = src.traceRootHash;
    return {
        diff: redactObviousSecrets(diff),
        evidenceMeta,
    };
}
/** The allow-listed evidence-metadata keys — exported so the secret-firewall test can assert. */
exports.EVIDENCE_META_KEYS = [
    'runId',
    'verdict',
    'signatureVerified',
    'correspondence',
    'changedFiles',
    'traceRootHash',
];
//# sourceMappingURL=commitMessageLogic.js.map