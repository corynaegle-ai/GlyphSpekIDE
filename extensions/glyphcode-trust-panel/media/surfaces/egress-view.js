/*
 * GlyphCode EGRESS / NETWORK rail surface — webview renderer (Spec §5.9 "Egress").
 *
 * Pure presentation. Receives a fully-derived, already-validated view model from
 * egressViewProvider.ts via a { type:'render', model } message and draws it with
 * native DOM (no framework, no innerHTML of dynamic data — every dynamic value goes
 * through textContent). It performs NO validation and INVENTS no data: the provider
 * has already run validateRunEvent on each envelope and folded only network events.
 *
 * HONESTY (§2.2): blocked = RED; observed/allowed = NEUTRAL. The local governed
 * terminal is observe-and-trace (metadata-only) — NOT a hard allowlist — so an
 * allowed/observed destination is rendered as OBSERVED, never as a green "secured"
 * claim, and the posture banner says so. When the run asserts loopbackProxyBypass,
 * the loopback caution is shown so "every destination is recorded" is never implied.
 */

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var els = {
    runRef: document.getElementById('runRef'),
    posture: document.getElementById('posture'),
    loopback: document.getElementById('loopback'),
    blocked: document.getElementById('blocked'),
    allowed: document.getElementById('allowed'),
    blockedCount: document.getElementById('blockedCount'),
    allowedCount: document.getElementById('allowedCount'),
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

  /* The honest posture banner. The local soft governed terminal is observe-and-trace
     (metadata-only); a hard default-deny network jail is the ISOLATED remote plane,
     not enforced here. The banner says exactly that — no overclaim. */
  function renderPosture(model) {
    var root = els.posture;
    clear(root);
    var box = el('div', 'posture');

    box.appendChild(el('span', 'ban-label', 'observe-and-trace · not a hard jail'));
    box.appendChild(el('div', 'ban-title', 'Default posture: observe + record egress (soft, local)'));

    box.appendChild(
      el(
        'p',
        null,
        'The local governed terminal OBSERVES and RECORDS network egress as metadata; ' +
          'it does not enforce a hard allowlist. Destinations let through are shown as ' +
          'OBSERVED (neutral), not as a "secured" guarantee.',
      ),
    );
    box.appendChild(
      el(
        'p',
        null,
        'A hard default-deny network jail (where blocked egress cannot escape) is the ' +
          'ISOLATED remote plane — NOT what is enforced on this local run.',
      ),
    );

    var note = el('div', 'ban-note');
    if (model && model.hasRun) {
      note.textContent =
        'Load-bearing exfil defense: what was OBSERVED/allowed this run + any BLOCKED ' +
        'attempts are listed below. This run’s creation trust: ' +
        (model.creationTrust || 'unknown') +
        '; runtime: ' +
        (model.runtimeProfile || 'unknown') +
        ' (' +
        (model.runtimeTrust || 'unknown') +
        ').';
    } else {
      note.textContent =
        'No focused run yet. When a governed run streams network events they appear here; ' +
        'no destinations are fabricated.';
    }
    box.appendChild(note);
    root.appendChild(box);
  }

  /* F2: the loopback-bypass caution — only when the run asserts it. */
  function renderLoopback(model) {
    var root = els.loopback;
    clear(root);
    if (!model || !model.loopbackProxyBypass) return;
    var box = el('div', 'loopback');
    box.appendChild(el('span', 'lb-h', 'loopback UNOBSERVED'));
    box.appendChild(
      el(
        'div',
        null,
        'This run exempts loopback (localhost / 127.0.0.1 / ::1) from the egress proxy, ' +
          'so loopback traffic BYPASSES observation and is NOT in the trace. The lists ' +
          'below cover non-loopback egress only.',
      ),
    );
    if (model.loopbackProxyBypassReason) {
      box.appendChild(el('div', 'lb-reason', 'Reason: ' + model.loopbackProxyBypassReason));
    }
    root.appendChild(box);
  }

  /* One destination row. State drives the left-border color + the chip glyph/label.
     blocked = RED ✕; observed = violet ◌ (soft, not enforced); allowed = neutral ○;
     asked = amber ◇ (escalated to a human). */
  function destRow(n) {
    var state = n.blocked ? 'blocked' : n.observeOnly ? 'observed' : n.decision === 'ask' ? 'asked' : 'allowed';
    var row = el('div', 'dest ' + (state === 'asked' ? 'observed' : state));

    var top = el('div', 'd-top');
    top.appendChild(el('span', 'd-dest', n.destination || '(unknown)'));

    var chipText;
    if (state === 'blocked') chipText = 'blocked — not sent';
    else if (state === 'observed') chipText = 'observed (soft, default-allow)';
    else if (state === 'asked') chipText = 'escalated to human';
    else chipText = 'allowed (observed)';
    top.appendChild(el('span', 'chip ' + state, chipText));
    row.appendChild(top);

    var metaParts = [];
    if (n.requestedCapability && n.requestedCapability !== n.destination) {
      metaParts.push(n.requestedCapability);
    }
    if (n.rule) metaParts.push('rule: ' + n.rule);
    if (n.provenanceLabel) metaParts.push('prov: ' + n.provenanceLabel);
    if (metaParts.length) row.appendChild(el('div', 'd-meta', metaParts.join('   ·   ')));

    return row;
  }

  function renderList(root, countEl, rows) {
    clear(root);
    countEl.textContent = String(rows.length);
    if (!rows.length) {
      root.appendChild(el('p', 'empty', 'None recorded for this run.'));
      return;
    }
    for (var i = 0; i < rows.length; i++) root.appendChild(destRow(rows[i]));
  }

  function renderFoot(model) {
    var n = model && model.observedTotal != null ? model.observedTotal : 0;
    var b = model && model.blockedTotal != null ? model.blockedTotal : 0;
    els.foot.textContent =
      'Evidence-only. ' +
      b +
      ' blocked attempt(s), ' +
      n +
      ' observed/allowed destination(s) this run. Foreign or malformed envelopes are ' +
      'dropped — nothing here is fabricated. Local egress is observed metadata, not a ' +
      'hard network jail.';
  }

  function render(model) {
    els.runRef.textContent = model && model.shortRunId ? model.shortRunId : '';
    renderPosture(model);
    renderLoopback(model);
    renderList(els.blocked, els.blockedCount, (model && model.blocked) || []);
    renderList(els.allowed, els.allowedCount, (model && model.allowed) || []);
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
