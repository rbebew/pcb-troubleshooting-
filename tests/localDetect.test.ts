import { describe, expect, it } from "vitest";
import { detectComponentsLocal, type PixelImage } from "../src/localDetect";

/** Syntetisk grønt print med mørke "komponenter" og en tynd lys bane. */
function syntheticBoard(): PixelImage {
  const W = 400;
  const H = 300;
  const data = new Uint8ClampedArray(W * H * 4);
  const fill = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * W + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
        data[i + 3] = 255;
      }
  };
  fill(0, 0, W, H, [20, 110, 50]); // loddestopmaske
  // Lidt støj så det ligner et foto.
  for (let i = 0; i < W * H; i++) data[i * 4 + 1] += ((i * 7919) % 13) - 6;
  fill(40, 40, 60, 40, [15, 15, 15]); // IC
  fill(200, 60, 20, 10, [190, 150, 90]); // modstand
  fill(300, 180, 36, 36, [40, 40, 160]); // kondensator
  fill(0, 250, W, 1, [200, 200, 200]); // tynd silketryk-/kobberlinje
  return { width: W, height: H, data };
}

describe("detectComponentsLocal", () => {
  it("finder de tre komponenter og ignorerer tynde linjer", () => {
    const boxes = detectComponentsLocal(syntheticBoard());
    expect(boxes).toHaveLength(3);
    const near = (bx: { x: number; y: number }, x: number, y: number) => Math.abs(bx.x - x) <= 3 && Math.abs(bx.y - y) <= 3;
    expect(boxes.some((b) => near(b, 40, 40))).toBe(true);
    expect(boxes.some((b) => near(b, 200, 60))).toBe(true);
    expect(boxes.some((b) => near(b, 300, 180))).toBe(true);
  });

  it("giver intet på et tomt print", () => {
    const W = 50;
    const data = new Uint8ClampedArray(W * W * 4).fill(100);
    expect(detectComponentsLocal({ width: W, height: W, data })).toEqual([]);
  });
});

import { detectBoard } from "../src/localDetect";

describe("detectBoard", () => {
  function photo(boardColor: [number, number, number]): PixelImage {
    const W = 300, H = 200;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const onBoard = x >= 40 && x < 260 && y >= 30 && y < 170;
        // Bordet: lys træfarve med gradient; pladen: farve med ujævn belysning og komponenter.
        const shade = 0.75 + 0.25 * (x / W);
        let c: number[] = onBoard ? boardColor.map((v) => v * shade) : [180 + y * 0.2, 150, 110];
        if (onBoard && (x - 100) ** 2 + (y - 90) ** 2 < 300) c = [20, 20, 20]; // en chip
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
      }
    return { width: W, height: H, data };
  }

  it("finder en grøn plade på et træbord", () => {
    const r = detectBoard(photo([20, 120, 55]))!;
    expect(r).not.toBeNull();
    expect(Math.abs(r.x - 40)).toBeLessThan(8);
    expect(Math.abs(r.y - 30)).toBeLessThan(8);
    expect(Math.abs(r.x + r.w - 260)).toBeLessThan(8);
    expect(Math.abs(r.y + r.h - 170)).toBeLessThan(8);
  });

  it("finder en blå plade", () => {
    const r = detectBoard(photo([20, 60, 160]))!;
    expect(Math.abs(r.x - 40)).toBeLessThan(8);
    expect(Math.abs(r.x + r.w - 260)).toBeLessThan(8);
  });
});
