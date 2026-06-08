/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GlyphStudio inert stub for `@github/copilot-sdk`.
 *
 * GlyphStudio ships NO GitHub Copilot runtime (see SECURITY-PATCHES.md GATE-002).
 * Microsoft's Agent Host (`vs/platform/agentHost/node/copilot/**`) imports the
 * real Copilot SDK as a load-bearing runtime dependency, but GlyphStudio does not
 * use that Copilot-backed agent path — it has its own brokered/trust layer and
 * the Claude agent. The agent host still imports these symbols, so this module
 * provides INERT implementations whose every Copilot-touching entry point
 * throws `COPILOT_UNAVAILABLE` rather than reaching out to GitHub. No real
 * Copilot code, binary, or network call is reachable from here.
 *
 * This file is type-described by the sibling `*.d.ts` declarations (the SDK's
 * real type shapes, copied verbatim — pure types, zero runtime). tsc reads the
 * `.d.ts`; Node/esbuild bundles this inert `.js`. The two are never
 * cross-validated, exactly as for any package with separate `types` + `main`.
 */

const COPILOT_UNAVAILABLE = 'Copilot is not available in GlyphStudio (the Copilot runtime is intentionally removed; GlyphStudio ships no GitHub Copilot).';

function unavailable() {
	throw new Error(COPILOT_UNAVAILABLE);
}

/** Inert {@link CopilotClient}. Construction is allowed (the agent host may
 * `new CopilotClient(...)` eagerly), but every method that would talk to the
 * Copilot runtime throws. The agent host only reaches these after a successful
 * auth + `start()`, and `start()` throws here, so no Copilot path runs. */
class CopilotClient {
	constructor(_options) {
		// `connection` is read by the agent host's plan-mode shim; expose an
		// inert value so the optional-chaining guard there short-circuits.
		this.connection = undefined;
		this.rpc = new Proxy({}, { get() { return unavailable; } });
	}
	async start() { unavailable(); }
	async stop() { return []; }
	async forceStop() { /* inert no-op */ }
	async createSession() { unavailable(); }
	async resumeSession() { unavailable(); }
	async ping() { unavailable(); }
	async getStatus() { unavailable(); }
	async getAuthStatus() { unavailable(); }
	async listModels() { return []; }
	async getLastSessionId() { return undefined; }
	async deleteSession() { unavailable(); }
	async listSessions() { return []; }
	async getSessionMetadata() { return undefined; }
	async getForegroundSessionId() { return undefined; }
	async setForegroundSessionId() { unavailable(); }
	onLifecycle() { return () => { /* inert */ }; }
}

/** Inert {@link CopilotSession}. Never constructed here (the agent host only
 * receives sessions back from `createSession`/`resumeSession`, which throw),
 * but exported so the symbol resolves. */
class CopilotSession {
	get sessionId() { return ''; }
	on() { return () => { /* inert */ }; }
	async send() { unavailable(); }
	async disconnect() { /* inert no-op */ }
}

/** Inert {@link Canvas}. */
class Canvas { }
class CanvasError extends Error { }

const RuntimeConnection = {
	forStdio: () => ({ type: 'stdio' }),
	forTcp: () => ({ type: 'tcp' }),
	forUri: () => ({ type: 'uri' }),
};

function createCanvas() { unavailable(); }
function defineTool(definition) { return definition; }
function approveAll() { return { behavior: 'allow' }; }
function convertMcpCallToolResult() { unavailable(); }
function createSessionFsAdapter() { unavailable(); }

const SYSTEM_MESSAGE_SECTIONS = {};

export {
	CopilotClient,
	CopilotSession,
	Canvas,
	CanvasError,
	RuntimeConnection,
	createCanvas,
	defineTool,
	approveAll,
	convertMcpCallToolResult,
	createSessionFsAdapter,
	SYSTEM_MESSAGE_SECTIONS,
};
