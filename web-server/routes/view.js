/**
 * /view/:projectId — read-only storyboard viewer
 *
 * Server-renders a single self-contained HTML page. No external JS deps,
 * no bundler, no API round-trips after initial load. The page receives
 * the full project shape as inline JSON and renders board-by-board in the
 * browser.
 *
 * Design choices:
 *   - Client-side layer compositing: each board renders as a stack of
 *     absolutely-positioned <img> elements, one per layer. Missing layers
 *     fall through cleanly (just don't render). We skip the composited
 *     `board` asset entirely because agents writing via /api/agent/draw
 *     only upload individual layers, never a pre-composited result.
 *   - Dark aesthetic by default (matches Storyboarder chrome).
 *   - Iframe-embeddable: we intentionally do NOT set X-Frame-Options.
 *   - Keyboard: ←/→ navigates, space toggles play, Home/End jump.
 *   - Auto-advance respects each board's own `duration` (in ms).
 *
 * Share tokens + permissioning come in task #34. For now every project is
 * publicly viewable by URL — fine for a private alpha.
 */

const express = require('express');
const router = express.Router();

const store = require('../services/project-store');
const shareTokens = require('../services/share-tokens');
const agents = require('../services/agents');

// Legacy layer order (matches StoryboarderSketchPane#visibleLayersIndices
// in the web client so what the viewer shows matches what the editor shows).
const LAYER_ORDER = ['fill', 'tone', 'pencil', 'ink', 'reference', 'notes'];

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build the list of { name, url, opacity } for a board's layers, in the
// order they should be composited (bottom to top). Layers that exist in
// the database but not in LAYER_ORDER are appended at the end.
function buildLayerStack(projectId, board) {
  const layers = board.layers || {};
  const known = new Set(LAYER_ORDER);
  const ordered = [];

  for (const name of LAYER_ORDER) {
    if (layers[name] && layers[name].url) {
      ordered.push({
        name,
        url: `/web/projects/${projectId}/images/${layers[name].url}`,
        opacity: typeof layers[name].opacity === 'number' ? layers[name].opacity : 1,
      });
    }
  }
  for (const name of Object.keys(layers)) {
    if (known.has(name)) continue;
    if (layers[name] && layers[name].url) {
      ordered.push({
        name,
        url: `/web/projects/${projectId}/images/${layers[name].url}`,
        opacity: typeof layers[name].opacity === 'number' ? layers[name].opacity : 1,
      });
    }
  }
  return ordered;
}

function buildViewModel(projectId, project) {
  const aspectRatio = project.aspectRatio || 1.7777;
  const boards = (project.boards || []).map(b => ({
    uid: b.uid,
    number: b.number,
    shot: b.shot || `${b.number}A`,
    duration: b.duration || project.defaultBoardTiming || 2000,
    dialogue: b.dialogue || '',
    action: b.action || '',
    notes: b.notes || '',
    layers: buildLayerStack(projectId, b),
  }));
  // Title lives in project.meta.title if set (create-project stashes it there)
  let title = 'Untitled';
  if (project.meta && typeof project.meta === 'object' && project.meta.title) {
    title = project.meta.title;
  }
  return { projectId, title, aspectRatio, boards };
}

router.get('/:projectId', async (req, res) => {
  const projectId = req.params.projectId;
  // Basic UUID shape check so we don't bother SQLite with garbage
  if (!/^[0-9a-fA-F-]{8,}$/.test(projectId)) {
    return res.status(400).send('Invalid project id');
  }
  const result = await store.getProject(projectId);
  if (!result) {
    return res.status(404).type('text/html').send(notFoundHtml(projectId));
  }

  // Access gate.
  //
  // In dev (PUBLIC_VIEW_REQUIRES_TOKEN unset) any project URL is public —
  // the intent is easy local testing. In prod with
  // PUBLIC_VIEW_REQUIRES_TOKEN=1, visitors need either:
  //   (a) a valid ?t=<token> query param (mint via POST /api/agent/share/:id)
  //   (b) a bearer token for an authenticated agent that has read access
  //       to the project
  // Owner/admin direct access without a share token is allowed so you can
  // always view your own work even when public views are locked down.
  const gated = process.env.PUBLIC_VIEW_REQUIRES_TOKEN === '1';
  if (gated) {
    const rawToken = typeof req.query.t === 'string' ? req.query.t : null;
    let accessOk = false;
    let tokenPerm = null;

    if (rawToken) {
      const v = shareTokens.validateShareToken(projectId, rawToken);
      if (v.ok) { accessOk = true; tokenPerm = v.permission; }
    }
    if (!accessOk && req.agent && req.agent.authenticated) {
      // Authenticated agent — check project permission
      if (agents.canRead(projectId, req.agent.userId)) {
        accessOk = true;
      }
    }
    if (!accessOk) {
      return res.status(403).type('text/html').send(forbiddenHtml(projectId));
    }
    // tokenPerm ('view' | 'comment' | 'edit') could be surfaced to the
    // client-side JS later for mutation routes; for now it's informational.
    res.locals.tokenPermission = tokenPerm;
  }

  const vm = buildViewModel(projectId, result.project);
  const html = renderHtml(vm);
  res.type('text/html').send(html);
});

// ── HTML templates ────────────────────────────────────────────────────

function notFoundHtml(id) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>AgentBoard — not found</title>
<style>
  body { background: #1a1a1a; color: #eee; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; }
  h1 { font-weight: 600; margin: 0 0 0.5em; }
  code { background: #2a2a2a; padding: 0.2em 0.5em; border-radius: 3px; }
</style>
</head><body>
  <div class="box">
    <h1>Storyboard not found</h1>
    <p>No project with id <code>${escapeHtml(id)}</code>.</p>
  </div>
</body></html>`;
}

function forbiddenHtml(id) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>AgentBoard — access denied</title>
<style>
  body { background: #1a1a1a; color: #eee; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; max-width: 32rem; padding: 0 1.5rem; }
  h1 { font-weight: 600; margin: 0 0 0.5em; }
  p { color: #999; line-height: 1.5; }
  code { background: #2a2a2a; padding: 0.2em 0.5em; border-radius: 3px; }
</style>
</head><body>
  <div class="box">
    <h1>This storyboard is private</h1>
    <p>You need a valid share link or an authenticated session to view
       project <code>${escapeHtml(id)}</code>.</p>
  </div>
</body></html>`;
}

function renderHtml(vm) {
  const dataJson = JSON.stringify(vm).replace(/</g, '\\u003c');
  const title = escapeHtml(vm.title);
  const boardCount = vm.boards.length;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — AgentBoard</title>
<style>
  :root {
    --bg: #111;
    --panel: #1a1a1a;
    --border: #2a2a2a;
    --fg: #e8e8e8;
    --fg-dim: #999;
    --accent: #f6c945;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
  }
  .app {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    max-width: 1200px;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 0;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1.5rem;
  }
  header h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  header .meta {
    color: var(--fg-dim);
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }
  .board-stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }
  .canvas {
    position: relative;
    width: 100%;
    max-width: 960px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .canvas::before {
    content: '';
    display: block;
    padding-bottom: calc(100% / var(--ar, 1.7777));
  }
  .canvas .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    image-rendering: crisp-edges;
  }
  .canvas .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #aaa;
    font-size: 0.85rem;
  }
  .meta-row {
    width: 100%;
    max-width: 960px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: baseline;
    gap: 0.75rem;
    color: var(--fg-dim);
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.5rem;
  }
  .meta-row .shot { color: var(--accent); font-weight: 600; }
  .meta-row .duration { }
  .meta-row .progress { justify-self: end; }
  .text-block {
    width: 100%;
    max-width: 960px;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-top: 0.5rem;
    min-height: 4rem;
  }
  .text-block .dialogue {
    font-style: italic;
    font-size: 1rem;
    color: var(--fg);
  }
  .text-block .dialogue:empty::before {
    content: '\u200b';
  }
  .text-block .action {
    color: var(--fg-dim);
    font-size: 0.9rem;
  }
  .text-block .notes {
    color: #777;
    font-size: 0.8rem;
    font-family: 'SFMono-Regular', 'Consolas', monospace;
  }
  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1rem 0;
  }
  .controls button {
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0.4rem 0.75rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    min-width: 2.5rem;
  }
  .controls button:hover {
    border-color: var(--fg-dim);
  }
  .controls button.primary {
    background: var(--accent);
    color: #000;
    border-color: var(--accent);
    font-weight: 600;
  }
  .controls .counter {
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
    font-size: 0.85rem;
    min-width: 4.5rem;
    text-align: center;
  }
  .strip {
    display: flex;
    gap: 0.35rem;
    overflow-x: auto;
    padding: 0.75rem 0 1.5rem;
    border-top: 1px solid var(--border);
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .strip .thumb {
    flex: 0 0 auto;
    width: 96px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
    transition: border-color 0.1s;
  }
  .strip .thumb::before {
    content: '';
    display: block;
    padding-bottom: calc(100% / var(--ar, 1.7777));
  }
  .strip .thumb img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .strip .thumb .num {
    position: absolute;
    left: 3px;
    top: 3px;
    padding: 1px 4px;
    background: rgba(0,0,0,0.7);
    color: #fff;
    font-size: 10px;
    border-radius: 2px;
  }
  .strip .thumb.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .strip .thumb:hover {
    border-color: var(--fg-dim);
  }
  .empty-state {
    padding: 4rem 2rem;
    text-align: center;
    color: var(--fg-dim);
  }
  kbd {
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 2px;
    font: inherit;
    font-size: 0.7rem;
    color: var(--fg-dim);
    background: var(--panel);
  }
  footer {
    padding: 1rem 0 1.5rem;
    color: var(--fg-dim);
    font-size: 0.75rem;
    text-align: center;
    border-top: 1px solid var(--border);
  }
  footer a { color: var(--fg-dim); }
</style>
</head>
<body>
  <div class="app">
    <header>
      <h1>${title}</h1>
      <div class="meta">${boardCount} board${boardCount === 1 ? '' : 's'}</div>
    </header>

    <div id="stage" class="board-stage">
      ${boardCount === 0 ? '<div class="empty-state">This storyboard has no boards yet.</div>' : ''}
    </div>

    <footer>
      <kbd>&larr;</kbd> <kbd>&rarr;</kbd> navigate &nbsp;·&nbsp;
      <kbd>space</kbd> play/pause &nbsp;·&nbsp;
      <kbd>Home</kbd>/<kbd>End</kbd> jump &nbsp;·&nbsp;
      AgentBoard
    </footer>
  </div>

  <script>
    const DATA = ${dataJson};

    const state = {
      index: 0,
      playing: false,
      timer: null,
    };

    const stage = document.getElementById('stage');
    if (DATA.boards.length === 0) {
      // Empty state already rendered
    } else {
      render();
    }

    function render() {
      stage.innerHTML = '';
      const board = DATA.boards[state.index];
      if (!board) return;

      // Canvas with stacked layers
      const canvas = document.createElement('div');
      canvas.className = 'canvas';
      canvas.style.setProperty('--ar', String(DATA.aspectRatio));
      if (board.layers.length === 0) {
        const ph = document.createElement('div');
        ph.className = 'placeholder';
        ph.textContent = 'No image yet';
        canvas.appendChild(ph);
      } else {
        for (const layer of board.layers) {
          const img = document.createElement('img');
          img.className = 'layer';
          img.src = layer.url;
          img.alt = layer.name;
          if (layer.opacity !== 1) img.style.opacity = String(layer.opacity);
          img.onerror = () => { img.style.display = 'none'; };
          canvas.appendChild(img);
        }
      }
      stage.appendChild(canvas);

      // Meta row
      const meta = document.createElement('div');
      meta.className = 'meta-row';
      meta.innerHTML = '<span class="shot">' + escapeHtml(board.shot) + '</span>' +
        '<span class="duration">' + formatDuration(board.duration) + '</span>' +
        '<span class="progress">' + (state.index + 1) + ' / ' + DATA.boards.length + '</span>';
      stage.appendChild(meta);

      // Text block
      const text = document.createElement('div');
      text.className = 'text-block';
      if (board.dialogue) {
        const d = document.createElement('div');
        d.className = 'dialogue';
        d.textContent = board.dialogue;
        text.appendChild(d);
      }
      if (board.action) {
        const a = document.createElement('div');
        a.className = 'action';
        a.textContent = board.action;
        text.appendChild(a);
      }
      if (board.notes) {
        const n = document.createElement('div');
        n.className = 'notes';
        n.textContent = board.notes;
        text.appendChild(n);
      }
      stage.appendChild(text);

      // Controls
      const controls = document.createElement('div');
      controls.className = 'controls';
      controls.innerHTML =
        '<button id="btn-first" title="First (Home)">&laquo;</button>' +
        '<button id="btn-prev" title="Prev (←)">&lsaquo;</button>' +
        '<button id="btn-play" class="primary" title="Play/Pause (space)">' + (state.playing ? 'Pause' : 'Play') + '</button>' +
        '<button id="btn-next" title="Next (→)">&rsaquo;</button>' +
        '<button id="btn-last" title="Last (End)">&raquo;</button>';
      stage.appendChild(controls);

      // Strip
      const strip = document.createElement('div');
      strip.className = 'strip';
      DATA.boards.forEach((b, i) => {
        const t = document.createElement('div');
        t.className = 'thumb' + (i === state.index ? ' active' : '');
        t.style.setProperty('--ar', String(DATA.aspectRatio));
        // Show the top-most non-transparent layer as the thumbnail preview
        const thumbLayer = b.layers[b.layers.length - 1];
        if (thumbLayer) {
          const img = document.createElement('img');
          img.src = thumbLayer.url;
          img.onerror = () => { img.style.display = 'none'; };
          t.appendChild(img);
        }
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(b.number);
        t.appendChild(num);
        t.onclick = () => goTo(i);
        strip.appendChild(t);
      });
      stage.appendChild(strip);

      // Scroll active thumb into view
      const active = strip.querySelector('.thumb.active');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

      // Wire up buttons
      document.getElementById('btn-first').onclick = () => goTo(0);
      document.getElementById('btn-prev').onclick = () => goTo(state.index - 1);
      document.getElementById('btn-next').onclick = () => goTo(state.index + 1);
      document.getElementById('btn-last').onclick = () => goTo(DATA.boards.length - 1);
      document.getElementById('btn-play').onclick = togglePlay;
    }

    function goTo(i) {
      const next = Math.max(0, Math.min(DATA.boards.length - 1, i));
      if (next === state.index) return;
      state.index = next;
      if (state.playing && state.index === DATA.boards.length - 1) {
        // Reached the end during playback — stop instead of looping
        state.playing = false;
        clearTimer();
      }
      render();
      if (state.playing) scheduleNext();
    }

    function togglePlay() {
      if (DATA.boards.length < 2) return;
      state.playing = !state.playing;
      render();
      if (state.playing) scheduleNext();
      else clearTimer();
    }

    function scheduleNext() {
      clearTimer();
      const board = DATA.boards[state.index];
      const ms = (board && board.duration) || 2000;
      state.timer = setTimeout(() => {
        if (!state.playing) return;
        if (state.index >= DATA.boards.length - 1) {
          state.playing = false;
          render();
          return;
        }
        state.index += 1;
        render();
        scheduleNext();
      }, ms);
    }

    function clearTimer() {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }

    function formatDuration(ms) {
      const s = (ms / 1000);
      return s.toFixed(s < 10 ? 1 : 0) + 's';
    }

    function escapeHtml(s) {
      if (s == null) return '';
      return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.key) {
        case 'ArrowLeft':  goTo(state.index - 1); e.preventDefault(); break;
        case 'ArrowRight': goTo(state.index + 1); e.preventDefault(); break;
        case 'Home':       goTo(0); e.preventDefault(); break;
        case 'End':        goTo(DATA.boards.length - 1); e.preventDefault(); break;
        case ' ':          togglePlay(); e.preventDefault(); break;
      }
    });
  </script>
</body></html>`;
}

module.exports = router;
