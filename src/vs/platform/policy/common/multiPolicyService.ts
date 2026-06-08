/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStringDictionary } from '../../../base/common/collections.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { PolicyName } from '../../../base/common/policy.js';
import { isObject } from '../../../base/common/types.js';
import { IPolicyService, PolicyDefinition, PolicyValue } from './policy.js';

/**
 * GlyphStudio PATCH-001 — layered policy source.
 *
 * Merges a GlyphStudio-bundled file policy (the baseline that travels inside the signed
 * Sovereign app) with the OS native/MDM policy. Native policy may *tighten* the baseline but
 * must never *loosen* it: for the `AllowedExtensions` policy this is enforced with a
 * dictionary-aware intersection (an entry stays in the effective allowlist only if both
 * sources permit it, and a deny in either source wins). For all other (scalar) policies the
 * native value takes precedence when present, since a native/MDM administrator is trusted to
 * set stricter scalar values.
 *
 * `bundled` is the baseline (lower precedence); `native` is layered ahead of it. Either may be
 * `undefined` (e.g. no native source on a platform), in which case the other is used directly.
 */
export class MultiPolicyService extends Disposable implements IPolicyService {

	readonly _serviceBrand: undefined;

	/** The policy whose value carries the GlyphStudio-curated extension allowlist. */
	private static readonly ALLOWED_EXTENSIONS_POLICY: PolicyName = 'AllowedExtensions';

	private readonly _onDidChange = this._register(new Emitter<readonly PolicyName[]>());
	readonly onDidChange = this._onDidChange.event;

	get policyDefinitions(): IStringDictionary<PolicyDefinition> {
		return { ...this.bundled.policyDefinitions, ...(this.native?.policyDefinitions ?? {}) };
	}

	constructor(
		private readonly bundled: IPolicyService,
		private readonly native: IPolicyService | undefined
	) {
		super();

		this._register(this.bundled.onDidChange(names => this._onDidChange.fire(names)));
		if (this.native) {
			this._register(this.native.onDidChange(names => this._onDidChange.fire(names)));
		}
	}

	async updatePolicyDefinitions(policyDefinitions: IStringDictionary<PolicyDefinition>): Promise<IStringDictionary<PolicyValue>> {
		const [bundled, native] = await Promise.all([
			this.bundled.updatePolicyDefinitions(policyDefinitions),
			this.native ? this.native.updatePolicyDefinitions(policyDefinitions) : Promise.resolve<IStringDictionary<PolicyValue>>({})
		]);

		const result: IStringDictionary<PolicyValue> = {};
		for (const name of new Set([...Object.keys(bundled), ...Object.keys(native)])) {
			const value = this.getPolicyValue(name);
			if (value !== undefined) {
				result[name] = value;
			}
		}
		return result;
	}

	getPolicyValue(name: PolicyName): PolicyValue | undefined {
		const bundledValue = this.bundled.getPolicyValue(name);
		const nativeValue = this.native?.getPolicyValue(name);

		if (name === MultiPolicyService.ALLOWED_EXTENSIONS_POLICY) {
			return intersectAllowedExtensions(bundledValue, nativeValue);
		}

		// Scalar policies: native (MDM/admin) wins when set, else the bundled baseline.
		return nativeValue !== undefined ? nativeValue : bundledValue;
	}

	serialize(): IStringDictionary<{ definition: PolicyDefinition; value: PolicyValue }> | undefined {
		const definitions = this.policyDefinitions;
		const result: IStringDictionary<{ definition: PolicyDefinition; value: PolicyValue }> = {};
		for (const name of Object.keys(definitions)) {
			const value = this.getPolicyValue(name);
			if (value !== undefined) {
				result[name] = { definition: definitions[name], value };
			}
		}
		return result;
	}
}

type AllowedExtensionsDict = IStringDictionary<boolean | string | string[]>;

/**
 * Intersects two `AllowedExtensions` policy values so the result is no looser than either:
 * an extension/publisher is allowed only if *both* sources allow it, and a deny (or absence)
 * in either source removes it. This lets a native/MDM administrator tighten — never loosen —
 * the GlyphStudio-bundled baseline.
 *
 * Values arrive from the policy layer either as already-parsed objects (FilePolicyService) or
 * as JSON strings (NativePolicyService); both are normalized here. A non-object value is
 * treated as "no constraint from that source".
 */
function intersectAllowedExtensions(bundled: PolicyValue | undefined, native: PolicyValue | undefined): PolicyValue | undefined {
	const bundledDict = asAllowedExtensionsDict(bundled);
	const nativeDict = asAllowedExtensionsDict(native);

	// Single-source: re-serialize as a JSON string so `getPolicyValue` always returns a valid
	// scalar `PolicyValue`; the config layer parses object-typed policies that arrive as strings.
	if (!bundledDict) {
		return nativeDict ? JSON.stringify(nativeDict) : native;
	}
	if (!nativeDict) {
		return JSON.stringify(bundledDict);
	}

	// A key absent from a source resolves to that source's `"*"` fallback (mirrors how the
	// allowlist itself resolves: an unlisted id falls through to the `"*"` entry — see
	// allowedExtensionsService.isAllowed). Default the floor to deny when `"*"` is unset.
	const bundledStar = starValue(bundledDict);
	const nativeStar = starValue(nativeDict);
	const result: AllowedExtensionsDict = {};
	for (const key of new Set([...Object.keys(bundledDict), ...Object.keys(nativeDict)])) {
		if (key === '*') {
			continue; // handled explicitly below
		}
		const b = key in bundledDict ? bundledDict[key] : bundledStar;
		const n = key in nativeDict ? nativeDict[key] : nativeStar;
		result[key] = intersectAllowedEntry(b, n);
	}
	// The `"*"` floor can only get stricter: allow-all survives only if BOTH sources allow all.
	result['*'] = bundledStar && nativeStar;

	// The merged dict is delivered as a JSON string; PolicyConfiguration parses object-typed
	// policies that arrive as strings (configurations.ts), matching NativePolicyService.
	return JSON.stringify(result);
}

/** Resolves a dict's `"*"` fallback to a boolean (default-deny when unset or non-boolean). */
function starValue(dict: AllowedExtensionsDict): boolean {
	return dict['*'] === true;
}

function asAllowedExtensionsDict(value: PolicyValue | undefined): AllowedExtensionsDict | undefined {
	if (value === undefined) {
		return undefined;
	}
	let parsed: unknown = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!isObject(parsed) || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as AllowedExtensionsDict;
}

/**
 * Combines two per-key allowlist entries to the stricter of the two. `true` = allow any
 * version, `false` = deny, `"stable"` = stable-only, `string[]` = specific versions.
 */
function intersectAllowedEntry(b: boolean | string | string[], n: boolean | string | string[]): boolean | string | string[] {
	// A hard deny in either source wins.
	if (b === false || n === false) {
		return false;
	}
	// `true` is the most permissive: the result is whatever the other source constrains to.
	if (b === true) {
		return n;
	}
	if (n === true) {
		return b;
	}
	// Both are version arrays: keep only versions both allow.
	if (Array.isArray(b) && Array.isArray(n)) {
		const allowed = b.filter(v => n.includes(v));
		return allowed.length > 0 ? allowed : false;
	}
	// One side is a version array, the other is `"stable"`: the version pins are the stricter,
	// concrete constraint, so keep them.
	if (Array.isArray(b)) {
		return b;
	}
	if (Array.isArray(n)) {
		return n;
	}
	// Both are strings (e.g. both `"stable"`): if they agree keep it, otherwise deny.
	return b === n ? b : false;
}
