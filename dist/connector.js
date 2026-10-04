// ============================================================
// Tavern Tanuki Connector v0.3.0
// Lets AI coding assistants (such as Claude Code) use the Tavern Tanuki MCP server
// to send messages, trigger replies, and switch presets or models in SillyTavern.
//
// In Tavern Helper, create a script, paste this file's content, and enable it.
// Tavern Tanuki must run locally and listen on 127.0.0.1:6700.
// HTTPS-hosted SillyTavern cannot connect to a local WebSocket due to mixed-content restrictions.
// ============================================================

(() => {
  const PORT = 6700;
  const URL = `ws://127.0.0.1:${PORT}`;
  let ws = null;
  let retry = null;
  let announced = false;
  let busy = false;

  // ---------- Utilities ----------

  const lastId = () => getLastMessageId();

  function readMessage(id) {
    const m = getChatMessages(id)[0];
    return m ? { id, name: m.name, role: m.role, text: m.message } : null;
  }

  function readRecent(n) {
    const end = lastId();
    const start = Math.max(0, end - n + 1);
    const out = [];
    for (let i = start; i <= end; i++) {
      const m = readMessage(i);
      if (m) out.push(m);
    }
    return { total: end + 1, messages: out };
  }

  /** Wait for a generation to finish or stop, then return the final message. */
  function waitGeneration(timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (ok, err) => {
        if (done) return;
        done = true;
        eventRemoveListener(tavern_events.GENERATION_ENDED, onEnd);
        eventRemoveListener(tavern_events.GENERATION_STOPPED, onEnd);
        clearTimeout(timer);
        if (ok) setTimeout(() => resolve(readMessage(lastId())), 300);
        else reject(err);
      };
      const onEnd = () => finish(true);
      const timer = setTimeout(
        () => finish(false, new Error('Generation timed out. SillyTavern may not be generating, or the model may be slow.')),
        timeoutMs,
      );
      eventOn(tavern_events.GENERATION_ENDED, onEnd);
      eventOn(tavern_events.GENERATION_STOPPED, onEnd);
    });
  }

  // ---------- Prompt capture ----------
  // Capture the fully assembled prompt when SillyTavern signals that it is ready for the LLM.
  // Ignore dry runs used for token counting; support chat and text completion modes.
  let lastPrompt = null;

  eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, (data) => {
    try {
      if (!data || data.dryRun) return;
      lastPrompt = {
        kind: 'chat_completion',
        at: new Date().toISOString(),
        messages: JSON.parse(JSON.stringify(data.messages ?? [])),
      };
    } catch (e) { console.warn('[tanuki] Failed to capture prompt', e); }
  });

  eventOn(tavern_events.GENERATE_AFTER_COMBINE_PROMPTS, (data) => {
    try {
      if (!data || data.dryRun) return;
      lastPrompt = {
        kind: 'text_completion',
        at: new Date().toISOString(),
        messages: [{ role: 'combined', content: String(data.prompt ?? '') }],
      };
    } catch (e) { console.warn('[tanuki] Failed to capture prompt', e); }
  });

  // ---------- Command handling ----------

  const handlers = {
    async status() {
      const char = await triggerSlash('/pass {{char}}');
      const user = await triggerSlash('/pass {{user}}');
      return { character: char, persona: user, last_message_id: lastId() };
    },

    async send({ text, trigger = true }, timeoutMs) {
      if (busy) throw new Error('A previous response is still being generated.');
      busy = true;
      try {
        await createChatMessages([{ role: 'user', content: text }]);
        if (!trigger) return { sent: true, message_id: lastId() };
        const wait = waitGeneration(timeoutMs - 2000);
        await triggerSlash('/trigger');
        return await wait;
      } finally {
        busy = false;
      }
    },

    async trigger(_args, timeoutMs) {
      if (busy) throw new Error('A previous response is still being generated.');
      busy = true;
      try {
        const wait = waitGeneration(timeoutMs - 2000);
        await triggerSlash('/trigger');
        return await wait;
      } finally {
        busy = false;
      }
    },

    async last_messages({ n = 4 }) {
      return readRecent(Math.min(n, 50));
    },

    async preset({ name }) {
      await triggerSlash(`/preset ${name}`);
      const now = await triggerSlash('/preset');
      return { active_preset: now };
    },

    async model({ name }) {
      await triggerSlash(`/model ${name}`);
      return { ok: true, model: name };
    },

    async stscript({ script }) {
      const pipe = await triggerSlash(script);
      return { pipe: pipe ?? null };
    },

    async prompt({ mode = 'summary', search, index }) {
      if (!lastPrompt) {
        throw new Error('No prompt has been captured yet. Generate a response with play_send or directly in SillyTavern first.');
      }
      const { kind, at, messages } = lastPrompt;
      const total_chars = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
      const base = { kind, captured_at: at, message_count: messages.length, total_chars };

      if (typeof index === 'number') {
        const m = messages[index];
        if (!m) throw new Error(`Message ${index} does not exist; there are ${messages.length} messages.`);
        return { ...base, index, role: m.role, name: m.name, content: m.content };
      }
      if (search) {
        const matches = [];
        messages.forEach((m, i) => {
          const c = m.content ?? '';
          let pos = c.indexOf(search);
          while (pos !== -1 && matches.length < 10) {
            matches.push({ index: i, role: m.role, pos, context: c.slice(Math.max(0, pos - 100), pos + search.length + 100) });
            pos = c.indexOf(search, pos + 1);
          }
        });
        return { ...base, search, match_count: matches.length, matches };
      }
      if (mode === 'full') {
        return { ...base, messages };
      }
      return {
        ...base,
        messages: messages.map((m, i) => ({
          i, role: m.role, name: m.name || undefined,
          chars: m.content?.length ?? 0,
          head: (m.content ?? '').slice(0, 120),
        })),
      };
    },
  };

  // ---------- WebSocket connection ----------

  function connect() {
    try {
      ws = new WebSocket(URL);
    } catch (e) {
      scheduleRetry();
      return;
    }

    ws.onopen = () => {
      if (!announced) {
        toastr.success('Connected to the AI coding assistant', 'Tavern Tanuki');
        announced = true;
      }
      ws.send(JSON.stringify({ type: 'hello', agent: 'tanuki-connector', version: '0.3.0' }));
    };

    ws.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg.cmd || msg.id === undefined) return;
      const timeoutMs = msg.args?.__timeout_ms ?? 180000;
      try {
        const handler = handlers[msg.cmd];
        if (!handler) throw new Error(`Unknown command: ${msg.cmd}`);
        const data = await handler(msg.args ?? {}, timeoutMs);
        ws.send(JSON.stringify({ id: msg.id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e?.message ?? e) }));
      }
    };

    ws.onclose = () => {
      ws = null;
      scheduleRetry();
    };
    ws.onerror = () => {
      try { ws?.close(); } catch {}
    };
  }

  function scheduleRetry() {
    if (retry) return;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, 5000);
  }

  connect();

  // Clean up on page unload to avoid leaving event listeners or connections behind.
  window.addEventListener('pagehide', () => {
    try { ws?.close(); } catch {}
    if (retry) clearTimeout(retry);
  });
})();
