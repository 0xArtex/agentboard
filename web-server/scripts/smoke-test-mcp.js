/**
 * Ephemeral smoke test for the MCP server.
 *
 * Spins up the web-server on an ephemeral port, spawns the MCP server as
 * a subprocess pointed at that port, and drives the MCP protocol over
 * stdio to invoke each tool and verify end-to-end plumbing.
 *
 * Covers:
 *   - MCP server launches and lists tools
 *   - create_storyboard, get_project, list_projects
 *   - add_board, add_scene, set_metadata
 *   - upload_image → verifies layer asset lands in the API
 *   - upload_audio → verifies audio asset lands
 *   - generate_panel (mock mode, no x402)
 *   - generate_speech (mock mode, no x402)
 *   - export_pdf → verifies bytesBase64 decodes to a valid PDF
 *   - get_board_url and mint_share_token
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

// ── ephemeral web-server ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mcp-'));
const dbPath = path.join(tmpDir, 'test.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).sort()) {
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
}

require.cache[require.resolve('../services/db')] = {
  id: require.resolve('../services/db'),
  filename: require.resolve('../services/db'),
  loaded: true,
  exports: { db, DB_PATH: dbPath },
};

delete process.env.FAL_KEY;
delete process.env.ELEVENLABS_KEY;
delete process.env.X402_ENABLED;
delete process.env.AGENT_AUTH_ENABLED;
delete process.env.RATE_LIMIT_ENABLED;

// Clear module caches
for (const m of [
  '../services/image-gen',
  '../services/tts',
  '../services/x402',
  '../services/pricing',
  '../middleware/x402-gate',
  '../middleware/rate-limit',
  '../middleware/agent-auth',
  '../routes/agent',
]) {
  delete require.cache[require.resolve(m)];
}

const express = require('express');
const { Server: SocketIO } = require('socket.io');
const { setupSocketHandler } = require('../services/socket-handler');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(require('../middleware/agent-auth').agentAuthMiddleware);
app.use('/api/agent', require('../routes/agent'));

const webServer = http.createServer(app);
const io = new SocketIO(webServer, { cors: { origin: '*' } });
app.locals.socketHandler = setupSocketHandler(io);

let fail = false;
function check(label, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) fail = true;
  console.log(`${mark}  ${label}${extra ? '  ' + extra : ''}`);
}

webServer.listen(0, async () => {
  const port = webServer.address().port;
  const agentboardUrl = `http://localhost:${port}`;

  // ── spawn the MCP server subprocess ──
  const mcpPath = path.join(__dirname, '..', 'mcp', 'server.mjs');
  const mcp = spawn(process.execPath, [mcpPath], {
    env: { ...process.env, AGENTBOARD_URL: agentboardUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // ── MCP protocol driver (minimal JSON-RPC over stdio) ──
  // MCP uses a length-delimited framing in some transports, but the stdio
  // transport used by the SDK sends line-delimited JSON-RPC. We just
  // buffer stdout and split on newlines.

  let stdoutBuffer = '';
  const pendingRequests = new Map();
  let requestId = 0;

  mcp.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let newlineIdx;
    while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const { resolve, reject } = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) {
        // Non-JSON line, ignore
      }
    }
  });

  let mcpStderr = '';
  mcp.stderr.on('data', (chunk) => {
    mcpStderr += chunk.toString('utf8');
  });

  mcp.on('error', (err) => {
    console.error('MCP process error:', err);
    process.exit(1);
  });

  // Wait a moment for the server to be ready
  await new Promise((r) => setTimeout(r, 500));

  function sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      mcp.stdin.write(msg + '\n');
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`timeout waiting for ${method} response`));
        }
      }, 10_000);
    });
  }

  async function callTool(name, args) {
    const result = await sendRequest('tools/call', { name, arguments: args });
    // Extract text content
    if (result && Array.isArray(result.content)) {
      const text = result.content.find(c => c.type === 'text');
      if (text) {
        try { return { parsed: JSON.parse(text.text), raw: result }; }
        catch (e) { return { parsed: null, raw: result, text: text.text }; }
      }
    }
    return { parsed: null, raw: result };
  }

  try {
    // ── initialize + list tools ──
    const initResult = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });
    check('1. initialize succeeded', initResult != null);
    check('1. serverInfo.name = agentboard',
      initResult && initResult.serverInfo && initResult.serverInfo.name === 'agentboard');

    // Send initialized notification
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise(r => setTimeout(r, 100));

    const toolsResult = await sendRequest('tools/list', {});
    check('2. tools/list returned tools', Array.isArray(toolsResult.tools));
    const toolNames = (toolsResult.tools || []).map(t => t.name);
    const expectedTools = [
      'create_storyboard', 'get_project', 'list_projects',
      'add_board', 'add_scene', 'set_metadata',
      'upload_image', 'upload_audio',
      'generate_panel', 'generate_speech',
      'export_pdf', 'get_board_url', 'mint_share_token',
    ];
    for (const t of expectedTools) {
      check(`2. tool '${t}' registered`, toolNames.includes(t));
    }

    // ── create_storyboard ──
    let r = await callTool('create_storyboard', {
      title: 'MCP Test Story',
      aspectRatio: 1.7777,
      boards: [
        { dialogue: 'first scene', action: 'enters', duration: 2500 },
        { dialogue: 'second scene', action: 'speaks', duration: 2000 },
      ],
    });
    check('3. create_storyboard text response',
      r.parsed && typeof r.parsed.projectId === 'string');
    check('3. create_storyboard boardCount = 2', r.parsed.boardCount === 2);
    check('3. create_storyboard returns viewUrl',
      typeof r.parsed.viewUrl === 'string');
    const projectId = r.parsed.projectId;

    // ── get_project ──
    r = await callTool('get_project', { projectId });
    check('4. get_project has project.boards',
      r.parsed && Array.isArray(r.parsed.project.boards));
    check('4. get_project permission = owner',
      r.parsed.permission === 'owner');
    const [b1, b2] = r.parsed.project.boards;

    // ── list_projects ──
    r = await callTool('list_projects', {});
    check('5. list_projects returns projects array',
      r.parsed && Array.isArray(r.parsed.projects) && r.parsed.projects.length >= 1);

    // ── add_board ──
    r = await callTool('add_board', {
      projectId, dialogue: 'third scene', duration: 1500,
    });
    check('6. add_board returns new board', r.parsed && r.parsed.board);
    check('6. new board number = 3', r.parsed.board.number === 3);

    // ── add_scene ──
    r = await callTool('add_scene', {
      projectId,
      boards: [
        { dialogue: 'epilogue A', shot: '2A' },
        { dialogue: 'epilogue B', shot: '2B' },
      ],
    });
    check('7. add_scene added 2 boards',
      r.parsed && Array.isArray(r.parsed.boards) && r.parsed.boards.length === 2);

    // ── set_metadata ──
    r = await callTool('set_metadata', {
      projectId,
      updates: [
        { boardUid: b1.uid, notes: 'important note A' },
        { boardUid: b2.uid, notes: 'important note B' },
      ],
    });
    check('8. set_metadata updated 2 boards',
      r.parsed && Array.isArray(r.parsed.updatedBoards) && r.parsed.updatedBoards.length === 2);
    check('8. set_metadata no conflicts',
      r.parsed.conflicts.length === 0);

    // ── upload_image ──
    const fakePng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000040000000408060000' +
      '00a9f1' +
      '9e7e0000000e4944415478da6300010000000500010d0a2db40000000049454e44ae426082',
      'hex'
    );
    r = await callTool('upload_image', {
      projectId, boardUid: b1.uid, layer: 'reference',
      imageBase64: fakePng.toString('base64'),
      mime: 'image/png',
    });
    check('9. upload_image returns hash',
      r.parsed && typeof r.parsed.hash === 'string' && r.parsed.hash.length === 64);
    check('9. upload_image kind = layer:reference',
      r.parsed.kind === 'layer:reference');

    // ── upload_audio ──
    const fakeAudio = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000', 'binary');
    r = await callTool('upload_audio', {
      projectId, boardUid: b1.uid, kind: 'sfx',
      audioBase64: fakeAudio.toString('base64'),
      mime: 'audio/mpeg',
      duration: 500,
    });
    check('10. upload_audio returns hash',
      r.parsed && typeof r.parsed.hash === 'string');
    check('10. upload_audio kind = audio:sfx', r.parsed.kind === 'audio:sfx');

    // ── generate_panel (mock mode, no x402) ──
    r = await callTool('generate_panel', {
      projectId, boardUid: b2.uid, layer: 'fill',
      prompt: 'opening shot of a lighthouse at dusk',
    });
    check('11. generate_panel returns hash',
      r.parsed && typeof r.parsed.hash === 'string');
    check('11. generate_panel provider = mock',
      r.parsed.provider === 'mock');

    // ── generate_speech ──
    r = await callTool('generate_speech', {
      projectId, boardUid: b2.uid, kind: 'narration',
      text: 'The lighthouse stood alone against the storm.',
    });
    check('12. generate_speech returns hash',
      r.parsed && typeof r.parsed.hash === 'string');
    check('12. generate_speech kind = audio:narration',
      r.parsed.kind === 'audio:narration');

    // ── export_pdf ──
    r = await callTool('export_pdf', { projectId });
    check('13. export_pdf returns bytesBase64',
      r.parsed && typeof r.parsed.bytesBase64 === 'string' && r.parsed.bytesBase64.length > 100);
    check('13. export_pdf mime = application/pdf',
      r.parsed && /application\/pdf/.test(r.parsed.mime || ''));
    // Decode the base64 and verify PDF magic bytes
    if (r.parsed && r.parsed.bytesBase64) {
      const pdfBytes = Buffer.from(r.parsed.bytesBase64, 'base64');
      check('13. decoded PDF starts with %PDF',
        pdfBytes.slice(0, 4).toString() === '%PDF');
      check('13. decoded PDF ends with %%EOF',
        pdfBytes.slice(-6).toString().includes('%%EOF'));
    }

    // ── get_board_url ──
    r = await callTool('get_board_url', { projectId });
    check('14. get_board_url returns viewUrl',
      r.parsed && typeof r.parsed.viewUrl === 'string');

    // ── mint_share_token ──
    r = await callTool('mint_share_token', {
      projectId, permission: 'view', name: 'mcp-test',
    });
    check('15. mint_share_token returns token',
      r.parsed && typeof r.parsed.token === 'string');
    check('15. mint_share_token returns viewUrl with token',
      r.parsed && r.parsed.viewUrl && r.parsed.viewUrl.includes('?t='));
    check('15. mint_share_token permission = view',
      r.parsed && r.parsed.permission === 'view');

    // ── verify error handling ──
    r = await callTool('get_project', {
      projectId: '00000000-0000-0000-0000-000000000999',
    });
    check('16. get_project nonexistent returns isError',
      r.raw && r.raw.isError === true);

  } catch (e) {
    console.error('EXCEPTION:', e);
    if (mcpStderr) console.error('MCP stderr:', mcpStderr);
    fail = true;
  } finally {
    mcp.kill();
    webServer.close();
    await new Promise(r => setTimeout(r, 100));
    console.log();
    console.log(fail ? 'FAILED' : 'OK — all checks passed');
    process.exit(fail ? 1 : 0);
  }
});
