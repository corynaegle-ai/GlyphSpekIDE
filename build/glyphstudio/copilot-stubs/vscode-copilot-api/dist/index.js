/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GlyphStudio inert stub for `@vscode/copilot-api`.
 *
 * GlyphStudio ships NO GitHub Copilot runtime (see SECURITY-PATCHES.md GATE-002).
 * The agent host's `copilotApiService` imports `CAPIClient` + `RequestType` as
 * runtime values to talk to Copilot's CAPI proxy. GlyphStudio does not use that
 * Copilot-backed CAPI path, so this module provides INERT values: `RequestType`
 * is a plain enum-shaped object (so `RequestType.Models` etc. resolve), and any
 * actual `CAPIClient` request throws `COPILOT_UNAVAILABLE`. No Copilot network
 * call is reachable.
 *
 * Types are described by the sibling `index.d.ts` (the agent-host subset, pure
 * types, no runtime). tsc reads the `.d.ts`; Node/esbuild bundles this `.js`.
 */

const COPILOT_UNAVAILABLE = 'Copilot is not available in GlyphStudio (the Copilot CAPI runtime is intentionally removed; GlyphStudio ships no GitHub Copilot).';

const RequestType = Object.freeze({
	CopilotToken: 'CopilotToken',
	ChatCompletions: 'ChatCompletions',
	ChatResponses: 'ChatResponses',
	ChatMessages: 'ChatMessages',
	Models: 'Models',
});

/** Inert {@link CAPIClient}. Construction is allowed, but any request throws. */
class CAPIClient {
	constructor(_extensionInfo, _license, _fetcherService, _hmacSecret, _integrationId) {
		// inert
	}
	updateDomains() {
		return {
			capiUrlChanged: false,
			telemetryUrlChanged: false,
			dotcomUrlChanged: false,
			proxyUrlChanged: false,
		};
	}
	async makeRequest() {
		throw new Error(COPILOT_UNAVAILABLE);
	}
}

export { RequestType, CAPIClient };
