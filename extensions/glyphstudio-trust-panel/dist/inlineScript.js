"use strict";
/*
 * Inline-<script> embedding helper (pure; NO vscode dependency).
 *
 * Lives in its own module so it can be unit-tested under plain node:test against
 * the compiled dist/ output without requiring the `vscode` host module (which is
 * only available inside the editor). The extension host imports it from here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeForInlineScript = escapeForInlineScript;
/**
 * JSON-serialize a value for SAFE embedding inside an inline <script> element.
 *
 * `JSON.stringify` alone is NOT safe here: it does not escape for the HTML
 * script-data context, so a string value containing the literal closing-script
 * sequence (`</` + `script>`) would terminate the surrounding <script> element
 * early — letting attacker-controlled bytes (e.g. a trusted-key value sourced
 * from a setting or keystore file) introduce markup before app.js even loads.
 *
 * We JSON-stringify and THEN escape the characters that can break out of, or be
 * misinterpreted within, an inline script:
 *   - `<` -> < and `>` -> >   (so `</script>` / any tag cannot form)
 *   - `&` -> &                     (defuses HTML entity interpretation)
 *   - U+2028 / U+2029 ->
 /
   (LINE/PARAGRAPH SEPARATOR: valid in
 *                                         JSON strings but illegal raw in JS source)
 * The result is still valid JSON (these are all standard \uXXXX escapes), so the
 * webview parses the value identically — it just cannot inject markup.
 */
function escapeForInlineScript(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}
//# sourceMappingURL=inlineScript.js.map