'use strict';

/**
 * A fake GDevelop MCP server, speaking the same newline-delimited JSON-RPC on
 * stdin/stdout as `--mcp`, used to test funnel.js without the editor.
 *
 * Usage: node mock-upstream.js <path-to-functions.json> [<path-to-script-api.d.ts>]
 */

const readline = require('readline');
const { createMockApi } = require('./mock-gdevelop-api');

const api = createMockApi({
  functionsPath: process.argv[2],
  scriptApiPath: process.argv[3],
});

readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    const reply = api.handleMessage(JSON.parse(line));
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
