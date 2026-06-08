/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { IUntypedEditorInput } from '../../../common/editor.js';

/**
 * GlyphCode Home — the editor input for the full-window landing surface (PATCH-004).
 *
 * Modeled on `GettingStartedInput`: a single, resource-keyed editor input that the
 * workbench opens into the editor area. There is exactly one Home (singlePerResource),
 * so it can be revealed-if-open rather than duplicated.
 */
export const glyphcodeHomeInputTypeId = 'workbench.editors.glyphcodeHomeInput';

export class GlyphspekHomeInput extends EditorInput {

	static readonly ID = glyphcodeHomeInputTypeId;
	static readonly RESOURCE = URI.from({ scheme: Schemas.walkThrough, authority: 'glyphcode_home' });

	override get typeId(): string {
		return GlyphspekHomeInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI | undefined {
		return GlyphspekHomeInput.RESOURCE;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: GlyphspekHomeInput.RESOURCE,
			options: {
				override: GlyphspekHomeInput.ID,
				pinned: false
			}
		};
	}

	override getName(): string {
		return localize('glyphcodeHome', "GlyphCode Home");
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}

		return other instanceof GlyphspekHomeInput;
	}
}
