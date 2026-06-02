/*
 * GlyphSpek WORKSPACE rail surface — webview renderer (Spec §5.9 "Workspace").
 *
 * Pure presentation. Receives a fully-derived, already-validated view model from
 * workspaceViewProvider.ts via a { type:'render', model } message and draws it with
 * native DOM (no framework, no innerHTML of dynamic data — every dynamic value goes
 * through textContent). It performs NO validation and INVENTS no data: the provider
 * has already run validateRunEvent on each envelope, folded only brokered changed-file
 * events, and decided each file's honest dot state.
 *
 * HONESTY (§2.2 / §3.4):
 *  - A provenance dot is FILE-LEVEL — one dot per changed file, never per-line; the
 *    write event carries only a path, so synthesizing per-line authorship would be a
 *    fabrication. The dot's SHAPE/FILL (not only hue) encodes the state so SOFT-violet
 *    (hollow ring) ≠ VERIFIED-blue (solid fill) under deuteranopia / grayscale.
 *  - SOFT runs are CAPPED at violet; VERIFIED-blue is only ever set by the host behind
 *    the webview's Ed25519 signature gate. The renderer NEVER promotes a dot itself.
 *  - The scope frame is the honest "writes scoped to the run worktree" posture, not a
 *    green "secured" claim — a soft worktree is governed + traced, not a hard sandbox.
 */

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var els = {
    runRef: document.getElementById('runRef'),
    scope: document.getElementById('scope'),
    files: document.getElementById('files'),
    fileCount: document.getElementById('fileCount'),
    legend: document.getElementById('legend'),
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

  /* The honest scope frame. The run's writes are scoped to its worktree; a SOFT
     (governed-unsandboxed) worktree is governed + traced, NOT a hard sandbox, so the
     frame is a CAUTION (amber), not a green "secured" guarantee. An isolated run reads
     as a stronger (blue) frame. No allowlist is synthesized — there is none on the
     wire; "scoped to the worktree" is a posture statement about where writes land. */
  function renderScope(model) {
    var root = els.scope;
    clear(root);
    var isolated = !!(model && model.hasRun && !model.soft && model.runtimeTrust === 'trusted');
    var box = el('div', 'scope' + (isolated ? ' isolated' : ''));

    box.appendChild(
      el('span', 'sc-label', isolated ? 'isolated worktree' : 'soft worktree · governed + traced'),
    );
    box.appendChild(el('div', 'sc-title', 'Writes scoped to the run worktree'));

    box.appendChild(
      el(
        'p',
        null,
        'The files below are the brokered writes this run made inside its own ' +
          'worktree — the run does not edit your tree until you promote it. Each ' +
          'carries a FILE-LEVEL provenance dot; no per-line authorship is invented.',
      ),
    );
    if (!isolated) {
      box.appendChild(
        el(
          'p',
          null,
          'This is a SOFT (governed-unsandboxed) worktree: governed and traced, but ' +
            'NOT a hard sandbox. Its changes are CAPPED at soft (violet) provenance — ' +
            'never promoted to verified-blue.',
        ),
      );
    }

    var note = el('div', 'sc-note');
    if (model && model.hasRun) {
      note.textContent =
        'Runtime: ' +
        (model.runtimeLabel || 'worktree') +
        ' (' +
        (model.runtimeProfile || 'unknown') +
        ' · ' +
        (model.runtimeTrust || 'unknown') +
        '). Creation trust: ' +
        (model.creationTrust || 'unknown') +
        '.';
    } else {
      note.textContent =
        'No focused run yet. When a governed run brokers a file write it appears here; ' +
        'no file or provenance is fabricated.';
    }
    box.appendChild(note);
    root.appendChild(box);
  }

  /* One changed-file row: the FILE-LEVEL provenance dot + change letter + path. */
  function fileRow(f) {
    var row = el('div', 'file-row');

    var dotState = f && f.dot ? f.dot : 'human';
    var dot = el('span', 'prov ' + dotState);
    // A non-visual label so the dot's meaning survives a screen reader too.
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', dotState + ' provenance');
    dot.setAttribute('title', dotLabel(dotState));
    row.appendChild(dot);

    var ch = f && f.change ? f.change : '?';
    row.appendChild(el('span', 'change ' + ch, ch));
    row.appendChild(el('span', 'path', (f && f.path) || '(unknown)'));
    return row;
  }

  function dotLabel(state) {
    if (state === 'verified') return 'verified — signature-verified (solid)';
    if (state === 'soft') return 'soft — governed-unsandboxed, capped (hollow ring)';
    if (state === 'claimed') return 'claimed — agent wrote it, unverified (dashed ring)';
    return 'human / neutral';
  }

  function renderFiles(model) {
    var files = (model && model.files) || [];
    clear(els.files);
    els.fileCount.textContent = String(files.length);
    if (!files.length) {
      els.files.appendChild(
        el(
          'p',
          'empty',
          model && model.hasRun
            ? 'No brokered file writes recorded for this run yet.'
            : 'No focused run.',
        ),
      );
      return;
    }
    for (var i = 0; i < files.length; i++) els.files.appendChild(fileRow(files[i]));
  }

  /* The dot legend — names each state + shows its shape, so the non-color channel is
     legible. Always rendered (it documents the axis even when the list is empty). */
  function renderLegend() {
    clear(els.legend);
    var box = el('div', 'legend');
    var states = [
      ['claimed', 'claimed (unverified)'],
      ['soft', 'soft (capped)'],
      ['verified', 'verified (signed)'],
      ['human', 'human / neutral'],
    ];
    for (var i = 0; i < states.length; i++) {
      var lg = el('div', 'lg');
      lg.appendChild(el('span', 'prov ' + states[i][0]));
      lg.appendChild(el('span', null, states[i][1]));
      box.appendChild(lg);
    }
    els.legend.appendChild(box);
  }

  function renderFoot(model) {
    var n = model && model.fileCount != null ? model.fileCount : 0;
    els.foot.textContent =
      'Evidence-only. ' +
      n +
      ' brokered file write(s) this run, each with a FILE-LEVEL dot (no per-line ' +
      'authorship synthesized). Soft runs cap at violet; verified-blue is set only ' +
      'behind the webview signature gate. Foreign or malformed envelopes are dropped ' +
      '— nothing here is fabricated.';
  }

  function render(model) {
    els.runRef.textContent = model && model.shortRunId ? model.shortRunId : '';
    renderScope(model);
    renderFiles(model);
    renderLegend();
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
