/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * GLYPHSPEK FLOATING GOVERNED TERMINAL — the cursor-anchored IContentWidget (⌃⌘K, Option A).
 *
 * A real PTY-backed GOVERNED terminal (input + live output) floating at the editor cursor.
 * The widget is the DOM host + IContentWidget; FloatingTerminalController (this file) drives
 * the governed lifecycle over the ext-host command seam. Modeled on DictationWidget
 * (editorDictation.ts:107-181): allowEditorOverflow, getPosition()→null off-screens it.
 *
 * GOVERNED BY CONSTRUCTION (trust core):
 *  - B1a/AD8: the terminal env is the ext-host startSession env VERBATIM —
 *    config.strictEnv=true + config.env=<that env>, with NO renderer-side merge of
 *    process.env / terminal.integrated.env.*. THIS FILE NEVER READS RENDERER ENV.
 *  - AD3/G1: startSession failure ⇒ honest two-phase error, NO terminal (never ungoverned).
 *  - B2a/H6: created with the FLOATING_GOVERNED_TERMINAL_NAME marker so the ext-host A1
 *    ungoverned-notice is suppressed; also calls registerOwned(runId).
 *  - G7/E18/E19: supervisor-child/proxy death (bridge run-event) OR pty.onExit ⇒ drop the
 *    green badge, show degraded, finalize via stopSession.
 *  - AD5/A9a/G3a: EVERY teardown path (Esc, editor close/move, window unload, throw) issues
 *    idempotent stopSession(runId).
 *  - C0: the content widget is added to the editor (addContentWidget) and DOM-connected
 *    BEFORE attachToElement/setVisible (else _open() throws).
 */

import { Dimension, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import {
	decideAnchorVisibility,
	computeFloatingTerminalDims,
	FLOATING_TERMINAL_DIMS,
	FloatingTerminalController as FloatingTerminalStateMachine,
	type FloatingDimension,
	type FloatingTerminalControllerDeps,
	type GovernedStartResult as PureGovernedStartResult,
	type HostedTerminalLike,
} from './floatingTerminalLogic.js';

/** Default visible rows for the floating terminal (clamped to a usable min for tiny editors). */
const DEFAULT_ROWS = 13;

/**
 * The cursor-anchored content widget hosting the governed terminal. It is PRESENTATION
 * only: the controller owns the session lifecycle. The widget exposes its host element
 * (the terminal canvas mounts there after the widget is DOM-connected — C0), a posture
 * banner + describe-a-command affordance, and the governed shield/green badge (F2).
 */
export class FloatingTerminalWidget extends Disposable implements IContentWidget {

	readonly suppressMouseDown = false;
	readonly allowEditorOverflow = true;

	private readonly domNode = document.createElement('div');
	private readonly terminalHost = document.createElement('div');
	private anchorLine: number;
	private shown = false;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly onDescribeCommand: () => void,
		private readonly onDismiss: () => void,
	) {
		super();

		const selection = this.editor.getSelection();
		this.anchorLine = selection ? selection.getPosition().lineNumber : 1;

		// F2/ACC3 — visibly GOVERNED: the shield + green identity is applied HERE in the
		// constructor (a DOM-building unit asserts the class, not GUI-only). Theme tokens
		// only (no hardcoded hex) — see media/floatingTerminal.css.
		this.domNode.classList.add('glyphspek-floating-terminal', 'governed');
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('glyphspek.floatingTerminal.aria', "GlyphSpek governed terminal"));

		// Header: shield badge + honest posture copy (F3 — never trusted/verified/sandboxed).
		const header = document.createElement('div');
		header.classList.add('glyphspek-floating-terminal-header');
		const shield = document.createElement('span');
		shield.classList.add('glyphspek-floating-terminal-shield', ...ThemeIcon.asClassNameArray(Codicon.shield));
		const posture = document.createElement('span');
		posture.classList.add('glyphspek-floating-terminal-posture');
		posture.textContent = localize('glyphspek.floatingTerminal.posture', "governed-unsandboxed (soft) — egress traced");
		header.appendChild(shield);
		header.appendChild(posture);

		// Describe-a-command affordance (D1, keyboard-reachable — a real button, not mouse-only).
		const describe = document.createElement('button');
		describe.classList.add('glyphspek-floating-terminal-describe');
		describe.textContent = localize('glyphspek.floatingTerminal.describe', "Describe a command");
		describe.setAttribute('aria-label', localize('glyphspek.floatingTerminal.describe.aria', "Describe a command for GlyphSpek to generate, pre-typed into the governed terminal"));
		const onDescribe = () => this.onDescribeCommand();
		describe.addEventListener('click', onDescribe);
		this._register(toDisposable(() => describe.removeEventListener('click', onDescribe)));
		header.appendChild(describe);

		this.terminalHost.classList.add('glyphspek-floating-terminal-host');

		this.domNode.appendChild(header);
		this.domNode.appendChild(this.terminalHost);

		// ACC4/E2 — Esc dismisses; do NOT swallow other keys (no focus trap). Tab/editor
		// chords pass through (xterm's attachCustomKeyEventHandler lets editor chords out).
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this.onDismiss();
			}
		};
		this.domNode.addEventListener('keydown', onKey);
		this._register(toDisposable(() => this.domNode.removeEventListener('keydown', onKey)));
	}

	/** The element the hosted terminal canvas mounts into (after the widget is DOM-connected). */
	get hostElement(): HTMLElement {
		return this.terminalHost;
	}

	/** Update the green/governed badge → degraded (G7): drop the claim of being governed. */
	markDegraded(): void {
		this.domNode.classList.remove('governed');
		this.domNode.classList.add('degraded');
		const posture = this.domNode.querySelector('.glyphspek-floating-terminal-posture');
		if (posture) {
			posture.textContent = localize('glyphspek.floatingTerminal.degraded', "governance lost — session degraded, finalizing");
		}
	}

	getId(): string {
		return 'glyphspek.floatingTerminal';
	}

	getDomNode(): HTMLElement {
		return this.domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		// A3/E21 — no model ⇒ getPosition()→null ⇒ off-screen. The controller already
		// refused before showing, so this is the belt-and-braces of the DictationWidget model.
		if (!this.editor.hasModel()) {
			return null;
		}
		const selection = this.editor.getSelection();
		const position = selection ? selection.getPosition() : this.editor.getPosition();
		if (!position) {
			return null;
		}
		return {
			position,
			preference: [
				ContentWidgetPositionPreference.BELOW,
				ContentWidgetPositionPreference.ABOVE,
				ContentWidgetPositionPreference.EXACT,
			],
		};
	}

	/** C0 — add the widget to the editor BEFORE the terminal is attached. addContentWidget
	 * only REGISTERS the widget; the editor commits it to the DOM on its next render pass,
	 * so force a synchronous render here to push the host element into the document. Any
	 * residual async commit is covered by {@link whenHostConnected} (the controller awaits
	 * it before attaching — else TerminalInstance._open() throws "container ... part of the
	 * DOM"). */
	show(): void {
		if (this.shown) {
			return;
		}
		this.shown = true;
		this.editor.addContentWidget(this);
		this.editor.render(true);
	}

	/**
	 * C0 — resolve once the terminal host element is actually connected to the document.
	 * A freshly-added content widget is committed to the DOM on a render pass that can lag
	 * the synchronous addContentWidget/render call; the governed terminal must NOT attach
	 * before then, because TerminalInstance._open() throws if its container is not in the
	 * DOM (the "failed to attach" path). Bounded: after maxFrames it resolves anyway so a
	 * genuinely un-anchorable host fails honestly downstream (refuse-not-degrade) rather
	 * than hanging.
	 */
	whenHostConnected(maxFrames = 20): Promise<void> {
		if (this.terminalHost.isConnected) {
			return Promise.resolve();
		}
		const targetWindow = getWindow(this.domNode);
		const frame = this._register(new MutableDisposable());
		return new Promise<void>(resolve => {
			let frames = 0;
			const tick = () => {
				if (this.terminalHost.isConnected || frames++ >= maxFrames) {
					frame.clear();
					resolve();
					return;
				}
				frame.value = scheduleAtNextAnimationFrame(targetWindow, tick);
			};
			frame.value = scheduleAtNextAnimationFrame(targetWindow, tick);
		});
	}

	hide(): void {
		if (!this.shown) {
			return;
		}
		this.shown = false;
		this.editor.removeContentWidget(this);
	}

	/** Compute the floating dims from the editor layout + rows (pure C3/E24). */
	computeDims(rows = DEFAULT_ROWS): FloatingDimension {
		const layout = this.editor.getLayoutInfo();
		return computeFloatingTerminalDims({ contentWidth: layout.contentWidth, height: layout.height }, rows, FLOATING_TERMINAL_DIMS);
	}

	/** A7/E8 — should the widget stay (track) or dismiss as the anchor scrolls out (v1 dismiss). */
	shouldDismissOnScroll(): boolean {
		const visible = this.editor.getVisibleRanges().map(r => ({ startLineNumber: r.startLineNumber, endLineNumber: r.endLineNumber }));
		return decideAnchorVisibility(this.anchorLine, visible) === 'dismiss';
	}

	override dispose(): void {
		this.hide();
		super.dispose();
	}
}

/** A brief window so the degraded (governance-lost) badge is actually VISIBLE before the
 * widget tears down — G7 cosmetic fix (without it markDegraded + dispose ran in the same
 * tick and the user never saw "degraded"). Overridable for tests. */
export const DEGRADED_VISIBLE_MS = 1200;

/**
 * Drives the governed floating-terminal lifecycle over the ext-host command seam
 * (glyphspek.governedTerminal.startSession / .stopSession / .registerOwned /
 * onGovernanceLost). One instance per window (the contribution keeps a single live
 * controller).
 *
 * The lifecycle STATE MACHINE is the PURE, injected-deps {@link FloatingTerminalStateMachine}
 * (floatingTerminalLogic.ts) — shared byte-for-byte with the spike + unit-tested in
 * floatingTerminalController.test.ts. THIS class is the thin vscode adapter: it builds the
 * deps from real services (terminalService.createTerminal VERBATIM B1a, the command seam,
 * the widget DOM) and wires the editor lifecycle (scroll/model/dispose) + the ext-host
 * governance-loss signal into the state machine. Refuse-not-degrade, always-finalize,
 * mid-session-death → degraded are all enforced by the state machine; the adapter cannot
 * silently diverge from the tested logic.
 */
export class FloatingTerminalController extends Disposable {

	private readonly sessionDisposables = this._register(new DisposableStore());
	private widget: FloatingTerminalWidget | undefined;
	private terminal: ITerminalInstance | undefined;
	private machine: FloatingTerminalStateMachine | undefined;
	/** runId of the live session, so the contribution can route the ext-host governanceLost(runId). */
	private liveRunId: string | undefined;
	/** Fired by the adapter when the ext-host reports governance loss for our runId (G7/E18). */
	private governanceLostSignal: (() => void) | undefined;
	private degradedTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		@ITerminalService private readonly terminalService: ITerminalService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
	}

	get isLive(): boolean {
		return this.machine?.state === 'live';
	}

	/** The runId of the live session (for the contribution's governanceLost routing), if any. */
	get runId(): string | undefined {
		return this.liveRunId;
	}

	/** A4 — focus the existing floating terminal (re-press ⌃⌘K). */
	focus(): void {
		this.terminal?.focus(true);
	}

	/**
	 * G7/E18 — the contribution calls this when the ext-host invokes
	 * glyphspek.floatingTerminal.governanceLost(runId) for OUR runId. It feeds the pure
	 * state machine's governance-loss path: drop the green badge → (brief degraded show) →
	 * finalize. This is the renderer-unreachable signal the old onExit-only detection
	 * missed — the supervisor child/proxy can die while the shell stays alive.
	 */
	notifyGovernanceLost(): void {
		this.governanceLostSignal?.();
	}

	/**
	 * Open the governed floating terminal. The PURE state machine owns the ORDERING
	 * (refuse-not-degrade, C0 connect-before-attach, register-owned, always-finalize). The
	 * adapter resolves the one ASYNC step (terminalService.createTerminal) UP FRONT so the
	 * state machine's sync createHostedTerminal contract is honored:
	 *   1. startSession (ext-host) — the machine's startSession dep returns the cached result.
	 *   2. on success, createTerminal VERBATIM (B1a) — awaited here; a spawn failure ⇒ the
	 *      machine's createHostedTerminal throws (G3a/G4 finalize).
	 *   3. the machine then connects the widget (C0) → attaches the pre-resolved terminal →
	 *      layout → focus → registerOwned → live.
	 */
	async open(): Promise<void> {
		const widget = new FloatingTerminalWidget(
			this.editor,
			() => void this.describeCommand(),
			() => void this.dispose(),
		);
		this.widget = widget;
		this.sessionDisposables.add(widget);

		// 1. startSession ext-side; the machine's dep returns this cached result.
		const start = await this.commandService.executeCommand<PureGovernedStartResult>('glyphspek.governedTerminal.startSession');
		const startResult: PureGovernedStartResult = start ?? { ok: false, message: 'the governed terminal seam did not respond.' };

		// 2. On a governed start, create the terminal VERBATIM (B1a) NOW so the sync
		//    createHostedTerminal contract holds. A creation failure is captured and re-thrown
		//    inside createHostedTerminal so the machine takes the G3a/G4 finalize path.
		let hosted: HostedTerminalLike | undefined;
		let hostError: unknown;
		if (startResult.ok && startResult.runId && startResult.env) {
			try {
				hosted = await this.hostTerminalVerbatim(widget, startResult);
			} catch (err) {
				hostError = err;
			}
		}

		const deps: FloatingTerminalControllerDeps = {
			startSession: async () => startResult,
			stopSession: (runId: string) =>
				Promise.resolve(this.commandService.executeCommand('glyphspek.governedTerminal.stopSession', runId)),
			registerOwned: (runId: string) => {
				this.liveRunId = runId; // remember so the contribution can route governanceLost(runId).
				void this.commandService.executeCommand('glyphspek.governedTerminal.registerOwned', runId);
			},
			connectWidget: async () => {
				// C0 — register + force-render the widget, then WAIT until the host is truly in
				// the DOM before the machine attaches the terminal (else _open() throws).
				widget.show();
				await widget.whenHostConnected();
			},
			removeWidget: () => {
				const finish = () => {
					if (this.degradedTimer) {
						clearTimeout(this.degradedTimer);
						this.degradedTimer = undefined;
					}
					this.sessionDisposables.clear(); // disposes the widget (removeContentWidget).
					this.widget = undefined;
					this.terminal = undefined;
					this.liveRunId = undefined;
					this.editor.focus(); // E3 — focus returns to the editor.
				};
				// G7 cosmetic — if we just dropped to DEGRADED, keep the badge VISIBLE for a
				// brief window before the chrome is removed, so the operator sees "governance
				// lost". The PTY/child is already disposed by the state machine; only the
				// (now-dead) widget chrome lingers, honestly labeled. Otherwise tear down now.
				const w = this.widget;
				if (this.degradedShown && w) {
					this.degradedTimer = setTimeout(finish, DEGRADED_VISIBLE_MS);
				} else {
					finish();
				}
			},
			createHostedTerminal: () => {
				if (hostError !== undefined || !hosted) {
					throw (hostError instanceof Error ? hostError : new Error(String(hostError ?? 'terminal host failed')));
				}
				return hosted;
			},
			onGovernanceLoss: (listener) => {
				this.governanceLostSignal = listener; // fed by notifyGovernanceLost() (G7/E18).
				return toDisposable(() => { this.governanceLostSignal = undefined; });
			},
			showDegraded: () => this.showDegradedThenTeardown(widget),
			showError: (message: string) => {
				void this.commandService.executeCommand('glyphspek.floatingTerminal.showError', message);
			},
		};

		this.machine = new FloatingTerminalStateMachine(deps, widget.computeDims());
		await this.machine.start();
	}

	/**
	 * B1a/AD8 — create + wire the governed terminal VERBATIM: config.env = the startSession
	 * env, config.strictEnv = true, NO renderer-side merge of process.env /
	 * terminal.integrated.env.*. Returns the sync {@link HostedTerminalLike} adapter the
	 * state machine drives. attachToElement targets the widget host (DOM-connected by C0).
	 * Also installs the resize/scroll/model editor-lifecycle teardown listeners. E2/ACC4 —
	 * attachCustomKeyEventHandler lets Esc/editor chords pass through (no focus trap); C4/E25
	 * — bracketed paste is enabled so a multiline paste does not auto-execute.
	 */
	private async hostTerminalVerbatim(widget: FloatingTerminalWidget, start: PureGovernedStartResult): Promise<HostedTerminalLike> {
		const terminal = await this.terminalService.createTerminal({
			config: {
				name: start.name,
				env: start.env,
				strictEnv: start.strictEnv === true, // carried THROUGH (B1a) — never dropped.
				hideFromUser: true,
				cwd: start.cwd,
				icon: ThemeIcon.fromId(Codicon.shield.id),
			},
			location: TerminalLocation.Panel,
		});
		this.terminal = terminal;

		return {
			attachToElement: () => {
				terminal.attachToElement(widget.hostElement);
				// E2/ACC4 — pass editor chords (incl. Esc) THROUGH so the terminal does not
				// trap focus. Return true ⇒ xterm processes the key; false ⇒ it bubbles to the
				// workbench. Mirrors terminalInstance.ts:1135 but minimal: let the workbench
				// handle Escape (Esc dismisses the widget) and editor chords.
				terminal.xterm?.raw.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
					if (event.type !== 'keydown') {
						return true;
					}
					// Esc → let the workbench dismiss the widget (do not feed xterm).
					if (event.key === 'Escape') {
						return false;
					}
					// Tab and editor/workbench chords (Ctrl/Cmd-modified) bubble out — no trap.
					if (event.key === 'Tab' || ((event.ctrlKey || event.metaKey) && !event.altKey)) {
						return false;
					}
					return true;
				});
				// C4/E25 — bracketed paste: a multiline paste is wrapped in ESC[200~ … ESC[201~
				// so the shell does NOT auto-execute embedded newlines. This is xterm's default
				// (negotiated via DECSET 2004 by the shell) and the panel governed terminal
				// relies on the same default; the fork does NOT disable it. A T-GUI eyeball
				// entry confirms a multiline paste stays staged (does not auto-run) — see the
				// AC E25 GUI checklist; no fork code path turns it off.
			},
			setVisible: (visible: boolean) => terminal.setVisible(visible),
			layout: (dims: FloatingDimension) => {
				terminal.layout(new Dimension(dims.width, dims.height));
				// C3/E13 — resize via an INJECTED ResizeObserver on first layout.
				this.installResizeObserver(widget, terminal);
				// A7/E8 + A8/E5/E22 — editor lifecycle teardown wiring (idempotent: only once).
				this.installEditorLifecycle(widget);
			},
			focus: () => terminal.focus(true),
			dispose: () => terminal.dispose(),
			onExit: (listener) => terminal.onExit(() => listener(undefined)), // E19.
		};
	}

	/** C3/E13 — re-layout on editor/window resize via an injected ResizeObserver (best-effort). */
	private resizeInstalled = false;
	private installResizeObserver(widget: FloatingTerminalWidget, terminal: ITerminalInstance): void {
		if (this.resizeInstalled) {
			return;
		}
		this.resizeInstalled = true;
		const Ctor = (this.editor.getDomNode()?.ownerDocument.defaultView as Window & typeof globalThis | undefined)?.ResizeObserver;
		if (!Ctor) {
			return;
		}
		const ro = new Ctor(() => {
			if (!this.terminal) {
				return;
			}
			const dims = widget.computeDims();
			terminal.layout(new Dimension(dims.width, dims.height));
		});
		ro.observe(this.editor.getDomNode()!);
		this.sessionDisposables.add(toDisposable(() => ro.disconnect()));
	}

	private lifecycleInstalled = false;
	private installEditorLifecycle(widget: FloatingTerminalWidget): void {
		if (this.lifecycleInstalled) {
			return;
		}
		this.lifecycleInstalled = true;
		// A7/E8 — dismiss-on-scroll-out (v1): dismiss when the anchor leaves the viewport.
		this.sessionDisposables.add(this.editor.onDidScrollChange(() => {
			if (widget.shouldDismissOnScroll()) {
				void this.dispose();
			}
		}));
		// A8/E5/E22 — editor model change / dispose ⇒ teardown (no dangling ref).
		this.sessionDisposables.add(this.editor.onDidChangeModel(() => void this.dispose()));
		this.sessionDisposables.add(this.editor.onDidDispose(() => void this.dispose()));
	}

	/**
	 * G7 (cosmetic) — drop the green badge to DEGRADED and keep it VISIBLE for a brief
	 * window before the state machine tears down, so the operator actually SEES the
	 * governance-lost state instead of an instant disappear. markDegraded() flips the badge
	 * synchronously; the state machine's dispose() (which it calls right after showDegraded)
	 * does the teardown — we defer the visible removeWidget via the degradedTimer.
	 */
	private degradedShown = false;
	private showDegradedThenTeardown(widget: FloatingTerminalWidget): void {
		widget.markDegraded();
		this.degradedShown = true;
		// A transient notification reinforces it for screen-reader / glance users.
		void this.commandService.executeCommand('glyphspek.floatingTerminal.showDegradedNotice');
	}

	/**
	 * D1/D2/D3/D4a/D5 — fold-in NL-generate: prompt → ext-host governed gateway → a single
	 * SANITIZED command, PRE-TYPED into THIS floating terminal (never auto-run).
	 */
	async describeCommand(): Promise<void> {
		if (!this.terminal) {
			// D4a — invoked from the palette before a terminal exists: open one first.
			if (this.machine?.state !== 'live') {
				await this.open();
			}
			if (!this.terminal) {
				return; // open refused (AD3/G1) — the state machine already showed the error.
			}
		}
		const instruction = await this.quickInputService.input({
			prompt: localize('glyphspek.floatingTerminal.describePrompt', "Describe the command for GlyphSpek to generate — it will be pre-typed into the governed terminal for you to review, then run."),
			placeHolder: localize('glyphspek.floatingTerminal.describePlaceholder', "e.g. list every file changed since main"),
		});
		if (instruction === undefined || instruction.trim().length === 0) {
			this.terminal.focus(true);
			return; // dismissed / empty — honest no-op (D5).
		}
		const cmd = await this.commandService.executeCommand<string | undefined>('glyphspek.governedTerminal.generateCommand', instruction);
		if (cmd && cmd.length > 0) {
			this.terminal.sendText(cmd, false); // D3 — pre-type, no newline; operator's Enter launches.
		}
		this.terminal.focus(true);
	}

	override dispose(): void {
		// Delegate to the state machine's idempotent teardown (A5/AD5/G6/G6a). It tears down
		// the widget DOM (removeWidget) + the terminal + finalizes via stopSession exactly
		// once. super.dispose() then disposes the registered DisposableStore.
		void this.machine?.dispose();
		super.dispose();
	}
}
