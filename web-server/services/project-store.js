const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

// Generate 5-char uppercase alphanumeric UID (matching Storyboarder format)
function generateBoardUid() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let uid = '';
  for (let i = 0; i < 5; i++) {
    uid += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return uid;
}

// Sanitize path component to prevent directory traversal
function sanitize(segment) {
  return segment.replace(/[^a-zA-Z0-9_\-\.]/g, '');
}

function projectDir(id) {
  return path.join(PROJECTS_DIR, sanitize(id));
}

function projectFile(id) {
  return path.join(projectDir(id), 'project.storyboarder');
}

// ── Project CRUD ──

async function createProject(opts = {}) {
  const id = uuidv4();
  const dir = projectDir(id);
  await fs.ensureDir(path.join(dir, 'images'));

  const project = {
    version: opts.version || '0.6.0',
    aspectRatio: opts.aspectRatio || 1.7777,
    fps: opts.fps || 24,
    defaultBoardTiming: opts.defaultBoardTiming || 2000,
    boards: [],
  };

  await fs.writeJson(projectFile(id), project, { spaces: 2 });
  return { id, project };
}

async function getProject(id) {
  const file = projectFile(id);
  if (!(await fs.pathExists(file))) return null;
  const project = await fs.readJson(file);
  return { id, project };
}

async function updateProject(id, updates) {
  const existing = await getProject(id);
  if (!existing) return null;

  const project = { ...existing.project, ...updates };
  // Don't let updates overwrite boards directly via this method
  if (updates.boards === undefined) {
    project.boards = existing.project.boards;
  }
  await fs.writeJson(projectFile(id), project, { spaces: 2 });
  return { id, project };
}

async function deleteProject(id) {
  const dir = projectDir(id);
  if (!(await fs.pathExists(dir))) return false;
  await fs.remove(dir);
  return true;
}

async function listProjects() {
  await fs.ensureDir(PROJECTS_DIR);
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(PROJECTS_DIR, entry.name, 'project.storyboarder');
    if (await fs.pathExists(file)) {
      const project = await fs.readJson(file);
      projects.push({
        id: entry.name,
        boardCount: project.boards ? project.boards.length : 0,
        aspectRatio: project.aspectRatio,
        version: project.version,
      });
    }
  }
  return projects;
}

// ── Board CRUD ──

async function addBoard(projectId, boardData = {}) {
  const existing = await getProject(projectId);
  if (!existing) return null;

  const uid = boardData.uid || generateBoardUid();
  const boardNumber = existing.project.boards.length + 1;

  const board = {
    uid,
    url: boardData.url || `board-${boardNumber}-${uid}.png`,
    newShot: boardData.newShot !== undefined ? boardData.newShot : (boardNumber === 1),
    lastEdited: Date.now(),
    number: boardNumber,
    shot: boardData.shot || `${boardNumber}A`,
    time: boardData.time || 0,
    duration: boardData.duration || existing.project.defaultBoardTiming || 2000,
    dialogue: boardData.dialogue || '',
    action: boardData.action || '',
    notes: boardData.notes || '',
    layers: boardData.layers || {},
  };

  existing.project.boards.push(board);

  // Recalculate times
  recalcTimes(existing.project);

  await fs.writeJson(projectFile(projectId), existing.project, { spaces: 2 });
  return board;
}

async function updateBoard(projectId, boardUid, updates) {
  const existing = await getProject(projectId);
  if (!existing) return null;

  const idx = existing.project.boards.findIndex(b => b.uid === boardUid);
  if (idx === -1) return null;

  const board = { ...existing.project.boards[idx], ...updates, lastEdited: Date.now() };
  existing.project.boards[idx] = board;

  await fs.writeJson(projectFile(projectId), existing.project, { spaces: 2 });
  return board;
}

async function deleteBoard(projectId, boardUid) {
  const existing = await getProject(projectId);
  if (!existing) return null;

  const idx = existing.project.boards.findIndex(b => b.uid === boardUid);
  if (idx === -1) return false;

  const removed = existing.project.boards.splice(idx, 1)[0];

  // Renumber
  existing.project.boards.forEach((b, i) => {
    b.number = i + 1;
  });
  recalcTimes(existing.project);

  // Remove image file if exists
  const imgPath = path.join(projectDir(projectId), 'images', removed.url);
  if (await fs.pathExists(imgPath)) {
    await fs.remove(imgPath);
  }

  await fs.writeJson(projectFile(projectId), existing.project, { spaces: 2 });
  return true;
}

async function reorderBoards(projectId, uidOrder) {
  const existing = await getProject(projectId);
  if (!existing) return null;

  const boardMap = {};
  for (const b of existing.project.boards) {
    boardMap[b.uid] = b;
  }

  const reordered = [];
  for (const uid of uidOrder) {
    if (boardMap[uid]) {
      reordered.push(boardMap[uid]);
    }
  }

  // Append any boards not in the new order (safety)
  for (const b of existing.project.boards) {
    if (!uidOrder.includes(b.uid)) {
      reordered.push(b);
    }
  }

  reordered.forEach((b, i) => {
    b.number = i + 1;
  });
  recalcTimes({ ...existing.project, boards: reordered });

  existing.project.boards = reordered;
  await fs.writeJson(projectFile(projectId), existing.project, { spaces: 2 });
  return reordered;
}

// Recalculate cumulative times
function recalcTimes(project) {
  let time = 0;
  for (const board of project.boards) {
    board.time = time;
    time += board.duration || project.defaultBoardTiming || 2000;
  }
}

// ── File helpers ──

function getProjectDir(id) {
  return projectDir(id);
}

function getImagesDir(id) {
  return path.join(projectDir(id), 'images');
}

module.exports = {
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listProjects,
  addBoard,
  updateBoard,
  deleteBoard,
  reorderBoards,
  getProjectDir,
  getImagesDir,
  generateBoardUid,
  sanitize,
  DATA_DIR,
  PROJECTS_DIR,
};
