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
exports.BUNDLED_SUPERVISOR_SHA256 = '8f0a5215c248aa7c9b00fe0d4893a88e08b9758366a90e9ab288dc51a96e8ca1';
exports.BUNDLED_BRIDGE_SERVER_SHA256 = 'c62d86f8cd780fd303186bc76dc3501d54000a62e071188af2124be46642ba84';
//# sourceMappingURL=supervisorHash.js.map