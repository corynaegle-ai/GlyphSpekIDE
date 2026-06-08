/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorSerializer, EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { GlyphspekHomePage } from './glyphcodeHome.js';
import { GlyphspekHomeInput, glyphcodeHomeInputTypeId } from './glyphcodeHomeInput.js';

/** Setting that controls whether GlyphCode Home auto-opens when the editor area would be empty. */
const OPEN_ON_STARTUP_SETTING = 'glyphcode.home.openOnStartup';

/** Command id for re-opening Home (palette: "GlyphCode: Open Home"). */
const OPEN_HOME_COMMAND_ID = 'glyphcode.home.open';

// ---- EditorInput serializer: lets a pinned/persisted Home tab survive a window reload. ----
class GlyphspekHomeInputSerializer implements IEditorSerializer {
	canSerialize(): boolean {
		return true;
	}
	serialize(): string {
		return '{}';
	}
	deserialize(instantiationService: IInstantiationService): GlyphspekHomeInput {
		return instantiationService.createInstance(GlyphspekHomeInput);
	}
}

// ---- Register the editor pane + input + serializer. ----
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(GlyphspekHomeInput.ID, GlyphspekHomeInputSerializer);
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		GlyphspekHomePage,
		GlyphspekHomePage.ID,
		localize('glyphcodeHome', "GlyphCode Home")
	),
	[
		new SyncDescriptor(GlyphspekHomeInput)
	]
);

// ---- "GlyphCode: Open Home" command. ----
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_HOME_COMMAND_ID,
			title: localize2('glyphcodeHome.open', 'Open Home'),
			category: Categories.View,
			f1: true,
			// "Back to Home" chord. Verified unused: Cmd+K Cmd+H is the Output panel, so use
			// Cmd+K Cmd+G ("G" for GlyphCode), which has no default binding on any platform.
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyG)
			},
			metadata: {
				description: localize2('glyphcodeHome.open.desc', 'Open the GlyphCode Home surface — start a governed run and reach the governance surfaces.')
			}
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		// revealIfOpened via IEditorService: a single Home tab, focused if already open.
		await editorService.openEditor(instantiationService.createInstance(GlyphspekHomeInput), { pinned: false, revealIfOpened: true });
	}
});

// ---- Discoverable "back to Home" entry in the View menu (beyond the palette + keybinding). ----
MenuRegistry.appendMenuItem(MenuId.MenubarViewMenu, {
	group: '1_open',
	command: {
		id: OPEN_HOME_COMMAND_ID,
		title: localize({ key: 'miGlyphspekHome', comment: ['&& denotes a mnemonic'] }, "GlyphCode &&Home")
	},
	order: 2
});

/**
 * Resolves the Home resource scheme to the Home editor, so reopening the persisted resource
 * (e.g. after a reload) maps back to the Home pane. Mirrors `StartupPageEditorResolverContribution`.
 */
class GlyphspekHomeEditorResolverContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.glyphcodeHomeEditorResolver';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorResolverService editorResolverService: IEditorResolverService
	) {
		super();

		this._register(editorResolverService.registerEditor(
			`${GlyphspekHomeInput.RESOURCE.scheme}:/**`,
			{
				id: GlyphspekHomeInput.ID,
				label: localize('glyphcodeHome.displayName', "GlyphCode Home"),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				singlePerResource: true,
				canSupportResource: uri => uri.scheme === GlyphspekHomeInput.RESOURCE.scheme && uri.authority === GlyphspekHomeInput.RESOURCE.authority,
			},
			{
				createEditorInput: () => ({
					editor: instantiationService.createInstance(GlyphspekHomeInput),
					options: { pinned: false }
				})
			}
		));
	}
}

/**
 * Lands the IDE on GlyphCode Home on every fresh app launch — the way an agent-home IDE opens to
 * its home rather than to last session's panes. Modeled on `StartupPageRunnerContribution`: waits
 * for `Restored`, then (behind `glyphcode.home.openOnStartup`, default ON) opens Home as the
 * active editor. Restored editors stay open as tabs behind Home; Home is opened additively and
 * focused, never replacing them. On a window reload Home is not forced to the foreground, so
 * reloading mid-work to test a build never steals focus from the user's active editor.
 *
 * Honesty/scope note: this does NOT touch `product.json` or `workbench.startupEditor`. It is an
 * additive, settings-gated startup contribution that coexists with the stock Welcome page — if the
 * user disables the setting, Home does not force itself open.
 */
class GlyphspekHomeStartupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.glyphcodeHomeStartup';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService
	) {
		super();
		this.run().then(undefined, onUnexpectedError);
	}

	private async run(): Promise<void> {
		// Defer until the workbench is restored so we never fight session restore.
		await this.lifecycleService.when(LifecyclePhase.Restored);

		if (this.environmentService.skipWelcome) {
			return; // honor --skip-welcome / e2e flags
		}
		if (this.configurationService.getValue<boolean>(OPEN_ON_STARTUP_SETTING) === false) {
			return; // user opted out — master gate
		}

		// Don't duplicate an already-open Home: reveal it instead. On a fresh launch this still
		// brings Home forward (active); on a reload it leaves the existing Home where it was.
		const isReload = this.lifecycleService.startupKind === StartupKind.ReloadedWindow;
		const homeAlreadyOpen = this.editorService.editors.some(e => e.typeId === glyphcodeHomeInputTypeId);

		if (isReload) {
			// Reloading mid-work to test a build must not steal focus from the user's active editor.
			// Skip if Home is already restored; otherwise open it inactively, behind the active pane.
			if (homeAlreadyOpen) {
				return;
			}
			await this.editorService.openEditor(
				this.instantiationService.createInstance(GlyphspekHomeInput),
				{ pinned: true, inactive: true, revealIfOpened: true }
			);
			return;
		}

		// Fresh app launch: land on Home and make it the active editor, even if other editors were
		// restored. Restored editors stay open as tabs behind Home — `revealIfOpened` reuses an
		// existing Home tab (no duplicate) and the default (active, focused) options bring it forward.
		await this.editorService.openEditor(
			this.instantiationService.createInstance(GlyphspekHomeInput),
			{ pinned: true, revealIfOpened: true }
		);
	}
}

// ---- GlyphCode Home configuration. ----
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'glyphcode',
	order: 9,
	title: localize('glyphcodeHomeConfigurationTitle', "GlyphCode"),
	type: 'object',
	properties: {
		[OPEN_ON_STARTUP_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('glyphcode.home.openOnStartup', "Open the GlyphCode Home surface as the active tab on startup (the way an agent-home IDE lands on its home). Restored editors stay open behind it; a window reload keeps your current editor focused. Reopen any time with the \"GlyphCode: Open Home\" command.")
		}
	}
});

// ---- Wire the contributions. ----
registerWorkbenchContribution2(GlyphspekHomeEditorResolverContribution.ID, GlyphspekHomeEditorResolverContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(GlyphspekHomeStartupContribution.ID, GlyphspekHomeStartupContribution, WorkbenchPhase.AfterRestored);
