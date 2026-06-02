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

  // CANONICAL RunTrust SET (sweep-25 #1 — kill the duplication). The host injects
  // bridgeProtocol's RUN_TRUSTS as window.GLYPHSPEK_RUN_TRUSTS (a nonce-guarded
  // global, set BEFORE this script runs) so the run_opened gate below validates
  // `trust` against the EXACT same five-value vocabulary the contract defines —
  // never a hand-kept array that drifts and silently drops a real governed posture
  // (governed-unsandboxed, sandboxed-soft-egress). The literal here is only a
  // fail-safe MIRROR of bridgeProtocol.RUN_TRUSTS for the (test/edge) case where the
  // global is absent; it is the same five values, so a dropped injection still
  // accepts every canonical posture rather than failing closed on valid runs.
  var RUN_TRUSTS = (typeof window !== 'undefined' && Array.isArray(window.GLYPHSPEK_RUN_TRUSTS))
    ? window.GLYPHSPEK_RUN_TRUSTS
    : ['trusted', 'sandboxed-soft-egress', 'governed-unsandboxed', 'untrusted', 'refused'];
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
  // A runId the host asked to focus (Governed Runs tree click) before it streamed.
  // Adopted the moment that run first appears in ingestRunEvent. View-only nav.
  var pendingHostSelection = null;

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
        loopbackProxyBypass: false,
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
        // F1: an observe-only egress is OBSERVED (soft default-allow), NOT a policy
        // allow — surface it distinctly so it never reads as "policy: allowed".
        var obs = p.enforcement === 'observe-only';
        out.push({ destination: String(p.destination || p.requestedCapability || '(unknown)'), decision: String(p.decision || ''), blocked: obs ? false : !!p.blocked, observeOnly: obs });
      }
    }
    return out;
  }
  function derivePolicyDecisions(trace) {
    var out = [];
    for (var i = 0; i < trace.length; i++) {
      if (trace[i].type !== 'policy_decision') continue;
      var p = payloadOf(trace[i]);
      // F1: carry observe-only through so a soft-plane observation is never read as
      // a real policy allow.
      var obs = p.enforcement === 'observe-only';
      out.push({
        tool: String(p.tool || ''),
        requestedCapability: String(p.requestedCapability || ''),
        decision: String(p.decision || ''),
        blocked: obs ? false : !!p.blocked,
        rule: p.rule ? String(p.rule) : undefined,
        provenanceLabel: p.provenanceLabel ? String(p.provenanceLabel) : undefined,
        enforcement: obs ? 'observe-only' : undefined,
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
          // F2: surface the loopback-bypass posture so the panel labels loopback as
          // unobserved local traffic (the carve-out means it is NOT in the trace).
          loopbackProxyBypass: event.loopbackProxyBypass === true,
          loopbackProxyBypassReason: event.loopbackProxyBypassReason,
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
      // Validate `trust` against the INJECTED canonical RUN_TRUSTS set (sweep-25 #1)
      // rather than a hardcoded array, so EVERY valid posture is accepted — including
      // governed-unsandboxed (the governed-terminal demo posture) and
      // sandboxed-soft-egress. Product-trust is gated SEPARATELY by
      // isProductTrustEligible (strict 'trusted'), so accepting the value here never
      // confers product authority. Mirrors src/runEventProtocol.ts validateRunEvent.
      if (RUN_TRUSTS.indexOf(e.trust) === -1) return { ok: false, reason: 'malformed' };
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
    // If the host asked to focus a run that has now arrived, honor that selection
    // and stop auto-advancing selection to other newly-opened runs.
    if (pendingHostSelection && raw.runId === pendingHostSelection) {
      selectedRunId = pendingHostSelection;
      pendingHostSelection = null;
    } else if (!pendingHostSelection) {
      // Auto-select the most recently opened/active run if none chosen yet.
      if (!selectedRunId) selectedRunId = raw.runId;
      if (raw.kind === 'run_opened') selectedRunId = raw.runId;
    }
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

  /*
   * Focus a run requested by the host (the activity-bar Governed Runs tree). If the
   * run is already known, select + render it; otherwise record it as the desired
   * selection so the next event that creates it focuses it (ingestRunEvent only
   * auto-selects when nothing is selected, so set it directly here). View-only.
   */
  function selectRunFromHost(runId) {
    showLiveView();
    if (runs[runId]) {
      selectedRunId = runId;
      pendingHostSelection = null;
      renderRunList();
      renderSelectedRun();
    } else {
      // Not streamed yet: remember it and adopt it the moment it appears.
      pendingHostSelection = runId;
      selectedRunId = runId;
      renderRunList();
    }
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

  /* ============================================================ *
   * SLICE 1 — BLENDED FRICTION SURFACE (BLENDED-WORKBENCH-SPEC.md §5.8, §6, §7).
   *
   * Two ORTHOGONAL axes, both DERIVED from already-computed honest state — neither
   * re-decides trust:
   *   - data-authority (ASSURANCE, §7): read | claimed | soft | verified | denied,
   *     from run lifecycle + the SOFT posture + productTrustEligible + the signature
   *     gate. SOFT (governed-unsandboxed / boundary-only / sandboxed-soft-egress) is
   *     CAPPED at violet here exactly because CREATION_TRUST_BADGE marks it
   *     productTrusted:false — verified-blue is reachable ONLY for a product-trust-
   *     eligible run whose signature verified against a PRODUCT key (the same gate the
   *     verdict pane uses). We never paint blue from a claim.
   *   - data-tier (FRICTION, §6): ask | inline | governed | sensitive | sovereign,
   *     derived from the run's posture + whether it crossed the canonical sensitive
   *     boundary. The live panel is a GOVERNED-run surface, so it defaults to
   *     'governed'; 'sovereign' is reflected from the Sovereign extension posture.
   * ============================================================ */

  // The SOFT (capped-at-violet) creation-trust postures. A run in any of these can
  // reach data-authority='soft' but NEVER 'verified' — read straight from the shared
  // CREATION_TRUST_BADGE.productTrusted gate so this can't drift from the state cap.
  function isSoftPosture(creationTrust) {
    var badge = CREATION_TRUST_BADGE[creationTrust];
    // productTrusted:false AND not an outright failure posture = the SOFT band.
    return !!badge && badge.productTrusted === false &&
      creationTrust !== 'untrusted' && creationTrust !== 'refused';
  }

  /**
   * DERIVE the assurance axis (data-authority) from a run view. Pure; mirrors the
   * verdict pane's own gate so the halo can never imply more than the verdict shows.
   * Returns 'read' | 'claimed' | 'soft' | 'verified' | 'denied'.
   */
  function deriveAuthority(view) {
    if (!view) return 'read';
    var summary = deriveTrustSummary(view);
    // DENIED: any de-authoritative failure (tamper / non-isolated runtime / stale /
    // bridge mismatch) flips the halo red — the panel's strongest signal.
    var denied = ['tampered_trace', 'non_isolated_runtime', 'stale_verifier', 'bridge_mismatch'];
    for (var i = 0; i < view.failures.length; i++) {
      if (denied.indexOf(view.failures[i].state) !== -1) return 'denied';
    }
    // VERIFIED: only when the run is product-trust ELIGIBLE and a PRODUCT-tier
    // signature verified (the exact gate renderVerdict uses for green). A demo-tier
    // or untrusted-key signature is NOT verified-blue here.
    var res = view.sigResult;
    var sigByProduct = !!res && res.status === 'verified' && res.tier === 'product';
    var chain = view.chainResult;
    var bundleConsistent = !!chain && chain.chainOk === true && chain.rootMatches === true;
    if (view.productTrustEligible && sigByProduct && bundleConsistent) return 'verified';
    // SOFT: a governed-unsandboxed / boundary / soft-egress run is capped at violet.
    if (isSoftPosture(view.badges.creationTrust)) return 'soft';
    // CLAIMED: the agent has acted (we have a verdict or claims), but it is unverified.
    if (view.verdict || view.claims) return 'claimed';
    // READ: no execution authority exercised yet.
    return 'read';
  }

  /**
   * DERIVE the friction tier (data-tier) from a run view. The live panel is a
   * governed-run surface, so the baseline is 'governed'; Sovereign extension posture
   * reflects to 'sovereign'; a run that crossed the canonical sensitive boundary
   * reflects to 'sensitive'. (ask/inline are pre-run authority tiers driven by the
   * Ask overlay / inline-edit surfaces — Slice 2 — not by a live governed run.)
   * Pure; returns one of ask|inline|governed|sensitive|sovereign.
   */
  // The CANONICAL sensitive-boundary surfaces (§6) — kept in ONE place so the strip
  // copy and the tier derivation can't drift.
  var SENSITIVE_BOUNDARY = ['secrets', 'network', 'infra', 'migrations', 'auth', 'ci/cd', 'deploy'];
  function crossedSensitiveBoundary(view) {
    // A network policy decision that was actually enforced (not soft observe-only) is
    // the one sensitive surface we can read honestly from the live trace today.
    for (var i = 0; i < view.policyDecisions.length; i++) {
      var d = view.policyDecisions[i];
      if (d.tool === 'network' && d.enforcement !== 'observe-only' && d.blocked) return true;
    }
    return false;
  }
  function deriveTier(view) {
    if (!view) return 'governed';
    if (view.badges.extensionPosture === 'sovereign') return 'sovereign';
    if (crossedSensitiveBoundary(view)) return 'sensitive';
    return 'governed';
  }

  /** Per-tier friction copy (§6) + the level-chip glyph/label per authority (§3.4). */
  var FRICTION_COPY = {
    ask: 'Ask: no execution authority — Q&A and explanation only. Answers are useful context, <b>not independently verified</b>; acting requires promotion.',
    inline: 'Inline edit: a proposed <b>diff</b> in context — the claims/verdict split stays legible. No terminal or network authority until you promote.',
    governed: 'Governed run: the full trust stack is on — sandbox, policy, trace, and the independent <b>verifier</b>.',
    sensitive: 'Sensitive governed run: this run touches a dangerous surface — <b>fresh approval</b> is required and named in the boundary strip below.',
    sovereign: 'Sovereign / high-security: maximum evidence and the curated posture below — offline verification, no call-home, hard runtime.',
  };
  // Non-color redundancy for the level chip (§3.4): a glyph + a short label per
  // assurance state, so the halo's meaning survives grayscale / color-blindness.
  var AUTHORITY_CHIP = {
    read: { glyph: '•', label: 'read · no authority yet' },
    claimed: { glyph: '◇', label: 'claimed · self-reported, unverified' },
    soft: { glyph: '◈', label: 'SOFT · governed-unsandboxed' },
    verified: { glyph: '✓', label: 'verified · signed' },
    denied: { glyph: '✕', label: 'UNTRUSTED · denied' },
  };

  /* ============================================================ *
   * SLICE 2 — AUTHORITY LADDER (the VIEW axis) — manual override state.
   *
   * The ladder is a five-rung radiogroup that DRIVES data-tier (which Slice 1's
   * friction surface + dimming already read). CRITICAL HONESTY (§2.4 / §6 "tier is
   * enforced authority, not a UI hint"): a rung selection is a VIEW control — it
   * chooses WHICH evidence to show, it does NOT grant authority. So:
   *   - data-tier  ← the manual ladder override when the user has slid the ladder,
   *                  ELSE the run's reflected deriveTier(view).
   *   - data-authority ← ALWAYS deriveAuthority(view) (the real run state). The
   *                  rung never touches the assurance axis; sliding the ladder to
   *                  "Ask" does NOT make a verified run unverified, and sliding to
   *                  "Governed" does NOT confer trust. The halo/level-chip keep
   *                  showing the run's true assurance regardless of the view rung.
   * The Governed→Sensitive enforcement (§6) lives in the supervisor (Promote's
   * modal / the build's `approved` grant), not in the rung — the rung only changes
   * which evidence you are looking at.
   * ============================================================ */
  var LADDER_TIERS = ['ask', 'inline', 'governed', 'sensitive', 'sovereign'];
  // The user's manual view-tier selection (null = follow the run's reflected tier).
  var viewTierOverride = null;
  // The authority last posted to the host (so the status-bar `verified` segment is
  // driven by the SAME gate the verdict pane uses). Avoids redundant posts.
  var lastPostedAuthority = null;
  // The friction TIER last posted to the host (so the fork chrome can react to it —
  // e.g. recede the editor at Ask). De-duplicated like the authority post. This is
  // the FRICTION axis only; it NEVER carries or implies assurance (data-authority).
  var lastPostedTier = null;
  // PATCH-009 loop-breaker: when TRUE, postTier() is suppressed. Set while applying a
  // tier the HOST pushed (from a native title-bar ladder click) so syncing the webview
  // ladder does NOT echo `glyphspekTier` straight back to the host — the host already
  // set the context-key. The native ladder reads the key; the webview reads the host
  // push. One source, no round-trip.
  var applyingHostTier = false;

  /**
   * Apply the derived axes to the live-view root + populate the friction surface.
   * DOM-only; safe to call with no DOM (early-returns), so node:vm render tests stay
   * silent. Reads ONLY derived state — it never decides trust.
   *
   * data-authority is ALWAYS the run's real assurance (deriveAuthority); data-tier
   * is the manual ladder override when set, else the run's reflected tier. The
   * computed authority is posted to the host so the status-bar `authority:` segment
   * + the future fork halo can reach `verified` ONLY on this signature-gated state.
   */
  function setFrictionSurface(view) {
    var root = document.getElementById('live-view');
    if (!root) return;
    var authority = deriveAuthority(view);
    var reflectedTier = deriveTier(view);
    // The ladder is a VIEW control: honor a manual override, else reflect the run.
    var tier = viewTierOverride || reflectedTier;
    root.setAttribute('data-authority', authority);
    root.setAttribute('data-tier', tier);

    var chip = document.getElementById('authority-level');
    if (chip) {
      var a = AUTHORITY_CHIP[authority] || AUTHORITY_CHIP.read;
      chip.setAttribute('data-glyph', a.glyph);
      chip.textContent = a.label;
    }
    var note = document.getElementById('friction-note');
    if (note) note.innerHTML = FRICTION_COPY[tier] || FRICTION_COPY.governed;

    // SOFT side-chat card: present only when the selected run is a SOFT posture.
    var softCard = document.getElementById('soft-chat-card');
    if (softCard) softCard.hidden = !isSoftPosture(view.badges.creationTrust);

    // Reflect the effective tier on the ladder rungs (ARIA) + toggle the Ask
    // surface, and surface the reflect-not-grant note when the view is MANUAL.
    syncLadder(tier, viewTierOverride !== null && viewTierOverride !== reflectedTier);

    // Post the run's REAL assurance to the host (Slice 2 §1.12). This is the ONLY
    // signal that lets the status bar `verified` segment light up, because it
    // carries the result of the webview's signature-before-display gate the host
    // cannot run. View-only on the panel; honest by construction.
    postAuthority(view.runId, authority);

    // Publish the effective FRICTION tier to the host (orthogonal to authority) so
    // fork chrome can react — e.g. recede the center editor at Ask. View-only: this
    // is "which evidence to show / how light the surface feels", NOT a grant. The
    // promote modal remains the only authority door.
    postTier(tier);
  }

  /**
   * Reflect the effective FRICTION tier onto the ladder's ARIA radio state + the
   * tabindex roving (a radiogroup has ONE tab stop on the checked rung), toggle the
   * Ask surface, and show/hide the reflect-not-grant note. Pure DOM; safe with no DOM.
   * `manual` = the user has slid the ladder away from the run's reflected tier.
   */
  function syncLadder(tier, manual) {
    var ladder = document.getElementById('authority-ladder');
    if (ladder && typeof ladder.querySelectorAll === 'function') {
      var rungs = ladder.querySelectorAll('.rung');
      for (var i = 0; i < rungs.length; i++) {
        var r = rungs[i];
        var checked = r.getAttribute('data-tier') === tier;
        r.setAttribute('aria-checked', checked ? 'true' : 'false');
        // Roving tabindex: only the checked rung is in the tab order.
        r.setAttribute('tabindex', checked ? '0' : '-1');
      }
    }
    // Ask surface: visible only at the ask tier (also gated in CSS; hidden attr
    // keeps it out of the a11y tree when not Ask).
    var ask = document.getElementById('ask-surface');
    if (ask) ask.hidden = tier !== 'ask';
    // The ladder-note is always present, but emphasize it when the view is manual
    // (the user is inspecting a tier the run is not actually at).
    var lnote = document.getElementById('ladder-note');
    if (lnote) lnote.setAttribute('data-manual', manual ? 'true' : 'false');
  }

  /**
   * The user selected a rung (or pressed a key on the ladder). Set the VIEW tier
   * override and re-render the selected run so Slice 1's friction surface + dimming
   * + the Ask surface reflect the chosen tier. This NEVER grants authority — it is
   * the "which evidence to show" control (§2.4). Selecting the run's own reflected
   * tier clears the override (back to following the run).
   */
  function setViewTier(tier) {
    if (LADDER_TIERS.indexOf(tier) === -1) return;
    viewTierOverride = tier;
    if (selectedRunId && runs[selectedRunId]) {
      // Clear the override if the chosen tier IS the run's reflected tier (follow).
      if (deriveTier(runs[selectedRunId]) === tier) viewTierOverride = null;
      setFrictionSurface(runs[selectedRunId]);
    } else {
      // No run yet (pre-run Ask exploration): apply the tier to the bare root so the
      // Ask surface can show. data-authority stays whatever it was (no run = read).
      var root = document.getElementById('live-view');
      if (root) {
        root.setAttribute('data-tier', tier);
        if (!root.getAttribute('data-authority')) root.setAttribute('data-authority', 'read');
        var note = document.getElementById('friction-note');
        if (note) note.innerHTML = FRICTION_COPY[tier] || FRICTION_COPY.governed;
        syncLadder(tier, true);
      }
      // Pre-run Ask exploration still publishes the tier so the fork can recede the
      // editor the moment the user slides to Ask, before any run exists (the selected-
      // run path posts via setFrictionSurface above).
      postTier(tier);
    }
    // Move keyboard focus to the now-checked rung (radiogroup focus management).
    focusCheckedRung();
  }

  /** Focus the currently-checked rung (after a keyboard/selection change). */
  function focusCheckedRung() {
    var ladder = document.getElementById('authority-ladder');
    if (!ladder || typeof ladder.querySelector !== 'function') return;
    var checked = ladder.querySelector('.rung[aria-checked="true"]');
    if (checked && typeof checked.focus === 'function') checked.focus();
  }

  /**
   * The ladder's current effective tier — read from the checked rung's data-tier
   * (the single source of truth the keyboard handler steps from), falling back to
   * the override / governed. Pure-ish (DOM read only).
   */
  function currentLadderTier() {
    var ladder = document.getElementById('authority-ladder');
    if (ladder && typeof ladder.querySelector === 'function') {
      var checked = ladder.querySelector('.rung[aria-checked="true"]');
      if (checked && checked.getAttribute) {
        var t = checked.getAttribute('data-tier');
        if (t) return t;
      }
    }
    return viewTierOverride || 'governed';
  }

  /**
   * Post the run's REAL assurance to the host (Slice 2 §1.12). De-duplicated by
   * (runId, authority) so we don't spam the host. The host uses ONLY 'verified' to
   * light the status-bar `verified` segment; every other value clears that flag, so
   * a tamper honestly drops the run off blue. View-only — confers no trust.
   */
  function postAuthority(runId, authority) {
    if (!runId) return;
    var key = runId + ' ' + authority;
    if (key === lastPostedAuthority) return;
    lastPostedAuthority = key;
    if (typeof window !== 'undefined' && typeof window.GLYPHSPEK_POST === 'function') {
      window.GLYPHSPEK_POST({ type: 'glyphspekAuthority', runId: runId, authority: authority });
    }
  }

  /**
   * Post the effective FRICTION tier to the host (mirrors postAuthority, but on the
   * orthogonal axis). De-duplicated so we don't spam the host on every re-render. The
   * host mirrors it to the `glyphspek.tier` context-key the fork chrome reads to
   * recede the editor at Ask. VIEW-ONLY — it carries no assurance and grants nothing;
   * the promote modal stays the only authority door.
   */
  function postTier(tier) {
    if (LADDER_TIERS.indexOf(tier) === -1) return;
    // Loop-breaker (PATCH-009): suppress the echo while applying a host-pushed tier
    // (a native title-bar ladder click). The host already set the context-key; echoing
    // would be a redundant round-trip. Still record lastPostedTier so a later genuine
    // webview-originated change to a DIFFERENT tier still posts.
    if (applyingHostTier) { lastPostedTier = tier; return; }
    if (tier === lastPostedTier) return;
    lastPostedTier = tier;
    if (typeof window !== 'undefined' && typeof window.GLYPHSPEK_POST === 'function') {
      window.GLYPHSPEK_POST({ type: 'glyphspekTier', tier: tier });
    }
  }

  /**
   * Apply a friction tier the HOST pushed (PATCH-009) — from a NATIVE title-bar
   * Authority Ladder rung click. Syncs the webview ladder via the SAME setViewTier path
   * the webview's own rungs use, but suppresses the `glyphspekTier` echo so there is no
   * host↔webview loop (the host already set the context-key the native ladder reads).
   * VIEW-ONLY — confers no authority, never touches data-authority.
   */
  function applyHostTier(tier) {
    if (LADDER_TIERS.indexOf(tier) === -1) return;
    applyingHostTier = true;
    try {
      setViewTier(tier);
    } finally {
      applyingHostTier = false;
    }
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

  /**
   * SHARED, EXHAUSTIVE creation-trust → badge map (sweep-24 #3). EVERY RunTrust
   * value MUST appear here so a new posture cannot silently render without a badge.
   * `productTrusted: false` on a posture documents that it is NEVER shown as
   * product-trusted. Amber postures (governed-unsandboxed, sandboxed-soft-egress) are
   * governed-but-not-hard; 'trusted' is the only product-trust-eligible posture (and
   * even then only "pending gate"); untrusted/refused are failure-red.
   */
  var CREATION_TRUST_BADGE = {
    'trusted': {
      className: 'creation-trusted',
      text: 'creation: trusted (pending gate)',
      productTrusted: true,
    },
    'sandboxed-soft-egress': {
      className: 'creation-sandboxed-soft-egress',
      text: 'Sandboxed (soft egress) — not hard containment',
      productTrusted: false,
    },
    'governed-unsandboxed': {
      className: 'creation-governed-unsandboxed',
      text: 'Governed (soft) — metadata-only, not sandboxed',
      productTrusted: false,
    },
    'untrusted': {
      className: 'creation-untrusted',
      text: 'creation: UNTRUSTED',
      productTrusted: false,
    },
    'refused': {
      className: 'creation-untrusted',
      text: 'creation: REFUSED',
      productTrusted: false,
    },
  };

  /**
   * Resolve a creation-trust posture to its badge via the shared exhaustive map.
   * Returns null only for an absent/unknown posture (no creation badge rendered),
   * which the golden test asserts never happens for a real RunTrust value.
   */
  function creationTrustBadge(ct) {
    if (!ct) return null;
    return CREATION_TRUST_BADGE[ct] || null;
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

    // Creation-trust badge (sweep-23 #2, sweep-24 #3). Surfaces the run-creation
    // posture honestly. The label/CSS for EVERY RunTrust value lives in the shared
    // exhaustive CREATION_TRUST_BADGE map below, so a NEW posture cannot silently
    // fall through with no badge (the sandboxed-soft-egress gap this fix closes).
    var ctBadge = creationTrustBadge(b.creationTrust);
    if (ctBadge) {
      root.appendChild(el('span', { className: 'trust-badge ' + ctBadge.className, text: ctBadge.text }));
    }

    // Actor + creation-trust badge.
    root.appendChild(el('span', {
      className: 'trust-badge actor-badge',
      text: 'actor: ' + b.actorType + (b.actorVersion ? ' ' + b.actorVersion : ''),
    }));

    // F2: loopback-bypass badge. When the governed terminal exempts loopback from
    // the proxy, loopback traffic BYPASSES the proxy and is UNOBSERVED — label it
    // honestly so "every destination is recorded" is never implied.
    if (b.loopbackProxyBypass) {
      root.appendChild(el('span', {
        className: 'trust-badge loopback-unobserved',
        text: 'loopback: unobserved local traffic',
        title: b.loopbackProxyBypassReason || 'loopback (127.0.0.1/::1/localhost) is exempt from the egress proxy — local IPC / OAuth callbacks, NOT external egress — so it is not recorded in the trace',
      }));
    }

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
      case 'model_call': return summarizeModelCall(p);
      case 'actor_claimed_success': return 'actor claims success (NOT a verdict)';
      default: return JSON.stringify(p);
    }
  }

  /**
   * Summarize a model_call event HONESTLY (sweep-24 #1). A metadata-only boundary
   * observation against a BROAD-WEB origin (e.g. chatgpt.com) is host-only evidence:
   * the proxy cannot see the TLS path, so a host match is WEAK proof this egress was
   * actually a model call. We label it as LOWER assurance rather than presenting it
   * identically to a narrow-API (api.*) model call. A brokered/decrypted call (no
   * 'metadata-only' observation) keeps the full token summary.
   */
  function summarizeModelCall(p) {
    var base = 'model=' + p.model;
    if (p.observation === 'metadata-only') {
      // Boundary observation: tokens absent by construction; show byte counts.
      var bytes = 'bytes=' + (p.bytesUp || 0) + '↑ / ' + (p.bytesDown || 0) + '↓';
      var assurance = p.originAssurance === 'broad-web'
        ? '   LOWER ASSURANCE: host-only evidence — broad origin, path not verified'
        : '   metadata-only (boundary): host-match evidence';
      return base + '   ' + bytes + assurance;
    }
    return base + '   tokens=' + (p.inputTokens || 0) + ' in / ' + (p.outputTokens || 0) + ' out';
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
      // F1: an observe-only egress is OBSERVED on the bypassable soft plane, NOT a
      // policy allow. Label it distinctly so a reviewer never reads it as
      // "policy: allowed".
      if (n.observeOnly) {
        dec.appendChild(el('span', { className: 'chip chip-decision decision-observe', text: 'observed (soft, default-allow)' }));
      } else if (n.decision === 'allow') {
        dec.appendChild(el('span', { className: 'chip chip-decision decision-allow', text: 'policy: allowed' }));
      } else {
        dec.appendChild(el('span', { className: 'chip chip-decision decision-' + n.decision, text: n.decision }));
      }
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
      // F1: a soft-plane observe-only decision is OBSERVED (bypassable default-allow),
      // NOT a real policy allow — label it distinctly, mirroring the Network table.
      if (d.enforcement === 'observe-only') {
        dec.appendChild(el('span', { className: 'chip chip-decision decision-observe', text: 'observed (soft, default-allow)' }));
      } else {
        dec.appendChild(el('span', { className: 'chip chip-decision decision-' + d.decision, text: d.decision }));
      }
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
    setFrictionSurface(view);
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

  /* ================================================================== *
   * AGENTIC BUILD REVIEW (Phase B — view layer).
   *
   * Renders an AgenticBuildReview evidence object so a developer can review a
   * governed agent run from EVIDENCE rather than the transcript:
   *   intent + actor + honest posture, verdict + signature state, changed files,
   *   a unified-diff viewer, commands + exit codes, observed egress, and an
   *   accept / reject / request-changes decision.
   *
   * HONESTY: the posture is `governed-unsandboxed` — this surface governs and
   * traces a run, it does NOT contain it, so it is NEVER product-trusted. The
   * verdict badge shows assurance (full/degraded) and the signature state; a
   * pass is shown as a pass, never as a product-trusted success.
   *
   * The diff is rendered via textContent/DOM (el() sets textContent, never
   * innerHTML), so the diff string — untrusted run content — cannot inject markup
   * under the webview's strict CSP.
   * ================================================================== */

  // The runId of the review currently shown (so a decision posts the right id).
  var abrCurrentRunId = null;

  /**
   * Parse a unified diff (`git diff`) string into per-file sections with
   * classified lines. Pure: no DOM, no deps. Returns
   *   { files: [{ header, oldPath, newPath, status, lines: [{ kind, text }] }] }
   * where line.kind is one of 'meta' | 'hunk' | 'add' | 'del' | 'context'.
   * A leading preamble (before the first `diff --git`/`---`) is tolerated and
   * dropped. Tested directly in test/agenticBuildReview.test.mjs.
   */
  function parseUnifiedDiff(diffText) {
    var files = [];
    if (typeof diffText !== 'string' || diffText.length === 0) {
      return { files: files };
    }
    var rawLines = diffText.split('\n');
    var current = null;
    function startFile(header) {
      current = { header: header || '', oldPath: null, newPath: null, status: 'modified', lines: [] };
      files.push(current);
    }
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i];
      if (line.indexOf('diff --git ') === 0) {
        // New file section. Derive paths from "a/<old> b/<new>".
        startFile(line);
        var m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        if (m) { current.oldPath = m[1]; current.newPath = m[2]; }
        current.lines.push({ kind: 'meta', text: line });
        continue;
      }
      if (line.indexOf('--- ') === 0) {
        // A `---` with no preceding `diff --git` still begins a file section.
        if (!current) startFile('');
        var oldP = line.slice(4);
        current.oldPath = oldP === '/dev/null' ? null : oldP.replace(/^a\//, '');
        if (oldP === '/dev/null') current.status = 'added';
        current.lines.push({ kind: 'meta', text: line });
        continue;
      }
      if (line.indexOf('+++ ') === 0) {
        if (!current) startFile('');
        var newP = line.slice(4);
        current.newPath = newP === '/dev/null' ? null : newP.replace(/^b\//, '');
        if (newP === '/dev/null') current.status = 'deleted';
        current.lines.push({ kind: 'meta', text: line });
        continue;
      }
      if (line.indexOf('@@') === 0) {
        if (!current) startFile('');
        current.lines.push({ kind: 'hunk', text: line });
        continue;
      }
      // File-level metadata lines (mode/index/new file/etc.) before any hunk.
      if (current && current.lines.length && !hasHunk(current) &&
          (line.indexOf('new file') === 0 || line.indexOf('deleted file') === 0 ||
           line.indexOf('index ') === 0 || line.indexOf('old mode') === 0 ||
           line.indexOf('new mode') === 0 || line.indexOf('rename ') === 0 ||
           line.indexOf('similarity ') === 0 || line.indexOf('Binary files') === 0)) {
        if (line.indexOf('new file') === 0) current.status = 'added';
        if (line.indexOf('deleted file') === 0) current.status = 'deleted';
        current.lines.push({ kind: 'meta', text: line });
        continue;
      }
      if (!current) {
        // Preamble before any file header — ignore (e.g. a commit message blob).
        continue;
      }
      var first = line.charAt(0);
      if (first === '+') current.lines.push({ kind: 'add', text: line });
      else if (first === '-') current.lines.push({ kind: 'del', text: line });
      else if (first === '\\') current.lines.push({ kind: 'meta', text: line }); // "\ No newline at end of file"
      else current.lines.push({ kind: 'context', text: line });
    }
    return { files: files };
  }
  function hasHunk(file) {
    for (var i = 0; i < file.lines.length; i++) {
      if (file.lines[i].kind === 'hunk') return true;
    }
    return false;
  }

  /**
   * Build the unified-diff DOM for a parsed diff. Each file is a section with a
   * path header; each line is a row with a class per kind so +/- coloring is CSS.
   * Returns a DocumentFragment so callers control mounting. Pure-ish (DOM only).
   */
  function buildDiffView(parsed) {
    var frag = document.createDocumentFragment();
    if (!parsed.files.length) {
      frag.appendChild(el('p', { className: 'empty', text: 'No diff in this review.' }));
      return frag;
    }
    for (var f = 0; f < parsed.files.length; f++) {
      var file = parsed.files[f];
      var section = el('div', { className: 'abr-diff-file' });
      var head = el('div', { className: 'abr-diff-file-head' });
      var path = file.newPath || file.oldPath || '(unknown file)';
      head.appendChild(el('span', { className: 'abr-diff-status abr-diff-status-' + file.status, text: file.status }));
      head.appendChild(el('code', { className: 'abr-diff-path', text: path }));
      section.appendChild(head);
      var body = el('div', { className: 'abr-diff-lines mono' });
      for (var i = 0; i < file.lines.length; i++) {
        var ln = file.lines[i];
        var row = el('div', { className: 'abr-diff-line abr-line-' + ln.kind });
        // textContent only (el sets textContent for `text`) — the diff string is
        // untrusted run content and must never be parsed as HTML.
        row.appendChild(el('span', { className: 'abr-diff-line-text', text: ln.text }));
        body.appendChild(row);
      }
      section.appendChild(body);
      frag.appendChild(section);
    }
    return frag;
  }

  /**
   * Resolve the honest verdict badge for an AgenticBuildReview verdict. Returns
   * { overall, overallClass, assurance, assuranceDegraded, sig } where `sig` is the
   * honest signature-state descriptor. NEVER returns a "product-trusted" label —
   * a pass is a pass, gated by assurance + signature state, not product trust.
   */
  function abrVerdictBadge(verdict) {
    var overall = (verdict && verdict.overall) || 'error';
    var assurance = (verdict && verdict.assurance) || 'degraded';
    var sig = verdict && verdict.signature;
    var sigState;
    if (!sig) {
      sigState = { className: 'abr-sig-none', text: 'unsigned — verdict cannot be authoritative' };
    } else {
      // The view layer reports the signature is PRESENT; it does NOT assert the
      // signature verifies (that crypto gate is the live-bundle path). Honest:
      // "signature present" is not "signature trusted".
      sigState = {
        className: 'abr-sig-present',
        text: 'signed (' + (sig.alg || 'unknown') + ', key ' + shortHash(sig.keyId || sig.value || '') + ') — present, not independently verified here',
      };
    }
    return {
      overall: overall,
      overallClass: 'verdict-' + overall,
      assurance: assurance,
      assuranceDegraded: assurance !== 'full',
      sig: sigState,
    };
  }

  function renderAbrHeader(review) {
    var root = document.getElementById('abr-header-body');
    if (!root) return;
    clear(root);

    // Intent.
    var intent = el('div', { className: 'abr-field' });
    intent.appendChild(el('div', { className: 'field-label', text: 'Task intent' }));
    intent.appendChild(el('div', { className: 'abr-intent', text: review.intent || '(no intent recorded)' }));
    root.appendChild(intent);

    // Actor + posture badge row.
    var badges = el('div', { className: 'badge-row abr-badge-row' });
    badges.appendChild(el('span', { className: 'trust-badge actor-badge', text: 'actor: ' + (review.actor || 'unknown') }));
    // HONEST POSTURE — governed-unsandboxed is governed-but-not-contained and is
    // NEVER product-trusted. Reuse the live panel's amber creation badge styling.
    badges.appendChild(el('span', {
      className: 'trust-badge creation-governed-unsandboxed',
      text: 'posture: governed-unsandboxed — traced, NOT sandboxed, NOT product-trusted',
      title: 'GlyphSpek governs and traces this run (egress observed, trace signed) but does not contain it. The verdict is honest evidence, never a product-trusted guarantee.',
    }));
    root.appendChild(badges);

    // Verdict banner + assurance + signature state.
    var v = abrVerdictBadge(review.verdict);
    // HONESTY (sweep): tint the banner by ASSURANCE, not by `overall` alone. A
    // degraded (inline/unsandboxed) pass must NOT read as full success-green —
    // a hurried reader could over-read it as a verified pass. When assurance is
    // degraded we use the existing amber `verdict-error` styling (same
    // .verdict-banner element) instead of `verdict-pass`. The honest sub-labels
    // (posture badge, assurance pill, "not independently verified here" sig chip)
    // stay intact below.
    var bannerClass = v.assuranceDegraded ? 'verdict-error' : v.overallClass;
    var banner = el('div', { className: 'verdict-banner ' + bannerClass + ' abr-verdict-banner' });
    banner.appendChild(el('span', { className: 'verdict-label', text: 'VERIFIER VERDICT' }));
    banner.appendChild(el('span', { className: 'verdict-value', text: v.overall }));
    root.appendChild(banner);

    var meta = el('div', { className: 'abr-verdict-meta' });
    // Assurance pill — degraded is shown honestly, never hidden.
    meta.appendChild(el('span', {
      className: 'verdict-pill ' + (v.assuranceDegraded ? 'check-error' : 'check-pass'),
      text: 'assurance: ' + v.assurance,
    }));
    // Signature state.
    meta.appendChild(el('span', { className: 'abr-sig-chip ' + v.sig.className, text: v.sig.text }));
    root.appendChild(meta);

    // Per-check breakdown (reuse verdict-pill check-<status> styling).
    var checks = (review.verdict && review.verdict.checks) || [];
    if (checks.length) {
      var tbl = el('table', { className: 'mini-table check-table abr-check-table' });
      for (var i = 0; i < checks.length; i++) {
        var ck = checks[i];
        var tr = el('tr');
        tr.appendChild(el('td', { text: ck.name }));
        var st = el('td');
        st.appendChild(el('span', { className: 'verdict-pill check-' + ck.status, text: ck.status }));
        tr.appendChild(st);
        tbl.appendChild(tr);
      }
      root.appendChild(tbl);
    }
  }

  function renderAbrSummary(review) {
    var root = document.getElementById('abr-summary-body');
    if (!root) return;
    clear(root);
    root.appendChild(el('p', { className: 'abr-summary', text: review.summary || '(the agent provided no summary)' }));
  }

  function renderAbrFiles(review) {
    var root = document.getElementById('abr-files-body');
    if (!root) return;
    clear(root);
    var files = review.changedFiles || [];
    if (!files.length) { root.appendChild(el('p', { className: 'empty', text: 'No changed files.' })); return; }
    var tbl = el('table', { className: 'mini-table' });
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var tr = el('tr');
      var st = el('td');
      st.appendChild(el('span', { className: 'abr-file-status abr-diff-status-' + f.status, text: f.status }));
      tr.appendChild(st);
      var pth = el('td');
      pth.appendChild(el('code', { text: f.path }));
      tr.appendChild(pth);
      var counts = el('td', { className: 'abr-file-counts' });
      if (typeof f.additions === 'number') counts.appendChild(el('span', { className: 'abr-adds', text: '+' + f.additions }));
      if (typeof f.deletions === 'number') counts.appendChild(el('span', { className: 'abr-dels', text: '-' + f.deletions }));
      tr.appendChild(counts);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }

  function renderAbrDiff(review) {
    var root = document.getElementById('abr-diff-body');
    if (!root) return;
    clear(root);
    var parsed = parseUnifiedDiff(review.diff);
    root.appendChild(buildDiffView(parsed));
  }

  function renderAbrCommands(review) {
    var root = document.getElementById('abr-commands-body');
    if (!root) return;
    clear(root);
    var cmds = review.commands || [];
    if (!cmds.length) { root.appendChild(el('p', { className: 'empty', text: 'No commands run.' })); return; }
    var tbl = el('table', { className: 'mini-table' });
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      var tr = el('tr');
      var td = el('td');
      td.appendChild(el('code', { text: '$ ' + (c.cmd || '') }));
      tr.appendChild(td);
      var code = el('td');
      var ok = c.exitCode === 0;
      code.appendChild(el('span', {
        className: 'chip chip-exit ' + (ok ? 'exit-ok' : 'exit-bad'),
        text: 'exit ' + (c.exitCode == null ? '?' : c.exitCode),
      }));
      tr.appendChild(code);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }

  function renderAbrEgress(review) {
    var root = document.getElementById('abr-egress-body');
    if (!root) return;
    clear(root);
    var egress = review.egress || [];
    if (!egress.length) { root.appendChild(el('p', { className: 'empty', text: 'No network destinations observed.' })); return; }
    var tbl = el('table', { className: 'mini-table' });
    for (var i = 0; i < egress.length; i++) {
      var tr = el('tr');
      var td = el('td');
      td.appendChild(el('code', { text: String(egress[i]) }));
      tr.appendChild(td);
      var dec = el('td');
      // Egress here is metadata-only observation on the soft (bypassable) plane —
      // label it as observed, never as a policy "allow".
      dec.appendChild(el('span', { className: 'chip chip-decision decision-observe', text: 'observed (metadata-only)' }));
      tr.appendChild(dec);
      tbl.appendChild(tr);
    }
    root.appendChild(tbl);
  }

  function renderAbrDecision(review) {
    var root = document.getElementById('abr-decision-body');
    if (!root) return;
    clear(root);

    // If a decision is already recorded, reflect it (read-only).
    if (review.decision) {
      root.appendChild(buildAbrDecisionResult(review.decision));
      return;
    }

    var controls = el('div', { className: 'abr-decision-controls' });
    var accept = el('button', { className: 'btn abr-btn abr-accept', text: 'Accept' });
    accept.setAttribute('type', 'button');
    var changes = el('button', { className: 'btn abr-btn abr-changes', text: 'Request changes' });
    changes.setAttribute('type', 'button');
    var reject = el('button', { className: 'btn abr-btn abr-reject', text: 'Reject' });
    reject.setAttribute('type', 'button');
    accept.addEventListener('click', function () { submitAbrDecision('accepted'); });
    changes.addEventListener('click', function () { submitAbrDecision('changes-requested'); });
    reject.addEventListener('click', function () { submitAbrDecision('rejected'); });
    controls.appendChild(accept);
    controls.appendChild(changes);
    controls.appendChild(reject);
    root.appendChild(controls);
  }

  function buildAbrDecisionResult(decision) {
    var labels = {
      'accepted': { cls: 'abr-decided-accepted', text: '✓ Accepted' },
      'rejected': { cls: 'abr-decided-rejected', text: '✕ Rejected' },
      'changes-requested': { cls: 'abr-decided-changes', text: '↺ Changes requested' },
    };
    var d = labels[decision] || { cls: 'abr-decided-changes', text: decision };
    var wrap = el('div', { className: 'abr-decision-result ' + d.cls });
    wrap.appendChild(el('strong', { text: d.text }));
    wrap.appendChild(el('span', {
      className: 'abr-decision-note',
      text: ' — recorded. Applying / reverting the work happens in Phase C.',
    }));
    return wrap;
  }

  /** Post the decision to the host and reflect it in the UI immediately. */
  function submitAbrDecision(decision) {
    if (!abrCurrentRunId) return;
    if (typeof window !== 'undefined' && typeof window.GLYPHSPEK_POST === 'function') {
      window.GLYPHSPEK_POST({ type: 'agenticBuildDecision', runId: abrCurrentRunId, decision: decision });
    }
    var root = document.getElementById('abr-decision-body');
    if (root) {
      clear(root);
      root.appendChild(buildAbrDecisionResult(decision));
    }
  }

  /** Show the Agentic Build Review view (hide the other panels' main regions). */
  function showAbrView() {
    var view = document.getElementById('agentic-review-view');
    if (view) view.hidden = false;
    var live = document.getElementById('live-view');
    if (live) live.hidden = true;
  }

  /**
   * Render a full AgenticBuildReview. The single entry point the host message
   * handler (and the preview command) calls.
   */
  function renderAgenticBuildReview(review, opts) {
    if (!review || typeof review !== 'object') return;
    abrCurrentRunId = typeof review.runId === 'string' ? review.runId : null;
    var tag = document.getElementById('abr-preview-tag');
    if (tag) tag.hidden = !(opts && opts.preview);
    renderAbrHeader(review);
    renderAbrSummary(review);
    renderAbrFiles(review);
    renderAbrDiff(review);
    renderAbrCommands(review);
    renderAbrEgress(review);
    renderAbrDecision(review);
    showAbrView();
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

  /* --------------------------- reduced motion (§14.3) --------------------------- */
  /**
   * Apply the webview's "reduce motion" Settings toggle by adding/removing the
   * `glyphspek-reduce-motion` class on <html> (styles.css shares the OS-pref rule
   * list with that class). This is the webview-readable analog of the fork's
   * `glyphspek.workbench.haloMotion` setting: it gives the Trust Panel the SECOND
   * disable path §14.3 requires (the @media query covers the OS preference; this
   * covers a user/host Settings toggle). View-only — it changes nothing about trust,
   * only whether the deny-pulse + trust cross-fades animate. `on === undefined`
   * (no setting posted yet) leaves the class untouched so the OS pref still governs.
   */
  function applyReduceMotion(on) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    if (on === undefined || on === null) return;
    document.documentElement.classList.toggle('glyphspek-reduce-motion', on === true);
  }

  /* --------------------------- wiring --------------------------- */
  function wireLive() {
    // Reduced-motion Settings toggle (§14.3): seed from a host-injected global if the
    // host set one BEFORE this script ran (mirrors GLYPHSPEK_RUN_TRUSTS / trusted-key
    // injection), then keep it live via the `reduceMotion` host message below.
    if (typeof window !== 'undefined' && typeof window.GLYPHSPEK_REDUCE_MOTION !== 'undefined') {
      applyReduceMotion(window.GLYPHSPEK_REDUCE_MOTION === true);
    }
    // Host → webview run-event stream. The real supervisor stream and the mock
    // driver both arrive here, so the real stream slots in with NO renderer change.
    window.addEventListener('message', function (event) {
      var msg = event && event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'runEvent' && msg.event) {
        ingestRunEvent(msg.event);
      } else if (msg.type === 'runEvents' && Array.isArray(msg.events)) {
        for (var i = 0; i < msg.events.length; i++) ingestRunEvent(msg.events[i]);
      } else if (msg.type === 'reduceMotion') {
        // §14.3 Settings-toggle path: the host posts the user's GlyphSpek "reduce
        // motion" setting (the webview-side analog of the fork's haloMotion key).
        applyReduceMotion(msg.value === true);
      } else if (msg.type === 'selectRun' && typeof msg.runId === 'string') {
        // FOCUS a run from the activity-bar Governed Runs tree (view-only nav: it
        // confers no trust and starts nothing). Select the run if we know it and
        // re-render; if it has not streamed yet, remember it so the next event for
        // that run auto-selects it (ingestRunEvent already selects the first run).
        selectRunFromHost(msg.runId);
      } else if (msg.type === 'agenticBuildReview' && msg.review) {
        // AGENTIC BUILD REVIEW (Phase B). The host posts a pinned AgenticBuildReview
        // evidence object (real backend or the preview fixture). View-only: render
        // the compact evidence + the accept/reject/request-changes controls.
        renderAgenticBuildReview(msg.review, { preview: !!msg.preview });
      } else if (msg.type === 'setTier' && typeof msg.tier === 'string') {
        // FRICTION-TIER SYNC (PATCH-009). The host pushes the effective tier after a
        // NATIVE title-bar Authority Ladder rung click so the webview ladder reflects
        // it. Applied WITHOUT echoing `glyphspekTier` back (applyHostTier suppresses the
        // post) — the host already set the context-key. VIEW-ONLY: confers no authority,
        // never touches data-authority (the assurance axis / halo).
        applyHostTier(msg.tier);
      }
    });

    var demoBtn = document.getElementById('demo-live-btn');
    if (demoBtn) {
      demoBtn.addEventListener('click', function () { driveMockRun('isolated-native'); });
    }

    // PROMOTE TO GOVERNED RUN (§5.8, §6). The button posts `glyphspekPromote` to the
    // host, which runs glyphspek.promoteChatToBuild — the first-party agentic-build
    // gesture. The button does NOT grant authority: the command's own modal is the
    // authority gate (a third party cannot post into this webview, and even our own
    // click only OPENS the gated command). View-only here.
    var promoteBtn = document.getElementById('promote-btn');
    if (promoteBtn) {
      promoteBtn.addEventListener('click', function () {
        if (typeof window !== 'undefined' && typeof window.GLYPHSPEK_POST === 'function') {
          window.GLYPHSPEK_POST({ type: 'glyphspekPromote' });
        }
      });
    }

    // SLICE 2 — AUTHORITY LADDER wiring (§1.3, §14.4). Click selects a rung (a VIEW
    // control, not an authority grant); keyboard follows the ARIA radiogroup
    // pattern: ←/↑ previous, →/↓ next (wrapping), Home/End first/last, Space/Enter
    // select the focused rung. Selecting a rung calls setViewTier — it changes which
    // evidence is shown, never the run's assurance.
    var ladder = document.getElementById('authority-ladder');
    if (ladder) {
      ladder.addEventListener('click', function (e) {
        var rung = e.target && e.target.closest ? e.target.closest('.rung') : null;
        if (rung && rung.getAttribute) {
          var t = rung.getAttribute('data-tier');
          if (t) setViewTier(t);
        }
      });
      ladder.addEventListener('keydown', function (e) {
        var key = e.key;
        var idx = LADDER_TIERS.indexOf(currentLadderTier());
        if (idx === -1) idx = LADDER_TIERS.indexOf('governed');
        var next = null;
        if (key === 'ArrowRight' || key === 'ArrowDown') next = (idx + 1) % LADDER_TIERS.length;
        else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (idx - 1 + LADDER_TIERS.length) % LADDER_TIERS.length;
        else if (key === 'Home') next = 0;
        else if (key === 'End') next = LADDER_TIERS.length - 1;
        else if (key === ' ' || key === 'Enter' || key === 'Spacebar') next = idx;
        if (next !== null) {
          e.preventDefault();
          setViewTier(LADDER_TIERS[next]);
        }
      });
    }

    // ASK-TIER SURFACE actions (§1.7, §5.5.1). "Propose edit ▸" promotes the VIEW to
    // the inline tier (still pre-run — a proposed diff, no execution). "Start a
    // governed run ▸" is the EXPLICIT promotion entry point: it posts glyphspekPromote
    // → glyphspek.promoteChatToBuild, whose OWN modal is the authority gate. Neither
    // grants authority here.
    var askProposeBtn = document.getElementById('ask-propose-btn');
    if (askProposeBtn) {
      askProposeBtn.addEventListener('click', function () { setViewTier('inline'); });
    }
    var askRunBtn = document.getElementById('ask-run-btn');
    if (askRunBtn) {
      askRunBtn.addEventListener('click', function () {
        if (typeof window !== 'undefined' && typeof window.GLYPHSPEK_POST === 'function') {
          window.GLYPHSPEK_POST({ type: 'glyphspekPromote' });
        }
      });
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
      // The canonical RunTrust set the run_opened gate validates against (the
      // injected window.GLYPHSPEK_RUN_TRUSTS, or the fail-safe mirror). Exposed so
      // the ingestion test (test/liveRunTrustIngestion.test.mjs) iterates EXACTLY
      // what the webview accepts, so a future new posture that is injected but not
      // handled is caught.
      runTrusts: RUN_TRUSTS.slice(),
      // Read-only trust summary over a run view (view-only, NOT a security surface).
      // Exposed so the golden-fixture conformance test (test/liveReducerGolden.test.mjs)
      // compares the WEBVIEW's OWN failure-severity ordering + eligibility against the
      // TS reducer (src/liveRunModel.ts), so a drift in either is caught (Finding 7).
      deriveTrustSummary: function (runId) {
        var v = runs[runId];
        return v ? deriveTrustSummary(v) : null;
      },
      // Exposed for the webview render tests (sweep-24 #1, #3): the SHARED exhaustive
      // creation-trust badge map + resolver, and the trace-event summarizer (so the
      // broad-web lower-assurance model_call label and the sandboxed-soft-egress badge
      // are asserted on the REAL panel code, not a re-implementation).
      CREATION_TRUST_BADGE: CREATION_TRUST_BADGE,
      creationTrustBadge: creationTrustBadge,
      summarizeLive: summarizeLive,
      // SLICE 1 — friction surface derivation (BLENDED-WORKBENCH-SPEC §5.8/§6/§7).
      // Exposed PURE so test/frictionSurface.test.mjs asserts the data-tier /
      // data-authority derivation + the SOFT cap on the REAL panel code (the same
      // honesty gates renderVerdict uses), not a re-implementation.
      deriveAuthority: deriveAuthority,
      deriveTier: deriveTier,
      isSoftPosture: isSoftPosture,
      FRICTION_COPY: FRICTION_COPY,
      AUTHORITY_CHIP: AUTHORITY_CHIP,
      SENSITIVE_BOUNDARY: SENSITIVE_BOUNDARY,
      // SLICE 2 — Authority Ladder (view axis) + Ask surface. Exposed PURE so
      // test/authorityLadder.test.mjs asserts the ladder sets data-tier + the ARIA
      // radiogroup state on the REAL panel code, the Ask surface hides the verdict +
      // shows the two promotion actions, and the ladder never touches data-authority.
      setViewTier: setViewTier,
      syncLadder: syncLadder,
      currentLadderTier: currentLadderTier,
      setFrictionSurface: setFrictionSurface,
      LADDER_TIERS: LADDER_TIERS,
      // FRICTION-TIER PUBLISH (Phase 1 §A) — exposed so the tier-publish test can
      // assert the de-duplicated `glyphspekTier` post on the REAL panel code. The
      // host mirrors it to the `glyphspek.tier` context-key the fork chrome reads.
      postTier: postTier,
      // FRICTION-TIER SYNC (PATCH-009) — exposed so a test can assert that a host-
      // pushed tier (native title-bar ladder click) syncs the webview ladder WITHOUT
      // echoing `glyphspekTier` back (the loop-breaker), on the REAL panel code.
      applyHostTier: applyHostTier,
      // AGENTIC BUILD REVIEW (Phase B) — exposed for the renderer/parser tests
      // (test/agenticBuildReview.test.mjs) so the diff parser, the honest verdict
      // badge, and the full render are asserted on the REAL panel code.
      parseUnifiedDiff: parseUnifiedDiff,
      buildDiffView: buildDiffView,
      abrVerdictBadge: abrVerdictBadge,
      renderAgenticBuildReview: renderAgenticBuildReview,
      // REDUCED-MOTION toggle (§14.3) — exposed so a test can assert the webview's
      // Settings-toggle path adds/removes the `glyphspek-reduce-motion` class.
      applyReduceMotion: applyReduceMotion,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireLive);
  } else {
    wireLive();
  }
})();
