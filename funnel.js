#!/usr/bin/env node
'use strict';

/**
 * gdevelop-mcp-funnel
 *
 * A stdio MCP server that sits in front of the GDevelop MCP server and exposes
 * a small tool surface instead of the ~40 tools it publishes.
 *
 * The tool schemas are what costs tokens: GDevelop publishes one JSON Schema
 * per editor function, about 35k tokens re-sent on every API request. This
 * proxy keeps a single `gdevelop(function_name, arguments)` tool whose
 * description is a compact signature list (about 1k tokens) and forwards each
 * call to the real tool on the upstream server, which still validates the
 * arguments. Nothing is lost: `docs({what:"schema", name})` returns any
 * function's full JSON Schema on demand.
 *
 * Two upstream transports, chosen by the configuration:
 *
 * - "http" (default): the live editor server, `http://127.0.0.1:52520/mcp`,
 *   started by opening GDevelop and enabling the MCP server in its
 *   preferences. The token and the port are read from the editor settings
 *   file (`mcp-live-server.json` in GDevelop's user data folder).
 * - "stdio": an editor instance spawned with `--mcp`, as a command to run.
 *
 * The handshake of the MCP client is answered by the funnel itself, and the
 * tool list is cached on disk: the funnel therefore connects whether or not
 * GDevelop is running, and an unreachable editor shows up as a readable tool
 * error ("GDevelop is not reachable at ...") instead of a dead connection.
 *
 * Configuration: `funnel.config.json` next to this file.
 *
 *   { "url": "http://127.0.0.1:52520/mcp" }                       // http
 *   { "command": ["C:/GDevelop/GDevelop.exe", "--mcp", "a.json"] } // stdio
 *
 * `funnel.config.local.json` next to it is merged over it, key by key. It is
 * git-ignored, so it is the place for a token or a machine-specific path.
 *
 * The environment wins over both: GDEVELOP_FUNNEL_URL / GDEVELOP_MCP_TOKEN /
 * GDEVELOP_MCP_CMD / GDEVELOP_FUNNEL_CACHE / GDEVELOP_FUNNEL_CONFIG.
 *
 * Only JSON-RPC goes to stdout; logs go to stderr.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');

const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_LIVE_URL = 'http://127.0.0.1:52520/mcp';
const HANDSHAKE_TIMEOUT = 15000;
const TOOL_LIST_TIMEOUT = 20000;
const CACHE_FILE =
  process.env.GDEVELOP_FUNNEL_CACHE || path.join(__dirname, 'funnel-cache.json');

const HANDSHAKE_PARAMS = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'gdevelop-mcp-funnel', version: '1.0.0' },
};

const FALLBACK_INSTRUCTIONS = [
  'This server edits the GDevelop project opened in the editor. The editor functions are exposed through one tool, `gdevelop(function_name, arguments)`.',
  'Explore before editing: `read_game_project_json` gives the scenes, objects, variables and events; `gdevelop` with `describe_instances` and the `inspect_*` functions gives details. Never guess object names.',
  'Every tool call is a full round trip of the whole conversation: batch related steps into one `gdevelop` call with `run_script` instead of calling one function per step.',
  'Before writing events with `generate_events`, read `docs({what:"event_script_guide"})`. EventScript syntax is not optional and cannot be guessed.',
  'Before writing a `run_script`, read `docs({what:"script_api"})` once. It is large: only do it when the named functions cannot do the job.',
  'Never guess the actions, conditions or expressions of events: `docs({what:"extension", names:["..."]})` gives their exact names and parameters.',
  'The changes are kept in memory: call `save_project` once a coherent set of changes is done.',
  'Full JSON Schema of one function: `docs({what:"schema", name:"..."})`.',
  'If a call answers that GDevelop is not reachable, ask the user to open the editor with the project and retry: the funnel reconnects by itself on the next call.',
].join('\n');

const TOOLS_HANDLED_HERE = new Set([
  'gdevelop',
  'docs',
  'read_game_project_json',
  'save_project',
  'create_project',
]);

// Tools that are documented on demand by `docs` rather than listed in the
// signature sheet.
const NOT_IN_SHEET = new Set([
  'read_script_api_definition',
  'read_gameplay_test_harness_guide',
  'read_full_docs',
  'search_docs',
  'read_javascript_reference',
  'search_object_asset_store',
  'search_resource_store',
  'save_project',
  'create_project',
  'read_game_project_json',
]);

const PASSTHROUGH_TOOLS = [
  'read_game_project_json',
  'save_project',
  'create_project',
];

const log = (message) => process.stderr.write(`[funnel] ${message}\n`);

const idKey = (id) => JSON.stringify(id);

const withTimeout = (promise, ms, label) => {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not answer within ${ms / 1000}s`)),
      ms
    );
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
};

// Where the editor keeps the live MCP server settings ({ enabled, port,
// token }): the Electron `userData` folder of "GDevelop 5".
const liveSettingsFiles = (configured) =>
  [
    configured,
    process.env.GDEVELOP_LIVE_SETTINGS,
    process.env.APPDATA &&
      path.join(process.env.APPDATA, 'GDevelop 5', 'mcp-live-server.json'),
    process.env.APPDATA &&
      path.join(process.env.APPDATA, 'GDevelop', 'mcp-live-server.json'),
    process.env.HOME &&
      path.join(
        process.env.HOME,
        'Library/Application Support/GDevelop 5/mcp-live-server.json'
      ),
    process.env.HOME &&
      path.join(process.env.HOME, '.config/GDevelop 5/mcp-live-server.json'),
    process.env.HOME &&
      path.join(process.env.HOME, '.config/gdevelop/mcp-live-server.json'),
  ].filter(Boolean);

const findLiveSettings = (configured) => {
  for (const file of liveSettingsFiles(configured)) {
    const settings = readJsonFile(file);
    if (settings && typeof settings === 'object') return { ...settings, file };
  }
  return null;
};

// `funnel.config.json` holds the shared settings; `funnel.config.local.json`
// next to it is merged over it key by key. A custom GDEVELOP_FUNNEL_CONFIG
// gets the same `.local.json` sibling.
const loadFileConfig = (configPath) => {
  const shared = readJsonFile(configPath) || {};
  const localPath = configPath.replace(/\.json$/i, '.local.json');
  if (localPath === configPath) return shared;
  const local = readJsonFile(localPath);
  if (!local) return shared;
  log(`local config: ${localPath}`);
  return { ...shared, ...local };
};

const loadConfig = () => {
  const configPath =
    process.env.GDEVELOP_FUNNEL_CONFIG ||
    path.join(__dirname, 'funnel.config.json');
  const fileConfig = loadFileConfig(configPath);

  let command = process.env.GDEVELOP_MCP_CMD || fileConfig.command;
  if (typeof command === 'string' && command.trim().startsWith('[')) {
    try {
      command = JSON.parse(command);
    } catch (error) {
      log(`GDEVELOP_MCP_CMD is not valid JSON: ${error.message}`);
      process.exit(2);
    }
  }

  const instructions =
    typeof fileConfig.instructions === 'string' && fileConfig.instructions.trim()
      ? fileConfig.instructions
      : FALLBACK_INSTRUCTIONS;

  if (command && !(Array.isArray(command) && command.length === 0)) {
    return { mode: 'stdio', command, instructions, warning: null };
  }

  const settings = findLiveSettings(fileConfig.settingsFile);
  const url =
    process.env.GDEVELOP_FUNNEL_URL ||
    fileConfig.url ||
    (settings && settings.port
      ? `http://127.0.0.1:${settings.port}/mcp`
      : DEFAULT_LIVE_URL);
  const token =
    process.env.GDEVELOP_MCP_TOKEN ||
    fileConfig.token ||
    (settings && typeof settings.token === 'string' ? settings.token : null) ||
    null;

  const warnings = [];
  if (token) {
    if (settings) log(`token read from ${settings.file}`);
  } else {
    warnings.push(
      'No GDevelop MCP token found. Open GDevelop, enable the MCP server in its preferences, then run `node funnel.js --check` (or set "token" in funnel.config.local.json).'
    );
  }
  if (settings && settings.enabled === false) {
    warnings.push(
      'The MCP server is disabled in GDevelop: enable it in the editor preferences.'
    );
  }

  return {
    mode: 'http',
    url,
    token,
    target: new URL(url),
    instructions,
    warning: warnings.length ? warnings.join(' ') : null,
  };
};

/**
 * The upstream transports. Both expose the same interface:
 * - post(message): send one JSON-RPC message upstream.
 * - onMessage(handler): called with every JSON-RPC message coming back.
 * - close(): release the upstream session.
 * - describe(): what it connects to, for the logs and the errors.
 */
const createStdioTransport = (command) => {
  const child = Array.isArray(command)
    ? spawn(command[0], command.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    : spawn(command, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });

  const handlers = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      log(`ignoring a non JSON-RPC line from the upstream: ${line.slice(0, 120)}`);
      return;
    }
    handlers.forEach((handler) => handler(message));
  });
  if (child.stderr) {
    readline
      .createInterface({ input: child.stderr })
      .on('line', (line) => process.stderr.write(`[gdevelop] ${line}\n`));
  }
  child.on('error', (error) =>
    log(`could not start the GDevelop server: ${error.message}`)
  );
  child.on('exit', (code) => {
    if (!child.killed) log(`the GDevelop server exited (code ${code}).`);
  });

  return {
    post: (message) => {
      if (!child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (handler) => handlers.push(handler),
    close: () => {
      try {
        child.kill();
      } catch (error) {
        // Already gone.
      }
    },
    describe: () => 'the GDevelop --mcp process',
  };
};

/**
 * The live editor server (see `LiveMcpServer.js` in the Electron app): one
 * JSON-RPC message per POST, a `Mcp-Session-Id` header given by `initialize`
 * and needed on every later message, a 202 for notifications. There is no
 * server-sent stream.
 */
const createHttpTransport = ({ url, token, warning }) => {
  const target = new URL(url);
  const handlers = [];
  const handshakePending = new Map();
  let sessionId = null;
  let session = null;
  let handshakeCount = 0;
  let closed = false;

  const emit = (message) => handlers.forEach((handler) => handler(message));

  const unreachable = (reason) =>
    `GDevelop is not reachable at ${url} (${reason}). Open the GDevelop editor and retry the call: the funnel reconnects by itself.${
      warning ? ` ${warning}` : ''
    }`;

  const request = ({ method, headers, body }, onResponse, onError) => {
    const sent = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search || ''}`,
        method,
        headers,
      },
      onResponse
    );
    sent.on('error', onError);
    sent.end(body);
  };

  const settleHandshake = (message, error) => {
    const entry = handshakePending.get(idKey(message.id));
    if (!entry) return false;
    handshakePending.delete(idKey(message.id));
    if (error) entry.reject(error);
    else entry.resolve(message);
    return true;
  };

  const failRequest = (message, reason, text) => {
    if (message.id === undefined || message.id === null) return;
    const finalText = text || unreachable(reason);
    if (settleHandshake(message, new Error(finalText))) return;
    emit({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: finalText },
    });
  };

  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': body.length,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;

    request(
      { method: 'POST', headers, body },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const received = response.headers['mcp-session-id'];
          if (typeof received === 'string' && received) sessionId = received;
          const status = response.statusCode || 0;
          const text = Buffer.concat(chunks).toString('utf8');

          if (status === 202) return; // A notification: nothing to answer.
          if (status === 200) {
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch (error) {
              parsed = null;
            }
            if (!parsed) {
              failRequest(message, 'the editor answered with invalid JSON');
              return;
            }
            (Array.isArray(parsed) ? parsed : [parsed]).forEach((item) => {
              if (!item || typeof item !== 'object') return;
              if (item.id !== undefined && settleHandshake(item)) return;
              emit(item);
            });
            return;
          }

          // The session is gone (the editor was restarted, or the funnel
          // reconnected): the next message will handshake again.
          if (status === 404) {
            sessionId = null;
            session = null;
            failRequest(
              message,
              'the session expired',
              'GDevelop lost the MCP session (the editor was restarted?). Retry the call: the funnel reconnects by itself.'
            );
            return;
          }
          const reasons = {
            400: 'the request was rejected (missing session)',
            401: 'the bearer token was rejected',
            403: 'the request was refused (origin)',
            405: 'the HTTP method is not allowed',
            503: 'no GDevelop window is opened',
          };
          let detail = '';
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.error && parsed.error.message)
              detail = ` - ${parsed.error.message}`;
          } catch (error) {
            // Not JSON-RPC: ignore the body.
          }
          failRequest(message, `${reasons[status] || `HTTP ${status}`}${detail}`);
        });
      },
      (error) =>
        failRequest(
          message,
          error.code === 'ECONNREFUSED'
            ? 'connection refused'
            : error.code === 'ECONNRESET'
            ? 'the connection was reset'
            : error.message
        )
    );
  };

  /** Binds a session to the focused GDevelop window, once. */
  const ensureSession = () => {
    if (sessionId) return Promise.resolve();
    if (session) return session;
    session = new Promise((resolve, reject) => {
      const id = `funnel-handshake-${++handshakeCount}`;
      handshakePending.set(idKey(id), { resolve, reject });
      send({ jsonrpc: '2.0', id, method: 'initialize', params: HANDSHAKE_PARAMS });
      const timer = setTimeout(() => {
        if (settleHandshake({ id }, new Error('the handshake timed out')))
          log('the editor did not answer the MCP handshake.');
      }, HANDSHAKE_TIMEOUT);
      if (timer.unref) timer.unref();
    })
      .then(() => {
        log(`connected to the editor at ${url}`);
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      })
      .catch((error) => {
        session = null;
        throw error;
      });
    return session;
  };

  return {
    post: (message) => {
      if (closed) return;
      if (message.method === 'initialize') return send(message);
      ensureSession()
        .then(() => send(message))
        // The handshake failure is already a full sentence: do not wrap it.
        .catch((error) => failRequest(message, null, error.message));
    },
    onMessage: (handler) => handlers.push(handler),
    close: () => {
      if (closed) return;
      closed = true;
      if (!sessionId) return;
      // Lets the editor drop the queue of this session.
      request(
        {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${token || ''}`,
            'mcp-session-id': sessionId,
          },
        },
        (response) => response.resume(),
        () => {}
      );
    },
    describe: () => url,
  };
};

const loadCache = () => {
  const cached = readJsonFile(CACHE_FILE);
  if (!cached || !Array.isArray(cached.tools) || !cached.tools.length) return null;
  return cached.tools;
};

const saveCache = (tools) => {
  try {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ savedAt: new Date().toISOString(), tools }),
      'utf8'
    );
  } catch (error) {
    log(`could not write the tool list cache: ${error.message}`);
  }
};

// The lookup functions take comma-separated names (`Sprite, Physics3D`): accept
// an array too, so that `docs` callers can pass a list.
const toCommaSeparated = (value) => {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
};

const describeFunction = (definition) => {
  const schema = definition.inputSchema || {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const names = Object.keys(properties);
  const ordered = [
    ...names.filter((name) => required.has(name)),
    ...names.filter((name) => !required.has(name)),
  ];
  return `${definition.name}(${ordered
    .map((name) => (required.has(name) ? name : `${name}?`))
    .join(', ')})`;
};

const buildSignatureSheet = (publishedTools) => {
  // A tool published twice would cost tokens and give two signatures of
  // contradictory arity: keep the first one only.
  const seenNames = new Set();
  const upstreamTools = publishedTools.filter((tool) => {
    if (seenNames.has(tool.name)) return false;
    seenNames.add(tool.name);
    return true;
  });
  const documented = upstreamTools.filter((tool) => !NOT_IN_SHEET.has(tool.name));
  const hidden = upstreamTools.filter(
    (tool) => NOT_IN_SHEET.has(tool.name) && tool.name !== 'save_project'
  );
  const lines = [
    'Required arguments first, `?` marks optional ones. `arguments` is passed as-is.',
    '',
    ...documented.map(describeFunction),
    '',
    'Other callable tools:',
    ...hidden
      .filter((tool) => !PASSTHROUGH_TOOLS.includes(tool.name))
      .map(describeFunction),
    '',
    'Full schema of one function: docs({what:"schema", name:"..."}).',
    'EventScript syntax: docs({what:"event_script_guide"}).',
  ];
  return lines.join('\n');
};

const buildTools = (upstreamTools) => {
  const byName = new Map(upstreamTools.map((tool) => [tool.name, tool]));
  const tools = [
    {
      name: 'gdevelop',
      description: buildSignatureSheet(upstreamTools),
      inputSchema: {
        type: 'object',
        properties: {
          function_name: {
            type: 'string',
            description: 'The editor function to call, from the list above.',
          },
          arguments: {
            type: 'object',
            description:
              'The arguments of the function, as an object. Omitted arguments must be optional.',
            additionalProperties: true,
          },
        },
        required: ['function_name'],
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: 'docs',
      description:
        'Read GDevelop documentation on demand, and the full JSON Schema of an editor function. Nothing here is sent to the model until it is called.',
      inputSchema: {
        type: 'object',
        properties: {
          what: {
            type: 'string',
            enum: [
              'event_script_guide',
              'script_api',
              'gameplay_guide',
              'schema',
              'extension',
              'search',
              'javascript',
            ],
            description:
              'event_script_guide: the EventScript syntax for generate_events. script_api: the API of run_script scripts (large). gameplay_guide: the gameplay test harness (large). schema: the JSON Schema of one function. extension: the docs of extensions, by name. search: the wiki and the extensions matching a query. javascript: the game engine API, by name.',
          },
          name: {
            type: 'string',
            description: 'For what:"schema", the function name.',
          },
          names: {
            type: 'array',
            items: { type: 'string' },
            description:
              'For what:"extension" and what:"javascript", the extension or class names (an array, or the comma-separated form upstream takes).',
          },
          query: {
            type: 'string',
            description: 'For what:"search", what to look for.',
          },
        },
        required: ['what'],
      },
      annotations: { readOnlyHint: true },
    },
  ];

  for (const name of PASSTHROUGH_TOOLS) {
    const tool = byName.get(name);
    if (tool) tools.push(tool);
  }
  return tools;
};

/** `node funnel.js --check`: tells whether the editor answers, without a client. */
const runCheck = (config) => {
  log(`mode: ${config.mode}`);
  if (config.mode === 'http') {
    log(`url: ${config.url}`);
    log(
      config.token
        ? `token: ${config.token.slice(0, 6)}... (${config.token.length} characters)`
        : 'token: none'
    );
  } else {
    log(`command: ${JSON.stringify(config.command)}`);
  }
  if (config.warning) log(`warning: ${config.warning}`);

  const transport =
    config.mode === 'http'
      ? createHttpTransport(config)
      : createStdioTransport(config.command);
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    transport.close();
    setTimeout(() => process.exit(code), 200);
  };

  transport.onMessage((message) => {
    if (message.id !== 'funnel-check') return;
    if (message.error) {
      console.error(`NOT reachable - ${message.error.message}`);
      finish(1);
      return;
    }
    const tools = (message.result && message.result.tools) || [];
    console.log(
      `Reachable. The editor publishes ${tools.length} tools; the funnel exposes ${
        buildTools(tools).length
      }.`
    );
    finish(0);
  });
  transport.post({
    jsonrpc: '2.0',
    id: 'funnel-check',
    method: 'tools/list',
    params: {},
  });
  setTimeout(() => {
    console.error('No answer from the editor within 20s.');
    finish(1);
  }, 20000).unref();
};

const main = () => {
  const config = loadConfig();
  if (process.argv.includes('--check')) return runCheck(config);
  const transport =
    config.mode === 'http'
      ? createHttpTransport(config)
      : createStdioTransport(config.command);
  log(
    config.mode === 'http'
      ? `upstream: the live editor server at ${config.url}`
      : `upstream: ${transport.describe()}`
  );
  if (config.warning) log(config.warning);

  const internal = new Map();
  let internalCounter = 0;
  let upstreamTools = null;
  let closing = false;

  const sendClient = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const respondTool = (id, text, isError) =>
    sendClient({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], isError: !!isError },
    });

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `funnel-${++internalCounter}`;
      internal.set(id, { resolve, reject });
      transport.post({ jsonrpc: '2.0', id, method, params });
    });

  const callUpstreamTool = (name, toolArguments) =>
    rpc('tools/call', { name, arguments: toolArguments });

  const readResourceByKeyword = async (keyword) => {
    const listing = await rpc('resources/list', {});
    const resources =
      (listing && listing.result && listing.result.resources) || [];
    const match = resources.find((resource) =>
      new RegExp(keyword, 'i').test(`${resource.name} ${resource.uri}`)
    );
    if (!match) return null;
    const read = await rpc('resources/read', { uri: match.uri });
    const contents = (read && read.result && read.result.contents) || [];
    const [first] = contents;
    return first && typeof first.text === 'string' ? first.text : null;
  };

  const buildInstructions = () =>
    config.warning ? `${config.instructions}\n\n${config.warning}` : config.instructions;

  // The handshake is answered here, not upstream: a client gives up after
  // ~30s, and an editor that never answers it (or is not running) must not
  // turn into a connection error. Upstream problems show up as tool errors.
  const handleInitialize = (message) => {
    const params = message.params || {};
    sendClient({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion:
          typeof params.protocolVersion === 'string'
            ? params.protocolVersion
            : MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'gdevelop-funnel', version: '1.0.0' },
        instructions: buildInstructions(),
      },
    });
  };

  const handleToolsList = async (message) => {
    try {
      const listing = await withTimeout(
        rpc('tools/list', message.params || {}),
        TOOL_LIST_TIMEOUT,
        'the tool list'
      );
      const tools = (listing && listing.result && listing.result.tools) || [];
      if (!tools.length) throw new Error('the tool list is empty');
      upstreamTools = tools;
      saveCache(tools);
      log(`${tools.length} tools from ${transport.describe()}`);
    } catch (error) {
      const cached = loadCache();
      log(
        `no tool list from ${transport.describe()}: ${error.message}${
          cached ? '. Using the cached one.' : '.'
        }`
      );
      upstreamTools = cached;
    }
    sendClient({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: buildTools(upstreamTools || []) },
    });
  };

  const handleDocs = async (message) => {
    const args = (message.params && message.params.arguments) || {};
    const what = args.what;
    try {
      if (what === 'schema') {
        if (!upstreamTools) {
          respondTool(
            message.id,
            'The list of editor functions is not available: GDevelop is not reachable. Open the editor and retry.',
            true
          );
          return;
        }
        const tool = upstreamTools.find((candidate) => candidate.name === args.name);
        if (!tool) {
          respondTool(
            message.id,
            `Unknown function: ${args.name}. See the signature list in the gdevelop tool.`,
            true
          );
          return;
        }
        respondTool(message.id, JSON.stringify(tool.inputSchema));
        return;
      }
      if (
        what === 'event_script_guide' ||
        what === 'script_api' ||
        what === 'gameplay_guide'
      ) {
        const keyword =
          what === 'event_script_guide'
            ? 'event ?script'
            : what === 'script_api'
            ? 'script api'
            : 'harness';
        const text = await readResourceByKeyword(keyword);
        if (text) respondTool(message.id, text);
        else respondTool(message.id, 'Documentation not available.', true);
        return;
      }
      if (what === 'extension') {
        const result = await callUpstreamTool('read_full_docs', {
          extension_names: toCommaSeparated(args.names),
        });
        sendClient({ jsonrpc: '2.0', id: message.id, result: result.result });
        return;
      }
      if (what === 'search') {
        const result = await callUpstreamTool('search_docs', {
          query: args.query || '',
        });
        sendClient({ jsonrpc: '2.0', id: message.id, result: result.result });
        return;
      }
      if (what === 'javascript') {
        const result = await callUpstreamTool('read_javascript_reference', {
          names: toCommaSeparated(args.names),
        });
        sendClient({ jsonrpc: '2.0', id: message.id, result: result.result });
        return;
      }
      respondTool(
        message.id,
        `Unknown docs request: ${what}. Use event_script_guide, script_api, gameplay_guide, schema, extension, search or javascript.`,
        true
      );
    } catch (error) {
      respondTool(message.id, `docs failed: ${error.message}`, true);
    }
  };

  const handleGdevelop = (message) => {
    const args = (message.params && message.params.arguments) || {};
    const functionName = args.function_name;
    if (typeof functionName !== 'string' || !functionName) {
      respondTool(message.id, 'function_name is required.', true);
      return;
    }
    if (TOOLS_HANDLED_HERE.has(functionName)) {
      respondTool(
        message.id,
        `${functionName} is not an editor function. Use the ${functionName} tool directly.`,
        true
      );
      return;
    }
    const known =
      !upstreamTools ||
      upstreamTools.some((tool) => tool.name === functionName);
    if (!known) {
      respondTool(
        message.id,
        `Unknown function: ${functionName}. Call docs({what:"schema", name:"..."}) only with a name from the signature list.`,
        true
      );
      return;
    }
    const callArguments =
      args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
    transport.post({
      jsonrpc: '2.0',
      id: message.id,
      method: 'tools/call',
      params: { name: functionName, arguments: callArguments },
    });
  };

  const handleClientMessage = (message) => {
    const hasId = message.id !== undefined && message.id !== null;
    if (!hasId) {
      transport.post(message);
      return;
    }
    if (message.method === 'initialize') return handleInitialize(message);
    if (message.method === 'tools/list') return void handleToolsList(message);
    if (message.method === 'tools/call') {
      const name = message.params && message.params.name;
      if (name === 'gdevelop') return handleGdevelop(message);
      if (name === 'docs') return void handleDocs(message);
      if (PASSTHROUGH_TOOLS.includes(name)) return transport.post(message);
      return respondTool(message.id, `Unknown tool: ${name}.`, true);
    }
    transport.post(message);
  };

  const onUpstreamMessage = (message) => {
    if (internal.has(message.id)) {
      const { resolve, reject } = internal.get(message.id);
      internal.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message);
      return;
    }
    sendClient(message);
  };

  transport.onMessage(onUpstreamMessage);

  const clientInput = readline.createInterface({ input: process.stdin });
  clientInput.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      sendClient({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error.' },
      });
      return;
    }
    try {
      handleClientMessage(message);
    } catch (error) {
      log(`failed to handle ${message.method}: ${error.message}`);
      if (message.id !== undefined && message.id !== null) {
        respondTool(message.id, `funnel error: ${error.message}`, true);
      }
    }
  });
  clientInput.on('close', () => {
    if (closing) return;
    closing = true;
    transport.close();
    // Gives the DELETE of the session the time to be sent.
    setTimeout(() => process.exit(0), 300);
  });

  process.on('uncaughtException', (error) => {
    log(`unexpected error: ${error.stack || error.message}`);
  });
};

main();
