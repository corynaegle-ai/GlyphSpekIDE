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
exports.BUNDLED_SUPERVISOR_SHA256 = '2176c3dc9e912a9afd3b168481f85fa254a4d88a1efaaebcb951e764bef3e918';
exports.BUNDLED_BRIDGE_SERVER_SHA256 = '90d904742345b11d9a4ae515b8f6523441ddb41b9dc1da6fecb17c8674584b8c';
//# sourceMappingURL=supervisorHash.js.map