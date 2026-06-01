/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
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
import { GlyphspekHomePage } from './glyphspekHome.js';
import { GlyphspekHomeInput, glyphspekHomeInputTypeId } from './glyphspekHomeInput.js';

/** Setting that controls whether GlyphSpek Home auto-opens when the editor area would be empty. */
const OPEN_ON_STARTUP_SETTING = 'glyphspek.home.openOnStartup';

/** Command id for re-opening Home (palette: "GlyphSpek: Open Home"). */
const OPEN_HOME_COMMAND_ID = 'glyphspek.home.open';

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
		localize('glyphspekHome', "GlyphSpek Home")
	),
	[
		new SyncDescriptor(GlyphspekHomeInput)
	]
);

// ---- "GlyphSpek: Open Home" command. ----
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_HOME_COMMAND_ID,
			title: localize2('glyphspekHome.open', 'Open Home'),
			category: Categories.View,
			f1: true,
			metadata: {
				description: localize2('glyphspekHome.open.desc', 'Open the GlyphSpek Home surface — start a governed run and reach the governance surfaces.')
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

/**
 * Resolves the Home resource scheme to the Home editor, so reopening the persisted resource
 * (e.g. after a reload) maps back to the Home pane. Mirrors `StartupPageEditorResolverContribution`.
 */
class GlyphspekHomeEditorResolverContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.glyphspekHomeEditorResolver';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorResolverService editorResolverService: IEditorResolverService
	) {
		super();

		this._register(editorResolverService.registerEditor(
			`${GlyphspekHomeInput.RESOURCE.scheme}:/**`,
			{
				id: GlyphspekHomeInput.ID,
				label: localize('glyphspekHome.displayName', "GlyphSpek Home"),
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
 * Auto-opens GlyphSpek Home on startup when the editor area would otherwise be empty — the way
 * an agent-home IDE lands on its home rather than a blank editor. Modeled on
 * `StartupPageRunnerContribution`: waits for `Restored`, and only opens on a fresh launch (not a
 * window reload) when no editor is restored. Behind `glyphspek.home.openOnStartup` (default ON).
 *
 * Honesty/scope note: this does NOT touch `product.json` or `workbench.startupEditor`. It is an
 * additive, settings-gated startup contribution that coexists with the stock Welcome page — if a
 * user has restored editors or disables the setting, Home does not force itself open.
 */
class GlyphspekHomeStartupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.glyphspekHomeStartup';

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
			return; // user opted out
		}
		if (this.lifecycleService.startupKind === StartupKind.ReloadedWindow) {
			return; // a reload restores prior editors; don't re-inject Home
		}
		// Only land on Home when nothing else is open (a restored file/workspace wins).
		if (this.editorService.activeEditor) {
			return;
		}
		// Don't duplicate an already-open Home.
		if (this.editorService.editors.some(e => e.typeId === glyphspekHomeInputTypeId)) {
			return;
		}

		await this.editorService.openEditor(
			this.instantiationService.createInstance(GlyphspekHomeInput),
			{ pinned: false }
		);
	}
}

// ---- GlyphSpek Home configuration. ----
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'glyphspek',
	order: 9,
	title: localize('glyphspekHomeConfigurationTitle', "GlyphSpek"),
	type: 'object',
	properties: {
		[OPEN_ON_STARTUP_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('glyphspek.home.openOnStartup', "Open the GlyphSpek Home surface at startup when the editor area would otherwise be empty (the way an agent-home IDE lands on its home). Reopen any time with the \"GlyphSpek: Open Home\" command. Does not override a restored editor or workspace.")
		}
	}
});

// ---- Wire the contributions. ----
registerWorkbenchContribution2(GlyphspekHomeEditorResolverContribution.ID, GlyphspekHomeEditorResolverContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(GlyphspekHomeStartupContribution.ID, GlyphspekHomeStartupContribution, WorkbenchPhase.AfterRestored);
