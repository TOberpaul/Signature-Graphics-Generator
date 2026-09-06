import { describe, expect, it } from "vitest";
import {
  COVERAGE_THRESHOLD,
  DETAIL_COLUMNS,
  maskToIllustration,
  mirrorGrid,
  resampleMask,
  symmetriseGrid,
  targetRowsFor,
} from "./shapeMask";
import { gridToAscii, shapeMetrics, trimGrid } from "./occupancy";
import type { OccupancyGrid } from "./occupancy";
import { validateIllustration } from "./validation";
import { layoutRects } from "./renderer";
import { BAR_WIDTH_UNITS, GAP_UNITS } from "./geometry";
import type { DetailLevel } from "./types";

const DETAILS: DetailLevel[] = ["low", "medium", "high"];

function mask(rows: string[]): OccupancyGrid {
  return { widthCells: rows[0].length, heightCells: rows.length, rows };
}

/** Solid rectangle of the given size. */
function solid(width: number, height: number): OccupancyGrid {
  return mask(Array.from({ length: height }, () => "#".repeat(width)));
}

describe("targetRowsFor", () => {
  it("keeps the aspect ratio, compensating for the pitch", () => {
    // square mask: width in units is columns * 2, so rows must double
    expect(targetRowsFor(solid(40, 40), 20)).toBe(40);
    // wide mask stays wide
    expect(targetRowsFor(solid(48, 16), 24)).toBe(16);
  });

  it("never returns a degenerate height", () => {
    expect(targetRowsFor(solid(60, 1), 30)).toBeGreaterThanOrEqual(6);
  });
});

describe("resampleMask", () => {
  it("downsamples a solid area to a solid area", () => {
    const sampled = resampleMask(solid(48, 24), 12);
    expect(sampled.widthCells).toBe(12);
    expect(sampled.rows.every((row) => row === "#".repeat(12))).toBe(true);
  });

  it("is deterministic", () => {
    const first = resampleMask(solid(40, 40), 17);
    const second = resampleMask(solid(40, 40), 17);
    expect(first).toEqual(second);
  });

  it("is independent of the mask resolution for the same shape", () => {
    // the same triangle drawn at two resolutions must sample to the same raster
    const build = (size: number) =>
      mask(
        Array.from({ length: size }, (_, y) => {
          const half = Math.round(((y + 1) / size) * (size / 2));
          const line = Array(size).fill(".");
          for (let x = size / 2 - half; x < size / 2 + half; x += 1) {
            if (x >= 0 && x < size) line[Math.floor(x)] = "#";
          }
          return line.join("");
        }),
      );

    const small = resampleMask(build(24), 15);
    const large = resampleMask(build(48), 15);
    const widthsSmall = shapeMetrics(small).rowWidths;
    const widthsLarge = shapeMetrics(large).rowWidths;

    expect(widthsSmall.length).toBe(widthsLarge.length);
    for (const [index, width] of widthsSmall.entries()) {
      expect(Math.abs(width - widthsLarge[index])).toBeLessThanOrEqual(2);
    }
  });

  it("keeps negative space and produces several segments per column", () => {
    // a frame: outer ring filled, large hole inside
    const rows = Array.from({ length: 24 }, (_, y) =>
      y < 4 || y >= 20 ? "#".repeat(24) : `####${".".repeat(16)}####`,
    );
    const sampled = resampleMask(mask(rows), 12);
    const metrics = shapeMetrics(sampled);

    // a middle column must be interrupted: top band, hole, bottom band
    const middle = Math.floor(sampled.widthCells / 2);
    const column = sampled.rows.map((row) => row[middle]).join("");
    expect(column).toMatch(/#+\.+#+/);
    expect(metrics.sharesBaseline).toBe(true);
  });

  it("preserves a thin but characteristic feature", () => {
    // one cell wide mast on top of a body, 40 columns down to 20
    const rows = Array.from({ length: 40 }, (_, y) =>
      y < 20
        ? `${".".repeat(20)}#${".".repeat(19)}`
        : `${".".repeat(8)}${"#".repeat(24)}${".".repeat(8)}`,
    );
    const sampled = resampleMask(mask(rows), 20);
    expect(sampled.rows[0]).toContain("#");
  });

  it("drops detail that falls below the coverage threshold", () => {
    // a one cell wide slit inside a solid body: it survives a fine sampling and
    // disappears under a coarse one - the illustrative threshold in action
    const rows = Array.from(
      { length: 40 },
      () => `${"#".repeat(19)}.${"#".repeat(20)}`,
    );
    const body = mask(rows);

    const fine = resampleMask(body, 40);
    expect(fine.rows[0]).toContain(".");

    const coarse = resampleMask(body, 5);
    expect(coarse.rows[0]).toBe("#####");
    expect(COVERAGE_THRESHOLD).toBeLessThan(0.5);
  });

  it("returns an empty raster for an empty mask", () => {
    expect(resampleMask(mask(["....", "...."]), 10)).toEqual({
      widthCells: 0,
      heightCells: 0,
      rows: [],
    });
  });
});

describe("symmetriseGrid", () => {
  it("makes a nearly symmetric raster exactly symmetric", () => {
    const grid = symmetriseGrid(mask(["..##.", ".###."]));
    for (const row of grid.rows) {
      expect(row).toBe([...row].reverse().join(""));
    }
  });
});

describe("mirrorGrid", () => {
  const lopsided = mask([
    ".##...",
    "###...",
    "##....",
  ]);

  it("leaves the raster untouched for mode none", () => {
    expect(mirrorGrid(lopsided, "none")).toEqual(lopsided);
  });

  for (const mode of ["left", "right", "union"] as const) {
    it(`produces an exactly symmetric raster for mode ${mode}`, () => {
      for (const row of mirrorGrid(lopsided, mode).rows) {
        expect(row).toBe([...row].reverse().join(""));
      }
    });
  }

  it("mirrors the left half onto the right", () => {
    expect(mirrorGrid(lopsided, "left").rows).toEqual([
      ".####.",
      "######",
      "##..##",
    ]);
  });

  it("mirrors the right half onto the left", () => {
    // the right half of this shape is empty, so the result is empty as well
    expect(mirrorGrid(lopsided, "right").rows).toEqual([
      "......",
      "......",
      "......",
    ]);
  });

  it("never widens the silhouette in left or right mode", () => {
    const width = (grid: OccupancyGrid) =>
      Math.max(...shapeMetrics(grid).rowWidths, 0);
    const source = mask(["..###.", ".#####", "..###."]);

    expect(width(mirrorGrid(source, "left"))).toBeLessThanOrEqual(width(source) + 1);
    // union may add the details of the other side
    expect(width(mirrorGrid(source, "union"))).toBeGreaterThanOrEqual(width(source));
  });

  it("keeps the centre column of an odd width raster", () => {
    expect(mirrorGrid(mask([".....", "..#.."]), "left").rows).toEqual([".....", "..#.."]);
  });

  it("handles an even width raster without an off by one", () => {
    const grid = mirrorGrid(mask(["#...", "##.."]), "left");
    expect(grid.rows).toEqual(["#..#", "####"]);
  });
});

describe("maskToIllustration", () => {
  const document = {
    subject: "Kreis",
    symmetry: "vertical" as const,
    grid: mask([
      "..####..",
      ".######.",
      "########",
      "########",
      ".######.",
      "..####..",
    ]),
  };

  it("runs mask -> sampling -> bars and keeps the raster rules", () => {
    for (const detail of DETAILS) {
      const { illustration, mask: usedMask, sampled } = maskToIllustration(document, detail);

      expect(usedMask.widthCells).toBe(8);
      expect(sampled.widthCells).toBe(DETAIL_COLUMNS[detail]);
      expect(illustration.bars.length).toBeGreaterThan(0);
      expect(illustration.system).toEqual({ barWidthUnits: 1, gapUnits: 1 });
      expect(validateIllustration(illustration).ok).toBe(true);
    }
  });

  it("increases the sampling density with the detail level", () => {
    const counts = DETAILS.map(
      (detail) => maskToIllustration(document, detail).illustration.bars.length,
    );
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
  });

  it("keeps identical bar widths and identical gaps at every detail level", () => {
    for (const detail of DETAILS) {
      const { illustration } = maskToIllustration(document, detail);
      const rects = layoutRects(illustration, 4);

      expect(new Set(rects.map((rect) => rect.width)).size).toBe(1);
      expect(rects[0].width).toBe(BAR_WIDTH_UNITS * 4);

      const xs = [...new Set(rects.map((rect) => rect.x))].sort((a, b) => a - b);
      const gaps = xs.slice(1).map((x, index) => x - xs[index] - rects[0].width);
      expect(new Set(gaps).size).toBe(1);
      expect(gaps[0]).toBe(GAP_UNITS * 4);
    }
  });

  it("enforces the declared vertical symmetry", () => {
    const { sampled } = maskToIllustration(document, "medium");
    for (const row of sampled.rows) {
      expect(row).toBe([...row].reverse().join(""));
    }
  });

  it("applies an explicitly requested mirror to an asymmetric template", () => {
    // this is what the image template checkbox does
    const lopsided = {
      subject: "Turm",
      grid: mask([
        "...####...",
        "..######..",
        ".#######..",
        "#########.",
      ]),
    };

    const plain = maskToIllustration(lopsided, "medium");
    const mirrored = maskToIllustration(lopsided, "medium", { mirror: "left" });

    const isSymmetric = (rows: string[]) =>
      rows.every((row) => row === [...row].reverse().join(""));

    expect(isSymmetric(plain.sampled.rows)).toBe(false);
    expect(isSymmetric(mirrored.sampled.rows)).toBe(true);
    // the mask shown in the debug view is mirrored as well
    expect(isSymmetric(mirrored.mask.rows)).toBe(true);
    expect(validateIllustration(mirrored.illustration).ok).toBe(true);
  });

  it("mirrors exactly at every detail level", () => {
    const lopsided = {
      subject: "Turm",
      grid: mask(["..###.....", ".#####....", "#######..."]),
    };

    for (const detail of DETAILS) {
      const { sampled } = maskToIllustration(lopsided, detail, { mirror: "left" });
      for (const row of sampled.rows) {
        expect(row, `${detail}: row not symmetric`).toBe([...row].reverse().join(""));
      }
    }
  });

  it("leaves asymmetric motifs untouched", () => {
    const asymmetric = {
      subject: "Fahne",
      symmetry: "none" as const,
      grid: mask(["####....", "####....", "#.......", "#......."]),
    };
    const { sampled } = maskToIllustration(asymmetric, "medium");
    const mirrored = sampled.rows.map((row) => [...row].reverse().join(""));
    expect(mirrored).not.toEqual(sampled.rows);
  });

  it("produces a readable ASCII debug view", () => {
    const { sampled } = maskToIllustration(document, "low");
    expect(gridToAscii(trimGrid(sampled)).split("\n").length).toBeGreaterThan(3);
  });
});
