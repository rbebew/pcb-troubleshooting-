import { describe, expect, it } from "vitest";
import { makeTiles, mergeDetections } from "../src/detectMerge";
import type { PcbComponent } from "../src/types";

let n = 0;
function c(x: number, y: number, w: number, h: number, extra: Partial<PcbComponent> = {}): PcbComponent {
  return { id: `c${n++}`, x, y, w, h, designator: "", type: "resistor", value: "", status: "unknown", notes: "", source: "ai", ...extra };
}

describe("makeTiles", () => {
  it("dækker hele billedet med overlap", () => {
    const tiles = makeTiles(3000, 4000, 3);
    expect(tiles.length).toBe(9); // 3 × 3 felter på ca. 1333 px
    for (const [x, y] of [[0, 0], [2999, 3999], [1500, 2000]]) {
      expect(tiles.some((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h)).toBe(true);
    }
  });
});

describe("mergeDetections", () => {
  const tileA = { x: 0, y: 0, w: 1100, h: 1000 };
  const tileB = { x: 900, y: 0, w: 1100, h: 1000 };

  it("fjerner dubletter fra overlappet og beholder den hele udgave", () => {
    const cut = c(1040, 500, 60, 30); // skåret over ved højre kant af felt A
    const full = c(1040, 500, 80, 30, { value: "10k" }); // hel i felt B
    const r = mergeDetections([], [{ tile: tileA, components: [cut] }, { tile: tileB, components: [full] }], 2000 * 1000);
    expect(r.components).toHaveLength(1);
    expect(r.components[0].w).toBe(80);
    expect(r.components[0].value).toBe("10k");
  });

  it("holder tætsiddende små komponenter adskilt", () => {
    const a = c(100, 100, 20, 10);
    const b = c(124, 100, 20, 10);
    const r = mergeDetections([], [{ tile: tileA, components: [a, b] }], 2000 * 1000);
    expect(r.components).toHaveLength(2);
  });

  it("tager små komponenter fra felterne og store fra helheden", () => {
    const smallWhole = c(300, 300, 30, 16, { designator: "R5" });
    const smallTile = c(302, 301, 26, 14, { value: "4k7" });
    const bigWhole = c(500, 500, 400, 300, { designator: "U1" });
    const bigTilePart = c(500, 500, 250, 300);
    const r = mergeDetections([smallWhole, bigWhole], [{ tile: tileA, components: [smallTile, bigTilePart] }], 2000 * 1000);
    expect(r.components).toHaveLength(2);
    const small = r.components.find((x) => x.w < 100)!;
    expect(small.value).toBe("4k7");
    expect(small.designator).toBe("R5");
    expect(r.remap.get(smallWhole.id)).toBe(small.id);
    expect(r.components.find((x) => x.w >= 100)!.w).toBe(400);
  });
});
