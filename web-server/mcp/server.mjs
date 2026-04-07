#!/usr/bin/env node
/**
 * mcp/server.mjs — AgentBoard MCP server (stdio transport)
 *
 * This process is launched by MCP-compatible clients (Claude Desktop,
 * Cursor, etc.) to expose AgentBoard as a set of tools the model can use.
 * The configuration in ~/.config/Claude/claude_desktop_config.json or
 * equivalent should look like:
 *
 *   {
 *     "mcpServers": {
 *       "agentboard": {
 *         "command": "node",
 *         "args": ["<repo>/web-server/mcp/server.mjs"],
 *         "env": {
 *           "AGENTBOARD_URL": "http://localhost:3456",
 *           "AGENTBOARD_TOKEN": "<optional bearer token>"
 *         }
 *       }
 *     }
 *   }
 *
 * Architecture note: this is a SUBPROCESS of the MCP client, not the
 * web-server. It talks to the web-server over HTTP. Splitting the MCP
 * server into its own package (mcp-server/) can happen later without
 * changing this file — it only imports from the MCP SDK and fetches
 * from AGENTBOARD_URL; nothing here depends on the web-server's internal
 * code. See NOTES.local.md for the "split later" plan.
 *
 * Tools exposed:
 *   - create_storyboard       create a project with boards in one call
 *   - get_project             read a project's full state
 *   - list_projects           list projects the user owns
 *   - add_board               append a board to a project
 *   - add_scene               batch-add boards (a "scene")
 *   - set_metadata            batch update dialogue/action/notes/duration
 *   - upload_image            upload a base64 PNG to a layer
 *   - upload_audio            upload base64 audio with kind (narration/sfx/...)
 *   - generate_panel          AI image generation (fal.ai, x402-gated)
 *   - list_image_styles       list available named visual style presets
 *   - generate_speech         AI text-to-speech (ElevenLabs, x402-gated)
 *   - generate_sound_effect   AI sound effect generation (ElevenLabs, x402-gated)
 *   - generate_music          AI music composition (ElevenLabs, x402-gated)
 *   - export_pdf              download the project as a PDF buffer
 *   - get_board_url           generate a shareable view URL
 *   - mint_share_token        create a time-limited share token
 *
 * All tools return text content describing the result. Binary tool
 * results (like export_pdf) are returned as base64 in the text body so
 * MCP clients can decode + save them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import * as path from 'path';

// Load .env alongside the MCP server file so running the server directly
// (without going through the web-server) still picks up AGENTBOARD_URL,
// AGENTBOARD_TOKEN, AGENTBOARD_X402_PAYMENT, etc from a file on disk.
// The MCP client's own `env` block always wins when set.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenvConfig({ path: path.join(__dirname, '..', '.env') });

const AGENTBOARD_URL = process.env.AGENTBOARD_URL || 'http://localhost:3456';
const AGENTBOARD_TOKEN = process.env.AGENTBOARD_TOKEN || null;
const X402_PAYMENT_HEADER = process.env.AGENTBOARD_X402_PAYMENT || null;

// ── HTTP helper ────────────────────────────────────────────────────────

async function apiRequest(method, path, body) {
  const url = new URL(path, AGENTBOARD_URL).toString();
  const headers = { 'Accept': 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (AGENTBOARD_TOKEN) headers['Authorization'] = `Bearer ${AGENTBOARD_TOKEN}`;
  if (X402_PAYMENT_HEADER) headers['X-Payment'] = X402_PAYMENT_HEADER;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get('content-type') || '';
  let payload;
  if (contentType.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else if (contentType.startsWith('application/pdf') || contentType.startsWith('application/octet-stream')) {
    const buf = Buffer.from(await res.arrayBuffer());
    payload = { _binary: true, mime: contentType, bytes: buf };
  } else {
    payload = await res.text();
  }

  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}`);
    err.status = res.status;
    err.body = payload;
    throw err;
  }
  return payload;
}

// ── tool result formatters ─────────────────────────────────────────────

function okText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorText(err) {
  const base = { ok: false };
  if (err.status) base.status = err.status;
  if (err.body) base.body = err.body;
  if (err.message) base.message = err.message;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(base, null, 2) }],
  };
}

// Wrap every tool impl with a standard try/catch so the MCP client sees
// clean errors instead of exceptions crashing the stdio pipe.
function handle(fn) {
  return async (args, _extra) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorText(err);
    }
  };
}

// ── MCP server setup ───────────────────────────────────────────────────

const server = new McpServer(
  {
    name: 'agentboard',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ── tool: create_storyboard ────────────────────────────────────────────
server.registerTool(
  'create_storyboard',
  {
    title: 'Create a new storyboard',
    description:
      'Create a new AgentBoard storyboard project with an optional list of boards. ' +
      'Returns the new project id and a shareable view URL. Use add_board or ' +
      'generate_panel afterwards to fill in content.',
    inputSchema: {
      title: z.string().optional().describe('Project title, shown in the viewer and PDF header'),
      aspectRatio: z.number().optional().describe('Aspect ratio width/height (default 1.7777 for 16:9)'),
      fps: z.number().optional().describe('Frames per second for time calculations'),
      defaultBoardTiming: z.number().optional().describe('Default duration per board in ms'),
      boards: z.array(z.object({
        dialogue: z.string().optional(),
        action: z.string().optional(),
        notes: z.string().optional(),
        duration: z.number().optional(),
        shot: z.string().optional(),
        newShot: z.boolean().optional(),
      })).optional().describe('Boards to pre-create'),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/create-project', args);
    return okText({
      projectId: result.id,
      boardCount: (result.project.boards || []).length,
      viewUrl: result.viewUrl,
      apiUrl: result.apiUrl,
    });
  })
);

// ── tool: get_project ──────────────────────────────────────────────────
server.registerTool(
  'get_project',
  {
    title: 'Read a project',
    description: 'Fetch the full state of a storyboard project by id, including all boards and their metadata.',
    inputSchema: {
      projectId: z.string().describe('UUID of the project'),
    },
  },
  handle(async ({ projectId }) => {
    const result = await apiRequest('GET', `/api/agent/project/${projectId}`);
    return okText({
      projectId: result.id,
      project: result.project,
      permission: result.permission,
      viewUrl: result.viewUrl,
    });
  })
);

// ── tool: list_projects ────────────────────────────────────────────────
server.registerTool(
  'list_projects',
  {
    title: 'List my projects',
    description: 'List all storyboard projects owned by the current agent.',
    inputSchema: {},
  },
  handle(async () => {
    const result = await apiRequest('GET', '/api/agent/projects');
    return okText(result);
  })
);

// ── tool: add_board ────────────────────────────────────────────────────
server.registerTool(
  'add_board',
  {
    title: 'Add a board',
    description: 'Append a single board to an existing project with optional dialogue/action/notes/duration.',
    inputSchema: {
      projectId: z.string(),
      dialogue: z.string().optional(),
      action: z.string().optional(),
      notes: z.string().optional(),
      duration: z.number().optional(),
      shot: z.string().optional(),
      newShot: z.boolean().optional(),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/add-board', args);
    return okText({ board: result.board });
  })
);

// ── tool: add_scene ────────────────────────────────────────────────────
server.registerTool(
  'add_scene',
  {
    title: 'Add a scene (batch add boards)',
    description: 'Append multiple boards to a project in one call. Useful for generating a whole sequence at once.',
    inputSchema: {
      projectId: z.string(),
      boards: z.array(z.object({
        dialogue: z.string().optional(),
        action: z.string().optional(),
        notes: z.string().optional(),
        duration: z.number().optional(),
        shot: z.string().optional(),
        newShot: z.boolean().optional(),
      })).describe('Array of boards to add'),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/add-scene', args);
    return okText({ boards: result.boards });
  })
);

// ── tool: set_metadata ─────────────────────────────────────────────────
server.registerTool(
  'set_metadata',
  {
    title: 'Batch-update board metadata',
    description:
      'Update dialogue/action/notes/duration/shot/newShot on one or more boards in one call. ' +
      'Each update can include expectedVersion for optimistic concurrency — if the current ' +
      'version differs, that entry lands in the conflicts[] array and the others still apply.',
    inputSchema: {
      projectId: z.string(),
      updates: z.array(z.object({
        boardUid: z.string(),
        expectedVersion: z.number().optional(),
        dialogue: z.string().optional(),
        action: z.string().optional(),
        notes: z.string().optional(),
        duration: z.number().optional(),
        shot: z.string().optional(),
        newShot: z.boolean().optional(),
      })),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/set-metadata', args);
    return okText({
      updatedBoards: result.boards,
      conflicts: result.conflicts || [],
    });
  })
);

// ── tool: upload_image ─────────────────────────────────────────────────
server.registerTool(
  'upload_image',
  {
    title: 'Upload an image to a board layer',
    description:
      'Upload a base64-encoded PNG/JPG to a specific layer of a board. ' +
      'Use this when you already have image bytes; use generate_panel to have ' +
      "the server generate new art via AI. Layers: 'fill', 'reference', 'ink', 'notes'.",
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      layer: z.string().describe('Layer name (fill, reference, ink, notes, ...)'),
      imageBase64: z.string().describe('Base64-encoded image bytes (data: prefix allowed)'),
      mime: z.string().optional().describe('image/png (default) or image/jpeg'),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/draw', args);
    return okText(result);
  })
);

// ── tool: upload_audio ─────────────────────────────────────────────────
server.registerTool(
  'upload_audio',
  {
    title: 'Upload audio to a board',
    description:
      "Attach an audio file to a board. Use kind to distinguish narration, sfx, music, ambient, or reference. " +
      "Accepts base64-encoded mp3/wav/ogg bytes. Use generate_speech for server-side TTS.",
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      kind: z.string().optional().describe('narration | sfx | music | ambient | reference (default narration)'),
      audioBase64: z.string(),
      mime: z.string().optional().describe('audio/mpeg (default), audio/wav, audio/ogg'),
      duration: z.number().optional().describe('Duration in ms, optional metadata'),
      voice: z.string().optional(),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/upload-audio', args);
    return okText(result);
  })
);

// ── tool: generate_panel ───────────────────────────────────────────────
server.registerTool(
  'generate_panel',
  {
    title: 'Generate a panel image with AI',
    description:
      'Generate an image for a board layer using AI (fal.ai). The server calls the ' +
      'image-gen provider, downloads the result, and stores it as the specified layer. ' +
      'Use the optional `style` parameter to pick a named aesthetic preset — ' +
      '"storyboard-sketch" produces classic black-and-white rough marker sketches ' +
      'with reference-image guidance (the preferred style for pre-production panels); ' +
      '"cinematic-color" produces painterly color concept art; "comic-panel" produces ' +
      'inked + cel-shaded comic-book style. Call list_image_styles to discover all ' +
      'available presets. This route is x402-gated in production: the MCP client must ' +
      'supply the X-Payment header via the AGENTBOARD_X402_PAYMENT env var.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      layer: z.string().optional().describe('Target layer (default fill)'),
      prompt: z.string().describe('Image generation prompt. When style is set, focus on content/action — the style preset handles the look.'),
      style: z.string().optional().describe(
        'Named style preset. "storyboard-sketch" for black-and-white rough sketches ' +
        '(uses reference images + Flux Kontext). "cinematic-color" for painterly concept art. ' +
        '"comic-panel" for inked comic style. Call list_image_styles to discover all options.'
      ),
      model: z.string().optional().describe(
        'Explicit model override. flux-schnell (fastest + cheapest), flux-dev, flux-pro, ' +
        'flux-pro-v1.1, flux-pro-ultra, flux-kontext-multi (reference-based), flux-2-pro, ' +
        'sdxl. When style is set, the style\'s preferred model is used unless this is set.'
      ),
      aspectRatio: z.number().optional(),
      seed: z.number().optional(),
      negativePrompt: z.string().optional(),
      steps: z.number().optional(),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/generate-image', args);
    return okText(result);
  })
);

// ── tool: list_image_styles ────────────────────────────────────────────
server.registerTool(
  'list_image_styles',
  {
    title: 'List available image style presets',
    description:
      'Return the list of named style presets available to generate_panel. Each ' +
      'entry includes the style name, title, description, preferred model, and ' +
      'whether it uses reference images. Call this before generate_panel if you\'re ' +
      'not sure which style to pick, or to surface options to a human user.',
    inputSchema: {},
  },
  handle(async () => {
    const result = await apiRequest('GET', '/api/agent/image-styles');
    return okText(result);
  })
);

// ── tool: generate_speech ──────────────────────────────────────────────
server.registerTool(
  'generate_speech',
  {
    title: 'Generate speech audio with AI',
    description:
      'Generate text-to-speech audio for a board using ElevenLabs. The server calls ' +
      'the TTS provider, downloads the audio, and stores it as an audio:<kind> asset on ' +
      'the target board. Use this for narration and dialogue. For non-speech audio ' +
      'use generate_sound_effect (one-shot SFX) or generate_music (musical pieces). ' +
      'x402-gated in production.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      kind: z.string().optional().describe('narration (default) | sfx | music | ...'),
      text: z.string(),
      voice: z.string().optional().describe('ElevenLabs voice id'),
      model: z.string().optional().describe('eleven_turbo_v2_5 (default), eleven_multilingual_v2, ...'),
      stability: z.number().optional(),
      similarityBoost: z.number().optional(),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/generate-speech', args);
    return okText(result);
  })
);

// ── tool: generate_sound_effect ────────────────────────────────────────
server.registerTool(
  'generate_sound_effect',
  {
    title: 'Generate a sound effect with AI',
    description:
      'Generate a one-shot sound effect for a board using ElevenLabs sound generation. ' +
      'Best for short prompts describing a discrete sound: "thunderclap", "footsteps on ' +
      'gravel", "metal door slam", "car engine starting". Stored as audio:sfx by default ' +
      '(or audio:ambient if kind=ambient). Duration is bounded 0.5-22 seconds. x402-gated ' +
      'in production. For dialogue/narration use generate_speech, for musical pieces use ' +
      'generate_music.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      prompt: z.string().describe('Short description of the sound, e.g. "distant thunder rumbling"'),
      durationSeconds: z.number().optional().describe('Length in seconds (0.5-22, default 5)'),
      promptInfluence: z.number().optional().describe('How strictly to follow the prompt (0-1, default provider choice)'),
      kind: z.string().optional().describe('sfx (default) | ambient'),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/generate-sfx', args);
    return okText(result);
  })
);

// ── tool: generate_music ───────────────────────────────────────────────
server.registerTool(
  'generate_music',
  {
    title: 'Generate music with AI',
    description:
      'Compose a piece of music for a board using ElevenLabs music compose. Best for ' +
      'descriptive prompts like "melancholic lo-fi piano with soft kick drum, 70 bpm" ' +
      'or "epic orchestral cue, building tension, strings and timpani". Stored as ' +
      'audio:music by default (or audio:ambient if kind=ambient). Length is bounded ' +
      '5-300 seconds. x402-gated in production. NOTE: requires beta access on ElevenLabs ' +
      'plan — if your account does not have it, the call returns PROVIDER_REJECTED and ' +
      'you should fall back to upload_audio with a pre-baked track.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      prompt: z.string().describe('Description of the desired music — instruments, mood, tempo, genre'),
      musicLengthMs: z.number().optional().describe('Length in milliseconds (5000-300000, default 30000)'),
      kind: z.string().optional().describe('music (default) | ambient'),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/generate-music', args);
    return okText(result);
  })
);

// ── tool: export_pdf ───────────────────────────────────────────────────
server.registerTool(
  'export_pdf',
  {
    title: 'Export project as PDF',
    description:
      'Generate a PDF with one page per board (composited image + dialogue/action/notes). ' +
      'Returns the PDF bytes base64-encoded so the MCP client can save them to disk. ' +
      'Also returns the download URL if you prefer to fetch it directly.',
    inputSchema: {
      projectId: z.string(),
    },
  },
  handle(async ({ projectId }) => {
    const result = await apiRequest('POST', '/api/agent/export/pdf', { projectId });
    if (result && result._binary) {
      const base64 = result.bytes.toString('base64');
      return okText({
        mime: result.mime,
        sizeBytes: result.bytes.length,
        downloadUrl: `${AGENTBOARD_URL}/api/agent/export/pdf/${projectId}`,
        bytesBase64: base64,
      });
    }
    return okText(result);
  })
);

// ── tool: get_board_url ────────────────────────────────────────────────
server.registerTool(
  'get_board_url',
  {
    title: 'Get the shareable view URL for a project',
    description: 'Return the public /view/:projectId URL and the underlying API URL for a project.',
    inputSchema: {
      projectId: z.string(),
    },
  },
  handle(async ({ projectId }) => {
    const result = await apiRequest('GET', `/api/agent/share/${projectId}`);
    return okText(result);
  })
);

// ── tool: mint_share_token ─────────────────────────────────────────────
server.registerTool(
  'mint_share_token',
  {
    title: 'Mint a time-limited share token',
    description:
      'Create a share token that can be embedded in a view URL to give view/comment/edit ' +
      'access to a project. Tokens are single-use-creation: the raw value is returned once ' +
      'and can never be shown again by this API.',
    inputSchema: {
      projectId: z.string(),
      permission: z.enum(['view', 'comment', 'edit']).optional().describe('Default view'),
      name: z.string().optional().describe('Human label, e.g. "client preview"'),
      ttlMs: z.number().optional().describe('Token lifetime in ms. Omit for no expiry.'),
    },
  },
  handle(async (args) => {
    const { projectId, ...body } = args;
    const result = await apiRequest('POST', `/api/agent/share/${projectId}`, body);
    return okText(result);
  })
);

// ── start the server ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Write a one-line "ready" log to stderr so MCP clients can see the
  // server started. stdout is reserved for the protocol stream.
  process.stderr.write(`[agentboard-mcp] ready, target=${AGENTBOARD_URL}\n`);
}

main().catch((err) => {
  process.stderr.write(`[agentboard-mcp] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
