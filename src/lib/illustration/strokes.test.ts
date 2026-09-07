import { describe, expect, it } from "vitest";
import { SIGNATURE_SYSTEM } from "./geometry";
import { addStrokes, clampAddedStroke, MIN_ADDED_HEIGHT } from "./strokes";
import { validateIllustration } from "./validation";
import type { Bar, BarIllustration } from "./types";

/** Minimal illustration around a set of bars, with no safe area so the
 *  coordinates in the tests read as drawable rows directly. */
function build(bars: Bar[]): BarIllustration {
  return {
    meta: { subject: "test" },
    canvas: { widthUnits: 90, heightUnits: 90, paddingUnits: 0 },
    system: SIGNATURE_SYSTEM,
    bars,
  };
}

/** The bar sitting in a slot, or undefined. */
function barAt(illustration: BarIllustration, slot: number): Bar | undefined {
  return illustration.bars.find((bar) => bar.x === slot);
}

describe("clampAddedStroke", () => {
  it("never returns a stroke below the minimum length", () => {
    const stroke = clampAddedStroke({ slot: 0, row: 0, height: 1 }, 90, 22);
    expect(stroke?.height).toBe(MIN_ADDED_HEIGHT);
  });

  it("slides a stroke up rather than cutting it short at the bottom edge", () => {
    // Dragging along an edge has to feel solid: the length is what the user set,
    // so the position gives way instead.
    const stroke = clampAddedStroke({ slot: 0, row: 88, height: 10 }, 90, 22);
    expect(stroke).toEqual({ slot: 0, row: 80, height: 10 });
  });

  it("keeps a stroke inside the slot range", () => {
    expect(clampAddedStroke({ slot: 99, row: 0, height: 10 }, 90, 22)?.slot).toBe(22);
    expect(clampAddedStroke({ slot: -5, row: 0, height: 10 }, 90, 22)?.slot).toBe(0);
  });

  it("gives up when the canvas cannot hold a legal stroke", () => {
    expect(clampAddedStroke({ slot: 0, row: 0, height: 4 }, 2, 22)).toBeNull();
  });
});

describe("addStrokes", () => {
  it("returns the illustration untouched when nothing was drawn", () => {
    const illustration = build([{ x: 0, segments: [{ y: 0, height: 10 }] }]);
    expect(addStrokes(illustration, [])).toBe(illustration);
  });

  it("creates a bar for a slot that has none", () => {
    const illustration = build([{ x: 0, segments: [{ y: 0, height: 10 }] }]);
    const drawn = addStrokes(illustration, [{ slot: 5, row: 20, height: 8 }]);

    expect(barAt(drawn, 5)?.segments).toEqual([{ y: 20, height: 8 }]);
  });

  it("adds a second segment to an existing bar", () => {
    const illustration = build([{ x: 0, segments: [{ y: 0, height: 10 }] }]);
    const drawn = addStrokes(illustration, [{ slot: 0, row: 20, height: 8 }]);

    expect(barAt(drawn, 0)?.segments).toEqual([
      { y: 0, height: 10 },
      { y: 20, height: 8 },
    ]);
  });

  it("merges a stroke that overlaps one already there", () => {
    // Two overlapping segments in one bar are what the validator rejects, so they
    // have to come out as a single stroke.
    const illustration = build([{ x: 0, segments: [{ y: 0, height: 10 }] }]);
    const drawn = addStrokes(illustration, [{ slot: 0, row: 5, height: 10 }]);

    expect(barAt(drawn, 0)?.segments).toEqual([{ y: 0, height: 15 }]);
  });

  it("merges a stroke that only touches one already there", () => {
    // Edge to edge is one continuous stroke, so keeping two segments would be a
    // second way of describing the same graphic.
    const illustration = build([{ x: 0, segments: [{ y: 0, height: 10 }] }]);
    const drawn = addStrokes(illustration, [{ slot: 0, row: 10, height: 4 }]);

    expect(barAt(drawn, 0)?.segments).toEqual([{ y: 0, height: 14 }]);
  });

  it("leaves a staggered bar alone and opens its own slot instead", () => {
    // A staggered bar sits at a different x by design, so merging into it would
    // shift the added stroke sideways from where it was drawn.
    const illustration = build([
      { x: 3, xOffsetUnits: 2, segments: [{ y: 0, height: 10 }] },
    ]);
    const drawn = addStrokes(illustration, [{ slot: 3, row: 40, height: 6 }]);

    // Both bars claim slot 3, told apart by their stagger. The staggered one is
    // untouched, the addition gets a bar of its own at the base grid.
    expect(drawn.bars).toHaveLength(2);
    expect(
      drawn.bars.find((bar) => bar.x === 3 && bar.xOffsetUnits === 2)?.segments,
    ).toEqual([{ y: 0, height: 10 }]);
    expect(
      drawn.bars.find((bar) => bar.x === 3 && bar.xOffsetUnits === undefined)
        ?.segments,
    ).toEqual([{ y: 40, height: 6 }]);
  });

  it("does not mutate the illustration it was given", () => {
    const illustration = build([{ x: 0, segments: [{ y: 0, height: 10 }] }]);
    addStrokes(illustration, [{ slot: 0, row: 20, height: 8 }]);

    expect(illustration.bars[0].segments).toEqual([{ y: 0, height: 10 }]);
  });

  it("produces a graphic that still validates", () => {
    // Additions are a construction step like any other, so the result has to
    // satisfy every rule of the system - including ordered, disjoint segments.
    const illustration = build([{ x: 0, segments: [{ y: 30, height: 10 }] }]);
    const drawn = addStrokes(illustration, [
      { slot: 0, row: 0, height: 8 },
      { slot: 0, row: 50, height: 8 },
      { slot: 7, row: 10, height: 20 },
    ]);

    expect(validateIllustration(drawn).ok).toBe(true);
  });

  it("keeps a stroke dragged past the edges inside the canvas", () => {
    const illustration = build([{ x: 0, segments: [{ y: 0, height: 10 }] }]);
    const drawn = addStrokes(illustration, [{ slot: 999, row: 999, height: 6 }]);

    expect(validateIllustration(drawn).ok).toBe(true);
    // 90 units wide at a 4 dp pitch is 23 slots, so the last one is 22.
    expect(barAt(drawn, 22)?.segments).toEqual([{ y: 84, height: 6 }]);
  });
});
