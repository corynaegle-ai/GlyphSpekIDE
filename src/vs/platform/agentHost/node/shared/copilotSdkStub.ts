/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GlyphCode-owned inert compatibility layer for `@github/copilot-sdk`.
 *
 * GlyphCode ships NO GitHub Copilot runtime (see SECURITY-PATCHES.md GATE-002).
 * Microsoft's Agent Host (`vs/platform/agentHost/node/copilot/**`) imports the
 * Copilot SDK as a load-bearing runtime dependency, but GlyphCode does not use
 * that Copilot-backed agent path — it has its own brokered/trust layer and the
 * Claude agent. The agent host still imports these symbols, so this module
 * provides INERT runtime values whose every Copilot-touching entry point throws
 * rather than reaching out to GitHub. No real Copilot code, binary, or network
 * call is reachable from here.
 *
 * IMPORTANT — gate boundary (GATE-002 / verify-no-copilot.sh):
 *   The agent host source MUST import these symbols from THIS owned module via a
 *   relative path, NOT from the bare `@github/copilot-sdk` specifier. That keeps
 *   the scanned package name out of every EMITTED `.js` (tsc, transpile, node
 *   unit tests, esbuild bundle, package). The only references to the bare
 *   specifier below are `import type` / `export type`, which TypeScript ERASES
 *   at emit, so they never appear in any `out/` or bundled JavaScript and never
 *   resolve as an installed package at runtime. The rich SDK type surface stays
 *   fully fidelity-checked against the `.d.ts` stub via the tsconfig `paths`
 *   mapping.
 */

import type {
	CopilotClient as ISdkCopilotClient,
	CopilotClientOptions,
	CopilotSession,
	ModelInfo,
	ResumeSessionConfig,
	RuntimeConnection as ISdkRuntimeConnection,
	SessionConfig,
	SessionListFilter,
	SessionMetadata,
} from '@github/copilot-sdk';

// Type surface re-exported from the path-mapped `.d.ts` stub (erased at emit).
// Re-exporting `CopilotSession` as a type only is intentional: the production
// agent host never constructs one (sessions come back from create/resume, which
// throw), so a value export is not needed.
export type {
	CopilotClientOptions,
	CustomAgentConfig,
	MCPServerConfig,
	MessageOptions,
	ModelInfo,
	PermissionRequest,
	PermissionRequestResult,
	ResumeSessionConfig,
	SessionConfig,
	SessionEvent,
	SessionEventPayload,
	SessionEventType,
	TelemetryConfig,
	Tool,
	ToolInvocation,
	ToolResultObject,
	TypedSessionEventHandler,
	CopilotSession,
} from '@github/copilot-sdk';

const COPILOT_UNAVAILABLE = 'Copilot is not available in GlyphCode (the Copilot runtime is intentionally removed; GlyphCode ships no GitHub Copilot).';

function unavailable(): never {
	throw new Error(COPILOT_UNAVAILABLE);
}

/**
 * Inert `CopilotClient`. Construction is allowed (the agent host may
 * `new CopilotClient(...)` eagerly), but every method that would talk to the
 * Copilot runtime throws. The agent host only reaches these after a successful
 * auth + `start()`, and `start()` throws here, so no Copilot path runs.
 */
export class CopilotClient {
	/**
	 * `connection` is read by the agent host's plan-mode shim via an unsafe
	 * cast; expose an inert value so the optional-chaining guard there
	 * short-circuits.
	 */
	readonly connection: undefined = undefined;

	/**
	 * The agent host reaches `client.rpc.sessions.fork(...)` on the fork path.
	 * Typed against the real SDK surface for fidelity; backed by a Proxy whose
	 * every leaf throws, so no Copilot RPC is reachable.
	 */
	readonly rpc: ISdkCopilotClient['rpc'] = new Proxy({}, {
		get() { return new Proxy(() => unavailable(), { get() { return unavailable; } }); },
	}) as ISdkCopilotClient['rpc'];

	constructor(_options?: CopilotClientOptions) {
		// inert
	}
	async start(): Promise<void> { unavailable(); }
	async stop(): Promise<Error[]> { return []; }
	async forceStop(): Promise<void> { /* inert no-op */ }
	createSession(_config: SessionConfig): Promise<CopilotSession> { return unavailable(); }
	resumeSession(_sessionId: string, _config: ResumeSessionConfig): Promise<CopilotSession> { return unavailable(); }
	async ping(): Promise<void> { unavailable(); }
	getStatus(): ReturnType<ISdkCopilotClient['getStatus']> { return unavailable(); }
	getAuthStatus(): ReturnType<ISdkCopilotClient['getAuthStatus']> { return unavailable(); }
	async listModels(): Promise<ModelInfo[]> { return []; }
	async getLastSessionId(): Promise<string | undefined> { return undefined; }
	async deleteSession(_sessionId: string): Promise<void> { unavailable(); }
	async listSessions(_filter?: SessionListFilter): Promise<SessionMetadata[]> { return []; }
	async getSessionMetadata(_sessionId: string): Promise<SessionMetadata | undefined> { return undefined; }
	async getForegroundSessionId(): Promise<string | undefined> { return undefined; }
	async setForegroundSessionId(_sessionId: string): Promise<void> { unavailable(); }
	onLifecycle(..._args: unknown[]): () => void { return () => { /* inert */ }; }
}

/** Inert `RuntimeConnection` factory mirroring the SDK's static surface. */
export const RuntimeConnection: {
	forStdio: (opts?: { path?: string; args?: readonly string[] }) => ISdkRuntimeConnection;
	forTcp: (opts?: { port?: number; connectionToken?: string; path?: string; args?: readonly string[] }) => ISdkRuntimeConnection;
	forUri: (url: string, opts?: { connectionToken?: string }) => ISdkRuntimeConnection;
} = {
	forStdio: opts => ({ kind: 'stdio', path: opts?.path, args: opts?.args }),
	forTcp: opts => ({ kind: 'tcp', port: opts?.port, connectionToken: opts?.connectionToken, path: opts?.path, args: opts?.args }),
	forUri: (url, opts) => ({ kind: 'uri', url, connectionToken: opts?.connectionToken }),
};
