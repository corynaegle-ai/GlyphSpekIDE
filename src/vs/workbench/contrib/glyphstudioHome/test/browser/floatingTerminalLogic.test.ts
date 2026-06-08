/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideWhereToAnchor,
	decideAnchorVisibility,
	computeFloatingTerminalDims,
	clampFloatingDims,
	clampDragOffset,
	FLOATING_TERMINAL_DIMS,
} from '../../browser/floatingTerminalLogic.js';

/*
 * T-LIFECYCLE (pure) for the fork floating governed terminal: decideWhereToAnchor 3-branch
 * (A3/E1/E21), decideAnchorVisibility dismiss-on-scroll (A7/E8), computeFloatingTerminalDims
 * + min-clamp (C3/E24). Byte-for-byte mirror of the authoritative spike suite
 * (spikes/p0-floating-terminal/floating-terminal-logic.test.ts), re-run in the fork harness.
 */
suite('GlyphStudio Floating Terminal — pure logic', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('A3 — anchor when the active editor has a model + cursor', () => {
		assert.deepStrictEqual(
			decideWhereToAnchor({ hasActiveEditor: true, hasModel: true, position: { lineNumber: 7, column: 3 } }),
			{ kind: 'anchor', position: { lineNumber: 7, column: 3 } });
	});

	test('E1 — refuse(no-editor) with no active editor', () => {
		assert.deepStrictEqual(decideWhereToAnchor({ hasActiveEditor: false, hasModel: false }), { kind: 'refuse', reason: 'no-editor' });
	});

	test('E21 — refuse(no-model) for a model-less host', () => {
		assert.deepStrictEqual(decideWhereToAnchor({ hasActiveEditor: true, hasModel: false }), { kind: 'refuse', reason: 'no-model' });
	});

	test('A7/E8 — track inside the viewport, dismiss when scrolled out (locked v1)', () => {
		assert.strictEqual(decideAnchorVisibility(10, [{ startLineNumber: 5, endLineNumber: 20 }]), 'track');
		assert.strictEqual(decideAnchorVisibility(99, [{ startLineNumber: 5, endLineNumber: 20 }]), 'dismiss');
		assert.strictEqual(decideAnchorVisibility(1, []), 'dismiss');
	});

	test('C3/E24 — dims scale with a roomy editor and clamp to a usable min for a tiny one', () => {
		const roomy = computeFloatingTerminalDims({ contentWidth: 1000, height: 800 }, 13);
		assert.strictEqual(roomy.width, Math.floor(1000 * FLOATING_TERMINAL_DIMS.widthFraction));
		const tiny = computeFloatingTerminalDims({ contentWidth: 50, height: 40 }, 13);
		assert.deepStrictEqual(tiny, { width: FLOATING_TERMINAL_DIMS.minWidthPx, height: FLOATING_TERMINAL_DIMS.minHeightPx });
	});

	test('C6 — resize clamps to [usable min, editor-bounded max] on each axis', () => {
		const max = { width: 900, height: 700 };
		// In range → unchanged.
		assert.deepStrictEqual(clampFloatingDims({ width: 500, height: 400 }, max), { width: 500, height: 400 });
		// Below the usable minimum → pinned to the min (the grip can't shrink it to nothing).
		assert.deepStrictEqual(clampFloatingDims({ width: 10, height: 10 }, max),
			{ width: FLOATING_TERMINAL_DIMS.minWidthPx, height: FLOATING_TERMINAL_DIMS.minHeightPx });
		// Past the editor bounds → capped to the editor content area.
		assert.deepStrictEqual(clampFloatingDims({ width: 9999, height: 9999 }, max), { width: 900, height: 700 });
	});

	test('C5 — drag offset keeps the widget within the editor bounds', () => {
		const base = { left: 100, top: 100, width: 200, height: 150 };
		const bounds = { left: 0, top: 0, width: 1000, height: 800 };
		// A small move stays in-bounds → offset passes through unchanged.
		assert.deepStrictEqual(clampDragOffset({ proposed: { x: 50, y: 25 }, base, bounds }), { x: 50, y: 25 });
		// Dragging far past the right/bottom edge → clamped so the widget's far edge sits on the bound.
		// maxLeft = 1000-200 = 800 ⇒ offset.x = 800-100 = 700; maxTop = 800-150 = 650 ⇒ offset.y = 650-100 = 550.
		assert.deepStrictEqual(clampDragOffset({ proposed: { x: 5000, y: 5000 }, base, bounds }), { x: 700, y: 550 });
		// Dragging past the top/left edge → clamped so the widget's near edge sits on the bound.
		assert.deepStrictEqual(clampDragOffset({ proposed: { x: -5000, y: -5000 }, base, bounds }), { x: -100, y: -100 });
	});
});
