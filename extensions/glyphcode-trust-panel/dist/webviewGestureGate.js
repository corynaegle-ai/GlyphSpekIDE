"use strict";
/*
 * GlyphCode FIRST-PARTY WEBVIEW GESTURE GATE (sweep-20 High #3 — rework of sweep-19).
 *
 * WHY THE COMMAND-HANDLER MINT WAS INSUFFICIENT. The sweep-19 fix minted the
 * operator-gesture token INSIDE the globally-invokable `glyphcode.runGovernedTask`
 * command handler. VS Code commands carry NO trustworthy caller attribution, so a
 * third-party extension that calls
 * `vscode.commands.executeCommand('glyphcode.runGovernedTask')` RE-ENTERS our
 * handler, which then minted a token and proceeded — the gate consumed a token the
 * third party effectively caused us to mint. Same for the new
 * `glyphcode.bridgeSupervisedRun` / `glyphcode.startLiveRun` commands (no gate at
 * all). The lever the gate must protect — "the ability to drive a PRODUCT-TRUSTED
 * run (verifier private key, trust:'trusted')" — was still reachable from a global
 * command.
 *
 * WHAT A THIRD PARTY CANNOT FORGE. A third-party extension can invoke any of our
 * commands, but it CANNOT post a message into OUR first-party webview: VS Code
 * isolates each webview, and only the extension that created the panel receives its
 * `onDidReceiveMessage`. So the genuine first-party operator gesture is "the
 * operator clicked a button INSIDE the GlyphCode Trust Panel webview, which posted
 * a message to US". That message — and ONLY that message — may mint+consume a
 * gesture token and start a product-trusted run.
 *
 * THE GATE. This module owns the gesture registry AND the set of trusted-run
 * LAUNCHERS (keyed by a small, fixed set of run kinds). A launcher is registered by
 * the host (the command-wiring layer) and is the ONLY code that creates a
 * product-trusted run. It is invoked EXCLUSIVELY via {@link WebviewGestureGate.launchFromWebview},
 * which the Trust Panel calls from inside its webview message handler — i.e. only a
 * real first-party webview gesture reaches a launcher. A command-palette invocation
 * does NOT call a launcher directly; it asks the Trust Panel to surface the
 * first-party "start run" affordance, and the launcher runs only after the operator
 * clicks it in the webview.
 *
 * Pure + dependency-free (NO vscode, NO node) so it is headlessly unit-testable: a
 * test can prove that a launcher runs trusted ONLY through launchFromWebview and
 * NEVER from a path that lacks a current webview gesture.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebviewGestureGate = exports.TRUSTED_RUN_KINDS = void 0;
exports.isTrustedRunKind = isTrustedRunKind;
const operatorGesture_js_1 = require("./operatorGesture.js");
/** Every {@link TrustedRunKind}, for validation/iteration. */
exports.TRUSTED_RUN_KINDS = ['governed', 'bridge', 'live'];
/** True iff `k` is one of the fixed, reviewed trusted-run kinds. */
function isTrustedRunKind(k) {
    return typeof k === 'string' && exports.TRUSTED_RUN_KINDS.includes(k);
}
/**
 * The gate the Trust Panel + command-wiring share. ONE instance is held
 * module-private by the extension and never exported to the public surface.
 *
 * - The HOST registers a launcher per kind via {@link registerLauncher}.
 * - The Trust Panel webview message handler calls {@link launchFromWebview} when the
 *   operator clicks a first-party "start run" button. ONLY this path mints+consumes
 *   a gesture token and invokes a launcher — so only a real first-party webview
 *   gesture can drive a product-trusted run.
 */
class WebviewGestureGate {
    constructor(gestures = new operatorGesture_js_1.OperatorGestureRegistry()) {
        this.launchers = new Map();
        this.gestures = gestures;
    }
    /** Register the trusted-run launcher for `kind`. Called once per kind by the host. */
    registerLauncher(kind, launcher) {
        this.launchers.set(kind, launcher);
    }
    /**
     * Start a trusted run of `kind` AS A FIRST-PARTY WEBVIEW GESTURE. This is the ONLY
     * method that mints a gesture token, and it must be called ONLY from the Trust
     * Panel's own `webview.onDidReceiveMessage` handler (a third-party extension
     * cannot post into our webview, so it can never reach here). The freshly-minted
     * token is handed to the launcher, which forwards it to the trusted-run creator;
     * the creator consumes it and refuses without a valid current gesture.
     *
     * Returns ok:false (without throwing) for an unknown kind or a kind with no
     * registered launcher, so a malformed webview message can never reach a launcher.
     */
    async launchFromWebview(kind) {
        if (!isTrustedRunKind(kind))
            return { ok: false, reason: 'unknown-kind' };
        const launcher = this.launchers.get(kind);
        if (!launcher)
            return { ok: false, reason: 'no-launcher' };
        // Minting HERE — inside the webview-gesture path only — IS the operator gesture.
        const gesture = this.gestures.mint();
        await launcher(gesture);
        return { ok: true, kind };
    }
}
exports.WebviewGestureGate = WebviewGestureGate;
//# sourceMappingURL=webviewGestureGate.js.map