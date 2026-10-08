import type { PcbComponent, Point, Probe, Rect, Trace } from "./types";

export function pointInRect(p: Point, r: Rect, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const tl = { x: r.x, y: r.y };
  const tr = { x: r.x + r.w, y: r.y };
  const br = { x: r.x + r.w, y: r.y + r.h };
  const bl = { x: r.x, y: r.y + r.h };
  return (
    segmentsIntersect(a, b, tl, tr) ||
    segmentsIntersect(a, b, tr, br) ||
    segmentsIntersect(a, b, br, bl) ||
    segmentsIntersect(a, b, bl, tl)
  );
}

/**
 * Komponenter som strømvejen (alle traces på et net) passerer, i den rækkefølge
 * de mødes når man følger hver trace fra første til sidste punkt.
 */
export function componentsAlongNet(netId: string, traces: Trace[], components: PcbComponent[]): PcbComponent[] {
  const seen = new Set<string>();
  const ordered: PcbComponent[] = [];
  for (const tr of traces) {
    if (tr.netId !== netId) continue;
    const pts = tr.points;
    for (let i = 0; i < pts.length; i++) {
      const hits: { c: PcbComponent; d: number }[] = [];
      for (const c of components) {
        if (seen.has(c.id)) continue;
        const hit =
          pts.length === 1 || i === pts.length - 1
            ? pointInRect(pts[i], c)
            : segmentIntersectsRect(pts[i], pts[i + 1], c);
        if (hit) hits.push({ c, d: Math.hypot(c.x + c.w / 2 - pts[i].x, c.y + c.h / 2 - pts[i].y) });
      }
      hits.sort((a, b) => a.d - b.d);
      for (const h of hits) {
        seen.add(h.c.id);
        ordered.push(h.c);
      }
    }
  }
  return ordered;
}

/** Fortolker "3,3V", "3.3 V", "12", "500mV" osv. som volt. */
export function parseVoltage(s: string): number | null {
  if (!s) return null;
  const m = s.trim().replace(",", ".").match(/^([-+]?\d*\.?\d+)\s*(m|k)?\s*v?$/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  const unit = m[2]?.toLowerCase();
  if (unit === "m") v /= 1000;
  if (unit === "k") v *= 1000;
  return v;
}

export type ProbeVerdict = "none" | "ok" | "bad";

/** Sammenligner målt med forventet spænding. Tolerance er ±10 % (dog mindst 0,1 V). */
export function probeVerdict(p: Pick<Probe, "expected" | "measured">, tolerance = 0.1): ProbeVerdict {
  const exp = parseVoltage(p.expected);
  const meas = parseVoltage(p.measured);
  if (exp === null || meas === null) return "none";
  const allowed = Math.max(Math.abs(exp) * tolerance, 0.1);
  return Math.abs(meas - exp) <= allowed ? "ok" : "bad";
}

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Næste ledige betegnelse, fx R5 hvis R1..R4 findes. */
export function nextDesignator(prefix: string, components: PcbComponent[]): string {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`, "i");
  for (const c of components) {
    const m = c.designator.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}${max + 1}`;
}
