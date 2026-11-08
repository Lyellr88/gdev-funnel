# gdevelop-mcp-funnel

A small stdio proxy that sits in front of the GDevelop MCP server and exposes 4 tools instead of 40.

The GDevelop server publishes one JSON Schema per editor function. That is what the model is charged for on every single API request, whether it uses those tools or not. This proxy replaces the 40 schemas with one `gdevelop(function_name, arguments)` tool whose description is a compact signature list, and forwards each call to the real tool on the upstream server. Arguments are still validated by GDevelop, and the full JSON Schema of any function is one `docs` call away.

## Measured difference

| | GDevelop alone | Through the funnel |
|---|---|---|
| Tools | 40 over `--mcp`, 42 over `http` | 4 over `--mcp`, 5 over `http` |
| `tools/list` | 146,399 chars (~36,600 tokens) | 8,783 chars (~2,196 tokens) over `--mcp`, 9,717 chars (~2,429 tokens) over `http` |
| Server instructions | 22,337 chars (~5,600 tokens) | 1,275 chars (~319 tokens) |
| **Per API request** | **~42,200 tokens** | **~2,515 tokens** over `--mcp`, **~2,748 tokens** over `http` |
| A turn with 10 tool calls | ~422,000 tokens | ~25,000 over `--mcp`, ~27,500 over `http` |

Both columns are measured: the `--mcp` side against a fake server serving the real `functions.json`, the `http` side against a live editor. The fifth tool over `http` is `create_project`, which the live server publishes and `--mcp` does not.

That is a 93% cut to the floor. The remaining cost is the project data and the docs, both of which are read on demand:

- `docs({what:"event_script_guide"})` - 20 KB, read once per session before writing events.
- `docs({what:"script_api"})` - 135 KB, only when a `run_script` is really needed.
- `docs({what:"schema", name:"generate_events"})` - 8.6 KB, one function's full schema.
- `docs({what:"extension", names:[...]})`, `docs({what:"search", query})`, `docs({what:"javascript", names:[...]})`.

## Two ways to reach GDevelop

| | `http` (default) | `stdio` |
|---|---|---|
| Upstream | the editor opened by the user, `http://127.0.0.1:52520/mcp` | an editor instance spawned with `--mcp` |
| Requires | GDevelop open, MCP server enabled in its preferences | nothing else running |
| Project | whatever is open, and it can change | fixed at launch |
| Also publishes | `create_project` as a tool, `list_game_templates` in the signature sheet | - |

The HTTP server binds each agent session to the GDevelop window focused when it connected, so close the other windows if you have several projects open.

The `stdio` upstream is not usable on the 5.6.287 installer build: it starts, draws its window and never answers the MCP handshake, which the client reports as `CONNECTION_CLOSED`. The HTTP server is started by the same editor and does answer, which is why it is the default here.

### The token and the port

The editor writes both to `mcp-live-server.json` in its `userData` folder, and creates the token when the server is first enabled:

```
%APPDATA%\GDevelop 5\mcp-live-server.json      (Windows)
~/Library/Application Support/GDevelop 5/mcp-live-server.json   (macOS)
```

```json
{ "enabled": true, "port": 52520, "token": "64 hex characters" }
```

The funnel reads that file by itself: the token is never copied into a committed config or into `~/.claude.json`. Set `url`, `token` or `settingsFile` in `funnel.config.json` only to override it. The port can move if 52520 is taken, and the file follows.

## Setup

No dependencies. Node 18 or newer.

1. Nothing to edit: `funnel.config.json` already points at the live editor server and finds the token. It also works with no config file at all.

2. Point your MCP client at `funnel.js` instead of GDevelop. In `.mcp.json`:

```json
{
  "mcpServers": {
    "gdevelop-funnel": {
      "command": "node",
      "args": ["C:/tools/gdev-funnel/funnel.js"]
    }
  }
}
```

3. Check it before trusting it:

```
node funnel.js --check
```

```
mode: http
url: http://127.0.0.1:52520/mcp
token: 3f9a1c... (64 characters)
Reachable. The editor publishes 42 tools; the funnel exposes 5.
```

It tells you which settings file the token came from on stderr, and exits non-zero with the editor's reason when it cannot connect.

4. Run the test suite:

```
node test-funnel.js
```

It drives the proxy against a fake GDevelop over all three paths - `--mcp` on stdin/stdout, the live HTTP contract (session header, 202 for notifications, 404 when the session is gone), and no editor at all - and prints the sizes above. It should end with `All checks passed.`

This test reads the real schemas from a GDevelop checkout (`newIDE/app/src/EditorFunctions/PublicApi/v22/functions.json`), found next to this folder or from `GDEVELOP_SOURCE_DIR`. The funnel itself does not need the source tree, so the folder can be moved or zipped anywhere.

## What changes for the agent

- `save_project`, `read_game_project_json` and (over `http` only) `create_project` work exactly as before.
- Every editor function is called as `gdevelop({ function_name: "put_2d_instances", arguments: { ... } })`.
- The 32 editor functions are in the signature sheet of `gdevelop`, as are the docs and lookup functions, so both of these work and are the same call upstream:

| Upstream tool | Through the funnel |
|---|---|
| `read_script_api_definition` | `docs({what:"script_api"})` |
| `read_gameplay_test_harness_guide` | `docs({what:"gameplay_guide"})` |
| `read_full_docs(extension_names)` | `docs({what:"extension", names:[...]})` |
| `search_docs(query)` | `docs({what:"search", query})` |
| `read_javascript_reference(names)` | `docs({what:"javascript", names:[...]})` |
| `search_object_asset_store(search_terms, allowed_object_types?)` | `gdevelop({function_name:"search_object_asset_store", ...})` |
| `search_resource_store(search_terms, resource_kind)` | `gdevelop({function_name:"search_resource_store", ...})` |

The two store searches have no `docs` form because their output is project edits (an `asset_id` to create, an exact audio/font name), not documentation. `docs` turns a list of names into the comma-separated string upstream expects, so `names:["Sprite","Physics3D"]` is valid.

Tool permission names change with the server name, so an allow rule for `mcp__gdevelop__read_game_project_json` becomes `mcp__gdevelop-funnel__read_game_project_json`.

## When GDevelop is not running

The funnel answers the MCP handshake itself instead of waiting for the editor, so the connection is never reported as dead:

- **Tool list.** Taken from the editor on the first `tools/list` and cached in `funnel-cache.json` next to `funnel.js`. With the editor closed, the cached list is used and the 4 tools are still there, signature sheet included.
- **Tool calls.** If the editor is unreachable, a call answers `GDevelop is not reachable at http://127.0.0.1:52520/mcp (connection refused). Open the GDevelop editor and retry the call: the funnel reconnects by itself.` instead of hanging.
- **Editor restarted.** The next call after the restart fails once with `GDevelop lost the MCP session (the editor was restarted?). Retry the call: the funnel reconnects by itself.` The call after that works, on a fresh session. Nothing is executed twice: a lost session means the call never ran.
- **Exit.** The funnel sends a `DELETE` so the editor releases the session, and the queue attached to it.

`funnel-cache.json` is only a cache of the upstream tool list: delete it whenever.

## Notes

- stdout carries JSON-RPC only. Logs are on stderr, prefixed `[funnel]` and `[gdevelop]`.
- A gameplay test can run for minutes. The funnel and the editor both wait without a timeout on tool calls; only the handshake (15s) and the tool list (20s) have one.
- Environment overrides: `GDEVELOP_FUNNEL_URL`, `GDEVELOP_MCP_TOKEN`, `GDEVELOP_LIVE_SETTINGS`, `GDEVELOP_MCP_CMD`, `GDEVELOP_FUNNEL_CACHE`, `GDEVELOP_FUNNEL_CONFIG`. The environment wins over `funnel.config.json`.
- `funnel.config.local.json`, next to `funnel.config.json`, is merged over it key by key and is git-ignored: that is where a token or a machine-specific path belongs. A custom `GDEVELOP_FUNNEL_CONFIG` gets the same `.local.json` sibling.
- Nothing in the GDevelop source tree is modified. This folder can be zipped and sent to someone else; they only need their own editor, and their token is found on their machine.
- If GDevelop changes its tool names, the signature list follows automatically because it is built from whatever the upstream server publishes.

## Tests

`node test-funnel.js` runs three suites — the stdio upstream, the live-editor HTTP contract, and the offline path — against a fake upstream, so it needs no GDevelop install. The schemas it measures against come from `fixtures/public-api-v22/`: a trimmed copy of `newIDE/app/src/EditorFunctions/PublicApi/v22` (13 of the 32 functions, all 5 lookup tools, and an excerpt of `script-api.d.ts`).

To measure the real files instead, point it at a checkout:

```sh
GDEVELOP_SOURCE_DIR=/path/to/GDevelop-master node test-funnel.js
```

GitHub Actions runs the suite on Linux and Windows, on Node 20 and 22 (`.github/workflows/test.yml`).

## License

MIT, see `LICENSE`.
