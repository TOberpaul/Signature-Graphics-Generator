import { describe, expect, it } from "vitest";
import {
  autoThreshold,
  contentBounds,
  cropToContent,
  imageToGrid,
  imageToGridWithDetail,
  imageToMask,
  inkCoverage,
  inkCoverageGrid,
  suggestThreshold,
} from "./imageMask";
import type { RasterImage } from "./imageMask";
import { shapeMetrics, trimGrid } from "./occupancy";
import {
  detailThreshold,
  imageToSignature,
  maskToIllustration,
  maskToSignature,
} from "./shapeMask";
import { validateIllustration } from "./validation";
import { layoutRects } from "./renderer";
import { GAP_UNITS } from "./geometry";

/** Builds an RGBA image from a character map: "#" black, "." white, " " transparent. */
function image(rows: string[]): RasterImage {
  const width = rows[0].length;
  const height = rows.length;
  const data = new Uint8ClampedArray(width * height * 4);

  for (const [y, row] of rows.entries()) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const char = row[x];
      const value = char === "#" ? 0 : 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = char === " " ? 0 : 255;
    }
  }

  return { width, height, data };
}

describe("inkCoverage", () => {
  it("reads a black shape on white as full ink", () => {
    const { values } = inkCoverage(image(["##", "##"]), 2);
    expect(values.every((value) => value === 1)).toBe(true);
  });

  it("treats transparent pixels as background", () => {
    const { values } = inkCoverage(image(["  ", "  "]), 2);
    expect(values.every((value) => value === 0)).toBe(true);
  });

  it("inverts for a light silhouette on a dark ground", () => {
    const dark = inkCoverage(image(["..", ".."]), 2, true);
    expect(dark.values.every((value) => value === 1)).toBe(true);
  });

  it("keeps the aspect ratio of the image", () => {
    const wide = inkCoverage(image(["####", "####"]), 4);
    expect(wide.columns).toBe(4);
    expect(wide.rows).toBeGreaterThanOrEqual(2);
  });
});

describe("autoThreshold", () => {
  it("separates a clean bimodal distribution", () => {
    const coverage = [...Array(50).fill(0), ...Array(50).fill(1)];
    const threshold = autoThreshold(coverage);
    expect(threshold).toBeGreaterThan(0.1);
    expect(threshold).toBeLessThan(0.9);
  });

  it("stays inside sane bounds for degenerate input", () => {
    expect(autoThreshold([])).toBeGreaterThan(0);
    expect(autoThreshold(Array(20).fill(0))).toBeLessThanOrEqual(0.95);
  });
});

describe("imageToMask", () => {
  // a filled circle-ish blob, clearly not a mountain
  const blob = [
    "..####..",
    ".######.",
    "########",
    "########",
    "########",
    ".######.",
    "..####..",
    "...##...",
  ];

  it("produces a mask with the requested resolution", () => {
    const mask = imageToMask(image(blob), { columns: 8, threshold: 0.5 });
    expect(mask.widthCells).toBe(8);
    expect(mask.rows).toHaveLength(mask.heightCells);
    expect(mask.rows.every((row) => row.length === 8)).toBe(true);
  });

  it("reproduces the silhouette at matching resolution", () => {
    const mask = imageToMask(image(blob), { columns: 8, threshold: 0.5 });
    expect(mask.rows).toEqual(blob);
  });

  it("downsamples larger images without losing the shape character", () => {
    // scale the blob up by four, then reduce again
    const scaled = blob.flatMap((row) => {
      const wide = [...row].flatMap((char) => [char, char, char, char]).join("");
      return [wide, wide, wide, wide];
    });

    const mask = imageToMask(image(scaled), { columns: 8, threshold: 0.5 });
    expect(mask.rows).toEqual(blob);
  });

  it("a higher threshold keeps less ink", () => {
    const soft = ["....", ".##.", ".##.", "...."].map((row) =>
      row.replace(/#/g, "#").replace(/\./g, "."),
    );
    const low = imageToMask(image(soft), { columns: 4, threshold: 0.2 });
    const high = imageToMask(image(soft), { columns: 4, threshold: 0.9 });

    const count = (rows: string[]) => rows.join("").split("#").length - 1;
    expect(count(low.rows)).toBeGreaterThanOrEqual(count(high.rows));
  });

  it("returns an empty mask for a blank image", () => {
    const mask = imageToMask(image(["....", "...."]), { columns: 4 });
    expect(mask.rows.join("")).not.toContain("#");
    expect(trimGrid(mask).widthCells).toBe(0);
  });

  it("suggests a usable threshold", () => {
    const threshold = suggestThreshold(image(blob), { columns: 8 });
    const mask = imageToMask(image(blob), { columns: 8, threshold });
    expect(trimGrid(mask).widthCells).toBeGreaterThan(0);
  });
});

describe("image template through the full pipeline", () => {
  // a pear like silhouette: narrow neck, wide round belly, rounded bottom
  const pear = [
    "......##......",
    "......##......",
    ".....####.....",
    "....######....",
    "...########...",
    "..##########..",
    ".############.",
    "##############",
    "##############",
    "##############",
    ".############.",
    "..##########..",
    "....######....",
  ];

  it("maps an image template to a valid bar illustration", () => {
    const mask = imageToMask(image(pear), { columns: 14, threshold: 0.5 });
    const { illustration, sampled } = maskToIllustration(
      { subject: "Birne", symmetry: "vertical", grid: mask },
      "medium",
    );

    expect(validateIllustration(illustration).ok).toBe(true);
    expect(illustration.system).toEqual({ barWidthUnits: 1, gapUnits: 1 });
    expect(sampled.widthCells).toBeGreaterThan(mask.widthCells);
  });

  it("keeps identical bar widths and gaps", () => {
    const mask = imageToMask(image(pear), { columns: 14, threshold: 0.5 });
    const { illustration } = maskToIllustration({ subject: "Birne", grid: mask }, "medium");
    const rects = layoutRects(illustration, 4);

    expect(new Set(rects.map((rect) => rect.width)).size).toBe(1);
    const xs = [...new Set(rects.map((rect) => rect.x))].sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, index) => x - xs[index] - rects[0].width);
    expect(new Set(gaps).size).toBe(1);
    expect(gaps[0]).toBe(GAP_UNITS * 4);
  });

  it("does not turn a pear template into a mountain", () => {
    const mask = imageToMask(image(pear), { columns: 14, threshold: 0.5 });
    const { sampled } = maskToIllustration({ subject: "Birne", grid: mask }, "medium");
    const metrics = shapeMetrics(sampled);

    expect(metrics.widestAt).toBeGreaterThan(0.4);
    expect(metrics.bottomWidth).toBeLessThan(metrics.maxWidth);
    expect(metrics.sharesBaseline).toBe(false);
  });
});

describe("content crop", () => {
  it("drops the empty border without touching the motif", () => {
    const bordered = image([
      "......",
      "..##..",
      ".####.",
      "..##..",
      "......",
    ]);

    expect(contentBounds(bordered)).toEqual({ x: 1, y: 1, width: 4, height: 3 });

    const cropped = cropToContent(bordered);
    expect(cropped.width).toBe(4);
    expect(cropped.height).toBe(3);
  });

  it("reports null for an empty image", () => {
    expect(contentBounds(image(["...", "..."]))).toBeNull();
  });
});

describe("single stage rastering", () => {
  /** Tall motif with a wide empty margin, solid bands and mid grey infill. */
  function tower(): RasterImage {
    const rows: string[] = ["..............", ".............."];
    for (let i = 0; i < 12; i += 1) {
      const solid = i === 5 || i === 9;
      const half = Math.max(1, Math.round((i / 11) * 5));
      const fill = (solid ? "#" : "+").repeat(half * 2);
      const pad = ".".repeat((14 - fill.length) / 2);
      rows.push((pad + fill + pad).slice(0, 14));
    }
    rows.push("..............");

    const width = rows[0].length;
    const height = rows.length;
    const data = new Uint8ClampedArray(width * height * 4);
    for (const [y, row] of rows.entries()) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const char = row[x];
        const value = char === "#" ? 0 : char === "+" ? 150 : 255;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }
    return { width, height, data };
  }

  it("measures the image on an anisotropic grid without an intermediate mask", () => {
    // A stroke cell is 2 dp wide but only 1 dp tall, so the grid is deliberately
    // not square. Values have to be real area averages, not nearest pixel picks.
    const values = inkCoverageGrid(tower(), 4, 12);

    expect(values).toHaveLength(48);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    // the empty top row cannot carry ink, the solid band must
    expect(values.slice(0, 4).every((value) => value === 0)).toBe(true);
    expect(Math.max(...values)).toBeGreaterThan(0.5);
  });

  it("keeps size and position identical across thresholds", () => {
    const cropped = cropToContent(tower());
    const placements = new Set<string>();
    const fills = new Set<number>();

    for (const threshold of [0.15, 0.35, 0.55, 0.9]) {
      const { illustration, plan, sampled } = imageToSignature(
        cropped,
        { subject: "Turm" },
        { threshold, cleanup: 0.2, allowExtendedFormat: true },
      );

      placements.add(
        `${plan.format} ${plan.columnsUsed}x${plan.rowsUsed} @${plan.offsetColumns},${plan.offsetRows}`,
      );
      fills.add([...sampled.rows.join("")].filter((c) => c === "#").length);
      expect(validateIllustration(illustration).ok).toBe(true);
    }

    // The fit is settled before any cell is classified, so it never moves ...
    expect(placements.size).toBe(1);
    // ... while the threshold does change which cells are filled.
    expect(fills.size).toBeGreaterThan(1);
  });
});

describe("placement after a content crop", () => {
  /**
   * The crop and the fit run before any thresholding, so the threshold may only
   * change which cells are filled - never the size or position of the motif.
   * This is the invariant that keeps the preview from jumping while the slider
   * moves.
   */
  it("keeps size and position identical across thresholds", () => {
    // Tall motif with a wide empty margin, solid bands and lighter infill, so
    // the thresholded silhouette really does change between the extremes.
    const rows: string[] = [];
    rows.push("..............");
    for (let i = 0; i < 12; i += 1) {
      const solid = i === 5 || i === 9;
      const half = Math.max(1, Math.round((i / 11) * 5));
      const fill = (solid ? "#" : "+").repeat(half * 2);
      const pad = ".".repeat((14 - fill.length) / 2);
      rows.push((pad + fill + pad).slice(0, 14));
    }
    rows.push("..............");

    // "+" is mid grey, so it sits between the two thresholds below.
    const width = rows[0].length;
    const height = rows.length;
    const data = new Uint8ClampedArray(width * height * 4);
    for (const [y, row] of rows.entries()) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const char = row[x];
        const value = char === "#" ? 0 : char === "+" ? 150 : 255;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }

    const cropped = cropToContent({ width, height, data });
    const placements = new Set<string>();

    for (const threshold of [0.15, 0.35, 0.55, 0.9]) {
      const grid = imageToMask(cropped, { columns: 48, threshold });
      const { plan } = maskToSignature(
        { subject: "Turm", grid },
        { cleanup: 0.2, coverage: 0, allowExtendedFormat: true, extentIsMotif: true },
      );
      placements.add(
        `${plan.format} ${plan.columnsUsed}x${plan.rowsUsed} @${plan.offsetColumns},${plan.offsetRows}`,
      );
    }

    expect(placements.size).toBe(1);
  });
});

/**
 * Builds an image with a mid grey level: "#" black, "+" grey, "." white.
 *
 * Grey is what the two thresholds are about. A cell that is only partly covered
 * passes a low threshold and fails a high one, and that is true both for a window
 * inside the shape and for the soft outer edge of the silhouette - which is
 * exactly why they have to be told apart by position rather than by ink.
 */
function greyImage(rows: string[]): RasterImage {
  const width = rows[0].length;
  const height = rows.length;
  const data = new Uint8ClampedArray(width * height * 4);
  // "#" black, ":" dark grey, "+" mid grey, "." white. Two grey levels are needed
  // to build a group that only breaks through to the outside at a higher level.
  const levels: Record<string, number> = { "#": 0, ":": 77, "+": 128, ".": 255 };

  for (const [y, row] of rows.entries()) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = levels[row[x]] ?? 255;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }

  return { width, height, data };
}

describe("imageToGridWithDetail", () => {
  // Grey ring around a black wall with a grey middle. At a low threshold every
  // grey cell is filled; the strict pass has to open the middle and keep the ring.
  const template = [
    "+++++",
    "+###+",
    "+#+#+",
    "+###+",
    "+++++",
  ];

  it("opens an enclosed area without eroding the outline", () => {
    const grid = imageToGridWithDetail(greyImage(template), 5, 5, 0.3, 0.8);

    expect(grid.rows).toEqual([
      "#####",
      "#####",
      "##.##",
      "#####",
      "#####",
    ]);
  });

  it("matches the single threshold grid when there is nothing stricter to find", () => {
    const image = greyImage(template);
    // detailThreshold at or below the threshold has no stricter decision to make.
    expect(imageToGridWithDetail(image, 5, 5, 0.3, 0.3).rows).toEqual(
      imageToGrid(image, 5, 5, 0.3).rows,
    );
    expect(imageToGridWithDetail(image, 5, 5, 0.3, 0.1).rows).toEqual(
      imageToGrid(image, 5, 5, 0.3).rows,
    );
  });

  it("only ever opens more as the detail level rises", () => {
    // The complaint this guards against: an opening appeared at one setting and was
    // gone again at a higher one, which makes the control impossible to reason
    // about.
    //
    // The mid grey middle is a candidate from a low level on, enclosed by the dark
    // grey ring, and gets opened. Higher up the ring becomes a candidate too, the
    // group grows to include it, and now it touches the white outside - so it is no
    // longer enclosed and the opening would be lost again.
    const image = greyImage([".....", ".:::.", ".:+:.", ".:::.", "....."]);

    let previous = 0;
    for (let detail = 0; detail <= 1.0001; detail += 0.05) {
      const grid = imageToGridWithDetail(
        image,
        5,
        5,
        0.3,
        detailThreshold(0.3, detail),
      );
      const open = [...grid.rows.join("")].filter((cell) => cell === ".").length;

      expect(
        open,
        `detail ${detail.toFixed(2)} opened fewer cells than the setting below it`,
      ).toBeGreaterThanOrEqual(previous);
      previous = open;
    }

    // And the middle really does open at some point, so the test is not just
    // watching a shape that never changes.
    const fully = imageToGridWithDetail(image, 5, 5, 0.3, detailThreshold(0.3, 1));
    expect(fully.rows[2][2]).toBe(".");
  });

  it("leaves an opening that reaches the edge closed", () => {
    // The grey area now runs out to the border, so it is the soft rim of the
    // silhouette rather than a window. Opening it would break the outline.
    const open = ["+++++", "+###+", "+#+++", "+###+", "+++++"];
    const grid = imageToGridWithDetail(greyImage(open), 5, 5, 0.3, 0.8);

    expect(grid.rows.join("\n")).not.toContain(".");
  });
});

describe("detailThreshold", () => {
  it("stays at the outline threshold when detail is off", () => {
    expect(detailThreshold(0.4, 0)).toBe(0.4);
  });

  it("never falls below the outline threshold", () => {
    for (const threshold of [0.05, 0.5, 0.9]) {
      for (const detail of [0, 0.25, 0.5, 1]) {
        expect(detailThreshold(threshold, detail)).toBeGreaterThanOrEqual(threshold);
      }
    }
  });

  it("keeps room below full coverage at full strength", () => {
    expect(detailThreshold(0.1, 1)).toBeLessThan(1);
  });
});
