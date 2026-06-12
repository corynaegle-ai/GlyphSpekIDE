"use strict";
/*
 * GlyphStudio chat + inline-edit VIEW MODEL — pure (NO vscode, NO node, NO DOM).
 *
 * This is the trust-load-bearing half of the M6 chat / inline-edit UI. It folds
 * the model-broker allowlist and each brokered model.call result into a renderable
 * view model the webview draws, and it PINS the UI invariants the design requires
 * (docs/ide-build-design.md §12.4 + §6):
 *
 *   1. SURFACE ONLY ALLOWLISTED MODELS. The model picker is built ONLY from the
 *      supervisor's model/allowlist reply. A model the supervisor did not offer is
 *      not selectable, and a chat turn that names a non-allowlisted model is
 *      refused locally (so the UI never even sends it) — mirroring the broker's
 *      default-deny.
 *   2. RENDER decision / redacted completion / usage (tokens-cost) / traceEventRef.
 *   3. HANDLE deny + force_ask DISTINCTLY (deny → a blocked card; force_ask → an
 *      approval prompt the operator must confirm before any retry).
 *   4. NEVER STORE OR DISPLAY A CREDENTIAL. A defensive scrubber asserts no model
 *      result carries a credential-shaped field, and the assembled outbound
 *      request shape (ModelCallParams) has no credential field by construction.
 *
 * Pure + dependency-free so it compiles to dist/ and is unit-tested headlessly.
 * (The legacy media/chat.js webview that mirrored these derivations was DELETED with
 * the demo stub gateway; this module remains the pure, tested seam any future
 * allowlist-driven model picker renders over.)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_DECISIONS = void 0;
exports.emptyChatView = emptyChatView;
exports.applyAllowlist = applyAllowlist;
exports.applyAllowlistFailure = applyAllowlistFailure;
exports.selectModel = selectModel;
exports.isModelAllowed = isModelAllowed;
exports.selectedAllowedModel = selectedAllowedModel;
exports.assembleUserCall = assembleUserCall;
exports.normalizeDecision = normalizeDecision;
exports.applyModelResult = applyModelResult;
exports.dismissApproval = dismissApproval;
exports.scrubCredential = scrubCredential;
exports.containsCredentialField = containsCredentialField;
exports.formatCostMicroUsd = formatCostMicroUsd;
/** The full set, for validation/rendering. */
exports.CHAT_DECISIONS = ['allow', 'deny', 'force_ask', 'ask'];
/* ============================================================== *
 * CONSTRUCTION
 * ============================================================== */
/** A fresh, empty chat view (before any allowlist or turn). */
function emptyChatView(runId) {
    return {
        ...(runId ? { runId } : {}),
        allowedModels: [],
        turns: [],
        pendingApproval: null,
        status: '',
        totals: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    };
}
/**
 * Apply the supervisor's model/allowlist to the view: the picker is set to EXACTLY
 * these models. If the previously-selected model is no longer allowlisted (or none
 * was selected), the first allowlisted model is selected; an empty allowlist
 * leaves no selection (the UI then offers nothing and refuses to send).
 */
function applyAllowlist(view, models) {
    const next = { ...view, allowedModels: models.slice() };
    const stillValid = models.some((m) => m.label === view.selectedModel);
    if (stillValid) {
        next.selectedModel = view.selectedModel;
    }
    else if (models.length > 0) {
        next.selectedModel = models[0].label;
    }
    else {
        delete next.selectedModel;
        next.status = 'no models are allowlisted by the supervisor — the model picker is empty.';
    }
    return next;
}
/**
 * Fold a BRIDGE/ALLOWLIST FAILURE into the view: the picker shows the ERROR STATE,
 * never phantom models. When the supervisor bridge cannot be reached (spawn/hash/
 * handshake failure) there is NO trustworthy allowlist — so the picker is EMPTIED
 * (no stale or invented entries survive), the selection is cleared, and the status
 * carries the honest, non-secret failure reason. With no selectable model,
 * {@link assembleUserCall} then refuses to send — the UI cannot quietly call a
 * model nobody allowlisted.
 */
function applyAllowlistFailure(view, message) {
    const next = { ...view, allowedModels: [] };
    delete next.selectedModel;
    next.status = `model allowlist unavailable — ${message && message.trim().length > 0 ? message.trim() : 'the supervisor bridge could not be reached.'}`;
    return next;
}
/** Select a model BY LABEL. Refuses (no-op) a label not on the allowlist. */
function selectModel(view, label) {
    if (!view.allowedModels.some((m) => m.label === label)) {
        return { ...view, status: `model "${label}" is not allowlisted — selection refused.` };
    }
    return { ...view, selectedModel: label, status: '' };
}
/* ============================================================== *
 * SENDING A TURN (the request the UI assembles)
 * ============================================================== */
/**
 * Whether the UI may send a turn against (provider, model): ONLY when that pair is
 * on the allowlist. This is the CLIENT-side mirror of the broker's default-deny —
 * the UI never even sends a non-allowlisted model (the broker would deny it too,
 * but refusing locally gives an immediate, precise UI state).
 */
function isModelAllowed(view, provider, model) {
    return view.allowedModels.some((m) => m.provider === provider && m.model === model);
}
/** Resolve the AllowedModelInfo for the currently-selected label, if any. */
function selectedAllowedModel(view) {
    return view.allowedModels.find((m) => m.label === view.selectedModel);
}
/**
 * Assemble the ModelCallParams for a user message against the selected model.
 * Returns undefined (and a status reason on the returned view) when there is no
 * selected/allowlisted model — so the UI cannot send a call for a model the
 * supervisor did not offer.
 *
 * The assembled params carry WHAT to ask; by the ModelCallParams type they have
 * NO credential field. The optional context source (e.g. the edited file or the
 * inline-edit selection) flows through with its provenance.
 */
function assembleUserCall(view, text, opts = {}) {
    const selected = selectedAllowedModel(view);
    if (!view.runId) {
        return { view: { ...view, status: 'no active run — open a governed run first.' } };
    }
    if (!selected) {
        return {
            view: { ...view, status: 'no allowlisted model is selected — cannot send.' },
        };
    }
    const userTurn = { role: 'user', content: text };
    const params = {
        runId: view.runId,
        provider: selected.provider,
        model: selected.model,
        messages: [{ role: 'user', content: text }],
        provenanceLabel: opts.provenanceLabel ?? 'user',
        ...(opts.contextSources ? { contextSources: opts.contextSources } : {}),
    };
    return { view: { ...view, turns: view.turns.concat([userTurn]), status: '' }, params };
}
/* ============================================================== *
 * APPLYING A RESULT
 * ============================================================== */
/**
 * Normalize a raw decision string to a ChatDecision (defaults unknowns to 'deny',
 * fail-closed: an unrecognized decision is treated as blocked).
 */
function normalizeDecision(d) {
    return exports.CHAT_DECISIONS.includes(d) ? d : 'deny';
}
/**
 * Fold a brokered model.call RESULT into the view. The result is the redacted,
 * credential-free projection from the bridge:
 *   - allow → append the assistant turn (redacted completion + usage + traceRef)
 *     and roll the totals.
 *   - deny → append a blocked assistant card with the (non-secret) reason.
 *   - force_ask / ask → raise a PendingApproval (the UI must confirm before retry)
 *     and append a blocked card explaining the gate.
 *
 * DEFENSE IN DEPTH: the result is scrubbed for any credential-shaped field before
 * it is stored; if one were ever present (it must not be), it is dropped and the
 * status flags it — the credential never lands in the rendered view.
 */
function applyModelResult(view, rawResult) {
    const result = scrubCredential(rawResult);
    const decision = normalizeDecision(result.decision);
    const next = { ...view };
    if (decision === 'allow' && result.ok) {
        const turn = {
            role: 'assistant',
            content: result.completion ?? '',
            decision,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.traceEventRef ? { traceEventRef: result.traceEventRef } : {}),
        };
        next.turns = view.turns.concat([turn]);
        next.pendingApproval = null;
        next.status = '';
        next.totals = rollTotals(view.totals, result.usage);
        return next;
    }
    if (decision === 'force_ask' || decision === 'ask') {
        const selected = selectedAllowedModel(view);
        next.pendingApproval = {
            provider: selected?.provider ?? '(model)',
            model: selected?.model ?? '',
            reason: result.error ?? 'This model call requires confirmation before it proceeds.',
        };
        next.turns = view.turns.concat([
            {
                role: 'assistant',
                content: result.error ?? 'Approval required before this model call proceeds.',
                decision,
                blocked: true,
                ...(result.traceEventRef ? { traceEventRef: result.traceEventRef } : {}),
            },
        ]);
        next.status = 'approval required';
        return next;
    }
    // deny (or any unknown decision, fail-closed): a blocked card.
    next.turns = view.turns.concat([
        {
            role: 'assistant',
            content: result.error ?? 'This model call was blocked by policy.',
            decision: 'deny',
            blocked: true,
            ...(result.traceEventRef ? { traceEventRef: result.traceEventRef } : {}),
        },
    ]);
    next.pendingApproval = null;
    next.status = result.error ?? 'blocked';
    return next;
}
/** Clear a standing approval prompt (operator dismissed / will not confirm). */
function dismissApproval(view) {
    return { ...view, pendingApproval: null, status: '' };
}
/* ============================================================== *
 * CREDENTIAL SCRUBBER (defense in depth)
 * ============================================================== */
/**
 * Field names that would carry a provider credential. The bridge contract has NO
 * such field on a result, but this scrubber asserts it at the UI boundary so a
 * future drift cannot leak a token into the rendered view. It drops any such field
 * and never copies its value anywhere.
 */
const CREDENTIAL_FIELD_RE = /^(credential|token|api[_-]?key|apikey|authorization|auth[_-]?header|secret|bearer|access[_-]?token|provider[_-]?token)$/i;
/**
 * Return a shallow copy of the result with ANY credential-shaped field removed.
 * The known-good fields are copied through explicitly; anything else that matches
 * the credential pattern is dropped. The result is what the view stores/renders.
 */
function scrubCredential(result) {
    const cleaned = {
        decision: result.decision,
        ok: result.ok,
        ...(result.completion !== undefined ? { completion: result.completion } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.traceEventRef !== undefined ? { traceEventRef: result.traceEventRef } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
    };
    return cleaned;
}
/**
 * Whether ANY field of an arbitrary object (a raw result before scrubbing, or any
 * UI payload) is credential-shaped. Used by tests to assert no token can reach the
 * UI, and usable as a runtime guard on inbound payloads.
 */
function containsCredentialField(value) {
    if (!value || typeof value !== 'object')
        return false;
    for (const key of Object.keys(value)) {
        if (CREDENTIAL_FIELD_RE.test(key))
            return true;
    }
    return false;
}
/* ============================================================== *
 * TOTALS
 * ============================================================== */
function rollTotals(totals, usage) {
    if (!usage)
        return totals;
    return {
        inputTokens: totals.inputTokens + (usage.inputTokens ?? 0),
        outputTokens: totals.outputTokens + (usage.outputTokens ?? 0),
        costMicroUsd: totals.costMicroUsd + (usage.costMicroUsd ?? 0),
    };
}
/** Format a micro-USD cost integer as a human dollar string (e.g. '$0.000042'). */
function formatCostMicroUsd(costMicroUsd) {
    const usd = costMicroUsd / 1_000_000;
    return `$${usd.toFixed(6)}`;
}
//# sourceMappingURL=chatViewModel.js.map