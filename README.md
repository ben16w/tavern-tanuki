# Tavern Tanuki

Tavern Tanuki is an MCP server that lets AI coding assistants manage and play a running SillyTavern instance. It can read and edit character cards, worldbooks, and chats, then use the open browser session to send messages, generate replies, and change presets or models.

## Components

| Component | Runs in | Purpose |
|---|---|---|
| **MCP server** | Your AI coding assistant, such as Claude Code | Uses the SillyTavern HTTP API to manage characters, worldbooks, and chats. |
| **Tavern Tanuki Connector** (optional) | SillyTavern through Tavern Helper | Enables the `play_*` tools to use the currently open browser session. |

The management tools work without the connector. The connector is required only for the `play_*` tools.

## Tools

**Management:** `st_status`, `list_characters`, `get_character`, `edit_character`, `merge_character_data`, `list_worldbooks`, `get_worldbook`, `upsert_worldbook_entry`, `delete_worldbook_entry`, `delete_worldbook`, `list_chats`, and `get_chat`.

**Play:** `play_status`, `play_send`, `play_trigger`, `play_recent_messages`, `play_get_prompt`, `play_list_presets`, `play_set_preset`, `play_set_model`, and `play_stscript`.

## Installation

Requires Node.js 18 or later and a running SillyTavern instance. The default endpoint is `http://127.0.0.1:8000`.

Install from this repository:

```bash
git clone git@github.com:ben16w/tavern-tanuki.git
cd tavern-tanuki
npm install
```

Add the MCP server to your coding assistant configuration:

```json
{
  "mcpServers": {
    "sillytavern": {
      "command": "node",
      "args": ["<path-to>/tavern-tanuki/src/server.js"],
      "env": {
        "ST_URL": "http://127.0.0.1:8000",
        "ST_USER": "your-sillytavern-handle",
        "ST_PASSWORD": "your-sillytavern-password"
      }
    }
  }
}
```

When SillyTavern user accounts are enabled, `ST_USER` and `ST_PASSWORD` log in through `/api/users/login`. For installations that use only HTTP Basic Auth, the same variables continue to be sent as Basic Auth credentials. Omit both variables when no authentication is configured.

To enable play tools, import the generated connector JSON from the `tavern-script` directory through Tavern Helper's Script Library. The lightweight loader retrieves `dist/connector.js` from jsDelivr. `ST_BRIDGE_PORT` changes its local WebSocket port; it defaults to `6700` and listens only on `127.0.0.1`.

## How Play Tools Work

SillyTavern assembles prompts, applies worldbooks and presets, and generates responses in the browser. The connector opens a WebSocket to the local MCP server so a `play_send` call can create a chat message, trigger generation, and return the completed reply through the same browser workflow.

Browsers block an HTTPS-hosted SillyTavern page from connecting to the local `ws://` bridge because of mixed-content restrictions. Management tools are unaffected because they communicate through `ST_URL`.

## Development

```bash
ST_USER=... ST_PASSWORD=... node smoke.mjs
node release.mjs "Short release summary"
```

The smoke test writes only to a temporary worldbook and a duplicate character card, then cleans up both. The loader is packaged into the importable connector JSON with `node scripts/build-connector-json.mjs`.

## Security

- The connector only listens on and connects to localhost. Store credentials in your MCP configuration or secret manager; never commit real passwords.
- `play_stscript` gives an agent the same power as a user typing commands into SillyTavern. Use it only with software and agents you trust.
- Deleting an entire worldbook requires `confirm: true`.

## License

MIT
