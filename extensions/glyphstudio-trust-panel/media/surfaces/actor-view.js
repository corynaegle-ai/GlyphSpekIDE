/*
 * GlyphStudio ACTOR rail surface — webview renderer (Spec §5.3 "pinned actor" / §5.9).
 *
 * Pure presentation. Receives a fully-derived, already-validated view model from
 * actorViewProvider.ts via a { type:'render', model } message and draws it with native
 * DOM (no framework, no innerHTML of dynamic data — every dynamic value goes through
 * textContent). It performs NO validation and INVENTS no data: the provider has already
 * run validateRunEvent on each envelope and folded only run_opened actor facts.
 *
 * HONESTY (§2.2): the bound-actor chip is NEUTRAL/violet, never green. Fidelity is shown
 * honestly — boundary-only is badged as coarser, sandbox-boundary evidence and never
 * upgraded to per-tool brokering. The unifying line "the actor never gets raw tool access
 * — every action is brokered" is always rendered. The rebind affordance is a read-only
 * LABEL: no command is posted to the host (a true rebind command does not exist yet).
 */

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var els = {
    runRef: document.getElementById('runRef'),
    actorCard: document.getElementById('actorCard'),
    brokered: document.getElementById('brokered'),
    cautions: document.getElementById('cautions'),
    capabilities: document.getElementById('capabilities'),
    rebind: document.getElementById('rebind'),
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

  function metaRow(key, value) {
    var row = el('div');
    row.appendChild(el('span', 'k', key));
    row.appendChild(el('span', 'v', value));
    return row;
  }

  /* The fidelity badge class + short label, honest per the model's cliFidelity. */
  function fidelityBadge(fidelity) {
    if (fidelity === 'per-tool-brokered') return { cls: 'pertool', label: 'per-tool brokered' };
    if (fidelity === 'boundary-only') return { cls: 'boundary', label: 'boundary-only' };
    if (fidelity === 'n/a') return { cls: 'na', label: 'n/a (native)' };
    return { cls: 'unknown', label: 'fidelity unknown' };
  }

  /* The pinned bound-actor chip: WHICH actor is bound + its honest fidelity + posture. */
  function renderActorCard(model) {
    var root = els.actorCard;
    clear(root);

    if (!model || !model.hasRun) {
      var empty = el('div', 'actor');
      empty.appendChild(el('div', 'a-name', 'No bound actor yet'));
      empty.appendChild(
        el(
          'div',
          'fid-note',
          'No focused run. When a governed run opens, the actor bound to it (Claude Code / ' +
            'Codex / native / local) appears here with its evidence fidelity and granted ' +
            'capabilities. No actor is fabricated.',
        ),
      );
      root.appendChild(empty);
      return;
    }

    var card = el('div', 'actor');

    var top = el('div', 'a-top');
    var names = el('div');
    names.appendChild(el('div', 'a-name', model.actorName || 'Unknown actor'));
    if (model.actorType && model.actorType !== model.actorName) {
      names.appendChild(el('div', 'a-type', model.actorType));
    }
    top.appendChild(names);

    var fb = fidelityBadge(model.cliFidelity);
    top.appendChild(el('span', 'fid ' + fb.cls, fb.label));
    card.appendChild(top);

    var meta = el('div', 'a-meta');
    if (model.actorVersion) meta.appendChild(metaRow('Version', model.actorVersion));
    meta.appendChild(metaRow('Creation trust', model.creationTrust || 'unknown'));
    meta.appendChild(
      metaRow('Runtime', (model.runtimeProfile || 'unknown') + ' (' + (model.runtimeTrust || 'unknown') + ')'),
    );
    if (model.extensionPosture) meta.appendChild(metaRow('Extension', model.extensionPosture));
    if (model.state) meta.appendChild(metaRow('State', model.state));
    if (model.binaryPath) meta.appendChild(metaRow('Binary', model.binaryPath));
    if (model.binarySha256) meta.appendChild(metaRow('sha256', model.binarySha256));
    if (model.binaryVersion && model.binaryVersion !== model.actorVersion) {
      meta.appendChild(metaRow('Reported', model.binaryVersion));
    }
    card.appendChild(meta);

    if (model.fidelityNote) card.appendChild(el('div', 'fid-note', model.fidelityNote));

    root.appendChild(card);
  }

  /* The unifying honesty line — always present, even with no run. */
  function renderBrokered() {
    var root = els.brokered;
    clear(root);
    var box = el('div', 'brokered');
    box.appendChild(el('span', 'b-h', 'the actor is never trusted with raw tools'));
    var p = el('p');
    p.style.margin = '0';
    p.appendChild(document.createTextNode('The actor '));
    var strong = el('strong', null, 'never gets raw tool access');
    p.appendChild(strong);
    p.appendChild(
      document.createTextNode(
        ' — every action it takes (file, command, network, model) is brokered through the ' +
          'governed plane and recorded. Binding an actor confers NO trust; it only names who ' +
          'is driving the run.',
      ),
    );
    box.appendChild(p);
    root.appendChild(box);
  }

  /* Posture cautions, shown only when the focused run asserts them. */
  function renderCautions(model) {
    var root = els.cautions;
    clear(root);
    if (!model || !model.hasRun) return;

    if (model.governedUnsandboxed) {
      var gu = el('div', 'caution');
      gu.appendChild(el('span', 'c-h', 'governed-unsandboxed'));
      gu.appendChild(
        el(
          'div',
          null,
          'This run is governed + traced but NOT sandboxed (the M7 governed-terminal posture). ' +
            'It can never be product-trusted; the actor still has no raw tool access, but ' +
            'isolation is not enforced — a hard sandbox is the isolated remote plane.',
        ),
      );
      root.appendChild(gu);
    }

    if (model.nonIsolatedRuntime) {
      var ni = el('div', 'caution');
      ni.appendChild(el('span', 'c-h', 'runtime not an isolation runtime'));
      ni.appendChild(
        el(
          'div',
          null,
          'The runtime "' +
            (model.runtimeProfile || 'unknown') +
            '" is NOT an approved isolation runtime, so this run can never reach a ' +
            'product-authoritative trusted state regardless of any later verifier verdict.',
        ),
      );
      root.appendChild(ni);
    }
  }

  function capRow(c) {
    var row = el('div', 'cap');
    row.appendChild(el('div', 'cap-label', c.label || ''));
    if (c.detail) row.appendChild(el('div', 'cap-detail', c.detail));
    return row;
  }

  function renderCapabilities(model) {
    var root = els.capabilities;
    clear(root);
    var caps = (model && model.capabilities) || [];
    if (!caps.length) {
      root.appendChild(
        el(
          'p',
          'empty',
          model && model.hasRun
            ? 'No brokered capability classes reported for this run.'
            : 'Capabilities appear once a governed run is bound to an actor.',
        ),
      );
      return;
    }
    for (var i = 0; i < caps.length; i++) root.appendChild(capRow(caps[i]));
  }

  /* Rebind — a read-only LABEL this increment (no command is fired). */
  function renderRebind(model) {
    var root = els.rebind;
    clear(root);
    var box = el('div', 'rebind');
    box.appendChild(el('span', 'r-h', 'rebind (read-only)'));
    box.appendChild(
      el(
        'div',
        null,
        'An actor is bound to a run when the run is created; a run keeps its bound actor for ' +
          'its lifetime. To bind a different actor (Claude Code / Codex / native / local), ' +
          'start a NEW governed run with that actor selected.',
      ),
    );
    box.appendChild(
      el(
        'div',
        'r-note',
        'This is a label, not a button — rebinding the focused run in place is not wired in ' +
          'this increment, so nothing here changes the running actor or its authority.',
      ),
    );
    root.appendChild(box);
  }

  function renderFoot(model) {
    if (model && model.hasRun) {
      els.foot.textContent =
        'Evidence-only. Bound actor + fidelity are read from the run_opened envelope for run ' +
        (model.shortRunId || '') +
        '. Foreign or malformed envelopes are dropped — nothing here is fabricated, and no ' +
        'capability the stream did not establish is implied.';
    } else {
      els.foot.textContent =
        'Evidence-only. No focused run yet; the bound actor renders here when a governed run ' +
        'opens. Nothing is fabricated.';
    }
  }

  function render(model) {
    els.runRef.textContent = model && model.shortRunId ? model.shortRunId : '';
    renderActorCard(model);
    renderBrokered();
    renderCautions(model);
    renderCapabilities(model);
    renderRebind(model);
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
