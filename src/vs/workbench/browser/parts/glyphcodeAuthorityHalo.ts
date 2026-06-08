/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/glyphcodeAuthorityHalo.css';
import { localize } from '../../../nls.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchLayoutService } from '../../services/layout/browser/layoutService.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../common/contributions.js';

/**
 * GlyphCode Authority Halo (PATCH-003).
 *
 * Paints the whole-workbench chrome — a thin border ring + outer glow, on an
 * optional floating-frame substrate — colored by the *assurance* of the focused
 * governed run. This is the element that makes the IDE read as "the demo".
 *
 * Mechanism (read-only): the GlyphCode first-party extension sets the
 * `glyphcode.authority` context-key (`read | claimed | soft | verified | denied`,
 * default `read`) on every assurance change. This contribution observes that key
 * and mirrors it to a `data-glyphcode-authority` attribute on the `.monaco-workbench`
 * root element, which the companion CSS keys off of for the ring color/glow.
 *
 * It NEVER computes or re-derives trust. It only READS the assurance the extension
 * already computed honestly and PAINTS chrome — it cannot change trust state, grant
 * authority, or make a SOFT run read as verified-blue (the extension only sets
 * `verified` on a signature-verified product verdict; this consumes that, it does not
 * re-decide). The ring is ambient signal, not a modal and not a grant.
 *
 * An extension cannot do this: the outer `.monaco-workbench` frame chrome is workbench
 * layout, not reachable by any extension surface (a webview is confined to its own
 * rect). See `SECURITY-PATCHES.md` PATCH-003.
 */

/** The context-key the GlyphCode extension writes the focused-run assurance to. */
const AUTHORITY_CONTEXT_KEY = 'glyphcode.authority';

/** The attribute the companion CSS keys the ring color/glow off of. */
const AUTHORITY_ATTRIBUTE = 'data-glyphcode-authority';

/** The class that opts the workbench root into the floating-frame substrate look. */
const FLOATING_FRAME_CLASS = 'glyphcode-floating-frame';

/** The class that disables the halo motion (pulse + cross-fade), keeping static color. */
const REDUCE_MOTION_CLASS = 'glyphcode-halo-reduce-motion';

const FLOATING_FRAME_SETTING = 'glyphcode.workbench.floatingFrame';
const HALO_MOTION_SETTING = 'glyphcode.workbench.haloMotion';

/** The honest assurance vocabulary. Anything else (or unset) is treated as `read`. */
const KNOWN_AUTHORITIES = new Set<string>(['read', 'claimed', 'soft', 'verified', 'denied']);
const DEFAULT_AUTHORITY = 'read';

export class GlyphCodeAuthorityHaloContribution extends Disposable {

	static readonly ID = 'workbench.contrib.glyphcodeAuthorityHalo';

	private readonly contextKeySet = new Set<string>([AUTHORITY_CONTEXT_KEY]);

	private lastAuthority: string | undefined;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();

		// Initial paint from whatever the extension has already published (or the
		// neutral `read` default if it has not set the key yet).
		this.applyAuthority(this.readAuthority());
		this.applyFloatingFrame();
		this.applyHaloMotion();

		// React to assurance changes (the extension flips the context-key).
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(this.contextKeySet)) {
				this.applyAuthority(this.readAuthority());
			}
		}));

		// React to the two GlyphCode workbench settings.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(FLOATING_FRAME_SETTING)) {
				this.applyFloatingFrame();
			}
			if (e.affectsConfiguration(HALO_MOTION_SETTING)) {
				this.applyHaloMotion();
			}
		}));
	}

	private get root(): HTMLElement {
		return this.layoutService.mainContainer;
	}

	private readAuthority(): string {
		const raw = this.contextKeyService.getContextKeyValue<string>(AUTHORITY_CONTEXT_KEY);
		return raw && KNOWN_AUTHORITIES.has(raw) ? raw : DEFAULT_AUTHORITY;
	}

	private applyAuthority(authority: string): void {
		if (authority === this.lastAuthority) {
			return;
		}

		const previous = this.lastAuthority;
		this.lastAuthority = authority;
		this.root.setAttribute(AUTHORITY_ATTRIBUTE, authority);

		// `denied` is a one-shot pulse. Re-arm it only on an actual *transition into*
		// `denied`, so re-rendering the same state never re-fires the alarm. We toggle
		// a marker class off-then-on across a reflow so the keyframe animation restarts.
		if (authority === 'denied' && previous !== 'denied') {
			this.root.classList.remove('glyphcode-halo-deny-pulse');
			// Force a reflow so the animation can be re-triggered.
			void this.root.offsetWidth;
			this.root.classList.add('glyphcode-halo-deny-pulse');
		} else if (authority !== 'denied') {
			this.root.classList.remove('glyphcode-halo-deny-pulse');
		}
	}

	private applyFloatingFrame(): void {
		// Default ON to match the demo; user-toggleable. The RING reflects assurance
		// regardless of this setting — this only governs the substrate/rounded-frame look.
		const on = this.configurationService.getValue<boolean>(FLOATING_FRAME_SETTING) !== false;
		this.root.classList.toggle(FLOATING_FRAME_CLASS, on);
	}

	private applyHaloMotion(): void {
		// Motion ON unless the user disables it. `prefers-reduced-motion` is also
		// honored in CSS independently, so either path disables the pulse + cross-fade.
		const on = this.configurationService.getValue<boolean>(HALO_MOTION_SETTING) !== false;
		this.root.classList.toggle(REDUCE_MOTION_CLASS, !on);
	}

	override dispose(): void {
		// Clean rollback: drop the attribute + every class this contribution added.
		const root = this.root;
		root.removeAttribute(AUTHORITY_ATTRIBUTE);
		root.classList.remove(FLOATING_FRAME_CLASS, REDUCE_MOTION_CLASS, 'glyphcode-halo-deny-pulse');
		super.dispose();
	}
}

registerWorkbenchContribution2(GlyphCodeAuthorityHaloContribution.ID, GlyphCodeAuthorityHaloContribution, WorkbenchPhase.AfterRestored);

// GlyphCode workbench settings backing the halo + floating frame.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'glyphcode',
	order: 8,
	title: localize('glyphcodeWorkbenchConfigurationTitle', "GlyphCode"),
	type: 'object',
	properties: {
		[FLOATING_FRAME_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('glyphcode.workbench.floatingFrame', "Float the workbench on a dark substrate with rounded corners so the Authority Halo ring has somewhere to glow. The halo ring reflects run assurance regardless of this setting.")
		},
		[HALO_MOTION_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('glyphcode.workbench.haloMotion', "Animate Authority Halo transitions (the calm color cross-fade and the one-shot deny pulse). When off, the halo keeps its static assurance color with no animation. The OS \"reduce motion\" preference also disables these animations.")
		}
	}
});
