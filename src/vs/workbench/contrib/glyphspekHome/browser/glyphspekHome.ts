/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/glyphspekHome.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { GlyphspekHomeInput } from './glyphspekHomeInput.js';
import { GLYPHSPEK_HOME_ICON_SPRITE } from './glyphspekHomeIcons.js';

/**
 * A governance command row on the Home surface. Every row maps to a REAL extension command —
 * the honesty contract (BLENDED-WORKBENCH-SPEC §2.2): nothing actionable is a dead button. If
 * the GlyphSpek extension is not active (its commands unregistered), the row renders visibly
 * disabled with a "needs the GlyphSpek extension" hint rather than a live-looking no-op.
 */
interface IHomeCommand {
	readonly commandId: string;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
}

/** The primary governed-run command (extension: "GlyphSpek: Build This (Governed Run)"). */
const BUILD_COMMAND_ID = 'glyphspek.promoteChatToBuild';

/**
 * The governance command list. Each id is a command CONTRIBUTED by the GlyphSpek extension
 * (`extension/package.json` → `contributes.commands` / `contributes.views`). Only wired ids
 * that the extension actually registers. The view ids (Trace/Egress) are reached via the
 * stock `workbench.view.extension.<container>` command Code-OSS auto-registers for each
 * contributed view container, so they open the real governance side-bar surfaces.
 */
const HOME_COMMANDS: readonly IHomeCommand[] = [
	{
		commandId: 'glyphspek.openTrustPanel',
		label: localize('glyphspekHome.openTrustPanel', "Open Trust Panel"),
		description: localize('glyphspekHome.openTrustPanel.desc', "Evidence, not transcript — claims vs. signed verdict."),
		icon: 'gs-verifier'
	},
	{
		commandId: 'glyphspek.runs.openTrustPanel',
		label: localize('glyphspekHome.openVerifier', "Open Independent Verifier"),
		description: localize('glyphspekHome.openVerifier.desc', "Re-runs declared checks in a clean trust domain and signs a verdict."),
		icon: 'gs-broker'
	},
	{
		commandId: 'workbench.view.extension.glyphspek-egress',
		label: localize('glyphspekHome.openEgress', "Open Egress / Network"),
		description: localize('glyphspekHome.openEgress.desc', "Observe-and-trace egress (metadata-only) for governed runs — allowed-this-run is recorded, not blocked."),
		icon: 'gs-network'
	},
	{
		commandId: 'workbench.view.extension.glyphspek-trace',
		label: localize('glyphspekHome.openTrace', "Open Trace / Provenance"),
		description: localize('glyphspekHome.openTrace.desc', "The hash-chained, tamper-evident event chain for the focused run."),
		icon: 'gs-trace'
	},
	{
		commandId: 'workbench.action.findInFiles',
		label: localize('glyphspekHome.search', "Search"),
		description: localize('glyphspekHome.search.desc', "Find across the workspace."),
		icon: 'gs-search'
	}
];

/**
 * GlyphSpek Home (PATCH-004) — the full-window landing surface the IDE opens on at startup,
 * the way an agent-home IDE lands on its home rather than an empty editor.
 *
 * Renders the blended-workbench aesthetic (floating frame, halo palette, GlyphSpek wordmark)
 * as a LIVE, HONEST surface: the primary input starts a REAL governed run via the extension's
 * `glyphspek.promoteChatToBuild` command (typed task → build intent arg); each governance row
 * invokes a REAL command/view. Recent runs are an honest empty-state — the workbench has no
 * runs data source (runs live in the extension), so we never fabricate them.
 *
 * This is a native-DOM `EditorPane` (not a webview): it harmonizes directly with the Authority
 * Halo CSS vars, reads `IKeybindingService` for live keybinding hints, and invokes commands
 * through `ICommandService` with no message-passing seam. Modeled on `GettingStartedPage`.
 */
export class GlyphspekHomePage extends EditorPane {

	static readonly ID = 'glyphspekHomePage';

	private container!: HTMLElement;
	private taskInput: HTMLTextAreaElement | undefined;
	private readonly rowDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkbenchThemeService themeService: IWorkbenchThemeService,
		@IStorageService storageService: IStorageService
	) {
		super(GlyphspekHomePage.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = $('.glyphspek-home', {
			role: 'document',
			tabindex: 0,
			'aria-label': localize('glyphspekHome.aria', "GlyphSpek Home — start a governed run and reach the governance surfaces.")
		});
		// Vendored brand icon sprite so `<use href="#gs-…">` resolves inside the pane.
		this.container.insertAdjacentHTML('afterbegin', GLYPHSPEK_HOME_ICON_SPRITE);
		append(parent, this.container);

		// Re-render the command rows when the GlyphSpek extension (de)registers its commands,
		// so a row flips from the disabled "extension needed" state to live the moment it activates.
		this._register(CommandsRegistry.onDidRegisterCommand(id => {
			if (id === BUILD_COMMAND_ID || HOME_COMMANDS.some(c => c.commandId === id)) {
				this.renderBody();
			}
		}));

		this.renderBody();
	}

	override async setInput(input: GlyphspekHomeInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.renderBody();
	}

	private renderBody(): void {
		if (!this.container) {
			return;
		}
		this.rowDisposables.clear();
		// Keep the leading sprite; clear everything after it, then rebuild.
		const sprite = this.container.querySelector('svg');
		clearNode(this.container);
		if (sprite) {
			this.container.appendChild(sprite);
		}

		const scroll = append(this.container, $('.glyphspek-home-scroll'));
		const inner = append(scroll, $('.glyphspek-home-inner'));

		this.renderHeader(inner);
		this.renderStartRun(inner);
		this.renderCommands(inner);
		this.renderRecentRuns(inner);
	}

	private renderHeader(parent: HTMLElement): void {
		const header = append(parent, $('.gsh-header'));
		const wordmark = append(header, $('.gsh-wordmark'));
		append(wordmark, this.icon('gs-verifier', 'gsh-mark-icon'));
		const title = append(wordmark, $('span.gsh-mark-text'));
		title.textContent = 'GlyphSpek';
		const tagline = append(header, $('.gsh-tagline'));
		tagline.textContent = localize('glyphspekHome.tagline', "Agent-safe engineering workstation — more autonomy, less blind trust.");
	}

	private renderStartRun(parent: HTMLElement): void {
		const card = append(parent, $('.gsh-card.gsh-start'));
		const head = append(card, $('.gsh-card-head'));
		append(head, this.icon('gs-run', 'gsh-head-icon'));
		const headText = append(head, $('span'));
		headText.textContent = localize('glyphspekHome.startTitle', "Start a governed run");

		const sub = append(card, $('.gsh-card-sub'));
		sub.textContent = localize('glyphspekHome.startSub', "Describe a task. The governed agent acts inside the supervisor envelope — it WILL edit files and run commands, every step brokered and traced.");

		const inputRow = append(card, $('.gsh-input-row'));
		const textarea = append(inputRow, $('textarea.gsh-task-input')) as HTMLTextAreaElement;
		textarea.placeholder = localize('glyphspekHome.startPlaceholder', "e.g. \"add input validation to the signup form and a test for it\"");
		textarea.rows = 3;
		textarea.setAttribute('aria-label', localize('glyphspekHome.startAria', "Describe the task for the governed agent to build"));
		this.taskInput = textarea;

		const buildAvailable = this.isCommandAvailable(BUILD_COMMAND_ID);
		const button = append(inputRow, $('button.gsh-run-button')) as HTMLButtonElement;
		append(button, this.icon('gs-sandbox', 'gsh-btn-icon'));
		const buttonLabel = append(button, $('span'));
		buttonLabel.textContent = localize('glyphspekHome.startButton', "Start governed run");
		button.disabled = !buildAvailable;

		// Enter (without Shift) submits; Shift+Enter inserts a newline.
		const onSubmit = () => this.startGovernedRun();
		const keyListener = (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				onSubmit();
			}
		};
		textarea.addEventListener('keydown', keyListener);
		button.addEventListener('click', onSubmit);
		this.rowDisposables.add({ dispose: () => { textarea.removeEventListener('keydown', keyListener); button.removeEventListener('click', onSubmit); } });

		const hint = append(card, $('.gsh-start-hint'));
		if (buildAvailable) {
			append(hint, this.icon('gs-broker', 'gsh-hint-icon'));
			const hintText = append(hint, $('span'));
			hintText.textContent = localize('glyphspekHome.startHintLive', "Submits to the governed build (you approve authority up front). Press Enter to start, Shift+Enter for a newline.");
		} else {
			append(hint, this.icon('gs-broker', 'gsh-hint-icon gsh-hint-muted'));
			const hintText = append(hint, $('span.gsh-hint-muted'));
			hintText.textContent = localize('glyphspekHome.startHintUnavailable', "The GlyphSpek extension is not active in this window, so governed runs can't start yet.");
		}
	}

	private async startGovernedRun(): Promise<void> {
		if (!this.isCommandAvailable(BUILD_COMMAND_ID)) {
			return;
		}
		const task = this.taskInput?.value.trim();
		// Pass the typed text as the build intent arg. A blank task lets the command prompt
		// for one itself (its quick-input), so Enter on an empty box is never a silent no-op.
		await this.commandService.executeCommand(BUILD_COMMAND_ID, task && task.length > 0 ? task : undefined);
	}

	private renderCommands(parent: HTMLElement): void {
		const section = append(parent, $('.gsh-section'));
		const sectionHead = append(section, $('.gsh-section-head'));
		sectionHead.textContent = localize('glyphspekHome.commandsTitle', "Governance surfaces");

		const list = append(section, $('.gsh-command-list'));
		for (const cmd of HOME_COMMANDS) {
			this.renderCommandRow(list, cmd);
		}
	}

	private renderCommandRow(parent: HTMLElement, cmd: IHomeCommand): void {
		const available = this.isCommandAvailable(cmd.commandId);
		const row = append(parent, $(available ? 'button.gsh-command-row' : 'button.gsh-command-row.gsh-disabled')) as HTMLButtonElement;
		row.disabled = !available;
		append(row, this.icon(cmd.icon, 'gsh-row-icon'));

		const text = append(row, $('.gsh-row-text'));
		const label = append(text, $('.gsh-row-label'));
		label.textContent = cmd.label;
		const desc = append(text, $('.gsh-row-desc'));
		desc.textContent = available
			? cmd.description
			: localize('glyphspekHome.rowUnavailable', "Needs the GlyphSpek extension active in this window.");

		// Live keybinding hint where one exists.
		const keybinding = this.keybindingService.lookupKeybinding(cmd.commandId);
		const kbLabel = keybinding?.getLabel();
		if (available && kbLabel) {
			const kb = append(row, $('span.gsh-row-kb'));
			kb.textContent = kbLabel;
		}

		if (available) {
			const onClick = () => { void this.commandService.executeCommand(cmd.commandId); };
			row.addEventListener('click', onClick);
			this.rowDisposables.add({ dispose: () => row.removeEventListener('click', onClick) });
		}
	}

	private renderRecentRuns(parent: HTMLElement): void {
		const section = append(parent, $('.gsh-section'));
		const sectionHead = append(section, $('.gsh-section-head'));
		sectionHead.textContent = localize('glyphspekHome.recentTitle', "Recent governed runs");

		// HONESTY: the workbench has no runs data source (runs are owned by the GlyphSpek
		// extension's views). We render an honest empty-state rather than fabricating runs.
		const empty = append(section, $('.gsh-empty'));
		append(empty, this.icon('gs-run', 'gsh-empty-icon'));
		const emptyText = append(empty, $('.gsh-empty-text'));
		const emptyTitle = append(emptyText, $('.gsh-empty-title'));
		emptyTitle.textContent = localize('glyphspekHome.recentEmpty', "No runs yet — start one above.");
		const emptySub = append(emptyText, $('.gsh-empty-sub'));
		emptySub.textContent = localize('glyphspekHome.recentEmptySub', "Governed runs you start will appear in the Governed Runs view; their evidence opens in the Trust Panel.");
	}

	private icon(id: string, className: string): SVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', `gsh-icon ${className}`);
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
		use.setAttribute('href', `#${id}`);
		svg.appendChild(use);
		return svg;
	}

	private isCommandAvailable(commandId: string): boolean {
		return !!CommandsRegistry.getCommand(commandId);
	}

	override clearInput(): void {
		this.taskInput = undefined;
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		if (this.taskInput) {
			this.taskInput.focus();
		} else {
			this.container?.focus();
		}
	}

	override layout(dimension: Dimension): void {
		this.container?.classList.toggle('gsh-narrow', dimension.width <= 720);
	}
}
