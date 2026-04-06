# Electron Migration Audit — Storyboarder

## Summary

| Category | Files Affected | Occurrences |
|----------|---------------|-------------|
| `require('electron')` | 35 | ~80+ |
| `@electron/remote` | 57 | ~120+ |
| `ipcRenderer` | 27 | ~60+ |
| `fs` / `fs-extra` | 34 | ~150+ |
| `path` | 51 | ~200+ |
| `child_process` | 3 | ~5 |
| `shell` | 12 | ~20 |
| `clipboard` | 2 | ~5 |
| `nativeImage` | 1 | ~2 |
| `dialog` | 16 | ~30 |
| `remote.require` | 7 | ~12 |

**Total unique files needing changes: ~90 out of 475 JS files (~19%)**

---

## 1. Critical Path Files (must migrate first)

### `src/js/window/main-window.js` (7,294 lines) — THE CORE
- 55 `fs.*` calls (read/write boards, save projects, load images)
- Heavy `@electron/remote` usage (dialog, app, prefs)
- `ipcRenderer` for inter-window communication
- `child_process` not used here
- **This is 80% of the migration effort**

### `src/js/window/storyboarder-sketch-pane.js` (1,403 lines) — DRAWING ENGINE WRAPPER
- `ipcRenderer` for cursor/tool events
- `@electron/remote` for prefs
- `fs` for loading brush data
- Wraps `alchemancy` SketchPane — **the SketchPane itself is pure WebGL**

### `src/js/main.js` (1,744 lines) — ELECTRON MAIN PROCESS
- Creates BrowserWindows, handles app lifecycle, menus
- **This gets REPLACED entirely by a web server (Express/Fastify)**

### `src/js/window/exporter.js` — EXPORT ENGINE
- `@electron/remote` for dialogs
- `fs` for writing exported files
- Handles PDF, FCPX, images, web export

---

## 2. Electron API → Web Replacement Map

### `@electron/remote` (57 files) — HIGHEST IMPACT
**What it does:** Lets renderer process access main process modules
**Used for:** `remote.require('./prefs')`, `remote.app`, `remote.dialog`
**Web replacement:**
- Prefs → REST API (`GET/POST /api/prefs`)
- App info → server endpoint or config
- Dialog → browser native dialogs / custom modals

### `ipcRenderer` (27 files)
**What it does:** Sends messages between Electron windows
**Used for:** Window state sync, tool changes, save/load triggers
**Web replacement:** WebSocket server (already has socket.io in deps!)

### `fs` / `fs-extra` (34 files)
**What it does:** Read/write files to disk
**Used for:** Load/save .storyboarder projects, images, exports
**Web replacement:**
- Read → `fetch('/api/projects/:id/files/:path')`
- Write → `POST /api/projects/:id/files/:path`
- Backend stores files on disk, serves via API

### `dialog` (16 files)
**What it does:** Native file open/save/message dialogs
**Used for:**
- `showOpenDialog` → Open .storyboarder files
- `showSaveDialog` → Export location
- `showMessageBox` → Confirmations
**Web replacement:**
- Open → `<input type="file">` + custom modal
- Save → Browser download / FileSaver.js
- Message → Custom confirmation modal

### `shell` (12 files)
**What it does:** `shell.openExternal(url)`, `shell.showItemInFolder(path)`
**Web replacement:** `window.open(url, '_blank')`

### `clipboard` (2 files)
**What it does:** Copy image to clipboard
**Web replacement:** `navigator.clipboard.write()` (modern browsers)

### `nativeImage` (1 file)
**What it does:** Create image from buffer for clipboard
**Web replacement:** `Blob` + `ClipboardItem`

### `path` (51 files)
**What it does:** Path manipulation (`path.join`, `path.dirname`, etc.)
**Web replacement:** `path-browserify` npm package (drop-in)

### `child_process` (3 files)
**What it does:** Spawn ffmpeg for video export
**Used in:** `exporters/ffmpeg.js`
**Web replacement:** Backend runs ffmpeg, serves result via API

---

## 3. Key Dependencies — Browser Compatibility

### ✅ BROWSER-SAFE (no changes needed)
| Package | Notes |
|---------|-------|
| `alchemancy` | Pure WebGL/pixi.js/paper.js drawing engine. **CORE ASSET — works in browser** |
| `paper` (0.11.5) | Canvas/SVG library. Browser-native. |
| `three` (0.115.0) | WebGL 3D. Browser-native. Used by Shot Generator. |
| `react` / `react-dom` | Browser-native. |
| `redux` / `react-redux` | Browser-native. |
| `socket.io-client` | Browser-native. Already used for mobile sync. |
| `express` | Server-side. Stays on backend. |
| `zustand` | Browser-native state management. |
| `pixi.js` (via alchemancy) | WebGL. Browser-native. |

### ❌ MUST REPLACE/SHIM
| Package | Replacement |
|---------|-------------|
| `@electron/remote` | API calls to backend |
| `electron-redux` | Regular redux (already using redux) |
| `electron-log` | `console.log` + server logging endpoint |
| `electron-is-dev` | `process.env.NODE_ENV` / config flag |
| `electron-updater` | Remove (web auto-updates by nature) |
| `electron-google-analytics` | Standard GA4 / web analytics |
| `fs-extra` | Backend API for file ops |
| `ffmpeg-static` | Backend-only, not needed in frontend |
| `chokidar` | Backend file watching |
| `node-machine-id` | Replace with session/user ID |
| `i18next-fs-backend` | Switch to `i18next-http-backend` (already in deps!) |
| `trash` | Backend API call |

### ⚠️ NEEDS INVESTIGATION
| Package | Notes |
|---------|-------|
| `ag-psd` | PSD import/export. May have Node deps. |
| `pdfkit` | PDF generation. Has browser builds available. |
| `gifencoder` | GIF export. Canvas-based, should work. |
| `wav-encoder` | Audio. Likely browser-safe. |
| `archiver` | ZIP creation. Backend-only. |

---

## 4. Architecture — Current vs Target

### Current (Electron)
```
┌──────────────────┐     ┌────────────────────┐
│   Main Process   │ IPC │  Renderer Process   │
│   (main.js)      │◄───►│  (main-window.js)   │
│   - File system  │     │  - UI/Canvas        │
│   - Dialogs      │     │  - SketchPane       │
│   - App lifecycle│     │  - Board management │
│   - Menus        │     │  - Redux store      │
└──────────────────┘     └────────────────────┘
         │
     Direct fs
     access
```

### Target (Web)
```
┌─────────────────────────────────────────────┐
│              Browser Client                  │
│  - Same UI (main-window.js, migrated)       │
│  - SketchPane (alchemancy — unchanged!)     │
│  - Redux store (unchanged!)                 │
│  - Board management (API calls instead of fs)│
│  - WebSocket for real-time sync             │
├─────────────────────────────────────────────┤
│              Agent API Layer                 │
│  REST: /api/projects, /api/boards, /api/draw│
│  WS: real-time board updates                │
├─────────────────────────────────────────────┤
│              Backend Server                  │
│  Express + socket.io (already in deps!)     │
│  - File storage (projects, images)          │
│  - PDF/video export (pdfkit, ffmpeg)        │
│  - Auth + shareable links                   │
│  - AI image gen (fal.ai)                    │
└─────────────────────────────────────────────┘
```

---

## 5. Proposed `electron-shim.js`

A compatibility layer that intercepts Electron API calls and routes them to web equivalents:

```js
// electron-shim.js — Drop-in replacement for Electron APIs in browser

const API_BASE = '/api';
const ws = new WebSocket(`ws://${location.host}/ws`);

// Replace @electron/remote
const remote = {
  require: (modulePath) => {
    if (modulePath.includes('prefs')) return prefsShim;
    // ... other modules
  },
  app: {
    getPath: (name) => fetch(`${API_BASE}/app/path/${name}`).then(r => r.text()),
    getVersion: () => fetch(`${API_BASE}/app/version`).then(r => r.text()),
  },
  dialog: dialogShim,
  getCurrentWindow: () => windowShim,
};

// Replace dialog
const dialogShim = {
  showOpenDialog: async (options) => {
    // Use <input type="file"> via hidden element
    return new Promise((resolve) => { /* file picker */ });
  },
  showSaveDialog: async (options) => {
    // Return virtual path, backend handles actual save
    return { filePath: await promptSaveName(options) };
  },
  showMessageBox: async (options) => {
    return { response: confirm(options.message) ? 0 : 1 };
  }
};

// Replace fs
const fs = {
  readFileSync: (path) => { throw new Error('Use async fs.readFile'); },
  readFile: (path, enc, cb) => {
    fetch(`${API_BASE}/fs/read?path=${encodeURIComponent(path)}`)
      .then(r => enc ? r.text() : r.arrayBuffer())
      .then(data => cb(null, data))
      .catch(err => cb(err));
  },
  writeFile: (path, data, cb) => {
    fetch(`${API_BASE}/fs/write?path=${encodeURIComponent(path)}`, {
      method: 'POST', body: data
    }).then(() => cb(null)).catch(err => cb(err));
  },
  existsSync: () => { throw new Error('Use async fs.exists'); },
  // ... etc
};

// Replace ipcRenderer
const ipcRenderer = {
  on: (channel, handler) => ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.channel === channel) handler(null, ...msg.args);
  }),
  send: (channel, ...args) => ws.send(JSON.stringify({ channel, args })),
};

// Replace shell
const shell = {
  openExternal: (url) => window.open(url, '_blank'),
  showItemInFolder: () => { /* no-op or open in new tab */ },
};

// Replace clipboard  
const clipboard = {
  writeImage: async (img) => {
    const blob = await fetch(img.toDataURL()).then(r => r.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  },
  readImage: () => navigator.clipboard.read(),
};

module.exports = { remote, fs, ipcRenderer, shell, clipboard, nativeImage: {} };
```

---

## 6. Migration Phases

### Phase 1A: Backend Server (NEW — ~2 days)
- Express server serving static frontend
- REST API for file operations (CRUD projects, boards, images)
- WebSocket for real-time sync (replaces ipcRenderer)
- Project storage on disk

### Phase 1B: Electron Shim + Webpack Config (~3 days)
- Create `electron-shim.js`
- Webpack alias: `electron` → `./electron-shim.js`
- Webpack alias: `@electron/remote` → `./electron-shim.js`
- `path` → `path-browserify`
- `fs`/`fs-extra` → shim that calls backend API
- Replace `readFileSync` hot paths with async equivalents

### Phase 1C: main-window.js Migration (~3-4 days)
- Replace 55 fs calls with API calls
- Replace dialog calls with web modals
- Replace ipcRenderer with WebSocket
- This is the bulk of the work

### Phase 1D: Supporting Files (~2 days)
- Migrate remaining 89 files
- Most are simple find/replace once shim exists
- Test each module

### Phase 1E: Shareable URLs + Deploy (~1 day)
- Each project gets a UUID-based URL
- Deploy to VPS

**Estimated Phase 1 total: ~11-13 days**

---

## 7. Files That Need ZERO Changes
- `alchemancy` (drawing engine) — pure WebGL ✅
- `paper.js` usage — browser-native ✅
- All React components (unless they import electron) ✅
- Redux store logic ✅
- Most of `src/js/shared/` ✅
- All CSS ✅
- All HTML templates (minor script tag changes) ✅

This means ~80% of the codebase stays untouched. The migration is focused on the ~90 files that touch Electron/Node APIs.
