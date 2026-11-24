/**
 * Box-filtered thumbnail built from rows, so a 100-megapixel image is never
 * cloned or fully copied out of wasm memory just to draw a 96 px preview.
 */
export interface Thumb {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/**
 * @param row returns the RGBA bytes (width*4) of source row y. May return a view
 *            that is only valid until the next call.
 */
export function thumbFromRows(width: number, height: number, row: (y: number) => ArrayLike<number>, maxSide = 96): Thumb {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(tw * th * 4);
  const cellW = width / tw;
  const cellH = height / th;
  const rowsPerCell = Math.max(1, Math.min(4, Math.round(cellH)));
  for (let ty = 0; ty < th; ty++) {
    const acc = new Float64Array(tw * 4); // premultiplied r,g,b + alpha sum
    const cnt = new Float64Array(tw);
    for (let k = 0; k < rowsPerCell; k++) {
      const sy = Math.min(height - 1, Math.floor(ty * cellH + ((k + 0.5) * cellH) / rowsPerCell));
      const r = row(sy);
      for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor(tx * cellW);
        const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((tx + 1) * cellW)));
        for (let x = x0; x < x1; x++) {
          const i = x * 4;
          const a = r[i + 3]!;
          acc[tx * 4] = acc[tx * 4]! + r[i]! * a;
          acc[tx * 4 + 1] = acc[tx * 4 + 1]! + r[i + 1]! * a;
          acc[tx * 4 + 2] = acc[tx * 4 + 2]! + r[i + 2]! * a;
          acc[tx * 4 + 3] = acc[tx * 4 + 3]! + a;
          cnt[tx] = cnt[tx]! + 1;
        }
      }
    }
    for (let tx = 0; tx < tw; tx++) {
      const o = (ty * tw + tx) * 4;
      const aSum = acc[tx * 4 + 3]!;
      if (aSum > 0) {
        out[o] = acc[tx * 4]! / aSum;
        out[o + 1] = acc[tx * 4 + 1]! / aSum;
        out[o + 2] = acc[tx * 4 + 2]! / aSum;
        out[o + 3] = aSum / cnt[tx]!;
      }
    }
  }
  return { width: tw, height: th, rgba: out };
}
