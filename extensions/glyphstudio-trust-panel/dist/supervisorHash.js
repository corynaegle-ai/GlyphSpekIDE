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
exports.BUNDLED_SUPERVISOR_SHA256 = 'f282616c7045bafeca9dda06b275dfc74d336e253d8c5fc7f5553c2826e3014a';
exports.BUNDLED_BRIDGE_SERVER_SHA256 = '0606b029c428869724c53bfea4503e0168fcbe98e43fb930d7a747375f941f9c';
//# sourceMappingURL=supervisorHash.js.map