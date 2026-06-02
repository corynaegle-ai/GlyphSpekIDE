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
      fontSize: 13,
      // lineHeight stays ~1 so Claude's box-drawing (│ ┌ └ ─) renders as unbroken
      // borders; chat "breathing room" comes from the wrapper padding instead, which
      // does not interfere with per-cell glyph alignment.
      lineHeight: 1.08,
      cursorBlink: true,
      // Bar cursor reads like a chat composer caret rather than a terminal block.
      cursorStyle: 'bar',
      cursorWidth: 2,
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

  /*
   * ───────────────────────────────────────────────────────────────────────────
   * INLINE BROKER-VERDICT CHIPS (spec §5.6). When the HOST delivers a REAL broker
   * `decide()` verdict for a governed command ({type:'brokerVerdict', verdict, ...}),
   * we pin an inline `.brk` chip to the command's terminal line using xterm's
   * marker + decoration API, with the non-color redundancy required by §3.4 (text
   * label + glyph + fill/border shape). HONESTY: this fires ONLY on a host message —
   * the webview never parses the raw PTY stream to guess commands or fabricate an
   * `allow`. No message → no chip.
   * ───────────────────────────────────────────────────────────────────────────
   */

  // Verdict → { glyph, label }. The ✕ on deny is spec-called-out (§3.4); ✓/?? give
  // allow/ask their own non-color glyphs so grayscale/deuteranopia still reads them.
  const VERDICT_META = {
    allow: { glyph: '✓', label: 'ALLOW' }, // ✓
    ask: { glyph: '?', label: 'ASK' },
    deny: { glyph: '✕', label: 'DENY' }, // ✕
  };

  function buildChipEl(chip) {
    const meta = VERDICT_META[chip.verdict];
    if (!meta) return null; // unknown verdict → render nothing (honest)
    const el = document.createElement('span');
    el.className = 'brk ' + chip.verdict;
    el.setAttribute('role', 'status');

    const glyph = document.createElement('span');
    glyph.className = 'brk-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = meta.glyph;

    const label = document.createElement('span');
    label.className = 'brk-label';
    label.textContent = meta.label;

    el.appendChild(glyph);
    el.appendChild(label);

    // Exit code (context only) when the command has finished — never fabricated.
    if (typeof chip.exitCode === 'number') {
      const exit = document.createElement('span');
      exit.className = 'brk-exit';
      exit.textContent = 'exit ' + chip.exitCode;
      el.appendChild(exit);
    }

    // Accessible + hover description. `command` is host-redacted before it reaches us.
    const desc =
      'Broker verdict: ' +
      meta.label +
      (typeof chip.exitCode === 'number' ? ' (exit ' + chip.exitCode + ')' : '') +
      (chip.command ? ' — ' + chip.command : '');
    el.title = desc;
    el.setAttribute('aria-label', desc);
    return el;
  }

  function renderBrokerVerdict(chip) {
    if (!chip || !VERDICT_META[chip.verdict] || !term) return;

    // Anchor a marker to the current line so the chip pins to the command, not a
    // detached log. registerMarker/registerDecoration are the vendored xterm APIs.
    let decoration = null;
    try {
      const marker = term.registerMarker(0);
      if (marker && typeof term.registerDecoration === 'function') {
        decoration = term.registerDecoration({ marker });
      }
    } catch (_e) {
      /* decoration API unavailable on this build: fall through to no chip */
    }

    const denyCue = () => {
      // A denied command must be FELT (§5.6) — a brief frame pulse + chip flash.
      // CSS disables the animation under prefers-reduced-motion; the static red
      // border/fill + ✕ + DENY label still carry the state there.
      if (chip.verdict !== 'deny') return;
      termWrap.classList.remove('deny-pulse');
      // reflow so re-adding the class restarts the animation
      void termWrap.offsetWidth;
      termWrap.classList.add('deny-pulse');
      window.setTimeout(() => termWrap.classList.remove('deny-pulse'), 700);
    };

    if (decoration && typeof decoration.onRender === 'function') {
      // xterm calls onRender with the cell element backing the decoration; we mount
      // the chip into it once and flash deny on first render.
      let mounted = false;
      decoration.onRender((cellEl) => {
        if (mounted || !cellEl) return;
        const chipEl = buildChipEl(chip);
        if (!chipEl) return;
        cellEl.style.position = cellEl.style.position || 'relative';
        cellEl.style.zIndex = '5';
        cellEl.appendChild(chipEl);
        if (chip.verdict === 'deny') chipEl.classList.add('flash');
        mounted = true;
        denyCue();
      });
    } else {
      // Decoration API unavailable: still honor the deny cue at the frame level so a
      // denial is never silent, even if the per-line chip could not anchor.
      denyCue();
    }
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
      case 'brokerVerdict':
        // A REAL broker decide() verdict from the host (spec §5.6). Render the inline
        // chip pinned to the command line. Never synthesized — only on this message.
        ensureTerminal();
        renderBrokerVerdict(msg);
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
