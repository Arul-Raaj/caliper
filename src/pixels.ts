// Reads Caliper's own screenshots, so a rule can judge what really reached the
// screen. Only what Playwright writes is supported: 8-bit RGB or RGBA PNGs.

import { inflateSync } from "node:zlib";

export interface Raster { width: number; height: number; channels: number; data: Uint8Array }
export interface Area { x: number; y: number; width: number; height: number }

export function decodePng(png: Buffer): Raster {
  let width = 0;
  let height = 0;
  let channels = 0;
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") {
      width = png.readUInt32BE(at + 8);
      height = png.readUInt32BE(at + 12);
      const [depth, color, , , interlace] = png.subarray(at + 16, at + 21);
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace) throw new Error("Unsupported PNG");
      channels = color === 6 ? 4 : 3;
    }
    if (type === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const from = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? data[row + i - channels]! : 0;
      const up = y ? data[row + i - stride]! : 0;
      const corner = y && i >= channels ? data[row + i - stride - channels]! : 0;
      const value = raw[from + i]!;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predicted = a <= b && a <= c ? left : b <= c ? up : corner;
      }
      data[row + i] = (value + predicted) & 255;
    }
  }
  return { width, height, channels, data };
}

// WCAG relative luminance and contrast ratio.
const LINEAR = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const luminance = (r: number, g: number, b: number) => 0.2126 * LINEAR[r]! + 0.7152 * LINEAR[g]! + 0.0722 * LINEAR[b]!;
export function contrast(a: readonly number[], b: readonly number[]): number {
  const [x, y] = [luminance(a[0]!, a[1]!, a[2]!), luminance(b[0]!, b[1]!, b[2]!)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;
const FAINT = 1.3; // below this contrast, a pixel can't be told from what is behind it

export interface Ink {
  ink: string; // the image's most common colour
  back: string; // the most common colour behind it
  contrast: number; // between those two
  visible: number; // share of the image's pixels that stand out, 0 to 1
  vanishes: boolean; // almost nothing stands out
}

// Three screenshots of the same page: as shown, with the images hidden (what
// is behind them), and with them inverted. A pixel that inverts belongs to the
// image, so a transparent corner, or an image covered by something else, never
// counts as ink. Null when the area holds almost no ink: nothing to judge.
export function inkIn(shown: Raster, behind: Raster, inverted: Raster, area: Area): Ink | null {
  const { width, height, channels } = shown;
  const left = Math.max(0, area.x);
  const top = Math.max(0, area.y);
  const right = Math.min(width, area.x + area.width);
  const bottom = Math.min(height, area.y + area.height);
  const inks = new Map<number, number>();
  const backs = new Map<number, number>();
  let total = 0;
  let inked = 0;
  let visible = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      total++;
      const at = (y * width + x) * channels;
      const [r, g, b] = [shown.data[at]!, shown.data[at + 1]!, shown.data[at + 2]!];
      if (r === inverted.data[at] && g === inverted.data[at + 1] && b === inverted.data[at + 2]) continue;
      const [br, bg, bb] = [behind.data[at]!, behind.data[at + 1]!, behind.data[at + 2]!];
      inked++;
      if (contrast([r, g, b], [br, bg, bb]) >= FAINT) visible++;
      const ink = (r << 16) | (g << 8) | b;
      const back = (br << 16) | (bg << 8) | bb;
      inks.set(ink, (inks.get(ink) ?? 0) + 1);
      backs.set(back, (backs.get(back) ?? 0) + 1);
    }
  }
  if (inked < 4 || inked < total * 0.005) return null;
  const top1 = (counts: Map<number, number>) => [...counts].reduce((best, next) => (next[1] > best[1] ? next : best))[0];
  const [ink, back] = [top1(inks), top1(backs)];
  const rgb = (c: number) => [c >> 16, (c >> 8) & 255, c & 255];
  // A count as well as a share: one thin line on a big white tile is well
  // under 1% of its pixels, and you can still see it.
  const vanishes = visible < Math.min(12, inked * 0.01);
  return { ink: hex(ink), back: hex(back), contrast: contrast(rgb(ink), rgb(back)), visible: visible / inked, vanishes };
}

// The most common colour in an area of a screenshot, as [r, g, b].
export function commonColor(raster: Raster, area: Area): [number, number, number] | null {
  const { width, height, channels, data } = raster;
  const counts = new Map<number, number>();
  for (let y = Math.max(0, area.y); y < Math.min(height, area.y + area.height); y++) {
    for (let x = Math.max(0, area.x); x < Math.min(width, area.x + area.width); x++) {
      const at = (y * width + x) * channels;
      const c = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  if (!counts.size) return null;
  const c = [...counts].reduce((best, next) => (next[1] > best[1] ? next : best))[0];
  return [c >> 16, (c >> 8) & 255, c & 255];
}

const EDGE = 1.1; // below this contrast, an image's edge can't be told from what is around it

export interface Edge {
  edges: number; // pixels on the image's outline
  lost: number; // of those, how many melt into the pixel just outside
}

// Where an image meets what is around it. A pixel of the image (one that
// changes when the image is inverted) is on its outline when the pixel two
// steps away is not part of the image. Its edge is lost when it has almost
// no contrast with that outside pixel, as shown on screen: a white photo on
// a white page, with no change of hue either. A ring drawn over the edge (an outline, an inset shadow, a
// border layer) changes the shown pixels, so it counts as an edge.
export function edgeOf(shown: Raster, inverted: Raster, area: Area): Edge {
  const { width, height, channels } = shown;
  const at = (x: number, y: number) => (y * width + x) * channels;
  const inImage = (x: number, y: number) => {
    if (x < area.x || y < area.y || x >= area.x + area.width || y >= area.y + area.height || x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = at(x, y);
    return shown.data[i] !== inverted.data[i] || shown.data[i + 1] !== inverted.data[i + 1] || shown.data[i + 2] !== inverted.data[i + 2];
  };
  const pixel = (x: number, y: number) => {
    const i = at(Math.min(width - 1, Math.max(0, x)), Math.min(height - 1, Math.max(0, y)));
    return [shown.data[i]!, shown.data[i + 1]!, shown.data[i + 2]!];
  };
  let edges = 0;
  let lost = 0;
  for (let y = Math.max(0, area.y); y < Math.min(height, area.y + area.height); y++) {
    for (let x = Math.max(0, area.x); x < Math.min(width, area.x + area.width); x++) {
      if (!inImage(x, y)) continue;
      const out = ([[2, 0], [-2, 0], [0, 2], [0, -2]] as const).find(([dx, dy]) => !inImage(x + dx, y + dy));
      if (!out) continue;
      // Step past any anti-aliased rim to what really sits outside.
      const [ox, oy] = [x + out[0] * 2, y + out[1] * 2];
      edges++;
      // Hue counts as much as lightness: a yellow photo on a pale grey page
      // has the same luminance and a plain edge.
      const [a, b] = [pixel(x, y), pixel(ox, oy)];
      if (contrast(a, b) < EDGE && Math.max(...a.map((v, i) => Math.abs(v - b[i]!))) < 24) lost++;
    }
  }
  return { edges, lost };
}
