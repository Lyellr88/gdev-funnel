# Security

The funnel reads the GDevelop editor's access token from `mcp-live-server.json` on your machine and sends it only to the editor at `127.0.0.1`. It never writes the token to a file in this repo.

If you find a way the token or your project data can leak, please report it privately through GitHub's "Report a vulnerability" button on the Security tab, not in a public issue.

Never paste a token into an issue, a pull request or a log. If you did, restart the editor's MCP server so it issues a new one.
