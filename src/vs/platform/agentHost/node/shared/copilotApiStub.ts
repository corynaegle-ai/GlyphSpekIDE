/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GlyphStudio-owned inert compatibility layer for `@vscode/copilot-api`.
 *
 * GlyphStudio ships NO GitHub Copilot runtime (see SECURITY-PATCHES.md GATE-002).
 * Microsoft's Agent Host imports `CAPIClient` + `RequestType` as runtime values
 * to talk to Copilot's CAPI proxy. GlyphStudio does not use that Copilot-backed
 * path, so this module provides INERT runtime values: `RequestType` is a real
 * enum mirroring the SDK's, and any actual `CAPIClient` request throws.
 *
 * IMPORTANT — gate boundary (GATE-002 / verify-no-copilot.sh):
 *   The agent host source MUST import these symbols from THIS owned module via a
 *   relative path, NOT from the bare `@vscode/copilot-api` specifier. That keeps
 *   the scanned package name out of every EMITTED `.js` (tsc, transpile, node
 *   unit tests, esbuild bundle, package). The only references to the bare
 *   specifier below are `import type` statements, which TypeScript ERASES at
 *   emit, so they never appear in any `out/` or bundled JavaScript and never
 *   resolve as an installed package at runtime. Pure data types stay fully
 *   fidelity-checked against the rich `.d.ts` stub via the tsconfig `paths`
 *   mapping.
 */

import type {
	CopilotToken,
	IDomainChangeResponse,
	IExtensionInformation,
	IFetcherService,
	MakeRequestOptions,
} from '@vscode/copilot-api';

// Pure data types re-exported from the path-mapped `.d.ts` stub (erased at emit).
export type {
	CCAModel,
	CopilotToken,
	FetchOptions,
	IDomainChangeResponse,
	IExtensionInformation,
	IFetcherService,
	MakeRequestOptions,
} from '@vscode/copilot-api';

const COPILOT_UNAVAILABLE = 'Copilot is not available in GlyphStudio (the Copilot CAPI runtime is intentionally removed; GlyphStudio ships no GitHub Copilot).';

/**
 * Inert mirror of `@vscode/copilot-api`'s `RequestType` enum. Provided as a
 * real enum (both a value and a type) so `RequestType.Models` etc. resolve in
 * the agent host and remain assignable to {@link RequestMetadata}.
 */
export enum RequestType {
	CopilotToken = 'CopilotToken',
	ChatCompletions = 'ChatCompletions',
	ChatResponses = 'ChatResponses',
	ChatMessages = 'ChatMessages',
	Models = 'Models',
}

/** Mirrors `@vscode/copilot-api`'s `RequestMetadata` against the owned enum. */
export type RequestMetadata =
	| { type: RequestType.CopilotToken }
	| { type: RequestType.ChatCompletions | RequestType.ChatResponses | RequestType.ChatMessages | RequestType.Models; isModelLab?: boolean };

/** Inert `CAPIClient`. Construction is allowed, but any request throws. */
export class CAPIClient {
	constructor(
		_extensionInfo: IExtensionInformation,
		_license: string | undefined,
		_fetcherService?: IFetcherService,
		_hmacSecret?: string,
		_integrationId?: string,
	) {
		// inert
	}
	updateDomains(_copilotToken: CopilotToken | undefined, _enterpriseUrlConfig: string | undefined): IDomainChangeResponse {
		return {
			capiUrlChanged: false,
			telemetryUrlChanged: false,
			dotcomUrlChanged: false,
			proxyUrlChanged: false,
		};
	}
	async makeRequest<T>(_requestOptions: MakeRequestOptions, _requestMetadata: RequestMetadata): Promise<T> {
		throw new Error(COPILOT_UNAVAILABLE);
	}
}
