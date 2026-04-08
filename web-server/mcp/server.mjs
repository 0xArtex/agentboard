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
 *   - upload_image            upload an image (path/url/base64) to a layer
 *   - upload_audio            upload audio (path/url/base64) with kind
 *   - upload_assets_batch     PREFERRED: many uploads in one call
 *   - generate_panel          AI image generation (fal.ai, x402-gated)
 *   - list_image_styles       list available named visual style presets
 *   - list_voices             list available TTS voices on the user's account
 *   - generate_speech         AI text-to-speech (ElevenLabs, x402-gated)
 *   - generate_sound_effect   AI sound effect generation (ElevenLabs, x402-gated)
 *   - generate_music          AI music composition (ElevenLabs, x402-gated)
 *   - draw_shapes             rasterize geometric shapes onto a board layer (free)
 *   - draw_strokes            rasterize brush strokes onto a board layer (free)
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
import * as fs from 'fs';
import * as net from 'net';

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

// ── bytes loader (context-free upload) ────────────────────────────────
//
// The core problem: MCP tool arguments travel through the agent's context
// window. If an agent has to pass 2 MB of base64 inline, it chews through
// token budget in a single call. This helper lets tools accept three
// input modes so the bytes NEVER touch the agent context unless they're
// tiny:
//
//   imageBase64 / audioBase64 — inline, small only (under ~10 KB)
//   imagePath   / audioPath   — file path the MCP subprocess reads
//   imageUrl    / audioUrl    — URL the MCP subprocess fetches
//
// The MCP server runs on the same machine as the agent (it's spawned as
// a subprocess), so path-based reads don't grant any capability the
// agent didn't already have — they just keep bytes out of the LLM's
// context window.
//
// URL fetching has basic SSRF guards: http/https only, private-IP block,
// hard size + time limits. This is best-effort — the primary use case is
// agents fetching their own fal CDN URLs, not internal network probes.

// 256 MB matches the REST-side image cap in routes/agent.js so the
// MCP-fetched bytes can always make it through the upload route.
const MAX_FETCH_BYTES = 256 * 1024 * 1024;
// Generous timeout so high-latency CDN downloads of huge images don't
// abort prematurely.
const FETCH_TIMEOUT_MS = 120_000;

function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0') return true;
  if (h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // Numeric IPs — check against RFC1918 / loopback / link-local ranges.
  if (net.isIP(h)) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;                           // 10/8
    if (parts[0] === 127) return true;                          // 127/8 loopback
    if (parts[0] === 169 && parts[1] === 254) return true;      // link-local
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16/12
    if (parts[0] === 192 && parts[1] === 168) return true;      // 192.168/16
    if (h.startsWith('::') || h.startsWith('fc') || h.startsWith('fd') || h === '::1') return true;
  }
  return false;
}

async function readLocalFile(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`path not readable: ${abs}`);
  }
  if (stat.size > MAX_FETCH_BYTES) {
    throw new Error(`file too large: ${stat.size} bytes (max ${MAX_FETCH_BYTES})`);
  }
  return await fs.promises.readFile(abs);
}

async function fetchUrlBytes(urlStr) {
  let u;
  try { u = new URL(urlStr); }
  catch { throw new Error(`invalid URL: ${urlStr}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`only http/https URLs are allowed, got ${u.protocol}`);
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`refusing to fetch from private/loopback host: ${u.hostname}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(urlStr, { signal: controller.signal });
    if (!res.ok) throw new Error(`fetch ${urlStr} → ${res.status}`);
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_FETCH_BYTES) {
      throw new Error(`remote file too large: ${contentLength} bytes (max ${MAX_FETCH_BYTES})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) {
      throw new Error(`remote file too large: ${buf.length} bytes (max ${MAX_FETCH_BYTES})`);
    }
    return { bytes: buf, contentType: res.headers.get('content-type') || null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize whatever input shape the agent passed into { base64, mime }.
 * Accepts exactly one of base64 / path / url per call.
 *
 *   loadBytesForTool({ base64, path, url, defaultMime })
 *     → { base64: '<base64>', mime: 'image/png' }
 */
async function loadBytesForTool({ base64, path: filePath, url, defaultMime }) {
  const provided = [base64, filePath, url].filter(v => v != null && v !== '').length;
  if (provided === 0) {
    throw new Error('must provide exactly one of base64 / path / url');
  }
  if (provided > 1) {
    throw new Error('provide only one of base64 / path / url — not multiple');
  }

  if (base64) {
    // Strip data URL prefix if present. Caller-supplied mime wins.
    const stripped = String(base64).replace(/^data:([^;]+);base64,/, (_m, m) => {
      if (!defaultMime) defaultMime = m;
      return '';
    });
    return { base64: stripped, mime: defaultMime || null };
  }

  if (filePath) {
    const bytes = await readLocalFile(filePath);
    return { base64: bytes.toString('base64'), mime: defaultMime || null };
  }

  if (url) {
    const { bytes, contentType } = await fetchUrlBytes(url);
    return { base64: bytes.toString('base64'), mime: contentType || defaultMime || null };
  }
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
      'generate_panel afterwards to fill in content. ' +
      'Pass `quality` to set a project-level image quality tier: "low" (draft, ' +
      'fastest/cheapest via z-image-turbo), "medium" (balanced, flux-2-pro — the ' +
      'default when not set), or "high" (final-render via seedream-v5-lite). ' +
      'Every subsequent generate_panel call on this project uses that tier unless ' +
      'the caller passes its own `quality` or explicit `model`.',
    inputSchema: {
      title: z.string().optional().describe('Project title, shown in the viewer and PDF header'),
      aspectRatio: z.coerce.number().optional().describe('Aspect ratio width/height (default 1.7777 for 16:9)'),
      fps: z.coerce.number().optional().describe('Frames per second for time calculations'),
      defaultBoardTiming: z.coerce.number().optional().describe('Default duration per board in ms'),
      quality: z.enum(['low', 'medium', 'high']).optional().describe(
        'Project-level image quality tier. low=z-image-turbo (draft, cheapest), ' +
        'medium=flux-2-pro (balanced, default when unset), high=seedream-v5-lite (final render).'
      ),
      boards: z.array(z.object({
        dialogue: z.string().optional(),
        action: z.string().optional(),
        notes: z.string().optional(),
        duration: z.coerce.number().optional(),
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
      duration: z.coerce.number().optional(),
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
        duration: z.coerce.number().optional(),
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
        expectedVersion: z.coerce.number().optional(),
        dialogue: z.string().optional(),
        action: z.string().optional(),
        notes: z.string().optional(),
        duration: z.coerce.number().optional(),
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
      'PREFERRED image path. Attach an image to a specific layer of a board. ' +
      'If your runtime has built-in image generation (fal, Sora, Veo, Midjourney, ' +
      'Gemini, etc.), generate the image with your own tool and upload it here — ' +
      'cheaper, faster, and you control the model. Only fall back to generate_panel ' +
      'if you have NO image generation of your own. Pass EXACTLY ONE of imagePath ' +
      '(local file — BEST for agent workflows, zero context cost), imageUrl (remote ' +
      'URL the server fetches — great for fal CDN links), or imageBase64 (inline ' +
      'bytes — use only for tiny images, bloats agent context). ' +
      "Layers: 'fill' (most common), 'reference', 'ink', 'notes', 'pencil', 'tone'.",
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      layer: z.string().describe('Layer name (fill, reference, ink, notes, ...)'),
      imagePath: z.string().optional().describe('Local file path the MCP subprocess reads. Preferred for any image over ~10 KB — zero agent context cost.'),
      imageUrl: z.string().optional().describe('http/https URL the MCP subprocess fetches (e.g. a fal CDN link). http-only, blocks private IPs, 25 MB cap.'),
      imageBase64: z.string().optional().describe('Inline base64 bytes. Use only for small images — every byte burns agent context.'),
      mime: z.string().optional().describe('image/png (default) or image/jpeg. Inferred from URL/file extension when possible.'),
    },
  },
  handle(async (args) => {
    const { projectId, boardUid, layer, mime } = args;
    const { base64, mime: detectedMime } = await loadBytesForTool({
      base64: args.imageBase64,
      path: args.imagePath,
      url: args.imageUrl,
      defaultMime: mime || null,
    });
    const result = await apiRequest('POST', '/api/agent/draw', {
      projectId, boardUid, layer,
      imageBase64: base64,
      mime: mime || detectedMime || 'image/png',
    });
    return okText(result);
  })
);

// ── tool: upload_assets_batch ──────────────────────────────────────────
server.registerTool(
  'upload_assets_batch',
  {
    title: 'Upload many images and/or audio clips in one call',
    description:
      'BATCH upload — populate multiple boards in a single tool call. Massively ' +
      'reduces round-trips when an agent has 5/10/50 panels to fill. Each item ' +
      'in the `uploads` array is an independent upload spec; partial failures are ' +
      'reported per-item via the `failed` array, the whole call never aborts on ' +
      'one bad item. Each item can use imagePath/imageUrl/imageBase64 for images ' +
      'or audioPath/audioUrl/audioBase64 for audio — same context-cost rules as ' +
      'single uploads (path > url > base64). Up to 100 items per call. Use this ' +
      'as the DEFAULT path for any storyboard with 3+ panels.',
    inputSchema: {
      projectId: z.string(),
      uploads: z.array(z.object({
        boardUid: z.string(),
        kind: z.enum(['image', 'audio']).optional().describe('Item type (default "image")'),
        // image fields
        layer: z.string().optional().describe('Image layer (default "fill")'),
        imagePath: z.string().optional().describe('Local file path the MCP subprocess reads (preferred for any non-tiny image)'),
        imageUrl: z.string().optional().describe('Remote URL the MCP subprocess fetches'),
        imageBase64: z.string().optional().describe('Inline base64. Only for very small images.'),
        // audio fields
        audioKind: z.string().optional().describe('Audio sub-kind: narration | sfx | music | ambient | reference (default narration)'),
        audioPath: z.string().optional().describe('Local file path for audio'),
        audioUrl: z.string().optional().describe('Remote audio URL'),
        audioBase64: z.string().optional().describe('Inline base64 audio'),
        // common
        mime: z.string().optional().describe('Override mime type. Server still verifies via magic bytes.'),
        duration: z.coerce.number().optional().describe('Audio duration in ms (metadata only)'),
        voice: z.string().optional(),
      })).describe('Array of upload specs, processed independently. Up to 100 per call.'),
    },
  },
  handle(async (args) => {
    const { projectId, uploads } = args;
    if (!Array.isArray(uploads) || uploads.length === 0) {
      throw new Error('uploads must be a non-empty array');
    }
    // Resolve each item's bytes before posting to the REST batch endpoint.
    // We do this in series so we don't blow memory holding 100 huge files
    // at once — most agents will batch 5-20 items, which is fine.
    const resolved = [];
    for (let i = 0; i < uploads.length; i++) {
      const u = uploads[i];
      const itemKind = u.kind === 'audio' ? 'audio' : 'image';
      try {
        if (itemKind === 'image') {
          const { base64, mime } = await loadBytesForTool({
            base64: u.imageBase64,
            path: u.imagePath,
            url: u.imageUrl,
            defaultMime: u.mime || null,
          });
          resolved.push({
            kind: 'image',
            boardUid: u.boardUid,
            layer: u.layer || 'fill',
            imageBase64: base64,
            mime: u.mime || mime || 'image/png',
          });
        } else {
          const { base64, mime } = await loadBytesForTool({
            base64: u.audioBase64,
            path: u.audioPath,
            url: u.audioUrl,
            defaultMime: u.mime || null,
          });
          resolved.push({
            kind: 'audio',
            boardUid: u.boardUid,
            audioKind: u.audioKind || 'narration',
            audioBase64: base64,
            mime: u.mime || mime || 'audio/mpeg',
            duration: u.duration,
            voice: u.voice,
          });
        }
      } catch (e) {
        // Resolution failed (bad path, bad URL, missing bytes). Pass a
        // sentinel item that the REST endpoint will surface as a per-item
        // failure rather than aborting the whole batch.
        resolved.push({
          kind: itemKind,
          boardUid: u.boardUid,
          // Intentionally missing imageBase64/audioBase64 → REST will
          // record this as a per-item BAD_REQUEST failure with the
          // resolution error message in the response.
          _resolutionError: e.message,
        });
      }
    }
    const result = await apiRequest('POST', '/api/agent/upload-batch', { projectId, uploads: resolved });
    return okText(result);
  })
);

// ── tool: upload_audio ─────────────────────────────────────────────────
server.registerTool(
  'upload_audio',
  {
    title: 'Upload audio to a board',
    description:
      'PREFERRED audio path. Attach an audio file to a board. If your runtime has ' +
      'built-in TTS or audio generation, produce the audio with your own tool and ' +
      'upload it here. Only fall back to generate_speech/generate_sound_effect/' +
      'generate_music if you have NO audio generation of your own. Pass EXACTLY ONE ' +
      'of audioPath (local file — BEST, zero context cost), audioUrl (remote URL the ' +
      'server fetches), or audioBase64 (inline bytes — use only for very short clips).',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      kind: z.string().optional().describe('narration | sfx | music | ambient | reference (default narration)'),
      audioPath: z.string().optional().describe('Local file path the MCP subprocess reads. Preferred for any audio — zero agent context cost.'),
      audioUrl: z.string().optional().describe('http/https URL the MCP subprocess fetches. http-only, blocks private IPs, 25 MB cap.'),
      audioBase64: z.string().optional().describe('Inline base64 bytes. Use only for very short clips — burns agent context.'),
      mime: z.string().optional().describe('audio/mpeg (default), audio/wav, audio/ogg'),
      duration: z.coerce.number().optional().describe('Duration in ms, optional metadata'),
      voice: z.string().optional(),
    },
  },
  handle(async (args) => {
    const { projectId, boardUid, kind, mime, duration, voice } = args;
    const { base64, mime: detectedMime } = await loadBytesForTool({
      base64: args.audioBase64,
      path: args.audioPath,
      url: args.audioUrl,
      defaultMime: mime || null,
    });
    const result = await apiRequest('POST', '/api/agent/upload-audio', {
      projectId, boardUid, kind, duration, voice,
      audioBase64: base64,
      mime: mime || detectedMime || 'audio/mpeg',
    });
    return okText(result);
  })
);

// ── tool: generate_panel ───────────────────────────────────────────────
server.registerTool(
  'generate_panel',
  {
    title: 'Generate a panel image with AI (fallback)',
    description:
      'FALLBACK tool. Only use this if your runtime does NOT have its own image ' +
      'generation (fal, Sora, Veo, Midjourney, Gemini, etc.). If you already have ' +
      'an image generator, use upload_image instead — it\'s cheaper, faster, and ' +
      'avoids server-side API key dependencies. This tool calls fal.ai on the ' +
      'server\'s behalf, which requires FAL_KEY to be configured and is x402-gated ' +
      'in production. Style presets: "storyboard-sketch" (B&W sketches w/ refs), ' +
      '"cinematic-color", "comic-panel". Call list_image_styles to discover all.',
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
        'Explicit model override. Wins over style and quality. ' +
        'Known: z-image-turbo (cheapest draft), flux-schnell (fast+cheap), flux-dev, ' +
        'flux-pro, flux-pro-v1.1, flux-pro-ultra, flux-kontext-multi (reference-based), ' +
        'flux-2-pro (balanced default), seedream-v5-lite (top quality), sdxl. ' +
        'When style is set, the style\'s preferred model is used unless this is explicitly overridden.'
      ),
      quality: z.enum(['low', 'medium', 'high']).optional().describe(
        'Per-call quality tier override. Resolves to a concrete model: low→z-image-turbo ' +
        '(draft), medium→flux-2-pro (balanced), high→seedream-v5-lite (final). ' +
        'Use "low" for fast draft iteration and "high" for final renders. If unset, ' +
        'falls back to the project-level quality that was set at create_storyboard time.'
      ),
      aspectRatio: z.coerce.number().optional(),
      seed: z.coerce.number().optional(),
      negativePrompt: z.string().optional(),
      steps: z.coerce.number().optional(),
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

// ── tool: list_voices ──────────────────────────────────────────────────
server.registerTool(
  'list_voices',
  {
    title: 'List available TTS voices',
    description:
      'Return the list of voices accessible on the configured ElevenLabs account, ' +
      'with each voice\'s id, display name, category (premade/cloned/generated/professional), ' +
      'and an isOwned flag. Call this BEFORE generate_speech if you\'re unsure which voice ' +
      'id to pass — picking a library-locked voice on a free plan returns PROVIDER_REJECTED. ' +
      'On the mock provider this returns a small set of fake voices for testing.',
    inputSchema: {},
  },
  handle(async () => {
    const result = await apiRequest('GET', '/api/agent/voices');
    return okText(result);
  })
);

// ── tool: generate_speech ──────────────────────────────────────────────
server.registerTool(
  'generate_speech',
  {
    title: 'Generate speech audio with AI (fallback)',
    description:
      'FALLBACK tool. Only use this if your runtime does NOT have its own TTS. If ' +
      'you already have a TTS tool, use upload_audio with kind:"narration" instead — ' +
      'cheaper, avoids server-side API key dependencies, avoids ElevenLabs free-tier ' +
      'voice restrictions. This tool calls ElevenLabs on the server\'s behalf, requires ' +
      'ELEVENLABS_KEY, and is x402-gated in production. For non-speech audio use ' +
      'generate_sound_effect or generate_music (also fallback tools).',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      kind: z.string().optional().describe('narration (default) | sfx | music | ...'),
      text: z.string(),
      voice: z.string().optional().describe('ElevenLabs voice id'),
      model: z.string().optional().describe('eleven_turbo_v2_5 (default), eleven_multilingual_v2, ...'),
      stability: z.coerce.number().optional(),
      similarityBoost: z.coerce.number().optional(),
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
    title: 'Generate a sound effect with AI (fallback)',
    description:
      'FALLBACK tool. Only use this if your runtime does NOT have its own audio ' +
      'generation. If you can produce SFX yourself, use upload_audio with kind:"sfx" ' +
      'instead. This tool calls ElevenLabs sound-generation, requires ELEVENLABS_KEY, ' +
      'and is x402-gated. Best for short prompts: "thunderclap", "footsteps on gravel", ' +
      '"metal door slam". Duration 0.5-22 seconds.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      prompt: z.string().describe('Short description of the sound, e.g. "distant thunder rumbling"'),
      durationSeconds: z.coerce.number().optional().describe('Length in seconds (0.5-22, default 5)'),
      promptInfluence: z.coerce.number().optional().describe('How strictly to follow the prompt (0-1, default provider choice)'),
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
    title: 'Generate music with AI (fallback)',
    description:
      'FALLBACK tool. Only use this if your runtime does NOT have its own music ' +
      'generation. If you can produce music yourself, use upload_audio with ' +
      'kind:"music" instead. This tool calls ElevenLabs /v1/music, requires ' +
      'ELEVENLABS_KEY, and is x402-gated. Best for descriptive prompts: ' +
      '"melancholic lo-fi piano, 70 bpm". Length 3-600 seconds. Pass ' +
      'forceInstrumental:true to guarantee no vocals.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      prompt: z.string().describe('Description of the desired music — instruments, mood, tempo, genre (≤4100 chars)'),
      musicLengthMs: z.coerce.number().optional().describe('Length in milliseconds (3000-600000, default 30000)'),
      modelId: z.string().optional().describe('ElevenLabs music model (default "music_v1")'),
      forceInstrumental: z.boolean().optional().describe('If true, guarantees no vocals'),
      kind: z.string().optional().describe('music (default) | ambient'),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/generate-music', args);
    return okText(result);
  })
);

// ── tool: draw_shapes ──────────────────────────────────────────────────
server.registerTool(
  'draw_shapes',
  {
    title: 'Draw geometric shapes onto a board layer',
    description:
      'Rasterize an array of high-level shapes (line, circle, rect, arrow, text, ' +
      'polyline, polygon, bezier) onto a board layer. This is the right tool for ' +
      'annotating an AI-generated panel — circling characters, adding directional ' +
      'arrows for camera/character motion, drawing callout labels, framing marks, ' +
      'composition guides — or for sketching simple layouts from primitives. ' +
      'Coordinates are normalized [0,1]: (0,0) is top-left, (1,1) is bottom-right. ' +
      'Use mode="overlay" to composite on top of an existing layer (most common when ' +
      'annotating an AI image), or mode="replace" to start from a blank canvas. ' +
      'FREE — runs server-side via @napi-rs/canvas, no AI inference and no x402.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      layer: z.string().optional().describe('Target layer (default "fill"). Other layers: tone, pencil, ink, notes, reference.'),
      mode: z.enum(['overlay', 'replace']).optional().describe('overlay = draw on top of existing layer. replace = start fresh. Default replace.'),
      shapes: z.array(z.object({
        type: z.enum(['line', 'circle', 'rect', 'arrow', 'text', 'polyline', 'polygon', 'bezier']),
      }).passthrough()).describe(
        'Array of shape descriptors. Each shape needs a "type" plus geometry. ' +
        'Examples: ' +
        '{type:"circle",center:[0.5,0.5],radius:0.1,stroke:"red",strokeWidth:6} | ' +
        '{type:"arrow",from:[0.1,0.5],to:[0.9,0.5],stroke:"#0066cc",strokeWidth:8} | ' +
        '{type:"text",position:[0.5,0.05],text:"WIDE SHOT",fontSize:0.05,fill:"black",align:"center"} | ' +
        '{type:"rect",topLeft:[0.1,0.2],size:[0.8,0.6],stroke:"black",strokeWidth:4} | ' +
        '{type:"polyline",points:[[0.1,0.5],[0.3,0.4],[0.5,0.5]],stroke:"black",strokeWidth:5}'
      ),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/draw-shapes', args);
    return okText(result);
  })
);

// ── tool: draw_strokes ─────────────────────────────────────────────────
server.registerTool(
  'draw_strokes',
  {
    title: 'Draw brush strokes onto a board layer',
    description:
      'Rasterize an array of brush strokes onto a board layer. Use this when ' +
      'draw_shapes does not give enough control — for sketch-style freeform marks, ' +
      'expressive lines, or erasing parts of an existing layer. Each stroke is a ' +
      'list of [x,y] points which the engine smooths into a clean curve via ' +
      'Catmull-Rom interpolation, so even sparse point arrays look hand-drawn. ' +
      'Brushes: pencil (soft, slightly translucent), pen (clean opaque line), ' +
      'ink (heavy bold line), marker (translucent multiply blend), eraser (removes ' +
      'pixels — pair with mode="overlay" to erase parts of an existing image). ' +
      'Coordinates are normalized [0,1]. FREE — no AI, no x402.',
    inputSchema: {
      projectId: z.string(),
      boardUid: z.string(),
      layer: z.string().optional().describe('Target layer (default "fill")'),
      mode: z.enum(['overlay', 'replace']).optional().describe('overlay = on top of existing. replace = blank canvas. Default replace.'),
      strokes: z.array(z.object({
        brush: z.enum(['pencil', 'pen', 'ink', 'marker', 'eraser']).optional(),
        color: z.string().optional().describe('CSS color (default per brush)'),
        size: z.coerce.number().optional().describe('Brush size in pixels (default per brush, max 200)'),
        opacity: z.coerce.number().optional().describe('0-1 (default per brush)'),
        points: z.array(z.array(z.coerce.number())).describe('Array of [x,y] points in [0,1] coordinates'),
      })).describe(
        'Array of strokes. Example: ' +
        '[{brush:"pencil",color:"#222",size:5,points:[[0.1,0.5],[0.3,0.4],[0.5,0.5],[0.7,0.6],[0.9,0.5]]}, ' +
        '{brush:"eraser",size:30,points:[[0.4,0.4],[0.5,0.5]]}]'
      ),
    },
  },
  handle(async (args) => {
    const result = await apiRequest('POST', '/api/agent/draw-strokes', args);
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
      ttlMs: z.coerce.number().optional().describe('Token lifetime in ms. Omit for no expiry.'),
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
