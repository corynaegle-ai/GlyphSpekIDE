/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { mock } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { COPILOT_VENDOR_ID } from '../../../contrib/chat/common/languageModels.js';
import { IExtHostAuthentication } from '../../common/extHostAuthentication.js';
import { ExtHostLanguageModels } from '../../common/extHostLanguageModels.js';
import { AnyCallRPCProtocol } from './testRPCProtocol.js';
import type { MainThreadLanguageModelsShape } from '../../common/extHost.protocol.js';

suite('ExtHostLanguageModels', function () {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const GLYPHSPEK_VENDOR = 'glyphspek';
	const GLYPHSPEK_MODEL_ID = 'glyphspek-codex-gateway';

	function makeLanguageModels(): ExtHostLanguageModels {
		// `$selectChatModels` must return an array: when no chat-default is cached,
		// `getDefaultLanguageModel` re-resolves via `selectLanguageModels`, which maps over the
		// main-thread result. Default the proxy call to an empty list so the fail-closed path
		// (no GlyphSpek/Copilot default) re-resolves cleanly and still returns undefined.
		const proxy: Pick<MainThreadLanguageModelsShape, '$selectChatModels'> = {
			$selectChatModels: async () => [],
		};
		return store.add(new ExtHostLanguageModels(
			AnyCallRPCProtocol(proxy),
			new NullLogService(),
			new class extends mock<IExtHostAuthentication>() { }
		));
	}

	// A built-in with `chatProvider` enabled so the host honors `isDefault`.
	const extension = { ...nullExtensionDescription, enabledApiProposals: ['chatProvider'] };

	/**
	 * Register a single chat-default provider for `vendor` and populate the local model
	 * cache the way the main thread does (`selectLanguageModels` triggers this under the
	 * hood).
	 */
	async function registerChatDefaultProvider(extHostLanguageModels: ExtHostLanguageModels, vendor: string, modelId: string): Promise<void> {
		store.add(extHostLanguageModels.registerLanguageModelChatProvider(extension, vendor, {
			async provideLanguageModelChatInformation() {
				return [{
					id: modelId,
					name: 'GlyphSpek (Codex Gateway)',
					family: 'codex',
					version: '1',
					maxInputTokens: 128000,
					maxOutputTokens: 16000,
					capabilities: {},
					// The chat default for the de-Copilot fork.
					isDefault: true,
					isUserSelectable: true,
				}];
			},
			async provideLanguageModelChatResponse() { /* never reached in these tests */ },
			async provideTokenCount() { return 1; },
		}));
		await extHostLanguageModels.$provideLanguageModelChatInfo(vendor, { silent: true }, CancellationToken.None);
	}

	/**
	 * The GlyphSpek fork strips Copilot and ships a FIRST-PARTY non-Copilot chat-default
	 * model (the governed Codex gateway). This is the regression guard for the stock chat
	 * panel's "Language model unavailable" break: `getDefaultLanguageModel` must resolve the
	 * GlyphSpek-vendor model that is marked `isDefault` for the Chat location.
	 */
	test('getDefaultLanguageModel resolves the first-party GlyphSpek chat-default model', async function () {
		const extHostLanguageModels = makeLanguageModels();
		await registerChatDefaultProvider(extHostLanguageModels, GLYPHSPEK_VENDOR, GLYPHSPEK_MODEL_ID);

		const model = await extHostLanguageModels.getDefaultLanguageModel(extension);

		assert.ok(model, 'a default chat model resolves (no "Language model unavailable")');
		assert.deepStrictEqual(
			{ id: model.id, vendor: model.vendor, isCopilot: model.vendor === COPILOT_VENDOR_ID },
			{ id: GLYPHSPEK_MODEL_ID, vendor: GLYPHSPEK_VENDOR, isCopilot: false },
			'the resolved default is our first-party non-Copilot Codex-gateway model',
		);
	});

	/**
	 * Adversarial: a SECOND non-Copilot `isDefault` provider (a future proposal-granted or
	 * developer provider) registers BEFORE the GlyphSpek one. The tightened resolver must
	 * still pick the GlyphSpek-vendor model, never let registration order hand "Auto" to a
	 * non-GlyphSpek vendor.
	 */
	test('getDefaultLanguageModel prefers the GlyphSpek vendor over an earlier non-Copilot default', async function () {
		const extHostLanguageModels = makeLanguageModels();
		// Register the foreign chat-default FIRST so insertion order favors it.
		await registerChatDefaultProvider(extHostLanguageModels, 'other', 'other-default-model');
		await registerChatDefaultProvider(extHostLanguageModels, GLYPHSPEK_VENDOR, GLYPHSPEK_MODEL_ID);

		const model = await extHostLanguageModels.getDefaultLanguageModel(extension);

		assert.ok(model, 'a default chat model resolves');
		assert.deepStrictEqual(
			{ id: model.id, vendor: model.vendor },
			{ id: GLYPHSPEK_MODEL_ID, vendor: GLYPHSPEK_VENDOR },
			'the GlyphSpek vendor wins even though "other" registered its chat-default first',
		);
	});

	/**
	 * Fail-closed: with ONLY a non-GlyphSpek, non-Copilot default registered, the resolver
	 * returns undefined (→ honest "Language model unavailable") rather than resolving some
	 * other vendor's governed model. Proves a non-GlyphSpek default can never win "Auto".
	 */
	test('getDefaultLanguageModel returns undefined when only a non-GlyphSpek default exists', async function () {
		const extHostLanguageModels = makeLanguageModels();
		await registerChatDefaultProvider(extHostLanguageModels, 'other', 'other-default-model');

		const model = await extHostLanguageModels.getDefaultLanguageModel(extension);

		assert.strictEqual(model, undefined, 'fails closed: no GlyphSpek (or Copilot) chat-default → no default resolved');
	});
});
