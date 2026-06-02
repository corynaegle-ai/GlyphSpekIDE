/*
 * GlyphSpek SEARCH rail surface — webview renderer (Spec §5.9 "Search"), INTERIM build.
 *
 * Pure presentation. Receives a fully-folded, already-validated corpus from
 * searchViewProvider.ts via a { type:'render', model } message and filters/draws it
 * with native DOM (no framework; every dynamic value goes through textContent — no
 * innerHTML of dynamic data). It performs NO validation and INVENTS no data: the
 * provider already ran validateRunEvent on each envelope and indexed only the metadata
 * the stream carried.
 *
 * HONEST INTERIM (§2.2): this filters the focused run's RECORDED HISTORY, NOT live
 * sandbox contents. The amber banner in the HTML states that; this renderer never
 * implies a sandbox boundary. An empty corpus renders the honest empty state, never a
 * fabricated result.
 */

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var els = {
    runRef: document.getElementById('runRef'),
    q: document.getElementById('q'),
    filters: document.getElementById('filters'),
    resultMeta: document.getElementById('resultMeta'),
    results: document.getElementById('results'),
    foot: document.getElementById('foot'),
  };

  // The full corpus posted by the host, and the active category filter ('' = all).
  var model = { hasRun: false, recordCount: 0, records: [] };
  var activeCategory = '';

  var CATEGORY_ORDER = ['command', 'file', 'policy', 'model', 'network', 'lifecycle', 'other'];

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

  /* Build a summary element with the matched query substring highlighted. Uses ONLY
     textContent for every fragment, so no dynamic value is ever parsed as HTML. */
  function summaryEl(summary, query) {
    var span = el('span', 'r-summary');
    var text = String(summary == null ? '' : summary);
    if (!query) {
      span.textContent = text;
      return span;
    }
    var lcText = text.toLowerCase();
    var lcQuery = query.toLowerCase();
    var idx = 0;
    var from = lcText.indexOf(lcQuery, idx);
    if (from === -1) {
      span.textContent = text;
      return span;
    }
    while (from !== -1) {
      if (from > idx) span.appendChild(document.createTextNode(text.slice(idx, from)));
      span.appendChild(el('span', 'hit', text.slice(from, from + query.length)));
      idx = from + query.length;
      from = lcText.indexOf(lcQuery, idx);
    }
    if (idx < text.length) span.appendChild(document.createTextNode(text.slice(idx)));
    return span;
  }

  /* Count records per category for the filter chips. */
  function countByCategory(records) {
    var counts = {};
    for (var i = 0; i < records.length; i++) {
      var c = records[i].category || 'other';
      counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }

  /* The active filtered set: category match AND query substring match over `text`. */
  function filtered() {
    var query = (els.q.value || '').trim().toLowerCase();
    var out = [];
    for (var i = 0; i < model.records.length; i++) {
      var r = model.records[i];
      if (activeCategory && (r.category || 'other') !== activeCategory) continue;
      if (query && String(r.text || '').indexOf(query) === -1) continue;
      out.push(r);
    }
    return out;
  }

  function renderFilters() {
    clear(els.filters);
    if (!model.hasRun || !model.records.length) return;
    var counts = countByCategory(model.records);

    var all = el('button', 'fchip');
    all.type = 'button';
    all.setAttribute('aria-pressed', activeCategory === '' ? 'true' : 'false');
    all.textContent = 'All';
    var allCount = el('span', 'fcount', model.records.length);
    all.appendChild(allCount);
    all.addEventListener('click', function () {
      activeCategory = '';
      renderAll();
    });
    els.filters.appendChild(all);

    for (var i = 0; i < CATEGORY_ORDER.length; i++) {
      var cat = CATEGORY_ORDER[i];
      if (!counts[cat]) continue;
      (function (catName) {
        var chip = el('button', 'fchip');
        chip.type = 'button';
        chip.setAttribute('aria-pressed', activeCategory === catName ? 'true' : 'false');
        chip.textContent = catName;
        chip.appendChild(el('span', 'fcount', counts[catName]));
        chip.addEventListener('click', function () {
          activeCategory = activeCategory === catName ? '' : catName;
          renderAll();
        });
        els.filters.appendChild(chip);
      })(cat);
    }
  }

  function resultRow(r, query) {
    var row = el('div', 'row ' + (r.category || 'other'));
    var top = el('div', 'r-top');
    top.appendChild(summaryEl(r.summary, query));
    top.appendChild(el('span', 'cat ' + (r.category || 'other'), r.category || 'other'));
    row.appendChild(top);

    var metaParts = [];
    if (r.kind) metaParts.push(r.kind);
    if (r.seq != null && r.seq >= 0) metaParts.push('seq ' + r.seq);
    if (r.ts) {
      try {
        metaParts.push(new Date(r.ts).toLocaleTimeString());
      } catch (e) {
        /* ignore unparseable ts */
      }
    }
    if (metaParts.length) row.appendChild(el('div', 'r-meta', metaParts.join('   ·   ')));
    return row;
  }

  function renderResults() {
    var query = (els.q.value || '').trim();
    var rows = filtered();
    clear(els.results);

    if (!model.hasRun) {
      els.resultMeta.textContent = '';
      els.results.appendChild(
        el(
          'p',
          'empty',
          'No focused run yet. When a governed run streams events, its recorded history becomes searchable here. Nothing is fabricated.',
        ),
      );
      return;
    }

    if (!model.records.length) {
      els.resultMeta.textContent = '';
      els.results.appendChild(
        el('p', 'empty', 'This run has no recorded history yet — no commands, files, decisions or calls observed so far.'),
      );
      return;
    }

    var scope = activeCategory ? activeCategory : 'all categories';
    if (query) {
      els.resultMeta.textContent = rows.length + ' of ' + model.records.length + ' records match “' + query + '” (' + scope + ')';
    } else {
      els.resultMeta.textContent = rows.length + ' of ' + model.records.length + ' recorded records (' + scope + ')';
    }

    if (!rows.length) {
      els.results.appendChild(
        el('p', 'empty', 'No recorded-history records match. This searches what GlyphSpek observed, not live sandbox files.'),
      );
      return;
    }

    for (var i = 0; i < rows.length; i++) els.results.appendChild(resultRow(rows[i], query));
  }

  function renderFoot() {
    els.foot.textContent =
      'INTERIM: searches this run’s recorded history (events GlyphSpek observed and folded), ' +
      'not live sandbox contents. Foreign or malformed envelopes are dropped — nothing here ' +
      'is fabricated. Sandbox-scoped search ships with the isolated plane.';
  }

  function renderAll() {
    els.runRef.textContent = model && model.shortRunId ? model.shortRunId : '';
    renderFilters();
    renderResults();
    renderFoot();
  }

  els.q.addEventListener('input', renderResults);

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'render') {
      model = msg.model || { hasRun: false, recordCount: 0, records: [] };
      // If the active category vanished from the new corpus, fall back to "all".
      if (activeCategory) {
        var stillPresent = false;
        for (var i = 0; i < model.records.length; i++) {
          if ((model.records[i].category || 'other') === activeCategory) {
            stillPresent = true;
            break;
          }
        }
        if (!stillPresent) activeCategory = '';
      }
      renderAll();
    }
  });

  // Tell the host we are live; it replies with the current corpus.
  vscode.postMessage({ type: 'ready' });
})();
