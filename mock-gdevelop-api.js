'use strict';

/**
 * The fake GDevelop MCP server used by the tests: the same JSON-RPC methods
 * and replies, serving the real tool definitions from `functions.json` so
 * that the size of the rewritten tool list can be measured.
 *
 * The transports are elsewhere: `mock-upstream.js` (stdin/stdout) and
 * `test-funnel.js` (the live editor HTTP contract).
 */

const fs = require('fs');

const createMockApi = ({ functionsPath, scriptApiPath }) => {
  const api = functionsPath
    ? JSON.parse(fs.readFileSync(functionsPath, 'utf8'))
    : { functions: [], lookupFunctions: [] };

  const serverTools = [
    {
      name: 'save_project',
      description: 'Save the project.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'read_script_api_definition',
      description: 'Read the script API.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'read_gameplay_test_harness_guide',
      description: 'Read the gameplay test harness guide.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  // The lookup tools are published by the real server from `lookupFunctions`
  // of the public API (one entry each), not hand-written here: adding them
  // twice would not match what GDevelop publishes. What the real `--mcp`
  // server publishes: 32 functions, 5 lookup functions, 2 doc tools and
  // save_project. Not `create_project`/`list_game_templates`, which only the
  // HTTP server gets.
  const tools = [
    ...(api.functions || []),
    ...(api.lookupFunctions || []),
    ...serverTools,
  ];

  const resources = [
    {
      uri: 'gdevelop://script-api-definition',
      name: 'Script API definition',
      mimeType: 'text/plain',
    },
    {
      uri: 'gdevelop://event-script-guide',
      name: 'EventScript guide',
      mimeType: 'text/markdown',
    },
    {
      uri: 'gdevelop://gameplay-test-harness-guide',
      name: 'Gameplay test harness guide',
      mimeType: 'text/markdown',
    },
  ];

  const readResource = (uri) =>
    uri === 'gdevelop://script-api-definition' && scriptApiPath
      ? fs.readFileSync(scriptApiPath, 'utf8')
      : `documentation for ${uri}`;

  /** Returns the reply to send back, or null for a notification. */
  const handleMessage = (message) => {
    if (message.id === undefined || message.id === null) return null;
    const { id, method, params } = message;
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'gdevelop', version: '5.6.287' },
          instructions: 'x'.repeat(20000),
        },
      };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools } };
    }
    if (method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                called: params.name,
                arguments: params.arguments,
              }),
            },
          ],
          isError: false,
        },
      };
    }
    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources } };
    }
    if (method === 'resources/read') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: params.uri,
              mimeType: 'text/plain',
              text: readResource(params.uri),
            },
          ],
        },
      };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } };
  };

  return { tools, resources, readResource, handleMessage };
};

module.exports = { createMockApi };
