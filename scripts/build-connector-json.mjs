// Packs tavern-script/loader.js into an importable Tavern-Helper script
// JSON (Tavern Helper -> Script Library -> Import). The loader pulls dist/connector.js from
// jsDelivr at the commit pinned by Supabase sb_config.tanuki_script_ref, so
// users import ONCE and get every future update automatically.
//   node scripts/build-connector-json.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const content = readFileSync(join(root, 'tavern-script', 'loader.js'), 'utf8');

const script = {
  type: 'script',
  enabled: true,
  name: 'Tavern Tanuki Connector',
  // Stable id so that re-importing updates instead of duplicating.
  id: 'a7f3c9d2-4b8e-4f1a-9c6d-tanuki000001',
  content,
  info:
    'The SillyTavern-side connector for Tavern Tanuki. It connects to the local MCP server (ws://127.0.0.1:6700), ' +
    'allowing an AI coding assistant to send messages, trigger replies, and switch presets or models. Import once to receive future updates automatically. ' +
    'Requires the Tavern Tanuki MCP server to run locally. Source: https://github.com/ben16w/tavern-tanuki',
  button: { enabled: false, buttons: [] },
  data: {},
};

const out = join(root, 'tavern-script', 'tavern-tanuki-connector.json');
writeFileSync(out, JSON.stringify(script, null, 2));
console.log('written:', out, `(${content.length} chars of JS)`);
