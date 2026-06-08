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
exports.BUNDLED_SUPERVISOR_SHA256 = 'ab3de0a5574f080d74e02c76ee558e3adb811ba84f441122ff8b76a7bd31feb0';
exports.BUNDLED_BRIDGE_SERVER_SHA256 = '302a9f61633b246d2894d864a4b302a2ae0c231a3afee0a9272adcf1ba150d27';
//# sourceMappingURL=supervisorHash.js.map