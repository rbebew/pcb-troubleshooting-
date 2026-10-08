/**
 * Finder hvor et nærbillede sidder på oversigtsbilledet (billedregistrering).
 *
 * Metode: normaliseret krydskorrelation (NCC) på gråtoner, grov-til-fin:
 * 1. Grov søgning over alle positioner, mange størrelser og (valgfrit) 4 rotationer
 *    med en lille skabelon (nærbilledet skaleret ned til ~20 px bredde).
 * 2. De bedste kandidater forfines med en større skabelon i et lille vindue.
 * NCC er ufølsom over for lysstyrke og kontrast, så forskellig belysning gør ikke så meget.
 * Perspektiv håndteres ikke – billederne skal være taget nogenlunde lige oppefra.
 */

export interface Gray {
  w: number;
  h: number;
  d: Float32Array;
}

export interface Match {
  /** Område i oversigtens koordinater (samme enhed som `overview` der blev givet). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Antal kvart-omgange med uret nærbilledet skal drejes for at passe. */
  rot: 0 | 1 | 2 | 3;
  /** NCC-score fra -1 til 1. Over ca. 0,6 er et sikkert match. */
  score: number;
}

export interface Hint {
  /** Område i brøkdele (0-1) af oversigtens bredde/højde. */
  x: number;
  y: number;
  w: number;
  h: number;
  rot: 0 | 1 | 2 | 3;
}

export function grayFromRgba(width: number, height: number, data: Uint8ClampedArray): Gray {
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { w: width, h: height, d };
}

/** Skalering med område-gennemsnit (god til nedskalering) og bilineær opskalering. */
export function resize(g: Gray, w: number, h: number): Gray {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const out = new Float32Array(w * h);
  const sx = g.w / w;
  const sy = g.h / h;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.min(g.h, Math.floor((y + 1) * sy)));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(g.w, Math.floor((x + 1) * sx)));
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += g.d[yy * g.w + xx];
        out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const fy = Math.min(g.h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(g.h - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(g.w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(g.w - 1, x0 + 1);
        const tx = fx - x0;
        const a = g.d[y0 * g.w + x0] * (1 - tx) + g.d[y0 * g.w + x1] * tx;
        const b = g.d[y1 * g.w + x0] * (1 - tx) + g.d[y1 * g.w + x1] * tx;
        out[y * w + x] = a * (1 - ty) + b * ty;
      }
    }
  }
  return { w, h, d: out };
}

/** Drejer `times` kvart-omgange med uret. */
export function rotate90(g: Gray, times: number): Gray {
  let cur = g;
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    const out = new Float32Array(cur.w * cur.h);
    const W = cur.h;
    const H = cur.w;
    for (let y = 0; y < cur.h; y++) for (let x = 0; x < cur.w; x++) out[x * W + (W - 1 - y)] = cur.d[y * cur.w + x];
    cur = { w: W, h: H, d: out };
  }
  return cur;
}

interface Template {
  w: number;
  h: number;
  /** Middelværdi-fratrukne værdier. */
  t: Float32Array;
  norm: number;
}

function makeTemplate(g: Gray, w: number, h: number): Template | null {
  const r = resize(g, w, h);
  const n = r.w * r.h;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += r.d[i];
  mean /= n;
  const t = new Float32Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    t[i] = r.d[i] - mean;
    ss += t[i] * t[i];
  }
  if (ss < 1e-6 * n) return null; // ensfarvet billede – intet at matche på
  return { w: r.w, h: r.h, t, norm: Math.sqrt(ss) };
}

/** Summerede-areal-tabeller for hurtig middelværdi/varians i et vindue. */
function integrals(g: Gray): { s: Float64Array; s2: Float64Array } {
  const W = g.w + 1;
  const s = new Float64Array(W * (g.h + 1));
  const s2 = new Float64Array(W * (g.h + 1));
  for (let y = 0; y < g.h; y++) {
    let row = 0;
    let row2 = 0;
    for (let x = 0; x < g.w; x++) {
      const v = g.d[y * g.w + x];
      row += v;
      row2 += v * v;
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row;
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + row2;
    }
  }
  return { s, s2 };
}

interface Hit {
  x: number;
  y: number;
  score: number;
}

/** NCC for alle positioner i vinduet [x0,x1]×[y0,y1] med givet skridt. Returnerer de bedste lokale fund. */
function search(o: Gray, tp: Template, x0: number, y0: number, x1: number, y1: number, step: number, keep: number): Hit[] {
  const { s, s2 } = integrals(o);
  const W = o.w + 1;
  const n = tp.w * tp.h;
  const hits: Hit[] = [];
  x1 = Math.min(x1, o.w - tp.w);
  y1 = Math.min(y1, o.h - tp.h);
  for (let y = Math.max(0, y0); y <= y1; y += step) {
    for (let x = Math.max(0, x0); x <= x1; x += step) {
      const a = y * W + x;
      const b = y * W + x + tp.w;
      const c = (y + tp.h) * W + x;
      const d = (y + tp.h) * W + x + tp.w;
      const sum = s[d] - s[b] - s[c] + s[a];
      const sum2 = s2[d] - s2[b] - s2[c] + s2[a];
      const varO = sum2 - (sum * sum) / n;
      if (varO <= 1e-6 * n) continue;
      let dot = 0;
      for (let ty = 0; ty < tp.h; ty++) {
        const orow = (y + ty) * o.w + x;
        const trow = ty * tp.w;
        for (let tx = 0; tx < tp.w; tx++) dot += o.d[orow + tx] * tp.t[trow + tx];
      }
      const score = dot / (Math.sqrt(varO) * tp.norm);
      if (hits.length < keep || score > hits[hits.length - 1].score) {
        hits.push({ x, y, score });
        hits.sort((p, q) => q.score - p.score);
        if (hits.length > keep) hits.pop();
      }
    }
  }
  return hits;
}

interface Candidate {
  /** Alt i brøkdele af oversigten. */
  fx: number;
  fy: number;
  fw: number;
  rot: 0 | 1 | 2 | 3;
  score: number;
}

const COARSE_W = 28;
const FINE_W = 56;

/**
 * Finder nærbilledets placering. `overview` bør være ca. 500-800 px bred og `detail` ca. 300-600 px.
 * Returnerer det bedste match (også selv om det er dårligt – se `score`).
 */
export async function locateDetail(
  overview: Gray,
  detail: Gray,
  opts: { rotations?: (0 | 1 | 2 | 3)[]; hint?: Hint; onProgress?: (frac: number) => void } = {},
): Promise<Match | null> {
  const rotations = opts.hint ? [opts.hint.rot] : (opts.rotations ?? [0]);
  const hint = opts.hint;
  const O = overview;
  let candidates: Candidate[] = [];
  let done = 0;

  for (const rot of rotations) {
    const D = rotate90(detail, rot);
    const aspect = D.h / D.w;
    const gy = Math.max(6, Math.round(COARSE_W * aspect));
    const tp = makeTemplate(D, COARSE_W, gy);
    if (!tp) return null;

    // Størrelser: nærbilledets bredde som brøkdel af oversigtens bredde.
    const maxF = Math.min(1, O.h / (O.w * aspect));
    let fMin = 0.05;
    let fMax = maxF;
    if (hint) {
      fMin = Math.max(fMin, hint.w * 0.7);
      fMax = Math.min(fMax, hint.w * 1.4);
    }
    const scales: number[] = [];
    for (let f = fMin; f <= fMax * 1.0001; f *= 1.07) scales.push(f);

    for (const f of scales) {
      // Skalér oversigten så nærbilledets område bliver COARSE_W px bredt.
      const Wz = COARSE_W / f;
      const Hz = (Wz * O.h) / O.w;
      if (Wz < COARSE_W || Hz < gy) continue;
      const Oz = resize(O, Wz, Hz);
      let x0 = 0, y0 = 0, x1 = Oz.w, y1 = Oz.h;
      if (hint) {
        const mx = 0.2 * Oz.w;
        const my = 0.2 * Oz.h;
        x0 = Math.floor(hint.x * Oz.w - mx);
        x1 = Math.ceil(hint.x * Oz.w + mx);
        y0 = Math.floor(hint.y * Oz.h - my);
        y1 = Math.ceil(hint.y * Oz.h + my);
      }
      const step = Oz.w > 160 ? 2 : 1;
      for (const hit of search(Oz, tp, x0, y0, x1, y1, step, 3)) {
        candidates.push({ fx: hit.x / Oz.w, fy: hit.y / Oz.h, fw: f, rot, score: hit.score });
      }
      done++;
      if (done % 6 === 0) {
        opts.onProgress?.(done / (scales.length * rotations.length));
        await new Promise((r) => setTimeout(r)); // giv brugerfladen luft
      }
    }
  }
  if (!candidates.length) return null;

  // Behold de bedste, indbyrdes forskellige kandidater.
  candidates.sort((a, b) => b.score - a.score);
  const distinct: Candidate[] = [];
  for (const c of candidates) {
    if (distinct.some((d) => d.rot === c.rot && Math.abs(d.fx - c.fx) < d.fw * 0.3 && Math.abs(d.fy - c.fy) < d.fw * 0.3 && Math.abs(Math.log(d.fw / c.fw)) < 0.2)) continue;
    distinct.push(c);
    if (distinct.length >= 10) break;
  }

  // Forfin hver kandidat med en større skabelon, og verificér på oversigtens egen opløsning.
  let best: Match | null = null;
  for (const c of distinct) {
    let refined: Match | null = null;
    const D = rotate90(detail, c.rot);
    const aspect = D.h / D.w;
    const fine = makeTemplate(D, FINE_W, Math.max(8, Math.round(FINE_W * aspect)));
    if (!fine) continue;
    for (const k of [0.94, 0.97, 1, 1.03, 1.06]) {
      const f = c.fw * k;
      const Wz = FINE_W / f;
      const Hz = (Wz * O.h) / O.w;
      if (Wz < FINE_W || Hz < fine.h) continue;
      const Oz = resize(O, Wz, Hz);
      const cx = Math.round(c.fx * Oz.w);
      const cy = Math.round(c.fy * Oz.h);
      const r = Math.ceil((Oz.w / (COARSE_W / c.fw)) * 3) + 2; // ca. 3 grove pixels
      const [hit] = search(Oz, fine, cx - r, cy - r, cx + r, cy + r, 1, 1);
      if (hit && (!refined || hit.score > refined.score)) {
        refined = {
          x: (hit.x / Oz.w) * O.w,
          y: (hit.y / Oz.h) * O.h,
          w: f * O.w,
          h: f * O.w * aspect,
          rot: c.rot,
          score: hit.score,
        };
      }
    }
    if (refined) {
      refined.score = verify(O, D, refined);
      if (!best || refined.score > best.score) best = refined;
    }
    await new Promise((r) => setTimeout(r));
  }
  opts.onProgress?.(1);
  return best;
}

/**
 * Sammenligner nærbilledet med området på oversigten i oversigtens egen opløsning (højst 128 px),
 * både på lysstyrke og på kanter. Et tilfældigt match er sjældent godt på begge.
 * Meget små områder giver for lidt at sammenligne på og straffes.
 */
function verify(O: Gray, D: Gray, m: Match): number {
  const vw = Math.min(128, m.w);
  if (vw < 12) return 0;
  const k = vw / m.w;
  const vh = Math.max(4, Math.round(m.h * k));
  const Ok = k < 1 ? resize(O, O.w * k, O.h * k) : O;
  const x0 = Math.round(m.x * k);
  const y0 = Math.round(m.y * k);
  const w = Math.min(Math.round(vw), Ok.w - x0);
  const h = Math.min(vh, Ok.h - y0);
  if (w < 8 || h < 4) return 0;
  const win = { w, h, d: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) win.d[y * w + x] = Ok.d[(y0 + y) * Ok.w + x0 + x];
  const tpl = resize(D, w, h);
  const luma = ncc(win, tpl);
  const edges = ncc(gradient(win), gradient(tpl));
  const sizePenalty = Math.min(1, vw / 60);
  return Math.min(luma, edges) * sizePenalty;
}

function ncc(a: Gray, b: Gray): number {
  const n = a.d.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a.d[i];
    mb += b.d[i];
  }
  ma /= n;
  mb /= n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) {
    const da = a.d[i] - ma;
    const db = b.d[i] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Kantstyrke (Sobel). */
function gradient(g: Gray): Gray {
  const out = new Float32Array(g.w * g.h);
  for (let y = 1; y < g.h - 1; y++) {
    for (let x = 1; x < g.w - 1; x++) {
      const i = y * g.w + x;
      const gx = g.d[i - g.w + 1] + 2 * g.d[i + 1] + g.d[i + g.w + 1] - g.d[i - g.w - 1] - 2 * g.d[i - 1] - g.d[i + g.w - 1];
      const gy = g.d[i + g.w - 1] + 2 * g.d[i + g.w] + g.d[i + g.w + 1] - g.d[i - g.w - 1] - 2 * g.d[i - g.w] - g.d[i - g.w + 1];
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { w: g.w, h: g.h, d: out };
}
