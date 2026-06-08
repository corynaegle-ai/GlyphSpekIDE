/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GlyphStudio brand icon sprite (PATCH-004).
 *
 * Vendored verbatim from `docs/assets/glyphstudio-icons.svg` (the same source the
 * blended-workbench mockup uses). Built once into the Home pane DOM so `<use href="#gs-…">`
 * references resolve. Kept here as a code constant so the pane has no network/file dependency.
 *
 * The raw SVG markup below is preserved ONLY as a reference for the geometry; it is NEVER
 * assigned to a DOM HTML sink. The sprite is materialized PROGRAMMATICALLY (see
 * `createGlyphspekHomeIconSprite`) so it cannot trip the renderer's Trusted Types CSP.
 *
 * Reference markup (do NOT route through innerHTML / DOMParser):
 * <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden" color="#e9ecff"><defs>
 * <symbol id="gs-run" viewBox="0 0 24 24"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m10 8 5 4-5 4Z" fill="currentColor"/><path d="M7 6.8h10M7 17.2h10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".55"/></symbol>
 * <symbol id="gs-verifier" viewBox="0 0 24 24"><path d="M12 3.5 19 6v5.7c0 4.6-2.9 7.2-7 8.8-4.1-1.6-7-4.2-7-8.8V6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m8.7 12 2.2 2.2 4.7-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 3.5v17" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".42"/></symbol>
 * <symbol id="gs-network" viewBox="0 0 24 24"><path d="M6 8h4v4H6ZM14 4h4v4h-4ZM14 16h4v4h-4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 10h2a2 2 0 0 0 2-2V6M10 10h2a2 2 0 0 1 2 2v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M5 17.5 8.5 14l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
 * <symbol id="gs-trace" viewBox="0 0 24 24"><path d="M6 6h4v4H6ZM14 6h4v4h-4ZM10 14h4v4h-4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8h4M16 10v2a2 2 0 0 1-2 2M8 10v2a2 2 0 0 0 2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="16" r="1" fill="currentColor"/></symbol>
 * <symbol id="gs-search" viewBox="0 0 24 24"><path d="M5.5 11a5.5 5.5 0 1 0 11 0 5.5 5.5 0 0 0-11 0Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.3 15.3 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
 * <symbol id="gs-broker" viewBox="0 0 24 24"><path d="M5 4h14v5.5H5ZM5 14.5h14V20H5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9.5v5M8.5 12h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/></symbol>
 * <symbol id="gs-policy" viewBox="0 0 24 24"><path d="M6 4h9l3 3v13H6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15 4v4h4M9 10.5h6M9 14h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="m8.5 17.3 1.7 1.7 4-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
 * <symbol id="gs-sandbox" viewBox="0 0 24 24"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 7.5 12 12l8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity=".7"/><path d="M9 8.8 12 7l3 1.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
 * <symbol id="gs-claude-actor" viewBox="0 0 24 24"><path d="M12 4.5v15M4.5 12h15M6.7 6.7l10.6 10.6M17.3 6.7 6.7 17.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/></symbol>
 * </defs></svg>
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A single SVG child shape (`<path>` / `<circle>`) described as a tag + its attributes. */
interface ISpriteShape {
	readonly tag: 'path' | 'circle';
	readonly attrs: Readonly<Record<string, string>>;
}

/** A `<symbol>` in the sprite: its id, its viewBox, and the shapes it contains. */
interface ISpriteSymbol {
	readonly id: string;
	readonly viewBox: string;
	readonly children: readonly ISpriteShape[];
}

/**
 * The vendored sprite as DATA (id / viewBox / shapes) — geometry identical to the reference
 * markup above. Materialized via `createElementNS` + `setAttribute`, which are NOT Trusted Types
 * HTML sinks, so building the sprite can never throw `TrustedHTML` in the renderer.
 */
const GLYPHSTUDIO_HOME_ICON_SYMBOLS: readonly ISpriteSymbol[] = [
	{
		id: 'gs-run',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' } },
			{ tag: 'path', attrs: { d: 'm10 8 5 4-5 4Z', fill: 'currentColor' } },
			{ tag: 'path', attrs: { d: 'M7 6.8h10M7 17.2h10', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.2', 'stroke-linecap': 'round', opacity: '.55' } }
		]
	},
	{
		id: 'gs-verifier',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M12 3.5 19 6v5.7c0 4.6-2.9 7.2-7 8.8-4.1-1.6-7-4.2-7-8.8V6Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'm8.7 12 2.2 2.2 4.7-5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'M12 3.5v17', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.1', opacity: '.42' } }
		]
	},
	{
		id: 'gs-network',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M6 8h4v4H6ZM14 4h4v4h-4ZM14 16h4v4h-4Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'M10 10h2a2 2 0 0 0 2-2V6M10 10h2a2 2 0 0 1 2 2v6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' } },
			{ tag: 'path', attrs: { d: 'M5 17.5 8.5 14l3.5 3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }
		]
	},
	{
		id: 'gs-trace',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M6 6h4v4H6ZM14 6h4v4h-4ZM10 14h4v4h-4Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'M10 8h4M16 10v2a2 2 0 0 1-2 2M8 10v2a2 2 0 0 0 2 2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' } },
			{ tag: 'circle', attrs: { cx: '12', cy: '16', r: '1', fill: 'currentColor' } }
		]
	},
	{
		id: 'gs-search',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M5.5 11a5.5 5.5 0 1 0 11 0 5.5 5.5 0 0 0-11 0Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' } },
			{ tag: 'path', attrs: { d: 'M15.3 15.3 20 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' } }
		]
	},
	{
		id: 'gs-broker',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M5 4h14v5.5H5ZM5 14.5h14V20H5Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'M12 9.5v5M8.5 12h7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' } },
			{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '1.8', fill: 'currentColor' } }
		]
	},
	{
		id: 'gs-policy',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M6 4h9l3 3v13H6Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'M15 4v4h4M9 10.5h6M9 14h5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'm8.5 17.3 1.7 1.7 4-4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }
		]
	},
	{
		id: 'gs-sandbox',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'm12 3 8 4.5v9L12 21l-8-4.5v-9Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linejoin': 'round' } },
			{ tag: 'path', attrs: { d: 'M4 7.5 12 12l8-4.5M12 12v9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round', opacity: '.7' } },
			{ tag: 'path', attrs: { d: 'M9 8.8 12 7l3 1.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } }
		]
	},
	{
		id: 'gs-claude-actor',
		viewBox: '0 0 24 24',
		children: [
			{ tag: 'path', attrs: { d: 'M12 4.5v15M4.5 12h15M6.7 6.7l10.6 10.6M17.3 6.7 6.7 17.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' } },
			{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '3.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' } },
			{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '1.1', fill: 'currentColor' } }
		]
	}
];

/** Create one namespaced SVG element and apply every attribute via `setAttribute` (not a TT sink). */
function createSvgElement(targetDocument: Document, tag: string, attrs: Readonly<Record<string, string>>): SVGElement {
	const el = targetDocument.createElementNS(SVG_NS, tag) as SVGElement;
	for (const name in attrs) {
		el.setAttribute(name, attrs[name]);
	}
	return el;
}

/**
 * Build the vendored sprite as a real `<svg>` DOM node — PROGRAMMATICALLY.
 *
 * IMPORTANT (Trusted Types): the Code-OSS renderer enforces a `require-trusted-types-for 'script'`
 * CSP. Routing a raw HTML/SVG STRING through ANY DOM HTML sink throws
 * `This document requires 'TrustedHTML' assignment.` synchronously — and in an EditorPane
 * `createEditor` that aborts the whole render, leaving the pane blank. This includes
 * `DOMParser().parseFromString(svg, 'image/svg+xml')` in THIS renderer (it still hits the
 * Trusted Types policy here). The bulletproof approach — used below — is to construct every node
 * with `createElementNS` and set every attribute with `setAttribute`; neither is a Trusted Types
 * HTML sink, so this cannot throw. The returned root `<svg>` already lives in the pane's document,
 * so the caller can append it directly and `<use href="#gs-…">` references resolve against it.
 */
export function createGlyphspekHomeIconSprite(targetDocument: Document): SVGElement {
	const svg = createSvgElement(targetDocument, 'svg', {
		'aria-hidden': 'true',
		focusable: 'false',
		style: 'position:absolute;width:0;height:0;overflow:hidden',
		color: '#e9ecff'
	});
	const defs = createSvgElement(targetDocument, 'defs', {});
	for (const symbol of GLYPHSTUDIO_HOME_ICON_SYMBOLS) {
		const symbolEl = createSvgElement(targetDocument, 'symbol', { id: symbol.id, viewBox: symbol.viewBox });
		for (const child of symbol.children) {
			symbolEl.appendChild(createSvgElement(targetDocument, child.tag, child.attrs));
		}
		defs.appendChild(symbolEl);
	}
	svg.appendChild(defs);
	return svg;
}
