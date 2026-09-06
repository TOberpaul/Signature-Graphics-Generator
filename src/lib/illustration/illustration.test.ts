import { describe, expect, it } from "vitest";
import {
  BAR_WIDTH_UNITS,
  GAP_UNITS,
  PITCH_UNITS,
  barOffsetUnits,
  maxBarIndex,
  slotCount,
  widthUnitsForSlots,
} from "./geometry";
import { validateIllustration } from "./validation";
import { canvasSizeUnits, layoutRects, renderIllustration } from "./renderer";
import type { BarIllustration } from "./types";

function illustration(overrides: Partial<BarIllustration> = {}): BarIllustration {
  return {
    meta: { subject: "Test", symmetry: "none" },
    canvas: { widthUnits: 9, heightUnits: 10, paddingUnits: 2 },
    system: { barWidthUnits: 1, gapUnits: 1 },
    bars: [
      { x: 0, segments: [{ y: 0, height: 10 }] },
      { x: 1, segments: [{ y: 2, height: 3 }, { y: 7, height: 3 }] },
      { x: 4, segments: [{ y: 5, height: 5 }] },
    ],
    ...overrides,
  };
}

describe("geometry", () => {
  it("locks bar width, gap and pitch", () => {
    expect(BAR_WIDTH_UNITS).toBe(1);
    expect(GAP_UNITS).toBe(1);
    expect(PITCH_UNITS).toBe(2);
  });

  it("maps bar index to unit offset via pitch", () => {
    expect(barOffsetUnits(0)).toBe(0);
    expect(barOffsetUnits(1)).toBe(2);
    expect(barOffsetUnits(7)).toBe(14);
  });

  it("derives slot count and width consistently", () => {
    for (let slots = 1; slots <= 40; slots += 1) {
      const width = widthUnitsForSlots(slots);
      expect(width).toBe(slots * 2 - 1);
      expect(slotCount(width)).toBe(slots);
      expect(maxBarIndex(width)).toBe(slots - 1);
    }
  });
});

describe("validation", () => {
  it("accepts a valid illustration", () => {
    const result = validateIllustration(illustration());
    expect(result.ok).toBe(true);
  });

  it("rejects non integer coordinates", () => {
    const result = validateIllustration(
      illustration({ bars: [{ x: 1.5, segments: [{ y: 0, height: 4 }] }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a height of zero or less", () => {
    for (const height of [0, -3]) {
      const result = validateIllustration(
        illustration({ bars: [{ x: 0, segments: [{ y: 0, height }] }] }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects negative positions", () => {
    const result = validateIllustration(
      illustration({ bars: [{ x: 0, segments: [{ y: -1, height: 4 }] }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate bar indices", () => {
    const result = validateIllustration(
      illustration({
        bars: [
          { x: 2, segments: [{ y: 0, height: 4 }] },
          { x: 2, segments: [{ y: 5, height: 4 }] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/duplicate/);
  });

  it("rejects overlapping segments inside one bar", () => {
    const result = validateIllustration(
      illustration({
        bars: [{ x: 0, segments: [{ y: 0, height: 5 }, { y: 3, height: 4 }] }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/overlaps/);
  });

  it("rejects bars outside the canvas width", () => {
    const result = validateIllustration(
      illustration({ bars: [{ x: 5, segments: [{ y: 0, height: 4 }] }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/exceeds the canvas/);
  });

  it("rejects segments overflowing the canvas height", () => {
    const result = validateIllustration(
      illustration({ bars: [{ x: 0, segments: [{ y: 8, height: 5 }] }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/outside the canvas height/);
  });

  it("enforces barWidthUnits and gapUnits of 1", () => {
    for (const system of [
      { barWidthUnits: 2, gapUnits: 1 },
      { barWidthUnits: 1, gapUnits: 2 },
    ]) {
      const result = validateIllustration({
        ...illustration(),
        system,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects unknown properties", () => {
    const result = validateIllustration({
      ...illustration(),
      bars: [{ x: 0, segments: [{ y: 0, height: 4 }], colour: "red" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects too many bars", () => {
    const bars = Array.from({ length: 100 }, (_, x) => ({
      x,
      segments: [{ y: 0, height: 2 }],
    }));
    const result = validateIllustration(illustration({ bars }));
    expect(result.ok).toBe(false);
  });

  it("rejects garbage input", () => {
    for (const value of [null, 42, "ICE", [], {}]) {
      expect(validateIllustration(value).ok).toBe(false);
    }
  });
});

describe("renderer", () => {
  const unitSize = 4;

  it("computes the canvas size including padding", () => {
    expect(canvasSizeUnits(illustration())).toEqual({ widthUnits: 13, heightUnits: 14 });
    const { width, height } = renderIllustration(illustration(), { unitSize });
    expect(width).toBe(13 * unitSize);
    expect(height).toBe(14 * unitSize);
  });

  it("emits one rect per segment", () => {
    const { rects } = renderIllustration(illustration(), { unitSize });
    expect(rects).toHaveLength(4);
    expect((renderIllustration(illustration(), { unitSize }).svg.match(/<rect /g) ?? []).length)
      .toBe(4 + 1); // segments + background
  });

  it("maps units to pixels with padding and pitch", () => {
    const rects = layoutRects(illustration(), unitSize);
    expect(rects[0]).toEqual({ x: 2 * unitSize, y: 2 * unitSize, width: unitSize, height: 40 });
    // bar x=4 -> padding 2 + 4 * pitch 2 = 10 units
    expect(rects[3].x).toBe(10 * unitSize);
  });

  it("gives every bar exactly the same width", () => {
    const rects = layoutRects(illustration(), unitSize);
    expect(new Set(rects.map((rect) => rect.width)).size).toBe(1);
    expect(rects[0].width).toBe(BAR_WIDTH_UNITS * unitSize);
  });

  it("keeps every gap between neighbouring bars identical", () => {
    const bars = Array.from({ length: 12 }, (_, x) => ({
      x,
      segments: [{ y: 0, height: 6 }],
    }));
    const rects = layoutRects(
      illustration({
        canvas: { widthUnits: widthUnitsForSlots(12), heightUnits: 10, paddingUnits: 3 },
        bars,
      }),
      unitSize,
    );

    const gaps = rects
      .slice(1)
      .map((rect, index) => rect.x - (rects[index].x + rects[index].width));
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBe(GAP_UNITS * unitSize);
  });

  it("is deterministic and free of paths, curves and gradients", () => {
    const first = renderIllustration(illustration(), { unitSize }).svg;
    const second = renderIllustration(illustration(), { unitSize }).svg;
    expect(first).toBe(second);
    expect(first).not.toMatch(/<path|<circle|<line|<polygon|Gradient|filter|transform=/);
  });

  it("scales linearly with unit size", () => {
    const small = renderIllustration(illustration(), { unitSize: 4 });
    const large = renderIllustration(illustration(), { unitSize: 12 });
    expect(large.width).toBe(small.width * 3);
    expect(large.rects[3].x).toBe(small.rects[3].x * 3);
  });

  it("escapes the label", () => {
    const { svg } = renderIllustration(
      illustration({ meta: { subject: "ICE", label: '<script>"x"' } }),
      { unitSize },
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("adds grid guides only on request", () => {
    const plain = renderIllustration(illustration(), { unitSize });
    const grid = renderIllustration(illustration(), { unitSize, showGrid: true });
    expect(grid.svg.length).toBeGreaterThan(plain.svg.length);
    expect(grid.rects).toEqual(plain.rects);
  });
});
