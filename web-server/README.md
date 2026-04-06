# Storyboarder Web Server

Express + Socket.io backend for the Storyboarder web app. Replaces the Electron main process with a REST API and WebSocket server.

## Quick Start

```bash
npm install
node server.js
# Server runs on http://localhost:3000
```

## API Reference

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |

### Projects
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create new project |
| GET | `/api/projects/:id` | Get project metadata |
| PUT | `/api/projects/:id` | Update project metadata |
| DELETE | `/api/projects/:id` | Delete project |

### Boards
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:id/boards` | List all boards |
| POST | `/api/projects/:id/boards` | Add a board |
| PUT | `/api/projects/:id/boards/:uid` | Update a board |
| DELETE | `/api/projects/:id/boards/:uid` | Delete a board |
| PUT | `/api/projects/:id/boards/reorder` | Reorder boards |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/:id/files/*` | Read a file |
| POST | `/api/projects/:id/files/*` | Write/upload a file |
| DELETE | `/api/projects/:id/files/*` | Delete a file |
| GET | `/api/projects/:id/images` | List project images |
| POST | `/api/projects/:id/images` | Upload an image (multipart) |

### Export
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/projects/:id/export/pdf` | Export as PDF |
| POST | `/api/projects/:id/export/images` | Export board images |
| POST | `/api/projects/:id/export/zip` | Export project as ZIP |
| GET | `/api/projects/:id/export/grid` | Storyboard grid overview |

### Preferences
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/prefs` | Get all preferences |
| PUT | `/api/prefs` | Update preferences |
| GET | `/api/prefs/:key` | Get specific preference |

### Agent API
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agent/create-project` | Create project from JSON spec |
| POST | `/api/agent/add-board` | Add board with metadata |
| POST | `/api/agent/draw` | Programmatic draw commands |
| POST | `/api/agent/generate-image` | AI image generation (placeholder) |
| GET | `/api/agent/share/:id` | Get shareable URL |

### App Info
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/app/version` | App version |
| GET | `/api/app/path/:name` | Get system paths |

## WebSocket Events

Connect via Socket.io to `ws://localhost:3000`.

| Event | Direction | Description |
|-------|-----------|-------------|
| `board:update` | ↔ | Board was modified |
| `board:add` | ↔ | New board added |
| `board:delete` | ↔ | Board removed |
| `board:reorder` | ↔ | Boards reordered |
| `project:save` | ↔ | Project saved |
| `canvas:draw` | ↔ | Drawing data (agent + real-time sync) |

## Data Format

Projects are stored in `data/projects/<uuid>/`:
```
data/projects/<uuid>/
├── project.storyboarder    # Project JSON
└── images/                 # Board image PNGs
```

### Project JSON (`.storyboarder`)
```json
{
  "version": "0.6.0",
  "aspectRatio": 1.7777,
  "fps": 24,
  "defaultBoardTiming": 2000,
  "boards": [
    {
      "uid": "ABCDE",
      "url": "board-1-ABCDE.png",
      "newShot": true,
      "lastEdited": 1492639275392,
      "number": 1,
      "shot": "1A",
      "time": 0,
      "duration": 2000,
      "dialogue": "",
      "action": "",
      "notes": "",
      "layers": {}
    }
  ]
}
```

## Testing

```bash
# Start server in one terminal
node server.js

# Run tests in another
bash test.sh
```
