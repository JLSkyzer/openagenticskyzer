// A tiny, dependency-free PNG encoder for the system tray icon — matches the previous NiceGUI
// app's PIL-drawn icon (purple circle, white diamond, purple inner diamond) without pulling in an
// image library or checking a binary asset into the repo.
const zlib = require('node:zlib');

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** RGBA pixel buffer: purple circle, white diamond, purple inner diamond — see notifier.py's sibling, _make_tray_image. */
function diamondRgba(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size / 2 - 1;
  const outer = size * 0.32;
  const inner = size * 0.16;
  const PURPLE = [88, 28, 135];
  const WHITE = [255, 255, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - center + 0.5;
      const dy = y - center + 0.5;
      if (dx * dx + dy * dy > radius * radius) continue; // stays transparent outside the circle
      const manhattan = Math.abs(dx) + Math.abs(dy);
      const [r, g, b] = manhattan <= inner ? PURPLE : manhattan <= outer ? WHITE : PURPLE;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function buildDiamondIconPng(size = 32) {
  return encodePng(size, size, diamondRgba(size));
}

/** The tray's context menu, as a template for Menu.buildFromTemplate. Pure, so a test can check which function each
 * item calls — a native tray menu cannot be clicked from a test. main.cjs passes showMainWindow and app.quit. */
function trayMenuTemplate({ open, quit }) {
  return [
    { label: 'Ouvrir openagent', click: open },
    { type: 'separator' },
    { label: 'Quitter', click: quit },
  ];
}

module.exports = { buildDiamondIconPng, diamondRgba, encodePng, trayMenuTemplate };
