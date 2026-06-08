"use strict";
/*
 * GlyphCode CHAT TERMINAL VIEW (M7 — "chat that's a terminal").
 *
 * A WebviewViewProvider for the activity-bar `glyphcode.chat` view that hosts an
 * xterm.js terminal connected to a real PTY running the user's INTERACTIVE `claude`,
 * GOVERNED. Under the hood it is a terminal; styled to read as a chat. This is the
 * sidebar Chat surface the product wants — VS Code's own integrated terminals cannot
 * live in an activity-bar view, so we host OUR OWN terminal in a webview.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A WEBVIEW-VIEW + xterm + PTY (and not a VS Code terminal). Subscription
 * `claude` is INTERACTIVE-ONLY (headless/API are metered + expensive), so the chat
 * MUST be the interactive `claude` TUI. The TUI renders only when it sees a TTY. We
 * give it one with a real PTY (node-pty — see spikes/p0-governed-pty/governed-pty.ts
 * for why node-pty over `script`), pipe the PTY's output into an xterm.js instance in
 * this webview, and pipe the webview xterm's keystrokes back into the PTY. Claude's
 * own TUI provides the conversation; GlyphCode provides the governed frame.
 *
 * GOVERNANCE / TRUST POSTURE. The PTY child runs under the SAME governed env contract
 * as the rest of M7 (buildGovernedTerminalEnv): egress forced through the
 * supervisor-owned metadata-only proxy, ambient host secrets stripped, HOME preserved
 * so `claude` authenticates from its OWN ~/.claude store (the user's SUBSCRIPTION).
 * GlyphCode injects NO credential and sets NO base-url override (anti-FauxCode). The
 * session reuses startGovernedTerminalSession → a `governed-unsandboxed` run projected
 * LIVE into the Trust Panel + Governed Runs sidebar. SOFT boundary, UNSANDBOXED, NEVER
 * product-trusted.
 *
 * BINARY-SWAP GUARD. The auto-launched binary is the canonical absolute path
 * resolveAgentLaunch pins (workspace-local resolutions are refused), and its identity
 * is captured immediately before launch and threaded into the run request (TOCTOU).
 * ─────────────────────────────────────────────────────────────────────────────
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatTerminalViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("node:fs"));
const crypto = __importStar(require("node:crypto"));
const governedTerminalEnv_1 = require("./governedTerminalEnv");
const ptyHost_1 = require("./ptyHost");
/** Narrow a startSession result to the error case (vs. a real session). */
function isChatSessionError(v) {
    return !!v && typeof v.error === 'string';
}
/**
 * The activity-bar Chat view. One PTY session at a time; closing/disposing the view
 * (or the child exiting) finalizes the governed run.
 */
class ChatTerminalViewProvider {
    constructor(extensionUri, deps, output) {
        this.extensionUri = extensionUri;
        this.deps = deps;
        this.output = output;
        this.starting = false;
    }
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        view.webview.html = this.getHtml(view.webview);
        view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
        // Tear down the PTY + finalize the run when the view goes away.
        view.onDidDispose(() => {
            void this.teardown();
            this.view = undefined;
        });
    }
    post(msg) {
        void this.view?.webview.postMessage(msg);
    }
    /**
     * Deliver a REAL broker `decide()` verdict for one governed command to the webview,
     * which renders the inline `.brk` chip (spec §5.6). HONESTY CONTRACT: callers must
     * only invoke this with an actual broker verdict — there is deliberately no
     * "default allow" path, so a command with no real verdict simply gets no chip.
     *
     * This is the typed seam the host wires to once per-command brokering + bridge→view
     * event plumbing land (today the chat PTY is boundary-observed and the run/event
     * stream goes to the Trust Panel; see {@link BrokerVerdictChip} and the report). It
     * is intentionally additive: nothing calls it yet, so no synthetic chip is produced.
     */
    postBrokerVerdict(chip) {
        if (!chip || (chip.verdict !== 'allow' && chip.verdict !== 'ask' && chip.verdict !== 'deny')) {
            // Refuse to forward a malformed/absent verdict — a missing chip is honest;
            // a fabricated one is not.
            return;
        }
        this.post({ type: 'brokerVerdict', ...chip });
    }
    onMessage(msg) {
        if (!msg || typeof msg !== 'object')
            return;
        switch (msg.type) {
            case 'ready':
                // The webview booted; nothing to replay yet (start is user-gestured).
                return;
            case 'start':
                void this.start();
                return;
            case 'input':
                if (typeof msg.data === 'string')
                    this.pty?.write(msg.data);
                return;
            case 'resize':
                this.pendingSize = { cols: msg.cols, rows: msg.rows };
                this.pty?.resize({ cols: msg.cols, rows: msg.rows });
                return;
        }
    }
    /** Start the governed PTY session: governed env → real PTY → interactive claude. */
    async start() {
        if (this.starting || this.pty)
            return; // single session
        this.starting = true;
        try {
            const ptyMod = this.deps.resolveNodePty();
            if (!ptyMod) {
                this.post({
                    type: 'error',
                    message: 'GlyphCode Chat needs a PTY backend (node-pty) to run your interactive Claude Code. ' +
                        'It was not available in this build. The wiring is proven in the spike; production ' +
                        'packaging of the native PTY is the remaining step.',
                });
                return;
            }
            const session = await this.deps.startSession();
            if (isChatSessionError(session)) {
                // Honest, non-silent failure: surface the reason in the webview empty state
                // (e.g. "couldn't find Claude Code / Codex on your PATH").
                this.post({ type: 'error', message: session.error });
                return;
            }
            if (!session) {
                // startSession already surfaced the reason elsewhere (e.g. a modal warning).
                return;
            }
            this.session = session;
            // Build the governed env: force egress through the supervisor proxy, strip
            // ambient secrets, preserve HOME for the ~/.claude subscription auth.
            const { env: governedEnv } = (0, governedTerminalEnv_1.buildGovernedTerminalEnv)({
                proxyUrl: session.proxyUrl,
                baseEnv: process.env,
            });
            const pty = (0, ptyHost_1.spawnGovernedPty)({
                file: session.launchPath,
                args: session.args,
                cwd: session.cwd,
                env: governedEnv,
                size: this.pendingSize,
                pty: ptyMod,
            });
            this.pty = pty;
            pty.onData((data) => this.post({ type: 'output', data }));
            pty.onExit(({ exitCode }) => {
                this.post({ type: 'exited', code: exitCode });
                void this.teardown();
            });
            this.post({ type: 'started', runId: session.runId, launchPath: session.launchPath });
            this.output.appendLine(`[chat] governed PTY started — run ${session.runId}, binary ${session.launchPath}. ` +
                'Governed (metadata-only egress) + traced; UNSANDBOXED; GlyphCode holds no key.');
        }
        catch (err) {
            const message = `GlyphCode Chat could not start: ${String(err?.message ?? err)}`;
            this.post({ type: 'error', message });
            this.output.appendLine(`[chat] ${message}`);
            await this.teardown();
        }
        finally {
            this.starting = false;
        }
    }
    /** Kill the PTY and finalize the governed run. Idempotent. */
    async teardown() {
        const pty = this.pty;
        const session = this.session;
        this.pty = undefined;
        this.session = undefined;
        pty?.kill();
        if (session) {
            try {
                await session.stop();
            }
            catch (err) {
                this.output.appendLine(`[chat] session stop failed (ignored): ${String(err?.message ?? err)}`);
            }
        }
    }
    /**
     * Build the webview HTML from media/chat-terminal.html: inject a per-load nonce, the
     * webview cspSource, and asWebviewUri-rewritten URIs for the vendored xterm assets +
     * the GlyphCode logo. Scripts run only with the nonce; assets only from media/.
     */
    getHtml(webview) {
        const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
        const htmlPath = vscode.Uri.joinPath(mediaUri, 'chat-terminal.html');
        let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
        const xtermDir = vscode.Uri.joinPath(mediaUri, 'vendor', 'xterm');
        const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermDir, 'xterm.js'));
        const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermDir, 'xterm.css'));
        const fitJsUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermDir, 'addon-fit.js'));
        const chatJsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'chat-terminal.js'));
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'icons', 'gs-activitybar.svg'));
        const nonce = crypto.randomBytes(16).toString('base64');
        return html
            .replace(/\{\{cspSource\}\}/g, webview.cspSource)
            .replace(/\{\{nonce\}\}/g, nonce)
            .replace(/\{\{xtermCssUri\}\}/g, xtermCssUri.toString())
            .replace(/\{\{xtermJsUri\}\}/g, xtermJsUri.toString())
            .replace(/\{\{fitJsUri\}\}/g, fitJsUri.toString())
            .replace(/\{\{chatJsUri\}\}/g, chatJsUri.toString())
            .replace(/\{\{logoUri\}\}/g, logoUri.toString());
    }
    /** Test/extension hook: dispose the active session on extension deactivate. */
    dispose() {
        void this.teardown();
    }
}
exports.ChatTerminalViewProvider = ChatTerminalViewProvider;
ChatTerminalViewProvider.viewType = 'glyphcode.chat';
//# sourceMappingURL=chatTerminalView.js.map