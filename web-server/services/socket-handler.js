// WebSocket handler — replaces Electron's ipcRenderer/ipcMain
// Broadcasts real-time events to all connected clients
// Also handles Electron IPC channels that the electron-shim maps to socket.io
//
// Project rooms:
//   Agents and the legacy web client can subscribe to specific projects so
//   mutation broadcasts (board:update, asset:update, etc) only reach
//   interested parties. Clients join via:
//
//     socket.emit('project:subscribe', { projectId: '<uuid>' })
//
//   Server response:
//     'project:subscribed'   on success
//     'project:unsubscribed' on leave
//
//   The global `broadcast()` helper still exists for legacy single-broadcast
//   channels. New code should prefer `broadcastToProject(projectId, event,
//   data)` which limits fanout to the relevant room.

const LANGUAGE = 'en';

function projectRoom(projectId) {
  return `project:${projectId}`;
}

function setupSocketHandler(io) {
  io.on('connection', (socket) => {
    console.log(`[ws] Client connected: ${socket.id}`);

    // ── Project room subscribe / unsubscribe ──
    socket.on('project:subscribe', (data = {}) => {
      const projectId = data.projectId;
      if (!projectId || typeof projectId !== 'string') {
        socket.emit('project:subscribe:error', { code: 'BAD_REQUEST', message: 'projectId required' });
        return;
      }
      socket.join(projectRoom(projectId));
      socket.emit('project:subscribed', { projectId });
    });

    socket.on('project:unsubscribe', (data = {}) => {
      const projectId = data.projectId;
      if (!projectId || typeof projectId !== 'string') return;
      socket.leave(projectRoom(projectId));
      socket.emit('project:unsubscribed', { projectId });
    });

    // ── Board events ──
    socket.on('board:update', (data) => {
      socket.broadcast.emit('board:update', data);
    });

    socket.on('board:add', (data) => {
      socket.broadcast.emit('board:add', data);
    });

    socket.on('board:delete', (data) => {
      socket.broadcast.emit('board:delete', data);
    });

    socket.on('board:reorder', (data) => {
      socket.broadcast.emit('board:reorder', data);
    });

    // ── Project events ──
    socket.on('project:save', (data) => {
      socket.broadcast.emit('project:save', data);
    });

    // ── Canvas/drawing events ──
    socket.on('canvas:draw', (data) => {
      socket.broadcast.emit('canvas:draw', data);
    });

    // ── Electron IPC shim events ──
    
    // Language
    socket.on('getCurrentLanguage', (...args) => {
      // The last arg might be a reply channel from ipcRenderer.invoke
      const replyChannel = typeof args[args.length - 1] === 'string' && args[args.length - 1].includes(':reply:')
        ? args[args.length - 1] : null;
      if (replyChannel) {
        socket.emit(replyChannel, LANGUAGE);
      } else {
        socket.emit('getCurrentLanguage', LANGUAGE);
      }
    });

    socket.on('languageChanged', (lang) => {
      socket.broadcast.emit('languageChanged', lang);
    });

    // Text input mode
    socket.on('textInputMode', (mode) => {
      socket.broadcast.emit('textInputMode', mode);
    });

    // Shot generator events — route between clients
    socket.onAny((event, ...args) => {
      if (event.startsWith('shot-generator:')) {
        socket.broadcast.emit(event, ...args);
      }
    });

    // ── Save/load events from the frontend ──
    socket.on('save', (data) => {
      socket.broadcast.emit('save', data);
    });

    socket.on('saveAs', (data) => {
      socket.broadcast.emit('saveAs', data);
    });

    socket.on('exportAs', (data) => {
      socket.broadcast.emit('exportAs', data);
    });

    // ── Generic IPC relay ──
    // For any unhandled channels, relay to other clients (multi-tab sync)
    // This acts as a catch-all for Electron IPC channels we haven't explicitly handled
    const HANDLED_EVENTS = new Set([
      'board:update', 'board:add', 'board:delete', 'board:reorder',
      'project:save', 'canvas:draw', 'getCurrentLanguage', 'languageChanged',
      'textInputMode', 'save', 'saveAs', 'exportAs',
      'disconnect', 'disconnecting', 'error', 'connection',
    ]);

    socket.onAny((event, ...args) => {
      // Skip already-handled events and socket.io internals
      if (HANDLED_EVENTS.has(event)) return;
      if (event.startsWith('shot-generator:')) return; // Already handled above
      
      // Check if the last arg is a reply channel (from ipcRenderer.invoke)
      const lastArg = args[args.length - 1];
      if (typeof lastArg === 'string' && lastArg.includes(':reply:')) {
        // This is an invoke-style call — respond with a default acknowledgment
        socket.emit(lastArg, null);
        return;
      }

      // Broadcast to other clients (multi-window sync)
      socket.broadcast.emit(event, ...args);
    });

    socket.on('disconnect', () => {
      console.log(`[ws] Client disconnected: ${socket.id}`);
    });
  });

  return {
    // Emit to ALL clients (legacy catch-all for events that don't have
    // a specific project scope, like project:create).
    broadcast(event, data) {
      io.emit(event, data);
    },
    // Emit only to sockets that have explicitly joined the project room.
    // Preferred path for mutation events on a specific project.
    broadcastToProject(projectId, event, data) {
      if (!projectId) {
        io.emit(event, data);
        return;
      }
      io.to(projectRoom(projectId)).emit(event, data);
    },
  };
}

module.exports = { setupSocketHandler };
