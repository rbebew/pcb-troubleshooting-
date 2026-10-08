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

export type MeasureKind = "voltage" | "resistance";


/**
 * Fortolker en modstand: "0,8 Ω", "220R", "4,7k", "4k7", "10 kΩ", "1M", "1M5", "OL" (= uendelig).
 * Bemærk: "1" alene på et multimeter betyder også ofte overløb, men tolkes her som 1 Ω.
 */
export function parseResistance(s: string): number | null {
  if (!s) return null;
  const t = s.trim();
  if (/^(ol|o\.l\.?|∞|uendelig|åben|open|inf)/i.test(t)) return Infinity;
  // 4k7 / 1M5 / 2R2
  const mid = t.match(/^(\d+)\s*([RkKM])\s*(\d+)\s*(Ω|ohm)?$/);
  if (mid) return parseFloat(`${mid[1]}.${mid[3]}`) * resMult(mid[2]);
  const m = t.replace(",", ".").match(/^([-+]?\d*\.?\d+)\s*([mRkKM]|meg)?\s*(Ω|ohm|ohms)?\s*$/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isNaN(v) ? null : v * resMult(m[2]);
}

function resMult(u: string | undefined): number {
  if (!u || u === "R") return 1;
  if (u === "m") return 1e-3;
  if (u === "k" || u === "K") return 1e3;
  return 1e6; // M, meg
}

function parseValue(s: string, kind: MeasureKind): number | null {
  return kind === "resistance" ? parseResistance(s) : parseVoltage(s);
}

export interface Expectation {
  op: "approx" | "gt" | "lt" | "range";
  value: number;
  max?: number;
}

/**
 * Fortolker et forventet resultat: "5V", "ca. 3,3 V", "over 100 Ω", "> 10k", "under 5 Ω",
 * "11,5-12,5 V", "4,7k", "OL".
 */
export function parseExpectation(s: string, kind: MeasureKind): Expectation | null {
  if (!s) return null;
  let t = s.trim().toLowerCase().startsWith("ca") ? s.trim().replace(/^ca\.?\s*/i, "") : s.trim();
  let op: Expectation["op"] = "approx";
  const gt = t.match(/^(>=?|≥|over|mindst|min\.?|større end)\s*/i);
  const lt = t.match(/^(<=?|≤|under|højst|max\.?|mindre end)\s*/i);
  if (gt) {
    op = "gt";
    t = t.slice(gt[0].length);
  } else if (lt) {
    op = "lt";
    t = t.slice(lt[0].length);
  }
  // Fjern forklarende tekst i parentes og efterfølgende ord: "over 100 Ω (stiger langsomt)" -> "100 Ω"
  t = t.replace(/\(.*\)/, "").trim();
  const range = t.match(/^(.+?)\s*(?:-|–|til)\s*(.+)$/);
  if (range && op === "approx") {
    const unit = range[2].match(/[a-zΩ]+\s*$/i)?.[0] ?? "";
    const a = parseValue(/[a-zΩ]\s*$/i.test(range[1]) ? range[1] : range[1] + unit, kind);
    const b = parseValue(range[2], kind);
    if (a !== null && b !== null) return { op: "range", value: Math.min(a, b), max: Math.max(a, b) };
  }
  const v = parseValue(t, kind) ?? parseValue(t.split(/\s+(?=[a-zæøå]{3,})/i)[0], kind);
  return v === null ? null : { op, value: v };
}

/**
 * Sammenligner målt med forventet. Spænding: ±10 % (mindst 0,1 V). Modstand: ±10 % (mindst 0,5 Ω).
 * Forventninger som "over 100 Ω" og "11,5-12,5 V" understøttes.
 */
export function probeVerdict(p: Pick<Probe, "expected" | "measured"> & { kind?: MeasureKind }, tolerance = 0.1): ProbeVerdict {
  const kind = p.kind ?? "voltage";
  const exp = parseExpectation(p.expected, kind);
  const meas = parseValue(p.measured, kind);
  if (!exp || meas === null) return "none";
  switch (exp.op) {
    case "gt":
      return meas >= exp.value ? "ok" : "bad";
    case "lt":
      return meas <= exp.value ? "ok" : "bad";
    case "range":
      return meas >= exp.value * (1 - tolerance / 2) && meas <= exp.max! * (1 + tolerance / 2) ? "ok" : "bad";
    default: {
      if (exp.value === Infinity) return meas === Infinity || meas > 1e6 ? "ok" : "bad";
      if (meas === Infinity) return "bad";
      const allowed = Math.max(Math.abs(exp.value) * tolerance, kind === "resistance" ? 0.5 : 0.1);
      return Math.abs(meas - exp.value) <= allowed ? "ok" : "bad";
    }
  }
}

/** Viser en værdi med enhed, fx 4700 -> "4,7 kΩ". */
export function formatValue(v: number, kind: MeasureKind): string {
  if (v === Infinity) return "OL";
  const unit = kind === "resistance" ? "Ω" : "V";
  const abs = Math.abs(v);
  const [n, p] = abs >= 1e6 ? [v / 1e6, "M"] : abs >= 1e3 ? [v / 1e3, "k"] : abs < 1 && abs > 0 && kind === "voltage" ? [v * 1e3, "m"] : [v, ""];
  return `${Number(n.toFixed(2)).toLocaleString("da-DK")} ${p}${unit}`;
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
