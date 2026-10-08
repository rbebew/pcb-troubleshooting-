import type { Rect } from "./types";

export interface PixelImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes pr. pixel. */
  data: Uint8ClampedArray;
}

/**
 * Offline komponent-detektering uden AI.
 *
 * Idé: printpladens loddestopmaske (grøn, blå, sort …) er den mest udbredte farve.
 * Pixels der afviger tydeligt fra den farve er kandidater til komponenter. Masken
 * lukkes (så komponentlegemer hænger sammen) og åbnes (så tynde baner og silketryk
 * forsvinder), hvorefter sammenhængende områder bliver til bokse.
 *
 * Returnerer bokse i samme koordinatsystem som `img`.
 */
export function detectComponentsLocal(img: PixelImage): Rect[] {
  const { width: W, height: H, data } = img;
  const n = W * H;
  if (n === 0) return [];

  // 1. Dominerende farve (kvantiseret histogram, 4 bit pr. kanal).
  const counts = new Uint32Array(4096);
  const sums = new Float64Array(4096 * 3);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts[bin]++;
    sums[bin * 3] += r;
    sums[bin * 3 + 1] += g;
    sums[bin * 3 + 2] += b;
  }
  let best = 0;
  for (let i = 1; i < 4096; i++) if (counts[i] > counts[best]) best = i;
  const br = sums[best * 3] / counts[best];
  const bg = sums[best * 3 + 1] / counts[best];
  const bb = sums[best * 3 + 2] / counts[best];

  // 2. Afstand til pladefarve -> forgrundsmaske med adaptiv tærskel.
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dr = data[i * 4] - br;
    const dg = data[i * 4 + 1] - bg;
    const db = data[i * 4 + 2] - bb;
    dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }
  const sorted = Float32Array.from(dist).sort();
  const median = sorted[Math.floor(n * 0.5)];
  const threshold = Math.max(45, median * 2.5);
  let mask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = dist[i] > threshold ? 1 : 0;

  // 3. Morfologi: luk (dilate->erode) og åbn (erode->dilate).
  const r = Math.max(1, Math.round(Math.min(W, H) / 200));
  mask = erode(dilate(mask, W, H, r), W, H, r);
  mask = dilate(erode(mask, W, H, r), W, H, r);

  // 4. Sammenhængende områder.
  const labels = new Int32Array(n).fill(-1);
  const boxes: (Rect & { area: number })[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, area = 0;
    labels[start] = boxes.length;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p / W) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of nb) {
        if (q >= 0 && mask[q] && labels[q] === -1) {
          labels[q] = boxes.length;
          stack.push(q);
        }
      }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }

  // 5. Filtrér urealistiske områder.
  const minArea = n * 0.0002;
  const maxArea = n * 0.2;
  const kept = boxes.filter((b) => {
    const boxArea = b.w * b.h;
    if (b.area < minArea || boxArea > maxArea) return false;
    const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
    if (aspect > 8) return false;
    if (b.area / boxArea < 0.35) return false;
    // Ting der fylder hele kanten er typisk baggrund omkring printet.
    if (b.x === 0 && b.x + b.w >= W) return false;
    if (b.y === 0 && b.y + b.h >= H) return false;
    return true;
  });

  // Fjern bokse der ligger inde i andre.
  kept.sort((a, b) => b.w * b.h - a.w * a.h);
  const result: Rect[] = [];
  for (const b of kept) {
    const inside = result.some((o) => b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h);
    if (!inside) result.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    if (result.length >= 200) break;
  }
  return result;
}

function dilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return morph(src, W, H, r, 1);
}

function erode(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  return morph(src, W, H, r, 0);
}

/** Separabel kvadratisk morfologi. `hit` = 1 for dilate, 0 for erode. */
function morph(src: Uint8Array, W: number, H: number, r: number, hit: 0 | 1): Uint8Array {
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  const miss = hit ? 0 : 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = miss;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        const s = xx < 0 || xx >= W ? miss : src[y * W + xx];
        if (s === hit) {
          v = hit;
          break;
        }
      }
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = miss;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        const s = yy < 0 || yy >= H ? miss : tmp[yy * W + x];
        if (s === hit) {
          v = hit;
          break;
        }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

/**
 * Finder selve printpladen i et foto (til automatisk beskæring af bord/baggrund).
 *
 * Pladens farve bestemmes som den mest udbredte farvetone i midten af billedet. Alle pixels med
 * samme farvetone (eller lysstyrke for sorte/hvide plader) markeres, masken lukkes så komponenter
 * og silketryk bliver en del af pladen, og det største sammenhængende område nær midten vælges.
 * Returnerer null hvis pladen fylder (næsten) hele billedet eller ikke kan findes.
 */
export function detectBoard(img: PixelImage): Rect | null {
  const { width: W, height: H, data } = img;
  const n = W * H;
  if (n < 100) return null;
  const hue = new Float32Array(n);
  const sat = new Float32Array(n);
  const val = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let hh = 0;
    if (d > 1e-6) {
      if (max === r) hh = ((g - b) / d) % 6;
      else if (max === g) hh = (b - r) / d + 2;
      else hh = (r - g) / d + 4;
      hh *= 60;
      if (hh < 0) hh += 360;
    }
    hue[i] = hh;
    sat[i] = max > 0 ? d / max : 0;
    val[i] = max;
  }

  // Dominerende farvetone i den midterste fjerdedel.
  const bins = new Float32Array(36);
  let satSum = 0, valSum = 0, cnt = 0;
  for (let y = Math.floor(H * 0.3); y < H * 0.7; y++) {
    for (let x = Math.floor(W * 0.3); x < W * 0.7; x++) {
      const i = y * W + x;
      bins[Math.floor(hue[i] / 10) % 36] += sat[i];
      satSum += sat[i];
      valSum += val[i];
      cnt++;
    }
  }
  let best = 0;
  for (let i = 1; i < 36; i++) if (bins[i] > bins[best]) best = i;
  const boardHue = best * 10 + 5;
  const colorful = satSum / cnt > 0.18;
  const meanVal = valSum / cnt;

  let mask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (colorful) {
      const dh = Math.min(Math.abs(hue[i] - boardHue), 360 - Math.abs(hue[i] - boardHue));
      mask[i] = dh < 25 && sat[i] > 0.15 ? 1 : 0;
    } else {
      mask[i] = Math.abs(val[i] - meanVal) < 0.18 ? 1 : 0;
    }
  }
  const r = Math.max(2, Math.round(Math.min(W, H) * 0.02));
  mask = erode(dilate(mask, W, H, r), W, H, r);

  // Største sammenhængende område der rører midten.
  const seen = new Uint8Array(n);
  let bestBox: Rect | null = null;
  let bestArea = 0;
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || seen[start]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, area = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p / W) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
      if (y > 0 && mask[p - W] && !seen[p - W]) (seen[p - W] = 1), stack.push(p - W);
      if (y < H - 1 && mask[p + W] && !seen[p + W]) (seen[p + W] = 1), stack.push(p + W);
    }
    const touchesCenter = minX < W * 0.6 && maxX > W * 0.4 && minY < H * 0.6 && maxY > H * 0.4;
    if (touchesCenter && area > bestArea) {
      bestArea = area;
      bestBox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
  }
  if (!bestBox || bestArea < n * 0.1) return null;
  // Lidt luft rundt om pladen.
  const m = Math.round(Math.min(W, H) * 0.015);
  const box = {
    x: Math.max(0, bestBox.x - m),
    y: Math.max(0, bestBox.y - m),
    w: 0,
    h: 0,
  };
  box.w = Math.min(W, bestBox.x + bestBox.w + m) - box.x;
  box.h = Math.min(H, bestBox.y + bestBox.h + m) - box.y;
  if (box.w * box.h > n * 0.92) return null;
  return box;
}
