'use strict';

/**
 * Drives funnel.js over stdio against a fake upstream, and checks the three
 * ways it has to work:
 *
 * 1. stdio: GDevelop spawned with `--mcp`, on a newline-delimited JSON-RPC.
 * 2. http: the live editor server (POST + `Mcp-Session-Id` + 202 for
 *    notifications + 404 when the session is gone), which is what the
 *    installed editor serves on port 52520.
 * 3. offline: no editor at all. The handshake still succeeds and the tool
 *    list comes from the cache, so the client never sees a dead connection.
 *
 * It also prints what the tool surface costs before and after.
 *
 * Usage: node test-funnel.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const { createMockApi } = require('./mock-gdevelop-api');

// The real function schemas live in the GDevelop source tree. The funnel
// itself does not need it: only this test does, to measure what the editor
// publishes. Set GDEVELOP_SOURCE_DIR if the folder was moved somewhere else.
const API_SUBDIR = 'newIDE/app/src/EditorFunctions/PublicApi/v22';
const findSourceTree = () => {
  const candidates = [
    process.env.GDEVELOP_SOURCE_DIR,
    path.join(__dirname, '..', 'GDevelop-master'),
    path.join(__dirname, '..', 'GDevelop-master', 'GDevelop-master'),
    path.join(__dirname, '..'),
  ].filter(Boolean);
  return (
    candidates.find((base) =>
      fs.existsSync(path.join(base, API_SUBDIR, 'functions.json'))
    ) || null
  );
};

const sourceRoot = findSourceTree();
if (!sourceRoot) {
  console.error(
    `Cannot find the GDevelop source tree (${API_SUBDIR}/functions.json).\nSet GDEVELOP_SOURCE_DIR to the root of a GDevelop checkout, or run this test from next to one.`
  );
  process.exit(2);
}
console.log(`GDevelop source: ${sourceRoot}\n`);
const functionsPath = path.join(sourceRoot, API_SUBDIR, 'functions.json');
const scriptApiPath = path.join(sourceRoot, API_SUBDIR, 'script-api.d.ts');

const api = createMockApi({ functionsPath, scriptApiPath });
const approxTokens = (text) => Math.round(text.length / 4);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-test-'));

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startFunnel = (env) => {
  const proxy = spawn(process.execPath, [path.join(__dirname, 'funnel.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GDEVELOP_MCP_CMD: '', ...env },
  });
  const waiting = new Map();
  let nextId = 1;

  proxy.stderr.on('data', (chunk) => process.stderr.write(`[test] ${chunk}`));
  readline.createInterface({ input: proxy.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    const resolve = waiting.get(message.id);
    if (!resolve) return;
    waiting.delete(message.id);
    resolve(message);
  });

  return {
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, resolve);
        proxy.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
        );
        setTimeout(() => {
          if (waiting.delete(id)) reject(new Error(`timeout on ${method}`));
        }, 20000);
      }),
    stop: () => proxy.stdin.end(),
  };
};

const initialize = (funnel) =>
  funnel.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });

const checkToolList = (list, label) => {
  const tools = list.result.tools;
  const listJson = JSON.stringify({ tools });
  console.log(
    `${label}: ${tools.length} tools, ${listJson.length} chars (~${approxTokens(
      listJson
    )} tokens)`
  );
  console.log(`  names: ${tools.map((tool) => tool.name).join(', ')}`);
  if (tools.length !== 4) fail(`${label}: expected 4 tools, got ${tools.length}`);
  const gdevelop = tools.find((tool) => tool.name === 'gdevelop');
  if (!gdevelop) fail(`${label}: no gdevelop tool`);
  if (!/generate_events\(/.test(gdevelop.description))
    fail(`${label}: the signature sheet is missing generate_events`);
  console.log(
    `  gdevelop description: ${gdevelop.description.length} chars (~${approxTokens(
      gdevelop.description
    )} tokens)`
  );

  const sheetLines = gdevelop.description
    .split('\n')
    .filter((line) => /^[a-z][a-z0-9_]*\(/.test(line));
  const duplicateLines = sheetLines.filter(
    (line, index) => sheetLines.indexOf(line) !== index
  );
  if (duplicateLines.length)
    fail(`${label}: the signature sheet repeats: ${duplicateLines.join(' | ')}`);
  console.log(`  ${sheetLines.length} signatures, no duplicates`);
  return gdevelop;
};

const checkInitialize = (init, label) => {
  if (!init.result) fail(`${label}: initialize returned no result`);
  const instructions = init.result.instructions || '';
  if (instructions.length > 2000)
    fail(`${label}: instructions were not trimmed (${instructions.length} chars)`);
  console.log(
    `initialize: instructions ${instructions.length} chars (~${approxTokens(
      instructions
    )} tokens), serverInfo ${init.result.serverInfo.name}`
  );
};

const checkStdio = async () => {
  console.log('--- stdio upstream (GDevelop --mcp) ---');
  const funnel = startFunnel({
    GDEVELOP_MCP_CMD: JSON.stringify([
      process.execPath,
      path.join(__dirname, 'mock-upstream.js'),
      functionsPath,
      scriptApiPath,
    ]),
    GDEVELOP_FUNNEL_CACHE: path.join(tempDir, 'stdio-cache.json'),
  });

  checkInitialize(await initialize(funnel), 'stdio');
  checkToolList(await funnel.call('tools/list', {}), 'tools/list');

  const forwarded = await funnel.call('tools/call', {
    name: 'gdevelop',
    arguments: {
      function_name: 'describe_instances',
      arguments: { scope: 'scene:Game Scene' },
    },
  });
  const parsed = JSON.parse(forwarded.result.content[0].text);
  if (parsed.called !== 'describe_instances')
    fail(`forwarded to ${parsed.called} instead of describe_instances`);
  if (parsed.arguments.scope !== 'scene:Game Scene')
    fail('arguments were not forwarded');
  console.log(
    'tools/call gdevelop -> forwarded to describe_instances with its arguments'
  );

  const unknown = await funnel.call('tools/call', {
    name: 'gdevelop',
    arguments: { function_name: 'nope_this_is_not_real', arguments: {} },
  });
  if (!unknown.result.isError) fail('an unknown function was not rejected');
  console.log('tools/call gdevelop -> rejects an unknown function name');

  const schema = await funnel.call('tools/call', {
    name: 'docs',
    arguments: { what: 'schema', name: 'generate_events' },
  });
  const schemaText = schema.result.content[0].text;
  if (!/event_batches/.test(schemaText))
    fail('docs schema did not return generate_events inputSchema');
  console.log(
    `docs schema generate_events: ${schemaText.length} chars (~${approxTokens(
      schemaText
    )} tokens, on demand)`
  );

  const guide = await funnel.call('tools/call', {
    name: 'docs',
    arguments: { what: 'event_script_guide' },
  });
  if (!/documentation for/.test(guide.result.content[0].text))
    fail('docs event_script_guide did not read a resource');
  console.log('docs event_script_guide -> served from resources/read');

  const passthrough = await funnel.call('tools/call', {
    name: 'read_game_project_json',
    arguments: { path: 'scenes' },
  });
  if (
    JSON.parse(passthrough.result.content[0].text).called !==
    'read_game_project_json'
  )
    fail('read_game_project_json was not passed through');
  console.log('tools/call read_game_project_json -> passed through');

  const extensionDocs = await funnel.call('tools/call', {
    name: 'docs',
    arguments: { what: 'extension', names: ['Sprite', 'Physics3D'] },
  });
  const readFullDocs = JSON.parse(extensionDocs.result.content[0].text);
  if (readFullDocs.called !== 'read_full_docs')
    fail(`docs extension called ${readFullDocs.called}`);
  // Upstream takes a comma-separated string, not an array.
  if (readFullDocs.arguments.extension_names !== 'Sprite, Physics3D')
    fail(
      `docs extension sent ${JSON.stringify(
        readFullDocs.arguments.extension_names
      )} instead of comma-separated names`
    );
  console.log(
    'docs extension -> read_full_docs with comma-separated names ("Sprite, Physics3D")'
  );

  const harness = await funnel.call('tools/call', {
    name: 'docs',
    arguments: { what: 'gameplay_guide' },
  });
  if (!/documentation for/.test(harness.result.content[0].text))
    fail('docs gameplay_guide did not read a resource');
  console.log('docs gameplay_guide -> served from resources/read');

  funnel.stop();
  console.log('');
};

/**
 * The live editor server, as `LiveMcpServer.js` implements it: POST only, a
 * bearer token, a `Mcp-Session-Id` header created by `initialize` and required
 * afterwards, a 202 for notifications, a 404 for a session that is gone, and a
 * DELETE that releases it.
 */
const createLiveMock = (token) => {
  const sessions = new Set();
  const seen = { withSessionHeader: 0, deletes: 0, created: 0 };
  let counter = 0;

  const server = http.createServer((req, res) => {
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      res.writeHead(405, { allow: 'POST, DELETE' });
      res.end();
      return;
    }
    if ((req.headers.authorization || '') !== `Bearer ${token}`) {
      json(
        401,
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Invalid or missing bearer token.' },
        },
        { 'www-authenticate': 'Bearer' }
      );
      return;
    }
    if (req.method === 'DELETE') {
      seen.deletes++;
      sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(204);
      res.end();
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = Array.isArray(body) ? body : [body];
      const headers = {};
      let sessionId = req.headers['mcp-session-id'];

      if (messages.some((message) => message.method === 'initialize')) {
        sessionId = `session-${++counter}`;
        seen.created++;
        sessions.add(sessionId);
        headers['Mcp-Session-Id'] = sessionId;
      } else if (!sessionId) {
        json(400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Missing Mcp-Session-Id header.' },
        });
        return;
      } else {
        seen.withSessionHeader++;
        if (!sessions.has(sessionId)) {
          json(404, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Session not found.' },
          });
          return;
        }
      }

      const requests = messages.filter(
        (message) =>
          typeof message.method === 'string' &&
          message.id !== undefined &&
          message.id !== null
      );
      if (!requests.length) {
        res.writeHead(202, headers);
        res.end();
        return;
      }
      const replies = requests.map(api.handleMessage).filter(Boolean);
      json(200, Array.isArray(body) ? replies : replies[0], headers);
    });
  });

  return {
    start: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      ),
    expireSessions: () => sessions.clear(),
    created: () => seen.created,
    seen,
    stop: () =>
      new Promise((resolve) => {
        if (server.closeAllConnections) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const checkHttp = async () => {
  console.log('--- http upstream (the live editor server) ---');
  const token = 'test-token-2f9c1a4e7b3d8f60';
  const mock = createLiveMock(token);
  const port = await mock.start();
  const cache = path.join(tempDir, 'http-cache.json');

  const funnel = startFunnel({
    GDEVELOP_FUNNEL_URL: `http://127.0.0.1:${port}/mcp`,
    GDEVELOP_MCP_TOKEN: token,
    GDEVELOP_FUNNEL_CACHE: cache,
  });

  checkInitialize(await initialize(funnel), 'http');
  checkToolList(await funnel.call('tools/list', {}), 'tools/list');

  if (!fs.existsSync(cache)) fail('the tool list was not cached');
  console.log('tools/list -> tool list cached for the next starts');

  const forwarded = await funnel.call('tools/call', {
    name: 'gdevelop',
    arguments: {
      function_name: 'put_3d_instances',
      arguments: { scope: { type: 'project' }, instances_size: '100,200,150' },
    },
  });
  const parsed = JSON.parse(forwarded.result.content[0].text);
  if (parsed.called !== 'put_3d_instances')
    fail(`forwarded to ${parsed.called} instead of put_3d_instances`);
  if (mock.seen.withSessionHeader < 1)
    fail('the session header was not sent after the handshake');
  console.log(
    'tools/call gdevelop -> forwarded over HTTP with the session header'
  );

  // The editor restarted and forgot the session: the call fails with a
  // readable message, and the next one reconnects by itself.
  mock.expireSessions();
  const expired = await funnel.call('tools/call', {
    name: 'save_project',
    arguments: {},
  });
  if (!expired.error || !/lost the MCP session/.test(expired.error.message))
    fail(`a lost session was not reported: ${JSON.stringify(expired)}`);
  console.log(`tools/call save_project -> ${expired.error.message.slice(0, 70)}...`);

  const afterReconnect = await funnel.call('tools/call', {
    name: 'save_project',
    arguments: {},
  });
  if (!afterReconnect.result)
    fail('the funnel did not reconnect after the session was lost');
  if (mock.created() < 2) fail('no new session was created');
  console.log('tools/call save_project -> reconnected with a new session');

  funnel.stop();
  await sleep(600);
  if (!mock.seen.deletes) fail('the session was not released on exit');
  console.log('exit -> the session is released (DELETE)');
  await mock.stop();
  console.log('');
};

const checkOffline = async () => {
  console.log('--- no editor running ---');
  const cache = path.join(tempDir, 'offline-cache.json');
  fs.writeFileSync(cache, JSON.stringify({ tools: api.tools }));

  // A port with nothing on it.
  const probe = http.createServer(() => {});
  const port = await new Promise((resolve) =>
    probe.listen(0, '127.0.0.1', () => resolve(probe.address().port))
  );
  await new Promise((resolve) => probe.close(resolve));

  const funnel = startFunnel({
    GDEVELOP_FUNNEL_URL: `http://127.0.0.1:${port}/mcp`,
    GDEVELOP_MCP_TOKEN: 'test-token-2f9c1a4e7b3d8f60',
    GDEVELOP_FUNNEL_CACHE: cache,
  });

  checkInitialize(await initialize(funnel), 'offline');
  checkToolList(await funnel.call('tools/list', {}), 'tools/list (cached)');

  const call = await funnel.call('tools/call', {
    name: 'gdevelop',
    arguments: { function_name: 'describe_instances', arguments: {} },
  });
  if (!call.error || !/not reachable/.test(call.error.message))
    fail(`an unconnected editor was not reported: ${JSON.stringify(call)}`);
  console.log(`tools/call -> ${call.error.message.slice(0, 90)}...`);
  console.log('the client stays connected: the handshake is answered locally');

  funnel.stop();
  await sleep(400);
  console.log('');
};

const main = async () => {
  await checkStdio();
  await checkHttp();
  await checkOffline();
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('All checks passed.');
  process.exit(0);
};

main().catch((error) => fail(error.stack || error.message));
