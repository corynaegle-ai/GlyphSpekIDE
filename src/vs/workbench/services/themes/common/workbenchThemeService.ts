/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	// GlyphSpek: the product default dark color theme (extensions/glyphspek-theme). This is the
	// source of truth for the desktop `workbench.colorTheme` default + the dark fallback +
	// legacy-id migration target, so the workbench boots in GlyphSpek Dark on a clean profile.
	export const COLOR_THEME_DARK = 'GlyphSpek Dark';
	export const COLOR_THEME_LIGHT = 'Light 2026';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

// GlyphSpek: pre-theme-load boot splash colors, aligned to the GlyphSpek Dark palette
// (design/ide-concept/glyphspek-workbench-blended.html :root) so a clean first launch does not
// flash the stock blue/#1F1F1F chrome before the theme extension resolves. Mirrors the load-bearing
// surfaces of extensions/glyphspek-theme/themes/glyphspek-dark-color-theme.json.
export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#232d3a',
	'activityBar.activeBorder': '#5b9cf0',
	'activityBar.background': '#161c24',
	'activityBar.border': '#2a333f',
	'activityBar.foreground': '#e9ecff',
	'activityBar.inactiveForeground': '#8b97a6',
	'activityBarBadge.background': '#d9a441',
	'activityBarBadge.foreground': '#1a1407',
	'badge.background': '#5b9cf0',
	'badge.foreground': '#08111d',
	'button.background': '#5b9cf0',
	'button.border': '#FFFFFF14',
	'button.foreground': '#08111d',
	'button.hoverBackground': '#74acf5',
	'button.secondaryBackground': '#1d2530',
	'button.secondaryForeground': '#d7dde5',
	'button.secondaryHoverBackground': '#232d3a',
	'chat.slashCommandBackground': '#11202f',
	'chat.slashCommandForeground': '#85b6ff',
	'chat.editedFileForeground': '#d9a441',
	'checkbox.background': '#1d2530',
	'checkbox.border': '#36424f',
	'debugToolBar.background': '#161c24',
	'descriptionForeground': '#aeb9c7',
	'dropdown.background': '#1d2530',
	'dropdown.border': '#36424f',
	'dropdown.foreground': '#d7dde5',
	'dropdown.listBackground': '#161c24',
	'editor.background': '#0f1419',
	'editor.findMatchBackground': '#d9a44166',
	'editor.foreground': '#d7dde5',
	'editor.inactiveSelectionBackground': '#5b9cf014',
	'editor.selectionHighlightBackground': '#5b9cf01f',
	'editorGroup.border': '#2a333f',
	'editorGroupHeader.tabsBackground': '#161c24',
	'editorGroupHeader.tabsBorder': '#2a333f',
	'editorGutter.addedBackground': '#3fb568',
	'editorGutter.deletedBackground': '#e0544b',
	'editorGutter.modifiedBackground': '#d9a441',
	'editorIndentGuide.activeBackground1': '#36424f',
	'editorIndentGuide.background1': '#222b36',
	'editorLineNumber.activeForeground': '#aeb9c7',
	'editorLineNumber.foreground': '#5a6678',
	'editorOverviewRuler.border': '#0f1419',
	'editorWidget.background': '#161c24',
	'errorForeground': '#e0544b',
	'focusBorder': '#5b9cf0',
	'foreground': '#d7dde5',
	'icon.foreground': '#aeb9c7',
	'input.background': '#0f1419',
	'input.border': '#36424f',
	'input.foreground': '#d7dde5',
	'input.placeholderForeground': '#8b97a6',
	'inputOption.activeBackground': '#5b9cf033',
	'inputOption.activeBorder': '#5b9cf0',
	'keybindingLabel.foreground': '#d7dde5',
	'list.activeSelectionIconForeground': '#FFF',
	'list.dropBackground': '#5b9cf022',
	'menu.background': '#161c24',
	'menu.border': '#36424f',
	'menu.foreground': '#d7dde5',
	'menu.selectionBackground': '#5b9cf033',
	'menu.separatorBackground': '#2a333f',
	'notificationCenterHeader.background': '#0f1419',
	'notificationCenterHeader.foreground': '#aeb9c7',
	'notifications.background': '#161c24',
	'notifications.border': '#2a333f',
	'notifications.foreground': '#d7dde5',
	'panel.background': '#070a0f',
	'panel.border': '#2a333f',
	'panelInput.border': '#2a333f',
	'panelTitle.activeBorder': '#d9a441',
	'panelTitle.activeForeground': '#d7dde5',
	'panelTitle.inactiveForeground': '#8b97a6',
	'peekViewEditor.background': '#0f1419',
	'peekViewEditor.matchHighlightBackground': '#d9a44144',
	'peekViewResult.background': '#161c24',
	'peekViewResult.matchHighlightBackground': '#d9a44144',
	'pickerGroup.border': '#2a333f',
	'ports.iconRunningProcessForeground': '#3fb568',
	'progressBar.background': '#5b9cf0',
	'quickInput.background': '#161c24',
	'quickInput.foreground': '#d7dde5',
	'settings.dropdownBackground': '#1d2530',
	'settings.dropdownBorder': '#36424f',
	'settings.headerForeground': '#d7dde5',
	'settings.modifiedItemIndicator': '#d9a441',
	'sideBar.background': '#161c24',
	'sideBar.border': '#2a333f',
	'sideBar.foreground': '#aeb9c7',
	'sideBarSectionHeader.background': '#161c24',
	'sideBarSectionHeader.border': '#2a333f',
	'sideBarSectionHeader.foreground': '#8b97a6',
	'sideBarTitle.foreground': '#aeb9c7',
	'statusBar.background': '#161c24',
	'statusBar.border': '#2a333f',
	'statusBar.debuggingBackground': '#d9a441',
	'statusBar.debuggingForeground': '#1a1407',
	'statusBar.focusBorder': '#5b9cf0',
	'statusBar.foreground': '#aeb9c7',
	'statusBar.noFolderBackground': '#161c24',
	'statusBarItem.focusBorder': '#5b9cf0',
	'statusBarItem.prominentBackground': '#5b9cf033',
	'statusBarItem.remoteBackground': '#5b9cf0',
	'statusBarItem.remoteForeground': '#08111d',
	'tab.activeBackground': '#0f1419',
	'tab.activeBorder': '#0f1419',
	'tab.activeBorderTop': '#d9a441',
	'tab.activeForeground': '#d7dde5',
	'tab.border': '#2a333f',
	'tab.hoverBackground': '#1d2530',
	'tab.inactiveBackground': '#161c24',
	'tab.inactiveForeground': '#8b97a6',
	'tab.lastPinnedBorder': '#36424f',
	'tab.selectedBackground': '#0f1419',
	'tab.selectedBorderTop': '#5b9cf0',
	'tab.selectedForeground': '#d7dde5',
	'tab.unfocusedActiveBorder': '#0f1419',
	'tab.unfocusedActiveBorderTop': '#2a333f',
	'tab.unfocusedHoverBackground': '#1d2530',
	'terminal.foreground': '#d7dde5',
	'terminal.inactiveSelectionBackground': '#5b9cf014',
	'terminal.tab.activeBorder': '#5b9cf0',
	'textBlockQuote.background': '#161c24',
	'textBlockQuote.border': '#36424f',
	'textCodeBlock.background': '#0f1419',
	'textLink.activeForeground': '#85b6ff',
	'textLink.foreground': '#5b9cf0',
	'textPreformat.background': '#1d2530',
	'textPreformat.foreground': '#e6c07b',
	'textSeparator.foreground': '#2a333f',
	'titleBar.activeBackground': '#161c24',
	'titleBar.activeForeground': '#d7dde5',
	'titleBar.border': '#2a333f',
	'titleBar.inactiveBackground': '#0f1419',
	'titleBar.inactiveForeground': '#8b97a6',
	'welcomePage.progress.foreground': '#5b9cf0',
	'welcomePage.tileBackground': '#161c24',
	'widget.border': '#2a333f'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#005FB8',
	'activityBar.background': '#F8F8F8',
	'activityBar.border': '#E5E5E5',
	'activityBar.foreground': '#1F1F1F',
	'activityBar.inactiveForeground': '#616161',
	'activityBarBadge.background': '#005FB8',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#CCCCCC',
	'badge.foreground': '#3B3B3B',
	'button.background': '#005FB8',
	'button.border': '#0000001a',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#0258A8',
	'button.secondaryBackground': '#E5E5E5',
	'button.secondaryForeground': '#3B3B3B',
	'button.secondaryHoverBackground': '#CCCCCC',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#26569E',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#F8F8F8',
	'checkbox.border': '#CECECE',
	'descriptionForeground': '#3B3B3B',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#CECECE',
	'dropdown.foreground': '#3B3B3B',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#3B3B3B',
	'editor.inactiveSelectionBackground': '#E5EBF1',
	'editor.selectionHighlightBackground': '#ADD6FF80',
	'editorGroup.border': '#E5E5E5',
	'editorGroupHeader.tabsBackground': '#F8F8F8',
	'editorGroupHeader.tabsBorder': '#E5E5E5',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#005FB8',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D3D3D3',
	'editorLineNumber.activeForeground': '#171184',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#E5E5E5',
	'editorSuggestWidget.background': '#F8F8F8',
	'editorWidget.background': '#F8F8F8',
	'errorForeground': '#F85149',
	'focusBorder': '#005FB8',
	'foreground': '#3B3B3B',
	'icon.foreground': '#3B3B3B',
	'input.background': '#FFFFFF',
	'input.border': '#CECECE',
	'input.foreground': '#3B3B3B',
	'input.placeholderForeground': '#767676',
	'inputOption.activeBackground': '#BED6ED',
	'inputOption.activeBorder': '#005FB8',
	'inputOption.activeForeground': '#000000',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#E8E8E8',
	'list.activeSelectionForeground': '#000000',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#005FB8',
	'list.hoverBackground': '#F2F2F2',
	'menu.border': '#CECECE',
	'menu.selectionBackground': '#005FB8',
	'menu.selectionForeground': '#ffffff',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#E5E5E5',
	'notifications.foreground': '#3B3B3B',
	'panel.background': '#F8F8F8',
	'panel.border': '#E5E5E5',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#005FB8',
	'panelTitle.activeForeground': '#3B3B3B',
	'panelTitle.inactiveForeground': '#3B3B3B',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#E5E5E5',
	'pickerGroup.foreground': '#8B949E',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#005FB8',
	'quickInput.background': '#F8F8F8',
	'quickInput.foreground': '#3B3B3B',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F8F8F8',
	'sideBar.border': '#E5E5E5',
	'sideBar.foreground': '#3B3B3B',
	'sideBarSectionHeader.background': '#F8F8F8',
	'sideBarSectionHeader.border': '#E5E5E5',
	'sideBarSectionHeader.foreground': '#3B3B3B',
	'sideBarTitle.foreground': '#3B3B3B',
	'statusBar.background': '#F8F8F8',
	'statusBar.border': '#E5E5E5',
	'statusBar.debuggingBackground': '#FD716C',
	'statusBar.debuggingForeground': '#000000',
	'statusBar.focusBorder': '#005FB8',
	'statusBar.foreground': '#3B3B3B',
	'statusBar.noFolderBackground': '#F8F8F8',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#005FB8',
	'statusBarItem.hoverBackground': '#B8B8B850',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#005FB8',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#F8F8F8',
	'tab.activeBorderTop': '#005FB8',
	'tab.activeForeground': '#3B3B3B',
	'tab.border': '#E5E5E5',
	'tab.hoverBackground': '#FFFFFF',
	'tab.inactiveBackground': '#F8F8F8',
	'tab.inactiveForeground': '#868686',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#68a3da',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#3B3B3B',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#005FB8',
	'terminalCursor.foreground': '#005FB8',
	'textBlockQuote.background': '#F8F8F8',
	'textBlockQuote.border': '#E5E5E5',
	'textCodeBlock.background': '#F8F8F8',
	'textLink.activeForeground': '#005FB8',
	'textLink.foreground': '#005FB8',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B3B3B',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#F8F8F8',
	'titleBar.activeForeground': '#1E1E1E',
	'titleBar.border': '#E5E5E5',
	'titleBar.inactiveBackground': '#F8F8F8',
	'titleBar.inactiveForeground': '#8B949E',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#E5E5E5'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
