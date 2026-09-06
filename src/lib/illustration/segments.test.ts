import { describe, expect, it } from "vitest";
import { SIGNATURE_SYSTEM } from "./geometry";
import {
  componentAt,
  findComponents,
  removeSegmentsAt,
  SEGMENT_PICK_TOLERANCE_DP,
  segmentBoxes,
} from "./segments";
import type { Bar, BarIllustration } from "./types";

/** Minimal illustration around a set of bars, with no safe area to keep the
 *  coordinates in the tests readable. */
function build(bars: Bar[]): BarIllustration {
  return {
    meta: { subject: "test" },
    canvas: { widthUnits: 90, heightUnits: 90, paddingUnits: 0 },
    system: SIGNATURE_SYSTEM,
    bars,
  };
}

describe("findComponents", () => {
  it("joins neighbouring strokes whose segments overlap", () => {
    const illustration = build([
      { x: 0, segments: [{ y: 10, height: 20 }] },
      { x: 1, segments: [{ y: 15, height: 20 }] },
      { x: 2, segments: [{ y: 20, height: 20 }] },
    ]);

    const { members } = findComponents(illustration);

    expect(members).toHaveLength(1);
    expect(members[0]).toHaveLength(3);
  });

  it("keeps strokes apart when a slot is skipped", () => {
    const illustration = build([
      { x: 0, segments: [{ y: 10, height: 20 }] },
      // No bar at x = 1, so nothing bridges the two.
      { x: 2, segments: [{ y: 10, height: 20 }] },
    ]);

    expect(findComponents(illustration).members).toHaveLength(2);
  });

  it("keeps stacked segments apart when they only touch diagonally", () => {
    // The second stroke starts exactly where the first ends: no shared unit, so
    // this is diagonal contact and must not join. A seam relies on this.
    const illustration = build([
      { x: 0, segments: [{ y: 0, height: 10 }] },
      { x: 1, segments: [{ y: 10, height: 10 }] },
    ]);

    expect(findComponents(illustration).members).toHaveLength(2);
  });

  it("separates what a seam cut apart", () => {
    // A seam removes one unit across every stroke, leaving an upper and a lower
    // band. Those are two parts and can be deleted independently.
    const illustration = build([
      { x: 0, segments: [{ y: 0, height: 20 }, { y: 21, height: 20 }] },
      { x: 1, segments: [{ y: 0, height: 20 }, { y: 21, height: 20 }] },
    ]);

    const { members } = findComponents(illustration);

    expect(members).toHaveLength(2);
    expect(members.map((group) => group.length)).toEqual([2, 2]);
  });

  it("groups a caption under a building separately from the building", () => {
    const illustration = build([
      { x: 0, segments: [{ y: 0, height: 40 }, { y: 60, height: 6 }] },
      { x: 1, segments: [{ y: 0, height: 40 }, { y: 60, height: 6 }] },
    ]);

    const { members } = findComponents(illustration);

    expect(members).toHaveLength(2);
  });
});

describe("componentAt", () => {
  const illustration = build([
    { x: 0, segments: [{ y: 0, height: 40 }, { y: 60, height: 6 }] },
    { x: 1, segments: [{ y: 0, height: 40 }, { y: 60, height: 6 }] },
  ]);

  it("finds the part under a point inside a stroke", () => {
    const part = componentAt(illustration, { x: 1, y: 20 }, SEGMENT_PICK_TOLERANCE_DP);
    expect(part).toHaveLength(2);
  });

  it("finds the part when pointing into the gap between its strokes", () => {
    // x = 3 sits in the 2 dp gap between slot 0 and slot 1. Pointing there still
    // has to select the shape, otherwise the tool feels broken.
    const part = componentAt(illustration, { x: 3, y: 20 }, SEGMENT_PICK_TOLERANCE_DP);
    expect(part).toHaveLength(2);
  });

  it("returns nothing far away from any stroke", () => {
    const part = componentAt(illustration, { x: 1, y: 52 }, SEGMENT_PICK_TOLERANCE_DP);
    expect(part).toBeNull();
  });
});

describe("removeSegmentsAt", () => {
  const illustration = build([
    { x: 0, segments: [{ y: 0, height: 40 }, { y: 60, height: 6 }] },
    { x: 1, segments: [{ y: 0, height: 40 }, { y: 60, height: 6 }] },
  ]);

  it("removes only the segment under the anchor by default", () => {
    const pruned = removeSegmentsAt(
      illustration,
      [{ x: 1, y: 62 }],
      SEGMENT_PICK_TOLERANCE_DP,
    );

    // The caption stroke of slot 0 is gone, the one of slot 1 stays: the point is
    // precision, not taking out everything that happens to be connected.
    expect(pruned.illustration.bars[0].segments).toEqual([{ y: 0, height: 40 }]);
    expect(pruned.illustration.bars[1].segments).toEqual([
      { y: 0, height: 40 },
      { y: 60, height: 6 },
    ]);
  });

  it("removes the whole connected part when the anchor asks for it", () => {
    const pruned = removeSegmentsAt(
      illustration,
      [{ x: 1, y: 62, whole: true }],
      SEGMENT_PICK_TOLERANCE_DP,
    );

    expect(pruned.illustration.bars).toHaveLength(2);
    expect(pruned.illustration.bars.every((bar) => bar.segments.length === 1)).toBe(true);
    expect(pruned.illustration.bars[0].segments[0]).toEqual({ y: 0, height: 40 });
  });

  it("drops bars that end up without segments", () => {
    const single = build([
      { x: 0, segments: [{ y: 0, height: 10 }] },
      { x: 5, segments: [{ y: 0, height: 10 }] },
    ]);

    const pruned = removeSegmentsAt(single, [{ x: 1, y: 5 }], SEGMENT_PICK_TOLERANCE_DP);

    expect(pruned.illustration.bars).toHaveLength(1);
    expect(pruned.illustration.bars[0].x).toBe(5);
  });

  it("leaves the graphic untouched when the anchor hits nothing", () => {
    const pruned = removeSegmentsAt(
      illustration,
      [{ x: 1, y: 52 }],
      SEGMENT_PICK_TOLERANCE_DP,
    );
    expect(pruned.illustration).toBe(illustration);
    expect(pruned.removed).toEqual([]);
  });

  it("reports what it removed, with the anchor responsible", () => {
    // The graphic no longer contains these, so their geometry has to come out of
    // the removal - that is what lets the preview show them and offer them back.
    const pruned = removeSegmentsAt(
      illustration,
      [
        { x: 1, y: 62 },
        { x: 5, y: 62 },
      ],
      SEGMENT_PICK_TOLERANCE_DP,
    );

    expect(pruned.removed).toHaveLength(2);
    expect(pruned.removed.map((box) => box.anchorIndex).sort()).toEqual([0, 1]);
    // Both captions sit at y 60 and are 6 units tall.
    for (const box of pruned.removed) {
      expect(box.y).toBe(60);
      expect(box.height).toBe(6);
    }
  });

  it("credits a whole part to the single anchor that removed it", () => {
    const pruned = removeSegmentsAt(
      illustration,
      [{ x: 1, y: 62, whole: true }],
      SEGMENT_PICK_TOLERANCE_DP,
    );

    expect(pruned.removed).toHaveLength(2);
    expect(pruned.removed.every((box) => box.anchorIndex === 0)).toBe(true);
  });

  it("wipes several segments from one drag", () => {
    // What dragging across the caption produces: one anchor per stroke passed.
    const pruned = removeSegmentsAt(
      illustration,
      [
        { x: 1, y: 62 },
        { x: 5, y: 62 },
      ],
      SEGMENT_PICK_TOLERANCE_DP,
    );

    expect(pruned.illustration.bars.every((bar) => bar.segments.length === 1)).toBe(true);
  });
});

describe("segmentBoxes", () => {
  it("places boxes at the rendered position, safe area included", () => {
    const illustration: BarIllustration = {
      meta: { subject: "test" },
      canvas: { widthUnits: 90, heightUnits: 90, paddingUnits: 3 },
      system: SIGNATURE_SYSTEM,
      bars: [{ x: 2, segments: [{ y: 5, height: 10 }] }],
    };

    // x = padding + slot * pitch = 3 + 2 * 4, y = padding + segment.y = 3 + 5
    expect(segmentBoxes(illustration)).toEqual([
      { ref: { bar: 0, segment: 0 }, x: 11, y: 8, width: 2, height: 10 },
    ]);
  });
});
