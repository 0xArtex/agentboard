---
name: agentboard
description: Store, annotate, and share multi-panel storyboards via a REST API. Invoke when the user wants to build a storyboard, pre-visualization, shot-by-shot breakdown, animatic, illustrated narrative, or any ordered sequence of visual panels with text metadata. Agents with their own image/video/TTS generation should UPLOAD the bytes they produce to AgentBoard's board layers — AgentBoard stores them, lets you draw/annotate on top, composites layers, exports PDFs, and returns shareable view URLs. Works over plain HTTP at AGENTBOARD_URL (default http://localhost:3456), or via MCP tools if your runtime supports them. Generation tools (fal.ai, ElevenLabs) are available as a FALLBACK for agents without built-in generation.
---

# AgentBoard — agent quick reference

AgentBoard is a **storyboard canvas for agents**. Your job: put images, audio, and annotations onto numbered boards, then hand the user a URL or a PDF. AgentBoard owns the project model, layer compositing, the drawing engine, the PDF exporter, and the shareable view. You own the pixels and the audio.

## Transport — pick one

**REST (works everywhere).** All routes live under `AGENTBOARD_URL` (default `http://localhost:3456`). Every example in this file uses REST so you can copy-paste without an MCP runtime. POST bodies are JSON.

**MCP (Claude Code / Desktop / Cursor).** If you see tools named `mcp__agentboard__*` in your tool list, you can call them directly — same argument shapes as the REST bodies below, just drop `projectId`/`boardUid` into the tool args. If you don't see them, use REST.

Everything else in this doc describes the REST surface because the request/response shapes are identical.

## The 5-minute mental model

- **Project** — one storyboard. Has a UUID, `aspectRatio` (default 1.7777), and an ordered list of **boards**.
- **Board** — one panel. Has a 5-char `uid`, `dialogue`, `action`, `notes`, `duration` (ms), and up to six **layers**: `fill`, `tone`, `pencil`, `ink`, `reference`, `notes`. For most work, just use `fill`.
- **Layer asset** — an image (PNG/JPEG) attached to a specific `(board, layer)`. Uploading to the same slot replaces it. Layers composite bottom→top when rendered.
- **Audio asset** — audio (MP3/WAV/OGG) keyed by `(board, kind)` where kind is `narration`, `sfx`, `music`, `ambient`, or `reference`. A single board can have multiple kinds simultaneously.

## PRIMARY WORKFLOW — bring your own pixels

Use this when you (or the runtime you're in) can already generate images and audio. This is the recommended path for any agent with built-in image generation.

```
1. Create the project:
   POST /api/agent/create-project
   { "title": "...", "aspectRatio": 1.7777,
     "boards": [
       { "dialogue": "...", "action": "...", "duration": 4000 },
       { "dialogue": "...", "action": "...", "duration": 3500 },
       ...
     ]
   }
   → { id, project:{ boards:[{uid, number, ...}] }, viewUrl, apiUrl }
   SAVE the id and every board's uid from the response.

2. For each board, generate the image with YOUR OWN tool (fal, Sora, Veo,
   Midjourney, Gemini, whatever you have). Then upload it.

   REST: POST /api/agent/draw with inline base64:
   { "projectId": "...", "boardUid": "...",
     "layer": "fill", "imageBase64": "<base64-png>",
     "mime": "image/png" }
   → { hash, size, kind, mime }

   MCP: use upload_image with ONE of three input modes — pick based on
   where the bytes currently live:
     - imagePath: "/tmp/panel.png"         ← local file, ZERO agent context cost (preferred)
     - imageUrl:  "https://fal.media/..."  ← URL the MCP server fetches (great for fal CDN links)
     - imageBase64: "<base64>"             ← inline, only for tiny images (burns agent context)

   Context cost matters: a 500 KB image is ~680 KB of base64. If you
   pass that as inline imageBase64 from an LLM tool call, the bytes go
   into the agent's context window. Use imagePath or imageUrl instead —
   the MCP server reads/fetches the bytes and they never touch your
   context at all. Same for upload_audio with audioPath/audioUrl.

   Server-side upload validation:
     - Image cap: 256 MB, audio cap: 512 MB (413 UPLOAD_TOO_LARGE).
       Caps are generous on purpose — 4K HDR PNGs, layered art, and
       high-res photos all fit. You should rarely hit them.
     - Magic-byte mime sniffing: you can't spoof the Content-Type.
       If you declare image/png but pass JPEG bytes, the server stores
       it as image/jpeg (the real type wins).
     - Accepted image mimes: image/png, image/jpeg, image/gif, image/webp
     - Accepted audio mimes: audio/mpeg, audio/wav, audio/ogg
     - Other formats → 400 BAD_MIME

   **PREFER BATCH UPLOADS** for any storyboard with 3+ panels — see
   the next section. One batch call replaces N round-trips.

### Batch upload — populate many boards in a single call

```
POST /api/agent/upload-batch
{ "projectId": "...",
  "uploads": [
    { "boardUid": "ABC", "kind": "image", "imageBase64": "...", "mime": "image/png" },
    { "boardUid": "DEF", "kind": "image", "imageBase64": "...", "mime": "image/png" },
    { "boardUid": "ABC", "kind": "audio", "audioKind": "narration", "audioBase64": "...", "mime": "audio/mpeg" },
    ...
  ]
}
```

- **Up to 100 items per call**, mixing images and audio freely.
- Each item is processed independently — partial failures don't abort
  the batch.
- Response is `201` if every item succeeded, `207 Multi-Status`
  otherwise. Body: `{ succeeded: [...], failed: [...] }` with
  per-item details and `index` field so you can map back to your input.

MCP equivalent: `upload_assets_batch` accepts the same shape, and
each item can use `imagePath`/`imageUrl`/`audioPath`/`audioUrl`
instead of inline base64. **This is the recommended path for any
storyboard with 3+ panels** — way fewer round-trips and zero context
cost when using `imagePath`.

Example MCP call to populate a 5-panel storyboard from local files in
one call:
```json
{
  "projectId": "...",
  "uploads": [
    { "boardUid": "ABC", "kind": "image", "imagePath": "/tmp/panel1.png" },
    { "boardUid": "DEF", "kind": "image", "imagePath": "/tmp/panel2.png" },
    { "boardUid": "GHI", "kind": "image", "imagePath": "/tmp/panel3.png" },
    { "boardUid": "JKL", "kind": "image", "imagePath": "/tmp/panel4.png" },
    { "boardUid": "MNO", "kind": "image", "imagePath": "/tmp/panel5.png" }
  ]
}
```
That's **one tool call** populating 5 boards. Compare to 5 separate
`upload_image` calls.

3. (optional) Annotate on top of the uploaded image:
   POST /api/agent/draw-shapes
   { "projectId": "...", "boardUid": "...",
     "layer": "fill", "mode": "overlay",
     "shapes": [
       { "type": "circle", "center": [0.5, 0.5], "radius": 0.08, "stroke": "#cc0000", "strokeWidth": 6 },
       { "type": "arrow",  "from": [0.7, 0.3], "to": [0.5, 0.5], "stroke": "#cc0000", "strokeWidth": 6 },
       { "type": "text",   "position": [0.05, 0.05], "text": "HERO", "fontSize": 0.04, "fill": "#cc0000" }
     ]
   }

4. (optional) Generate audio with your own TTS tool, then upload:
   POST /api/agent/upload-audio
   { "projectId": "...", "boardUid": "...",
     "kind": "narration", "audioBase64": "<base64-mp3>",
     "mime": "audio/mpeg", "duration": 4500 }

5. Return the view URL to the user:
   GET /api/agent/share/{projectId}
   → { viewUrl }
```

A 5-panel storyboard is 1 create + 5 uploads + 1 share = **7 HTTP calls**. Add 5 more if you annotate every panel, 5 more if you attach narration.

**Aspect ratio tip:** generate your images at the same aspect ratio as the project (`1.7777` = 16:9 by default). Images at other ratios still work — the viewer letterboxes — but matching looks best.

## Drawing and annotation

AgentBoard has a server-side rasterization engine that lets you draw shapes and brush strokes onto any board layer. **This is the unique thing AgentBoard does that your image generator can't: composite clean geometric annotations on top of AI output.**

Two routes, both free (no external APIs, no x402 gating):

### `POST /api/agent/draw-shapes` — high-level primitives (use this 90% of the time)

```json
{
  "projectId": "...",
  "boardUid": "...",
  "layer": "fill",
  "mode": "overlay",
  "shapes": [ ... ]
}
```

**Coordinates are normalized [0, 1]** — `(0,0)` is top-left, `(1,1)` is bottom-right. Distances and radii are normalized too. You never need to know the canvas pixel size.

**Modes:**
- `"overlay"` — load the existing layer and draw on top. Use this to annotate an AI-generated panel.
- `"replace"` — start from a blank canvas. Use this to sketch a layout from primitives.

**Shape types:**
```
{ "type": "line",     "from": [x,y], "to": [x,y], "stroke": "...", "strokeWidth": n }
{ "type": "circle",   "center": [x,y], "radius": n, "stroke": "...", "fill": "..." }
{ "type": "rect",     "topLeft": [x,y], "size": [w,h], "stroke": "...", "fill": "..." }
{ "type": "arrow",    "from": [x,y], "to": [x,y], "stroke": "...", "strokeWidth": n, "headSize": n }
{ "type": "text",     "position": [x,y], "text": "...", "fontSize": 0.05, "fill": "...", "align": "left|center|right" }
{ "type": "polyline", "points": [[x,y]...], "stroke": "...", "strokeWidth": n, "smooth": true }
{ "type": "polygon",  "points": [[x,y]...], "stroke": "...", "fill": "..." }
{ "type": "bezier",   "from": [x,y], "cp1": [x,y], "cp2": [x,y], "to": [x,y], "stroke": "..." }
```

`fontSize` is normalized too — `0.05` means "5% of the canvas height". Colors are any CSS color string.

### `POST /api/agent/draw-strokes` — brush strokes (when shapes aren't enough)

```json
{
  "projectId": "...", "boardUid": "...",
  "layer": "pencil", "mode": "replace",
  "strokes": [
    { "brush": "pencil", "color": "#222", "size": 5, "points": [[0.1,0.5],[0.3,0.4],[0.5,0.5],[0.7,0.6],[0.9,0.5]] }
  ]
}
```

Brushes: `pencil` (soft), `pen` (clean line), `ink` (heavy), `marker` (multiply blend), `eraser` (removes pixels — pair with `mode:"overlay"` to erase parts of an existing layer).

Stroke point arrays are Catmull-Rom smoothed — 5 sparse points produce a clean curve. You don't need to pass dense polylines.

## Sharing and export

Three ways to hand off results to a human — use whichever the user asks for.

**View URL** — `GET /api/agent/share/{projectId}` returns `{ viewUrl }`. Public read-only HTML viewer, works in any browser, iframe-embeddable.

**PDF export** — `POST /api/agent/export/pdf` with `{ projectId }` returns the PDF bytes. One page per board with image + dialogue footer + action line + notes sidebar. Producers expect this format.

**Time-limited token** — `POST /api/agent/share/{projectId}` with `{ permission: "view|comment|edit", ttlMs: 86400000 }` returns a URL with a scoped token. Use for client previews that should expire.

## Editing an existing project

```
POST /api/agent/set-metadata
{ "projectId": "...",
  "updates": [
    { "boardUid": "ABC", "dialogue": "new line", "expectedVersion": 4 },
    { "boardUid": "DEF", "notes": "tighter framing", "expectedVersion": 2 }
  ]
}
```

Metadata edits use optimistic concurrency via `expectedVersion`. If another agent modified the same board, you get a 409 with the current state — refetch via `GET /api/agent/project/{id}`, merge your intended changes, retry.

Asset uploads (`/draw`, `/upload-audio`, `/draw-shapes`, `/draw-strokes`) are **last-write-wins** on the target slot. They don't bump version and don't need `expectedVersion`.

## FALLBACK — generation when you don't have your own

**Skip this entire section if you already have image generation, video generation, or TTS available.** Upload your own bytes via the primary workflow above — it's cheaper, faster, and you control the model.

If you don't have built-in generation, AgentBoard can call fal.ai and ElevenLabs on your behalf. This requires the server to have `FAL_KEY` and `ELEVENLABS_KEY` configured, and is x402-gated in production.

**Image generation** — `POST /api/agent/generate-image`:
```json
{ "projectId": "...", "boardUid": "...",
  "layer": "fill",
  "prompt": "a lone stone lighthouse at dusk, dramatic chiaroscuro lighting, cinematic oil painting style, wide-angle composition",
  "style": "storyboard-sketch",
  "quality": "medium"
}
```
- `style` (optional): `"storyboard-sketch"` (B&W rough sketches with reference images), `"cinematic-color"`, or `"comic-panel"`. Call `GET /api/agent/image-styles` for the full list.
- `quality` (optional): `"low"` (z-image-turbo — fast drafts), `"medium"` (flux-2-pro — default), `"high"` (seedream-v5-lite — final renders). Project-level default can be set via `quality` on create-project.
- `model` (optional): explicit override, wins over style and quality.
- Gated by x402 (~$0.25/call in production).

**Text-to-speech** — `POST /api/agent/generate-speech`:
```json
{ "projectId": "...", "boardUid": "...",
  "kind": "narration",
  "text": "She climbed the spiral stairs as she had every night for forty years."
}
```
Before calling this, check `GET /api/agent/voices` to see which voices the configured ElevenLabs account can use. Free-tier ElevenLabs accounts must explicitly add a voice at https://elevenlabs.io/app/voice-library before the API will accept it — otherwise you get a 422 `PROVIDER_REJECTED`.

**Sound effects** — `POST /api/agent/generate-sfx`:
```json
{ "projectId": "...", "boardUid": "...",
  "prompt": "thunderclap with rolling rumble",
  "durationSeconds": 4 }
```

**Music** — `POST /api/agent/generate-music`:
```json
{ "projectId": "...", "boardUid": "...",
  "prompt": "melancholic lo-fi piano with soft kick drum, 70 bpm",
  "musicLengthMs": 20000 }
```

Audio generators write to `audio:narration`, `audio:sfx`, `audio:music` respectively. Pass `kind: "ambient"` to route to `audio:ambient` instead.

## Errors

All errors return `{ error: { code, message } }`. The codes that matter:

| Code | HTTP | What to do |
|---|---|---|
| `BAD_REQUEST` | 400 | Fix the request body shape |
| `BAD_BASE64` | 400 | Re-encode the image/audio bytes |
| `BAD_MIME` | 400 | Uploaded bytes aren't a recognized format (magic-byte check). Re-export the image/audio in a supported format |
| `UPLOAD_TOO_LARGE` | 413 | Image >10 MB or audio >20 MB. Resize/compress and retry |
| `BAD_DRAW` | 400 | Drawing command validation failed (bad coords, unknown brush/shape, oversized array) |
| `NO_BOARD` | 404 | The `boardUid` doesn't exist — verify via `GET /api/agent/project/:id` |
| `NOT_FOUND` | 404 | The `projectId` doesn't exist |
| `WRONG_PROJECT` | 403 | The `boardUid` belongs to a different project |
| `VERSION_MISMATCH` | 409 | Another agent modified the board — refetch, merge, retry |
| `PROVIDER_REJECTED` | 422 | Fallback generator rejected the prompt (moderation OR ElevenLabs library-voice on free tier) |
| `RATE_LIMITED` | 429 | Back off |
| (402) | 402 | x402 payment required (production only) — complete payment, retry with `X-Payment` header |

## What NOT to use AgentBoard for

- Single one-off image generation with no narrative sequence — use your image generator directly and don't wrap it in a storyboard.
- Video editing — AgentBoard produces storyboards, not finished video. Export the boards as PDF or view URL and hand off to a video editor.
- Canvas apps with interactive stroke-by-stroke drawing — the drawing engine is command-based (send shapes/strokes, get PNG), not a live canvas protocol.

## Invoke when

The user wants **an ordered sequence of visual panels with text metadata**, shareable output, or multi-agent collaborative storytelling. That's the sweet spot.
