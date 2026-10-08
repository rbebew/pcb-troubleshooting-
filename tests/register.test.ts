import { describe, expect, it } from "vitest";
import { locateDetail, resize, rotate90, type Gray } from "../src/register";

/** Pseudo-tilfældigt "print": rektangler og streger i forskellige gråtoner. */
function syntheticBoard(w: number, h: number, seed = 7): Gray {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const d = new Float32Array(w * h).fill(90);
  const rect = (x: number, y: number, rw: number, rh: number, v: number) => {
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++) for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) d[yy * w + xx] = v;
  };
  for (let i = 0; i < 25; i++) rect(Math.floor(rnd() * w), Math.floor(rnd() * h), 2 + Math.floor(rnd() * 3), Math.floor(rnd() * h * 0.6), 120); // baner
  for (let i = 0; i < 60; i++) rect(Math.floor(rnd() * w), Math.floor(rnd() * h), 4 + Math.floor(rnd() * 30), 4 + Math.floor(rnd() * 20), rnd() * 255); // komponenter
  return { w, h, d };
}

function crop(g: Gray, x: number, y: number, w: number, h: number): Gray {
  const d = new Float32Array(w * h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) d[yy * w + xx] = g.d[(y + yy) * g.w + x + xx];
  return { w, h, d };
}

/** Andet foto: anden opløsning, lysstyrke/kontrast og lidt støj. */
function photograph(g: Gray, scale: number): Gray {
  const r = resize(g, g.w * scale, g.h * scale);
  let s = 3;
  for (let i = 0; i < r.d.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    r.d[i] = r.d[i] * 0.8 + 25 + ((s / 0x7fffffff) - 0.5) * 12;
  }
  return r;
}

describe("locateDetail", () => {
  const overview = syntheticBoard(600, 400);
  const truth = { x: 210, y: 120, w: 150, h: 100 };
  const detail = photograph(crop(overview, truth.x, truth.y, truth.w, truth.h), 3);

  it("finder et nærbillede taget med anden opløsning og belysning", async () => {
    const m = (await locateDetail(overview, detail))!;
    expect(m.score).toBeGreaterThan(0.7);
    expect(m.rot).toBe(0);
    expect(Math.abs(m.x - truth.x)).toBeLessThan(8);
    expect(Math.abs(m.y - truth.y)).toBeLessThan(8);
    expect(Math.abs(m.w - truth.w) / truth.w).toBeLessThan(0.08);
  });

  it("opdager når nærbilledet er drejet", async () => {
    const turned = rotate90(detail, 3); // drejet en kvart omgang mod uret
    const m = (await locateDetail(overview, turned, { rotations: [0, 1, 2, 3] }))!;
    expect(m.rot).toBe(1);
    expect(Math.abs(m.x - truth.x)).toBeLessThan(8);
    expect(Math.abs(m.y - truth.y)).toBeLessThan(8);
  });

  it("forfiner ud fra et groft hint (fx fra AI)", async () => {
    const hint = { x: 0.33, y: 0.27, w: 0.3, h: 0.27, rot: 0 as const };
    const m = (await locateDetail(overview, detail, { hint }))!;
    expect(Math.abs(m.x - truth.x)).toBeLessThan(8);
    expect(Math.abs(m.y - truth.y)).toBeLessThan(8);
  });

  it("giver lav score når nærbilledet ikke er fra printet", async () => {
    const other = photograph(crop(syntheticBoard(600, 400, 99), 100, 100, 150, 100), 3);
    const m = await locateDetail(overview, other);
    expect(m === null || m.score < 0.6).toBe(true);
  });
});
