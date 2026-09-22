'use strict';

// Paints a red recording dot into the bottom-right corner of a BGRA bitmap (the layout of
// Electron's NativeImage.toBitmap() on Windows). Pure, so the tray can show "recording"
// without shipping a second icon file.
const DOT = { b: 0x3b, g: 0x3b, r: 0xe5 };

function withRecordingDot(bitmap, width, height) {
  const out = Buffer.from(bitmap);
  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.22));
  const cx = width - radius - 1, cy = height - radius - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius + 1) continue;
      const i = (y * width + x) * 4;
      if (d > radius) { out[i] = 0xff; out[i + 1] = 0xff; out[i + 2] = 0xff; out[i + 3] = 0xff; continue; }
      out[i] = DOT.b; out[i + 1] = DOT.g; out[i + 2] = DOT.r; out[i + 3] = 0xff;
    }
  }
  return out;
}

module.exports = { withRecordingDot };
