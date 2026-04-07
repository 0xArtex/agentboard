---
name: agentboard
description: Create, edit, and share AI-generated storyboards via the AgentBoard system. Invoke when the user wants to build a storyboard, visual story, comic-style panel sequence, shot-by-shot breakdown, pre-visualization, illustrated narrative, animatic, or wants to generate panels with AI art plus voiceover. Uses the AgentBoard MCP server (tools with names like create_storyboard, generate_panel, upload_image, upload_audio, generate_speech, export_pdf, mint_share_token) OR the REST API at the configured AGENTBOARD_URL (default http://localhost:3456). Works even in mock mode without any API keys — agents can test entire workflows locally.
---

# AgentBoard skill

AgentBoard is a multi-agent storyboard workspace. You can create projects,
fill them with AI-generated images and narration, attach dialogue and
action metadata, export them as PDFs, and return shareable URLs to humans —
all over a structured API.

## Two ways to talk to AgentBoard

**MCP tools (preferred).** If you're running in Claude Code, Claude
Desktop, Cursor, or another MCP-compatible runtime AND the AgentBoard MCP
server has been configured, you'll see these tools in your tool list and
can invoke them directly:

- `create_storyboard`
- `get_project`, `list_projects`
- `add_board`, `add_scene`, `set_metadata`
- `upload_image`, `upload_audio`
- `generate_panel` (AI image gen)
- `generate_speech` (AI TTS)
- `export_pdf`
- `get_board_url`, `mint_share_token`

**REST API.** If you don't have MCP tools available, call the HTTP routes
directly at `AGENTBOARD_URL` (default `http://localhost:3456`):

- `POST /api/agent/create-project` — same shape as `create_storyboard`
- `POST /api/agent/generate-image`, `/generate-speech`
- `POST /api/agent/draw`, `/upload-audio`
- `POST /api/agent/export/pdf`
- `GET /api/agent/project/:id`, `/projects`, `/share/:id`

Both paths pass through the same auth, permissions, and payment layers.
Request/response shapes are identical.

## Core data model

- **Project** — one storyboard. UUID id, aspect ratio, fps, ordered list
  of boards. An agent can create unlimited projects.
- **Board** — one panel. Has a number (1-indexed), shot label, duration,
  three text fields (`dialogue`, `action`, `notes`), a `newShot` flag,
  a monotonic `version` for optimistic concurrency, layers, and audio.
- **Layers** (visual, composited bottom→top): `fill`, `tone`, `pencil`,
  `ink`, `reference`, `notes`. For most agent use cases, upload a single
  full image to `fill` and ignore the others.
- **Audio assets** (kind-keyed): `audio:narration` (voiceover),
  `audio:sfx`, `audio:music`, `audio:ambient`, `audio:reference`. One
  board can have multiple audio kinds simultaneously.
- **Version** — every board has a monotonic version. Metadata edits
  bump it. Asset uploads do NOT bump it. Use `expectedVersion` in
  updates for collaborative safety.

## Workflow: build a storyboard from scratch with AI art

This is the most common agent use case. Typical flow:

```
1. create_storyboard({
     title,
     aspectRatio: 1.7777,
     boards: [
       { dialogue, action },       // each board is 1 scene beat
       { dialogue, action },
       ...
     ]
   })
   → returns { projectId, viewUrl, apiUrl, boardCount, project: { boards: [...] } }

2. For each board (in parallel if your runtime allows):
     generate_panel({
       projectId, boardUid,
       layer: "fill",
       prompt: "<detailed visual description>",
       model: "flux-schnell"   // fastest + cheapest
     })
   → stores generated image as the board's fill layer

3. (optional) For each board with dialogue:
     generate_speech({
       projectId, boardUid,
       kind: "narration",
       text: board.dialogue
     })
   → stores narration as an audio:narration asset

4. get_board_url({ projectId })
   → { viewUrl }    ← give this to the human for browser viewing

5. (optional) export_pdf({ projectId })
   → returns base64-encoded PDF bytes + downloadUrl
```

Five tool calls per board at worst. A 5-panel storyboard with images
and narration is ~15 MCP calls total.

## Prompt crafting for generate_panel

Quality of AI-generated panels depends almost entirely on prompt quality.
Don't just echo the user's description — translate it into visual direction:

- **Bad**: "a lighthouse"
- **Good**: "a lonely stone lighthouse at dusk, dramatic chiaroscuro
  lighting, storm-tossed sea in the foreground, cinematic oil painting
  style, wide-angle composition"

Include framing (wide / medium / close-up), lighting (hard / soft,
direction, time of day), style (realistic, oil painting, watercolor,
anime, noir, cinematic), mood (tense, melancholic, hopeful), and
composition hints (foreground/background, rule of thirds, low angle).

Use `negativePrompt` to exclude common failures: "blurry, low detail,
extra fingers, deformed hands, text, watermark".

Pass an explicit `seed` if you want reproducibility across calls.

## Workflow: collaboratively edit an existing project

When multiple agents work on the same project, use optimistic
concurrency:

```
1. get_project({ projectId })
   → read each board's `version` field

2. set_metadata({
     projectId,
     updates: [
       { boardUid: "ABC", dialogue: "new line", expectedVersion: 4 },
       ...
     ]
   })

3. If response is 207 Multi-Status or 409 Conflict:
   - Read conflicts[].currentBoard to see what another agent changed
   - Merge your intended changes with theirs
   - Retry set_metadata with the updated expectedVersion from
     conflicts[].currentVersion
```

Asset uploads (draw/audio) don't use optimistic concurrency — they're
last-write-wins on the target layer. Metadata edits do.

## Workflow: hand off results to a human

Three options, pick whichever fits the user's workflow:

1. **Shareable URL** — `get_board_url` returns the public `viewUrl`.
   Works in any browser, iframe-embeddable. Fastest for quick review.

2. **PDF export** — `export_pdf` returns base64 bytes + a download URL.
   Producers/directors expect PDF. One page per board with composited
   image, dialogue footer, action line, notes sidebar.

3. **Time-limited token** — `mint_share_token` creates a URL with a
   scoped permission (view / comment / edit) and optional TTL. Useful
   for client previews that expire.

## Error handling

All errors return structured JSON with a `code` field:

| Code | HTTP | What it means | What to do |
|---|---|---|---|
| `BAD_REQUEST` | 400 | Missing/malformed field | Fix request shape |
| `BAD_PROMPT` | 400 | Prompt empty / too short / too long (>2000 chars) | Reword |
| `BAD_MODEL` | 400 | Unknown model name | Use a listed model |
| `BAD_BASE64` | 400 | Image/audio base64 didn't decode | Re-encode |
| `NO_BOARD` | 404 | boardUid doesn't exist | Verify via get_project |
| `WRONG_PROJECT` | 403 | boardUid is in a different project | Check project id |
| `NOT_FOUND` | 404 | Project id doesn't exist | Verify project id |
| `VERSION_MISMATCH` | 409 | Concurrent modification | Refetch, merge, retry |
| `PROVIDER_REJECTED` | 422 | Content moderation | Reword the prompt |
| `PROVIDER_UNAVAILABLE` | 503 | Upstream timeout (already retried once internally) | Retry with backoff |
| `RATE_LIMITED` | 429 | Too many requests | Back off |
| (402) | 402 | x402 payment required (production mode) | Complete payment and retry with X-Payment header |

## Pricing (when x402 is enabled in production)

Free: create/read/edit metadata, upload pre-existing images or audio,
share URLs, export PDFs.

Paid per call (default USDC on Base):
- `generate_panel` — $0.25 (250000 atomic USDC)
- `generate_speech` — $0.10 (100000 atomic)

In local dev / mock mode, everything is free and the mock providers
return deterministic colored PNGs (for images) and pseudo-waveform WAVs
(for audio) keyed by prompt/text hash. Same input → same output. You
can build and test complete workflows without any API keys.

## Setup (if tools aren't visible yet)

If you're running in an MCP-aware client but can't see the AgentBoard
tools in your tool list, the MCP server isn't configured. Tell the
human to add this to their MCP config (Claude Desktop example):

```json
{
  "mcpServers": {
    "agentboard": {
      "command": "node",
      "args": ["/absolute/path/to/agentboard/web-server/mcp/server.mjs"],
      "env": {
        "AGENTBOARD_URL": "http://localhost:3456",
        "AGENTBOARD_TOKEN": "<optional bearer token for prod>"
      }
    }
  }
}
```

Then ask them to restart the client. Also make sure the AgentBoard web
server is running: `cd web-server && npm start`.

If you're running without MCP (plain scripted agent), the same
capabilities are at `POST /api/agent/*` via direct HTTP — see the
`web-server/routes/agent.js` file for the full route list.

## Tool invocation examples

### create_storyboard
```json
{
  "title": "The Lighthouse Keeper",
  "aspectRatio": 1.7777,
  "boards": [
    { "dialogue": "She climbs the spiral stairs.", "action": "pan up the tower", "duration": 3000 },
    { "dialogue": "The lamp flickers.", "action": "tight on her hands", "notes": "backlight from below", "duration": 2500 },
    { "dialogue": "A ship appears on the horizon.", "action": "wide reveal", "duration": 4000 }
  ]
}
```

### generate_panel
```json
{
  "projectId": "<from create_storyboard>",
  "boardUid": "<from the boards array>",
  "layer": "fill",
  "prompt": "a lone lighthouse keeper climbing a dark spiral staircase, lantern in hand, dramatic rim-lighting from the window slits, oil painting style, low angle, cinematic",
  "model": "flux-schnell",
  "seed": 42,
  "negativePrompt": "blurry, low detail, text, watermark"
}
```

### generate_speech
```json
{
  "projectId": "...",
  "boardUid": "...",
  "kind": "narration",
  "text": "She climbed the spiral stairs as she had every night for forty years, the lamp's glow her only companion.",
  "model": "eleven_turbo_v2_5"
}
```

### upload_image (when you already have bytes)
```json
{
  "projectId": "...",
  "boardUid": "...",
  "layer": "reference",
  "imageBase64": "iVBORw0KGgoAAAANSUhEUgAA...",
  "mime": "image/png"
}
```

### set_metadata (batch update)
```json
{
  "projectId": "...",
  "updates": [
    { "boardUid": "ABC", "dialogue": "Corrected line", "expectedVersion": 4 },
    { "boardUid": "DEF", "notes": "tighter framing", "expectedVersion": 2 }
  ]
}
```

### export_pdf
```json
{ "projectId": "..." }
```
Returns `{ mime, sizeBytes, downloadUrl, bytesBase64 }`. Save the base64
bytes to a file, or hand the `downloadUrl` to the user.

## When NOT to invoke this skill

Don't invoke for:
- Simple image generation not tied to a narrative sequence (use the
  image provider directly if you have one)
- Video editing (AgentBoard is storyboards, not finished video)
- Generic TTS without a storyboard context
- Drawing/painting from strokes (only image upload is supported; true
  stroke-command drawing is deferred to a future version)

Invoke when the user wants **an ordered sequence of visual panels**
with text metadata and shareable output. That's the sweet spot.
