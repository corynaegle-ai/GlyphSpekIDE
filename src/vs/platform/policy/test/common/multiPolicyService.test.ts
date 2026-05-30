/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { runWithFakedTimers } from '../../../../base/test/common/timeTravelScheduler.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileService } from '../../../files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../log/common/log.js';
import { FilePolicyService } from '../../common/filePolicyService.js';
import { MultiPolicyService } from '../../common/multiPolicyService.js';
import { SovereignFilePolicyService } from '../../common/sovereignFilePolicyService.js';
import { IStringDictionary } from '../../../../base/common/collections.js';
import { PolicyDefinition } from '../../common/policy.js';

/**
 * GlyphSpek PATCH-001 acceptance test (policy layer).
 *
 * Verifies that a self-contained Sovereign build's bundled `AllowedExtensions` allowlist is
 * loaded at startup and that an OS native/MDM policy layered ahead of it can *tighten* the
 * allowlist but never *loosen* it (SECURITY-PATCHES.md PATCH-001, acceptance tests #1 and #4).
 */
suite('MultiPolicyService (GlyphSpek PATCH-001)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// `AllowedExtensions` is an object-typed policy, registered as `type: 'object'`.
	const policyDefinitions: IStringDictionary<PolicyDefinition> = {
		AllowedExtensions: {
			type: 'string', // object policies are delivered/parsed as JSON strings by the config layer
		},
	};

	let fileService: IFileService;
	const bundledFile = URI.file('/sovereign/policy.json').with({ scheme: 'vscode-tests' });
	const nativeFile = URI.file('/mdm/policy.json').with({ scheme: 'vscode-tests' });

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(bundledFile.scheme, provider));
	});

	async function writeFile(file: URI, content: object): Promise<void> {
		await fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(content)));
	}

	async function createService(native?: object | undefined): Promise<MultiPolicyService> {
		const bundled = disposables.add(new FilePolicyService(bundledFile, fileService, new NullLogService()));
		let nativeService: FilePolicyService | undefined;
		if (native !== undefined) {
			await writeFile(nativeFile, native);
			nativeService = disposables.add(new FilePolicyService(nativeFile, fileService, new NullLogService()));
		}
		const service = disposables.add(new MultiPolicyService(bundled, nativeService));
		await service.updatePolicyDefinitions(policyDefinitions);
		return service;
	}

	function allowed(service: MultiPolicyService): IStringDictionary<unknown> {
		const value = service.getPolicyValue('AllowedExtensions');
		assert.ok(typeof value === 'string', 'AllowedExtensions should be delivered as a JSON string');
		return JSON.parse(value as string);
	}

	test('PATCH-001', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		// #1 Bundled-only: a standalone Sovereign app boots WITH its allowlist (not "*").
		await writeFile(bundledFile, {
			AllowedExtensions: { glyphspek: true, 'redhat.vscode-yaml': ['1.14.0'], '*': false },
		});
		const bundledOnly = await createService(undefined);
		assert.deepStrictEqual(allowed(bundledOnly), {
			glyphspek: true,
			'redhat.vscode-yaml': ['1.14.0'],
			'*': false,
		});

		// #4 Native tightens: MDM removes the curated id -> it becomes disallowed; default-deny holds.
		const tightened = await createService({
			AllowedExtensions: { glyphspek: true, 'redhat.vscode-yaml': false, '*': false },
		});
		assert.deepStrictEqual(allowed(tightened), {
			glyphspek: true,
			'redhat.vscode-yaml': false,
			'*': false,
		});

		// Native CANNOT loosen: an MDM `"*": true` cannot re-open the floor the bundle denied,
		// and an entry the bundle never allowed cannot be added by native.
		const loosenAttempt = await createService({
			AllowedExtensions: { '*': true, 'ms-python.python': true },
		});
		const effective = allowed(loosenAttempt);
		assert.strictEqual(effective['*'], false, 'native cannot re-open the default-deny floor');
		assert.strictEqual(effective['ms-python.python'], false, 'native cannot add an extension the bundle did not allow');
		assert.strictEqual(effective['glyphspek'], true, 'bundle-allowed first-party stays allowed');
	}));
});

/**
 * GlyphSpek PATCH-001 fail-closed acceptance test (Sweep-19 Finding 2).
 *
 * A Sovereign build (the `glyphspekSovereignPolicyFile` flag is set, so `SovereignFilePolicyService`
 * is constructed) must NOT silently degrade to an all-allowed default when its bundled policy file
 * is missing/invalid. Instead `AllowedExtensions` must resolve to a deny-everything floor
 * (`{ "*": false }`), so no third-party extension can be enabled and the build is effectively
 * UNTRUSTED. A present, valid policy must boot Sovereign-enforced. Native/MDM, layered ahead, must
 * not be able to loosen the failed-closed floor.
 */
suite('SovereignFilePolicyService fail-closed (GlyphSpek PATCH-001 / Sweep-19 F2)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const policyDefinitions: IStringDictionary<PolicyDefinition> = {
		AllowedExtensions: { type: 'string' },
	};

	let fileService: IFileService;
	const bundledFile = URI.file('/sovereign/policy.json').with({ scheme: 'vscode-tests' });
	const nativeFile = URI.file('/mdm/policy.json').with({ scheme: 'vscode-tests' });

	setup(() => {
		fileService = disposables.add(new FileService(new NullLogService()));
		const provider = disposables.add(new InMemoryFileSystemProvider());
		disposables.add(fileService.registerProvider(bundledFile.scheme, provider));
	});

	async function writeFile(file: URI, content: object): Promise<void> {
		await fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(content)));
	}

	async function createService(opts: { writeBundled?: object | string; native?: object } = {}): Promise<MultiPolicyService> {
		if (opts.writeBundled !== undefined) {
			const content = typeof opts.writeBundled === 'string' ? opts.writeBundled : JSON.stringify(opts.writeBundled);
			await fileService.writeFile(bundledFile, VSBuffer.fromString(content));
		}
		// Sovereign bundled source FAILS CLOSED when the file is absent/invalid.
		const bundled = disposables.add(new SovereignFilePolicyService(bundledFile, fileService, new NullLogService()));
		let nativeService: FilePolicyService | undefined;
		if (opts.native !== undefined) {
			await writeFile(nativeFile, opts.native);
			nativeService = disposables.add(new FilePolicyService(nativeFile, fileService, new NullLogService()));
		}
		const service = disposables.add(new MultiPolicyService(bundled, nativeService));
		await service.updatePolicyDefinitions(policyDefinitions);
		return service;
	}

	function allowed(service: MultiPolicyService): IStringDictionary<unknown> {
		const value = service.getPolicyValue('AllowedExtensions');
		assert.ok(typeof value === 'string', 'AllowedExtensions should be delivered as a JSON string');
		return JSON.parse(value as string);
	}

	test('present valid policy boots Sovereign-enforced; missing/invalid fails closed (deny-all)', () => runWithFakedTimers({ useFakeTimers: true }, async () => {
		// Present + valid -> the real curated allowlist is enforced (NOT all-allowed).
		const enforced = await createService({ writeBundled: { AllowedExtensions: { glyphspek: true, '*': false } } });
		assert.deepStrictEqual(allowed(enforced), { glyphspek: true, '*': false });

		// Missing policy file -> deny-all floor (UNTRUSTED), NOT an empty/all-allowed policy.
		const missing = await createService({});
		assert.deepStrictEqual(allowed(missing), { '*': false }, 'missing policy must deny all extensions');

		// Invalid JSON -> deny-all floor.
		const invalid = await createService({ writeBundled: '{ this is not json' });
		assert.deepStrictEqual(allowed(invalid), { '*': false }, 'invalid policy must deny all extensions');

		// Fail-closed floor cannot be loosened by native/MDM (which tries to re-open everything).
		const withNative = await createService({ native: { AllowedExtensions: { '*': true, 'ms-python.python': true } } });
		const effective = allowed(withNative);
		assert.strictEqual(effective['*'], false, 'native cannot re-open the failed-closed deny-all floor');
		assert.strictEqual(effective['ms-python.python'], false, 'native cannot add an extension while failed closed');
	}));
});
