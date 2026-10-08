import type { PcbComponent, Rect } from "./types";

/**
 * Sammenfletter komponenter fundet i overlappende felter (og evt. en analyse af hele billedet).
 * Den samme komponent findes ofte i to felter, eller både i helheden og i et felt.
 */

export interface TileDetection {
  /** Feltets område i billedets koordinater. */
  tile: Rect;
  components: PcbComponent[];
}

export interface MergeResult {
  components: PcbComponent[];
  /** Komponent-id fra helheds-analysen -> id på den komponent der blev beholdt i stedet. */
  remap: Map<string, string>;
}

function iou(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

function centerInside(a: Rect, b: Rect): boolean {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
}

/** Er a og b sandsynligvis samme fysiske komponent? */
export function sameComponent(a: Rect, b: Rect): boolean {
  if (iou(a, b) > 0.3) return true;
  const ratio = Math.min(a.w * a.h, b.w * b.h) / Math.max(a.w * a.h, b.w * b.h);
  // En komponent skåret over ved feltkanten giver en mindre boks inde i den hele.
  return ratio > 0.2 && (centerInside(a, b) || centerInside(b, a)) && iou(a, b) > 0.12;
}

/** Hvor langt boksen ligger fra feltets kant, relativt til boksens størrelse (lille = skåret over). */
function edgeMargin(c: Rect, tile: Rect): number {
  const m = Math.min(c.x - tile.x, c.y - tile.y, tile.x + tile.w - (c.x + c.w), tile.y + tile.h - (c.y + c.h));
  return m / Math.max(c.w, c.h);
}

function combine(keep: PcbComponent, other: PcbComponent): PcbComponent {
  return {
    ...keep,
    designator: keep.designator || other.designator,
    value: keep.value || other.value,
    description: keep.description || other.description,
    damage: [keep.damage, other.damage].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join("; "),
    status: keep.status === "suspect" || other.status === "suspect" ? "suspect" : keep.status,
  };
}

/**
 * @param whole Komponenter fra analysen af hele billedet (bevares for store komponenter).
 * @param tiles Komponenter fra hvert felt.
 * @param imageArea Billedets areal – komponenter over 1,5 % af det regnes som "store".
 */
export function mergeDetections(whole: PcbComponent[], tiles: TileDetection[], imageArea: number): MergeResult {
  // 1. Flet felterne indbyrdes: ved dubletter beholdes den der ligger længst fra feltkanten.
  const fromTiles: { c: PcbComponent; margin: number }[] = [];
  for (const t of tiles) {
    for (const c of t.components) {
      const margin = edgeMargin(c, t.tile);
      const dup = fromTiles.findIndex((e) => sameComponent(e.c, c));
      if (dup < 0) fromTiles.push({ c, margin });
      else if (margin > fromTiles[dup].margin) fromTiles[dup] = { c: combine(c, fromTiles[dup].c), margin };
      else fromTiles[dup].c = combine(fromTiles[dup].c, c);
    }
  }

  // 2. Flet med helheden: store komponenter tages fra helheden (de er ofte skåret over i felterne),
  //    små fra felterne (bedre opløsning).
  const remap = new Map<string, string>();
  const result: PcbComponent[] = [];
  const used = new Set<number>();
  for (const w of whole) {
    const i = fromTiles.findIndex((e, idx) => !used.has(idx) && sameComponent(e.c, w));
    if (i < 0) {
      result.push(w);
      continue;
    }
    used.add(i);
    const big = w.w * w.h > imageArea * 0.015;
    if (big) result.push(combine(w, fromTiles[i].c));
    else {
      const kept = combine(fromTiles[i].c, w);
      result.push(kept);
      remap.set(w.id, kept.id);
    }
  }
  fromTiles.forEach((e, idx) => {
    if (!used.has(idx)) result.push(e.c);
  });
  return { components: result, remap };
}

/** Deler et billede i overlappende felter, så hvert felt højst er ca. `maxSide / grid` stort. */
export function makeTiles(width: number, height: number, grid: number, overlap = 0.12): Rect[] {
  const size = Math.max(width, height) / grid;
  // Lidt tolerance, så 3,05 felter ikke bliver til 4.
  const cols = Math.max(1, Math.ceil(width / size - 0.1));
  const rows = Math.max(1, Math.ceil(height / size - 0.1));
  const tw = width / cols;
  const th = height / rows;
  const ox = tw * overlap;
  const oy = th * overlap;
  const tiles: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.max(0, c * tw - ox);
      const y = Math.max(0, r * th - oy);
      tiles.push({ x, y, w: Math.min(width, (c + 1) * tw + ox) - x, h: Math.min(height, (r + 1) * th + oy) - y });
    }
  }
  return tiles;
}
