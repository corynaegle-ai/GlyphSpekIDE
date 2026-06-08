/*
 * GlyphStudio chat renderer (webview). A THIN renderer over GlyphStudioChatModel
 * (chatView.js). It NEVER calls a model itself and NEVER touches the network: it
 * posts an intent to the extension host, which assembles the bridge model.call and
 * holds the provider credential supervisor-side. The host posts back the redacted
 * model.call RESULT and the model allowlist; this file folds them into the view
 * model and re-renders.
 *
 * CREDENTIAL HYGIENE: every inbound payload from the host is passed through the
 * model's credential scrubber/guard before it is stored. Nothing in this view can
 * hold or show a token (the contract has no credential field; the guard is defense
 * in depth).
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var M = window.GlyphStudioChatModel;

  var state = M.emptyChatView();

  var el = {
    subtitle: document.getElementById('chat-subtitle'),
    demoBanner: document.getElementById('chat-demo-banner'),
    transcriptCaption: document.getElementById('chat-transcript-caption'),
    footer: document.getElementById('chat-footer'),
    model: document.getElementById('chat-model'),
    totals: document.getElementById('chat-totals'),
    status: document.getElementById('chat-status'),
    transcript: document.getElementById('chat-transcript'),
    input: document.getElementById('chat-input'),
    send: document.getElementById('chat-send'),
    includeSel: document.getElementById('chat-include-selection'),
    approval: document.getElementById('chat-approval'),
    approvalReason: document.getElementById('chat-approval-reason'),
    approve: document.getElementById('chat-approve'),
    dismiss: document.getElementById('chat-dismiss'),
  };

  /** The text of the last user turn, kept so an approval can retry it. */
  var lastSentText = '';
  var lastSentOpts = null;

  /*
   * GATEWAY HONESTY POSTURE (sweep-20 High #4). Default to the DEMO/STUB posture so
   * the UI NEVER over-claims during boot: until the host posts chatGatewayMode of
   * 'brokered', the demo banner is shown and the brokered/auditable/traced claims
   * are withheld. Only a real supervisor-backed gateway flips this to 'brokered'.
   */
  var gatewayMode = 'stub';

  var COPY = {
    stub: {
      subtitle: 'Governed chat & inline edit · DEMO (stubbed, not brokered)',
      caption:
        'DEMO: replies below are stubbed. They are NOT brokered through the ' +
        'supervisor, NOT audited, and NOT traced. Any "trace" id shown is a ' +
        'placeholder stub, not an auditable Trust Panel reference.',
      footer:
        'Demo chat surface — responses are stubbed, not brokered or audited. ' +
        'Model selection, deny/force_ask handling, and diff-gating are exercised ' +
        'against the stub; no provider is called and no credential is involved.',
    },
    brokered: {
      subtitle: 'Governed chat & inline edit · every model call is brokered',
      caption:
        'Each reply shows its policy decision, the redacted completion, token/cost ' +
        'usage, and a trace ref auditable in the Trust Panel. The provider ' +
        'credential is held supervisor-side and never reaches this view.',
      footer:
        'Governed chat surface. Only models the supervisor allowlists are ' +
        'selectable; a denied call renders a blocked card and a force_ask raises an ' +
        'approval prompt. Inline edits are diff-gated. No credential is stored or ' +
        'displayed in this view.',
    },
  };

  /** Apply the mode-dependent copy + demo banner. Defaults to the demo posture. */
  function renderMode() {
    var copy = COPY[gatewayMode] || COPY.stub;
    var isStub = gatewayMode !== 'brokered';
    if (el.subtitle) el.subtitle.textContent = copy.subtitle;
    if (el.transcriptCaption) el.transcriptCaption.textContent = copy.caption;
    if (el.footer) el.footer.textContent = copy.footer;
    // The demo banner is shown ONLY on the stub gateway.
    if (el.demoBanner) el.demoBanner.hidden = !isStub;
  }

  function render() {
    // Model picker — ONLY allowlisted models.
    el.model.innerHTML = '';
    if (state.allowedModels.length === 0) {
      var opt = document.createElement('option');
      opt.textContent = '(no models allowlisted)';
      opt.value = '';
      opt.disabled = true;
      el.model.appendChild(opt);
      el.send.disabled = true;
    } else {
      state.allowedModels.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.label;
        o.textContent = m.label;
        if (m.label === state.selectedModel) o.selected = true;
        el.model.appendChild(o);
      });
      el.send.disabled = false;
    }

    el.totals.textContent =
      state.totals.inputTokens + state.totals.outputTokens > 0
        ? 'tokens: ' +
          (state.totals.inputTokens + state.totals.outputTokens) +
          ' · cost: ' +
          M.formatCostMicroUsd(state.totals.costMicroUsd)
        : '';

    el.status.textContent = state.status || '';
    el.status.hidden = !state.status;

    // Approval prompt.
    if (state.pendingApproval) {
      el.approval.hidden = false;
      el.approvalReason.textContent =
        state.pendingApproval.provider +
        ' / ' +
        state.pendingApproval.model +
        ' — ' +
        state.pendingApproval.reason;
    } else {
      el.approval.hidden = true;
    }

    // Transcript.
    el.transcript.innerHTML = '';
    state.turns.forEach(function (t) {
      el.transcript.appendChild(renderTurn(t));
    });
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderTurn(t) {
    var wrap = document.createElement('div');
    wrap.className = 'chat-turn chat-turn-' + t.role + (t.blocked ? ' chat-turn-blocked' : '');

    var roleEl = document.createElement('div');
    roleEl.className = 'chat-turn-role';
    roleEl.textContent = t.role;
    wrap.appendChild(roleEl);

    var body = document.createElement('div');
    body.className = 'chat-turn-body';
    body.textContent = t.content; // textContent — never innerHTML for model output.
    wrap.appendChild(body);

    if (t.role === 'assistant') {
      var meta = document.createElement('div');
      meta.className = 'chat-turn-meta';
      var bits = [];
      if (t.decision) bits.push(badge('decision', t.decision));
      if (t.usage) {
        var tok = (t.usage.inputTokens || 0) + (t.usage.outputTokens || 0);
        bits.push(
          'tokens ' + tok + ' · ' + M.formatCostMicroUsd(t.usage.costMicroUsd || 0),
        );
      }
      if (t.traceEventRef) {
        // On the stub gateway, label the ref as a STUB placeholder so it is never
        // mistaken for an auditable Trust Panel trace reference (sweep-20 High #4).
        var refLabel = gatewayMode === 'brokered' ? 'trace ' : 'stub-trace ';
        bits.push(refLabel + shortHash(t.traceEventRef));
      }
      meta.textContent = bits.join('  ');
      wrap.appendChild(meta);
    }
    return wrap;
  }

  function badge(label, value) {
    return label + '=' + value;
  }

  function shortHash(h) {
    return String(h).slice(0, 10);
  }

  /* --------------------------- host messaging --------------------------- */

  function send() {
    var text = (el.input.value || '').trim();
    if (!text) return;
    lastSentText = text;
    lastSentOpts = { includeSelection: !!el.includeSel.checked };
    // Locally append the user turn + clear input; the host returns the result.
    var r = M.assembleUserCall(state, text, {});
    state = r.view;
    el.input.value = '';
    render();
    // Ask the host to broker the call (it holds the credential + builds context).
    vscode.postMessage({
      type: 'chatSend',
      text: text,
      includeSelection: !!el.includeSel.checked,
    });
  }

  el.send.addEventListener('click', send);
  el.input.addEventListener('keydown', function (e) {
    // Cmd/Ctrl+Enter sends.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });

  el.model.addEventListener('change', function () {
    state = M.selectModel(state, el.model.value);
    vscode.postMessage({ type: 'chatSelectModel', label: el.model.value });
    render();
  });

  el.approve.addEventListener('click', function () {
    // Operator approved: ask the host to retry the last call WITH confirmation.
    state = M.dismissApproval(state);
    render();
    if (lastSentText) {
      vscode.postMessage({
        type: 'chatApproveRetry',
        text: lastSentText,
        includeSelection: !!(lastSentOpts && lastSentOpts.includeSelection),
      });
    }
  });

  el.dismiss.addEventListener('click', function () {
    state = M.dismissApproval(state);
    render();
  });

  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.type === 'chatGatewayMode') {
      // Honesty posture from the host (sweep-20 High #4). Anything other than the
      // explicit 'brokered' is treated as the demo/stub posture (fail to honest).
      gatewayMode = msg.mode === 'brokered' ? 'brokered' : 'stub';
      renderMode();
      render();
    } else if (msg.type === 'chatAllowlist') {
      // Guard: an allowlist entry must never carry a credential field.
      var models = Array.isArray(msg.models) ? msg.models : [];
      var clean = models.filter(function (m) {
        return !M.containsCredentialField(m);
      });
      state = M.applyAllowlist(state, clean);
      render();
    } else if (msg.type === 'chatRunId') {
      state = Object.assign({}, state, { runId: msg.runId });
      render();
    } else if (msg.type === 'chatResult') {
      // The redacted model.call result. Scrubbed + folded by the model.
      state = M.applyModelResult(state, msg.result || {});
      render();
    } else if (msg.type === 'chatStatus') {
      state = Object.assign({}, state, { status: String(msg.status || '') });
      render();
    }
  });

  // Render the DEMO posture immediately so the UI never over-claims before the host
  // reports the gateway mode (sweep-20 High #4), then signal ready.
  renderMode();
  vscode.postMessage({ type: 'ready' });
  render();
})();
