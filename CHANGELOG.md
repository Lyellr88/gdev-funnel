# Changelog

## 0.1.0 (8 Nov 2026)

- First release. Replaces GDevelop's 40 MCP tool schemas with 4 tools (5 over HTTP): `gdevelop`, `docs`, `read_game_project_json`, `save_project`. Cuts the per-request cost from about 42,200 tokens to about 2,500.
- Finds the editor's port and token by itself.
- Keeps answering when the editor is closed (cached tool list) and reconnects after an editor restart.
- Test suite with a fake GDevelop, run on Linux and Windows in GitHub Actions.
