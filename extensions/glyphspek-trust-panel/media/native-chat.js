/*
 * GlyphSpek NATIVE CHAT renderer (webview).
 *
 * The "normal chat window": the user types a message, sees the assistant reply,
 * GOVERNED through the GlyphSpek gateway (chat/send → Codex on the user's own
 * ChatGPT subscription). It NEVER calls a model itself and NEVER touches the
 * network (CSP default-src 'none'): it posts the conversation to the extension
 * host, which drives the bridge chat/send and streams chat/delta events back.
 *
 * Wire (host → webview):
 *   - chatTurnStart { }      — the host accepted the turn; show a "thinking…" state.
 *   - chatDelta { text }     — a chunk of assistant text (Codex emits ONE big delta).
 *   - chatDone { }           — the turn finished; finalize the assistant message.
 *   - chatError { message }  — the turn failed; render the message honestly.
 *   - chatBusy { busy }      — enable/disable the composer while a turn is in flight.
 * Wire (webview → host):
 *   - ready                  — the webview booted.
 *   - chatSend { messages }  — send the FULL transcript so far (system+history+user).
 *
 * No credential ever lives here (the contract has no credential field; the host
 * holds none either — Codex authenticates from its own store).
 */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  /** The rendered conversation: [{ role:'user'|'assistant', content:string }]. */
  var turns = [];
  /** True while a turn is in flight (composer disabled, thinking shown). */
  var busy = false;
  /** The assistant turn currently streaming, or null between turns. */
  var streaming = null;

  var el = {
    status: document.getElementById('chat-status'),
    transcript: document.getElementById('chat-transcript'),
    input: document.getElementById('chat-input'),
    send: document.getElementById('chat-send'),
  };

  function setStatus(text, kind) {
    el.status.textContent = text || '';
    el.status.hidden = !text;
    el.status.className = 'load-status' + (kind ? ' ' + kind : '');
  }

  function render() {
    el.send.disabled = busy;
    el.input.disabled = busy;

    el.transcript.innerHTML = '';
    turns.forEach(function (t) {
      el.transcript.appendChild(renderTurn(t.role, t.content, false));
    });
    // A "thinking…" placeholder between the ack and the first delta.
    if (busy && (!streaming || !streaming.content)) {
      el.transcript.appendChild(renderTurn('assistant', 'thinking…', true));
    } else if (streaming && streaming.content) {
      el.transcript.appendChild(renderTurn('assistant', streaming.content, false));
    }
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function renderTurn(role, content, thinking) {
    var wrap = document.createElement('div');
    wrap.className =
      'chat-turn chat-turn-' + role + (thinking ? ' chat-turn-thinking' : '');

    var roleEl = document.createElement('div');
    roleEl.className = 'chat-turn-role';
    roleEl.textContent = role;
    wrap.appendChild(roleEl);

    var body = document.createElement('div');
    body.className = 'chat-turn-body';
    // textContent — NEVER innerHTML for model output (no markup injection).
    body.textContent = content;
    wrap.appendChild(body);
    return wrap;
  }

  function send() {
    if (busy) return;
    var text = (el.input.value || '').trim();
    if (!text) return;

    // Append the user turn locally and clear the input.
    turns.push({ role: 'user', content: text });
    el.input.value = '';
    busy = true;
    streaming = { role: 'assistant', content: '' };
    setStatus('');
    render();

    // Post the FULL transcript so far so the gateway answers in context.
    vscode.postMessage({
      type: 'chatSend',
      messages: turns.map(function (t) {
        return { role: t.role, content: t.content };
      }),
    });
  }

  el.send.addEventListener('click', send);
  el.input.addEventListener('keydown', function (e) {
    // Cmd/Ctrl+Enter sends.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });

  /** Finalize the streaming assistant turn into the transcript. */
  function finalizeStreaming() {
    if (streaming && streaming.content) {
      turns.push({ role: 'assistant', content: streaming.content });
    }
    streaming = null;
    busy = false;
  }

  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.type === 'chatTurnStart') {
      busy = true;
      if (!streaming) streaming = { role: 'assistant', content: '' };
      setStatus('');
      render();
    } else if (msg.type === 'chatDelta') {
      if (!streaming) streaming = { role: 'assistant', content: '' };
      streaming.content += String(msg.text || '');
      render();
    } else if (msg.type === 'chatDone') {
      finalizeStreaming();
      setStatus('');
      render();
    } else if (msg.type === 'chatError') {
      // Render the failure HONESTLY as a blocked assistant card; do not swallow it.
      // The message is ALREADY REDACTED upstream (Finding 4): the supervisor's Codex
      // backend strips paths/tokens/secrets from any stderr tail before it crosses the
      // bridge — the verbatim tail goes only to the host OutputChannel, never here.
      // (textContent below also prevents any markup injection regardless.)
      streaming = null;
      busy = false;
      turns.push({
        role: 'assistant',
        content: String(msg.message || 'the chat turn failed.'),
      });
      // Tag the last turn as blocked for the red styling.
      render();
      var last = el.transcript.lastChild;
      if (last) last.className = 'chat-turn chat-turn-assistant chat-turn-blocked';
      setStatus(String(msg.message || 'chat turn failed'), 'err');
    } else if (msg.type === 'chatBusy') {
      busy = !!msg.busy;
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
  render();
})();
