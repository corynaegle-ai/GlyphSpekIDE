/*
 * GlyphSpek MODEL CALLS / ACTORS rail surface — webview renderer (Spec §5.9).
 *
 * Pure presentation. Receives a fully-derived, already-validated view model from
 * modelCallsViewProvider.ts via a { type:'render', model } message and draws it with
 * native DOM (no framework, no innerHTML of dynamic data — every dynamic value goes
 * through textContent). It performs NO validation and INVENTS no data: the provider
 * has already run validateRunEvent on each envelope and folded only the model-call /
 * actor / remote-approval slices.
 *
 * HONESTY (§2.2): fidelity is the load-bearing signal and is rendered exactly as the
 * stream supplies it. A boundary-only run is BOUNDARY-OBSERVED (coarse evidence), never
 * per-tool brokering; native is n/a. There is NO verifier-blue here. A nonce-bound
 * remote approval is a RECORDED MARKER (amber/red), not an asserted trust grant — the
 * cryptographic gate lives host-side; we only show THAT it was recorded.
 */

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var els = {
    runRef: document.getElementById('runRef'),
    actors: document.getElementById('actors'),
    remoteApproval: document.getElementById('remoteApproval'),
    endpoints: document.getElementById('endpoints'),
    endpointCount: document.getElementById('endpointCount'),
    foot: document.getElementById('foot'),
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* Map the honest fidelity label to a chip class. brokered = ✓ pass-tinted;
     boundary-observed = ◌ violet (coarse); native = ○ neutral. */
  function fidelityClass(label) {
    if (label === 'per-tool-brokered') return 'f-brokered';
    if (label === 'boundary-observed') return 'f-boundary';
    return 'f-native';
  }

  /* One actor card: the bound actor + honest fidelity. */
  function actorCard(a) {
    var fc = fidelityClass(a.fidelityLabel);
    var card = el('div', 'actor ' + fc);

    var top = el('div', 'a-top');
    top.appendChild(el('span', 'a-name', a.actorLabel || a.actorType || 'unknown actor'));
    top.appendChild(el('span', 'chip ' + fc, a.fidelityLabel || 'unknown'));
    card.appendChild(top);

    if (a.actorVersion) card.appendChild(el('div', 'a-ver', 'version: ' + a.actorVersion));

    card.appendChild(el('div', 'a-note', a.fidelityNote || ''));

    // Prompt-fidelity sub-chip: prompt-visible (a prompt envelope was recorded) vs
    // metadata-only (only model_call usage metadata). Honest either way.
    var sub = el(
      'span',
      'subchip' + (a.promptVisible ? ' prompt' : ''),
      a.promptVisible ? 'prompt-visible trace' : 'metadata-only trace',
    );
    card.appendChild(sub);

    // Best-effort binary identity evidence (sweep-28) — provenance, not trust.
    if (a.actorBinary && (a.actorBinary.path || a.actorBinary.sha256 || a.actorBinary.version)) {
      var b = a.actorBinary;
      var parts = [];
      if (b.path) parts.push(b.path);
      if (b.version) parts.push('v: ' + b.version);
      if (b.sha256) parts.push('sha256: ' + String(b.sha256).slice(0, 16) + '…');
      card.appendChild(el('div', 'a-bin', 'binary: ' + parts.join('   ·   ')));
    }

    return card;
  }

  function renderActors(model) {
    var root = els.actors;
    clear(root);
    var actors = (model && model.actors) || [];
    if (!actors.length) {
      root.appendChild(
        el(
          'p',
          'empty',
          model && model.hasRun
            ? 'No actor facts recorded yet for this run (awaiting run_opened).'
            : 'No focused run yet. The bound actor + its fidelity appear here when a governed run opens.',
        ),
      );
      return;
    }
    for (var i = 0; i < actors.length; i++) root.appendChild(actorCard(actors[i]));
  }

  /* Nonce-bound remote (iOS) approval marker — only when recorded. A RECORDED marker,
     not an asserted trust grant. */
  function renderRemoteApproval(model) {
    var root = els.remoteApproval;
    clear(root);
    var ra = model && model.remoteApproval;
    if (!ra) return;
    var denied = ra.decision === 'denied';
    var box = el('div', 'remote' + (denied ? ' denied' : ''));
    box.appendChild(el('span', 'r-h', denied ? 'remote approval DENIED' : 'remote approval GRANTED'));
    box.appendChild(
      el(
        'p',
        'r-line',
        'A nonce-bound remote (iOS) decision was RECORDED in this run’s trace. This shows ' +
          'THAT it was recorded; the signature / replay gate is enforced host-side, not here.',
      ),
    );
    var meta = [];
    if (ra.approvalId) meta.push('approval: ' + ra.approvalId);
    if (ra.nonce) meta.push('nonce: ' + ra.nonce);
    if (ra.seq != null) meta.push('seq #' + ra.seq);
    if (meta.length) box.appendChild(el('div', 'r-meta', meta.join('   ·   ')));
    root.appendChild(box);
  }

  /* One observed model endpoint row. */
  function endpointRow(e) {
    var row = el('div', 'endpoint');
    var top = el('div', 'e-top');
    top.appendChild(el('span', 'e-model', e.model || '(unnamed model)'));
    top.appendChild(el('span', 'e-calls', (e.calls || 0) + (e.calls === 1 ? ' call' : ' calls')));
    row.appendChild(top);

    var metaParts = [];
    var inTok = e.inputTokens || 0;
    var outTok = e.outputTokens || 0;
    if (inTok || outTok) metaParts.push(inTok + ' in / ' + outTok + ' out tokens');
    if (e.provenanceLabels && e.provenanceLabels.length) {
      metaParts.push('prov: ' + e.provenanceLabels.join(', '));
    }
    if (metaParts.length) row.appendChild(el('div', 'e-meta', metaParts.join('   ·   ')));
    return row;
  }

  function renderEndpoints(model) {
    var root = els.endpoints;
    clear(root);
    var endpoints = (model && model.endpoints) || [];
    els.endpointCount.textContent = String(endpoints.length);
    if (!endpoints.length) {
      root.appendChild(
        el(
          'p',
          'empty',
          model && model.boundaryOnly
            ? 'No model_call events observed. On a boundary-only run, model calls may not be individually brokered — nothing is fabricated.'
            : 'No model calls observed for this run yet.',
        ),
      );
      return;
    }
    for (var i = 0; i < endpoints.length; i++) root.appendChild(endpointRow(endpoints[i]));
  }

  function renderFoot(model) {
    if (!model || !model.hasRun) {
      els.foot.textContent =
        'Evidence-only. Foreign / future-rev / malformed envelopes are dropped — nothing here ' +
        'is fabricated. The bound actor + its honest fidelity, the observed model endpoints, ' +
        'and any nonce-bound remote approval render here when a governed run streams.';
      return;
    }
    var txt =
      'Evidence-only. ' +
      (model.endpointTotal || 0) +
      ' distinct model endpoint(s), ' +
      (model.totalCalls || 0) +
      ' model call(s) observed this run. Creation trust: ' +
      (model.trust || 'unknown') +
      '; runtime: ' +
      (model.runtimeProfile || 'unknown') +
      ' (' +
      (model.runtimeTrust || 'unknown') +
      '). ';
    if (model.boundaryOnly) {
      txt +=
        'BOUNDARY-OBSERVED actor: model evidence is coarse (THAT a model ran, not each ' +
        'individually-brokered call); not per-tool brokering. ';
    }
    if (model.loopbackProxyBypass) {
      txt += 'Loopback egress is exempt from the proxy and UNOBSERVED on this run. ';
    }
    txt += 'No verifier verdict is shown on this surface.';
    els.foot.textContent = txt;
  }

  function render(model) {
    els.runRef.textContent = model && model.shortRunId ? model.shortRunId : '';
    renderActors(model);
    renderRemoteApproval(model);
    renderEndpoints(model);
    renderFoot(model);
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'render') render(msg.model || {});
  });

  // Tell the host we are live; it replies with the current model.
  vscode.postMessage({ type: 'ready' });
})();
