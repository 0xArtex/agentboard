/**
 * blank-png.js — generate a blank (transparent) PNG of arbitrary dimensions
 *
 * Storyboarder treats every board as a stack of fixed-size raster layers, and
 * the sketch-pane initialises its render targets from the dimensions of the
 * first image it loads. If we hand it a 1×1 placeholder, downstream PIXI state
 * transitions choke ("transitionToState undefined") and the canvas comes up
 * with the wrong size. So we need a real PNG sized to match the project's
 * aspect ratio whenever we bootstrap a new board.
 *
 * Implementation note: rather than pulling in pngjs/sharp/canvas, we encode a
 * minimal RGBA PNG directly using Node's built-in zlib. The image data is all
 * zeros (fully transparent) so deflate compresses it down to a few KB even
 * for 1920×1080.
 */

const zlib = require('zlib');

// Standard PNG signature.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Pre-computed CRC32 table (IEEE 802.3 polynomial).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Build a fully-transparent RGBA PNG of the given dimensions.
 * @param {number} width  pixels
 * @param {number} height pixels
 * @returns {Buffer}
 */
function blankPng(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`blankPng: invalid dimensions ${width}x${height}`);
  }

  // IHDR: width(4), height(4), bit_depth(1)=8, colour_type(1)=6 (RGBA),
  // compression(1)=0, filter(1)=0, interlace(1)=0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // IDAT: per-scanline filter byte (0 = None) followed by RGBA pixels.
  // We allocate a single zero-filled buffer, then deflate it. Pre-allocating
  // avoids the cost of N row appends, and zlib collapses the long zero run
  // down to a few KB regardless of dimensions.
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height); // already zero-filled
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Pick reasonable pixel dimensions for a given aspect ratio. Storyboarder's
 * default project is 16:9, which we render at 1920×1080. For other ratios we
 * keep the height at 1080 and scale width to match (rounded to even pixels so
 * downstream video exports stay happy).
 */
function dimensionsForAspect(aspectRatio) {
  const ar = Number(aspectRatio) || 1.7777;
  const height = 1080;
  let width = Math.round(height * ar);
  if (width % 2) width += 1;
  return { width, height };
}

module.exports = { blankPng, dimensionsForAspect };
