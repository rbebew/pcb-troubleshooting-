import { describe, expect, it } from "vitest";
import { componentsAlongNet, nextDesignator, parseVoltage, probeVerdict, segmentIntersectsRect } from "../src/geometry";
import type { PcbComponent, Trace } from "../src/types";

function comp(id: string, x: number, y: number, w = 10, h = 10, designator = id): PcbComponent {
  return { id, x, y, w, h, designator, type: "resistor", value: "", status: "unknown", notes: "", source: "manual" };
}

describe("parseVoltage", () => {
  it("forstår danske og engelske decimaler og enheder", () => {
    expect(parseVoltage("3,3V")).toBeCloseTo(3.3);
    expect(parseVoltage("3.3 V")).toBeCloseTo(3.3);
    expect(parseVoltage("12")).toBe(12);
    expect(parseVoltage("500mV")).toBeCloseTo(0.5);
    expect(parseVoltage("-5V")).toBe(-5);
    expect(parseVoltage("")).toBeNull();
    expect(parseVoltage("ukendt")).toBeNull();
  });
});

describe("probeVerdict", () => {
  it("godkender inden for ±10 %", () => {
    expect(probeVerdict({ expected: "5V", measured: "4,8V" })).toBe("ok");
    expect(probeVerdict({ expected: "5V", measured: "4.2" })).toBe("bad");
    expect(probeVerdict({ expected: "0V", measured: "0.05V" })).toBe("ok");
    expect(probeVerdict({ expected: "3.3V", measured: "" })).toBe("none");
  });
});

describe("segmentIntersectsRect", () => {
  const r = { x: 10, y: 10, w: 10, h: 10 };
  it("rammer når segmentet krydser boksen uden endepunkter i den", () => {
    expect(segmentIntersectsRect({ x: 0, y: 15 }, { x: 30, y: 15 }, r)).toBe(true);
  });
  it("misser når segmentet går forbi", () => {
    expect(segmentIntersectsRect({ x: 0, y: 0 }, { x: 30, y: 0 }, r)).toBe(false);
  });
});

describe("componentsAlongNet", () => {
  it("returnerer komponenter i rækkefølge langs banen", () => {
    const comps = [comp("C", 200, 0), comp("A", 0, 0), comp("B", 100, 0), comp("X", 100, 100)];
    const traces: Trace[] = [{ id: "t", netId: "n", points: [{ x: 5, y: 5 }, { x: 205, y: 5 }] }];
    expect(componentsAlongNet("n", traces, comps).map((c) => c.id)).toEqual(["A", "B", "C"]);
    expect(componentsAlongNet("andet", traces, comps)).toEqual([]);
  });
});

describe("nextDesignator", () => {
  it("finder næste ledige nummer", () => {
    expect(nextDesignator("R", [comp("1", 0, 0, 1, 1, "R1"), comp("2", 0, 0, 1, 1, "R7"), comp("3", 0, 0, 1, 1, "C9")])).toBe("R8");
    expect(nextDesignator("U", [])).toBe("U1");
  });
});
