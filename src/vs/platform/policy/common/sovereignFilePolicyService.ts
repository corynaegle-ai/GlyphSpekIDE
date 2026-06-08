/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PolicyName } from '../../../base/common/policy.js';
import { FilePolicyService } from './filePolicyService.js';
import { PolicyValue } from './policy.js';

/**
 * GlyphStudio PATCH-001 (Sweep-19 Finding 2) — fail-closed bundled Sovereign policy source.
 *
 * A self-contained Sovereign build carries its `AllowedExtensions` allowlist as a bundled
 * `<appRoot>/policy.json`. Stock `FilePolicyService` swallows a missing/unreadable/invalid
 * policy file and proceeds with an *empty* policy map — for a Sovereign build that flag is set
 * on, that silently degrades the hard allowlist to the stock `extensions.allowed` default of
 * `'*'` (all extensions allowed), i.e. a silent Sovereign→Developer downgrade.
 *
 * This service is constructed *only* on the Sovereign branch (when `product.json` sets
 * `glyphstudioSovereignPolicyFile`). When the bundled policy file is missing/unreadable/invalid
 * it does NOT proceed with an empty allowlist: it forces the `AllowedExtensions` policy to a
 * deny-everything floor (`{ "*": false }`). Because `extensions.allowed` is then a policy-set,
 * deny-all value, no third-party extension can be enabled — the build cannot present as
 * product-trusted Sovereign; it is effectively UNTRUSTED. The failure is logged with a clear
 * security-posture message (via the base `read()` error path).
 *
 * A stock/Developer build (flag absent) never constructs this service, so it is wholly
 * unaffected and keeps booting with stock policy semantics.
 */
export class SovereignFilePolicyService extends FilePolicyService {

	/** The policy whose value carries the GlyphStudio-curated extension allowlist. */
	private static readonly ALLOWED_EXTENSIONS_POLICY: PolicyName = 'AllowedExtensions';

	/**
	 * The fail-closed floor: deny every extension. Delivered as a JSON string because the config
	 * layer parses object-typed policies that arrive as strings (mirrors `NativePolicyService`
	 * and `MultiPolicyService`).
	 */
	private static readonly DENY_ALL_ALLOWED_EXTENSIONS: PolicyValue = JSON.stringify({ '*': false });

	protected override onReadFailed(error: unknown, policies: Map<PolicyName, PolicyValue>): void {
		// Surface the degraded security posture clearly. The base service stays silent on a
		// missing file (FILE_NOT_FOUND), but for a Sovereign build a missing/invalid bundled
		// policy IS a security event: it is the difference between an enforced allowlist and an
		// all-allowed default, so it must always be visible in the log.
		this.logService.error(
			`[SovereignFilePolicyService] GlyphStudio Sovereign policy file could not be loaded ` +
			`(missing, unreadable, or invalid). FAILING CLOSED: forcing AllowedExtensions to ` +
			`deny-all so no third-party extension can be enabled. This build is UNTRUSTED until ` +
			`a valid policy.json is present.`,
			error
		);

		// Only impose the floor when this build actually expects the `AllowedExtensions` policy
		// (i.e. the policy definition is registered). If it is not registered yet, the value is
		// not consulted, and the floor will be applied on the next refresh once it is.
		if (this.policyDefinitions[SovereignFilePolicyService.ALLOWED_EXTENSIONS_POLICY]) {
			policies.set(
				SovereignFilePolicyService.ALLOWED_EXTENSIONS_POLICY,
				SovereignFilePolicyService.DENY_ALL_ALLOWED_EXTENSIONS
			);
		}
	}
}
