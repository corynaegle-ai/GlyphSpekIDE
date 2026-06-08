/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/glyphcodeTierChrome.css';
import { localize } from '../../../nls.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchLayoutService } from '../../services/layout/browser/layoutService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../common/contributions.js';

/**
 * GlyphCode Tier Chrome (PATCH-008) — the FRICTION axis, sibling to the Authority Halo.
 *
 * Where the halo (PATCH-003) paints the *assurance* axis (read | claimed | soft |
 * verified | denied) as a whole-frame ring, this contribution reflects the *friction*
 * axis — the five-rung Authority Ladder tier (ask | inline | governed | sensitive |
 * sovereign) from BLENDED-WORKBENCH-SPEC §6. The two axes are deliberately ORTHOGONAL
 * (§2.1): this file NEVER reads or writes `glyphcode.authority`, and the halo never
 * reads `glyphcode.tier`. They are kept in separate files so that separation is legible
 * at the source level.
 *
 * The visible payoff in this increment (§5.5.1): at the **Ask** tier the CENTER EDITOR
 * AREA *recedes* — grayscale + reduced opacity + a subtle translucent scrim — so the
 * lowest authority tier *feels* genuinely light. Receding the editor REDUCES perceived
 * authority; it adds no friction and confers no trust. It is purely the friction-axis
 * cue and never touches the assurance halo.
 *
 * Mechanism (read-only, mirrors the halo exactly): the GlyphCode first-party extension
 * sets the `glyphcode.tier` context-key on every effective-tier change (its Trust Panel
 * Authority Ladder is a VIEW control; the promote modal remains the only authority door).
 * This contribution observes that key and mirrors it to a `data-glyphcode-tier` attribute
 * on the `.monaco-workbench` root, which the companion CSS keys off of — scoped to the
 * editor part (`.part.editor`) only.
 *
 * An extension cannot do this: the editor part chrome is workbench layout, not reachable
 * by any extension surface (a webview is confined to its own rect). See
 * `SECURITY-PATCHES.md` PATCH-008.
 */

/** The context-key the GlyphCode extension writes the effective friction tier to. */
const TIER_CONTEXT_KEY = 'glyphcode.tier';

/** The attribute the companion CSS keys the editor-recede off of. */
const TIER_ATTRIBUTE = 'data-glyphcode-tier';

/** The class that opts the editor-recede out (so the user can disable the cue). */
const RECEDE_OFF_CLASS = 'glyphcode-tier-recede-off';

// REDUCED MOTION is handled entirely in the companion CSS: the OS `prefers-reduced-motion`
// media query AND the shared `glyphcode-halo-reduce-motion` class that the Authority Halo
// contribution toggles from the `glyphcode.workbench.haloMotion` setting. A single user/OS
// preference therefore quiets BOTH GlyphCode chrome motions, so this contribution does not
// re-toggle that class itself (the halo owns it) — it just relies on it in CSS.

const ASK_RECEDE_SETTING = 'glyphcode.workbench.askEditorRecede';

/** The honest friction vocabulary (§6). Anything else (or unset) is treated as `governed`. */
const KNOWN_TIERS = new Set<string>(['ask', 'inline', 'governed', 'sensitive', 'sovereign']);
const DEFAULT_TIER = 'governed';

export class GlyphCodeTierChromeContribution extends Disposable {

	static readonly ID = 'workbench.contrib.glyphcodeTierChrome';

	private readonly contextKeySet = new Set<string>([TIER_CONTEXT_KEY]);

	private lastTier: string | undefined;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();

		// Initial paint from whatever the extension has already published (or the
		// neutral `governed` default if it has not set the key yet — i.e. no recede).
		this.applyTier(this.readTier());
		this.applyAskRecedeSetting();

		// React to friction-tier changes (the extension flips the context-key).
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(this.contextKeySet)) {
				this.applyTier(this.readTier());
			}
		}));

		// React to the recede toggle setting.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ASK_RECEDE_SETTING)) {
				this.applyAskRecedeSetting();
			}
		}));
	}

	private get root(): HTMLElement {
		return this.layoutService.mainContainer;
	}

	private readTier(): string {
		const raw = this.contextKeyService.getContextKeyValue<string>(TIER_CONTEXT_KEY);
		return raw && KNOWN_TIERS.has(raw) ? raw : DEFAULT_TIER;
	}

	private applyTier(tier: string): void {
		if (tier === this.lastTier) {
			return;
		}
		this.lastTier = tier;
		this.root.setAttribute(TIER_ATTRIBUTE, tier);
	}

	private applyAskRecedeSetting(): void {
		// Default ON to match the spec (Ask should feel light). When the user turns it
		// off we add an opt-out class the CSS uses to suppress the recede — the tier
		// attribute still reflects the friction axis for any other future cue.
		const on = this.configurationService.getValue<boolean>(ASK_RECEDE_SETTING) !== false;
		this.root.classList.toggle(RECEDE_OFF_CLASS, !on);
	}

	override dispose(): void {
		// Clean rollback: drop the attribute + the opt-out class this contribution added.
		// The shared reduce-motion class is owned by the Authority Halo; we never remove it.
		const root = this.root;
		root.removeAttribute(TIER_ATTRIBUTE);
		root.classList.remove(RECEDE_OFF_CLASS);
		super.dispose();
	}
}

registerWorkbenchContribution2(GlyphCodeTierChromeContribution.ID, GlyphCodeTierChromeContribution, WorkbenchPhase.AfterRestored);

// GlyphCode workbench setting backing the Ask editor-recede. Registered under the same
// `glyphcode` configuration id as the halo settings so they group in Settings UI.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'glyphcode',
	order: 8,
	title: localize('glyphcodeWorkbenchConfigurationTitle', "GlyphCode"),
	type: 'object',
	properties: {
		[ASK_RECEDE_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('glyphcode.workbench.askEditorRecede', "At the Ask friction tier, let the center editor recede (grayscale, dimmed, with a translucent scrim) so the lowest-authority tier feels light. This is a purely visual friction cue — it never alters layout, never traps interaction, and never implies a trust or assurance state.")
		}
	}
});
