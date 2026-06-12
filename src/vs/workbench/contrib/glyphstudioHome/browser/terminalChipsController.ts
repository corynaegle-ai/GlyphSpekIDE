/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * GLYPHSTUDIO GOVERNED TERMINAL — inline broker decision chips, per-instance controller.
 *
 * For ONE governed terminal instance (identified by the GLYPHSTUDIO_GOVERNED_FLOATING
 * env marker, value = runId): subscribes to the command-detection capability's
 * onCommandFinished, fetches the run's chip rows over the ext-host command seam
 * (`glyphstudio.governedTerminal.getCommandChips` — the floatingTerminalWidget bridge
 * idiom), matches the finished command to its row (pure logic), and registers an OWN
 * xterm decoration on the command's marker — a small glyph CSS-offset from core's
 * command-decoration circle (media/terminalChips.css; layer 'top'; no collision).
 * One delayed refresh ~{@link CHIPS_LATE_REFRESH_MS}ms after each finish catches
 * late-correlated decisions (the extension store debounces ~300ms).
 *
 * ADDITIVE-ONLY: own decorations on own markers; core's decorationAddon.ts is read for
 * the idiom but never touched. DEGRADE SILENTLY: no shell integration / no command
 * detection / RPC failure / malformed response → no decorations, no errors surfaced.
 * View-only — a projection of decisions the broker already traced; it confers no trust.
 */

import type { IDecoration } from '@xterm/xterm';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ICommandDetectionCapability, ITerminalCommand, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { ITerminalInstance } from '../../terminal/browser/terminal.js';
import {
	CHIP_KIND_CLASSES,
	CHIPS_LATE_REFRESH_MS,
	matchChipRow,
	projectChipDecoration,
	validateCommandChipsResponse,
	type ChipDecorationModel,
} from './terminalChipsLogic.js';

/** One live chip decoration: the xterm decoration + the CURRENT model it renders. */
interface ChipHandle {
	readonly decoration: IDecoration;
	model: ChipDecorationModel;
	element?: HTMLElement;
	readonly hover: MutableDisposable<IDisposable>;
}

/**
 * The per-governed-terminal chips controller. Created by the contribution for each
 * marked instance; disposed with it (decorations, listeners and timers all ride the
 * instance's lifetime — nothing leaks past the terminal).
 */
export class TerminalChipsInstanceController extends Disposable {

	/** The command-detection listener (swapped when the capability is re-added). */
	private readonly _commandListener = this._register(new MutableDisposable<DisposableStore>());
	/** Owns every decoration, hover and refresh timer for this instance. */
	private readonly _session = this._register(new DisposableStore());
	/** marker.id → live chip handle (so the late refresh UPDATES, never duplicates). */
	private readonly _handles = new Map<number, ChipHandle>();

	constructor(
		private readonly _instance: ITerminalInstance,
		private readonly _runId: string,
		@ICommandService private readonly _commandService: ICommandService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		// The command-detection capability arrives asynchronously with shell integration
		// (or never, when shell integration is off — then NO chips, silently).
		this._register(this._instance.capabilities.onDidAddCapability(e => {
			if (e.id === TerminalCapability.CommandDetection) {
				this._attach();
			}
		}));
		this._register(this._instance.capabilities.onDidRemoveCapability(e => {
			if (e.id === TerminalCapability.CommandDetection) {
				this._commandListener.clear();
			}
		}));
		this._attach();
	}

	private _attach(): void {
		const capability = this._instance.capabilities.get(TerminalCapability.CommandDetection);
		if (!capability || this._commandListener.value) {
			return;
		}
		const store = new DisposableStore();
		store.add(capability.onCommandFinished(command => this._onCommandFinished(capability, command)));
		this._commandListener.value = store;
	}

	private _onCommandFinished(_capability: ICommandDetectionCapability, command: ITerminalCommand): void {
		if (!command.marker || command.marker.isDisposed) {
			return; // no anchor line — nothing to decorate (degrade silently).
		}
		// First pass now (the broker usually already traced the command's decisions)…
		void this._applyChips(command);
		// …and ONE delayed refresh to catch late-correlated decisions (ext store
		// debounces ~300ms). Later decisions appear only in the Trust Panel run view.
		const timer = setTimeout(() => void this._applyChips(command), CHIPS_LATE_REFRESH_MS);
		this._session.add(toDisposable(() => clearTimeout(timer)));
	}

	/** Fetch → validate → match → project → render/update. Never throws (degrade silently). */
	private async _applyChips(command: ITerminalCommand): Promise<void> {
		let raw: unknown;
		try {
			raw = await this._commandService.executeCommand('glyphstudio.governedTerminal.getCommandChips', this._runId);
		} catch {
			return; // seam unavailable — no decoration, no error surfaced.
		}
		if (this._store.isDisposed) {
			return;
		}
		const response = validateCommandChipsResponse(raw);
		if (!response) {
			return;
		}
		const row = matchChipRow(response.rows, command.command);
		const model = row ? projectChipDecoration(row, response.dropped) : undefined;
		if (!model) {
			return; // nothing recorded for this command — render nothing (no empty badge).
		}

		const marker = command.marker;
		if (!marker || marker.isDisposed) {
			return;
		}
		const existing = this._handles.get(marker.id);
		if (existing) {
			existing.model = model;
			if (existing.element) {
				this._renderElement(existing, existing.element);
			}
			return;
		}

		const xterm = this._instance.xterm;
		if (!xterm) {
			return;
		}
		// OWN decoration on the command's marker, layered 'top'; the CSS offsets it away
		// from core's command-decoration circle so the two never collide.
		const decoration = xterm.raw.registerDecoration({ marker, layer: 'top' });
		if (!decoration) {
			return;
		}
		const handle: ChipHandle = { decoration, model, hover: new MutableDisposable<IDisposable>() };
		this._handles.set(marker.id, handle);
		this._session.add(handle.hover);
		this._session.add(toDisposable(() => {
			this._handles.delete(marker.id);
			decoration.dispose();
		}));
		decoration.onDispose(() => this._handles.delete(marker.id));
		decoration.onRender(element => this._renderElement(handle, element));
	}

	/** (Re-)paint one decoration element off the handle's CURRENT model. */
	private _renderElement(handle: ChipHandle, element: HTMLElement): void {
		element.classList.remove(...Object.values(CHIP_KIND_CLASSES));
		element.classList.add(...handle.model.classNames);
		element.textContent = handle.model.glyph;
		element.setAttribute('aria-label', handle.model.ariaLabel);
		element.setAttribute('role', 'img');
		// Hover via IHoverService (house style). The factory reads the CURRENT model, so
		// the late refresh updates the hover without re-wiring; re-wire only when xterm
		// hands us a NEW element for the same decoration.
		if (handle.element !== element || !handle.hover.value) {
			handle.element = element;
			handle.hover.value = this._hoverService.setupDelayedHover(element, () => ({
				content: new MarkdownString().appendText(handle.model.hoverLines.join('\n')),
			}));
		}
	}
}
