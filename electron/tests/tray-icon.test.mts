import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDiamondIconPng } = require('../tray-icon.cjs');

function readIhdr(png: Buffer) {
  // PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) → 13-byte IHDR payload starts at 16.
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png.readUInt8(24),
    colorType: png.readUInt8(25),
  };
}

test('buildDiamondIconPng produces a real, well-formed PNG at the requested size', () => {
  const png = buildDiamondIconPng(32);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'PNG signature');
  const ihdr = readIhdr(png);
  assert.equal(ihdr.width, 32);
  assert.equal(ihdr.height, 32);
  assert.equal(ihdr.bitDepth, 8);
  assert.equal(ihdr.colorType, 6, 'RGBA color type');
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});

test('buildDiamondIconPng honors a custom size', () => {
  const png = buildDiamondIconPng(16);
  const ihdr = readIhdr(png);
  assert.equal(ihdr.width, 16);
  assert.equal(ihdr.height, 16);
});

test('buildDiamondIconPng draws something: not every pixel is fully transparent', () => {
  // Fastest real signal without a PNG decoder: the raw (pre-compression) pixel buffer this module
  // builds is exercised indirectly through encodePng — re-import the same module's internals.
  const { diamondRgba } = require('../tray-icon.cjs');
  const rgba = diamondRgba(32);
  let opaquePixels = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) opaquePixels++;
  assert.ok(opaquePixels > 0, 'at least some pixels must be opaque, or the tray icon would be invisible');
  assert.ok(opaquePixels < 32 * 32, 'the corners (outside the circle) must stay transparent');
});
