/*
 * GlyphSpek CHAT TERMINAL — webview renderer.
 *
 * Hosts an xterm.js terminal in the activity-bar Chat view and bridges it to the
 * extension host's PTY (running the user's interactive `claude`, governed):
 *   - PTY output (host → webview message {type:'output'}) → terminal.write()
 *   - terminal keystrokes (onData) → host message {type:'input'}
 *   - fit-addon geometry → host message {type:'resize'} → pty.resize()
 *
 * Claude's own TUI provides the conversation; this file is just the transport +
 * a thin chat frame (logo + Start-button empty-state with the honest-posture text in
 * the HTML; the view's section title labels it, so there is no in-webview header). The
 * CSP forbids eval/remote; xterm.js + the fit addon are the vendored, nonce-loaded UMD
 * globals `Terminal` and `FitAddon`.
 */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  const emptyEl = document.getElementById('empty');
  const emptyErrEl = document.getElementById('empty-err');
  const startBtn = document.getElementById('start-btn');
  const termWrap = document.getElementById('term-wrap');
  const termEl = document.getElementById('terminal');
  const runIdEl = document.getElementById('run-id');

  /** @type {any} */ let term = null;
  /** @type {any} */ let fitAddon = null;
  let started = false;

  // GlyphSpek-themed xterm palette (dark, matches the Trust Panel surface).
  const THEME = {
    background: '#0f1419',
    foreground: '#d7dde5',
    cursor: '#4b8fe0',
    cursorAccent: '#0f1419',
    selectionBackground: 'rgba(75,143,224,0.30)',
    black: '#0f1419',
    red: '#e0544b',
    green: '#3fb568',
    yellow: '#d9a441',
    blue: '#4b8fe0',
    magenta: '#b98fe0',
    cyan: '#56b6c2',
    white: '#d7dde5',
    brightBlack: '#6b7686',
    brightRed: '#e0544b',
    brightGreen: '#3fb568',
    brightYellow: '#d9a441',
    brightBlue: '#4b8fe0',
    brightMagenta: '#b98fe0',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  };

  function ensureTerminal() {
    if (term) return;
    // eslint-disable-next-line no-undef
    term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.1,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback: 5000,
    });
    // eslint-disable-next-line no-undef
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termEl);

    // Keystrokes → host → pty stdin.
    term.onData((data) => vscode.postMessage({ type: 'input', data }));

    // Report initial geometry once laid out, then on every resize.
    fitAndReport();
  }

  function fitAndReport() {
    if (!fitAddon || !term) return;
    try {
      fitAddon.fit();
    } catch (_e) {
      /* hidden/zero-size view: ignore */
    }
    const cols = term.cols || 80;
    const rows = term.rows || 24;
    vscode.postMessage({ type: 'resize', cols, rows });
  }

  // Debounced resize on container changes.
  let resizeTimer = null;
  function scheduleFit() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitAndReport, 60);
  }
  window.addEventListener('resize', scheduleFit);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleFit).observe(termEl);
  }

  function showTerminal() {
    emptyEl.style.display = 'none';
    termWrap.classList.add('active');
    ensureTerminal();
    // Re-fit after the wrapper becomes visible (it had display:none, so layout was 0).
    setTimeout(() => {
      fitAndReport();
      if (term) term.focus();
    }, 0);
  }

  function showError(message) {
    emptyErrEl.textContent = message;
    emptyErrEl.hidden = false;
  }

  startBtn.addEventListener('click', () => {
    if (started) return;
    started = true;
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    emptyErrEl.hidden = true;
    vscode.postMessage({ type: 'start' });
  });

  // Host → webview messages.
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'started':
        runIdEl.textContent = msg.runId ? 'run ' + String(msg.runId).slice(0, 8) : '';
        showTerminal();
        break;
      case 'output':
        ensureTerminal();
        if (typeof msg.data === 'string') term.write(msg.data);
        break;
      case 'exited':
        if (term) {
          term.write(
            '\r\n\x1b[2m[GlyphSpek] session ended (exit ' + String(msg.code) + '). ' +
              'The governed run was finalized + signed.\x1b[0m\r\n',
          );
        }
        started = false;
        startBtn.disabled = false;
        startBtn.textContent = 'Start chat';
        break;
      case 'error':
        // Reset the empty state so the user can retry, and surface the reason honestly.
        started = false;
        startBtn.disabled = false;
        startBtn.textContent = 'Start chat';
        showError(msg.message || 'Could not start the governed chat.');
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
