// Tavern Tanuki release helper: rebuild connector JSON, commit and push, then update the Supabase version pointer.
// Usage: node release.mjs "Short release summary"
// Prerequisites: gh and git authenticated; .env.supabase in the workspace root contains SUPABASE_SERVICE_KEY=sb_secret_xxx.
// If the pointer cannot be updated, the loader falls back to @main.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const msg = process.argv[2] ?? 'update';
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'pipe' }).toString().trim();

// 1) Rebuild importable JSON to keep it in sync with the loader.
execSync(`node scripts/build-connector-json.mjs`, { cwd: root, stdio: 'inherit' });

// 2) Commit and push. When there are no changes, skip the commit and update only the pointer.
run('git add -A');
try {
  run(`git commit -m "${msg.replace(/"/g, "'")}"`);
  console.log('Committed:', msg);
} catch {
  console.log('No changes to commit.');
}
run('git push origin main');
const hash = run('git rev-parse HEAD');
console.log('Pushed. Latest commit:', hash);

// 3) Update the Supabase sb_config.tanuki_script_ref pointer.
const envFile = join(root, '..', '.env.supabase');
let svcKey = null;
if (existsSync(envFile)) {
  const m = readFileSync(envFile, 'utf8').match(/^\s*SUPABASE_SERVICE_KEY\s*=\s*(.+?)\s*$/m);
  if (m) svcKey = m[1];
}
if (!svcKey) {
  console.log('Could not find .env.supabase or SUPABASE_SERVICE_KEY.');
  console.log(`Set sb_config.tanuki_script_ref to this commit in the Supabase Table Editor: ${hash}`);
  process.exit(0);
}

const SB = 'https://hieylivlsdmyznviumht.supabase.co/rest/v1/sb_config';
// Do not use a Mozilla user agent: Supabase treats the secret key as browser usage and returns 401.
const headers = {
  apikey: svcKey,
  Authorization: `Bearer ${svcKey}`,
  'Content-Type': 'application/json',
  'User-Agent': 'tanuki-release/1.0',
  Prefer: 'return=representation',
};

try {
  let res = await fetch(`${SB}?key=eq.tanuki_script_ref`, {
    method: 'PATCH', headers, body: JSON.stringify({ value: hash }),
  });
  let rows = res.ok ? await res.json() : [];
  if (!rows.length) {
    // Insert the row on the first release when it does not yet exist.
    res = await fetch(SB, { method: 'POST', headers, body: JSON.stringify({ key: 'tanuki_script_ref', value: hash }) });
    rows = res.ok ? await res.json() : [];
  }
  if (rows.length && rows[0].value === hash) {
    console.log('tanuki_script_ref now points to the latest commit. The next SillyTavern refresh loads the update.');
  } else {
    console.log(`Could not update the pointer (HTTP ${res.status}). Set sb_config.tanuki_script_ref manually to: ${hash}`);
  }
} catch (e) {
  console.log('Failed to update the pointer automatically:', e.message);
  console.log(`Set sb_config.tanuki_script_ref manually to: ${hash}`);
}
