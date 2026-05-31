/*
 * GlyphSpek LIVE Trust Panel (milestone M5) — webview side.
 *
 * Vanilla JS, no build step, loaded AFTER app.js so it reuses app.js's globals:
 *   - el / clear / escapeHtml / fmtTime / shortHash / argvToString   (DOM helpers)
 *   - verifyVerdictSignature / verifyTraceIntegrity                  (the GATE)
 *   - canonicalJson / verifyChainBrowser / computeTraceRootBrowser   (chain math)
 * This file does NOT re-implement the signature-before-display gate; it calls the
 * SAME verifyVerdictSignature + verifyTraceIntegrity app.js uses for loaded
 * bundles, so a live verdict is shown authoritative under EXACTLY the same crypto
 * rule, and a non-isolated runtime is gated out BEFORE that even runs.
 *
 * It mirrors src/liveRunModel.ts (the pure reducer the node tests pin) 1:1:
 *   - reduceRunEvent folds the run/event stream into a per-run view model,
 *   - the badges (runtime trust / extension posture / CLI fidelity) come straight
 *     from the RunOpened envelope,
 *   - actor CLAIMS and the verifier VERDICT are kept in separate view fields and
 *     rendered in separate, distinctly-styled panels — never conflated,
 *   - each DISTINCT failure (tampered trace, missing/invalid signature, stale
 *     verifier, non-isolated runtime, boundary-only CLI, bridge mismatch) renders
 *     as its own card.
 *
 * The webview cannot import the compiled CommonJS reducer, so the reduction logic
 * is duplicated here; src/liveRunModel.ts is the authoritative, tested copy and
 * this is the thin renderer over the same shapes. Keep them in sync.
 */

'use strict';

(function () {
  /* ----- run/event protocol constants (mirror src/runEventProtocol.ts) ----- */
  // SCHEMA-VERSION GATE (sweep-19 Medium #6). Mirrors RUN_EVENT_PROTOCOL_VERSION in
  // src/runEventProtocol.ts. The webview is what the operator actually sees, so it
  // ENFORCES the same compatibility gate the TS validator does and FAILS CLOSED on a
  // mismatch: a foreign/future stream is never rendered as a current event; it
  // surfaces a distinct bridge-mismatch failure instead.
  var RUN_EVENT_PROTOCOL_VERSION = 1;
  var RUN_EVENT_KIND = {
    RunOpened: 'run_opened',
    TraceEvent: 'trace_event',
    StateChanged: 'state_changed',
    ActorClaims: 'actor_claims',
    VerifierVerdict: 'verifier_verdict',
    RunClosed: 'run_closed',
    Failure: 'failure',
  };
  var FAILURE_KIND = {
    TamperedTrace: 'tampered_trace',
    MissingVerifierSignature: 'missing_verifier_signature',
    StaleVerifier: 'stale_verifier',
    NonIsolatedRuntime: 'non_isolated_runtime',
    BoundaryOnlyCli: 'boundary_only_cli',
    BridgeMismatch: 'bridge_mismatch',
  };
  // Severity order for the headline failure (most severe first).
  var FAILURE_SEVERITY = [
    'non_isolated_runtime',
    'tampered_trace',
    'stale_verifier',
    'bridge_mismatch',
    'missing_verifier_signature',
    'boundary_only_cli',
  ];

  /* --------------------------- live state --------------------------- */
  // runId -> RunView; selectedRunId is the one being reviewed.
  var runs = Object.create(null);
  var order = [];
  var selectedRunId = null;

  function emptyRunView(runId) {
    return {
      runId: runId,
      status: 'unknown',
      badges: {
        runtimeTrust: 'untrusted',
        runtimeProfile: 'unknown',
        extensionPosture: 'developer',
        cliFidelity: 'n/a',
        creationTrust: 'unknown',
        actorType: 'unknown',
        actorVersion: undefined,
      },
      trace: [],
      claims: null,
      verdict: null,
      changedFiles: [],
      commands: [],
      network: [],
      policyDecisions: [],
      failures: [],
      productTrustEligible: false, // fail-closed until RunOpened proves otherwise
      closed: false,
      // Latest async gate results for THIS run's verdict (verify-before-display).
      sigResult: null,
      chainResult: null,
    };
  }

  function getRun(runId) {
    if (!runs[runId]) {
      runs[runId] = emptyRunView(runId);
      order.push(runId);
    }
    return runs[runId];
  }

  function isProductTrustEligible(trust, runtimeTrust) {
    return runtimeTrust === 'trusted' && trust === 'trusted';
  }

  function appendFailure(failures, f) {
    for (var i = 0; i < failures.length; i++) {
      if (failures[i].state === f.state && failures[i].message === f.message) return failures;
    }
    return failures.concat([f]);
  }

  function failureKindToState(kind) {
    switch (kind) {
      case FAILURE_KIND.TamperedTrace: return 'tampered_trace';
      case FAILURE_KIND.MissingVerifierSignature: return 'missing_verifier_signature';
      case FAILURE_KIND.StaleVerifier: return 'stale_verifier';
      case FAILURE_KIND.NonIsolatedRuntime: return 'non_isolated_runtime';
      case FAILURE_KIND.BoundaryOnlyCli: return 'boundary_only_cli';
      case FAILURE_KIND.BridgeMismatch: return 'bridge_mismatch';
      default: return 'none';
    }
  }

  /* --------------------------- trace projections --------------------------- */
  function payloadOf(e) { return (e && e.payload) || {}; }

  function deriveCommands(trace) {
    var out = [];
    for (var i = 0; i < trace.length; i++) {
      var p = payloadOf(trace[i]);
      if (trace[i].type === 'tool_end' && p.tool === 'command') {
        out.push({ argv: Array.isArray(p.argv) ? p.argv : [], exitCode: p.exitCode, durationMs: p.durationMs });
      }
    }
    return out;
  }
  function deriveNetwork(trace) {
    var out = [];
    for (var i = 0; i < trace.length; i++) {
      var p = payloadOf(trace[i]);
      if (trace[i].type === 'policy_decision' && p.tool === 'network') {
        out.push({ destination: String(p.destination || p.requestedCapability || '(unknown)'), decision: String(p.decision || ''), blocked: !!p.blocked });
      }
    }
    return out;
  }
  function derivePolicyDecisions(trace) {
    var out = [];
    for (var i = 0; i < trace.length; i++) {
      if (trace[i].type !== 'policy_decision') continue;
      var p = payloadOf(trace[i]);
      out.push({
        tool: String(p.tool || ''),
        requestedCapability: String(p.requestedCapability || ''),
        decision: String(p.decision || ''),
        blocked: !!p.blocked,
        rule: p.rule ? String(p.rule) : undefined,
        provenanceLabel: p.provenanceLabel ? String(p.provenanceLabel) : undefined,
      });
    }
    return out;
  }
  function normalizeChange(c) {
    if (c === 'A' || c === 'added' || c === 'add') return 'A';
    if (c === 'M' || c === 'modified' || c === 'modify') return 'M';
    if (c === 'D' || c === 'deleted' || c === 'delete') return 'D';
    return '?';
  }
  function deriveChangedFiles(trace) {
    var byPath = Object.create(null);
    var seen = [];
    for (var i = 0; i < trace.length; i++) {
      var p = payloadOf(trace[i]);
      var list = p.changedFiles || p.filesChanged;
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        if (typeof item === 'string') {
          if (!(item in byPath)) { byPath[item] = '?'; seen.push(item); }
        } else if (item && typeof item === 'object' && typeof item.path === 'string') {
          if (!(item.path in byPath)) seen.push(item.path);
          byPath[item.path] = normalizeChange(item.change);
        }
      }
    }
    return seen.map(function (path) { return { path: path, change: byPath[path] }; });
  }

  /* --------------------------- the reducer --------------------------- */
  function reduce(view, event) {
    switch (event.kind) {
      case RUN_EVENT_KIND.RunOpened:
        view.badges = {
          runtimeTrust: event.runtimeTrust,
          runtimeProfile: event.runtimeProfile,
          extensionPosture: event.extensionPosture,
          cliFidelity: event.cliFidelity,
          creationTrust: event.trust,
          actorType: event.actorType,
          actorVersion: event.actorVersion,
        };
        view.status = event.state || 'created';
        view.productTrustEligible = isProductTrustEligible(event.trust, event.runtimeTrust);
        if (event.runtimeTrust !== 'trusted') {
          view.failures = appendFailure(view.failures, {
            state: 'non_isolated_runtime',
            message: 'NOT TRUSTED — dev runtime: ' + event.runtimeProfile +
              ' is not an approved isolation runtime. This run cannot be product-trusted.',
          });
        }
        if (event.cliFidelity === 'boundary-only') {
          view.failures = appendFailure(view.failures, {
            state: 'boundary_only_cli',
            message: 'boundary-observed: ' + event.actorType +
              ' ran boundary-only (no per-tool brokering). Evidence is coarser — diff, transcript, network observation, verdict.',
          });
        }
        return view;

      case RUN_EVENT_KIND.TraceEvent:
        view.trace = view.trace.concat([event.event]);
        view.commands = deriveCommands(view.trace);
        view.network = deriveNetwork(view.trace);
        view.policyDecisions = derivePolicyDecisions(view.trace);
        view.changedFiles = deriveChangedFiles(view.trace);
        if (event.event.type === 'run_state_changed' && event.event.payload && event.event.payload.to) {
          view.status = event.event.payload.to;
        }
        return view;

      case RUN_EVENT_KIND.StateChanged:
        view.status = event.to;
        return view;

      case RUN_EVENT_KIND.ActorClaims:
        // CLAIMS ONLY — never folded into the verdict.
        view.claims = {
          plan: event.plan,
          summary: event.summary,
          claimedChangedFiles: Array.isArray(event.claimedChangedFiles) ? event.claimedChangedFiles.slice() : [],
          claimedChecks: Array.isArray(event.claimedChecks)
            ? event.claimedChecks.map(function (c) { return { name: c.name, claim: c.claim }; })
            : [],
        };
        return view;

      case RUN_EVENT_KIND.VerifierVerdict:
        // VERDICT ONLY — delivered as evidence; the crypto gate runs on render.
        view.verdict = {
          checks: event.checks.slice(),
          overallVerdict: event.overallVerdict,
          traceRootHash: event.traceRootHash,
          signature: event.signature,
          verifierPublicKey: event.verifierPublicKey,
        };
        if (!event.signature || typeof event.signature.value !== 'string') {
          view.failures = appendFailure(view.failures, {
            state: 'missing_verifier_signature',
            message: 'verifier verdict carries no signature — cannot be authoritative.',
          });
        }
        // Reset + re-run the GATE for this run's verdict.
        view.sigResult = null;
        view.chainResult = null;
        runGateForRun(view);
        return view;

      case RUN_EVENT_KIND.RunClosed:
        view.status = event.finalState;
        view.closed = true;
        return view;

      case RUN_EVENT_KIND.Failure:
        view.failures = appendFailure(view.failures, {
          state: failureKindToState(event.failure),
          message: event.message,
          staleRootHash: event.staleRootHash,
          brokenIndex: event.brokenIndex,
        });
        if (event.failure === FAILURE_KIND.NonIsolatedRuntime ||
            event.failure === FAILURE_KIND.TamperedTrace ||
            event.failure === FAILURE_KIND.StaleVerifier ||
            event.failure === FAILURE_KIND.BridgeMismatch) {
          view.productTrustEligible = false;
        }
        return view;

      default:
        return view;
    }
  }

  /* --------------------------- the GATE (verify-before-display) --------------------------- */
  /*
   * Run the SAME signature + trace-integrity check app.js uses for loaded bundles
   * against THIS run's streamed verdict + trace. Stores the async result on the
   * view and re-renders. A non-isolated runtime is already gated out by
   * productTrustEligible, so even a valid signature cannot present product-trusted.
   */
  function runGateForRun(view) {
    var verdict = view.verdict;
    if (!verdict || typeof verifyVerdictSignature !== 'function') { renderIfSelected(view.runId); return; }
    renderIfSelected(view.runId); // show pending immediately
    Promise.all([
      verifyVerdictSignature(verdict, verdict.verifierPublicKey || null),
      verifyTraceIntegrity(view.trace, verdict),
    ]).then(function (pair) {
      view.sigResult = pair[0];
      view.chainResult = pair[1];
      renderIfSelected(view.runId);
    }).catch(function () {
      // The gate never throws by contract; on any unexpected error, leave the
      // verdict NON-authoritative (fail-closed).
      view.sigResult = { status: 'error', detail: 'gate error', trusted: false, tier: null };
      renderIfSelected(view.runId);
    });
  }

  /* --------------------------- ingest --------------------------- */
  // Minimal validation mirroring src/runEventProtocol.ts validateRunEvent: drop a
  // malformed envelope rather than mis-render it. Returns a small result object so
  // the caller can distinguish a SCHEMA-VERSION mismatch (which fails CLOSED with a
  // distinct bridge-mismatch card) from a generic malformed envelope (dropped).
  //   { ok: true }                          → render
  //   { ok: false, reason: 'rev' }          → schema mismatch: surface bridge_mismatch
  //   { ok: false, reason: 'malformed' }    → drop silently
  function validate(e) {
    if (!e || typeof e !== 'object') return { ok: false, reason: 'malformed' };
    if (typeof e.runId !== 'string' || !e.runId.trim()) return { ok: false, reason: 'malformed' };
    // SCHEMA-VERSION GATE (FAIL CLOSED): enforce rev before shape, so a
    // future/foreign-schema envelope is never interpreted as a current event.
    if (e.rev !== RUN_EVENT_PROTOCOL_VERSION) return { ok: false, reason: 'rev' };
    var kinds = ['run_opened', 'trace_event', 'state_changed', 'actor_claims', 'verifier_verdict', 'run_closed', 'failure'];
    if (kinds.indexOf(e.kind) === -1) return { ok: false, reason: 'malformed' };
    if (e.kind === 'run_opened') {
      if (['trusted', 'untrusted', 'refused'].indexOf(e.trust) === -1) return { ok: false, reason: 'malformed' };
      if (['trusted', 'untrusted'].indexOf(e.runtimeTrust) === -1) return { ok: false, reason: 'malformed' };
      if (['sovereign', 'developer'].indexOf(e.extensionPosture) === -1) return { ok: false, reason: 'malformed' };
      if (['per-tool-brokered', 'boundary-only', 'n/a'].indexOf(e.cliFidelity) === -1) return { ok: false, reason: 'malformed' };
    }
    if (e.kind === 'trace_event' && (!e.event || typeof e.event !== 'object')) return { ok: false, reason: 'malformed' };
    if (e.kind === 'failure' && (FAILURE_SEVERITY.indexOf(failureKindToState(e.failure)) === -1)) return { ok: false, reason: 'malformed' };
    return { ok: true };
  }

  function ingestRunEvent(raw) {
    var v = validate(raw);
    if (!v.ok) {
      if (v.reason === 'rev') ingestSchemaMismatch(raw);
      return;
    }
    var view = getRun(raw.runId);
    reduce(view, raw);
    showLiveView();
    // Auto-select the most recently opened/active run if none chosen yet.
    if (!selectedRunId) selectedRunId = raw.runId;
    if (raw.kind === 'run_opened') selectedRunId = raw.runId;
    renderRunList();
    if (selectedRunId === raw.runId) renderSelectedRun();
  }

  /*
   * SCHEMA-VERSION MISMATCH (sweep-19 Medium #6 — FAIL CLOSED). An envelope whose
   * `rev` is not RUN_EVENT_PROTOCOL_VERSION is a future/foreign stream schema. We do
   * NOT render it as a current event; instead we de-authoritate the affected run
   * with a DISTINCT bridge-mismatch failure card so the operator sees WHY a foreign
   * stream was refused, never a silently-dropped or mis-rendered event.
   */
  function ingestSchemaMismatch(raw) {
    var runId = raw && typeof raw.runId === 'string' && raw.runId.trim() ? raw.runId : 'unknown-run';
    var view = getRun(runId);
    view.failures = appendFailure(view.failures, {
      state: 'bridge_mismatch',
      message: 'unsupported run-event schema (rev mismatch) — refusing to render a foreign/future ' +
        'stream as current (expected rev ' + RUN_EVENT_PROTOCOL_VERSION + ').',
    });
    view.productTrustEligible = false; // fail closed
    showLiveView();
    if (!selectedRunId) selectedRunId = runId;
    renderRunList();
    if (selectedRunId === runId) renderSelectedRun();
  }

  /* --------------------------- rendering --------------------------- */
  function showLiveView() {
    var live = document.getElementById('live-view');
    if (live) live.hidden = false;
  }

  function renderIfSelected(runId) {
    if (selectedRunId === runId) renderSelectedRun();
    renderRunList();
  }

  function deriveTrustSummary(view) {
    var present = {};
    for (var i = 0; i < view.failures.length; i++) present[view.failures[i].state] = true;
    var headline = 'none';
    var states = [];
    for (var j = 0; j < FAILURE_SEVERITY.length; j++) {
      if (present[FAILURE_SEVERITY[j]]) {
        if (headline === 'none') headline = FAILURE_SEVERITY[j];
        states.push(FAILURE_SEVERITY[j]);
      }
    }
    return { productTrustEligible: view.productTrustEligible, headlineFailure: headline, failureStates: states };
  }

  function renderRunList() {
    var root = document.getElementById('live-runlist');
    if (!root) return;
    clear(root);
    if (order.length === 0) {
      root.appendChild(el('p', { className: 'empty', text: 'No live runs yet.' }));
      return;
    }
    var tbl = el('table', { className: 'mini-table runlist-table' });
    var head = el('tr', { className: 'mini-head' });
    ['run', 'actor', 'status', 'runtime', 'trust'].forEach(function (h) { head.appendChild(el('th', { text: h })); });
    tbl.appendChild(head);
    for (var i = 0; i < order.length; i++) {
      var v = runs[order[i]];
      var tr = el('tr', { className: 'runlist-row' + (v.runId === selectedRunId ? ' runlist-selected' : '') });
      tr.setAttribute('data-run', v.runId);
      var idTd = el('td');
      idTd.appendChild(el('code', { text: v.runId.length > 14 ? v.runId.slice(0, 12) + '…' : v.runId }));
      tr.appendChild(idTd);
      tr.appendChild(el('td', { text: v.badges.actorType }));
      var stTd = el('td');
      stTd.appendChild(el('span', { className: 'status-badge status-' + v.status, text: v.status }));
      tr.appendChild(stTd);
      tr.appendChild(el('td', { text: v.badges.runtimeProfile }));
      var trustTd = el('td');
      trustTd.appendChild(runtimeTrustBadge(v.badges.runtimeTrust, true));
      tr.appendChild(trustTd);
      (function (runId) {
        tr.addEventListener('click', function () { selectedRunId = runId; renderRunList(); renderSelectedRun(); });
      })(v.runId);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }

  /* ---- badges ---- */
  function runtimeTrustBadge(runtimeTrust, compact) {
    var trusted = runtimeTrust === 'trusted';
    var b = el('span', {
      className: 'trust-badge ' + (trusted ? 'trust-ok' : 'trust-bad'),
      text: trusted ? (compact ? 'isolated' : 'runtime: TRUSTED (isolated)') : (compact ? 'DEV RUNTIME' : 'runtime: NOT TRUSTED — dev runtime'),
    });
    return b;
  }

  function renderBadges(view) {
    var root = document.getElementById('live-badges');
    if (!root) return;
    clear(root);
    var b = view.badges;

    // Runtime-trust badge.
    root.appendChild(runtimeTrustBadge(b.runtimeTrust, false));

    // Extension-posture badge.
    var sovereign = b.extensionPosture === 'sovereign';
    root.appendChild(el('span', {
      className: 'trust-badge ' + (sovereign ? 'posture-sovereign' : 'posture-developer'),
      text: sovereign ? 'posture: Sovereign' : 'posture: Developer',
    }));

    // CLI-fidelity badge.
    var fid = b.cliFidelity;
    var fidClass = fid === 'per-tool-brokered' ? 'fid-brokered' : fid === 'boundary-only' ? 'fid-boundary' : 'fid-na';
    var fidText = fid === 'per-tool-brokered' ? 'fidelity: per-tool-brokered'
      : fid === 'boundary-only' ? 'fidelity: boundary-only (observed)'
      : 'fidelity: n/a (native)';
    root.appendChild(el('span', { className: 'trust-badge ' + fidClass, text: fidText }));

    // Creation-trust badge (sweep-23 #2). Surfaces the run-creation posture honestly.
    // A GOVERNED TERMINAL session (M7) settles into 'governed-unsandboxed': governed +
    // traced but the SOFT, metadata-only, UNSANDBOXED boundary — NEVER product-trusted.
    // It is shown as its own amber badge so a reviewer cannot mistake it for trusted.
    var ct = b.creationTrust;
    if (ct === 'governed-unsandboxed') {
      root.appendChild(el('span', {
        className: 'trust-badge creation-governed-unsandboxed',
        text: 'Governed (soft) — metadata-only, not sandboxed',
      }));
    } else if (ct === 'untrusted' || ct === 'refused') {
      root.appendChild(el('span', {
        className: 'trust-badge creation-untrusted',
        text: 'creation: ' + ct.toUpperCase(),
      }));
    } else if (ct === 'trusted') {
      root.appendChild(el('span', {
        className: 'trust-badge creation-trusted',
        text: 'creation: trusted (pending gate)',
      }));
    }

    // Actor + creation-trust badge.
    root.appendChild(el('span', {
      className: 'trust-badge actor-badge',
      text: 'actor: ' + b.actorType + (b.actorVersion ? ' ' + b.actorVersion : ''),
    }));

    // The single product-trust eligibility verdict, BEFORE the crypto gate.
    var summary = deriveTrustSummary(view);
    var eligText = summary.productTrustEligible
      ? 'product-trust ELIGIBLE (pending signature gate)'
      : 'NOT product-trusted';
    root.appendChild(el('span', {
      className: 'trust-badge ' + (summary.productTrustEligible ? 'elig-ok' : 'elig-bad'),
      text: eligText,
    }));
  }

  /* ---- distinct failure cards ---- */
  var FAILURE_LABELS = {
    tampered_trace: 'TAMPERED TRACE — UNTRUSTED',
    missing_verifier_signature: 'MISSING / INVALID VERIFIER SIGNATURE',
    stale_verifier: 'STALE VERIFIER — verdict over an old trace_root',
    non_isolated_runtime: 'NOT TRUSTED — dev runtime',
    boundary_only_cli: 'BOUNDARY-ONLY CLI — coarser evidence',
    bridge_mismatch: 'BRIDGE HASH / VERSION MISMATCH',
  };

  function renderFailures(view) {
    var root = document.getElementById('live-failures');
    if (!root) return;
    clear(root);
    if (!view.failures.length) return;
    var summary = deriveTrustSummary(view);
    for (var i = 0; i < view.failures.length; i++) {
      var f = view.failures[i];
      var isHeadline = f.state === summary.headlineFailure;
      var card = el('div', { className: 'failure-card failure-' + f.state + (isHeadline ? ' failure-headline' : '') });
      card.setAttribute('data-failure', f.state);
      var head = el('div', { className: 'failure-head' });
      head.appendChild(el('span', { className: 'failure-icon', text: '⚠' }));
      head.appendChild(el('strong', { text: FAILURE_LABELS[f.state] || f.state }));
      card.appendChild(head);
      card.appendChild(el('div', { className: 'failure-msg', text: f.message }));
      if (f.state === 'stale_verifier' && f.staleRootHash) {
        card.appendChild(el('div', { className: 'failure-detail mono', text: 'stale trace_root: ' + shortHash(f.staleRootHash) }));
      }
      if (f.state === 'tampered_trace' && typeof f.brokenIndex === 'number') {
        card.appendChild(el('div', { className: 'failure-detail', text: 'first broken at event #' + f.brokenIndex }));
      }
      root.appendChild(card);
    }
  }

  /* ---- claims (amber, NEVER a verdict) ---- */
  function renderClaims(view) {
    var root = document.getElementById('live-claims-body');
    if (!root) return;
    clear(root);
    var c = view.claims;
    if (!c) { root.appendChild(el('p', { className: 'empty', text: 'No actor claims yet.' })); return; }
    if (c.plan) root.appendChild(claimField('Plan', c.plan));
    if (c.summary) root.appendChild(claimField('Self-reported summary', c.summary));
    if (c.claimedChangedFiles && c.claimedChangedFiles.length) {
      var wrap = el('div', { className: 'field' });
      wrap.appendChild(el('div', { className: 'field-label', text: 'Claimed changed files (UNVERIFIED)' }));
      var ul = el('ul', { className: 'plain-list' });
      for (var i = 0; i < c.claimedChangedFiles.length; i++) {
        ul.appendChild(el('li', { html: '<code>' + escapeHtml(c.claimedChangedFiles[i]) + '</code>' }));
      }
      wrap.appendChild(ul);
      root.appendChild(wrap);
    }
    if (c.claimedChecks && c.claimedChecks.length) {
      var w2 = el('div', { className: 'field' });
      w2.appendChild(el('div', { className: 'field-label', text: 'Claimed check results (UNVERIFIED)' }));
      var tbl = el('table', { className: 'mini-table' });
      for (var j = 0; j < c.claimedChecks.length; j++) {
        var ck = c.claimedChecks[j];
        var tr = el('tr');
        tr.appendChild(el('td', { text: ck.name }));
        var td = el('td');
        td.appendChild(el('span', { className: 'claim-pill claim-' + ck.claim, text: 'claims: ' + ck.claim }));
        tr.appendChild(td);
        tbl.appendChild(tr);
      }
      w2.appendChild(tbl);
      root.appendChild(w2);
    }
  }
  function claimField(label, value) {
    var wrap = el('div', { className: 'field' });
    wrap.appendChild(el('div', { className: 'field-label', text: label }));
    wrap.appendChild(el('div', { className: 'field-value', text: value || '(none)' }));
    return wrap;
  }

  /* ---- verifier verdict (authoritative ONLY after the in-browser gate) ---- */
  function renderVerdict(view) {
    var root = document.getElementById('live-verdict-body');
    var card = document.getElementById('live-verdict-card');
    if (!root) return;
    clear(root);
    var v = view.verdict;
    if (!v) {
      if (card) card.classList.remove('verdict-untrusted', 'verdict-demo-authoritative', 'verdict-inconsistent', 'verdict-untrusted-key');
      root.appendChild(el('p', { className: 'empty', text: 'No verifier verdict yet. The run is unverified.' }));
      return;
    }

    var res = view.sigResult;
    var chain = view.chainResult;
    var sigVerified = !!res && res.status === 'verified';
    var tier = sigVerified ? res.tier : null;
    var sigByProduct = sigVerified && tier === 'product';
    var sigByDemo = sigVerified && tier === 'demo';
    var sigByTrusted = sigByProduct || sigByDemo;
    var sigUntrustedKey = sigVerified && tier === 'untrusted-key';
    var bundleConsistent = !!chain && chain.chainOk === true && chain.rootMatches === true;

    // CRITICAL GATE LAYERING (§6.3 + §6.5): a verdict can be PRODUCT-AUTHORITATIVE
    // only if (a) the run is product-trust ELIGIBLE (isolated runtime + trusted
    // creation) AND (b) a PRODUCT-tier signature verified AND (c) the bundle is
    // consistent. The eligibility floor means a non-isolated runtime can NEVER
    // reach the green authoritative state, regardless of a valid signature.
    var eligible = view.productTrustEligible;
    var verified = eligible && sigByProduct && bundleConsistent;
    var demoAuthoritative = sigByDemo && bundleConsistent; // demo tier never product
    var sigValidButInconsistent = sigByTrusted && !!chain && !bundleConsistent;

    if (card) {
      card.classList.toggle('verdict-untrusted', !verified && !demoAuthoritative);
      card.classList.toggle('verdict-demo-authoritative', demoAuthoritative);
      card.classList.toggle('verdict-inconsistent', sigValidButInconsistent);
      card.classList.toggle('verdict-untrusted-key', sigUntrustedKey);
    }

    // Signature badge FIRST — it is the gate, so it leads.
    root.appendChild(buildLiveSigBadge(v.signature, res, verified, demoAuthoritative, eligible, sigByProduct));

    if (sigByTrusted) {
      root.appendChild(buildLiveChainBadge(chain, verified || demoAuthoritative));
    }

    // Overall verdict banner.
    if (verified) {
      root.appendChild(verdictBanner('OVERALL VERDICT', (v.overallVerdict || 'unknown').toUpperCase(), 'verdict-' + v.overallVerdict));
    } else if (demoAuthoritative) {
      root.appendChild(verdictBanner('DEMO-AUTHORITATIVE', 'claims "' + (v.overallVerdict || 'unknown').toUpperCase() + '"', 'verdict-demo-authoritative-banner'));
    } else if (sigValidButInconsistent) {
      root.appendChild(verdictBanner('VERDICT — INCONSISTENT BUNDLE', '(signature valid, but NOT bound to this trace)', 'verdict-inconsistent-banner'));
    } else if (sigUntrustedKey) {
      root.appendChild(verdictBanner('VERDICT — UNTRUSTED KEY', '(signed by an UNTRUSTED key supplied by the bundle)', 'verdict-untrusted-key-banner'));
    } else if (sigByProduct && !eligible) {
      // Signature verified against a PRODUCT key, but the RUNTIME is not isolated
      // — the §6.3 floor forbids product-authoritative. Distinct, honest banner.
      root.appendChild(verdictBanner('VERDICT — NOT TRUSTED (dev runtime)', '(signature valid, but the runtime is not an approved isolation runtime)', 'verdict-untrusted-banner'));
    } else {
      root.appendChild(verdictBanner('VERDICT — UNTRUSTED', '(claims "' + (v.overallVerdict || 'unknown').toUpperCase() + '")', 'verdict-untrusted-banner'));
    }

    // Per-check results.
    var checksWrap = el('div', { className: 'field' });
    checksWrap.appendChild(el('div', { className: 'field-label', text: 'Checks (sourced from Policy.verify — actor cannot narrow)' }));
    var ctbl = el('table', { className: 'mini-table check-table' });
    for (var i = 0; i < (v.checks || []).length; i++) {
      var ck = v.checks[i];
      var tr = el('tr');
      tr.appendChild(el('td', { text: ck.name }));
      var cmdTd = el('td');
      cmdTd.appendChild(el('code', { text: argvToString(ck.command || []) }));
      tr.appendChild(cmdTd);
      var statTd = el('td');
      statTd.appendChild(el('span', { className: 'verdict-pill check-' + ck.status, text: ck.status }));
      tr.appendChild(statTd);
      ctbl.appendChild(tr);
    }
    checksWrap.appendChild(ctbl);
    root.appendChild(checksWrap);

    var rootHash = el('div', { className: 'field' });
    rootHash.appendChild(el('div', { className: 'field-label', text: 'Bound trace_root_hash' }));
    rootHash.appendChild(el('code', { className: 'field-value mono', text: v.traceRootHash || '(none)' }));
    root.appendChild(rootHash);
  }

  function verdictBanner(label, value, cls) {
    var banner = el('div', { className: 'verdict-banner ' + cls });
    banner.appendChild(el('span', { className: 'verdict-label', text: label }));
    banner.appendChild(el('span', { className: 'verdict-value', text: value }));
    return banner;
  }

  function buildLiveSigBadge(sig, res, verified, demoAuthoritative, eligible, sigByProduct) {
    var status = res ? res.status : sig ? 'pending' : 'no-signature';
    if (res && res.status === 'verified' && res.tier === 'untrusted-key') {
      var b1 = el('div', { className: 'sig-badge sig-untrusted-key' });
      b1.appendChild(el('span', { className: 'sig-x', text: '⚠' }));
      b1.appendChild(el('span', { text: '⚠ signature NOT trusted — valid only for a key SUPPLIED BY THE BUNDLE, not a pinned out-of-band verifier key' }));
      return b1;
    }
    if (demoAuthoritative) {
      var bd = el('div', { className: 'sig-badge sig-demo-authoritative' });
      bd.appendChild(el('span', { className: 'sig-check', text: '✓' }));
      var td = el('span');
      td.appendChild(el('strong', { text: 'signature verified ✓ (DEMO trust root)' }));
      td.appendChild(el('span', { text: ' — DEMO-AUTHORITATIVE, NOT a production trust root.' }));
      bd.appendChild(td);
      return bd;
    }
    if (verified) {
      var bv = el('div', { className: 'sig-badge sig-present' });
      bv.appendChild(el('span', { className: 'sig-check', text: '✓' }));
      var tv = el('span');
      tv.appendChild(el('strong', { text: 'signature verified ✓' }));
      tv.appendChild(el('span', { text: ' — authoritative. Ed25519, verified in-browser against a TRUSTED (out-of-band) PRODUCT verifier key over canonical (verdict, traceRootHash).' }));
      bv.appendChild(tv);
      return bv;
    }
    // Signature is product-valid but the RUNTIME is not isolated: a distinct,
    // honest "valid signature, untrusted runtime" message — never green.
    if (sigByProduct && !eligible) {
      var bn = el('div', { className: 'sig-badge sig-failed' });
      bn.appendChild(el('span', { className: 'sig-x', text: '⚠' }));
      bn.appendChild(el('span', { text: '⚠ signature is valid, but the RUNTIME is not an approved isolation runtime — NOT product-authoritative (dev runtime).' }));
      return bn;
    }
    var b = el('div', { className: 'sig-badge sig-failed' });
    b.appendChild(el('span', { className: 'sig-x', text: '⚠' }));
    var message;
    switch (status) {
      case 'pending': message = 'verifying signature…'; break;
      case 'no-signature': message = '⚠ signature NOT verified — verdict shown as UNTRUSTED (no signature present)'; break;
      case 'no-key': message = '⚠ signature NOT verified — verdict shown as UNTRUSTED (no verifier public key)'; break;
      case 'unsupported': message = '⚠ signature NOT verified — verdict shown as UNTRUSTED (' + ((res && res.detail) || 'Web Crypto Ed25519 unsupported') + ')'; break;
      default: message = '⚠ signature NOT verified — verdict shown as UNTRUSTED'; break;
    }
    b.appendChild(el('span', { text: message }));
    return b;
  }

  function buildLiveChainBadge(chain, bundleConsistent) {
    if (!chain) {
      var bp = el('div', { className: 'sig-badge sig-failed' });
      bp.appendChild(el('span', { className: 'sig-x', text: '…' }));
      bp.appendChild(el('span', { text: 'verifying trace chain + root binding…' }));
      return bp;
    }
    if (bundleConsistent) {
      var bo = el('div', { className: 'sig-badge sig-present' });
      bo.appendChild(el('span', { className: 'sig-check', text: '✓' }));
      var to = el('span');
      to.appendChild(el('strong', { text: 'evidence bundle verified ✓' }));
      to.appendChild(el('span', { text: ' — hash chain intact and trace root matches the signed verdict (' + shortHash(chain.recomputedRoot) + ').' }));
      bo.appendChild(to);
      return bo;
    }
    var b = el('div', { className: 'sig-badge sig-failed' });
    b.appendChild(el('span', { className: 'sig-x', text: '⚠' }));
    var t = el('span');
    if (!chain.chainOk) {
      t.appendChild(el('strong', { text: '⚠ evidence bundle UNTRUSTED — trace chain BROKEN' }));
      var where = typeof chain.brokenIndex === 'number' ? ' (first broken at event #' + chain.brokenIndex + ')' : '';
      t.appendChild(el('span', { text: where + '. The loaded trace fails hash-chain verification, so the verdict is NOT bound to it.' }));
    } else {
      t.appendChild(el('strong', { text: '⚠ evidence bundle INCONSISTENT — trace root does NOT match verdict (STALE verifier)' }));
      t.appendChild(el('span', { text: '. The signature is valid over the verdict, but the live trace is not the one it committed to.' }));
    }
    b.appendChild(t);
    return b;
  }

  /* ---- timeline + derived sections ---- */
  function renderTimeline(view) {
    var root = document.getElementById('live-timeline');
    if (!root) return;
    clear(root);
    for (var i = 0; i < view.trace.length; i++) {
      var evt = view.trace[i];
      var row = el('div', { className: 'event event-' + evt.type });
      var gutter = el('div', { className: 'event-gutter' });
      gutter.appendChild(el('span', { className: 'event-seq', text: '#' + evt.seq }));
      gutter.appendChild(el('span', { className: 'event-time', text: fmtTime(evt.ts) }));
      row.appendChild(gutter);
      var body = el('div', { className: 'event-body' });
      var head = el('div', { className: 'event-head' });
      head.appendChild(el('span', { className: 'event-type type-' + evt.type, text: evt.type }));
      body.appendChild(head);
      var detail = el('div', { className: 'event-detail' });
      detail.textContent = summarizeLive(evt);
      body.appendChild(detail);
      var hashLine = el('div', { className: 'event-hash' });
      hashLine.textContent = 'hash ' + shortHash(evt.hash) + '  ← prev ' + shortHash(evt.prevHash);
      body.appendChild(hashLine);
      row.appendChild(body);
      root.appendChild(row);
    }
  }
  function summarizeLive(evt) {
    var p = evt.payload || {};
    switch (evt.type) {
      case 'run_created': return 'runDir=' + (p.runDir || '?');
      case 'run_state_changed': return (p.from + ' → ' + p.to) + (p.reason ? '   ' + p.reason : '');
      case 'policy_decision': return 'tool=' + p.tool + '   decision=' + p.decision + (p.rule ? '   rule=' + p.rule : '');
      case 'tool_start': return p.argv ? '$ ' + argvToString(p.argv) : 'tool=' + p.tool;
      case 'tool_end': return (p.argv ? '$ ' + argvToString(p.argv) : 'tool=' + p.tool) + '   exitCode=' + (p.exitCode == null ? '?' : p.exitCode);
      case 'redaction': return 'location=' + p.location + '   reason=' + p.reason + '   (value never recorded)';
      case 'model_call': return 'model=' + p.model + '   tokens=' + (p.inputTokens || 0) + ' in / ' + (p.outputTokens || 0) + ' out';
      case 'actor_claimed_success': return 'actor claims success (NOT a verdict)';
      default: return JSON.stringify(p);
    }
  }

  function renderFiles(view) {
    var root = document.getElementById('live-files-body');
    if (!root) return;
    clear(root);
    if (!view.changedFiles.length) { root.appendChild(el('p', { className: 'empty', text: 'No changed files observed.' })); return; }
    var tbl = el('table', { className: 'mini-table' });
    for (var i = 0; i < view.changedFiles.length; i++) {
      var f = view.changedFiles[i];
      var tr = el('tr');
      var ch = el('td');
      ch.appendChild(el('span', { className: 'diff-change diff-' + f.change, text: f.change }));
      tr.appendChild(ch);
      var pth = el('td');
      pth.appendChild(el('code', { text: f.path }));
      tr.appendChild(pth);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }
  function renderCommands(view) {
    var root = document.getElementById('live-commands-body');
    if (!root) return;
    clear(root);
    if (!view.commands.length) { root.appendChild(el('p', { className: 'empty', text: 'No commands executed.' })); return; }
    var tbl = el('table', { className: 'mini-table' });
    for (var i = 0; i < view.commands.length; i++) {
      var c = view.commands[i];
      var tr = el('tr');
      var td = el('td');
      td.appendChild(el('code', { text: '$ ' + argvToString(c.argv) }));
      tr.appendChild(td);
      var code = el('td');
      code.appendChild(el('span', { className: 'chip chip-exit ' + (c.exitCode === 0 ? 'exit-ok' : 'exit-bad'), text: 'exit ' + (c.exitCode == null ? '?' : c.exitCode) }));
      tr.appendChild(code);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }
  function renderNetwork(view) {
    var root = document.getElementById('live-network-body');
    if (!root) return;
    clear(root);
    if (!view.network.length) { root.appendChild(el('p', { className: 'empty', text: 'No network destinations.' })); return; }
    var tbl = el('table', { className: 'mini-table' });
    for (var i = 0; i < view.network.length; i++) {
      var n = view.network[i];
      var tr = el('tr');
      var td = el('td');
      td.appendChild(el('code', { text: n.destination }));
      tr.appendChild(td);
      var dec = el('td');
      dec.appendChild(el('span', { className: 'chip chip-decision decision-' + n.decision, text: n.decision }));
      tr.appendChild(dec);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }
  function renderPolicy(view) {
    var root = document.getElementById('live-policy-body');
    if (!root) return;
    clear(root);
    if (!view.policyDecisions.length) { root.appendChild(el('p', { className: 'empty', text: 'No policy decisions.' })); return; }
    var tbl = el('table', { className: 'mini-table policy-table' });
    var head = el('tr', { className: 'mini-head' });
    ['capability', 'decision', 'provenance', 'rule'].forEach(function (h) { head.appendChild(el('th', { text: h })); });
    tbl.appendChild(head);
    for (var i = 0; i < view.policyDecisions.length; i++) {
      var d = view.policyDecisions[i];
      var tr = el('tr');
      var cap = el('td');
      cap.appendChild(el('code', { text: d.requestedCapability }));
      if (d.blocked) cap.appendChild(el('span', { className: 'chip chip-blocked', text: 'blocked' }));
      tr.appendChild(cap);
      var dec = el('td');
      dec.appendChild(el('span', { className: 'chip chip-decision decision-' + d.decision, text: d.decision }));
      tr.appendChild(dec);
      tr.appendChild(el('td', { text: d.provenanceLabel || '—' }));
      var rule = el('td', { className: 'rule-cell' });
      rule.textContent = d.rule || '—';
      tr.appendChild(rule);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }

  function renderSelectedRun() {
    if (!selectedRunId || !runs[selectedRunId]) return;
    var view = runs[selectedRunId];
    renderBadges(view);
    renderFailures(view);
    renderClaims(view);
    renderVerdict(view);
    renderTimeline(view);
    renderFiles(view);
    renderCommands(view);
    renderNetwork(view);
    renderPolicy(view);
  }

  /* --------------------------- mock event-stream driver --------------------------- */
  /*
   * Emits the SAME run/event envelope shapes the supervisor-side stdio server
   * produces (src/runEventProtocol.ts). The real supervisor stream slots in by
   * delivering these exact envelopes via the host's { type:'runEvent', event }
   * message — driveMockRun is only the demo source. Scenario presets exercise the
   * happy path AND every distinct failure state.
   */
  function mockTraceEvent(runId, seq, prevHash, type, payload) {
    // The hashes here are PLACEHOLDERS (not real chain hashes) — exactly like the
    // app.js mock sample. The default scenario's verdict therefore renders
    // signature/stale state honestly; the real stream carries real chain hashes.
    var hash = (seq.toString(16) + 'a').padEnd(64, '0').slice(0, 64);
    return { kind: 'trace_event', runId: runId, rev: 1, event: { v: 1, runId: runId, seq: seq, ts: Date.now(), type: type, prevHash: prevHash, hash: hash, payload: payload } };
  }

  function driveMockRun(scenario) {
    scenario = scenario || 'isolated-native';
    var runId = 'mock-' + scenario + '-' + Math.random().toString(36).slice(2, 8);
    var presets = mockScenarios(runId, scenario);
    var i = 0;
    function step() {
      if (i >= presets.length) return;
      ingestRunEvent(presets[i]);
      i++;
      setTimeout(step, 220);
    }
    step();
  }

  function mockScenarios(runId, scenario) {
    var opened = {
      kind: 'run_opened', runId: runId, rev: 1,
      actorType: 'native', trust: 'trusted', runtimeProfile: 'docker',
      runtimeTrust: 'trusted', extensionPosture: 'sovereign', cliFidelity: 'n/a', state: 'created',
    };
    var h0 = '0'.repeat(64);
    var base = [];
    if (scenario === 'dev-runtime') {
      // Non-isolated runtime: NEVER product-trusted, even with a valid verdict.
      opened.runtimeProfile = 'local-exec';
      opened.runtimeTrust = 'untrusted';
      opened.trust = 'untrusted';
    } else if (scenario === 'boundary-cli') {
      opened.actorType = 'claude-code-cli';
      opened.actorVersion = '1.0.0';
      opened.cliFidelity = 'boundary-only';
    } else if (scenario === 'sovereign-hook-cli') {
      opened.actorType = 'claude-code-cli';
      opened.cliFidelity = 'per-tool-brokered';
    }
    base.push(opened);
    base.push(mockTraceEvent(runId, 0, '', 'run_created', { runId: runId, runDir: '.glyphspek/runs/' + runId, provenanceLabel: 'user' }));
    base.push({ kind: 'state_changed', runId: runId, rev: 1, from: 'created', to: 'sandbox_ready', reason: 'sandbox ready, egress default-deny' });
    base.push(mockTraceEvent(runId, 1, '', 'policy_decision', { tool: 'command', requestedCapability: 'command:npm', decision: 'allow', provenanceLabel: 'repo', rule: 'allow.commands: ["npm"]' }));
    base.push(mockTraceEvent(runId, 2, '', 'tool_end', { tool: 'command', argv: ['npm', 'test'], exitCode: 0, durationMs: 8300, changedFiles: [{ path: 'src/date.ts', change: 'M' }, { path: 'test/date.test.ts', change: 'A' }] }));
    base.push(mockTraceEvent(runId, 3, '', 'policy_decision', { tool: 'network', requestedCapability: 'network:registry.npmjs.org', decision: 'allow', destination: 'https://registry.npmjs.org', provenanceLabel: 'repo' }));
    base.push({ kind: 'state_changed', runId: runId, rev: 1, from: 'sandbox_ready', to: 'completed', reason: 'actor reported complete' });
    // Claims — always its OWN envelope, never folded into a verdict.
    base.push({ kind: 'actor_claims', runId: runId, rev: 1, plan: 'Fix date parsing and add a regression test.', summary: 'Updated src/date.ts; all tests pass; ready to merge.', claimedChangedFiles: ['src/date.ts', 'test/date.test.ts'], claimedChecks: [{ name: 'unit tests', claim: 'pass' }, { name: 'typecheck', claim: 'pass' }] });

    // Verdict + per-scenario failure signal.
    if (scenario === 'missing-signature') {
      base.push({ kind: 'verifier_verdict', runId: runId, rev: 1, checks: [{ name: 'unit tests', command: ['npm', 'test'], status: 'pass' }], overallVerdict: 'pass', traceRootHash: 'deadbeef'.repeat(8).slice(0, 64) });
    } else if (scenario === 'tampered') {
      base.push({ kind: 'verifier_verdict', runId: runId, rev: 1, checks: [{ name: 'unit tests', command: ['npm', 'test'], status: 'pass' }], overallVerdict: 'pass', traceRootHash: 'deadbeef'.repeat(8).slice(0, 64), signature: { alg: 'ed25519', value: 'AAAA', keyId: 'k' } });
      base.push({ kind: 'failure', runId: runId, rev: 1, failure: 'tampered_trace', message: 'trace hash-chain verification failed upstream — the trace was modified.', brokenIndex: 2 });
    } else if (scenario === 'stale-verifier') {
      base.push({ kind: 'verifier_verdict', runId: runId, rev: 1, checks: [{ name: 'unit tests', command: ['npm', 'test'], status: 'pass' }], overallVerdict: 'pass', traceRootHash: 'cafebabe'.repeat(8).slice(0, 64), signature: { alg: 'ed25519', value: 'AAAA', keyId: 'k' } });
      base.push({ kind: 'failure', runId: runId, rev: 1, failure: 'stale_verifier', message: 'verifier verdict signs over an OLDER trace_root than the live trace.', staleRootHash: 'cafebabe'.repeat(8).slice(0, 64) });
    } else if (scenario === 'bridge-mismatch') {
      base.push({ kind: 'failure', runId: runId, rev: 1, failure: 'bridge_mismatch', message: 'supervisor bridge protocol/hash mismatch — refusing to treat this run as trusted.' });
    } else {
      // happy-path verdict (signature is a placeholder; renders honestly as not
      // verified against a pinned key unless one is provisioned).
      base.push({ kind: 'verifier_verdict', runId: runId, rev: 1, checks: [{ name: 'unit tests', command: ['npm', 'test'], status: 'pass' }, { name: 'typecheck', command: ['npm', 'run', 'typecheck'], status: 'pass' }], overallVerdict: 'pass', traceRootHash: 'feedface'.repeat(8).slice(0, 64), signature: { alg: 'ed25519', value: 'AAAA', keyId: 'verifier/2026-01' } });
    }
    base.push({ kind: 'run_closed', runId: runId, rev: 1, finalState: 'completed', eventCount: 5 });
    return base;
  }

  /* --------------------------- wiring --------------------------- */
  function wireLive() {
    // Host → webview run-event stream. The real supervisor stream and the mock
    // driver both arrive here, so the real stream slots in with NO renderer change.
    window.addEventListener('message', function (event) {
      var msg = event && event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'runEvent' && msg.event) {
        ingestRunEvent(msg.event);
      } else if (msg.type === 'runEvents' && Array.isArray(msg.events)) {
        for (var i = 0; i < msg.events.length; i++) ingestRunEvent(msg.events[i]);
      }
    });

    var demoBtn = document.getElementById('demo-live-btn');
    if (demoBtn) {
      demoBtn.addEventListener('click', function () { driveMockRun('isolated-native'); });
    }

    // Expose a tiny hook so the host (or a test page) can request a specific
    // scenario without a UI control. Not a security surface — view-only.
    // getRunView is read-only state inspection used by the schema-gate test.
    window.GLYPHSPEK_LIVE = {
      ingestRunEvent: ingestRunEvent,
      driveMockRun: driveMockRun,
      getRunView: function (runId) { return runs[runId] || null; },
      runIds: function () { return order.slice(); },
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      // Read-only trust summary over a run view (view-only, NOT a security surface).
      // Exposed so the golden-fixture conformance test (test/liveReducerGolden.test.mjs)
      // compares the WEBVIEW's OWN failure-severity ordering + eligibility against the
      // TS reducer (src/liveRunModel.ts), so a drift in either is caught (Finding 7).
      deriveTrustSummary: function (runId) {
        var v = runs[runId];
        return v ? deriveTrustSummary(v) : null;
      },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireLive);
  } else {
    wireLive();
  }
})();
