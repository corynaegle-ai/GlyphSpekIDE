/*
 * GlyphCode INDEPENDENT VERIFIER rail surface — webview renderer (Spec §5.9 / §5.8 /
 * §2.2). Vanilla JS, no framework, CSP-nonce loaded.
 *
 * WHAT IT RENDERS
 *   - the isolated-domain banner (static, in the HTML shell),
 *   - the verification targets (derived from the verdict's policy-sourced checks),
 *   - the "run verifier" affordance LABEL (static),
 *   - recent verdicts as PENDING -> PASS·SIGNED -> UNTRUSTED cards, each with the
 *     Ed25519 signature line + the signing-key fingerprint.
 *
 * THE HONESTY GATE (the ship-gating rule, §2.2 signature-before-display)
 *   A verdict renders authoritative (blue, PASS·SIGNED) ONLY after its Ed25519
 *   detached signature VERIFIES in-browser, here, against an OUT-OF-BAND trusted key
 *   (window.GLYPHCODE_TRUSTED_VERIFIER_KEYS — the SAME trust root the Trust Panel
 *   pins, injected by the host before this script). This is the byte-for-byte SAME
 *   gate media/app.js runs:
 *       message = UTF-8( canonicalJson({ traceRootHash, verdict-without-signature }) )
 *   and the trace-binding leg (verdict.traceRootHash must equal the run's live
 *   trace root) so a valid signature over a DIFFERENT trace is not presented as blue.
 *
 *   This surface NEVER paints blue from a stream claim, an actor-claimed verdict, or
 *   the bundle-supplied key. A missing / invalid / untrusted-key signature, a tamper
 *   or stale-verifier failure, or a non-isolated runtime all render UNTRUSTED (red) —
 *   never green/blue. PENDING is the honest pre-verification state.
 *
 * The host (verifierViewProvider.ts) validates + folds the run/event stream and posts
 * a render message; it NEVER tells this view a verdict is trusted. The crypto verdict
 * is decided only here, exactly as the panel decides it.
 */

'use strict';

(function () {
  /* ------------------------------------------------------------------ *
   * Canonical JSON — byte-for-byte port of spikes/p0-trace/canonical-json.ts.
   * MUST match the signer, or signatures will not verify. (Same as app.js.)
   * ------------------------------------------------------------------ */
  function canonicalJson(obj) {
    return canonicalEncode(obj);
  }
  function canonicalEncode(value) {
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (t === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
      const parts = value.map((item) => (item === undefined ? 'null' : canonicalEncode(item)));
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const key of keys) {
        const v = value[key];
        if (v === undefined) continue;
        parts.push(JSON.stringify(key) + ':' + canonicalEncode(v));
      }
      return '{' + parts.join(',') + '}';
    }
    if (t === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
    return 'undefined';
  }

  /**
   * The exact canonical message bytes the verifier signed: strip the verdict's own
   * `signature` field, then canonicalize { traceRootHash, verdict }. Identical to
   * app.js verdictMessageBytes so this surface verifies what the panel verifies.
   */
  function verdictMessageBytes(verdict) {
    const core = {};
    for (const k of Object.keys(verdict)) {
      if (k === 'signature') continue;
      core[k] = verdict[k];
    }
    const json = canonicalJson({ traceRootHash: core.traceRootHash, verdict: core });
    return new TextEncoder().encode(json);
  }

  function base64ToBytes(b64) {
    const clean = String(b64).replace(/\s+/g, '');
    const bin = atob(clean); // throws on invalid base64
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function publicKeyToDer(keyText) {
    const text = String(keyText).trim();
    const body = text
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
    return base64ToBytes(body);
  }

  function bytesToHex(buf) {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function hasWebCryptoSubtle() {
    return typeof crypto !== 'undefined' && crypto && typeof crypto.subtle !== 'undefined';
  }

  /* ------------------------------------------------------------------ *
   * PINNED TRUST ROOT (out-of-band) — read ONLY from the host-injected global, the
   * SAME set the Trust Panel pins (operator `glyphcode.trustedVerifierKeys` + the
   * extension keystore public key). NEVER from a stream/bundle-supplied key. A
   * verdict can reach blue ONLY if it verifies against one of these.
   * ------------------------------------------------------------------ */
  function trustedVerifierKeys() {
    const injected =
      typeof window !== 'undefined' && Array.isArray(window.GLYPHCODE_TRUSTED_VERIFIER_KEYS)
        ? window.GLYPHCODE_TRUSTED_VERIFIER_KEYS
        : [];
    const ids = new Set();
    const keys = [];
    for (const k of injected) {
      if (typeof k !== 'string' || !k.trim()) continue;
      let id;
      try { id = bytesToHex(publicKeyToDer(k)); } catch (_) { continue; }
      if (ids.has(id)) continue;
      ids.add(id);
      keys.push(k);
    }
    return keys;
  }

  /** Import one SPKI key and verify; returns true|false|'unsupported'. Never throws. */
  async function verifyWithKey(keyText, sigBytes, msg) {
    let der, key;
    try { der = publicKeyToDer(keyText); } catch (_) { return false; }
    try {
      key = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    } catch (_) {
      return 'unsupported';
    }
    try {
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, msg);
    } catch (_) {
      return false;
    }
  }

  /**
   * Verify a verdict's Ed25519 signature against the pinned out-of-band trust root.
   * Returns (never throws): { status, detail, trusted }
   *   status ∈ 'verified'|'failed'|'no-signature'|'no-key'|'unsupported'|'error'
   *   trusted: true ONLY when a pinned out-of-band key verified the signature.
   * Mirrors app.js verifyVerdictSignature (PRODUCT tier). A bundle/stream-supplied
   * key is NEVER consulted here — only the host-pinned trust root can confer blue.
   */
  async function verifyVerdictSignature(verdict) {
    const sig = verdict && verdict.signature;
    if (!sig || typeof sig.value !== 'string') {
      return { status: 'no-signature', detail: 'verdict carries no signature', trusted: false };
    }
    if (sig.alg !== 'ed25519') {
      return { status: 'failed', detail: 'unsupported signature alg: ' + sig.alg, trusted: false };
    }
    if (!hasWebCryptoSubtle()) {
      return { status: 'unsupported', detail: 'Web Crypto (crypto.subtle) unavailable', trusted: false };
    }
    let sigBytes;
    try { sigBytes = base64ToBytes(sig.value); }
    catch (err) { return { status: 'error', detail: 'malformed signature: ' + err.message, trusted: false }; }

    const msg = verdictMessageBytes(verdict);
    const keys = trustedVerifierKeys();
    if (keys.length === 0) {
      return { status: 'no-key', detail: 'no trusted out-of-band verifier key pinned', trusted: false };
    }
    for (const keyText of keys) {
      const ok = await verifyWithKey(keyText, sigBytes, msg);
      if (ok === 'unsupported') {
        return { status: 'unsupported', detail: 'this browser lacks Web Crypto Ed25519 support', trusted: false };
      }
      if (ok === true) {
        return {
          status: 'verified',
          detail: 'Ed25519 signature valid against a TRUSTED (out-of-band) verifier key',
          trusted: true,
        };
      }
    }
    return { status: 'failed', detail: 'signature does NOT verify against any pinned trusted key', trusted: false };
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers.
   * ------------------------------------------------------------------ */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function argvStr(argv) { return Array.isArray(argv) ? argv.join(' ') : ''; }
  function shortHash(h) {
    if (typeof h !== 'string' || h.length === 0) return '(none)';
    if (h.length <= 18) return h;
    return h.slice(0, 12) + '…' + h.slice(-6);
  }

  /* ------------------------------------------------------------------ *
   * State. The host posts validated, folded verdict records; this view holds them,
   * runs the async crypto gate on each, and re-renders. The host NEVER decides
   * verified — `sig` below is computed only here.
   * ------------------------------------------------------------------ */
  const state = {
    // runId -> {
    //   runId, verdict (the VerifierVerdictEvent payload as a verdict object),
    //   eligible (runtime/creation product-trust eligible),
    //   failure ({kind, message, staleRootHash} | null) from a stream Failure event,
    //   liveTraceRoot (the run's current trace root, for the binding leg),
    //   sig (the async verify result | null while pending),
    // }
    byRun: new Map(),
    order: [], // runIds, newest activity first
  };

  function touchOrder(runId) {
    const i = state.order.indexOf(runId);
    if (i !== -1) state.order.splice(i, 1);
    state.order.unshift(runId);
  }

  function rec(runId) {
    let r = state.byRun.get(runId);
    if (!r) {
      r = {
        runId,
        verdict: null,
        eligible: false,
        failure: null,
        liveTraceRoot: null,
        sig: null,
        // The CANONICAL gate result fanned from the Trust Panel (glyphcodeAuthority →
        // GovernanceSurfaceRegistry.confirmVerified). undefined = not yet confirmed,
        // so the run is NOT blue (an unconfirmed run is never authoritative here); true
        // = the panel's Ed25519 gate confirmed; false = never confirmed or a later
        // tamper revoked it (caps at UNTRUSTED). AND-ed with this view's own crypto gate.
        canonicalVerified: undefined,
      };
      state.byRun.set(runId, r);
    }
    return r;
  }

  /* ------------------------------------------------------------------ *
   * Ingest folded records from the host.
   * ------------------------------------------------------------------ */
  function applyOpened(m) {
    const r = rec(m.runId);
    r.eligible = m.eligible === true;
    // A non-isolated / soft run can never reach product-blue regardless of a passing
    // verdict — record an honest caveat (the verdict gate still de-authoritates).
    r.runtimeProfile = m.runtimeProfile;
    touchOrder(m.runId);
  }

  function applyVerdict(m) {
    const r = rec(m.runId);
    r.verdict = m.verdict; // the verdict object (checks, overallVerdict, traceRootHash, signature)
    r.sig = null; // reset — re-run the gate below
    touchOrder(m.runId);
    // Kick off the async signature gate; re-render when it resolves.
    void runGate(r);
  }

  function applyTraceRoot(m) {
    const r = rec(m.runId);
    if (typeof m.traceRoot === 'string' && m.traceRoot.length) {
      r.liveTraceRoot = m.traceRoot;
      // Binding may have changed; if we already have a verdict, the render's
      // binding leg recomputes from r.liveTraceRoot (no re-crypto needed).
    }
  }

  function applyFailure(m) {
    const r = rec(m.runId);
    r.failure = { kind: m.failureKind, message: m.message, staleRootHash: m.staleRootHash };
    touchOrder(m.runId);
  }

  /**
   * The CANONICAL Trust Panel gate confirmed (true) or revoked (false) a verified
   * authority for a run. This is the SAME signal the status bar / gutter / cards
   * honor; here it is AND-ed with this view's own in-webview Ed25519 gate (renderCard),
   * so a verdict reaches blue ONLY when BOTH agree. A `false` (never confirmed, or a
   * later tamper revoked it) caps the run at UNTRUSTED regardless of the local crypto
   * result. The host never decides verified — this only relays the panel's gate.
   */
  function applyConfirmVerified(m) {
    const r = rec(m.runId);
    r.canonicalVerified = m.verified === true;
  }

  /** Run the async Ed25519 gate for a record, then re-render. */
  async function runGate(r) {
    if (!r.verdict) { render(); return; }
    try {
      r.sig = await verifyVerdictSignature(r.verdict);
    } catch (err) {
      r.sig = { status: 'error', detail: 'verify threw: ' + (err && err.message), trusted: false };
    }
    render();
  }

  /* ------------------------------------------------------------------ *
   * Render.
   * ------------------------------------------------------------------ */
  function render() {
    renderTargets();
    renderVerdicts();
  }

  /**
   * Verification TARGETS (§5.9): the checks the policy declared, sourced from the
   * most-recent verdict's checks (the actor cannot narrow them). The verdict's
   * `checks[]` are the targets the verifier was told to run.
   */
  function renderTargets() {
    const root = document.getElementById('targets');
    clear(root);
    // Use the newest verdict that has checks.
    let checks = null;
    for (const runId of state.order) {
      const r = state.byRun.get(runId);
      if (r && r.verdict && Array.isArray(r.verdict.checks) && r.verdict.checks.length) {
        checks = r.verdict.checks;
        break;
      }
    }
    if (!checks) {
      root.appendChild(el('div', 'targets-empty',
        'No verification targets observed yet. Targets are declared in .glyphcode/policy.yml (Policy.verify) and surface here when a governed run produces a verdict.'));
      return;
    }
    for (const ck of checks) {
      const row = el('div', 'target-row');
      row.appendChild(el('span', 't-name', ck.name || '(unnamed check)'));
      const cmd = argvStr(ck.command);
      if (cmd) row.appendChild(el('span', 't-cmd', cmd));
      root.appendChild(row);
    }
  }

  function renderVerdicts() {
    const root = document.getElementById('verdicts');
    const countEl = document.getElementById('verdictCount');
    clear(root);

    const withVerdict = state.order.map((id) => state.byRun.get(id)).filter((r) => r && (r.verdict || r.failure));
    countEl.textContent = String(withVerdict.length);

    if (withVerdict.length === 0) {
      root.appendChild(el('div', 'verdicts-empty',
        'No verdicts yet. When the independent verifier signs a run, it appears here as PENDING, then PASS·SIGNED only after this panel verifies the Ed25519 signature, or UNTRUSTED if it cannot.'));
      return;
    }

    for (const r of withVerdict) root.appendChild(renderCard(r));
  }

  /**
   * Decide the verdict STATE and build the card. The gate (in priority order):
   *   UNTRUSTED  — a stream Failure (tamper/stale/missing-sig/non-isolated), OR the
   *                signature is missing/invalid/untrusted-key, OR the trace-binding
   *                leg fails, OR the run is product-ineligible (non-isolated/soft).
   *   PENDING    — a verdict is present but the async signature gate hasn't resolved.
   *   PASS·SIGNED— ALL hold: signature verified against a pinned out-of-band key AND
   *                (trace-binding satisfied, when a live root is known) AND the run is
   *                product-eligible. blue. This is the ONLY authoritative state.
   * Blue is NEVER painted from a stream claim — only from r.sig.trusted === true here.
   */
  function renderCard(r) {
    const v = r.verdict;

    // A stream failure de-authoritates outright.
    const hasFailure = !!r.failure;

    const sig = r.sig; // null while pending
    const sigVerified = !!sig && sig.status === 'verified' && sig.trusted === true;

    // Trace-binding leg: if we know the run's live trace root, the verdict must sign
    // over exactly it. If we don't know it yet, we do NOT block on it (the panel's
    // own binding check is authoritative) — but a KNOWN mismatch de-authoritates.
    let bindingMismatch = false;
    if (v && r.liveTraceRoot && typeof v.traceRootHash === 'string') {
      bindingMismatch = v.traceRootHash !== r.liveTraceRoot;
    }

    // Product-eligibility (runtime/creation trust). A non-isolated / soft run can
    // never reach product-blue — cap at UNTRUSTED even with a valid signature.
    const eligible = r.eligible === true;

    // CANONICAL gate (the only door to blue, AND-ed with the local crypto gate). The
    // Trust Panel's Ed25519 gate result, fanned via the host's confirmVerified path —
    // the SAME signal the status bar / gutter / cards read. undefined = not yet
    // confirmed (held back from blue, never fabricated); false = never confirmed or a
    // later tamper revoked it (caps at UNTRUSTED).
    const canonicalVerified = r.canonicalVerified === true;

    let stateClass, pillCls, pillGlyph, pillText;
    if (v && sig === null && !hasFailure) {
      stateClass = 'state-pending'; pillCls = 'pending'; pillGlyph = '…'; pillText = 'Pending';
    } else if (sigVerified && eligible && !bindingMismatch && !hasFailure && canonicalVerified) {
      stateClass = 'state-pass'; pillCls = 'pass'; pillGlyph = '✓'; pillText = 'Pass · Signed';
    } else {
      stateClass = 'state-untrusted'; pillCls = 'untrusted'; pillGlyph = '✕'; pillText = 'Untrusted';
    }

    const card = el('div', 'verdict-card ' + stateClass);

    const top = el('div', 'vc-top');
    top.appendChild(el('span', 'vc-run', shortHash(r.runId)));
    const pill = el('span', 'pill ' + pillCls);
    pill.appendChild(el('span', 'pg', pillGlyph));
    pill.appendChild(el('span', null, pillText));
    top.appendChild(pill);
    card.appendChild(top);

    // The Ed25519 signature line — the gate, shown directly under the pill.
    card.appendChild(buildSigLine(v, sig, sigVerified, hasFailure));

    // Signing-key fingerprint — DISPLAY-ONLY identity (never the basis of trust).
    if (v && v.signature) {
      const fp = el('div', 'key-fp');
      fp.appendChild(el('span', 'kf-label', 'signing key'));
      const keyId = v.signature.keyId ? String(v.signature.keyId) : '(no keyId)';
      fp.appendChild(el('span', null, keyId + '  ·  ' + shortHash(v.signature.value)));
      fp.title = 'keyId is a DISPLAY label only — trust comes from verifying the signature against the pinned out-of-band key, not from this id.';
      card.appendChild(fp);
    }

    // A stream failure renders distinctly (tamper / stale / missing-sig / non-isolated).
    if (hasFailure) {
      const f = el('div', 'vc-failure');
      f.appendChild(el('span', 'vf-glyph', '✕'));
      f.appendChild(el('span', null, failureLabel(r.failure)));
      card.appendChild(f);
    }

    // Binding-mismatch is its own honest, distinct caveat.
    if (bindingMismatch && !hasFailure) {
      const f = el('div', 'vc-failure');
      f.appendChild(el('span', 'vf-glyph', '✕'));
      f.appendChild(el('span', null, 'Verdict signs over a DIFFERENT trace root than this run’s live trace — not bound to the evidence shown.'));
      card.appendChild(f);
    }

    // Runtime caveat: a product-ineligible (non-isolated / soft) run, even with a
    // valid signature, can never be product-blue.
    if (sigVerified && !eligible && !hasFailure) {
      card.appendChild(el('div', 'vc-caveat',
        'Signature is valid, but this run’s runtime is not an approved isolation runtime — it can never be product-trusted, so the verdict is held at UNTRUSTED.'));
    }

    // Canonical-gate caveat: the local crypto gate passed (valid signature, bound,
    // eligible) but the Trust Panel's canonical gate has NOT confirmed this run (or
    // a later tamper revoked it). The verdict is held at UNTRUSTED until BOTH gates
    // agree — blue is never painted from the local gate alone.
    if (sigVerified && eligible && !bindingMismatch && !hasFailure && !canonicalVerified) {
      card.appendChild(el('div', 'vc-caveat',
        r.canonicalVerified === false
          ? 'Signature verified here, but the Trust Panel’s canonical gate revoked this run’s authority (a later tamper) — held at UNTRUSTED.'
          : 'Signature verified here; awaiting the Trust Panel’s canonical signature gate to confirm this run before it can read verified-blue.'));
    }

    // Per-check results.
    if (v && Array.isArray(v.checks) && v.checks.length) {
      const checks = el('div', 'vc-checks');
      for (const ck of v.checks) {
        const row = el('div', 'check-row');
        row.appendChild(el('span', 'c-name', ck.name || '(unnamed)'));
        const cmd = argvStr(ck.command);
        if (cmd) row.appendChild(el('span', 'c-cmd', cmd));
        const st = (ck.status || 'error').toLowerCase();
        row.appendChild(el('span', 'check-stat ' + st, st));
        checks.appendChild(row);
      }
      card.appendChild(checks);
    }

    // Bound trace_root_hash.
    if (v && v.traceRootHash) {
      const rootHash = el('div', 'vc-root');
      rootHash.appendChild(el('span', 'vr-label', 'bound trace_root'));
      rootHash.appendChild(el('span', null, shortHash(v.traceRootHash)));
      card.appendChild(rootHash);
    }

    return card;
  }

  /**
   * The Ed25519 signature line. `sigVerified === true` is the ONLY state that reads
   * authoritative (blue). Every other state is shown as explicitly NOT verified
   * (red/amber), never silently "verified". A stream failure forces the bad line.
   */
  function buildSigLine(v, sig, sigVerified, hasFailure) {
    // Pending: a verdict is present but the gate hasn't resolved.
    if (v && sig === null && !hasFailure) {
      const line = el('div', 'sig-line pending');
      line.appendChild(el('span', 'sg', '…'));
      line.appendChild(el('span', 'sig-detail', 'verifying Ed25519 signature in this panel…'));
      return line;
    }

    if (sigVerified && !hasFailure) {
      const line = el('div', 'sig-line ok');
      line.appendChild(el('span', 'sg', '✓'));
      line.appendChild(el('span', 'sig-detail',
        'signature verified — Ed25519, checked in this panel against a TRUSTED (out-of-band) verifier key.'));
      return line;
    }

    // Not verified — exact, honest message per failure mode.
    const line = el('div', 'sig-line bad');
    line.appendChild(el('span', 'sg', '⚠'));
    let message;
    const status = sig ? sig.status : v && v.signature ? 'failed' : 'no-signature';
    switch (status) {
      case 'no-signature':
        message = 'signature NOT verified — UNTRUSTED (no signature present on the verdict).';
        break;
      case 'no-key':
        message = 'signature NOT verified — UNTRUSTED (no trusted out-of-band verifier key is pinned).';
        break;
      case 'unsupported':
        message = 'signature NOT verified — UNTRUSTED (this panel lacks Web Crypto Ed25519 support).';
        break;
      case 'error':
        message = 'signature NOT verified — UNTRUSTED (' + (sig && sig.detail ? sig.detail : 'verify error') + ').';
        break;
      case 'verified':
        // Verified cryptographically but held UNTRUSTED by another leg (ineligible
        // runtime / binding mismatch / a stream failure) — be explicit.
        message = 'signature is cryptographically valid, but the verdict is held UNTRUSTED (see caveat below).';
        break;
      default:
        message = 'signature NOT verified — UNTRUSTED (does not verify against any pinned trusted key).';
    }
    line.appendChild(el('span', 'sig-detail', message));
    return line;
  }

  function failureLabel(failure) {
    const k = failure && failure.kind;
    switch (k) {
      case 'tampered_trace':
        return 'Trace tampered upstream — the hash chain broke. Verdict de-authoritated.';
      case 'missing_verifier_signature':
        return 'Verifier verdict has no signature or an invalid one — UNTRUSTED.';
      case 'stale_verifier':
        return 'Stale verifier — the verdict signed an older trace root' +
          (failure.staleRootHash ? ' (' + shortHash(failure.staleRootHash) + ')' : '') + ' than the live trace.';
      case 'non_isolated_runtime':
        return 'Non-isolated runtime — a dev runtime can never be product-trusted.';
      case 'boundary_only_cli':
        return 'Boundary-only CLI — coarser evidence; not per-tool brokered.';
      case 'bridge_mismatch':
        return 'Bridge mismatch — supervisor binary hash / protocol version mismatch.';
      default:
        return (failure && failure.message) || 'A degradation was reported for this run; verdict de-authoritated.';
    }
  }

  /* ------------------------------------------------------------------ *
   * Host message wiring.
   * ------------------------------------------------------------------ */
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  window.addEventListener('message', (event) => {
    const msg = event && event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'opened': applyOpened(msg); render(); break;
      case 'verdict': applyVerdict(msg); render(); break;
      case 'traceRoot': applyTraceRoot(msg); render(); break;
      case 'failure': applyFailure(msg); render(); break;
      case 'confirmVerified': applyConfirmVerified(msg); render(); break;
      case 'reset':
        state.byRun.clear();
        state.order.length = 0;
        render();
        break;
      default: break;
    }
  });

  render();
  if (vscode) vscode.postMessage({ type: 'ready' });
})();
