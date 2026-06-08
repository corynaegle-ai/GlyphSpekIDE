/*
 * GlyphCode chat view model — WEBVIEW MIRROR of src/chatViewModel.ts.
 *
 * The webview cannot import the compiled CommonJS module, so this is a 1:1
 * mirror of the pure reducer/derivations. The TypeScript module is the
 * source of truth and is unit-tested; this file must track it exactly. It pins
 * the same UI invariants: surface ONLY allowlisted models, render decision /
 * redacted completion / usage / traceRef, handle deny + force_ask distinctly, and
 * NEVER store or display a credential (the scrubber drops any credential-shaped
 * field). No vscode, no fetch — the webview never touches the network.
 */
(function () {
  'use strict';

  var CHAT_DECISIONS = ['allow', 'deny', 'force_ask', 'ask'];

  var CREDENTIAL_FIELD_RE =
    /^(credential|token|api[_-]?key|apikey|authorization|auth[_-]?header|secret|bearer|access[_-]?token|provider[_-]?token)$/i;

  function emptyChatView(runId) {
    var v = {
      allowedModels: [],
      turns: [],
      pendingApproval: null,
      status: '',
      totals: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    };
    if (runId) v.runId = runId;
    return v;
  }

  function applyAllowlist(view, models) {
    var next = Object.assign({}, view, { allowedModels: models.slice() });
    var stillValid = models.some(function (m) {
      return m.label === view.selectedModel;
    });
    if (stillValid) {
      next.selectedModel = view.selectedModel;
    } else if (models.length > 0) {
      next.selectedModel = models[0].label;
    } else {
      delete next.selectedModel;
      next.status = 'no models are allowlisted by the supervisor — the model picker is empty.';
    }
    return next;
  }

  function selectModel(view, label) {
    var ok = view.allowedModels.some(function (m) {
      return m.label === label;
    });
    if (!ok) {
      return Object.assign({}, view, {
        status: 'model "' + label + '" is not allowlisted — selection refused.',
      });
    }
    return Object.assign({}, view, { selectedModel: label, status: '' });
  }

  function selectedAllowedModel(view) {
    return view.allowedModels.find(function (m) {
      return m.label === view.selectedModel;
    });
  }

  function assembleUserCall(view, text, opts) {
    opts = opts || {};
    var selected = selectedAllowedModel(view);
    if (!view.runId) {
      return { view: Object.assign({}, view, { status: 'no active run — open a governed run first.' }) };
    }
    if (!selected) {
      return {
        view: Object.assign({}, view, { status: 'no allowlisted model is selected — cannot send.' }),
      };
    }
    var userTurn = { role: 'user', content: text };
    var params = {
      runId: view.runId,
      provider: selected.provider,
      model: selected.model,
      messages: [{ role: 'user', content: text }],
      provenanceLabel: opts.provenanceLabel || 'user',
    };
    if (opts.contextSources) params.contextSources = opts.contextSources;
    return {
      view: Object.assign({}, view, { turns: view.turns.concat([userTurn]), status: '' }),
      params: params,
    };
  }

  function normalizeDecision(d) {
    return CHAT_DECISIONS.indexOf(d) >= 0 ? d : 'deny';
  }

  function scrubCredential(result) {
    var cleaned = { decision: result.decision, ok: result.ok };
    if (result.completion !== undefined) cleaned.completion = result.completion;
    if (result.usage !== undefined) cleaned.usage = result.usage;
    if (result.traceEventRef !== undefined) cleaned.traceEventRef = result.traceEventRef;
    if (result.error !== undefined) cleaned.error = result.error;
    return cleaned;
  }

  function containsCredentialField(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.keys(value).some(function (k) {
      return CREDENTIAL_FIELD_RE.test(k);
    });
  }

  function rollTotals(totals, usage) {
    if (!usage) return totals;
    return {
      inputTokens: totals.inputTokens + (usage.inputTokens || 0),
      outputTokens: totals.outputTokens + (usage.outputTokens || 0),
      costMicroUsd: totals.costMicroUsd + (usage.costMicroUsd || 0),
    };
  }

  function applyModelResult(view, rawResult) {
    var result = scrubCredential(rawResult);
    var decision = normalizeDecision(result.decision);
    var next = Object.assign({}, view);

    if (decision === 'allow' && result.ok) {
      var turn = { role: 'assistant', content: result.completion || '', decision: decision };
      if (result.usage) turn.usage = result.usage;
      if (result.traceEventRef) turn.traceEventRef = result.traceEventRef;
      next.turns = view.turns.concat([turn]);
      next.pendingApproval = null;
      next.status = '';
      next.totals = rollTotals(view.totals, result.usage);
      return next;
    }

    if (decision === 'force_ask' || decision === 'ask') {
      var selected = selectedAllowedModel(view);
      next.pendingApproval = {
        provider: (selected && selected.provider) || '(model)',
        model: (selected && selected.model) || '',
        reason: result.error || 'This model call requires confirmation before it proceeds.',
      };
      var blockedTurn = {
        role: 'assistant',
        content: result.error || 'Approval required before this model call proceeds.',
        decision: decision,
        blocked: true,
      };
      if (result.traceEventRef) blockedTurn.traceEventRef = result.traceEventRef;
      next.turns = view.turns.concat([blockedTurn]);
      next.status = 'approval required';
      return next;
    }

    var denyTurn = {
      role: 'assistant',
      content: result.error || 'This model call was blocked by policy.',
      decision: 'deny',
      blocked: true,
    };
    if (result.traceEventRef) denyTurn.traceEventRef = result.traceEventRef;
    next.turns = view.turns.concat([denyTurn]);
    next.pendingApproval = null;
    next.status = result.error || 'blocked';
    return next;
  }

  function dismissApproval(view) {
    return Object.assign({}, view, { pendingApproval: null, status: '' });
  }

  function formatCostMicroUsd(costMicroUsd) {
    return '$' + (costMicroUsd / 1000000).toFixed(6);
  }

  window.GlyphCodeChatModel = {
    emptyChatView: emptyChatView,
    applyAllowlist: applyAllowlist,
    selectModel: selectModel,
    selectedAllowedModel: selectedAllowedModel,
    assembleUserCall: assembleUserCall,
    normalizeDecision: normalizeDecision,
    scrubCredential: scrubCredential,
    containsCredentialField: containsCredentialField,
    applyModelResult: applyModelResult,
    dismissApproval: dismissApproval,
    formatCostMicroUsd: formatCostMicroUsd,
  };
})();
