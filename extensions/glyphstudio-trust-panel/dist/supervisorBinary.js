"use strict";
/*
 * Supervisor binary hash-pin gate (hand-written; the pinned hash itself lives in
 * the GENERATED supervisorHash.ts, which build-supervisor.mjs OVERWRITES whole on
 * every build — so the gate logic cannot live there).
 *
 * This is the SINGLE implementation of the hash-pin check, shared by BOTH spawn
 * paths so neither can drift to a weaker check:
 *   - the verify-only governed-run launcher (supervisorRunner.ts), and
 *   - the authenticated supervisor bridge (bridge.ts, M2).
 *
 * Pinning the bundle's sha256 before spawn means tampering with the shipped
 * bundle (or a partial/corrupt write) REFUSES-to-spawn rather than silently
 * running unverified code that is handed the verifier private key. The pinned
 * constant is compiled into dist/extension.js by tsc, so the gate cannot be
 * defeated by editing a sibling .mjs/.ts file — the bundle must be rebuilt
 * (which regenerates the hash).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyBundleHash = verifyBundleHash;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const supervisorHash_1 = require("./supervisorHash");
/**
 * Hash-pin gate for a supervisor binary. Reads the file at `binaryPath` off disk,
 * computes its sha256, and compares it to the EXPECTED hash (defaulting to the
 * build-pinned {@link BUNDLED_SUPERVISOR_SHA256}). Returns an error MESSAGE on
 * mismatch or read failure, or `undefined` when the bytes verify.
 *
 * Returning a message (rather than throwing) lets every caller turn a mismatch
 * into a distinct REFUSE-to-spawn outcome. The dev-override (un-bundled tsx) path
 * is intentionally NOT gated by its callers; this helper is only invoked for the
 * bundled, pinned path.
 *
 * @param binaryPath     absolute path to the supervisor bundle to verify
 * @param expectedSha256 the pinned hash to match (default: the bundled constant)
 * @returns an operator-facing mismatch message, or undefined when verified
 */
function verifyBundleHash(binaryPath, expectedSha256 = supervisorHash_1.BUNDLED_SUPERVISOR_SHA256) {
    let bytes;
    try {
        bytes = (0, node_fs_1.readFileSync)(binaryPath);
    }
    catch (err) {
        return `supervisor binary not readable at ${binaryPath}: ${String(err?.message ?? err)}`;
    }
    const actual = (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
    if (actual !== expectedSha256) {
        return (`supervisor binary hash mismatch — refusing to spawn. Expected sha256 ` +
            `${expectedSha256}, got ${actual} for ${binaryPath}. Re-run ` +
            `"npm run bundle:supervisor" to rebuild the pinned bundle.`);
    }
    return undefined;
}
//# sourceMappingURL=supervisorBinary.js.map