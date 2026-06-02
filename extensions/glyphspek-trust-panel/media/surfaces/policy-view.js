/*
 * GlyphSpek POLICY-as-code rail surface — webview renderer (Spec §5.9).
 *
 * Receives two message kinds from the provider (policyViewProvider.ts):
 *   - { type:'policy/posture',  posture }   — the standing .glyphspek/policy.yml posture
 *                                             (defaults / allow / deny / required-review /
 *                                             verify) + the git-reviewed banner. Available
 *                                             whenever a workspace is open; no run needed.
 *   - { type:'policy/decisions', runId, decisions, counts }
 *                                           — the per-run allow/ask/deny breakdown the
 *                                             BROKER recorded, folded from the stream.
 *
 * HONESTY (Spec §2.2):
 *   - The posture is the file's standing INTENT, not a claim of enforcement.
 *   - A `deny` decision renders DISTINCTLY (red). `blocked` shows only when the stream
 *     reported it. `observe-only` is labelled OBSERVED (soft/violet), never as an allow.
 *   - Nothing is fabricated: counts/decisions are exactly what the provider folded.
 *
 * Native DOM only; no innerHTML with interpolated data, no inline handlers (CSP).
 */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /* ------------------------- DOM helpers ------------------------- */
  function el(tag, opts, children) {
    const node = document.createElement(tag);
    if (opts) {
      if (opts.className) node.className = opts.className;
      if (opts.text != null) node.textContent = String(opts.text);
      if (opts.title) node.title = opts.title;
    }
    if (children) for (const c of children) if (c) node.appendChild(c);
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  const root = document.getElementById('surface-root');

  // Persisted state across reloads (so a hidden→shown view re-renders without a re-post).
  let postureState = (vscode.getState() && vscode.getState().posture) || null;
  let decisionsState = (vscode.getState() && vscode.getState().decisions) || null;

  function persist() {
    vscode.setState({ posture: postureState, decisions: decisionsState });
  }

  /* ------------------------- top render ------------------------- */
  function render() {
    clear(root);
    root.appendChild(el('div', { className: 'surface-h', text: 'Policy-as-code' }));
    root.appendChild(renderPostureSection(postureState));
    root.appendChild(renderDecisionsSection(decisionsState));
    root.appendChild(
      el('div', {
        className: 'disclaimer',
        text:
          'The posture above is the policy file’s standing intent — not a claim it was enforced. ' +
          'The decisions below are what the broker recorded during the focused run; denied actions ' +
          'are shown distinctly. Observe-only egress is OBSERVED on the bypassable soft plane, not a policy allow.',
      }),
    );
  }

  /* ------------------------- posture ------------------------- */
  function renderPostureSection(posture) {
    const sec = el('section');
    sec.appendChild(el('div', { className: 'sec-h', text: 'Policy file (git-reviewed)' }));
    const card = el('div', { className: 'card' });

    if (!posture) {
      card.appendChild(
        el('div', { className: 'muted', text: 'Resolving the policy file…' }),
      );
      sec.appendChild(card);
      return sec;
    }

    // Path line — always shown.
    const pathLine = el('div', { className: 'path-line' });
    pathLine.appendChild(el('span', { className: 'label', text: 'path: ' }));
    pathLine.appendChild(document.createTextNode(posture.resolvedPath || posture.settingValue || '(unset)'));
    card.appendChild(pathLine);
    card.appendChild(
      el('div', {
        className: 'src-note',
        text: posture.fromSetting
          ? 'from glyphspek.policyPath setting: ' + posture.settingValue
          : 'default (glyphspek.policyPath unset): ' + posture.settingValue,
      }),
    );

    // git-reviewed banner — provenance via the exact-bytes sha256.
    card.appendChild(renderBanner(posture));

    if (posture.status !== 'ok') {
      card.appendChild(
        el('div', {
          className: 'empty',
          text: postureStatusMessage(posture),
        }),
      );
      sec.appendChild(card);
      return sec;
    }

    if (posture.structured) {
      if (posture.version != null) {
        card.appendChild(el('div', { className: 'src-note', text: 'version: ' + posture.version }));
      }
      card.appendChild(renderDefaults(posture.defaults || []));
      card.appendChild(renderRuleGroup('allow', 'Allow', posture.allow));
      card.appendChild(renderRuleGroup('deny', 'Deny', posture.deny));
      card.appendChild(renderRequiredReview(posture.requiredReview));
      card.appendChild(renderVerify(posture.verify));
    } else {
      // Could not confidently structure — show the raw bytes rather than a guess.
      card.appendChild(
        el('div', {
          className: 'muted',
          text: 'Could not structure this policy file confidently; showing the reviewed source verbatim:',
        }),
      );
      if (posture.rawText) card.appendChild(el('pre', { className: 'raw', text: posture.rawText }));
    }

    sec.appendChild(card);
    return sec;
  }

  function renderBanner(posture) {
    const reviewed = posture.status === 'ok' && !!posture.sha256;
    const banner = el('div', { className: 'banner ' + (reviewed ? 'reviewed' : 'unread') });
    banner.appendChild(el('span', { className: 'dot' }));
    const body = el('div');
    if (reviewed) {
      body.appendChild(el('div', { className: 'b-title', text: 'Git-reviewed policy-as-code' }));
      body.appendChild(
        el('div', {
          className: 'b-sub',
          text: 'This is the standing posture checked into the repo and reviewable in git.',
        }),
      );
    } else {
      body.appendChild(el('div', { className: 'b-title', text: 'Policy file not readable' }));
      body.appendChild(
        el('div', { className: 'b-sub', text: postureStatusMessage(posture) }),
      );
    }
    banner.appendChild(body);
    const wrap = el('div');
    wrap.appendChild(banner);
    if (posture.sha256) {
      wrap.appendChild(
        el('div', {
          className: 'hash-line',
          title: 'sha256 of the exact policy bytes',
          text: 'sha256 ' + posture.sha256.slice(0, 16) + '…' + posture.sha256.slice(-8),
        }),
      );
    }
    return wrap;
  }

  function postureStatusMessage(posture) {
    if (posture.note) return posture.note;
    switch (posture.status) {
      case 'missing': return 'policy file not found at this path';
      case 'too-large': return 'policy file too large to read';
      case 'not-a-file': return 'path is not a regular file';
      case 'unreadable': return 'policy file could not be read';
      case 'no-workspace': return 'no workspace folder open to resolve this relative path';
      default: return 'policy file unavailable';
    }
  }

  function renderDefaults(defaults) {
    const group = el('div', { className: 'rule-group' });
    group.appendChild(el('div', { className: 'rg-h', text: 'Defaults' }));
    if (!defaults.length) {
      group.appendChild(el('div', { className: 'empty', text: '(no defaults declared)' }));
      return group;
    }
    const grid = el('div', { className: 'defaults' });
    for (const d of defaults) {
      grid.appendChild(el('span', { className: 'd-tool', text: d.tool }));
      grid.appendChild(el('span', { className: 'd-verb ' + verbClass(d.verb), text: d.verb }));
    }
    group.appendChild(grid);
    return group;
  }

  function verbClass(verb) {
    if (verb === 'allow') return 'verb-allow';
    if (verb === 'deny') return 'verb-deny';
    if (verb === 'ask' || verb === 'force_ask') return 'verb-ask';
    return 'verb-other';
  }

  function renderRuleGroup(kind, title, section) {
    const group = el('div', { className: 'rule-group ' + kind });
    group.appendChild(el('div', { className: 'rg-h', text: title }));
    if (!section) {
      group.appendChild(el('div', { className: 'empty', text: '(none)' }));
      return group;
    }
    const subs = [
      ['read paths', section.read_paths],
      ['write paths', section.write_paths],
      ['commands', section.commands],
      ['network', section.network],
    ];
    let any = false;
    for (const [label, list] of subs) {
      if (!list || !list.length) continue;
      any = true;
      group.appendChild(el('div', { className: 'rule-sub', text: label }));
      const ul = el('ul', { className: 'rules' });
      for (const item of list) ul.appendChild(el('li', { text: item }));
      group.appendChild(ul);
    }
    if (!any) group.appendChild(el('div', { className: 'empty', text: '(none)' }));
    return group;
  }

  function renderRequiredReview(list) {
    const group = el('div', { className: 'rule-group' });
    group.appendChild(el('div', { className: 'rg-h', text: 'Required review' }));
    if (!list || !list.length) {
      group.appendChild(
        el('div', { className: 'empty', text: '(no required-review section in this policy)' }),
      );
      return group;
    }
    const ul = el('ul', { className: 'rules' });
    for (const item of list) ul.appendChild(el('li', { text: item }));
    group.appendChild(ul);
    return group;
  }

  function renderVerify(list) {
    const group = el('div', { className: 'rule-group' });
    group.appendChild(el('div', { className: 'rg-h', text: 'Verify (checks the verifier runs)' }));
    if (!list || !list.length) {
      group.appendChild(el('div', { className: 'empty', text: '(no verify commands declared)' }));
      return group;
    }
    const ul = el('ul', { className: 'rules' });
    for (const item of list) ul.appendChild(el('li', { text: item }));
    group.appendChild(ul);
    return group;
  }

  /* ------------------------- per-run decisions ------------------------- */
  function renderDecisionsSection(data) {
    const sec = el('section');
    sec.appendChild(el('div', { className: 'sec-h', text: 'Broker decisions this run' }));
    const card = el('div', { className: 'card' });

    if (!data || !data.runId) {
      card.appendChild(
        el('div', {
          className: 'muted',
          text:
            'No focused run yet. When a governed run is in focus, the allow / ask / deny ' +
            'decisions the broker actually made appear here — accumulated live from the trace.',
        }),
      );
      sec.appendChild(card);
      return sec;
    }

    card.appendChild(el('div', { className: 'run-tag', text: 'run ' + data.runId }));

    const counts = data.counts || {};
    const chips = el('div', { className: 'counts' });
    chips.appendChild(countChip('allow', 'allow', counts.allow || 0));
    chips.appendChild(countChip('ask', 'ask', counts.ask || 0));
    chips.appendChild(countChip('deny', 'deny', counts.deny || 0));
    if (counts.blocked) chips.appendChild(countChip('blocked', 'blocked', counts.blocked));
    if (counts.observeOnly) chips.appendChild(countChip('observe', 'observed', counts.observeOnly));
    card.appendChild(chips);

    const decisions = data.decisions || [];
    if (!decisions.length) {
      card.appendChild(
        el('div', { className: 'empty', text: 'No policy decisions recorded for this run yet.' }),
      );
      sec.appendChild(card);
      return sec;
    }

    const ul = el('ul', { className: 'decisions' });
    for (const d of decisions) ul.appendChild(renderDecision(d));
    card.appendChild(ul);

    sec.appendChild(card);
    return sec;
  }

  function countChip(cls, label, n) {
    const chip = el('div', { className: 'count-chip ' + cls });
    chip.appendChild(el('span', { className: 'n', text: String(n) }));
    chip.appendChild(el('span', { text: label }));
    return chip;
  }

  function decisionClass(d) {
    if (d.decision === 'deny') return 'd-deny';
    if (d.observeOnly) return 'd-observe';
    if (d.decision === 'allow' || d.decision === 'allow_with_redaction' ||
        d.decision === 'sandbox_only' || d.decision === 'read_only') return 'd-allow';
    if (d.decision === 'ask' || d.decision === 'force_ask') return 'd-ask';
    return 'd-other';
  }

  function renderDecision(d) {
    const li = el('li', { className: 'decision ' + decisionClass(d) });
    li.appendChild(el('span', { className: 'd-verb', text: d.decision || 'unknown' }));

    const cap = el('div', { className: 'd-cap' });
    cap.appendChild(document.createTextNode(d.requestedCapability || d.tool || '(unspecified)'));
    if (d.blocked) cap.appendChild(el('span', { className: 'd-blocked', text: 'BLOCKED — not executed' }));
    if (d.observeOnly) cap.appendChild(el('span', { className: 'd-observe-tag', text: 'OBSERVED (soft)' }));
    li.appendChild(cap);

    const metaBits = [];
    if (d.tool) metaBits.push('tool=' + d.tool);
    if (d.rule) metaBits.push('rule=' + d.rule);
    if (d.provenanceLabel) metaBits.push('prov=' + d.provenanceLabel);
    metaBits.push('#' + d.seq);
    const meta = el('div', { className: 'd-meta' });
    meta.appendChild(el('span', { className: 'tag', text: metaBits.join('   ') }));
    li.appendChild(meta);

    return li;
  }

  /* ------------------------- message wiring ------------------------- */
  window.addEventListener('message', function (e) {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'policy/posture') {
      postureState = msg.posture || null;
      persist();
      render();
    } else if (msg.type === 'policy/decisions') {
      decisionsState = { runId: msg.runId, decisions: msg.decisions, counts: msg.counts };
      persist();
      render();
    }
  });

  // Initial paint from persisted state, then announce readiness so the provider
  // replays the current posture + decisions.
  render();
  vscode.postMessage({ type: 'ready' });
})();
