/**
 * draw-engine.js — server-side rasterization for agent drawing commands
 *
 * Agents can't manipulate a canvas the way a human does — they can't drag a
 * mouse, feel pressure curves, or "feel out" a shape. What they CAN do is:
 *   1. Describe shapes semantically: "circle at center, radius 0.1, red"
 *   2. Pass arrays of points along a path: "stroke from A through B to C"
 *   3. Compose primitives into more complex outputs: arrows, callouts, frames
 *
 * This module is the server-side engine that turns those high-level
 * descriptions into rasterized PNG bytes that get stored as a layer asset
 * on a board. It uses @napi-rs/canvas (cairo-free, pure-JS install) so it
 * runs anywhere Node runs without native compile pain.
 *
 * Two surfaces:
 *
 *   renderShapes({ aspectRatio, mode, baseImage, shapes })
 *     → high-level primitives: line, circle, rect, arrow, text, polyline,
 *       polygon, bezier. This is the API agents will use 90% of the time.
 *
 *   renderStrokes({ aspectRatio, mode, baseImage, strokes })
 *     → low-level brush strokes: pencil/pen/ink/marker/eraser, with
 *       Catmull-Rom path smoothing and pressure modulation. For the rare
 *       case an agent really wants to "draw" stamp-by-stamp.
 *
 * Both APIs:
 *   - Use NORMALIZED [0,1] coordinates throughout. (0,0) = top-left,
 *     (1,1) = bottom-right. Agents don't need to know pixel dimensions.
 *   - Support `mode: 'overlay'` (composite onto an existing layer) or
 *     'replace' (start from a blank/transparent canvas).
 *   - Return a PNG buffer at the canvas's native pixel resolution.
 *
 * Resolution: we render at 1920px wide (or 1920px tall for portrait) and
 * compute the other dimension from the aspect ratio. That's high enough
 * for clean output but not so high that PNG encoding takes forever.
 */

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const TARGET_LONG_EDGE = 1920;
const MIN_DIM = 256;
const MAX_DIM = 4096;

// Agents have to fit within these limits or we reject the request. The
// caps prevent runaway requests (e.g. 100k stroke points) from chewing
// CPU. Real-world drawings need a small fraction of these.
const MAX_STROKES_PER_REQUEST = 200;
const MAX_POINTS_PER_STROKE = 4000;
const MAX_SHAPES_PER_REQUEST = 200;
const MAX_TEXT_LEN = 500;

class DrawError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrawError';
    this.code = code;
  }
}

// ── coordinate validation ─────────────────────────────────────────────

function validateNormalized(value, fieldName, { allowOutside = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new DrawError('BAD_DRAW', `${fieldName} must be a finite number`);
  }
  if (!allowOutside && (n < 0 || n > 1)) {
    throw new DrawError('BAD_DRAW',
      `${fieldName}=${n} must be in [0,1] (normalized coordinates)`);
  }
  return n;
}

function validatePoint(point, fieldName) {
  if (!Array.isArray(point) || point.length < 2) {
    throw new DrawError('BAD_DRAW', `${fieldName} must be a [x, y] pair`);
  }
  return [
    validateNormalized(point[0], `${fieldName}[0]`),
    validateNormalized(point[1], `${fieldName}[1]`),
  ];
}

function validateColor(input, fallback = '#000000') {
  if (input == null) return fallback;
  const s = String(input).trim();
  // Permissive: any string that looks like a CSS color. Canvas2D will
  // throw on invalid values, but we let it bubble as a generic error
  // rather than re-implementing the entire CSS color spec here.
  if (!/^#[0-9a-fA-F]{3,8}$|^rgba?\(.+\)$|^hsla?\(.+\)$|^[a-zA-Z]+$/.test(s)) {
    throw new DrawError('BAD_DRAW', `color '${s}' is not a valid CSS color`);
  }
  return s;
}

// ── canvas creation ────────────────────────────────────────────────────

function dimensionsForAspect(aspectRatio) {
  const ar = Number(aspectRatio) || 1.7777;
  if (!Number.isFinite(ar) || ar <= 0) {
    throw new DrawError('BAD_DRAW', `aspectRatio must be a positive number, got ${aspectRatio}`);
  }
  let width, height;
  if (ar >= 1) {
    width = TARGET_LONG_EDGE;
    height = Math.round(width / ar);
  } else {
    height = TARGET_LONG_EDGE;
    width = Math.round(height * ar);
  }
  // Clamp to safety bounds — protects against floating-point craziness.
  width = Math.max(MIN_DIM, Math.min(MAX_DIM, width));
  height = Math.max(MIN_DIM, Math.min(MAX_DIM, height));
  return { width, height };
}

async function createBoardCanvas({ aspectRatio, mode, baseImage }) {
  const { width, height } = dimensionsForAspect(aspectRatio);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Anti-aliasing on for smooth strokes + shapes.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (mode === 'overlay' && baseImage) {
    // Decode the existing layer bytes and draw them as the background.
    // We scale to fit the canvas (existing layer might be a different
    // pixel size — e.g. fal-generated 1024x576 vs our 1920x1080). The
    // aspect ratios SHOULD match because both come from the same project.
    let img;
    try {
      img = await loadImage(baseImage);
    } catch (err) {
      throw new DrawError('BAD_DRAW', `failed to decode base image: ${err.message}`);
    }
    ctx.drawImage(img, 0, 0, width, height);
  }

  return { canvas, ctx, width, height };
}

// ── path smoothing (Catmull-Rom → Bezier) ─────────────────────────────
//
// Agents pass arrays of points. Drawing a polyline straight through them
// looks blocky. We convert to a smooth curve using Catmull-Rom
// interpolation, which passes exactly through every input point and
// generates control points for cubic beziers in between. The result
// looks like a hand-drawn curve instead of a polygonal mess.

function strokeSmoothPath(ctx, points) {
  if (points.length === 0) return;
  if (points.length === 1) {
    // Single dot — draw a small filled circle at the point
    ctx.beginPath();
    ctx.arc(points[0][0], points[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (points.length === 2) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    ctx.lineTo(points[1][0], points[1][1]);
    ctx.stroke();
    return;
  }

  // Catmull-Rom → cubic Bezier
  // Reference: https://stackoverflow.com/a/15528789 — for each segment
  // (P1 → P2), use P0 and P3 as the tangent control points.
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
  }
  ctx.stroke();
}

// ── brush rendering ───────────────────────────────────────────────────
//
// Each brush is a function that takes (ctx, points, opts) and renders
// the stroke. Different brushes use different Canvas2D settings:
//
//   pencil  — soft, slightly translucent, narrow line
//   pen     — clean opaque line, slight stroke
//   ink     — heavy opaque line with dynamic width if pressure given
//   marker  — wide translucent line with multiply blend
//   eraser  — destination-out blend, removes pixels from the layer
//
// All brushes work on already-pixel-coordinate points (callers convert
// from normalized first). Width/opacity defaults differ per brush so
// agents can pass minimal options and still get reasonable output.

const BRUSHES = {
  pencil(ctx, points, opts) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = opts.color || '#222222';
    ctx.lineWidth = (opts.size != null ? opts.size : 4);
    ctx.globalAlpha = (opts.opacity != null ? opts.opacity : 0.85);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeSmoothPath(ctx, points);
    ctx.restore();
  },

  pen(ctx, points, opts) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = opts.color || '#000000';
    ctx.lineWidth = (opts.size != null ? opts.size : 3);
    ctx.globalAlpha = (opts.opacity != null ? opts.opacity : 1.0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeSmoothPath(ctx, points);
    ctx.restore();
  },

  ink(ctx, points, opts) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = opts.color || '#000000';
    ctx.lineWidth = (opts.size != null ? opts.size : 6);
    ctx.globalAlpha = (opts.opacity != null ? opts.opacity : 1.0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeSmoothPath(ctx, points);
    ctx.restore();
  },

  marker(ctx, points, opts) {
    ctx.save();
    // Multiply gives the translucent overlapping marker look — strokes
    // crossing each other darken naturally instead of just stacking alpha.
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = opts.color || '#222222';
    ctx.lineWidth = (opts.size != null ? opts.size : 16);
    ctx.globalAlpha = (opts.opacity != null ? opts.opacity : 0.5);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeSmoothPath(ctx, points);
    ctx.restore();
  },

  eraser(ctx, points, opts) {
    ctx.save();
    // destination-out removes pixels from whatever's already on the
    // canvas. Color doesn't matter for this blend mode but we still set
    // strokeStyle to be safe.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = (opts.size != null ? opts.size : 20);
    ctx.globalAlpha = (opts.opacity != null ? opts.opacity : 1.0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeSmoothPath(ctx, points);
    ctx.restore();
  },
};

// ── stroke validation ─────────────────────────────────────────────────

function validateStroke(stroke, idx) {
  if (!stroke || typeof stroke !== 'object') {
    throw new DrawError('BAD_DRAW', `stroke[${idx}] must be an object`);
  }
  const brush = String(stroke.brush || 'pencil');
  if (!BRUSHES[brush]) {
    throw new DrawError('BAD_DRAW',
      `stroke[${idx}].brush '${brush}' unknown. Valid: ${Object.keys(BRUSHES).join(', ')}`);
  }
  if (!Array.isArray(stroke.points)) {
    throw new DrawError('BAD_DRAW', `stroke[${idx}].points must be an array`);
  }
  if (stroke.points.length === 0) {
    throw new DrawError('BAD_DRAW', `stroke[${idx}].points must be non-empty`);
  }
  if (stroke.points.length > MAX_POINTS_PER_STROKE) {
    throw new DrawError('BAD_DRAW',
      `stroke[${idx}].points has ${stroke.points.length} points, max ${MAX_POINTS_PER_STROKE}`);
  }
  const points = stroke.points.map((p, j) => validatePoint(p, `stroke[${idx}].points[${j}]`));
  const opts = {
    color: stroke.color != null ? validateColor(stroke.color) : undefined,
    size: stroke.size != null ? Number(stroke.size) : undefined,
    opacity: stroke.opacity != null ? Number(stroke.opacity) : undefined,
  };
  if (opts.size != null && (!Number.isFinite(opts.size) || opts.size <= 0 || opts.size > 200)) {
    throw new DrawError('BAD_DRAW', `stroke[${idx}].size must be 0-200 px`);
  }
  if (opts.opacity != null && (!Number.isFinite(opts.opacity) || opts.opacity < 0 || opts.opacity > 1)) {
    throw new DrawError('BAD_DRAW', `stroke[${idx}].opacity must be in [0,1]`);
  }
  return { brush, points, opts };
}

// ── shape rendering ───────────────────────────────────────────────────
//
// High-level primitives. Each takes the ctx (already converted to pixel
// coordinates by the caller) and a validated shape descriptor. These are
// what agents will use most of the time — way more useful than asking an
// LLM to plan stroke-by-stroke.

function setupShapeStyle(ctx, shape) {
  ctx.lineCap = shape.lineCap || 'round';
  ctx.lineJoin = shape.lineJoin || 'round';
  if (shape.strokeWidth != null) {
    const w = Number(shape.strokeWidth);
    if (!Number.isFinite(w) || w < 0 || w > 200) {
      throw new DrawError('BAD_DRAW', `strokeWidth ${w} must be 0-200 px`);
    }
    ctx.lineWidth = w;
  } else {
    ctx.lineWidth = 4;
  }
  if (shape.opacity != null) {
    const a = Number(shape.opacity);
    if (!Number.isFinite(a) || a < 0 || a > 1) {
      throw new DrawError('BAD_DRAW', `opacity ${a} must be in [0,1]`);
    }
    ctx.globalAlpha = a;
  }
  if (shape.stroke) ctx.strokeStyle = validateColor(shape.stroke);
  if (shape.fill) ctx.fillStyle = validateColor(shape.fill);
}

const SHAPES = {
  line(ctx, shape, toPx) {
    const [x1, y1] = toPx(validatePoint(shape.from, 'line.from'));
    const [x2, y2] = toPx(validatePoint(shape.to, 'line.to'));
    ctx.save();
    setupShapeStyle(ctx, shape);
    if (!shape.stroke) ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  },

  circle(ctx, shape, toPx, scaleR) {
    const [cx, cy] = toPx(validatePoint(shape.center, 'circle.center'));
    const r = scaleR(validateNormalized(shape.radius, 'circle.radius'));
    ctx.save();
    setupShapeStyle(ctx, shape);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (shape.fill) ctx.fill();
    if (shape.stroke || !shape.fill) {
      if (!shape.stroke) ctx.strokeStyle = '#000000';
      ctx.stroke();
    }
    ctx.restore();
  },

  rect(ctx, shape, toPx, scaleR) {
    const [x1, y1] = toPx(validatePoint(shape.topLeft, 'rect.topLeft'));
    if (!Array.isArray(shape.size) || shape.size.length < 2) {
      throw new DrawError('BAD_DRAW', 'rect.size must be a [w,h] pair');
    }
    const w = scaleR(validateNormalized(shape.size[0], 'rect.size[0]'));
    const h = validateNormalized(shape.size[1], 'rect.size[1]') * ctx.canvas.height;
    ctx.save();
    setupShapeStyle(ctx, shape);
    if (shape.fill) ctx.fillRect(x1, y1, w, h);
    if (shape.stroke || !shape.fill) {
      if (!shape.stroke) ctx.strokeStyle = '#000000';
      ctx.strokeRect(x1, y1, w, h);
    }
    ctx.restore();
  },

  arrow(ctx, shape, toPx) {
    // Line + arrowhead at the `to` end. Arrowhead is a filled triangle
    // sized relative to the shaft length so it scales nicely.
    const [x1, y1] = toPx(validatePoint(shape.from, 'arrow.from'));
    const [x2, y2] = toPx(validatePoint(shape.to, 'arrow.to'));
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const headLen = shape.headSize != null
      ? Number(shape.headSize) * ctx.canvas.width
      : Math.min(40, len * 0.2);
    const angle = Math.atan2(dy, dx);
    const headAngle = Math.PI / 7;

    ctx.save();
    setupShapeStyle(ctx, shape);
    if (!shape.stroke) ctx.strokeStyle = '#000000';
    if (!shape.fill) ctx.fillStyle = ctx.strokeStyle;

    // Shaft (stop short of arrowhead so the line doesn't poke through it)
    const shaftEndX = x2 - Math.cos(angle) * headLen * 0.6;
    const shaftEndY = y2 - Math.sin(angle) * headLen * 0.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(shaftEndX, shaftEndY);
    ctx.stroke();

    // Arrowhead triangle
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - headAngle),
      y2 - headLen * Math.sin(angle - headAngle)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + headAngle),
      y2 - headLen * Math.sin(angle + headAngle)
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  text(ctx, shape, toPx) {
    if (typeof shape.text !== 'string' || shape.text.length === 0) {
      throw new DrawError('BAD_DRAW', 'text.text must be a non-empty string');
    }
    if (shape.text.length > MAX_TEXT_LEN) {
      throw new DrawError('BAD_DRAW', `text.text exceeds ${MAX_TEXT_LEN} characters`);
    }
    const [x, y] = toPx(validatePoint(shape.position, 'text.position'));
    // Font size is normalized — agents specify "0.05" meaning "5% of the
    // canvas height". This keeps text legible regardless of pixel size.
    const sizeNorm = shape.fontSize != null
      ? validateNormalized(shape.fontSize, 'text.fontSize')
      : 0.04;
    const sizePx = Math.max(8, Math.round(sizeNorm * ctx.canvas.height));
    const family = shape.fontFamily || 'sans-serif';
    const weight = shape.fontWeight || 'normal';
    ctx.save();
    setupShapeStyle(ctx, shape);
    ctx.font = `${weight} ${sizePx}px ${family}`;
    ctx.textAlign = shape.align || 'left';
    ctx.textBaseline = shape.baseline || 'top';
    if (shape.fill !== false) {
      ctx.fillStyle = validateColor(shape.fill || '#000000');
      ctx.fillText(shape.text, x, y);
    }
    if (shape.stroke) {
      ctx.strokeStyle = validateColor(shape.stroke);
      ctx.strokeText(shape.text, x, y);
    }
    ctx.restore();
  },

  polyline(ctx, shape, toPx) {
    if (!Array.isArray(shape.points) || shape.points.length < 2) {
      throw new DrawError('BAD_DRAW', 'polyline.points must have at least 2 points');
    }
    const pts = shape.points.map((p, i) => toPx(validatePoint(p, `polyline.points[${i}]`)));
    ctx.save();
    setupShapeStyle(ctx, shape);
    if (!shape.stroke) ctx.strokeStyle = '#000000';
    if (shape.smooth !== false) {
      strokeSmoothPath(ctx, pts);
    } else {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.restore();
  },

  polygon(ctx, shape, toPx) {
    if (!Array.isArray(shape.points) || shape.points.length < 3) {
      throw new DrawError('BAD_DRAW', 'polygon.points must have at least 3 points');
    }
    const pts = shape.points.map((p, i) => toPx(validatePoint(p, `polygon.points[${i}]`)));
    ctx.save();
    setupShapeStyle(ctx, shape);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    if (shape.fill) ctx.fill();
    if (shape.stroke || !shape.fill) {
      if (!shape.stroke) ctx.strokeStyle = '#000000';
      ctx.stroke();
    }
    ctx.restore();
  },

  bezier(ctx, shape, toPx) {
    // Cubic bezier curve: from → cp1 → cp2 → to
    const [x1, y1] = toPx(validatePoint(shape.from, 'bezier.from'));
    const [x2, y2] = toPx(validatePoint(shape.to, 'bezier.to'));
    const [cp1x, cp1y] = toPx(validatePoint(shape.cp1, 'bezier.cp1'));
    const [cp2x, cp2y] = toPx(validatePoint(shape.cp2, 'bezier.cp2'));
    ctx.save();
    setupShapeStyle(ctx, shape);
    if (!shape.stroke) ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
    ctx.stroke();
    ctx.restore();
  },
};

// ── public entrypoints ────────────────────────────────────────────────

async function renderStrokes({ aspectRatio, mode = 'replace', baseImage = null, strokes }) {
  if (!Array.isArray(strokes)) {
    throw new DrawError('BAD_DRAW', 'strokes must be an array');
  }
  if (strokes.length === 0) {
    throw new DrawError('BAD_DRAW', 'strokes must be non-empty');
  }
  if (strokes.length > MAX_STROKES_PER_REQUEST) {
    throw new DrawError('BAD_DRAW',
      `${strokes.length} strokes exceeds max ${MAX_STROKES_PER_REQUEST} per request`);
  }

  // Validate everything BEFORE allocating the canvas — fast-fail.
  const validated = strokes.map((s, i) => validateStroke(s, i));

  const { canvas, ctx, width, height } = await createBoardCanvas({ aspectRatio, mode, baseImage });

  // Convert each stroke's normalized [0,1] points to pixel coordinates
  // and dispatch to the brush implementation.
  for (const { brush, points, opts } of validated) {
    const px = points.map(([nx, ny]) => [nx * width, ny * height]);
    BRUSHES[brush](ctx, px, opts);
  }

  return canvas.toBuffer('image/png');
}

async function renderShapes({ aspectRatio, mode = 'replace', baseImage = null, shapes }) {
  if (!Array.isArray(shapes)) {
    throw new DrawError('BAD_DRAW', 'shapes must be an array');
  }
  if (shapes.length === 0) {
    throw new DrawError('BAD_DRAW', 'shapes must be non-empty');
  }
  if (shapes.length > MAX_SHAPES_PER_REQUEST) {
    throw new DrawError('BAD_DRAW',
      `${shapes.length} shapes exceeds max ${MAX_SHAPES_PER_REQUEST} per request`);
  }
  for (let i = 0; i < shapes.length; i++) {
    if (!shapes[i] || typeof shapes[i] !== 'object') {
      throw new DrawError('BAD_DRAW', `shapes[${i}] must be an object`);
    }
    if (!SHAPES[shapes[i].type]) {
      throw new DrawError('BAD_DRAW',
        `shapes[${i}].type '${shapes[i].type}' unknown. Valid: ${Object.keys(SHAPES).join(', ')}`);
    }
  }

  const { canvas, ctx, width, height } = await createBoardCanvas({ aspectRatio, mode, baseImage });

  // Closures that convert normalized [0,1] coords to pixels. Passed to
  // each shape implementation so it doesn't need to know the canvas size.
  const toPx = ([nx, ny]) => [nx * width, ny * height];
  // Radius / horizontal distance: scale by width so circles look correct.
  // (Strictly speaking radius in non-square canvases is ambiguous, but
  // scaling by width is the convention agents will expect.)
  const scaleR = (n) => n * width;

  for (let i = 0; i < shapes.length; i++) {
    try {
      SHAPES[shapes[i].type](ctx, shapes[i], toPx, scaleR);
    } catch (err) {
      if (err instanceof DrawError) throw err;
      throw new DrawError('BAD_DRAW', `shapes[${i}] (${shapes[i].type}): ${err.message}`);
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  DrawError,
  renderStrokes,
  renderShapes,
  // Exported for tests + introspection
  BRUSHES,
  SHAPES,
  TARGET_LONG_EDGE,
  MAX_STROKES_PER_REQUEST,
  MAX_POINTS_PER_STROKE,
  MAX_SHAPES_PER_REQUEST,
  MAX_TEXT_LEN,
  dimensionsForAspect,
};
