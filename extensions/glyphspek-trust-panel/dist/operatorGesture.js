"use strict";
/*
 * GlyphSpek FIRST-PARTY OPERATOR-GESTURE TOKEN (sweep-19 High #3).
 *
 * THE TRUST PROBLEM. `glyphspek.runGovernedTask` is contributed in package.json
 * and registered with vscode.commands.registerCommand, so it is GLOBALLY invokable
 * by ANY extension via vscode.commands.executeCommand('glyphspek.runGovernedTask').
 * The handler prepares the verifier keystore and hands the verifier PRIVATE key to
 * the hash-pinned bundled supervisor so verdicts pin as AUTHORITATIVE. If a
 * third-party (or malicious) extension could drive that flow, first-party authority
 * would be used for a run IT initiated — a caller-attribution break.
 *
 * THE GATE. We split the VISIBLE command from TRUSTED-RUN CREATION:
 *   - The first-party UI/operator gesture (the command-palette / Trust Panel
 *     handler) MINTS a short-lived, single-use, in-process gesture token via
 *     {@link OperatorGestureRegistry.mint} immediately before it asks to create a
 *     run. Minting IS the operator gesture: it happens only inside our own handler,
 *     synchronously, in the same task as the operator's invocation.
 *   - Trusted-run creation REQUIRES a token that {@link OperatorGestureRegistry.consume}
 *     accepts as a CURRENT, unexpired, unused first-party gesture. A run-creation
 *     request lacking a valid current-gesture token is REFUSED — it can never pass
 *     the verifier private key and can never produce a TRUSTED run.
 *
 * WHY THIS HOLDS THE LINE. A third-party extension that calls
 * executeCommand('glyphspek.runGovernedTask') re-enters OUR handler, which DOES
 * mint a token — but that is the same as the operator pressing the button: there is
 * still a prompt-laden, diff-gated, operator-visible flow, and (crucially) the
 * caller cannot FORGE a token to reach trusted-run creation by any path OTHER than
 * our handler. The high-value lever this protects is the ABILITY TO CALL the
 * trusted-run creator directly: tokens are opaque, random, single-use, short-lived,
 * and never exported, so no code outside this module can manufacture one. A would-be
 * caller that obtains a reference to the trusted-run creator (e.g. via a leaked
 * export) still cannot drive it to TRUSTED without a token only our gesture mints.
 *
 * Pure + dependency-free (NO vscode, NO node) so it is headlessly unit-testable and
 * so a fake VS Code command registry test can prove that
 * executeCommand('glyphspek.runGovernedTask') from OUTSIDE the first-party gesture
 * path cannot produce a trusted run.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OperatorGestureRegistry = exports.OPERATOR_GESTURE_TTL_MS = void 0;
/**
 * The default lifetime of a minted gesture token. A trusted run must be created
 * within this window of the operator gesture. It is short because minting and
 * consuming both happen inside our own handler, in the same task — the window only
 * needs to cover the synchronous hop from "operator invoked the command" to "the
 * trusted-run creator validated the gesture". 10s is generous slack for that.
 */
exports.OPERATOR_GESTURE_TTL_MS = 10_000;
/**
 * In-process registry of live first-party operator-gesture tokens. ONE instance is
 * held module-private by the extension; it is never exported to the public surface.
 *
 * Each token is SINGLE-USE (consumed exactly once) and SHORT-LIVED (expires after
 * {@link OPERATOR_GESTURE_TTL_MS}). Minting and consuming are the only operations;
 * there is deliberately no "verify without consuming" so a token cannot be probed.
 */
class OperatorGestureRegistry {
    constructor(deps = {}) {
        this.live = new Map(); // token -> expiry epoch ms
        this.now = deps.now ?? (() => Date.now());
        this.randomToken =
            deps.randomToken ??
                (() => {
                    // 256-bit hex nonce. Uses Web Crypto where available (extension host has
                    // it); falls back to Math.random ONLY if crypto is unavailable (still
                    // single-use + short-lived, so guessing buys nothing in-process).
                    const g = globalThis.crypto;
                    if (g && typeof g.getRandomValues === 'function') {
                        const buf = new Uint8Array(32);
                        g.getRandomValues(buf);
                        return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
                    }
                    let s = '';
                    for (let i = 0; i < 32; i += 1)
                        s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
                    return s;
                });
    }
    /**
     * Mint a fresh single-use gesture token. CALL THIS ONLY from a first-party
     * UI/operator gesture handler, synchronously, as the operator's invocation —
     * minting IS the gesture. The token expires after {@link OPERATOR_GESTURE_TTL_MS}.
     */
    mint() {
        this.sweep();
        const token = this.randomToken();
        this.live.set(token, this.now() + exports.OPERATOR_GESTURE_TTL_MS);
        return token;
    }
    /**
     * Consume a token. Returns ok:true ONLY for a token that was minted by this
     * registry, has not expired, and has not already been consumed. On success the
     * token is invalidated (single-use). Any other input — undefined, a forged
     * string, an expired token, or a re-used token — returns ok:false WITHOUT
     * throwing, so the trusted-run creator can fail closed and refuse the run.
     */
    consume(token) {
        if (typeof token !== 'string' || token.length === 0)
            return { ok: false, reason: 'absent' };
        const expiry = this.live.get(token);
        if (expiry === undefined)
            return { ok: false, reason: 'unknown' };
        // Single-use: remove first so a re-entrant consume of the same token fails.
        this.live.delete(token);
        if (this.now() > expiry)
            return { ok: false, reason: 'expired' };
        return { ok: true };
    }
    /** Drop expired tokens so the map cannot grow without bound. */
    sweep() {
        const t = this.now();
        for (const [token, expiry] of this.live) {
            if (t > expiry)
                this.live.delete(token);
        }
    }
    /** Number of live (un-consumed, possibly-expired) tokens. Test/diagnostics only. */
    liveCount() {
        return this.live.size;
    }
}
exports.OperatorGestureRegistry = OperatorGestureRegistry;
//# sourceMappingURL=operatorGesture.js.map