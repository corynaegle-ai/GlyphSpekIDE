/*
 * GlyphStudio TRACE / PROVENANCE rail surface — webview renderer (Spec §5.9; honesty §2.2).
 *
 * Receives a { type:'render', runId, actorType, state, events } message from the
 * provider (traceViewProvider.ts) and draws the focused run's hash-chained,
 * append-only trace. The events are the RAW bytes the supervisor streamed — this
 * renderer RE-VERIFIES the chain itself, byte-for-byte, mirroring the Trust Panel
 * (media/app.js) and spikes/p0-trace/trace-store.ts:
 *
 *     hash_n = sha256( prevHash_n + canonicalJson({v,runId,seq,ts,type,payload[,source]}) )
 *     genesis prevHash = 64 hex zeros; trace_root = hash of the LAST event.
 *
 * HONESTY. The chain integrity shown is what THIS renderer recomputes from the bytes
 * it was handed — intact, or BROKEN at index i. It is NOT a verdict and NEVER renders
 * verifier-blue: an intact chain proves only tamper-evident integrity, not independent
 * verification. The "change one byte → the chain breaks" framing is literally true
 * here: edit any stored event and re-verify fails at that event. No external assets,
 * no inline handlers (CSP+nonce locked); the only privileged action is asking the
 * host to write the export bundle.
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /* ---- DOM handles ---- */
  const els = {
    count: document.getElementById('eventCount'),
    runHeader: document.getElementById('runHeader'),
    empty: document.getElementById('empty'),
    chainBadge: document.getElementById('chainBadge'),
    rootRow: document.getElementById('rootRow'),
    timeline: document.getElementById('timeline'),
    exportRow: document.getElementById('exportRow'),
    exportBtn: document.getElementById('exportBtn'),
  };

  /* ---- tiny DOM helpers ---- */
  function el(tag, opts) {
    const node = document.createElement(tag);
    if (!opts) return node;
    if (opts.className) node.className = opts.className;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.title) node.title = opts.title;
    return node;
  }
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }
  function fmtTime(ts) {
    if (typeof ts !== 'number') return String(ts == null ? '' : ts);
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toISOString().replace('T', ' ').replace('Z', 'Z');
  }
  function shortHash(h) {
    if (typeof h !== 'string' || h.length === 0) return '(none)';
    if (h.length <= 16) return h;
    return h.slice(0, 10) + '…' + h.slice(-6);
  }

  /* ================================================================== *
   * CHAIN RE-VERIFICATION — byte-for-byte the p0-trace / app.js scheme.
   * ================================================================== */

  const GENESIS_HASH = '0'.repeat(64);

  /** Canonical JSON: sorted object keys, omit undefined; same port app.js uses. */
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
    return 'undefined';
  }
  function canonicalJson(obj) {
    return canonicalEncode(obj);
  }

  /** The hashed content: derived chain fields (prevHash/hash) excluded; source folded only when present. */
  function hashableContent(evt) {
    const content = {
      v: evt.v,
      runId: evt.runId,
      seq: evt.seq,
      ts: evt.ts,
      type: evt.type,
      payload: evt.payload,
    };
    if (evt.source !== undefined) content.source = evt.source;
    return content;
  }

  function hasWebCryptoSubtle() {
    return typeof crypto !== 'undefined' && crypto && typeof crypto.subtle !== 'undefined';
  }

  function bytesToHex(buf) {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  async function computeEventHash(prevHash, evt) {
    const msg = new TextEncoder().encode(prevHash + canonicalJson(hashableContent(evt)));
    const digest = await crypto.subtle.digest('SHA-256', msg);
    return bytesToHex(digest);
  }

  /**
   * Recompute every event's hash + verify linkage. Returns { supported, ok, brokenIndex }.
   * For each event i: expected prevHash is GENESIS for i===0 else events[i-1].hash, and
   * the recomputed hash must equal the stored hash. supported:false → Web Crypto absent.
   */
  async function verifyChain(events) {
    if (!hasWebCryptoSubtle()) return { supported: false, ok: false };
    const list = Array.isArray(events) ? events : [];
    let expectedPrev = GENESIS_HASH;
    for (let i = 0; i < list.length; i++) {
      const evt = list[i];
      if (evt.prevHash !== expectedPrev) return { supported: true, ok: false, brokenIndex: i };
      const recomputed = await computeEventHash(evt.prevHash, evt);
      if (recomputed !== evt.hash) return { supported: true, ok: false, brokenIndex: i };
      expectedPrev = evt.hash;
    }
    return { supported: true, ok: true };
  }

  /** trace_root = hash of the LAST event, GENESIS for empty (each hash commits to all prior history). */
  function computeTraceRoot(events) {
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) return GENESIS_HASH;
    return list[list.length - 1].hash;
  }

  /* ================================================================== *
   * PAYLOAD SUMMARY — metadata only, NEVER a secret value (mirrors app.js).
   * ================================================================== */

  function argvToString(argv) {
    return Array.isArray(argv) ? argv.join(' ') : '';
  }

  function summarizePayload(evt) {
    const p = (evt && evt.payload) || {};
    switch (evt.type) {
      case 'run_created':
        return 'runDir=' + (p.runDir || '?');
      case 'run_state_changed':
        return (p.from != null ? p.from + ' → ' + p.to : '') + (p.reason ? '   ' + p.reason : '');
      case 'policy_decision':
        return [
          p.tool ? 'tool=' + p.tool : null,
          p.argv ? 'cmd="' + argvToString(p.argv) + '"' : null,
          p.destination ? 'dest=' + p.destination : null,
          p.rule ? 'rule=' + p.rule : null,
          p.decision ? 'decision=' + p.decision : null,
        ]
          .filter(Boolean)
          .join('   ');
      case 'tool_start':
        return p.argv ? '$ ' + argvToString(p.argv) : 'tool=' + (p.tool || '?');
      case 'tool_end':
        return (
          (p.argv ? '$ ' + argvToString(p.argv) : 'tool=' + (p.tool || '?')) +
          '   exitCode=' + (p.exitCode == null ? '?' : p.exitCode)
        );
      case 'redaction':
        // NEVER show the secret value — location/reason/field metadata only.
        return (
          'location=' + (p.location || '?') +
          '   reason=' + (p.reason || '?') +
          '   field=' + (p.field || '?') +
          '   (value never recorded)'
        );
      case 'model_call':
        return (
          'model=' + (p.model || '?') +
          '   tokens=' + (p.inputTokens || 0) + ' in / ' + (p.outputTokens || 0) + ' out'
        );
      case 'prompt':
        return 'role=' + (p.role || '?') + '   (content may be redacted)';
      case 'verifier_verdict':
        return (
          'overall=' + (p.overallVerdict || '?') +
          '   checks=' + (p.checks ? p.checks.length : 0) +
          '   (independent verification: see the Verifier surface)'
        );
      default:
        try {
          return JSON.stringify(p);
        } catch (e) {
          return '';
        }
    }
  }

  /** Per-type non-color chips (state/decision/redaction). No verifier-blue here. */
  function appendChips(container, evt) {
    const p = (evt && evt.payload) || {};
    if (evt.type === 'policy_decision' && p.decision) {
      container.appendChild(el('span', { className: 'chip decision-' + p.decision, text: p.decision }));
      if (p.blocked) container.appendChild(el('span', { className: 'chip blocked', text: 'BLOCKED' }));
    } else if (evt.type === 'redaction') {
      container.appendChild(el('span', { className: 'chip redaction', text: 'SECRET REDACTED' }));
    } else if (evt.type === 'run_state_changed' && p.to) {
      container.appendChild(el('span', { className: 'chip state', text: (p.from || '?') + ' → ' + p.to }));
    }
  }

  /* ================================================================== *
   * RENDER.
   * ================================================================== */

  let current = { runId: null, events: [] };
  // A monotonically-increasing token so a slow async verifyChain for an OLD render
  // can never overwrite the badge for a newer render.
  let renderToken = 0;

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  function renderHeader(model) {
    if (!els.runHeader) return;
    clear(els.runHeader);
    if (!model.runId) {
      setHidden(els.runHeader, true);
      return;
    }
    setHidden(els.runHeader, false);
    els.runHeader.appendChild(el('span', { className: 'run-id', text: model.runId, title: model.runId }));
    if (model.actorType) {
      els.runHeader.appendChild(el('span', { className: 'meta', text: 'actor: ' + model.actorType }));
    }
    if (model.state) {
      els.runHeader.appendChild(el('span', { className: 'meta', text: 'state: ' + model.state }));
    }
  }

  function renderTimeline(events, brokenIndex) {
    clear(els.timeline);
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      const isBroken = brokenIndex != null && i === brokenIndex;
      const afterBreak = brokenIndex != null && i > brokenIndex;
      const cls =
        'event' + (isBroken ? ' broken' : '') + (afterBreak ? ' after-break' : '');
      const row = el('div', { className: cls });

      const gutter = el('div', { className: 'event-gutter' });
      gutter.appendChild(el('span', { className: 'event-seq', text: '#' + evt.seq }));
      gutter.appendChild(el('span', { className: 'event-time', text: fmtTime(evt.ts) }));
      row.appendChild(gutter);

      const body = el('div', { className: 'event-body' });

      const head = el('div', { className: 'event-head' });
      head.appendChild(el('span', { className: 'event-type kind-' + evt.type, text: evt.type }));
      const chips = el('span', { className: 'event-chips' });
      appendChips(chips, evt);
      head.appendChild(chips);
      body.appendChild(head);

      const detail = el('div', { className: 'event-detail' });
      detail.textContent = summarizePayload(evt);
      body.appendChild(detail);

      const hashLine = el('div', { className: 'event-hash' });
      hashLine.appendChild(
        el('span', {
          text: 'hash ' + shortHash(evt.hash) + '  ← prev ' + shortHash(evt.prevHash),
          title: 'hash ' + (evt.hash || '') + '  ← prev ' + (evt.prevHash || ''),
        }),
      );
      if (isBroken) {
        hashLine.appendChild(document.createTextNode('  '));
        hashLine.appendChild(
          el('span', { className: 'break-note', text: '✕ chain breaks here — recomputed hash does not match' }),
        );
      }
      body.appendChild(hashLine);

      row.appendChild(body);
      els.timeline.appendChild(row);
    }
  }

  function renderChainBadge(result, eventCount) {
    if (!els.chainBadge) return;
    clear(els.chainBadge);
    els.chainBadge.className = 'chain-badge';

    if (eventCount === 0) {
      setHidden(els.chainBadge, true);
      return;
    }
    setHidden(els.chainBadge, false);

    if (!result) {
      els.chainBadge.classList.add('pending');
      els.chainBadge.appendChild(el('span', { className: 'glyph', text: '⋯' }));
      els.chainBadge.appendChild(el('span', { text: 're-verifying the hash chain over the received events…' }));
      return;
    }
    if (result.supported === false) {
      els.chainBadge.classList.add('pending');
      els.chainBadge.appendChild(el('span', { className: 'glyph', text: 'ⓘ' }));
      const wrap = el('span');
      wrap.appendChild(document.createTextNode('Web Crypto unavailable — cannot re-verify the chain in this view.'));
      wrap.appendChild(el('span', { className: 'sub', text: 'The chain is shown as-received; integrity is not re-checked here.' }));
      els.chainBadge.appendChild(wrap);
      return;
    }
    if (result.ok) {
      els.chainBadge.classList.add('intact');
      els.chainBadge.appendChild(el('span', { className: 'glyph', text: '✓' }));
      const wrap = el('span');
      wrap.appendChild(document.createTextNode('Hash chain intact — re-verified here over ' + eventCount + ' event' + (eventCount === 1 ? '' : 's') + '.'));
      wrap.appendChild(
        el('span', {
          className: 'sub',
          text: 'Tamper-evident, not verified: change one byte of any event and re-verification breaks at it. This is integrity, not an independent verdict.',
        }),
      );
      els.chainBadge.appendChild(wrap);
      return;
    }
    // Broken.
    els.chainBadge.classList.add('broken');
    els.chainBadge.appendChild(el('span', { className: 'glyph', text: '✕' }));
    const wrap = el('span');
    const at = typeof result.brokenIndex === 'number' ? ' at event #' + result.brokenIndex : '';
    wrap.appendChild(document.createTextNode('Hash chain BROKEN' + at + ' — the trace was tampered or is incomplete.'));
    wrap.appendChild(
      el('span', {
        className: 'sub',
        text: 'A broken chain can carry no verified provenance. Nothing downstream of the break can be trusted.',
      }),
    );
    els.chainBadge.appendChild(wrap);
  }

  function renderRoot(events, result) {
    if (!els.rootRow) return;
    clear(els.rootRow);
    if (events.length === 0) {
      setHidden(els.rootRow, true);
      return;
    }
    setHidden(els.rootRow, false);
    els.rootRow.appendChild(el('div', { className: 'label', text: 'Trace root (hash of the last event)' }));
    const root = computeTraceRoot(events);
    const broken = result && result.supported !== false && !result.ok;
    els.rootRow.appendChild(
      el('div', {
        text: root + (broken ? '  (chain broken — root is not anchored)' : ''),
        title: root,
      }),
    );
  }

  function render(model) {
    current = { runId: model.runId, events: Array.isArray(model.events) ? model.events : [] };
    const events = current.events;
    const token = ++renderToken;

    if (els.count) els.count.textContent = String(events.length);
    renderHeader(model);
    setHidden(els.empty, events.length > 0 || !!model.runId);

    renderTimeline(events, null); // draw immediately; mark the break once verify resolves.
    renderChainBadge(null, events.length); // pending
    renderRoot(events, null);
    setHidden(els.exportRow, events.length === 0);
    if (els.exportBtn) els.exportBtn.disabled = events.length === 0;

    // Re-verify asynchronously (Web Crypto). Ignore stale results.
    verifyChain(events).then((result) => {
      if (token !== renderToken) return; // a newer render superseded this one.
      renderChainBadge(result, events.length);
      renderRoot(events, result);
      const brokenIndex =
        result && result.supported !== false && !result.ok && typeof result.brokenIndex === 'number'
          ? result.brokenIndex
          : null;
      renderTimeline(events, brokenIndex);
    });
  }

  /* ---- wiring ---- */
  if (els.exportBtn) {
    els.exportBtn.addEventListener('click', function () {
      vscode.postMessage({ type: 'exportBundle' });
    });
  }

  window.addEventListener('message', function (event) {
    const msg = event && event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'render') render(msg);
  });

  // Tell the host we are ready for a first paint.
  vscode.postMessage({ type: 'ready' });
})();
