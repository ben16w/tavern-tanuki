#!/usr/bin/env node
/**
 * Tavern Tanuki - MCP server for a running SillyTavern instance.
 *
 * Lets coding agents read and write characters, worldbooks and chats through
 * SillyTavern's HTTP API. Configure via environment variables:
 *   ST_URL      base URL of the ST server (default http://127.0.0.1:8000)
 *   ST_USER     HTTP Basic Auth username (if ST has basicAuthMode enabled)
 *   ST_PASSWORD HTTP Basic Auth password
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { STClient } from './client.js';
import { Bridge } from './bridge.js';

const st = new STClient();
const bridge = new Bridge();

const server = new McpServer({ name: 'tavern-tanuki', version: '0.3.0' });

/** Wrap a handler: JSON-stringify results, surface errors as tool errors. */
function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = await handler(args ?? {});
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
}

const pageSchema = {
  offset: z.number().int().min(0).optional().describe('Result offset (default 0)'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default 20, max 100)'),
  include_total: z.boolean().optional().describe('Include total matching items (default false)'),
};

const presetPageSchema = {
  offset: pageSchema.offset,
  limit: pageSchema.limit,
};

function page(items, offset = 0, limit = 20, includeTotal = false) {
  const results = items.slice(offset, offset + limit);
  return {
    ...(includeTotal ? { total: items.length } : {}),
    offset,
    returned: results.length,
    next_offset: offset + results.length < items.length ? offset + results.length : undefined,
    results,
  };
}

function clippedText(value, maxChars, offset = 0) {
  const text = String(value ?? '');
  const nextOffset = offset + maxChars < text.length ? offset + maxChars : undefined;
  return {
    text: text.slice(offset, offset + maxChars),
    length: text.length,
    offset,
    next_offset: nextOffset,
    truncated: offset > 0 || nextOffset !== undefined || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

tool(
  'st_status',
  'Check the SillyTavern connection and item counts.',
  {},
  async () => {
    const version = await st.get('/version');
    const chars = await st.post('/api/characters/all');
    const settings = await st.post('/api/settings/get');
    return {
      version: version.pkgVersion,
      characters: chars.length,
      worldbooks: (settings.world_names ?? []).length,
    };
  },
);

/* ------------------------------------------------------------------ */
/* Characters                                                          */
/* ------------------------------------------------------------------ */

tool(
  'list_characters',
  'List character summaries; use avatar with other character tools.',
  {
    filter: z.string().optional().describe('Case-insensitive substring to match against character name'),
    ...pageSchema,
  },
  async ({ filter, offset, limit, include_total }) => {
    const all = await st.post('/api/characters/all');
    let list = all.map((c) => ({
      name: c.name,
      avatar: c.avatar,
      tags: c.tags?.length ? c.tags : undefined,
      chat_size: c.chat_size,
      date_last_chat: c.date_last_chat
        ? new Date(c.date_last_chat).toISOString().slice(0, 10)
        : undefined,
    }));
    if (filter) {
      const f = filter.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(f) || c.avatar.toLowerCase().includes(f));
    }
    return { characters: page(list, offset, limit, include_total) };
  },
);

const CHARACTER_PROMPT_FIELDS = [
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
];

tool(
  'get_character',
  'Read compact character metadata; use fields for full card values.',
  {
    avatar_url: z.string().describe('Avatar filename from list_characters'),
    fields: z.array(z.string()).max(12).optional().describe('Full top-level or data.* values, e.g. description or data.creator_notes'),
  },
  async ({ avatar_url, fields }) => {
    const c = await st.post('/api/characters/get', { avatar_url });
    if (fields?.length) {
      const pick = {};
      for (const f of fields) {
        const path = f.split('.');
        let v = c;
        for (const p of path) v = v?.[p];
        pick[f] = v;
      }
      return pick;
    }
    return {
      name: c.name,
      avatar: c.avatar,
      tags: c.tags?.length ? c.tags : undefined,
      prompt_lengths: Object.fromEntries(
        CHARACTER_PROMPT_FIELDS.map((field) => [field, String(c[field] ?? '').length]),
      ),
      creator_notes_length: String(c.data?.creator_notes ?? '').length,
      character_version: c.data?.character_version || undefined,
      alternate_greetings_count: c.data?.alternate_greetings?.length ?? 0,
      embedded_worldbook: c.data?.character_book?.name,
      extensions_keys: c.data?.extensions ? Object.keys(c.data.extensions) : undefined,
    };
  },
);

tool(
  'edit_character',
  'Set a prompt field and synchronize its top-level and data.* copies.',
  {
    avatar_url: z.string().describe('Avatar filename, e.g. "MyChar.png"'),
    field: z.string().describe('Field name, e.g. description or first_mes'),
    value: z.string().describe('New value for the field'),
  },
  async ({ avatar_url, field, value }) => {
    const card = await st.post('/api/characters/get', { avatar_url });
    await st.post('/api/characters/edit-attribute', {
      avatar_url,
      ch_name: card.name,
      field,
      value,
    });
    return { ok: true, field, length: value.length };
  },
);

tool(
  'merge_character_data',
  'Deep-merge nested character data or tags; use edit_character for prompt fields.',
  {
    avatar_url: z.string().describe('Avatar filename, e.g. "MyChar.png"'),
    edits: z.record(z.any()).describe('Partial card object to deep-merge into the character'),
  },
  async ({ avatar_url, edits }) => {
    await st.post('/api/characters/merge-attributes', { avatar: avatar_url, ...edits });
    return { ok: true, merged_keys: Object.keys(edits) };
  },
);

/* ------------------------------------------------------------------ */
/* Worldbooks                                                          */
/* ------------------------------------------------------------------ */

tool(
  'list_worldbooks',
  'List worldbook names.',
  {
    filter: z.string().optional().describe('Case-insensitive substring filter'),
    ...pageSchema,
  },
  async ({ filter, offset, limit, include_total }) => {
    const settings = await st.post('/api/settings/get');
    let names = settings.world_names ?? [];
    if (filter) {
      const f = filter.toLowerCase();
      names = names.filter((n) => n.toLowerCase().includes(f));
    }
    return { worldbooks: page(names, offset, limit, include_total) };
  },
);

const entrySummary = (e) => ({
  uid: e.uid,
  comment: e.comment,
  key: e.key,
  disable: e.disable,
  constant: e.constant,
  position: e.position,
  order: e.order,
  content_length: e.content?.length ?? 0,
});

function entryWithContent(e, maxContentChars, contentOffset) {
  const content = clippedText(e.content, maxContentChars, contentOffset);
  return {
    ...e,
    content: content.text,
    content_length: content.length,
    content_offset: content.offset,
    content_next_offset: content.next_offset,
    content_truncated: content.truncated,
  };
}

tool(
  'get_worldbook',
  'Read paged worldbook entries; summary mode omits content.',
  {
    name: z.string().describe('Worldbook name from list_worldbooks'),
    mode: z.enum(['summary', 'full']).optional().describe('summary omits content (default); full includes it'),
    uids: z.array(z.number()).max(20).optional().describe('Specific entry ids; returns entries with content'),
    content_offset: z.number().int().min(0).optional().describe('Content character offset for the next chunk (default 0)'),
    max_content_chars: z.number().int().min(100).max(16_000).optional().describe('Maximum content characters per entry (default 4,000)'),
    ...pageSchema,
  },
  async ({
    name, mode = 'summary', uids, offset, limit, include_total,
    content_offset = 0, max_content_chars = 4_000,
  }) => {
    const wb = await st.post('/api/worldinfo/get', { name });
    const entries = Object.values(wb.entries ?? {}).sort((a, b) => a.uid - b.uid);
    if (uids?.length) {
      return {
        name,
        entries: entries
          .filter((e) => uids.includes(e.uid))
          .map((e) => entryWithContent(e, max_content_chars, content_offset)),
      };
    }
    const selected = page(entries, offset, limit, include_total);
    return {
      name,
      entries: {
        ...selected,
        results: mode === 'full'
          ? selected.results.map((e) => entryWithContent(e, max_content_chars, content_offset))
          : selected.results.map(entrySummary),
      },
    };
  },
);

/** Template matching ST's new-entry defaults. */
const NEW_ENTRY_DEFAULTS = {
  key: [], keysecondary: [], comment: '', content: '', constant: false,
  vectorized: false, selective: true, selectiveLogic: 0, addMemo: true,
  order: 100, position: 0, disable: false, excludeRecursion: false,
  preventRecursion: false, delayUntilRecursion: false, probability: 100,
  useProbability: true, depth: 4, group: '', groupOverride: false,
  groupWeight: 100, scanDepth: null, caseSensitive: null,
  matchWholeWords: null, useGroupScoring: null, automationId: '', role: null,
  sticky: 0, cooldown: 0, delay: 0, triggers: [],
};

tool(
  'upsert_worldbook_entry',
  'Create or update an entry; omit uid to create, including a missing worldbook.',
  {
    name: z.string().describe('Worldbook name'),
    uid: z.number().optional().describe('Entry uid to update; omit to create a new entry'),
    entry: z.object({
      key: z.array(z.string()).optional(),
      keysecondary: z.array(z.string()).optional(),
      content: z.string().optional(),
      comment: z.string().optional(),
      constant: z.boolean().optional(),
      disable: z.boolean().optional(),
      position: z.number().optional(),
      order: z.number().optional(),
      probability: z.number().min(0).max(100).optional(),
    }).passthrough().describe('Entry fields to merge; common fields are typed and other ST fields are allowed'),
  },
  async ({ name, uid, entry }) => {
    let wb;
    try {
      wb = await st.post('/api/worldinfo/get', { name });
    } catch {
      wb = { entries: {} };
    }
    const entries = wb.entries ?? {};
    let target = uid;
    let created = false;
    if (target === undefined || !entries[target]) {
      const used = Object.keys(entries).map(Number);
      target = used.length ? Math.max(...used) + 1 : 0;
      entries[target] = { ...NEW_ENTRY_DEFAULTS, uid: target, displayIndex: target };
      created = true;
    }
    entries[target] = { ...entries[target], ...entry, uid: target };
    await st.post('/api/worldinfo/edit', { name, data: { entries } });
    return { ok: true, uid: target, created };
  },
);

tool(
  'delete_worldbook_entry',
  'Delete a worldbook entry by uid.',
  {
    name: z.string().describe('Worldbook name'),
    uid: z.number().describe('Entry uid to delete'),
  },
  async ({ name, uid }) => {
    const wb = await st.post('/api/worldinfo/get', { name });
    const entries = wb.entries ?? {};
    if (!entries[uid]) throw new Error(`Entry uid ${uid} not found in "${name}"`);
    delete entries[uid];
    await st.post('/api/worldinfo/edit', { name, data: { entries } });
    return { ok: true, deleted_uid: uid, remaining: Object.keys(entries).length };
  },
);

tool(
  'delete_worldbook',
  'Delete a worldbook; requires confirm: true.',
  {
    name: z.string().describe('Worldbook name'),
    confirm: z.boolean().describe('Must be true to actually delete'),
  },
  async ({ name, confirm }) => {
    if (!confirm) throw new Error('Set confirm:true to delete the whole worldbook.');
    await st.post('/api/worldinfo/delete', { name });
    return { ok: true, deleted: name };
  },
);

/* ------------------------------------------------------------------ */
/* Chats                                                               */
/* ------------------------------------------------------------------ */

tool(
  'list_chats',
  'List chat file summaries for a character.',
  {
    avatar_url: z.string().describe('Avatar filename from list_characters'),
    ...pageSchema,
  },
  async ({ avatar_url, offset, limit, include_total }) => {
    const chats = await st.post('/api/characters/chats', { avatar_url });
    if (chats.error) throw new Error('No chats found for this character.');
    const summaries = Object.values(chats).map((c) => ({
      file_id: c.file_id,
      chat_items: c.chat_items,
      file_size: c.file_size,
    }));
    return { chats: page(summaries, offset, limit, include_total) };
  },
);

tool(
  'get_chat',
  'Read trailing chat messages with bounded message text.',
  {
    avatar_url: z.string().describe('Avatar filename from list_characters'),
    file_id: z.string().describe('Chat file id from list_chats'),
    last: z.number().int().min(1).max(50).optional().describe('Trailing messages (default 10, max 50)'),
    message_offset: z.number().int().min(0).optional().describe('Message index from the start; overrides trailing selection'),
    text_offset: z.number().int().min(0).optional().describe('Message-text character offset for the next chunk (default 0)'),
    max_chars: z.number().int().min(100).max(4_000).optional().describe('Maximum characters per message (default 2,000)'),
  },
  async ({ avatar_url, file_id, last = 10, message_offset, text_offset = 0, max_chars = 2_000 }) => {
    const ch_name = avatar_url.replace(/\.png$/i, '');
    const file_name = file_id.replace(/\.jsonl$/i, '');
    const data = await st.post('/api/chats/get', { ch_name, file_name, avatar_url });
    const [meta, ...messages] = data;
    const start = message_offset === undefined
      ? Math.max(messages.length - last, 0)
      : message_offset;
    const slice = messages.slice(start, start + last);
    return {
      total_messages: messages.length,
      message_offset: start,
      next_message_offset: start + slice.length < messages.length ? start + slice.length : undefined,
      returned: slice.length,
      user_name: meta?.user_name,
      character_name: meta?.character_name,
      messages: slice.map((m, index) => {
        const mes = clippedText(m.mes, max_chars, text_offset);
        return {
          index: start + index,
          name: m.name,
          is_user: m.is_user,
          send_date: m.send_date,
          mes: mes.text,
          mes_length: mes.length,
          mes_offset: mes.offset,
          mes_next_offset: mes.next_offset,
          mes_truncated: mes.truncated,
        };
      }),
    };
  },
);

/* ------------------------------------------------------------------ */
/* Play - requires the Tavern Tanuki Connector script in the browser */
/* ------------------------------------------------------------------ */

tool(
  'play_status',
  'Check the required browser connector and open chat.',
  {},
  async () => {
    if (!bridge.connected) {
      return { connected: false, hint: 'Open SillyTavern in a browser with the Tavern Tanuki Connector script enabled.' };
    }
    const info = await bridge.call('status');
    return { connected: true, ...info };
  },
);

tool(
  'play_send',
  'Send a user message to the open chat; generation is on by default.',
  {
    text: z.string().describe('Message to send as the user'),
    trigger: z.boolean().optional().describe('Trigger an AI reply and wait for it (default true)'),
    timeout_s: z.number().optional().describe('Max seconds to wait for the reply (default 180)'),
  },
  async ({ text, trigger = true, timeout_s = 180 }) => {
    return bridge.call('send', { text, trigger }, (timeout_s + 5) * 1000);
  },
);

tool(
  'play_trigger',
  'Generate a reply in the open chat without sending a message.',
  {
    timeout_s: z.number().optional().describe('Max seconds to wait (default 180)'),
  },
  async ({ timeout_s = 180 }) => bridge.call('trigger', {}, (timeout_s + 5) * 1000),
);

tool(
  'play_recent_messages',
  'Read recent messages from the currently open chat.',
  {
    n: z.number().int().min(1).max(20).optional().describe('Messages to return (default 4, max 20)'),
  },
  async ({ n = 4 }) => bridge.call('last_messages', { n }),
);

tool(
  'play_list_presets',
  'List available completion preset names.',
  presetPageSchema,
  async ({ offset, limit }) => {
    const settings = await st.post('/api/settings/get');
    return { presets: page(settings.openai_setting_names ?? [], offset, limit, true) };
  },
);

tool(
  'play_set_preset',
  'Set the completion preset for the open session.',
  {
    name: z.string().describe('Preset name from play_list_presets'),
  },
  async ({ name }) => bridge.call('preset', { name }),
);

tool(
  'play_set_model',
  'Set the model for the selected API backend.',
  {
    name: z.string().describe('Model name/id'),
  },
  async ({ name }) => bridge.call('model', { name }),
);

tool(
  'play_get_prompt',
  'Inspect the latest assembled prompt; summary is the default and full can be large.',
  {
    mode: z.enum(['summary', 'full']).optional().describe('summary gives roles and excerpts; full returns the complete prompt'),
    search: z.string().optional().describe('Search prompt text and return matching context'),
    index: z.number().optional().describe('Return one prompt message in full by index'),
  },
  async ({ mode, search, index }) => bridge.call('prompt', { mode, search, index }, 30_000),
);

tool(
  'play_stscript',
  'Run a raw STScript command in the open tavern; use only when no focused tool fits.',
  {
    script: z.string().describe('STScript command, e.g. "/preset | /echo {{pipe}}"'),
  },
  async ({ script }) => {
    const result = await bridge.call('stscript', { script }, 60_000);
    return { pipe: result?.pipe ?? null };
  },
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`sillytavern-api-mcp connected (target: ${st.baseUrl})`);
