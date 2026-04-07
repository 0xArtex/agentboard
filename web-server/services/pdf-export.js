/**
 * pdf-export.js — server-side storyboard PDF renderer using pdfkit
 *
 * Produces a letter-size landscape PDF with one page per board. Each page
 * layout is:
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │  [Project title]                       [N of M]  │
 *   ├──────────────────────────────────────────────────┤
 *   │                                                  │
 *   │                                                  │
 *   │             [composited board image]             │
 *   │                                                  │
 *   │                                                  │
 *   ├──────────────────────────────────────────────────┤
 *   │  Shot 1A   ·   2.5s   ·   BOARD 1                │
 *   │                                                  │
 *   │  "Dialogue goes here in italics."                │
 *   │  Action description in plain text                │
 *   │  notes in monospace                              │
 *   └──────────────────────────────────────────────────┘
 *
 * Image compositing: the PDF renderer stacks all layer blobs for each
 * board, in the same z-order the live viewer uses, onto a single page.
 * pdfkit places images one after another at the same coordinates, and
 * PNG transparency is preserved, so the stack composites correctly on
 * the PDF page.
 *
 * If a board has no layer blobs at all (agent created boards but never
 * uploaded images), the image area renders as a grey placeholder with
 * the shot number centered.
 */

const PDFDocument = require('pdfkit');
const { blobStore } = require('./blob-store');
const store = require('./project-store');

// Same layer order as the viewer
const LAYER_ORDER = ['fill', 'tone', 'pencil', 'ink', 'reference', 'notes'];

function projectTitle(project) {
  if (project.meta && project.meta.title) return String(project.meta.title);
  return 'Untitled Storyboard';
}

/**
 * Resolve the image source for every layer blob a board references.
 * Returns an array of { name, source, opacity } in composition order
 * (bottom first). `source` is a string path for the disk backend or a
 * Buffer of the raw bytes for the R2 backend — pdfkit accepts both.
 *
 * Layers whose blob is missing are silently skipped.
 */
async function resolveLayerSources(projectId, board) {
  const layers = board.layers || {};
  const result = [];
  const known = new Set(LAYER_ORDER);

  const push = async (name) => {
    const layer = layers[name];
    if (!layer || !layer.url) return;
    // layer.url is the synthesized legacy filename (board-N-UID-<name>.png)
    const asset = store.resolveLegacyAsset(projectId, layer.url);
    if (!asset) return;
    let source;
    if (blobStore.backend === 'r2') {
      source = await blobStore.get(asset.hash);
      if (!source) return;
    } else {
      source = blobStore.pathOf(asset.hash);
      if (!source) return;
    }
    result.push({
      name,
      source,
      opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
    });
  };

  for (const name of LAYER_ORDER) await push(name);
  for (const name of Object.keys(layers)) {
    if (!known.has(name)) await push(name);
  }
  return result;
}

/**
 * Generate a PDF Buffer for the given project. Never throws on a per-board
 * issue — individual boards with missing assets just render as placeholders.
 */
async function renderProjectPdf(projectId) {
  const result = await store.getProject(projectId);
  if (!result) {
    throw Object.assign(new Error(`Project ${projectId} not found`), { code: 'NOT_FOUND' });
  }
  const project = result.project;
  const title = projectTitle(project);
  const boards = project.boards || [];

  // Pre-resolve all layer sources before starting the PDF stream. This is
  // especially important for the R2 backend where each resolveLayerSources
  // call does an async download — pdfkit's stream write API isn't async,
  // so we can't await mid-render.
  const boardSources = [];
  for (const board of boards) {
    boardSources.push(await resolveLayerSources(projectId, board));
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: 'landscape',
      margin: 40,
      info: {
        Title: title,
        Author: 'AgentBoard',
        Creator: 'AgentBoard',
        CreationDate: new Date(),
      },
      autoFirstPage: false,
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // If there are no boards, produce a single info page rather than an
    // empty PDF — downloaders get a confusing 0-byte file otherwise.
    if (boards.length === 0) {
      doc.addPage();
      doc.fontSize(24).text(title, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor('#666')
         .text('This storyboard has no boards yet.', { align: 'center' });
      doc.end();
      return;
    }

    boards.forEach((board, index) => {
      renderBoardPage(doc, {
        project,
        board,
        boardIndex: index,
        boardTotal: boards.length,
        title,
        layerSources: boardSources[index],
      });
    });

    doc.end();
  });
}

function renderBoardPage(doc, { project, board, boardIndex, boardTotal, title, layerSources }) {
  doc.addPage();

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const marginLeft = doc.page.margins.left;
  const marginRight = doc.page.margins.right;
  const marginTop = doc.page.margins.top;
  const marginBottom = doc.page.margins.bottom;
  const contentW = pageW - marginLeft - marginRight;

  let y = marginTop;

  // ── header ─────────────────────────────────────────────────────────
  doc.fontSize(11).fillColor('#333').font('Helvetica-Bold')
     .text(title, marginLeft, y, { width: contentW * 0.7, continued: false });
  doc.fontSize(10).fillColor('#666').font('Helvetica')
     .text(`${boardIndex + 1} of ${boardTotal}`, marginLeft + contentW * 0.7, y, {
       width: contentW * 0.3, align: 'right',
     });

  y += 20;
  doc.moveTo(marginLeft, y).lineTo(pageW - marginRight, y)
     .lineWidth(0.5).strokeColor('#ccc').stroke();
  y += 10;

  // ── image area ─────────────────────────────────────────────────────
  // Reserve roughly 55% of the page for the image, rest for metadata
  const imageAreaH = (pageH - marginTop - marginBottom) * 0.62;
  const aspectRatio = project.aspectRatio || 1.7777;

  // Fit the board's native aspect into the reserved space
  let imgW = contentW;
  let imgH = imgW / aspectRatio;
  if (imgH > imageAreaH) {
    imgH = imageAreaH;
    imgW = imgH * aspectRatio;
  }
  const imgX = marginLeft + (contentW - imgW) / 2;
  const imgY = y;

  // Background box (in case layers have transparency / are missing)
  doc.save();
  doc.rect(imgX, imgY, imgW, imgH).fill('#ffffff');
  doc.restore();

  // Composite layers (sources were pre-resolved async in renderProjectPdf)
  if (!layerSources || layerSources.length === 0) {
    // Placeholder
    doc.save();
    doc.rect(imgX, imgY, imgW, imgH).fillAndStroke('#f2f2f2', '#ccc');
    doc.fontSize(10).fillColor('#999').font('Helvetica')
       .text('(no image)', imgX, imgY + imgH / 2 - 5, { width: imgW, align: 'center' });
    doc.restore();
  } else {
    for (const layer of layerSources) {
      try {
        // pdfkit accepts either a file path OR a Buffer here. Disk backend
        // gives us a path; R2 backend gives us a Buffer of the downloaded
        // bytes. Same call site for both.
        doc.save();
        if (layer.opacity !== 1) doc.opacity(layer.opacity);
        doc.image(layer.source, imgX, imgY, { fit: [imgW, imgH], align: 'center', valign: 'center' });
        doc.restore();
      } catch (err) {
        // Non-fatal: one broken image just gets skipped, the others still render
        doc.restore();
      }
    }
  }
  // Border around the image box
  doc.save();
  doc.lineWidth(0.5).strokeColor('#bbb').rect(imgX, imgY, imgW, imgH).stroke();
  doc.restore();

  y = imgY + imgH + 14;

  // ── metadata strip ──────────────────────────────────────────────────
  const shotLabel = board.shot || `${board.number}A`;
  const durationSec = ((board.duration || project.defaultBoardTiming || 2000) / 1000);
  const durationLabel = durationSec.toFixed(durationSec < 10 ? 1 : 0) + 's';

  doc.fontSize(10).fillColor('#f6c945').font('Helvetica-Bold')
     .text(shotLabel, marginLeft, y, { continued: true });
  doc.fillColor('#888').font('Helvetica')
     .text('   ·   ' + durationLabel + '   ·   BOARD ' + board.number, { continued: false });

  y += 16;
  doc.moveTo(marginLeft, y).lineTo(pageW - marginRight, y)
     .lineWidth(0.25).strokeColor('#ddd').stroke();
  y += 8;

  // ── text block ──────────────────────────────────────────────────────
  const textW = contentW;
  const maxTextY = pageH - marginBottom - 20;

  if (board.dialogue) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#222')
       .text('"' + board.dialogue + '"', marginLeft, y, { width: textW });
    y = doc.y + 4;
  }
  if (board.action && y < maxTextY) {
    doc.font('Helvetica').fontSize(10).fillColor('#555')
       .text(board.action, marginLeft, y, { width: textW });
    y = doc.y + 4;
  }
  if (board.notes && y < maxTextY) {
    doc.font('Courier').fontSize(9).fillColor('#888')
       .text(board.notes, marginLeft, y, { width: textW });
  }
}

module.exports = { renderProjectPdf };
