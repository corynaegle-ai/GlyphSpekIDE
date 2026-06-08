/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/glyphstudioTitleLadder.css';
import { localize } from '../../../nls.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { mainWindow } from '../../../base/browser/window.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IWorkbenchLayoutService, Parts } from '../../services/layout/browser/layoutService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../common/contributions.js';

/**
 * GlyphStudio Title-bar Authority Ladder (PATCH-009) — the canonical FRICTION control.
 *
 * Promotes the five-rung friction ladder (ask | inline | governed | sensitive |
 * sovereign — BLENDED-WORKBENCH-SPEC §5.2.2 / §6) out of the Trust Panel webview and
 * into the workbench TITLE BAR, where the design source puts it. It is the title-bar
 * sibling of the Authority Halo (PATCH-003, assurance axis) and the Tier Chrome
 * (PATCH-008, the Ask editor-recede). The three are deliberately separate files so the
 * two-axis split (§2.1) is legible at the source level.
 *
 * TWO AXES, NEVER CONFLATED (§2.1, §7):
 *   - FRICTION (this widget's job): the active RUNG is driven by `glyphstudio.tier`.
 *   - ASSURANCE (borrowed for TINT ONLY): the level chip's color + label come from
 *     `glyphstudio.authority` (the same halo color map). The ladder NEVER sets, derives,
 *     or implies assurance — sliding a rung does not make a verified run unverified,
 *     and selecting "Governed" confers no trust. The halo owns the assurance axis.
 *
 * VIEW-ONLY HONESTY (§6, §2.4 "tier is enforced authority, not a UI hint"): clicking a
 * rung changes FRICTION / which evidence is visible — it does NOT grant authority. The
 * promote modal (glyphstudio.promoteChatToBuild) remains the only authority door. The
 * native rung click invokes the `glyphstudio.setTier` COMMAND (the single writer of the
 * `glyphstudio.tier` context-key, which also syncs the webview ladder). This widget never
 * writes the context-key itself — it only READS it for the active rung and INVOKES the
 * command on click, so there is exactly one source of truth (the extension).
 *
 * An extension cannot do this: the title-bar center region is workbench chrome, not
 * reachable by any extension surface (a webview is confined to its own rect). See
 * `SECURITY-PATCHES.md` PATCH-009.
 */

/** The context-key the GlyphStudio extension writes the effective friction tier to. */
const TIER_CONTEXT_KEY = 'glyphstudio.tier';

/** The context-key the GlyphStudio extension writes the focused-run assurance to. */
const AUTHORITY_CONTEXT_KEY = 'glyphstudio.authority';

/** The command (owned by the extension) that is the SINGLE writer of the tier key. */
const SET_TIER_COMMAND = 'glyphstudio.setTier';

/** The setting that toggles the whole widget (default ON). */
const TITLE_LADDER_SETTING = 'glyphstudio.workbench.titleLadder';

/** Neutral, honest actor placeholder when no actor is bound (no fabricated name). */
const NO_ACTOR_LABEL = localize('glyphstudio.actor.none', "No actor bound");

/** The honest friction vocabulary (§6). Anything else (or unset) is treated as `governed`. */
const KNOWN_TIERS = ['ask', 'inline', 'governed', 'sensitive', 'sovereign'] as const;
type Tier = typeof KNOWN_TIERS[number];
const DEFAULT_TIER: Tier = 'governed';

/** The honest assurance vocabulary (§7). Anything else (or unset) is treated as `read`. */
const KNOWN_AUTHORITIES = new Set<string>(['read', 'claimed', 'soft', 'verified', 'denied']);
const DEFAULT_AUTHORITY = 'read';

/**
 * Per-tier rung label (§5.2.2 / the design source's ladder). Title-style, short. These
 * are the FRICTION labels; they never describe assurance.
 */
const TIER_LABELS: Record<Tier, string> = {
	ask: localize('glyphstudio.ladder.ask', "Ask"),
	inline: localize('glyphstudio.ladder.inline', "Inline Edit"),
	governed: localize('glyphstudio.ladder.governed', "Governed Run"),
	sensitive: localize('glyphstudio.ladder.sensitive', "Sensitive"),
	sovereign: localize('glyphstudio.ladder.sovereign', "Sovereign")
};

/**
 * Non-color redundancy for the level chip (§3.4): a glyph + short label per assurance
 * state so the chip's meaning survives grayscale / color-blindness. Mirrors the
 * webview's AUTHORITY_CHIP map verbatim so the two views read identically.
 */
const AUTHORITY_CHIP: Record<string, { glyph: string; label: string }> = {
	read: { glyph: '•', label: localize('glyphstudio.lvl.read', "read · no authority yet") },
	claimed: { glyph: '◇', label: localize('glyphstudio.lvl.claimed', "claimed · self-reported, unverified") },
	soft: { glyph: '◈', label: localize('glyphstudio.lvl.soft', "SOFT · governed-unsandboxed") },
	verified: { glyph: '✓', label: localize('glyphstudio.lvl.verified', "verified · signed") },
	denied: { glyph: '✕', label: localize('glyphstudio.lvl.denied', "UNTRUSTED · denied") }
};

export class GlyphStudioTitleLadderContribution extends Disposable {

	static readonly ID = 'workbench.contrib.glyphstudioTitleLadder';

	private readonly contextKeySet = new Set<string>([TIER_CONTEXT_KEY, AUTHORITY_CONTEXT_KEY]);

	/** Disposables for the currently-mounted widget (cleared on re-mount/teardown). */
	private readonly widgetDisposables = this._register(new DisposableStore());

	private container: HTMLElement | undefined;
	private rungs: Map<Tier, HTMLElement> | undefined;
	private actorMini: HTMLElement | undefined;
	private levelChip: HTMLElement | undefined;

	private currentTier: Tier = DEFAULT_TIER;
	private currentAuthority: string = DEFAULT_AUTHORITY;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		this.currentTier = this.readTier();
		this.currentAuthority = this.readAuthority();

		this.applyEnabled();

		// React to friction-tier + assurance changes (the extension flips the keys).
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(this.contextKeySet)) {
				this.currentTier = this.readTier();
				this.currentAuthority = this.readAuthority();
				this.render();
			}
		}));

		// React to the enable/disable setting.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TITLE_LADDER_SETTING)) {
				this.applyEnabled();
			}
		}));

		// The title-bar center can be recreated (command-center toggle) or the part can
		// be hidden/shown. Re-mount idempotently whenever the title-bar visibility
		// changes, and self-heal if our node has been detached from the (recreated) center.
		this._register(this.layoutService.onDidChangePartVisibility(e => {
			if (e.partId === Parts.TITLEBAR_PART) {
				this.applyEnabled();
			}
		}));
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(TITLE_LADDER_SETTING) !== false;
	}

	private readTier(): Tier {
		const raw = this.contextKeyService.getContextKeyValue<string>(TIER_CONTEXT_KEY);
		return raw && (KNOWN_TIERS as readonly string[]).includes(raw) ? raw as Tier : DEFAULT_TIER;
	}

	private readAuthority(): string {
		const raw = this.contextKeyService.getContextKeyValue<string>(AUTHORITY_CONTEXT_KEY);
		return raw && KNOWN_AUTHORITIES.has(raw) ? raw : DEFAULT_AUTHORITY;
	}

	/** The title-bar center region for the main window, if the part is materialized. */
	private get titlebarCenter(): HTMLElement | undefined {
		const titlebar = this.layoutService.getContainer(mainWindow, Parts.TITLEBAR_PART);
		const center = titlebar?.querySelector<HTMLElement>('.titlebar-center');
		return center ?? undefined;
	}

	/** Mount when enabled (and the title-bar exists), tear down otherwise. Idempotent. */
	private applyEnabled(): void {
		if (!this.enabled) {
			this.teardown();
			return;
		}
		const center = this.titlebarCenter;
		if (!center) {
			// Title bar not materialized yet (e.g. native title-bar style). Nothing to
			// mount onto; a later visibility change re-invokes this. No fork crash.
			return;
		}
		// Self-heal: if our widget was detached by a center recreation, rebuild it.
		if (!this.container || !center.contains(this.container)) {
			this.mount(center);
		} else {
			this.render();
		}
	}

	private mount(center: HTMLElement): void {
		this.teardown();

		// The widget: an actor-mini chip, the five-rung radiogroup, and the level chip.
		const root = append(center, $('.glyphstudio-title-ladder'));
		this.container = root;

		// actor-mini: which actor/model is bound. Read honestly — if no actor context-key
		// is present we show a neutral placeholder rather than inventing a bound actor.
		this.actorMini = append(root, $('span.glyphstudio-tl-actor'));
		this.actorMini.setAttribute('aria-hidden', 'false');

		// The ladder radiogroup (ARIA mirrors the webview ladder's pattern).
		const ladder = append(root, $('.glyphstudio-tl-ladder'));
		ladder.setAttribute('role', 'radiogroup');
		ladder.setAttribute('aria-label', localize('glyphstudio.ladder.aria', "Authority ladder — choose which evidence to view (does not grant authority)"));

		this.rungs = new Map<Tier, HTMLElement>();
		for (const tier of KNOWN_TIERS) {
			const rung = append(ladder, $('button.glyphstudio-tl-rung'));
			rung.setAttribute('type', 'button');
			rung.setAttribute('role', 'radio');
			rung.setAttribute('data-tier', tier);
			rung.setAttribute('aria-checked', 'false');
			rung.setAttribute('tabindex', '-1');
			rung.textContent = TIER_LABELS[tier];
			this.rungs.set(tier, rung);
		}

		// Click: select a rung (a VIEW control). Invoke the extension's setTier command —
		// the single writer of the context-key. We do NOT mutate the key ourselves.
		this.widgetDisposables.add(addDisposableListener(ladder, EventType.CLICK, e => {
			const target = e.target as HTMLElement | null;
			const rung = target?.closest?.('.glyphstudio-tl-rung') as HTMLElement | null;
			const tier = rung?.getAttribute('data-tier');
			if (tier && (KNOWN_TIERS as readonly string[]).includes(tier)) {
				this.requestTier(tier as Tier);
			}
		}));

		// Keyboard: the ARIA radiogroup pattern, mirroring the webview ladder exactly.
		// Left/Up = previous, Right/Down = next (wrapping), Home/End = first/last,
		// Space/Enter = select the focused rung.
		this.widgetDisposables.add(addDisposableListener(ladder, EventType.KEY_DOWN, e => {
			const key = (e as KeyboardEvent).key;
			let idx = KNOWN_TIERS.indexOf(this.currentTier);
			if (idx === -1) {
				idx = KNOWN_TIERS.indexOf(DEFAULT_TIER);
			}
			let next: number | null = null;
			if (key === 'ArrowRight' || key === 'ArrowDown') {
				next = (idx + 1) % KNOWN_TIERS.length;
			} else if (key === 'ArrowLeft' || key === 'ArrowUp') {
				next = (idx - 1 + KNOWN_TIERS.length) % KNOWN_TIERS.length;
			} else if (key === 'Home') {
				next = 0;
			} else if (key === 'End') {
				next = KNOWN_TIERS.length - 1;
			} else if (key === ' ' || key === 'Enter' || key === 'Spacebar') {
				next = idx;
			}
			if (next !== null) {
				e.preventDefault();
				this.requestTier(KNOWN_TIERS[next]);
			}
		}));

		// The level chip: assurance label, COLORED by the halo color map (tint only).
		this.levelChip = append(root, $('span.glyphstudio-tl-level'));

		this.render();
	}

	/**
	 * Ask the extension to re-tier the workbench. This is the ONLY mutation path: the
	 * extension's `glyphstudio.setTier` command validates the tier, sets the context-key
	 * (the single writer), and syncs the webview ladder. View-only — confers no authority.
	 * If the command is not registered yet (extension still activating), the click is a
	 * harmless no-op; the next context-key change re-renders us into sync.
	 */
	private requestTier(tier: Tier): void {
		// Optimistically focus the rung so keyboard roving feels responsive; the real
		// active state still comes from the context-key the command sets (one source).
		this.focusRung(tier);
		this.commandService.executeCommand(SET_TIER_COMMAND, tier).then(undefined, err => {
			// Honest failure: do not fake a tier change the extension never accepted.
			this.logService.trace(`[glyphstudio] ${SET_TIER_COMMAND} unavailable (extension activating?): ${err}`);
		});
	}

	/** Reflect the current tier (active rung + ARIA) and authority (level chip) into the DOM. */
	private render(): void {
		if (!this.container || !this.rungs) {
			return;
		}

		// Active rung + ARIA radio state + roving tabindex (one tab stop on the checked rung).
		for (const [tier, rung] of this.rungs) {
			const active = tier === this.currentTier;
			rung.classList.toggle('active', active);
			rung.setAttribute('aria-checked', active ? 'true' : 'false');
			rung.setAttribute('tabindex', active ? '0' : '-1');
		}

		// The active rung borrows the halo color for TINT (the two axes meet visually
		// here but the rung still only selects friction). Mirror the authority as a data
		// attribute so the companion CSS picks the right --glyphstudio-tl-halo tint.
		this.container.setAttribute('data-glyphstudio-tier', this.currentTier);
		this.container.setAttribute('data-glyphstudio-authority', this.currentAuthority);

		// The level chip: assurance glyph + label (non-color redundancy, §3.4). Colored
		// by the halo map purely for tint; the chip never re-decides trust.
		if (this.levelChip) {
			const chip = AUTHORITY_CHIP[this.currentAuthority] ?? AUTHORITY_CHIP.read;
			this.levelChip.setAttribute('data-glyph', chip.glyph);
			this.levelChip.textContent = chip.label;
		}

		// actor-mini: read an actor/model context-key if present, else a neutral, HONEST
		// placeholder. We never invent a specific bound actor that the broker has not set.
		if (this.actorMini) {
			const actor = this.readBoundActor();
			this.actorMini.textContent = actor;
			this.actorMini.classList.toggle('glyphstudio-tl-actor-none', actor === NO_ACTOR_LABEL);
		}
	}

	/**
	 * The bound actor, read honestly from an optional context-key the model broker may
	 * set. No key (or empty) → a neutral placeholder, never a fabricated actor name.
	 */
	private readBoundActor(): string {
		const raw = this.contextKeyService.getContextKeyValue<string>('glyphstudio.actor');
		const trimmed = typeof raw === 'string' ? raw.trim() : '';
		return trimmed.length > 0 ? trimmed : NO_ACTOR_LABEL;
	}

	private focusRung(tier: Tier): void {
		const rung = this.rungs?.get(tier);
		rung?.focus();
	}

	private teardown(): void {
		this.widgetDisposables.clear();
		this.container?.remove();
		this.container = undefined;
		this.rungs = undefined;
		this.actorMini = undefined;
		this.levelChip = undefined;
	}

	override dispose(): void {
		// Clean rollback: remove the widget entirely. The shared reduce-motion class is
		// owned by the Authority Halo; we never add or remove it.
		this.teardown();
		super.dispose();
	}
}

registerWorkbenchContribution2(GlyphStudioTitleLadderContribution.ID, GlyphStudioTitleLadderContribution, WorkbenchPhase.AfterRestored);

// GlyphStudio workbench setting backing the title-bar Authority Ladder. Registered under
// the same `glyphstudio` configuration id as the halo + tier-chrome settings so they group.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'glyphstudio',
	order: 8,
	title: localize('glyphstudioWorkbenchConfigurationTitle', "GlyphStudio"),
	type: 'object',
	properties: {
		[TITLE_LADDER_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('glyphstudio.workbench.titleLadder', "Show the Authority Ladder (the five-rung friction control: Ask → Inline → Governed → Sensitive → Sovereign) in the title bar. Selecting a rung changes which evidence is visible — it is a view-only friction control and never grants authority or changes a run's verified assurance.")
		}
	}
});
