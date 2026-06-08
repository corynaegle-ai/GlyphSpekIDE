/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * GLYPHCODE FLOATING GOVERNED TERMINAL — PURE logic (no vscode-editor / no DOM imports).
 *
 * The ⌃⌘K floating-terminal decision logic, factored OUT of the GUI so every branch is
 * unit-testable headlessly (AC rule: "No GUI-only proof where logic can be factored
 * pure"; fork rule: "make deps injectable"). This is the byte-for-byte mirror of
 * spikes/p0-floating-terminal/floating-terminal-logic.ts (the extension build cannot
 * import the spikes tree, and the fork cannot import either — the same secret-firewall /
 * RPC shapes are mirrored across the three packages by the project's convention). Keep in
 * lock-step with the spike, which is the authoritative source + has the headless suite.
 *
 * Covers: A3 decideWhereToAnchor (3-branch), A7 decideAnchorVisibility (dismiss-on-scroll),
 * C3/E24 computeFloatingTerminalDims (+min-clamp). The fork unit test
 * (floatingTerminalLogic.test.ts under src/vs/workbench/contrib/glyphcodeHome/test/browser)
 * re-asserts these in the fork's test harness.
 */

/** A minimal structural view of the editor needed to decide an anchor (vscode-free). */
export interface AnchorEditorView {
	hasActiveEditor: boolean;
	hasModel: boolean;
	position?: { lineNumber: number; column: number };
}

export type AnchorDecision =
	| { kind: 'anchor'; position: { lineNumber: number; column: number } }
	| { kind: 'refuse'; reason: 'no-editor' | 'no-model' };

/** Honest message shown for BOTH refuse branches (A3) — never a mis-anchored widget. */
export const NO_ANCHOR_MESSAGE = 'Open a file to use the floating governed terminal.';

/** A3/E1/E21 (PURE). no editor → refuse(no-editor); editor w/o model → refuse(no-model); else anchor. */
export function decideWhereToAnchor(editor: AnchorEditorView): AnchorDecision {
	if (!editor.hasActiveEditor) {
		return { kind: 'refuse', reason: 'no-editor' };
	}
	if (!editor.hasModel || !editor.position) {
		return { kind: 'refuse', reason: 'no-model' };
	}
	return { kind: 'anchor', position: editor.position };
}

/** A visible line range (inclusive). */
export interface VisibleLineRange {
	startLineNumber: number;
	endLineNumber: number;
}

export type AnchorVisibility = 'track' | 'dismiss';

/** A7/E8 (PURE, locked = dismiss). Anchor in a visible range → track; else dismiss (v1). */
export function decideAnchorVisibility(
	anchorLine: number,
	visibleRanges: readonly VisibleLineRange[],
): AnchorVisibility {
	for (const r of visibleRanges) {
		if (anchorLine >= r.startLineNumber && anchorLine <= r.endLineNumber) {
			return 'track';
		}
	}
	return 'dismiss';
}

export interface FloatingLayoutInfo {
	contentWidth: number;
	height: number;
}

export interface FloatingDimension {
	width: number;
	height: number;
}

/** Dims tuning: ~12–15 rows at a comfortable width, with a usable MINIMUM (E24). */
export const FLOATING_TERMINAL_DIMS = {
	widthFraction: 0.6,
	rowHeightPx: 18,
	chromePx: 64,
	minWidthPx: 320,
	minHeightPx: 160,
} as const;

/** C3/E24 (PURE). Pixel dims from the editor layout + rows, clamped to a usable minimum. */
export function computeFloatingTerminalDims(
	layout: FloatingLayoutInfo,
	rows: number,
	tuning: typeof FLOATING_TERMINAL_DIMS = FLOATING_TERMINAL_DIMS,
): FloatingDimension {
	const desiredWidth = Math.floor(layout.contentWidth * tuning.widthFraction);
	const cappedWidth = Math.min(desiredWidth, Math.max(layout.contentWidth, tuning.minWidthPx));
	const width = Math.max(cappedWidth, tuning.minWidthPx);

	const desiredHeight = rows * tuning.rowHeightPx + tuning.chromePx;
	const cappedHeight = Math.min(desiredHeight, Math.max(layout.height, tuning.minHeightPx));
	const height = Math.max(cappedHeight, tuning.minHeightPx);

	return { width, height };
}

/**
 * C6 (PURE) — clamp a USER-resized dimension to [min, editor-bounded max] on each axis. The
 * grip can never shrink the box below a usable minimum nor grow it past the editor content
 * area. Never throws.
 */
export function clampFloatingDims(
	desired: FloatingDimension,
	max: FloatingDimension,
	tuning: typeof FLOATING_TERMINAL_DIMS = FLOATING_TERMINAL_DIMS,
): FloatingDimension {
	const width = Math.max(tuning.minWidthPx, Math.min(desired.width, Math.max(max.width, tuning.minWidthPx)));
	const height = Math.max(tuning.minHeightPx, Math.min(desired.height, Math.max(max.height, tuning.minHeightPx)));
	return { width, height };
}

/** A rectangle in px (a dragged box, or the bounds it must stay within). */
export interface FloatingRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Inputs to {@link clampDragOffset}. */
export interface DragClampInput {
	/** The proposed user offset (px) from the editor-placed base position. */
	proposed: { x: number; y: number };
	/** The widget's editor-placed base rect, BEFORE the user offset is applied. */
	base: FloatingRect;
	/** The bounds the widget must remain within (e.g. the editor content area). */
	bounds: FloatingRect;
}

/**
 * C5 (PURE) — clamp a drag offset so the dragged widget stays fully within `bounds`. Returns
 * the adjusted offset (relative to base); if the widget is larger than the bounds on an axis
 * it pins to the bounds' start on that axis. Never throws.
 */
export function clampDragOffset(input: DragClampInput): { x: number; y: number } {
	const { proposed, base, bounds } = input;
	const minLeft = bounds.left;
	const maxLeft = bounds.left + Math.max(0, bounds.width - base.width);
	const minTop = bounds.top;
	const maxTop = bounds.top + Math.max(0, bounds.height - base.height);
	const clampedLeft = Math.min(Math.max(base.left + proposed.x, minLeft), maxLeft);
	const clampedTop = Math.min(Math.max(base.top + proposed.y, minTop), maxTop);
	return { x: clampedLeft - base.left, y: clampedTop - base.top };
}

/* ---------------------------------------------------------------- *
 * D2 / D3 / D5 / E9 — NL-generate sanitize (reused for the fold-in)
 * ---------------------------------------------------------------- */

/** The result of sanitizing an NL→command gateway reply for PRE-TYPING (never auto-run). */
export type NlGenerateResult =
	| { kind: 'command'; command: string }
	| { kind: 'note'; note: string };

/** Honest note shown for an empty / unparseable / gateway-error NL reply (D5/E9). */
export const NL_GENERATE_EMPTY_NOTE = 'No command was generated — try rephrasing what you want to do.';

/**
 * D2/D3/D5/E9 (PURE). Sanitize a model gateway reply into a SINGLE command to PRE-TYPE
 * (the operator's Enter launches it; we NEVER auto-run). Mirrors the existing
 * terminalCommandGen sanitize contract; never throws.
 */
export function sanitizeGeneratedCommand(raw: string | null | undefined): NlGenerateResult {
	if (raw === null || raw === undefined) {
		return { kind: 'note', note: NL_GENERATE_EMPTY_NOTE };
	}
	const lines = raw.replace(/```[a-zA-Z]*/g, '').split(/\r?\n/);
	for (let line of lines) {
		line = line.trim();
		if (line.length === 0) {
			continue;
		}
		line = line.replace(/^\$\s+/, '').replace(/^#\s+/, '').trim();
		if (line.length === 0) {
			continue;
		}
		return { kind: 'command', command: line };
	}
	return { kind: 'note', note: NL_GENERATE_EMPTY_NOTE };
}

/* ---------------------------------------------------------------- *
 * T-SESSION — the controller STATE MACHINE (injected deps)
 *
 * Byte-for-byte mirror of the authoritative spike controller
 * (spikes/p0-floating-terminal/floating-terminal-logic.ts). The fork's vscode-facing
 * FloatingTerminalController (floatingTerminalWidget.ts) builds the deps from real
 * services + the ext-host command seam (start/stop/registerOwned/onGovernanceLoss/...)
 * and DELEGATES to this pure state machine, so the fork and spike can no longer silently
 * diverge: floatingTerminalController.test.ts re-runs the spike's T-SESSION suite against
 * THIS class.
 * ---------------------------------------------------------------- */

/** The governed env contract the ext-host startSession seam returns to the fork. */
export interface GovernedStartResult {
	ok: boolean;
	runId?: string;
	env?: Record<string, string>;
	strictEnv?: boolean;
	proxyUrl?: string;
	cwd?: string;
	name?: string;
	envMarker?: string;
	message: string;
}

/** A minimal structural view of a hosted terminal instance (vscode-free, injectable). */
export interface HostedTerminalLike {
	/** Re-parent the PTY-backed DOM into our container. MUST run after the container is DOM-connected (C0). */
	attachToElement(container: unknown): void;
	setVisible(visible: boolean): void;
	layout(dims: FloatingDimension): void;
	focus(): void;
	dispose(): void;
	/** Fired when the PTY self-exits (E19) — drives a teardown + finalize. */
	onExit(listener: (code: number | undefined) => void): { dispose(): void };
}

/** Injected dependencies for the controller (all stubbable in T-SESSION). */
export interface FloatingTerminalControllerDeps {
	/** ext-host seam: start the governed session (refuse-not-degrade on !ok). */
	startSession(): Promise<GovernedStartResult>;
	/** ext-host seam: finalize the run (idempotent, runId-scoped). */
	stopSession(runId: string): Promise<unknown>;
	/** ext-host seam: register the run as governed-owned (B2a). */
	registerOwned(runId: string): void;
	/** Create + host the terminal AFTER the container is DOM-connected (C0); sets strictEnv+env VERBATIM (B1a). */
	createHostedTerminal(start: GovernedStartResult): HostedTerminalLike;
	/** Add the content widget to the editor and WAIT until its host is DOM-connected — MUST
	 * complete before attach (C0); may be async because the editor commits a freshly-added
	 * content widget to the DOM on a render pass. */
	connectWidget(): void | Promise<void>;
	/** Remove the content widget + tear down DOM/listeners (always runs on dispose). */
	removeWidget(): void;
	/** Subscribe to the ext-host mid-session governance-loss signal (supervisor child/proxy death → G7/E18). */
	onGovernanceLoss(listener: () => void): { dispose(): void };
	/** Surface the degraded/dead-governance state in the widget (drop green) — G7. */
	showDegraded(): void;
	/** Show an honest refusal (no terminal) — AD3/G1/G4. */
	showError(message: string): void;
}

/** Observable controller state (for assertions + the badge/posture rendering). */
export type FloatingTerminalState =
	| 'idle'
	| 'starting'
	| 'live'
	| 'degraded'
	| 'disposed'
	| 'refused';

/**
 * T-SESSION — the floating terminal controller state machine, with EVERY external
 * dependency injected so it is unit-testable headlessly. Always-finalize (AD5/A9a/G3a):
 * once a runId is minted, EVERY teardown path issues stopSession(runId) exactly once.
 */
export class FloatingTerminalController {
	private _state: FloatingTerminalState = 'idle';
	private runId: string | undefined;
	private terminal: HostedTerminalLike | undefined;
	private exitSub: { dispose(): void } | undefined;
	private lossSub: { dispose(): void } | undefined;
	private cancelled = false;
	private stopIssued = false;

	constructor(
		private readonly deps: FloatingTerminalControllerDeps,
		private readonly dims: FloatingDimension,
	) { }

	get state(): FloatingTerminalState {
		return this._state;
	}

	/** Cancel an in-flight start (G3): if a runId was already minted, still finalize it. */
	cancel(): void {
		this.cancelled = true;
		if (this._state === 'starting') {
			void this.dispose();
		}
	}

	/** Drive start → live, or refuse. Resolves to the final state. */
	async start(): Promise<FloatingTerminalState> {
		if (this._state !== 'idle') {
			return this._state; // A4: already open/starting — caller focuses the existing one.
		}
		this._state = 'starting';
		let start: GovernedStartResult;
		try {
			start = await this.deps.startSession();
		} catch (err) {
			this._state = 'refused';
			this.deps.showError(`Could not start the governed terminal: ${String((err as Error)?.message ?? err)}`);
			return this._state;
		}

		if (!start.ok || !start.runId || !start.env) {
			this._state = 'refused';
			this.deps.showError(start.message || 'The governed terminal could not be established.');
			return this._state;
		}

		this.runId = start.runId; // a runId is minted: from here EVERY teardown finalizes (AD5/G3a).

		if (this.cancelled) {
			await this.dispose();
			return this._state;
		}

		try {
			await this.deps.connectWidget(); // C0: DOM-connect (await render-pass commit) BEFORE attach.
			const terminal = this.deps.createHostedTerminal(start);
			this.terminal = terminal;
			terminal.attachToElement(undefined);
			terminal.setVisible(true);
			terminal.layout(this.dims);
			terminal.focus();

			this.deps.registerOwned(start.runId); // B2a.

			this.lossSub = this.deps.onGovernanceLoss(() => this.onGovernanceLost()); // G7/E18.
			this.exitSub = terminal.onExit(() => this.onPtyExit()); // E19.

			this._state = 'live';
			return this._state;
		} catch (err) {
			this.deps.showError(`The governed terminal failed to attach: ${String((err as Error)?.message ?? err)}`);
			await this.dispose(); // G3a/G4: throw after runId mint ⇒ finalize, no orphan.
			this._state = 'refused';
			return this._state;
		}
	}

	/** G7/E18 — the supervisor child exited / proxy died while live. */
	private onGovernanceLost(): void {
		if (this._state !== 'live') {
			return;
		}
		this._state = 'degraded';
		this.deps.showDegraded(); // drop the green/governed badge — never keep claiming governed.
		void this.dispose();       // finalize via stopSession (verdict shown degraded).
	}

	/** E19 — the PTY self-exited (e.g. `exit`) while the widget is open. */
	private onPtyExit(): void {
		if (this._state === 'disposed') {
			return;
		}
		void this.dispose();
	}

	/** A5/AD5/G6/G6a — idempotent teardown. */
	async dispose(): Promise<void> {
		if (this._state === 'disposed') {
			return; // G6a idempotent
		}
		const wasLive = this._state === 'live' || this._state === 'starting' || this._state === 'degraded';
		this._state = 'disposed';
		try {
			this.exitSub?.dispose();
			this.lossSub?.dispose();
			this.terminal?.dispose(); // kills PTY/child (G5)
			this.deps.removeWidget();
		} finally {
			if (this.runId && !this.stopIssued && wasLive) {
				this.stopIssued = true;
				try {
					await this.deps.stopSession(this.runId);
				} catch {
					/* G6: stopSession throwing must not wedge the (already torn-down) widget */
				}
			}
		}
	}
}
