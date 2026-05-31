"use strict";
/*
 * GlyphSpek GOVERNED-RUNS MODEL — the backing store for the activity-bar
 * "Governed Runs" tree (governedRunsTree.ts).
 *
 * This is a thin, PURE projection (no vscode, no node, no DOM) of the SAME
 * `run/event` stream the Trust Panel renders. Every run source in extension.ts
 * (the live bridge run, the governed terminal, the mock demo feed) already calls
 * panel.postRunEvent(raw); this model is fed the identical raw envelopes so the
 * sidebar lists exactly the runs the extension actually knows about — no invented
 * placeholder rows.
 *
 * It deliberately keeps only the SUMMARY a tree row needs (actor, creation-trust
 * posture, lifecycle status, closed/active). It does NOT re-run the full
 * liveRunModel reducer or judge trust — that lives in liveRunModel.ts / the
 * webview crypto gate. The tree is a NAVIGATION surface: click a row → focus the
 * Trust Panel on that run, where the full evidence + signature gate live.
 *
 * Pure + dependency-free so it is unit-tested headlessly and the host wiring stays
 * a one-liner (model.ingest(raw) alongside panel.postRunEvent(raw)).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GovernedRunsModel = void 0;
const runEventProtocol_1 = require("./runEventProtocol");
/**
 * In-memory registry of the governed runs the extension has observed this session.
 * Fed the raw `run/event` envelopes (validate-then-fold), it exposes a stable,
 * newest-first list and a change signal the tree subscribes to.
 */
class GovernedRunsModel {
    constructor() {
        this.runs = new Map();
        this.listeners = new Set();
        this.nextOrder = 0;
    }
    /**
     * Ingest ONE raw run-event envelope (the same value passed to
     * panel.postRunEvent). Malformed/foreign-schema envelopes are ignored (the
     * panel surfaces those distinctly; the list simply does not invent a row). A
     * change to the run set fires the listeners exactly once per applied event.
     */
    ingest(raw) {
        const validation = (0, runEventProtocol_1.validateRunEvent)(raw);
        if (!validation.ok)
            return; // not a current/known event — don't fabricate a row
        const changed = this.apply(validation.event);
        if (changed)
            this.emitChange();
    }
    /** Fold one validated event into the summary set; returns whether anything changed. */
    apply(event) {
        const runId = event.runId;
        if (!runId)
            return false;
        const existing = this.runs.get(runId);
        const summary = existing ?? {
            runId,
            actorType: 'unknown',
            creationTrust: 'unknown',
            status: 'created',
            closed: false,
            order: this.nextOrder++,
        };
        let changed = !existing;
        switch (event.kind) {
            case runEventProtocol_1.RunEventKind.RunOpened: {
                const o = event;
                changed = this.set(summary, 'actorType', o.actorType) || changed;
                changed = this.set(summary, 'creationTrust', o.trust) || changed;
                changed = this.set(summary, 'status', o.state ?? 'created') || changed;
                break;
            }
            case runEventProtocol_1.RunEventKind.StateChanged:
                changed = this.set(summary, 'status', event.to) || changed;
                break;
            case runEventProtocol_1.RunEventKind.TraceEvent:
                // Keep status fresh from an embedded run_state_changed, mirroring the reducer.
                if (event.event.type === 'run_state_changed') {
                    const p = event.event.payload;
                    if (p && typeof p.to === 'string') {
                        changed = this.set(summary, 'status', p.to) || changed;
                    }
                }
                break;
            case runEventProtocol_1.RunEventKind.RunClosed:
                changed = this.set(summary, 'status', event.finalState) || changed;
                changed = this.set(summary, 'closed', true) || changed;
                break;
            case runEventProtocol_1.RunEventKind.Failure: {
                // A BRIDGE-MISMATCH failure DE-AUTHORITATES the run in BOTH surfaces
                // (sweep-25 #2). The host synthesizes this current-rev failure when it
                // refuses a foreign/future-rev envelope (extension.ts postRunEvent) and
                // routes it here too, so the sidebar is not EMPTY while the Trust Panel
                // shows a bridge_mismatch card. We surface it as a 'refused' creation
                // posture (the run could not be admitted under a known schema) and mark the
                // row's status so the operator sees WHY in the list. Other failure kinds
                // (tamper, stale, etc.) are surfaced in the Trust Panel, not the row summary.
                const f = event;
                if (f.failure === runEventProtocol_1.RunFailureKind.BridgeMismatch) {
                    changed = this.set(summary, 'creationTrust', 'refused') || changed;
                    changed = this.set(summary, 'status', 'bridge_mismatch') || changed;
                }
                break;
            }
            default:
                // ActorClaims / VerifierVerdict don't change the row SUMMARY (actor/posture/
                // status); they're surfaced in the Trust Panel, not the list.
                break;
        }
        this.runs.set(runId, summary);
        return changed;
    }
    /** Assign a field if it differs; returns whether it changed (for dirty tracking). */
    set(summary, key, value) {
        if (summary[key] === value)
            return false;
        summary[key] = value;
        return true;
    }
    /** The known runs, NEWEST FIRST (most recently created at the top of the tree). */
    list() {
        return Array.from(this.runs.values()).sort((a, b) => b.order - a.order);
    }
    /** Look up one run summary by id (the tree row → Trust Panel focus path). */
    get(runId) {
        return this.runs.get(runId);
    }
    /** True when no run has been observed yet (drives the viewsWelcome empty state). */
    isEmpty() {
        return this.runs.size === 0;
    }
    /** Subscribe to run-set changes; returns an unsubscribe disposer. */
    onDidChange(listener) {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    }
    emitChange() {
        for (const listener of this.listeners)
            listener();
    }
}
exports.GovernedRunsModel = GovernedRunsModel;
//# sourceMappingURL=governedRunsModel.js.map