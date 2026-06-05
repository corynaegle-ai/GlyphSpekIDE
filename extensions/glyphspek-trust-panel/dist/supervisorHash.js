"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUNDLED_BRIDGE_SERVER_SHA256 = exports.BUNDLED_SUPERVISOR_SHA256 = void 0;
/*
 * GENERATED FILE — do not edit by hand.
 *
 * Written by scripts/build-supervisor.mjs after bundling the supervisor
 * entrypoints into dist-supervisor/. Each constant is the sha256 of that
 * exact bundle. The runtime hash gates (supervisorRunner.ts and bridge.ts via
 * supervisorBinary.verifyBundleHash) refuse to spawn a bundle whose on-disk
 * sha256 != its constant. Because tsc compiles these values into
 * dist/extension.js, the gates cannot be defeated by editing a sibling file —
 * the bundle must be re-built (re-running this script regenerates the hashes).
 */
exports.BUNDLED_SUPERVISOR_SHA256 = '9dd52d7c8e870085d3b5767b76d8529c97023e2595da71252a163503606a8123';
exports.BUNDLED_BRIDGE_SERVER_SHA256 = '936146edbaa318004505110b186039306a3c8d637ed9a7bffcf91df059aad74a';
//# sourceMappingURL=supervisorHash.js.map