# Contributing

Thanks for helping. This is a small project: one proxy file (`funnel.js`), a fake upstream for tests, and a test runner. No dependencies, Node 18 or newer.

## Before you open a pull request

1. Run `node test-funnel.js`. It must end with `All checks passed.` No GDevelop install is needed, the tests use a fake server and the schemas in `fixtures/`.
2. Keep changes small and focused. One fix or feature per pull request.
3. Do not add dependencies. The funnel is meant to be copied anywhere and run with plain Node.
4. If you change what the agent sees (the tool list, the signature sheet, the `docs` options), update `README.md` and `.claude/gdevelop/SKILL.md` in the same pull request.
5. Never commit a token or a `*.local.json` file.

## Reporting a bug

Use the bug report form. Include your GDevelop version, your Node version, your OS, and the output of `node funnel.js --check` with the token removed.

## Ideas

Open an issue first for anything that changes how the funnel talks to GDevelop, so we can agree on the approach before you write code.

## Conduct

Be kind and assume good faith. See `CODE_OF_CONDUCT.md`.
