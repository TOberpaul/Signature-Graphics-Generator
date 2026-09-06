import { describe, expect, it } from "vitest";
import {
  columnSegments,
  gridToAscii,
  illustrationToGrid,
  normalizeGrid,
  occupancyToIllustration,
  shapeMetrics,
  trimGrid,
} from "./occupancy";
import type { OccupancyGrid } from "./occupancy";
import { validateIllustration, validateOccupancyDocument } from "./validation";
import { layoutRects } from "./renderer";
import { GAP_UNITS, LIMITS } from "./geometry";

function grid(rows: string[]): OccupancyGrid {
  return { widthCells: rows[0].length, heightCells: rows.length, rows };
}

describe("normalizeGrid", () => {
  it("accepts the documented characters and pads short rows", () => {
    const result = normalizeGrid({ widthCells: 5, heightCells: 2, rows: ["#X*", "..1_"] });
    expect(result.rows).toEqual(["###..", "..#.."]);
  });

  it("treats spaces and zeros as empty", () => {
    expect(normalizeGrid({ widthCells: 4, heightCells: 1, rows: ["0 #."] }).rows).toEqual([
      "..#.",
    ]);
  });
});

describe("trimGrid", () => {
  it("removes empty border rows and columns", () => {
    const trimmed = trimGrid(
      grid([".....", "..#..", ".###.", "..#..", "....."]),
    );
    expect(trimmed.widthCells).toBe(3);
    expect(trimmed.heightCells).toBe(3);
    expect(gridToAscii(trimmed)).toBe(".#.\n###\n.#.");
  });

  it("returns an empty grid when nothing is occupied", () => {
    expect(trimGrid(grid(["...", "..."]))).toEqual({
      widthCells: 0,
      heightCells: 0,
      rows: [],
    });
  });
});

describe("columnSegments", () => {
  it("merges vertical runs and keeps gaps as negative space", () => {
    const g = grid(["#", "#", ".", "#", "#", "#"]);
    expect(columnSegments(g, 0)).toEqual([
      { y: 0, height: 2 },
      { y: 3, height: 3 },
    ]);
  });
});

describe("occupancyToIllustration", () => {
  const document = {
    subject: "Test",
    label: "Test",
    symmetry: "vertical" as const,
    grid: grid([".#.", "###", "#.#"]),
  };

  it("maps one column to one bar and one run to one segment", () => {
    const illustration = occupancyToIllustration(document);
    expect(illustration.bars).toEqual([
      { x: 0, segments: [{ y: 1, height: 2 }] },
      { x: 1, segments: [{ y: 0, height: 2 }] },
      { x: 2, segments: [{ y: 1, height: 2 }] },
    ]);
  });

  it("derives a canvas that fits the grid", () => {
    const illustration = occupancyToIllustration(document);
    expect(illustration.canvas).toEqual({ widthUnits: 5, heightUnits: 3, paddingUnits: 2 });
  });

  it("never changes bar width or gap", () => {
    const illustration = occupancyToIllustration(document);
    expect(illustration.system).toEqual({ barWidthUnits: 1, gapUnits: 1 });

    const rects = layoutRects(illustration, 4);
    expect(new Set(rects.map((r) => r.width)).size).toBe(1);

    const xs = [...new Set(rects.map((r) => r.x))].sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, i) => x - xs[i] - rects[0].width);
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBe(GAP_UNITS * 4);
  });

  it("produces illustrations that pass the strict validation", () => {
    expect(validateIllustration(occupancyToIllustration(document)).ok).toBe(true);
  });

  it("skips empty columns so negative space survives", () => {
    const illustration = occupancyToIllustration({
      subject: "Gap",
      grid: grid(["#.#"]),
    });
    expect(illustration.bars.map((bar) => bar.x)).toEqual([0, 2]);
  });

  it("round trips through illustrationToGrid", () => {
    const illustration = occupancyToIllustration(document);
    expect(gridToAscii(illustrationToGrid(illustration))).toBe(gridToAscii(trimGrid(document.grid)));
  });
});

describe("validateOccupancyDocument", () => {
  const valid = {
    subject: "Test",
    grid: grid(["..#..", ".###.", "#####"]),
  };

  it("accepts a well formed document without notes", () => {
    const result = validateOccupancyDocument(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes).toEqual([]);
  });

  it("tolerates a row count that disagrees with heightCells and notes it", () => {
    const result = validateOccupancyDocument({
      subject: "Test",
      grid: { widthCells: 5, heightCells: 9, rows: ["#####", "#####", "#####"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.grid.heightCells).toBe(3);
      expect(result.notes.join(" ")).toMatch(/heightCells/);
    }
  });

  it("tolerates rows longer than widthCells, the rows win", () => {
    // measured model behaviour: the drawing is fine, the declaration is off by one
    const result = validateOccupancyDocument({
      subject: "Test",
      grid: { widthCells: 3, heightCells: 3, rows: ["###", "#####", "###"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.grid.widthCells).toBe(5);
      expect(result.value.grid.rows).toEqual(["###..", "#####", "###.."]);
      expect(result.notes.join(" ")).toMatch(/widthCells/);
    }
  });

  it("rejects unsupported characters", () => {
    const result = validateOccupancyDocument({
      subject: "Test",
      grid: { widthCells: 3, heightCells: 3, rows: ["###", "#?#", "###"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/unsupported character/);
  });

  it("rejects an empty grid", () => {
    const result = validateOccupancyDocument({
      subject: "Test",
      grid: grid(["...", "...", "..."]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/no occupied cell/);
  });

  it("rejects unknown properties and missing fields", () => {
    expect(validateOccupancyDocument({ ...valid, extra: 1 }).ok).toBe(false);
    expect(validateOccupancyDocument({ grid: valid.grid }).ok).toBe(false);
    expect(validateOccupancyDocument(null).ok).toBe(false);
  });

  it("rejects a column with too many separate runs", () => {
    // a comb in column 0: one run every other row, far above the segment limit
    const height = (LIMITS.maxSegmentsPerBar + 4) * 2;
    const rows = Array.from({ length: height }, (_, y) => (y % 2 === 0 ? "#.." : "..."));
    const result = validateOccupancyDocument({
      subject: "Comb",
      grid: { widthCells: 3, heightCells: rows.length, rows },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/segments/);
  });
});

describe("shapeMetrics", () => {
  it("detects the bar chart failure mode via a shared baseline", () => {
    // mountain: every column anchored to the bottom row
    const mountain = grid(["..#..", ".###.", "#####"]);
    expect(shapeMetrics(mountain).sharesBaseline).toBe(true);

    // pear like: rounded bottom, so the bottom edges differ
    const rounded = grid(["..#..", ".###.", "#####", ".###."]);
    expect(shapeMetrics(rounded).sharesBaseline).toBe(false);
  });

  it("reports where the widest row sits", () => {
    const metrics = shapeMetrics(grid(["..#..", "#####", ".###.", ".###."]));
    expect(metrics.maxWidth).toBe(5);
    expect(metrics.widestAt).toBeCloseTo(1 / 3, 5);
  });
});
