/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	FloatingTerminalController,
	type FloatingTerminalControllerDeps,
	type GovernedStartResult,
	type HostedTerminalLike,
	type FloatingDimension,
} from '../../browser/floatingTerminalLogic.js';

/*
 * T-SESSION (S) for the FORK floating governed terminal — the controller STATE MACHINE with
 * EVERY external dependency injected (start/stop/terminal-factory + child-exit/instance-exit
 * + the GOVERNANCE-LOSS signal). This is the ported authoritative spike suite
 * (spikes/p0-floating-terminal/floating-terminal-logic.test.ts) re-run against the FORK's
 * own FloatingTerminalController so the fork's state machine — not just a parallel spike
 * class — is the tested unit. Closes the review gap where G1/G3/G3a/G5/G6/G6a/A5/E18/E19
 * were proven only on the spike (which is why the G7 mid-session-loss path could ship
 * untested in the fork). The fork's vscode-facing controller (floatingTerminalWidget.ts)
 * builds the deps from real services and delegates to THIS class.
 */
suite('GlyphStudio Floating Terminal — controller state machine (T-SESSION)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DIMS: FloatingDimension = { width: 600, height: 280 };

	const OK_START: GovernedStartResult = {
		ok: true, runId: 'run-1', env: { HTTPS_PROXY: 'http://127.0.0.1:1', GLYPHSTUDIO_GOVERNED_FLOATING: 'run-1' },
		strictEnv: true, proxyUrl: 'http://127.0.0.1:1', cwd: '/ws', name: 'GlyphStudio Governed Terminal (Floating)', message: '',
	};

	interface Recorder {
		calls: string[];
		stopArgs: string[];
		ownedArgs: string[];
		exitListener?: (code: number | undefined) => void;
		lossListener?: () => void;
		terminalDisposed: boolean;
	}

	function newRec(): Recorder {
		return { calls: [], stopArgs: [], ownedArgs: [], terminalDisposed: false };
	}

	function makeDeps(over: { rec: Recorder; start?: () => Promise<GovernedStartResult>; throwOnAttach?: boolean; throwOnStop?: boolean }): FloatingTerminalControllerDeps {
		const rec = over.rec;
		const terminal: HostedTerminalLike = {
			attachToElement: () => { rec.calls.push('attach'); },
			setVisible: () => { rec.calls.push('setVisible'); },
			layout: () => { rec.calls.push('layout'); },
			focus: () => { rec.calls.push('focus'); },
			dispose: () => { rec.terminalDisposed = true; rec.calls.push('terminal.dispose'); },
			onExit: l => { rec.exitListener = l; return { dispose() { } }; },
		};
		return {
			startSession: over.start ?? (async () => { rec.calls.push('startSession'); return OK_START; }),
			stopSession: async (runId: string) => {
				rec.calls.push('stopSession');
				rec.stopArgs.push(runId);
				if (over.throwOnStop) { throw new Error('stop boom'); }
			},
			registerOwned: (runId: string) => { rec.calls.push('registerOwned'); rec.ownedArgs.push(runId); },
			connectWidget: () => { rec.calls.push('connectWidget'); },
			removeWidget: () => { rec.calls.push('removeWidget'); },
			createHostedTerminal: () => {
				rec.calls.push('createHostedTerminal');
				if (over.throwOnAttach) { throw new Error('pty spawn failed'); }
				return terminal;
			},
			onGovernanceLoss: l => { rec.lossListener = l; return { dispose() { } }; },
			showDegraded: () => { rec.calls.push('showDegraded'); },
			showError: () => { rec.calls.push('showError'); },
		};
	}

	test('T-SESSION success — connectWidget BEFORE attach (C0); registerOwned; reaches live', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec }), DIMS);
		const state = await c.start();
		assert.strictEqual(state, 'live');
		// C0 ORDERING: the content widget is DOM-connected before the terminal is attached.
		assert.ok(rec.calls.indexOf('connectWidget') < rec.calls.indexOf('createHostedTerminal'), 'connectWidget precedes create');
		assert.ok(rec.calls.indexOf('createHostedTerminal') < rec.calls.indexOf('attach'), 'create precedes attach');
		assert.ok(rec.calls.indexOf('attach') < rec.calls.indexOf('setVisible'), 'attach precedes setVisible');
		assert.deepStrictEqual(rec.ownedArgs, ['run-1'], 'the run is registered governed-owned (B2a)');
		assert.ok(rec.calls.includes('focus'));
	});

	test('C0 regression — attach WAITS for an ASYNC connectWidget (render-pass DOM commit)', async () => {
		// Repro of the "governed terminal failed to attach: A container element needs to be
		// set with attachToElement and be part of the DOM before calling _open" bug. The
		// editor commits a freshly-added content widget to the DOM on a render pass that
		// LAGS addContentWidget, so connectWidget resolves ASYNCHRONOUSLY. The machine MUST
		// await it before attaching, else TerminalInstance._open() throws on a host that is
		// not yet connected. (Pre-fix the machine called connectWidget() without awaiting →
		// attach ran while the promise was still pending → throw.)
		const rec = newRec();
		const deps = makeDeps({ rec });
		deps.connectWidget = async () => {
			rec.calls.push('connectWidget:start');
			await Promise.resolve(); // a microtask — stands in for the deferred render-pass commit.
			rec.calls.push('connectWidget:done');
		};
		const c = new FloatingTerminalController(deps, DIMS);
		const state = await c.start();
		assert.strictEqual(state, 'live');
		assert.ok(rec.calls.indexOf('connectWidget:done') < rec.calls.indexOf('attach'),
			'attach happens ONLY AFTER the async connectWidget resolves (the host is in the DOM)');
	});

	test('AD3/G1 — a refused start shows an honest error and opens NO terminal', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec, start: async () => ({ ok: false, message: 'no governance' }) }), DIMS);
		const state = await c.start();
		assert.strictEqual(state, 'refused');
		assert.ok(rec.calls.includes('showError'));
		assert.ok(!rec.calls.includes('createHostedTerminal'), 'no terminal is created on refusal');
		assert.deepStrictEqual(rec.stopArgs, [], 'no runId was minted ⇒ nothing to finalize');
	});

	test('A5/AD5 — dispose detaches, disposes the terminal, and finalizes via stopSession(runId)', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec }), DIMS);
		await c.start();
		await c.dispose();
		assert.ok(rec.terminalDisposed, 'the terminal (PTY/child) is disposed');
		assert.ok(rec.calls.includes('removeWidget'));
		assert.deepStrictEqual(rec.stopArgs, ['run-1'], 'stopSession is issued with the minted runId');
	});

	test('G6a — double-dispose is a no-op (stopSession issued exactly once)', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec }), DIMS);
		await c.start();
		await c.dispose();
		await c.dispose();
		assert.strictEqual(rec.stopArgs.length, 1, 'stopSession is issued exactly once across double-dispose');
	});

	test('G6 — a stopSession that THROWS still tears down the DOM (never wedged)', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec, throwOnStop: true }), DIMS);
		await c.start();
		await c.dispose(); // must not reject
		assert.ok(rec.calls.includes('removeWidget'), 'the widget DOM is removed even when stop throws');
		assert.ok(rec.terminalDisposed);
		assert.strictEqual(c.state, 'disposed');
	});

	test('G3a/G4 — a throw AFTER the runId is minted (PTY spawn fail) finalizes (no orphan)', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec, throwOnAttach: true }), DIMS);
		const state = await c.start();
		assert.strictEqual(state, 'refused');
		assert.ok(rec.calls.includes('showError'));
		assert.deepStrictEqual(rec.stopArgs, ['run-1'], 'the minted runId is finalized despite the attach throw');
	});

	test('G3 — cancel BEFORE a runId is minted finalizes nothing', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec, start: async () => ({ ok: false, message: 'x' }) }), DIMS);
		c.cancel();
		await c.start();
		assert.deepStrictEqual(rec.stopArgs, [], 'no runId minted ⇒ nothing finalized');
	});

	test('G7/E18 — mid-session governance loss drops green (degraded) and finalizes', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec }), DIMS);
		await c.start();
		assert.strictEqual(c.state, 'live');
		rec.lossListener!(); // supervisor child / proxy died while the shell is alive
		assert.ok(rec.calls.includes('showDegraded'), 'the green/governed state is dropped (degraded shown)');
		await Promise.resolve();
		assert.deepStrictEqual(rec.stopArgs, ['run-1'], 'the run is finalized on governance loss');
	});

	test('E19 — PTY self-exit while open tears down + finalizes', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec }), DIMS);
		await c.start();
		rec.exitListener!(0); // the PTY exited (`exit`)
		await Promise.resolve();
		assert.deepStrictEqual(rec.stopArgs, ['run-1'], 'a PTY self-exit finalizes the run');
		assert.ok(rec.terminalDisposed);
	});

	test('A4 — re-start while not idle does NOT start a second session', async () => {
		const rec = newRec();
		const c = new FloatingTerminalController(makeDeps({ rec }), DIMS);
		await c.start();
		const again = await c.start();
		assert.strictEqual(again, 'live');
		assert.strictEqual(rec.calls.filter(x => x === 'startSession').length, 1, 'only one startSession across re-press');
	});
});
