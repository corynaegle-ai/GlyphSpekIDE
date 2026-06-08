/*
 * GlyphStudio SETTINGS rail surface — webview renderer (Spec §5.9 "Settings").
 *
 * Pure presentation. Receives a fully-derived view model from settingsViewProvider.ts
 * via a { type:'render', model } message and draws it with native DOM (no framework, no
 * innerHTML of dynamic data — every dynamic value goes through textContent). It performs
 * NO validation and INVENTS no state: the host read the ACTUAL glyphstudio.* config and
 * derived the model. Flipping a switch posts { type:'toggle', key, value } back to the
 * host, which writes it via config.update(...) at the right scope and re-renders.
 *
 * HONESTY (§2.2): only writable toggles render an actual switch; read-only governance
 * rows render a lock chip (never a switch); the "not yet a setting" notes are cautioned
 * text, never a live control. Nothing here implies enforcement that the host did not read.
 */

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var els = {
    scopeRef: document.getElementById('scopeRef'),
    intro: document.getElementById('intro'),
    toggles: document.getElementById('toggles'),
    readonly: document.getElementById('readonly'),
    future: document.getElementById('future'),
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

  function renderIntro() {
    clear(els.intro);
    els.intro.appendChild(
      el(
        'div',
        null,
        'These are your LOCAL glyphstudio.* settings — not the run/event stream. Toggling a ' +
          'switch writes the setting (user scope) and takes effect immediately. Machine-scoped ' +
          'trust roots are shown read-only and can only be changed out-of-band.',
      ),
    );
  }

  /* One writable toggle row with a real, focusable switch button. */
  function toggleRow(t) {
    var row = el('div', 'toggle');

    var top = el('div', 't-top');

    var labelWrap = el('div', null);
    labelWrap.style.flex = '1 1 auto';
    labelWrap.appendChild(el('div', 't-label', t.label));
    top.appendChild(labelWrap);

    var ctrl = el('div', 't-ctrl');
    var sw = el('button', 'switch');
    sw.setAttribute('type', 'button');
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-pressed', t.value ? 'true' : 'false');
    sw.setAttribute('aria-label', t.label + (t.value ? ' (on)' : ' (off)'));
    sw.addEventListener('click', function () {
      // Optimistic flip is avoided — the host writes + re-renders, the single source of
      // truth. We just request the new value.
      vscode.postMessage({ type: 'toggle', key: t.key, value: !t.value });
    });
    ctrl.appendChild(sw);
    ctrl.appendChild(el('div', 't-state', t.value ? 'ON' : 'OFF'));
    top.appendChild(ctrl);

    row.appendChild(top);
    row.appendChild(el('div', 't-desc', t.description));
    return row;
  }

  function renderToggles(model) {
    clear(els.toggles);
    var rows = (model && model.toggles) || [];
    if (!rows.length) {
      els.toggles.appendChild(el('div', 't-desc', 'No writable toggles available in this host.'));
      return;
    }
    for (var i = 0; i < rows.length; i++) els.toggles.appendChild(toggleRow(rows[i]));
  }

  /* One read-only governance row: a lock chip, the effective value, the honest reason. */
  function readonlyRow(s) {
    var row = el('div', 'ro');

    var top = el('div', 'r-top');
    top.appendChild(el('span', 'r-label', s.label));
    top.appendChild(el('span', 'lock', 'read-only'));
    row.appendChild(top);

    var valLine = el('div', 'r-top');
    var val = el('span', 'r-value' + (s.configured ? '' : ' unset'), s.display);
    valLine.appendChild(val);
    row.appendChild(valLine);

    row.appendChild(el('div', 'r-desc', s.description));
    row.appendChild(el('div', 'r-reason', s.reason));
    return row;
  }

  function renderReadonly(model) {
    clear(els.readonly);
    var rows = (model && model.readonly) || [];
    for (var i = 0; i < rows.length; i++) els.readonly.appendChild(readonlyRow(rows[i]));
  }

  /* One "not yet a setting" honest note — cautioned, never a live control. */
  function futureRow(f) {
    var row = el('div', 'fnote');
    row.appendChild(el('span', 'f-label', f.label));
    row.appendChild(el('div', 'f-detail', f.detail));
    return row;
  }

  function renderFuture(model) {
    clear(els.future);
    var rows = (model && model.future) || [];
    for (var i = 0; i < rows.length; i++) els.future.appendChild(futureRow(rows[i]));
  }

  function renderFoot() {
    els.foot.textContent =
      'Reflects your actual glyphstudio.* configuration. Only wired settings appear; ' +
      'machine-scoped trust roots are read-only here so a workspace can never inject a ' +
      'trust root. Un-wired / v2 concepts are labelled, never faked as live toggles.';
  }

  function render(model) {
    if (els.scopeRef) els.scopeRef.textContent = 'local config';
    renderIntro();
    renderToggles(model);
    renderReadonly(model);
    renderFuture(model);
    renderFoot();
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'render') render(msg.model || {});
  });

  // Tell the host we are live; it replies with the current model.
  vscode.postMessage({ type: 'ready' });
})();
