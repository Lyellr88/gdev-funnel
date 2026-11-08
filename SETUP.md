# Funnel setup (5 minutes)

Cuts each GDevelop MCP request from about 42k tokens to about 2.7k. Full details are in `README.md`.

## Before you start

- Node.js installed. Check with `node --version` in a terminal.
- The GDevelop editor installed, with the project open.

## Steps

1. Put this folder at `C:/tools/gdev-funnel`. If it lives somewhere else, change the path in the project's `.mcp.json` to match.
2. Make sure the project has a `.mcp.json` in its root with this content:

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

3. Turn off the old GDevelop server. In Claude Code type `/mcp`, pick `gdevelop` (the old one) and disable it. If it stays on, you still pay for all 40 tools on every call.
4. Open GDevelop with the project. In GDevelop, open Preferences and switch on the MCP server.
5. Copy `.claude/gdevelop/SKILL.md` from this folder to `.claude/skills/gdevelop/SKILL.md` in the project. It teaches Claude how to use the 4 tools.
6. Restart Claude Code in the project folder. Approve `gdevelop-funnel` when it asks.

## Check that it works

- In a terminal, in this folder, run `node funnel.js --check`. It should print the url and token found, then "reachable". "Connection refused" means GDevelop is not open or the MCP server is off in Preferences.
- In Claude Code, type `/mcp`. `gdevelop-funnel` should show as connected.
- Ask Claude to describe the cabin. If it answers with a position and size, you are done.

## If something fails

- `CONNECTION_CLOSED` or not connected: run `/mcp` and reconnect. Check that the path in `.mcp.json` is right.
- "GDevelop is not reachable": open the editor with the project, then retry. The funnel reconnects by itself.
- Tools missing after closing and reopening the editor: run `/mcp` and reconnect.
- Never run the old `gdevelop` server and the funnel together.
