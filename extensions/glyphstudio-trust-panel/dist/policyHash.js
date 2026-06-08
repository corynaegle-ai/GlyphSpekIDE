"use strict";
/*
 * Policy-file fingerprinting for run provenance — with a hard guard.
 *
 * The governed-run command logs (and, for repo-supplied policies, confirms in a
 * modal) the sha256 of the EXACT policy bytes that govern a run. Because
 * `glyphstudio.policyPath` may LEGITIMATELY come from workspace settings
 * (policy-as-code), a repo could point it at a huge file or a special path
 * (a FIFO, /dev/zero, a directory). This module STATS before reading: it
 * requires a regular file and caps the size, so fingerprinting can never block
 * or exhaust the extension host. No `vscode` import, so it is unit-testable
 * headlessly (mirrors configScope.ts / inlineScript.ts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_POLICY_BYTES = void 0;
exports.policyFileSha256 = policyFileSha256;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
/**
 * Max bytes we will read to fingerprint a policy file. Policies are small JSON;
 * anything larger is not hashed for provenance (the supervisor still loads the
 * real file in its own process).
 */
exports.MAX_POLICY_BYTES = 1024 * 1024; // 1 MiB
/**
 * Fingerprint a policy file for provenance. Never throws. STATS first: a
 * non-regular file or one larger than {@link MAX_POLICY_BYTES} is reported via
 * `note` and is NOT read, so a workspace-pointed huge/special path cannot hang
 * or OOM the extension host.
 */
function policyFileSha256(filePath) {
    let st;
    try {
        st = (0, node_fs_1.statSync)(filePath);
    }
    catch {
        return { note: 'unreadable — file missing or not yet created' };
    }
    if (!st.isFile())
        return { note: 'not a regular file' };
    if (st.size > exports.MAX_POLICY_BYTES) {
        return { note: `too large to fingerprint (${st.size} bytes > ${exports.MAX_POLICY_BYTES})` };
    }
    try {
        return { sha256: (0, node_crypto_1.createHash)('sha256').update((0, node_fs_1.readFileSync)(filePath)).digest('hex') };
    }
    catch {
        return { note: 'unreadable' };
    }
}
//# sourceMappingURL=policyHash.js.map