/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * GLYPHSTUDIO GOVERNED TERMINAL — inline broker decision chips (workbench contribution).
 *
 * Watches ITerminalService instances and, for each terminal whose shellLaunchConfig.env
 * carries the GLYPHSTUDIO_GOVERNED_FLOATING marker (value = runId — stamped by the
 * EXTENSION on every governed terminal: the Ctrl+Cmd+K floating one AND the ext-created panel
 * governed terminal/chat), wires a TerminalChipsInstanceController that renders the
 * run's per-command broker decision chips inline in the pty (own xterm decorations on
 * the command markers). ADDITIVE: no core terminal file is touched; unmarked terminals
 * get nothing. Degrade silently everywhere — chips are view-only and must never break
 * a terminal.
 */

import './media/terminalChips.css';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { TerminalChipsInstanceController } from './terminalChipsController.js';
import { readGovernedRunId } from './terminalChipsLogic.js';

/**
 * Per-window watcher: one chips controller per GOVERNED terminal instance, keyed by the
 * instance and disposed with it (DisposableMap — no leak across closed terminals).
 */
class GovernedTerminalChipsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.glyphstudioTerminalChips';

	private readonly _controllers = this._register(new DisposableMap<ITerminalInstance, TerminalChipsInstanceController>());

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._register(this._terminalService.onDidCreateInstance(instance => this._maybeTrack(instance)));
		this._register(this._terminalService.onDidDisposeInstance(instance => this._controllers.deleteAndDispose(instance)));
		for (const instance of this._terminalService.instances) {
			this._maybeTrack(instance);
		}
	}

	private _maybeTrack(instance: ITerminalInstance): void {
		if (this._controllers.has(instance)) {
			return;
		}
		// Identification is the env marker ONLY (value = runId; uniform across both
		// governed-terminal creation paths). No marker → not governed-owned → no chips.
		const runId = readGovernedRunId(instance.shellLaunchConfig.env);
		if (!runId) {
			return;
		}
		this._controllers.set(instance, this._instantiationService.createInstance(TerminalChipsInstanceController, instance, runId));
	}
}

// Eager-ish (AfterRestored, the floatingTerminal manager's phase): the watcher itself is
// two listeners; controllers only exist for marked governed terminals.
registerWorkbenchContribution2(GovernedTerminalChipsContribution.ID, GovernedTerminalChipsContribution, WorkbenchPhase.AfterRestored);
