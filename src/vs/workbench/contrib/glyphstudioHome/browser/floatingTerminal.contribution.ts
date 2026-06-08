/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * GLYPHSTUDIO FLOATING GOVERNED TERMINAL — the ⌃⌘K workbench action + per-window single-
 * instance manager (Option A).
 *
 * ⌃⌘K = KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyK (verified free in the fork; the
 * extension package.json no longer binds ctrl+cmd+k — D4a/H3a). NOT a shadow of
 * deleteAllRight's mac ⌃K, which is KeyMod.WinCtrl | KeyCode.KeyK (no CtrlCmd) — a
 * DIFFERENT chord (H4a). A3/E1/E21: refuse (honest message, no terminal) when there is no
 * active code editor or it has no model.
 *
 * SINGLE INSTANCE PER WINDOW (A4/A4a): the manager holds at most ONE live controller; a
 * re-press focuses it. stopSession is runId-scoped ext-side so a second window can never
 * finalize this window's run. A9a: on window unload the live controller is disposed
 * (best-effort stopSession before teardown).
 */

import { localize, localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution, getWorkbenchContribution } from '../../../common/contributions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { FloatingTerminalController } from './floatingTerminalWidget.js';
import { decideWhereToAnchor, NO_ANCHOR_MESSAGE } from './floatingTerminalLogic.js';

const OPEN_FLOATING_TERMINAL_COMMAND_ID = 'glyphstudio.openFloatingGovernedTerminal';

/**
 * Per-window manager: one live floating-terminal controller at a time (A4/A4a). It owns
 * the open gesture (refuse-or-anchor), re-press focusing, and unload teardown (A9a).
 */
class FloatingTerminalManager extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.glyphstudioFloatingTerminal';

	// MutableDisposable so each new controller disposes the previous one (no leak across
	// repeated opens — the manager holds at most ONE live controller, A4/A4a).
	private readonly controllerDisposable = this._register(new MutableDisposable<FloatingTerminalController>());
	private get controller(): FloatingTerminalController | undefined {
		return this.controllerDisposable.value;
	}

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		// AD3/G1 — the honest-error helper the controller calls when startSession refuses
		// (no governed env ⇒ no terminal). The controller calls the ext-host
		// glyphstudio.governedTerminal.generateCommand directly for the NL fold-in (D4a), so
		// no fork-side generate shim is needed.
		this._register(CommandsRegistry.registerCommand('glyphstudio.floatingTerminal.showError', (_accessor, message?: string) => {
			this.notificationService.error(message
				? localize('glyphstudio.floatingTerminal.error', "GlyphStudio: the governed terminal could not be opened — {0}", message)
				: localize('glyphstudio.floatingTerminal.errorGeneric', "GlyphStudio: the governed terminal could not be opened."));
		}));

		// G7/E18 — the EXT-HOST invokes this when the supervisor child/proxy dies MID-SESSION
		// (while the shell is still alive) for a runId we own. This is the renderer-unreachable
		// governance-loss signal the old onExit-only detection missed. We route it to the live
		// controller iff the runId matches (runId-scoped so a stale/foreign signal is ignored);
		// the controller drops the green badge → shows degraded → finalizes via stopSession.
		this._register(CommandsRegistry.registerCommand('glyphstudio.floatingTerminal.governanceLost', (_accessor, runId?: string) => {
			const c = this.controller;
			if (c && typeof runId === 'string' && c.runId === runId) {
				c.notifyGovernanceLost();
			}
		}));

		// G7 (cosmetic) — a transient, accessible notification reinforcing the degraded state
		// for glance/screen-reader users (the badge alone is easy to miss before teardown).
		this._register(CommandsRegistry.registerCommand('glyphstudio.floatingTerminal.showDegradedNotice', () => {
			this.notificationService.warn(localize('glyphstudio.floatingTerminal.degradedNotice',
				"GlyphStudio: governed terminal governance was lost mid-session — the session is degraded and is being finalized."));
		}));

		// D4a (unify target) — the palette NL-generate entry. The EXTENSION's
		// glyphstudio.terminalGenerateCommand delegates here so the palette "describe a command"
		// targets the FLOATING governed terminal (not the panel). Opens/focuses the floating
		// terminal at the cursor, then runs its describe-a-command NL flow.
		this._register(CommandsRegistry.registerCommand('glyphstudio.floatingTerminal.describeCommand', () => this.describeCommand()));

		// A9a — on window unload the contribution's super.dispose() disposes controllerDisposable
		// → the live controller's dispose() issues a best-effort stopSession(runId) before
		// teardown (no orphaned supervisor child).
	}

	/**
	 * D4a (unify target) — the palette NL-generate path. Opens the floating governed
	 * terminal (or focuses the existing one) at the cursor, then runs its keyboard-reachable
	 * "describe a command" NL fold-in there (generate → sanitize → pre-type; operator's Enter
	 * launches). This is what the extension's `glyphstudio.terminalGenerateCommand` palette
	 * command delegates to, so there is ONE NL-generate path and it targets the FLOATING
	 * terminal, never the panel. Refuse-not-degrade: if the terminal can't open, the
	 * controller already showed the honest error and there is nothing to type into.
	 */
	async describeCommand(): Promise<void> {
		await this.open();
		await this.controller?.describeCommand();
	}

	/** ⌃⌘K — open at the cursor, or focus the existing one (A4), or refuse honestly (A3). */
	async open(): Promise<void> {
		// A4 — re-press focuses the existing single instance; never a second.
		if (this.controller && this.controller.isLive) {
			this.controller.focus();
			return;
		}

		const editor = this.codeEditorService.getActiveCodeEditor() ?? this.codeEditorService.getFocusedCodeEditor();
		// A3/E1/E21 — pure 3-branch decision over a minimal editor view.
		const decision = decideWhereToAnchor({
			hasActiveEditor: !!editor,
			hasModel: !!editor?.hasModel(),
			position: editor?.getPosition() ? { lineNumber: editor.getPosition()!.lineNumber, column: editor.getPosition()!.column } : undefined,
		});
		if (decision.kind === 'refuse') {
			this.notificationService.info(NO_ANCHOR_MESSAGE);
			return;
		}

		const controller = this.instantiationService.createInstance(FloatingTerminalController, editor!);
		this.controllerDisposable.value = controller; // disposes any prior controller.
		await controller.open();
		// If open() refused (no terminal), drop the reference so the next ⌃⌘K retries.
		if (!controller.isLive) {
			this.controllerDisposable.clear();
		}
	}

	// A9a — window unload: super.dispose() disposes controllerDisposable, which disposes the
	// live controller → its dispose() issues a best-effort stopSession(runId) before teardown
	// (no orphaned supervisor child). No explicit override needed.
}

// ⌃⌘K — the workbench action. Global (no `when`) so it fires from any editor; the manager
// refuses honestly when there is no model-bearing editor (A3). Palette-invokable (f1).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_FLOATING_TERMINAL_COMMAND_ID,
			title: localize2('glyphstudio.openFloatingGovernedTerminal', 'Open Floating Governed Terminal at Cursor'),
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				// ⌃⌘K = WinCtrl(Control) + CtrlCmd(Command) + K on macOS. Distinct from
				// deleteAllRight's ⌃K (WinCtrl|K, no CtrlCmd) — not shadowed (H4a).
				primary: KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyK,
			},
			metadata: {
				description: localize2('glyphstudio.openFloatingGovernedTerminal.desc', 'Open a real PTY-backed GOVERNED terminal floating at the editor cursor (governed-unsandboxed, egress traced; refuses rather than degrades).'),
			},
		});
	}

	override async run(_accessor: ServicesAccessor): Promise<void> {
		// Resolve the per-window manager contribution (single instance) and drive its open
		// gesture. getWorkbenchContribution instantiates it on first use if needed.
		const manager = getWorkbenchContribution<FloatingTerminalManager>(FloatingTerminalManager.ID);
		await manager.open();
	}
});

// BlockRestore-eligible but lazy: registered so getWorkbenchContribution can instantiate
// it on the first ⌃⌘K. Eager AfterRestored is fine too (it only wires two helper commands
// until the first open).
registerWorkbenchContribution2(FloatingTerminalManager.ID, FloatingTerminalManager, WorkbenchPhase.AfterRestored);
