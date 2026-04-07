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
- `generate_panel` (AI image gen, supports style presets)
- `list_image_styles` (browse available style presets)
- `generate_speech` (AI TTS — narration / dialogue)
- `generate_sound_effect` (AI one-shot SFX)
- `generate_music` (AI music composition)
- `draw_shapes` (rasterize geometric primitives onto a board layer)
- `draw_strokes` (rasterize brush strokes onto a board layer)
- `export_pdf`
- `get_board_url`, `mint_share_token`

**REST API.** If you don't have MCP tools available, call the HTTP routes
directly at `AGENTBOARD_URL` (default `http://localhost:3456`):

- `POST /api/agent/create-project` — same shape as `create_storyboard`
- `POST /api/agent/generate-image`, `/generate-speech`
- `POST /api/agent/generate-sfx`, `/generate-music`
- `POST /api/agent/draw-shapes`, `/draw-strokes`
- `POST /api/agent/draw`, `/upload-audio`
- `POST /api/agent/export/pdf`
- `GET /api/agent/project/:id`, `/projects`, `/share/:id`
- `GET /api/agent/image-styles` — list style presets

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

## Style presets — visual consistency across panels

Pass `style: "<preset>"` to `generate_panel` (or include `style` in the
REST `/api/agent/generate-image` body) to lock all panels to the same
visual look. The server prepends a curated system prompt and, for
reference-based styles, sends curated reference images to the model.
This is the easiest way to keep an entire storyboard visually coherent:
choose one style at the start of the project and pass it to every
generate call.

Available presets (call `list_image_styles` for the live list):

- `storyboard-sketch` — black & white rough marker-style storyboard
  panels with two reference images. Auto-promotes to
  `flux-kontext-multi` so the references can guide the output. Best
  default for traditional storyboard look.
- `cinematic-color` — full-color cinematic stills, dramatic lighting.
  No reference images, uses `flux-pro-v1.1`.
- `comic-panel` — comic book inks + flats, bold linework. No
  references.

When you pass a `style`, you can omit `model` — the preset's preferred
model is used. If you also pass an explicit `model` that doesn't
support references but the style HAS references, the server
auto-promotes you to a kontext-capable model so the refs aren't
silently dropped.

The response includes `style.title`, `style.referenceCount`, and the
final `model` so you can confirm what was used. The same metadata is
persisted in the board's asset record, so later reads show what style
each panel was generated with.

`BAD_STYLE` (HTTP 400) means an unknown preset name. Call
`list_image_styles` to see what's available.

### How style presets actually reach the model

When you pass `style: "storyboard-sketch"`, the server does three things
before hitting fal.ai:

1. **Composes the prompt** — prepends the preset's curated system prompt
   to your user prompt. The model sees `"<style system prompt>\n\n<your
   prompt>"`, not just your prompt alone. This is what locks the look.
2. **Loads reference images from disk** as base64 data URIs. For
   `storyboard-sketch` that's two PNGs from `web-server/assets/reference-
   images/`.
3. **Auto-routes to a kontext-capable model** (`flux-kontext-multi`)
   and posts the references as `image_urls` in the request body. The
   model uses them as visual exemplars.

The response surfaces this in `providerMeta.style` and the asset's
stored `meta.style`, so if you read the project back later you can tell
which preset was used and how many references guided each panel.

## Uploading pre-rendered art (drawing / images you already have)

If you already have an image (you generated it elsewhere, the user
attached one, you composited it yourself), upload it directly instead
of regenerating. This is the AgentBoard "draw" path — despite the name,
it's an image-bytes upload, not stroke commands. Stroke-command drawing
is deferred to a future version.

```
upload_image({
  projectId, boardUid,
  layer: "fill",          // or "reference", "ink", "notes", "tone", "pencil"
  imageBase64: "<base64>",
  mime: "image/png"
})
```

REST equivalent: `POST /api/agent/draw` (same body, returns same shape).

When to use which:
- **`generate_panel`** — you want fal.ai to make a new image from a prompt
- **`upload_image`** — you already have the bytes (from an attachment,
  another tool, an external generator, a previous run)

The `layer` field determines compositing order on the board:
`fill` (bottom) → `tone` → `pencil` → `ink` → `notes` (top), with
`reference` as a separate slot for non-rendered visual references.
For most cases, just upload to `fill` and ignore the rest.

## Uploading pre-recorded audio

Same idea but for sound. Use `upload_audio` when you already have
narration/SFX/music bytes (recorded by a human, generated elsewhere,
imported from a library) instead of calling the AI generators.

```
upload_audio({
  projectId, boardUid,
  kind: "narration",       // or "sfx" | "music" | "ambient" | "reference"
  audioBase64: "<base64>",
  mime: "audio/mpeg",      // or audio/wav, audio/ogg
  duration: 4500           // optional, ms
})
```

REST: `POST /api/agent/upload-audio`. One board can have multiple
audio kinds simultaneously — narration + music + ambient is a common
combo for a single panel.

## Drawing on boards programmatically

For when you want to *draw* on a board instead of generating or
uploading. The server rasterizes your commands via @napi-rs/canvas and
stores the result as a layer asset — same storage path as
`upload_image` and `generate_panel`. Free, no AI inference, no x402.

There are two tools, both using **normalized [0,1] coordinates** so you
never have to think about pixel sizes. `(0,0)` is top-left, `(1,1)` is
bottom-right. Distances and radii are also normalized to canvas width.

| Tool | Use when |
|---|---|
| `draw_shapes` | You want geometric primitives — circles, arrows, text, rectangles, polylines. **This is what you'll use 90% of the time.** Best for annotating an AI-generated panel (circling characters, adding directional arrows, drawing callout labels) or sketching layouts from primitives. |
| `draw_strokes` | You want freeform brush strokes with a specific brush type. Useful for sketch-style marks, expressive lines, or erasing parts of an existing layer with the eraser brush. |

### Modes

- `mode: "replace"` (default) — start from a blank/transparent canvas.
  The output is a fresh layer.
- `mode: "overlay"` — load the existing layer first and draw on top.
  This is what you want when **annotating** an AI-generated image:
  call `generate_panel` first, then `draw_shapes` with `mode:"overlay"`
  on the same `layer:"fill"` to add arrows/circles/labels over it.

### Shape types (for `draw_shapes`)

```
{ type:"line",     from:[x,y], to:[x,y], stroke?, strokeWidth?, opacity? }
{ type:"circle",   center:[x,y], radius:n, stroke?, strokeWidth?, fill?, opacity? }
{ type:"rect",     topLeft:[x,y], size:[w,h], stroke?, strokeWidth?, fill?, opacity? }
{ type:"arrow",    from:[x,y], to:[x,y], stroke?, strokeWidth?, headSize?, opacity? }
{ type:"text",     position:[x,y], text:"...", fontSize?, fontFamily?, fontWeight?, align?, baseline?, fill?, stroke? }
{ type:"polyline", points:[[x,y]...], stroke?, strokeWidth?, smooth?, opacity? }
{ type:"polygon",  points:[[x,y]...], stroke?, strokeWidth?, fill?, opacity? }
{ type:"bezier",   from, cp1, cp2, to, stroke?, strokeWidth?, opacity? }
```

`fontSize` is normalized — `0.05` means "5% of the canvas height".
`align` is `"left" | "center" | "right"`. Strings for `stroke`/`fill`
accept any CSS color (`"#cc0000"`, `"red"`, `"rgba(0,100,200,0.7)"`).

### Brush types (for `draw_strokes`)

| Brush | Looks like | Defaults |
|---|---|---|
| `pencil` | Soft, slightly translucent narrow line | size 4, opacity 0.85, color #222 |
| `pen` | Clean opaque line | size 3, opacity 1.0, color #000 |
| `ink` | Heavy bold line | size 6, opacity 1.0, color #000 |
| `marker` | Wide translucent multiply-blend | size 16, opacity 0.5, color #222 |
| `eraser` | Removes pixels (destination-out) | size 20, opacity 1.0 |

Pair `eraser` with `mode:"overlay"` to remove specific regions of an
existing layer. The points you pass become the eraser path.

Stroke point arrays are smoothed via Catmull-Rom interpolation, so even
sparse arrays like `[[0.1,0.5],[0.5,0.4],[0.9,0.5]]` produce a clean
hand-drawn-looking curve. You don't need to pass dense polylines.

### Common pattern: annotate an AI-generated panel

```
1. generate_panel({ projectId, boardUid, layer:"fill", prompt:"...", style:"storyboard-sketch" })
   → fal.ai produces an image, stored as the fill layer

2. draw_shapes({
     projectId, boardUid,
     layer:"fill", mode:"overlay",
     shapes: [
       { type:"circle", center:[0.35, 0.45], radius:0.08, stroke:"#cc0000", strokeWidth:6 },
       { type:"arrow",  from:[0.7, 0.3], to:[0.5, 0.5],   stroke:"#cc0000", strokeWidth:6 },
       { type:"text",   position:[0.05, 0.05], text:"HERO ENTERS", fontSize:0.04, fill:"#cc0000" },
     ]
   })
   → reads the AI image from disk, composites the annotations on top,
     stores the result back as the same fill layer
```

### Common pattern: sketch a layout from scratch

```
draw_shapes({
  projectId, boardUid, mode:"replace",
  shapes: [
    { type:"rect", topLeft:[0.05,0.05], size:[0.9,0.9], stroke:"#000", strokeWidth:6 },     // frame
    { type:"line", from:[0.5,0.05], to:[0.5,0.95], stroke:"#888", strokeWidth:2 },          // center vertical
    { type:"line", from:[0.05,0.5], to:[0.95,0.5], stroke:"#888", strokeWidth:2 },          // center horizontal
    { type:"circle", center:[0.33,0.6], radius:0.08, stroke:"#000", strokeWidth:4 },        // character head
    { type:"text", position:[0.5,0.92], text:"WIDE — DAY", fontSize:0.04, align:"center" }, // slug
  ]
})
```

### Layer choice

The default `layer` is `"fill"`. Other layers (composited bottom→top):
`tone` → `pencil` → `ink` → `notes`. Plus `reference` as a separate
slot. For most agent use cases, just draw on `fill` and let it be the
single visible layer. Use other layers if you specifically want to
separate concerns: e.g. AI image on `fill`, annotations on `notes`.

### Validation errors (`BAD_DRAW`)

| Cause | Fix |
|---|---|
| Coordinate outside `[0, 1]` | Clamp to range |
| Unknown brush / shape type | Use one from the lists above |
| Empty `strokes` or `shapes` array | Pass at least one |
| Brush `size` outside `0-200 px` | Pick a smaller brush |
| `opacity` outside `[0, 1]` | Clamp |
| Stroke with empty `points` | Add at least one point |

## Audio: speech, sound effects, and music

AgentBoard exposes three independent audio generation tools, each backed
by ElevenLabs. They write to different `audio:<kind>` slots on the same
board so a single panel can have narration, ambient SFX, and a music bed
all at once.

| Tool | Best for | Default slot | Bounds | Default price |
|---|---|---|---|---|
| `generate_speech` | Narration, dialogue, voiceover | `audio:narration` | 1-5000 chars | $0.10 |
| `generate_sound_effect` | One-shot SFX ("thunderclap", "metal door slam") | `audio:sfx` | 0.5-22 seconds | $0.05 |
| `generate_music` | Score, ambient beds, musical cues | `audio:music` | 3-600 seconds | $0.20 |

All three accept a `kind` override so you can route output to a
different slot — for example `generate_sound_effect` with `kind:
"ambient"` writes to `audio:ambient` (useful when you want both a
hard-cut SFX and a continuous bed on the same board).

Prompt tips:

- **Speech**: write the text exactly as it should be spoken. Include
  punctuation for natural pauses. The voice ID controls the speaker.
- **SFX**: keep it short and concrete. "thunderclap with rolling
  rumble", "footsteps on wet gravel", "old metal door creaking open".
  Pass `durationSeconds` if the default 5s isn't right.
- **Music**: be descriptive about instruments, tempo, mood, and genre.
  "melancholic lo-fi piano with soft kick drum, 70 bpm" is much better
  than "sad music". Pass `musicLengthMs` if the default 30s isn't right
  (allowed 3000–600000). Pass `forceInstrumental: true` to guarantee
  no vocals.

Errors specific to audio generation:

| Code | HTTP | Means |
|---|---|---|
| `BAD_PROMPT` | 400 | Prompt empty / non-string / over 2000 chars |
| `BAD_DURATION` | 400 | `durationSeconds` or `musicLengthMs` outside the allowed range |
| `BAD_VOICE` | 400 | Speech only — `voice` is not a valid ElevenLabs voice id |
| `PROVIDER_REJECTED` | 422 | Content moderation rejection from ElevenLabs |

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
| `BAD_PROMPT` | 400 | Prompt outside length bounds. Image gen: 2-2000 chars. SFX/music: 1-4100 chars. Speech: 1-5000 chars. | Reword to fit |
| `BAD_DURATION` | 400 | SFX/music duration outside allowed bounds | Pick a value within range |
| `BAD_STYLE` | 400 | Unknown image style preset | Call list_image_styles |
| `BAD_DRAW` | 400 | Drawing command failed validation (out-of-range coords, unknown brush/shape, oversized array) | Fix the offending field |
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
- `generate_sound_effect` — $0.05 (50000 atomic)
- `generate_music` — $0.20 (200000 atomic)

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

### generate_sound_effect
```json
{
  "projectId": "...",
  "boardUid": "...",
  "prompt": "old metal door creaking slowly open, then a soft thud",
  "durationSeconds": 4
}
```

### generate_music
```json
{
  "projectId": "...",
  "boardUid": "...",
  "prompt": "melancholic lo-fi piano with soft kick drum and vinyl crackle, 70 bpm",
  "musicLengthMs": 20000
}
```

### upload_image (when you already have bytes)
```json
{
  "projectId": "...",
  "boardUid": "...",
  "layer": "fill",
  "imageBase64": "iVBORw0KGgoAAAANSUhEUgAA...",
  "mime": "image/png"
}
```

### upload_audio (when you already have audio bytes)
```json
{
  "projectId": "...",
  "boardUid": "...",
  "kind": "music",
  "audioBase64": "SUQzAwAAAAAA...",
  "mime": "audio/mpeg",
  "duration": 8200
}
```

### list_image_styles
```json
{}
```
Returns `{ styles: [{ name, title, description, hasReferences, preferredModel }, ...] }`. Call before generate_panel if you're unsure which style to pick.

### draw_shapes (annotate an AI panel)
```json
{
  "projectId": "...",
  "boardUid": "...",
  "layer": "fill",
  "mode": "overlay",
  "shapes": [
    { "type": "circle", "center": [0.35, 0.45], "radius": 0.08, "stroke": "#cc0000", "strokeWidth": 6 },
    { "type": "arrow",  "from": [0.7, 0.3], "to": [0.5, 0.5], "stroke": "#cc0000", "strokeWidth": 6 },
    { "type": "text",   "position": [0.05, 0.05], "text": "HERO ENTERS", "fontSize": 0.04, "fill": "#cc0000" }
  ]
}
```

### draw_strokes (sketch with brushes)
```json
{
  "projectId": "...",
  "boardUid": "...",
  "layer": "pencil",
  "mode": "replace",
  "strokes": [
    { "brush": "pencil", "color": "#222", "size": 5, "points": [[0.1, 0.5], [0.3, 0.4], [0.5, 0.5], [0.7, 0.6], [0.9, 0.5]] },
    { "brush": "ink",    "color": "#000", "size": 8, "points": [[0.2, 0.7], [0.5, 0.7], [0.8, 0.7]] }
  ]
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
- Generic TTS / music / SFX without a storyboard context — if you just
  want a single audio clip with no board to attach it to, call the
  audio provider directly
- Pixel-perfect raster painting that requires interactive feedback —
  AgentBoard's drawing API rasterizes shapes/strokes server-side from
  high-level commands. It's great for annotations and sketch layouts,
  but it's not a substitute for a human artist with a tablet

Invoke when the user wants **an ordered sequence of visual panels**
with text metadata, optional audio, and shareable output. That's the
sweet spot.
