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
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { GlyphspekHomeInput } from './glyphspekHomeInput.js';
import { createGlyphspekHomeIconSprite } from './glyphspekHomeIcons.js';
import {
	DesktopAgentRunProvider,
	IAgentRunProvider,
	AgentRun,
	AgentRunDetail,
	AgentRunChangedFile,
	AgentRunCheck,
	AssuranceLevel,
	RunCardState,
	CreationTrustPosture,
	deriveRunCardState,
	productTrustEligible,
	runtimeLabel,
	actorLabel,
	authorityLabel,
	authorityColor,
	shortRunId
} from './agentRunProvider.js';

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

	/** The Slice-1 Agent View run provider (design §2) — fed by the Part A snapshot command. */
	private readonly runProvider: IAgentRunProvider;
	/** The currently selected run id (left pane → focuses the Evidence pane). null = composer draft. */
	private selectedRunId: string | null = null;
	/** Disposables for the left Runs-list rows; cleared on each re-render of that pane. */
	private readonly runRowDisposables = this._register(new DisposableStore());
	/** The right Evidence-pane container, so a selection can repaint it without a full rebuild. */
	private evidenceBody: HTMLElement | undefined;
	/**
	 * The last fetched detail for the selected run, or undefined while loading / when none.
	 * Held so a synchronous repaint (selection, runs-change) can render the already-known
	 * evidence immediately while a fresh async fetch is in flight.
	 */
	private selectedDetail: AgentRunDetail | undefined;
	/**
	 * Monotonic token guarding async detail fetches against races: a fetch only paints if its
	 * token still matches (the selection didn't change / the pane wasn't rebuilt underneath it).
	 */
	private detailFetchToken = 0;
	/** The left Runs-list container, so onDidChangeRuns can repaint just that pane. */
	private runsListBody: HTMLElement | undefined;
	/**
	 * The center COMPOSER container (Slice 3), so a selection change can swap it between the
	 * editable untitled-draft and the selected-run read-only intent/status WITHOUT a full
	 * rebuild. The governance-surfaces list below it is unaffected and is not re-rendered.
	 */
	private composerBody: HTMLElement | undefined;
	/**
	 * The whole-pane container (`.gsh-panes`), so Slice-4 can drive its Authority-Halo
	 * edge-tint attribute (`data-gsh-authority`) from the selected run's authorityLevel.
	 */
	private panesEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkbenchThemeService themeService: IWorkbenchThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super(GlyphspekHomePage.ID, group, telemetryService, themeService, storageService);
		// ONE provider (design §4 non-goal: no registry). Instantiated via DI so it gets
		// ICommandService; registered for disposal so its poll timer is torn down with the pane.
		this.runProvider = this._register(instantiationService.createInstance(DesktopAgentRunProvider));
		// Repaint ONLY the left pane + evidence stub when the run set changes — never the whole body.
		this._register(this.runProvider.onDidChangeRuns(() => this.onRunsChanged()));
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = $('.glyphspek-home', {
			role: 'document',
			tabindex: 0,
			'aria-label': localize('glyphspekHome.aria', "GlyphSpek Home — start a governed run and reach the governance surfaces.")
		});
		// Vendored brand icon sprite so `<use href="#gs-…">` resolves inside the pane. Built as a
		// real DOM node (NOT via insertAdjacentHTML) — the renderer's Trusted Types CSP rejects a
		// raw HTML-string assignment, which would throw here and blank the whole pane.
		this.container.insertBefore(createGlyphspekHomeIconSprite(this.container.ownerDocument), this.container.firstChild);
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
		// Drop references into the about-to-be-rebuilt DOM so an onDidChangeRuns mid-rebuild
		// never paints into a detached node; the pane renderers below reassign them.
		this.runsListBody = undefined;
		this.evidenceBody = undefined;
		this.composerBody = undefined;
		this.panesEl = undefined;
		// Keep the leading sprite; clear everything after it, then rebuild.
		const sprite = this.container.querySelector('svg');
		clearNode(this.container);
		if (sprite) {
			this.container.appendChild(sprite);
		}

		const scroll = append(this.container, $('.glyphspek-home-scroll'));
		const inner = append(scroll, $('.glyphspek-home-inner'));

		this.renderHeader(inner);

		// Slice 1: grow Home toward the §3 three-pane Agent View. LEFT = Runs list (full),
		// CENTER = today's composer + governance surfaces, RIGHT = Evidence (Slice-1 STUB).
		const panes = append(inner, $('.gsh-panes'));
		this.panesEl = panes;
		const left = append(panes, $('.gsh-pane.gsh-pane-runs'));
		const center = append(panes, $('.gsh-pane.gsh-pane-center'));
		const right = append(panes, $('.gsh-pane.gsh-pane-evidence'));

		this.renderRunsList(left);

		// CENTER: the Slice-3 composer host. It swaps between the editable untitled draft and
		// the selected-run read-only intent/status; the governance-surfaces list below is fixed.
		this.composerBody = append(center, $('.gsh-composer-host'));
		this.renderComposer();
		this.renderCommands(center);

		this.renderEvidencePane(right);

		// Slice 4: paint the Authority-Halo edge tint for the current selection (neutral when none).
		this.applyAuthorityTint();
	}

	/** Repaint just the left Runs list + the Evidence pane when the provider's run set changes. */
	private onRunsChanged(): void {
		if (this.runsListBody) {
			this.renderRunsListBody(this.runsListBody);
		}
		// If the selected run vanished from the set, fall back to the composer-draft state.
		if (this.selectedRunId && !this.runProvider.listRuns().some(r => r.id === this.selectedRunId)) {
			this.selectedRunId = null;
			this.selectedDetail = undefined;
			this.detailFetchToken++; // invalidate any in-flight fetch for the gone run.
			// The selection is gone → swap the composer back to the draft + drop the halo tint.
			this.renderComposer();
			this.applyAuthorityTint();
		}
		// A run-set / verified-flip change (the revision advanced) can change THIS run's
		// evidence (run closed, a verdict landed, verified flipped). Re-fetch when one is
		// selected — the existing revision pull-signal is the only refresh trigger (Part A note 2).
		if (this.selectedRunId) {
			void this.refreshSelectedDetail();
		} else {
			this.renderEvidenceBody();
		}
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

	/**
	 * CENTER composer (Slice 3, design §3 "Center — Composer"). Idempotently (re)paints
	 * `composerBody`, switching between two states by selection:
	 *   - NO run selected  → the editable `untitled` DRAFT composer (today's "Start a
	 *     governed run" card, unchanged in spirit), which calls `provider.startRun`.
	 *   - a run IS selected → that run's intent READ-ONLY plus its LIVE status — never an
	 *     editable box (you don't re-describe an already-running run).
	 * Clears the cached textarea ref first so a stale read never targets a detached node.
	 */
	private renderComposer(): void {
		const body = this.composerBody;
		if (!body) {
			return;
		}
		// The textarea only exists in the draft state; drop the ref before repainting so
		// startGovernedRun never reads a detached node when a run is selected.
		this.taskInput = undefined;
		clearNode(body);

		if (this.selectedRunId) {
			this.renderSelectedRunComposer(body);
		} else {
			this.renderDraftComposer(body);
		}
	}

	/**
	 * The editable untitled-DRAFT composer — today's "Start a governed run" card, preserved
	 * verbatim in behavior. Typed task → `provider.startRun({ title })`. The "extension not
	 * active → disabled with honest hint" behavior is unchanged (the same isCommandAvailable
	 * gate the provider's startRun also no-ops behind).
	 */
	private renderDraftComposer(parent: HTMLElement): void {
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

	/**
	 * The SELECTED-RUN composer (Slice 3): the run's intent shown READ-ONLY plus its live
	 * status. The intent comes from `detail.intent`; when it is OMITTED (an older run, or one
	 * with no intent yet) we show an honest neutral label — NOT a fabricated title (design §3
	 * HONESTY rule 5 / the Part A "OMITTED → untitled" contract). The status is the backend
	 * wire value (live, repainted on every revision change). A "back to draft" affordance
	 * clears the selection. This card is NEVER editable.
	 */
	private renderSelectedRunComposer(parent: HTMLElement): void {
		const detail = this.selectedDetail;
		const card = append(parent, $('.gsh-card.gsh-composer-selected'));

		const head = append(card, $('.gsh-card-head'));
		append(head, this.icon('gs-run', 'gsh-head-icon'));
		const headText = append(head, $('span'));
		headText.textContent = localize('glyphspekHome.composerSelectedTitle', "Selected run");

		// READ-ONLY intent. Honest neutral label when omitted — never a synthesized title.
		const intentBox = append(card, $('.gsh-composer-intent'));
		const intentText = detail?.intent;
		if (typeof intentText === 'string' && intentText.length > 0) {
			intentBox.textContent = intentText;
		} else {
			intentBox.classList.add('gsh-composer-intent-untitled');
			// Distinguish "loading the detail" from "this run carries no intent".
			intentBox.textContent = detail
				? localize('glyphspekHome.composerNoIntent', "untitled run — no intent text was recorded.")
				: localize('glyphspekHome.composerIntentLoading', "Loading the run's intent…");
		}

		// LIVE status line (the wire status string is not localizable; framed inline).
		const statusRow = append(card, $('.gsh-composer-status'));
		const statusLabel = append(statusRow, $('span.gsh-composer-status-label'));
		statusLabel.textContent = localize('glyphspekHome.composerStatusLabel', "status");
		const statusValue = append(statusRow, $('span.gsh-composer-status-value'));
		if (detail) {
			statusValue.textContent = detail.closed
				? localize('glyphspekHome.composerStatusClosed', "{0} (closed)", detail.status)
				: detail.status;
		} else {
			statusValue.textContent = localize('glyphspekHome.composerStatusLoading', "loading…");
		}

		// Honest framing + a "back to draft" affordance (clears the selection → editable draft).
		const hint = append(card, $('.gsh-start-hint'));
		append(hint, this.icon('gs-broker', 'gsh-hint-icon'));
		const hintText = append(hint, $('span'));
		hintText.textContent = localize('glyphspekHome.composerSelectedHint', "Read-only — this run is already governed. Its evidence is on the right. Clear the selection to start a new run.");

		const back = append(card, $('button.gsh-composer-back')) as HTMLButtonElement;
		back.textContent = localize('glyphspekHome.composerBack', "Start a new run instead");
		const onBack = () => this.selectRun(null);
		back.addEventListener('click', onBack);
		this.rowDisposables.add({ dispose: () => back.removeEventListener('click', onBack) });
	}

	/** Submit the draft composer's task through the provider's startRun (Slice 3). */
	private async startGovernedRun(): Promise<void> {
		// Preserve the existing "extension not active → no-op" gate VERBATIM (the button is
		// already disabled in that state; this guard backs a stray keydown).
		if (!this.isCommandAvailable(BUILD_COMMAND_ID)) {
			return;
		}
		const task = this.taskInput?.value ?? '';
		// Route through the provider seam (design §2 startRun). startRun trims + passes a blank
		// title as undefined so the command prompts for its own intent — never a silent no-op.
		await this.runProvider.startRun({ title: task });
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

	/**
	 * LEFT pane — the Agent View Runs list (design §3). Binds to the provider's
	 * listRuns() + onDidChangeRuns. Each row is an AgentRun projection: short id, a state
	 * pill (deriveRunCardState), and the runtime label. The honest empty/extension-not-active
	 * states are preserved — we never fabricate a row.
	 */
	private renderRunsList(parent: HTMLElement): void {
		const section = append(parent, $('.gsh-section'));
		const sectionHead = append(section, $('.gsh-section-head'));
		sectionHead.textContent = localize('glyphspekHome.runsTitle', "Runs");
		this.runsListBody = append(section, $('.gsh-runs-list'));
		this.renderRunsListBody(this.runsListBody);
	}

	/** (Re)paint the run rows into the left-pane body. Idempotent; clears row disposables first. */
	private renderRunsListBody(body: HTMLElement): void {
		this.runRowDisposables.clear();
		clearNode(body);

		const runs = this.runProvider.listRuns();
		if (runs.length === 0) {
			this.renderRunsEmpty(body);
			return;
		}
		for (const run of runs) {
			this.renderRunRow(body, run);
		}
	}

	/**
	 * The honest empty state (honesty rule §3.5 — never fabricate a row). Distinguishes
	 * "extension not active" (the snapshot command is unregistered) from "no runs yet".
	 */
	private renderRunsEmpty(parent: HTMLElement): void {
		const empty = append(parent, $('.gsh-empty'));
		append(empty, this.icon('gs-run', 'gsh-empty-icon'));
		const emptyText = append(empty, $('.gsh-empty-text'));
		const emptyTitle = append(emptyText, $('.gsh-empty-title'));
		const emptySub = append(emptyText, $('.gsh-empty-sub'));
		if (!this.runProvider.isExtensionActive()) {
			emptyTitle.textContent = localize('glyphspekHome.runsExtensionInactive', "GlyphSpek extension not active");
			emptySub.textContent = localize('glyphspekHome.runsExtensionInactiveSub', "Runs are owned by the GlyphSpek extension. Activate it in this window to see governed runs here.");
		} else {
			emptyTitle.textContent = localize('glyphspekHome.runsEmpty', "No runs yet — start one in the center.");
			emptySub.textContent = localize('glyphspekHome.runsEmptySub', "Governed runs you start appear here; selecting one shows its evidence on the right.");
		}
	}

	/** One run row — short id + state pill + runtime label. Selecting it focuses the Evidence stub. */
	private renderRunRow(parent: HTMLElement, run: AgentRun): void {
		const state = deriveRunCardState(run);
		const selected = run.id === this.selectedRunId;
		const row = append(parent, $(`button.gsh-run-row.gsh-state-${state}${selected ? '.gsh-run-selected' : ''}`)) as HTMLButtonElement;
		row.setAttribute('aria-pressed', selected ? 'true' : 'false');

		const main = append(row, $('.gsh-run-main'));
		const idEl = append(main, $('.gsh-run-id'));
		idEl.textContent = shortRunId(run.id);
		const pill = append(main, $(`.gsh-run-pill.gsh-pill-${state}`));
		pill.textContent = this.statePillLabel(state);

		const meta = append(row, $('.gsh-run-meta'));
		const actorEl = append(meta, $('span.gsh-run-actor'));
		actorEl.textContent = actorLabel(run.actorType);
		const runtimeEl = append(meta, $('span.gsh-run-runtime'));
		runtimeEl.textContent = runtimeLabel(run.posture);
		if (run.closed) {
			const closedEl = append(meta, $('span.gsh-run-closed'));
			closedEl.textContent = localize('glyphspekHome.runClosed', "closed");
		}

		const onClick = () => this.selectRun(run.id);
		row.addEventListener('click', onClick);
		this.runRowDisposables.add({ dispose: () => row.removeEventListener('click', onClick) });
	}

	/**
	 * The honest pill label per state. Mirrors RUN_CARD_PILL (governedRunsCard.ts):
	 * acting/blocked are literal; 'verified' reads "verified · signed" to echo the
	 * status-bar AUTHORITY_LABEL.verified text (the blue is gated upstream, never styled-in).
	 */
	private statePillLabel(state: RunCardState): string {
		switch (state) {
			case 'verified': return localize('glyphspekHome.pillVerified', "verified");
			case 'blocked': return localize('glyphspekHome.pillBlocked', "blocked");
			default: return localize('glyphspekHome.pillActing', "acting");
		}
	}

	/** Select a run (or clear): highlight the row, drop stale evidence, then fetch + repaint. */
	private selectRun(runId: string | null): void {
		this.selectedRunId = runId;
		// Drop the prior run's evidence immediately so a slow fetch never shows stale detail.
		this.selectedDetail = undefined;
		if (this.runsListBody) {
			this.renderRunsListBody(this.runsListBody);
		}
		// Slice 3: swap the center composer to match the new selection (draft ↔ read-only).
		// Slice 4: drop the halo tint to neutral immediately; refreshSelectedDetail re-tints it
		// to the run's authorityLevel once the detail arrives (never tint ahead of the data).
		this.renderComposer();
		this.applyAuthorityTint();
		if (runId) {
			void this.refreshSelectedDetail();
		} else {
			this.detailFetchToken++; // composer-draft state — invalidate any in-flight fetch.
			this.renderEvidenceBody();
		}
	}

	/**
	 * Fetch the selected run's evidence detail and repaint the Evidence pane. Guarded by a
	 * monotonic token so a late-returning fetch for a no-longer-selected run is discarded
	 * (never paints stale/foreign evidence). Renders the loading state synchronously first.
	 */
	private async refreshSelectedDetail(): Promise<void> {
		const runId = this.selectedRunId;
		if (!runId) {
			return;
		}
		const token = ++this.detailFetchToken;
		// Paint immediately so the pane reflects the selection (loading, or the prior known
		// detail if a refresh kept the same run selected).
		this.renderEvidenceBody();
		const detail = await this.runProvider.getRunDetail(runId);
		// Discard if the selection changed or the pane was rebuilt while the fetch was in flight.
		if (token !== this.detailFetchToken || this.selectedRunId !== runId) {
			return;
		}
		this.selectedDetail = detail;
		this.renderEvidenceBody();
		// Slice 3: the composer's read-only intent/status binds to this freshly-fetched detail.
		// Slice 4: re-tint the halo to the run's now-known authorityLevel (neutral if no detail).
		this.renderComposer();
		this.applyAuthorityTint();
	}

	/**
	 * Slice 4 — bind the pane's Authority-Halo edge tint to the SELECTED run's authorityLevel.
	 *
	 * What we found in the fork: there IS already a whole-workbench Authority Halo —
	 * `src/vs/workbench/browser/parts/glyphspekAuthorityHalo.ts` mirrors the
	 * `glyphspek.authority` CONTEXT-KEY (which the EXTENSION sets for the FOCUSED run) onto a
	 * `data-glyphspek-authority` attribute on `.monaco-workbench`, and the companion CSS paints
	 * the ring (read=slate / claimed=amber / soft=violet / verified=blue / denied=red). We do
	 * NOT write that context-key or re-paint that ring: it tracks the focused run (the extension
	 * owns it), which is a DIFFERENT axis from this pane's row SELECTION, and the workbench must
	 * not set the extension's trust context-key. Instead we reflect CONSISTENTLY with it — a
	 * pane-scoped edge tint keyed off the SAME `AssuranceLevel` vocabulary and the SAME hues
	 * (authorityColor mirrors HALO_COLOR / the ring CSS), so the pane edge and the chrome ring
	 * speak the same color language without a parallel/competing trust signal.
	 *
	 * HONESTY (design §3): the tint reflects `authorityLevel` ONLY — the cap already lives in the
	 * data (Part A pre-caps SOFT→'soft', denied honest, just-opened→'read'); we render it
	 * faithfully and NEVER upgrade past it. No selection / no detail yet → neutral, no tint.
	 */
	private applyAuthorityTint(): void {
		const panes = this.panesEl;
		if (!panes) {
			return;
		}
		// Tint ONLY when a run is selected AND its detail (carrying the canonical authorityLevel)
		// has arrived — never tint ahead of the data, never infer a level from selection alone.
		const level: AssuranceLevel | undefined = (this.selectedRunId && this.selectedDetail)
			? this.selectedDetail.authorityLevel
			: undefined;
		if (level) {
			panes.setAttribute('data-gsh-authority', level);
			// Also expose the hue as a CSS var so the edge tint resolves without enumerating every
			// level in the stylesheet (faithful to authorityColor → HALO_COLOR / the ring CSS).
			panes.style.setProperty('--gsh-authority-color', authorityColor(level));
			// The honest authority label as a hover tooltip — the color is never the ONLY channel
			// (non-color redundancy, the same AUTHORITY_LABEL text the status bar surfaces).
			panes.title = localize('glyphspekHome.authorityTitle', "Authority halo: {0}", authorityLabel(level));
		} else {
			panes.removeAttribute('data-gsh-authority');
			panes.style.removeProperty('--gsh-authority-color');
			panes.title = '';
		}
	}

	/**
	 * RIGHT pane — Evidence (Slice 2, design §3 "Right — Evidence"). Binds to the selected
	 * run's AgentRunDetail (fetched via the provider's `glyphspek.runs.detail` consumer).
	 * Three stacked sections: Posture, Changes, Verdict. With no selection it shows the honest
	 * "select a run" placeholder (distinct from the in-run "no evidence yet" state). The view
	 * NEVER re-decides trust and NEVER fabricates evidence — it renders the projected facts.
	 */
	private renderEvidencePane(parent: HTMLElement): void {
		const section = append(parent, $('.gsh-section'));
		const sectionHead = append(section, $('.gsh-section-head'));
		sectionHead.textContent = localize('glyphspekHome.evidenceTitle', "Evidence");
		this.evidenceBody = append(section, $('.gsh-evidence-body'));
		this.renderEvidenceBody();
	}

	/** (Re)paint the Evidence pane for the current selection + last-fetched detail. */
	private renderEvidenceBody(): void {
		const body = this.evidenceBody;
		if (!body) {
			return;
		}
		clearNode(body);

		// Nothing selected → the honest "select a run" placeholder (distinct from "no evidence yet").
		if (!this.selectedRunId) {
			this.renderEvidencePlaceholder(
				body,
				localize('glyphspekHome.evidenceNone', "Select a run to see its evidence."),
				localize('glyphspekHome.evidenceNoneSub', "Its posture, changes, and signed verdict appear here.")
			);
			return;
		}

		// Selected but detail not yet fetched (in flight, or the fetch returned undefined).
		const detail = this.selectedDetail;
		if (!detail) {
			// Distinguish "extension not active" from a still-loading / unknown-run fetch.
			if (!this.runProvider.isExtensionActive()) {
				this.renderEvidencePlaceholder(
					body,
					localize('glyphspekHome.evidenceInactive', "GlyphSpek extension not active"),
					localize('glyphspekHome.evidenceInactiveSub', "Run evidence is owned by the GlyphSpek extension. Activate it in this window to load it here.")
				);
			} else {
				this.renderEvidencePlaceholder(
					body,
					localize('glyphspekHome.evidenceLoading', "Loading evidence…"),
					localize('glyphspekHome.evidenceLoadingSub', "Fetching the selected run's posture, changes, and verdict.")
				);
			}
			return;
		}

		// Identity header (compact) + the three §3 sections, in order: Posture, Changes, Verdict.
		this.renderEvidenceHeader(body, detail);
		this.renderPostureSection(body, detail);
		this.renderChangesSection(body, detail);
		this.renderVerdictSection(body, detail);
	}

	/** The honest non-evidence placeholder (no selection / loading / extension inactive). */
	private renderEvidencePlaceholder(parent: HTMLElement, title: string, sub: string): void {
		const empty = append(parent, $('.gsh-evidence-empty'));
		append(empty, this.icon('gs-verifier', 'gsh-empty-icon'));
		const text = append(empty, $('.gsh-empty-text'));
		const titleEl = append(text, $('.gsh-empty-title'));
		titleEl.textContent = title;
		const subEl = append(text, $('.gsh-empty-sub'));
		subEl.textContent = sub;
	}

	/** Compact identity header: run id + status (+ closed marker), actor. */
	private renderEvidenceHeader(parent: HTMLElement, detail: AgentRunDetail): void {
		const header = append(parent, $('.gsh-ev-header'));
		const idEl = append(header, $('.gsh-ev-run-id'));
		idEl.textContent = shortRunId(detail.id);
		const meta = append(header, $('.gsh-ev-run-meta'));
		// `detail.status` is a backend wire value (not localizable); the closed marker is a placeholder.
		const statusEl = append(meta, $('span.gsh-ev-status'));
		statusEl.textContent = detail.closed
			? localize('glyphspekHome.evidenceStatusClosed', "{0} (closed)", detail.status)
			: detail.status;
		const actorEl = append(meta, $('span.gsh-ev-actor'));
		actorEl.textContent = actorLabel(detail.actorType);
	}

	/** Open one Evidence section with an uppercase head + icon, returns the body container. */
	private openEvidenceSection(parent: HTMLElement, iconId: string, title: string): HTMLElement {
		const sec = append(parent, $('.gsh-ev-section'));
		const head = append(sec, $('.gsh-ev-section-head'));
		append(head, this.icon(iconId, 'gsh-ev-section-icon'));
		const titleEl = append(head, $('span'));
		titleEl.textContent = title;
		return append(sec, $('.gsh-ev-section-body'));
	}

	/**
	 * POSTURE section (design §3). Renders the creation-trust posture via the local trust-badge
	 * mirror, with honest SOFT framing. A SOFT / governed-unsandboxed posture is styled
	 * `.gsh-ev-posture-soft` (violet, NEVER trusted-blue) and carries the "SOFT — not contained"
	 * line; only a product-trust-ELIGIBLE posture wears the eligible accent (and even then it is
	 * "pending the signature gate" — the verdict section, not posture, decides blue).
	 */
	private renderPostureSection(parent: HTMLElement, detail: AgentRunDetail): void {
		const body = this.openEvidenceSection(parent, 'gs-sandbox', localize('glyphspekHome.evPosture', "Posture"));
		const eligible = productTrustEligible(detail.posture);
		const soft = detail.posture === 'governed-unsandboxed' || detail.posture === 'sandboxed-soft-egress';
		const cls = eligible ? 'gsh-ev-posture-eligible' : (soft ? 'gsh-ev-posture-soft' : 'gsh-ev-posture-plain');
		const card = append(body, $(`.gsh-ev-posture.${cls}`));
		const label = append(card, $('.gsh-ev-posture-label'));
		label.textContent = postureLabel(detail.posture);
		const note = append(card, $('.gsh-ev-posture-note'));
		note.textContent = postureFraming(detail.posture);
	}

	/**
	 * CHANGES section (design §3). Renders `changedFiles` (path + ± counts) and a native-DOM
	 * diff view (NOT the Monaco diff editor — a clean native rendering is correct for Slice 2).
	 * Labeled as the review surface, not a sandbox. Honest empty: "No changes" when none.
	 */
	private renderChangesSection(parent: HTMLElement, detail: AgentRunDetail): void {
		const body = this.openEvidenceSection(parent, 'gs-policy', localize('glyphspekHome.evChanges', "Changes"));
		if (detail.changedFiles.length === 0 && detail.diff.trim().length === 0) {
			const none = append(body, $('.gsh-ev-muted'));
			none.textContent = localize('glyphspekHome.evNoChanges', "No changes recorded for this run yet.");
			return;
		}

		if (detail.changedFiles.length > 0) {
			const fileList = append(body, $('.gsh-ev-files'));
			for (const file of detail.changedFiles) {
				this.renderChangedFile(fileList, file);
			}
		}

		if (detail.diff.trim().length > 0) {
			this.renderDiff(body, detail.diff);
			const caption = append(body, $('.gsh-ev-diff-caption'));
			caption.textContent = localize('glyphspekHome.evDiffCaption', "Review surface — the unified diff of the run's changes (not a sandbox).");
		}
	}

	/** One changed-file row: a status glyph, the path, and the ± counts when present. */
	private renderChangedFile(parent: HTMLElement, file: AgentRunChangedFile): void {
		const row = append(parent, $(`.gsh-ev-file.gsh-ev-file-${file.status}`));
		const glyph = append(row, $('span.gsh-ev-file-glyph'));
		glyph.textContent = file.status === 'added' ? '+' : file.status === 'deleted' ? '−' : '±';
		glyph.setAttribute('aria-hidden', 'true');
		const path = append(row, $('span.gsh-ev-file-path'));
		path.textContent = file.path;
		const counts = append(row, $('span.gsh-ev-file-counts'));
		if (typeof file.additions === 'number') {
			const add = append(counts, $('span.gsh-ev-add'));
			add.textContent = `+${file.additions}`;
		}
		if (typeof file.deletions === 'number') {
			const del = append(counts, $('span.gsh-ev-del'));
			del.textContent = `−${file.deletions}`;
		}
	}

	/**
	 * Render a unified git diff as a native-DOM, per-line diff view (NOT Monaco). Each line is
	 * classed by its leading character so added/removed/hunk/meta lines get honest styling. The
	 * text is set via textContent (never innerHTML — Trusted Types + no injection).
	 */
	private renderDiff(parent: HTMLElement, diff: string): void {
		const view = append(parent, $('.gsh-ev-diff'));
		const lines = diff.replace(/\r\n/g, '\n').split('\n');
		for (const line of lines) {
			const cls = diffLineClass(line);
			const lineEl = append(view, $(`.gsh-ev-diff-line.${cls}`));
			// A blank line keeps height via a zero-width space so the diff stays readable.
			lineEl.textContent = line.length > 0 ? line : '​';
		}
	}

	/**
	 * VERDICT section (design §3 + the NON-NEGOTIABLE signature/verdict honesty rules).
	 * The single door to verdict-BLUE: `detail.verified === true` AND the posture is
	 * product-trust-ELIGIBLE. Everything else is amber/red/degraded/empty — never blue.
	 *   - no verdict                                  → honest "No evidence yet".
	 *   - overall fail|error                          → RED (a denial outranks the verdict display).
	 *   - blue door open (verified + eligible)        → BLUE "verified · signed".
	 *   - signaturePresent but not verified           → AMBER "signature present · not verified".
	 *   - assurance degraded / a skipped check        → shown explicitly, NEVER a green PASS.
	 *   - otherwise (claimed, unverified pass)         → AMBER (claims are never green).
	 */
	private renderVerdictSection(parent: HTMLElement, detail: AgentRunDetail): void {
		const body = this.openEvidenceSection(parent, 'gs-verifier', localize('glyphspekHome.evVerdict', "Verdict"));
		const verdict = detail.verdict;
		if (!verdict) {
			// Honest "no verdict yet" — never a fabricated PASS. Distinct from "select a run".
			const none = append(body, $('.gsh-ev-muted'));
			none.textContent = localize('glyphspekHome.evNoVerdict', "No evidence yet — this run has no signed verifier verdict.");
			return;
		}

		// THE SINGLE BLUE DOOR — verified AND product-trust-eligible posture. A SOFT posture is
		// ineligible (productTrustEligible:false), so it can never be blue even if verified were true.
		const blueEligible = detail.verified === true && productTrustEligible(detail.posture);
		const failed = verdict.overall === 'fail' || verdict.overall === 'error';
		// Tone selection, honesty-first: a failed/errored verdict is RED and outranks the blue
		// door; only a passing verdict through the blue door is BLUE; everything else is AMBER.
		const tone: 'blue' | 'amber' | 'red' = failed ? 'red' : (blueEligible ? 'blue' : 'amber');

		const verdictCard = append(body, $(`.gsh-ev-verdict.gsh-ev-tone-${tone}`));

		// --- overall + assurance line ---
		const headline = append(verdictCard, $('.gsh-ev-verdict-headline'));
		const overallEl = append(headline, $('span.gsh-ev-verdict-overall'));
		overallEl.textContent = verdictOverallLabel(verdict.overall, tone);
		const assuranceEl = append(headline, $(`span.gsh-ev-assurance.gsh-ev-assurance-${verdict.assurance}`));
		assuranceEl.textContent = verdict.assurance === 'full'
			? localize('glyphspekHome.evAssuranceFull', "assurance: full")
			: localize('glyphspekHome.evAssuranceDegraded', "assurance: degraded");

		// --- signature state (presence ≠ trust) ---
		const sigEl = append(verdictCard, $('.gsh-ev-signature'));
		if (blueEligible) {
			sigEl.classList.add('gsh-ev-sig-verified');
			sigEl.textContent = localize('glyphspekHome.evSigVerified', "signature verified · product-trusted");
		} else if (verdict.signaturePresent) {
			// Presence is not trust — AMBER, never blue (honesty rule).
			sigEl.classList.add('gsh-ev-sig-present');
			sigEl.textContent = detail.verified
				// verified upstream but the posture is SOFT/ineligible → say so plainly.
				? localize('glyphspekHome.evSigSoftCap', "signature present · capped by soft posture (not product-trusted)")
				: localize('glyphspekHome.evSigUnverified', "signature present · not verified");
		} else {
			sigEl.classList.add('gsh-ev-sig-none');
			sigEl.textContent = localize('glyphspekHome.evSigNone', "no signature");
		}

		// --- isolation / command-source (sweep-47), only when present ---
		if (verdict.verifierIsolation || verdict.verifyCommandSource) {
			const provenance = append(verdictCard, $('.gsh-ev-verdict-provenance'));
			if (verdict.verifierIsolation) {
				const iso = append(provenance, $('span'));
				iso.textContent = verdict.verifierIsolation === 'independent-sandboxed'
					? localize('glyphspekHome.evIsoIndependent', "verifier: independent-sandboxed")
					: localize('glyphspekHome.evIsoInline', "verifier: inline-unsandboxed");
			}
			if (verdict.verifyCommandSource) {
				const src = append(provenance, $('span'));
				// `verifyCommandSource` is a backend enum value (not localizable); labeled inline.
				src.textContent = localize('glyphspekHome.evCmdSource', "checks: {0}", verdict.verifyCommandSource);
			}
		}

		// --- the checks list (incl. the SKIPPED marker — shown, never hidden) ---
		if (verdict.checks.length > 0) {
			const checkList = append(verdictCard, $('.gsh-ev-checks'));
			for (const check of verdict.checks) {
				this.renderCheck(checkList, check);
			}
		}

		// --- the bound trace root (carried, not re-verified here) ---
		if (verdict.traceRootHash) {
			const root = append(verdictCard, $('.gsh-ev-trace-root'));
			const rootLabel = append(root, $('span.gsh-ev-trace-label'));
			rootLabel.textContent = localize('glyphspekHome.evTraceRoot', "trace root");
			const rootValue = append(root, $('span.gsh-ev-trace-value'));
			rootValue.textContent = shortHash(verdict.traceRootHash);
			rootValue.title = verdict.traceRootHash; // full hash on hover; never truncated in data.
		}
	}

	/** One verifier check row: a status glyph + name. A SKIPPED check is shown explicitly, never green. */
	private renderCheck(parent: HTMLElement, check: AgentRunCheck): void {
		const row = append(parent, $(`.gsh-ev-check.gsh-ev-check-${check.status}`));
		const glyph = append(row, $('span.gsh-ev-check-glyph'));
		glyph.textContent = check.status === 'pass' ? '✓'
			: check.status === 'skipped' ? '—'
				: '✕'; // fail | error
		glyph.setAttribute('aria-hidden', 'true');
		const name = append(row, $('span.gsh-ev-check-name'));
		// `check.name` is a backend-supplied check identifier (not localizable).
		name.textContent = check.name;
		const status = append(row, $('span.gsh-ev-check-status'));
		status.textContent = check.status === 'skipped'
			? localize('glyphspekHome.evCheckSkipped', "skipped")
			: check.status;
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
		this.runsListBody = undefined;
		this.evidenceBody = undefined;
		this.composerBody = undefined;
		this.panesEl = undefined;
		this.selectedRunId = null;
		this.selectedDetail = undefined;
		this.detailFetchToken++; // invalidate any in-flight detail fetch.
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

/* ============================================================== *
 * EVIDENCE-PANE HONESTY HELPERS (pure, module-scoped)
 * ============================================================== *
 * These mirror the host trust labels (runTrustBadge.ts RUN_TRUST_BADGE) so the pane's
 * framing can never silently disagree with the sidebar/tree. They render facts only;
 * none of them DECIDE trust (the blue door is decided in renderVerdictSection against the
 * provider's productTrustEligible map + the canonical `verified` flag). */

/** The badge-style posture label. MIRRORS RUN_TRUST_BADGE[*].label / UNKNOWN_TRUST_BADGE.label. */
function postureLabel(posture: CreationTrustPosture): string {
	switch (posture) {
		case 'trusted': return localize('glyphspekHome.postureTrusted', "Trusted (pending gate)");
		case 'sandboxed-soft-egress': return localize('glyphspekHome.postureSandboxedSoft', "Sandboxed (soft egress)");
		case 'governed-unsandboxed': return localize('glyphspekHome.postureGovernedUnsandboxed', "Governed (soft) — unsandboxed");
		case 'untrusted': return localize('glyphspekHome.postureUntrusted', "Untrusted");
		case 'refused': return localize('glyphspekHome.postureRefused', "Refused");
		default: return localize('glyphspekHome.postureUnknown', "Starting…");
	}
}

/**
 * The honest framing line for a posture. The SOFT postures get the load-bearing
 * "SOFT — not contained / never product-trusted" framing (design §3 Posture rule); a
 * 'trusted' posture is framed as eligible-but-pending-the-gate (it is NOT itself blue —
 * the verdict's signature gate is). MIRRORS the RUN_TRUST_BADGE descriptions, condensed.
 */
function postureFraming(posture: CreationTrustPosture): string {
	switch (posture) {
		case 'trusted':
			return localize('glyphspekHome.postureFramingTrusted', "Hard isolation + hard egress reported. Eligible for a product-trusted verdict ONLY after the signature gate passes.");
		case 'sandboxed-soft-egress':
			return localize('glyphspekHome.postureFramingSandboxedSoft', "SOFT — not contained. Isolation runtime, but the egress boundary is soft. Never product-trusted.");
		case 'governed-unsandboxed':
			return localize('glyphspekHome.postureFramingGovernedUnsandboxed', "SOFT — not contained. Governed + traced via the metadata-only egress proxy, but unsandboxed. Never product-trusted.");
		case 'untrusted':
			return localize('glyphspekHome.postureFramingUntrusted', "No trusted runtime could be established. Cannot be product-trusted.");
		case 'refused':
			return localize('glyphspekHome.postureFramingRefused', "The supervisor refused to create the run. No trusted run was produced.");
		default:
			return localize('glyphspekHome.postureFramingUnknown', "Trust posture not settled yet (no RunOpened observed).");
	}
}

/** The verdict overall label, toned. A passing verdict OUTSIDE the blue door is still "pass (unverified)". */
function verdictOverallLabel(overall: 'pass' | 'fail' | 'error', tone: 'blue' | 'amber' | 'red'): string {
	switch (overall) {
		case 'fail': return localize('glyphspekHome.verdictFail', "verdict: fail");
		case 'error': return localize('glyphspekHome.verdictError', "verdict: error");
		default:
			// A 'pass' is only an UNQUALIFIED pass through the blue door; otherwise it is a claim.
			return tone === 'blue'
				? localize('glyphspekHome.verdictPass', "verdict: pass")
				: localize('glyphspekHome.verdictPassUnverified', "verdict: pass (unverified)");
	}
}

/** Classify a unified-diff line for honest native-DOM styling (no Monaco). */
function diffLineClass(line: string): string {
	if (line.startsWith('+++') || line.startsWith('---')) {
		return 'gsh-ev-diff-meta'; // file headers — before the +/- body lines.
	}
	if (line.startsWith('@@')) {
		return 'gsh-ev-diff-hunk';
	}
	if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('similarity ')) {
		return 'gsh-ev-diff-meta';
	}
	if (line.startsWith('+')) {
		return 'gsh-ev-diff-add';
	}
	if (line.startsWith('-')) {
		return 'gsh-ev-diff-del';
	}
	return 'gsh-ev-diff-ctx';
}

/** Shorten a hash for display (full value preserved in the title attr; never truncated in data). */
function shortHash(hash: string): string {
	return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : hash;
}
