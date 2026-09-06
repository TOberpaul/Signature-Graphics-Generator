import { describe, expect, it } from "vitest";
import { DP, DP_PITCH, FORMATS, SIGNATURE_SYSTEM } from "./geometry";
import {
  chooseFormat,
  chooseFormatForExtent,
  cleanMask,
  constructStrokes,
  placeInDrawable,
  planSignatureCanvas,
  planSignatureCanvasForExtent,
  strokesToIllustration,
} from "./signature";
import { maskToSignature } from "./shapeMask";
import { validateIllustration } from "./validation";
import { layoutRects, renderIllustration } from "./renderer";
import type { OccupancyGrid } from "./occupancy";
import type { ConstructedStrokes } from "./signature";

function grid(rows: string[]): OccupancyGrid {
  return { widthCells: rows[0]?.length ?? 0, heightCells: rows.length, rows };
}

/** Solid block of the requested size, a stand in for a compact motif. */
function block(width: number, height: number): OccupancyGrid {
  return grid(Array.from({ length: height }, () => "#".repeat(width)));
}

describe("cleanMask", () => {
  it("removes small fragments but keeps the main shape", () => {
    const rows = [
      "########..",
      "########..",
      "########..",
      "########..",
      "..........",
      ".........#", // single speck
    ];

    const cleaned = cleanMask(grid(rows));
    expect(cleaned.rows[5]).toBe("..........");
    expect(cleaned.rows[0]).toBe("########..");
  });

  it("fills pinholes that would become an illegal sub 4 dp gap", () => {
    const rows = [
      "######",
      "######",
      "##.###",
      "######",
      "######",
    ];

    expect(cleanMask(grid(rows)).rows[2]).toBe("######");
  });

  it("preserves a large characteristic negative space", () => {
    // a gate like opening spanning a third of the shape
    const rows = Array.from({ length: 12 }, (_, y) =>
      y >= 4 && y <= 10 ? "###....###" : "##########",
    );

    const cleaned = cleanMask(grid(rows));
    expect(cleaned.rows[6]).toBe("###....###");
  });
});

describe("planSignatureCanvas", () => {
  it("derives a 90 dp drawable area with 23 strokes from the ideal format", () => {
    const plan = planSignatureCanvas(block(40, 40), "square");

    // 96 dp format minus 3 dp safe area on both sides
    expect(plan.widthDp).toBe(DP.baseCanvas - DP.safeArea * 2);
    expect(plan.rows).toBe(DP.baseCanvas - DP.safeArea * 2);
    // 23 * 4 - 2 = 90
    expect(plan.columns).toBe(23);
    expect(plan.columns * DP_PITCH - DP.horizontalGap).toBe(plan.widthDp);
  });

  it("adds up to exactly the format once the safe area is included", () => {
    for (const format of ["square", "landscape", "portrait"] as const) {
      const plan = planSignatureCanvas(block(40, 40), format);
      expect(plan.widthDp + DP.safeArea * 2).toBe(FORMATS[format].widthDp);
      expect(plan.rows + DP.safeArea * 2).toBe(FORMATS[format].heightDp);
    }
  });

  it("keeps the stroke count fixed for a given format", () => {
    const wide = planSignatureCanvas(block(60, 20), "square");
    const tall = planSignatureCanvas(block(20, 60), "square");
    expect(wide.columns).toBe(tall.columns);
  });

  it("fits the motif without stretching it", () => {
    // twice as tall as wide, so the height runs out first
    const plan = planSignatureCanvas(block(20, 40), "square");
    const ratio = plan.rowsUsed / (plan.columnsUsed * DP_PITCH - DP.horizontalGap);
    expect(ratio).toBeGreaterThan(2 * 0.9);
    expect(ratio).toBeLessThan(2 * 1.1);
  });

  it("uses the full drawable height for a tall motif and centres it", () => {
    const plan = planSignatureCanvas(block(20, 40), "square");
    expect(plan.rowsUsed).toBe(plan.rows);
    expect(plan.columnsUsed).toBeLessThan(plan.columns);
    expect(plan.offsetColumns).toBeGreaterThan(0);
    // centred: the same margin is left on both sides, give or take a rounding
    const right = plan.columns - plan.columnsUsed - plan.offsetColumns;
    expect(Math.abs(right - plan.offsetColumns)).toBeLessThanOrEqual(1);
  });

  it("uses the full drawable width for a wide motif and centres it", () => {
    const plan = planSignatureCanvas(block(40, 20), "square");
    expect(plan.columnsUsed).toBe(plan.columns);
    expect(plan.rowsUsed).toBeLessThan(plan.rows);
    expect(plan.offsetRows).toBeGreaterThan(0);
  });
});

describe("centring", () => {
  /**
   * The motif has to sit exactly in the middle of the format. Rounding the fit to
   * whole slots can leave an odd number of spare slots, which cannot be split in
   * two - at a 4 dp pitch that shows as a visible sideways shift. The plan
   * therefore trades at most one slot of size for an even leftover.
   */
  it("leaves equal margins on both axes for every aspect ratio", () => {
    const offenders: string[] = [];

    for (let width = 40; width <= 600; width += 7) {
      for (let height = 40; height <= 600; height += 11) {
        const format = chooseFormatForExtent(width, height, true);
        const plan = planSignatureCanvasForExtent(width, height, format);
        const pad = DP.safeArea;

        const totalWidth = plan.widthDp + pad * 2;
        const totalHeight = plan.rows + pad * 2;

        const left = pad + plan.offsetColumns * DP_PITCH;
        const right =
          totalWidth - (left + (plan.columnsUsed * DP_PITCH - DP.horizontalGap));
        const top = pad + plan.offsetRows;
        const bottom = totalHeight - (top + plan.rowsUsed);

        if (left !== right || top !== bottom) {
          offenders.push(`${width}x${height} ${format} lr=${left}/${right} tb=${top}/${bottom}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("chooseFormat", () => {
  it("always stays square without permission", () => {
    expect(chooseFormat(block(20, 60), false)).toBe("square");
    expect(chooseFormat(block(60, 20), false)).toBe("square");
  });

  it("picks the extended format matching the motif when permitted", () => {
    expect(chooseFormat(block(20, 60), true)).toBe("portrait");
    expect(chooseFormat(block(60, 20), true)).toBe("landscape");
  });

  it("keeps a roughly square motif square even when permitted", () => {
    expect(chooseFormat(block(40, 40), true)).toBe("square");
    expect(chooseFormat(block(40, 44), true)).toBe("square");
  });
});

describe("placeInDrawable", () => {
  it("keeps the safe area clear by centring the motif in the format", () => {
    const plan = planSignatureCanvas(block(20, 40), "square");
    const motif = block(plan.columnsUsed, plan.rowsUsed);
    const placed = placeInDrawable(motif, plan);

    expect(placed.widthCells).toBe(plan.columns);
    expect(placed.heightCells).toBe(plan.rows);
    // the columns left and right of the motif stay empty
    for (const row of placed.rows) {
      expect(row.slice(0, plan.offsetColumns)).not.toContain("#");
    }
  });
});

describe("constructStrokes", () => {
  it("never emits a stroke below the minimum length", () => {
    const strokes = constructStrokes(block(6, 40));
    for (const column of strokes.columns) {
      for (const run of column.runs) {
        expect(run.height).toBeGreaterThanOrEqual(DP.minStrokeLength);
      }
    }
  });

  it("only leaves legal vertical gaps: 1 dp or at least 4 dp", () => {
    // two blocks separated by an ambiguous 2 dp gap
    const rows = [
      ...Array.from({ length: 8 }, () => "######"),
      "......",
      "......",
      ...Array.from({ length: 8 }, () => "######"),
    ];

    const strokes = constructStrokes(grid(rows));
    for (const column of strokes.columns) {
      for (let index = 1; index < column.runs.length; index += 1) {
        const previous = column.runs[index - 1];
        const gap = column.runs[index].y - (previous.y + previous.height);
        const legal = gap === DP.tightVerticalGap || gap >= DP.intentionalVerticalGap;
        expect(legal).toBe(true);
      }
    }
  });

  it("keeps a large negative space untouched", () => {
    const rows = [
      ...Array.from({ length: 8 }, () => "######"),
      ...Array.from({ length: 8 }, () => "......"),
      ...Array.from({ length: 8 }, () => "######"),
    ];

    const strokes = constructStrokes(grid(rows));
    const column = strokes.columns[0];
    expect(column.runs.length).toBe(2);
    const gap = column.runs[1].y - (column.runs[0].y + column.runs[0].height);
    expect(gap).toBeGreaterThanOrEqual(DP.intentionalVerticalGap);
  });

  it("turns a thin horizontal feature into short vertical strokes", () => {
    // a 2 dp platform: too short to be a legal stroke, too wide to be a fragment
    const rows = [
      "..........",
      "##########",
      "##########",
      "..........",
    ];

    const strokes = constructStrokes(grid(rows));
    expect(strokes.report.levelsBanded).toBeGreaterThan(0);
    for (const column of strokes.columns) {
      for (const run of column.runs) {
        expect(run.height).toBeGreaterThanOrEqual(DP.minStrokeLength);
      }
    }
  });

  it("keeps a straight contour edge straight", () => {
    // A flat top and bottom are characteristic parts of the form - the base of a
    // popsicle, a plinth, a baseline - and must not be staggered into noise.
    const strokes = constructStrokes(block(10, 40));

    const tops = new Set(strokes.columns.map((column) => column.runs[0].y));
    const bottoms = new Set(
      strokes.columns.map((column) => {
        const last = column.runs[column.runs.length - 1];
        return last.y + last.height;
      }),
    );

    expect(tops.size).toBe(1);
    expect(bottoms.size).toBe(1);
  });

  it("staggers a level band horizontally by 2 dp", () => {
    const rows = ["..........", "##########", "##########", ".........."];
    const strokes = constructStrokes(grid(rows));
    expect(strokes.columns.every((column) => column.offset === DP.rowOffset)).toBe(true);
  });
});

describe("solid strokes", () => {
  /**
   * A column of solid blocks separated by small 2 dp gaps (the internal texture
   * of a lattice or masonry), plus one large deliberate opening in the middle.
   * Blocks are long enough to survive fragment removal, so the difference the
   * option makes is unambiguous.
   */
  function texturedColumn(): OccupancyGrid {
    const rows: string[] = [];
    const block6 = () => {
      for (let i = 0; i < 6; i += 1) rows.push("#");
    };
    const gap = (n: number) => {
      for (let i = 0; i < n; i += 1) rows.push(".");
    };
    // three blocks with small 2 dp gaps - the fine texture
    block6();
    gap(2);
    block6();
    gap(2);
    block6();
    // a large opening - a deliberate feature
    gap(DP.intentionalVerticalGap);
    // solid base
    block6();
    return grid(rows);
  }

  it("fuses fine gaps into one stroke while keeping the large opening", () => {
    const column = constructStrokes(texturedColumn(), {
      fuseGapsBelow: DP.intentionalVerticalGap,
    }).columns[0];

    // The textured top collapses to a single stroke; the large opening splits it
    // from the base, so exactly two runs remain.
    expect(column.runs.length).toBe(2);
    const gap = column.runs[1].y - (column.runs[0].y + column.runs[0].height);
    expect(gap).toBeGreaterThanOrEqual(DP.intentionalVerticalGap);
  });

  it("leaves every gap in place at zero", () => {
    const solid = constructStrokes(texturedColumn(), {
      fuseGapsBelow: DP.intentionalVerticalGap,
    }).columns[0];
    const chopped = constructStrokes(texturedColumn(), { fuseGapsBelow: 0 }).columns[0];

    // Without fusing, the small gaps stay, so more runs survive.
    expect(chopped.runs.length).toBeGreaterThan(solid.runs.length);
  });

  it("keeps more of the structure as the threshold drops", () => {
    // The dial is monotonic: a lower threshold can only leave more runs standing,
    // which is what makes the slider predictable.
    const counts = [0, 1, 2, 3, 4].map(
      (fuseGapsBelow) =>
        constructStrokes(texturedColumn(), { fuseGapsBelow }).columns[0].runs.length,
    );

    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});

describe("cleanup versus fusing", () => {
  /**
   * The two do different jobs, and neither replaces the other:
   *
   * - fusing only ever *joins* runs, and only across gaps below its threshold
   * - cleanup *removes* freestanding specks and fills holes, whatever their size
   *   relative to the shape
   *
   * A hole as large as a deliberate opening is therefore out of reach for the
   * fuse at any setting, but well within reach of the cleanup.
   */
  function shapeWithBigHole(): OccupancyGrid {
    const rows: string[] = [];
    for (let i = 0; i < 12; i += 1) rows.push("##########");
    // a hole the size of a deliberate opening, in the middle columns only
    for (let i = 0; i < DP.intentionalVerticalGap; i += 1) rows.push("####..####");
    for (let i = 0; i < 12; i += 1) rows.push("##########");
    return grid(rows);
  }

  it("cannot be replaced by fusing at any threshold", () => {
    const holed = shapeWithBigHole();
    const middle = 5;

    // The fuse never closes it, because the gap is not below the threshold.
    for (const fuseGapsBelow of [0, 1, 2, 3, 4]) {
      const column = constructStrokes(holed, { fuseGapsBelow }).columns[middle];
      expect(column.runs.length).toBe(2);
    }

    // The cleanup does, because the hole is small next to the shape around it.
    const cleaned = cleanMask(holed, { maxHoleRatio: 0.2, maxFragmentCells: 0 });
    const column = constructStrokes(cleaned, { fuseGapsBelow: 0 }).columns[middle];
    expect(column.runs.length).toBe(1);
  });
});

describe("manual seams", () => {
  it("cuts a seam across every column at the given row", () => {
    // A plain block fuses into one stroke per column, so the seam is the only
    // thing that can break it - which is exactly the soft-shape case (a dome)
    // where nothing can be detected automatically.
    const plain = constructStrokes(block(10, 40));
    expect(plain.columns[0].runs.length).toBe(1);

    const seamed = constructStrokes(block(10, 40), { manualSeams: [{ row: 20 }] });

    for (const column of seamed.columns) {
      const runs = [...column.runs].sort((a, b) => a.y - b.y);
      expect(runs.length).toBe(2);
      expect(runs[1].y - (runs[0].y + runs[0].height)).toBe(DP.tightVerticalGap);
    }
  });

  it("survives the fuse step", () => {
    // Seams are applied after fusing, so joining columns can never close them.
    const seamed = constructStrokes(block(10, 40), {
      fuseGapsBelow: DP.intentionalVerticalGap,
      manualSeams: [{ row: 15 }, { row: 30 }],
    });

    for (const column of seamed.columns) {
      expect(column.runs.length).toBe(3);
    }
  });

  it("cuts only the slots inside the seam's range", () => {
    // The Hagia Sophia case: a level of the central building is not a level of
    // the minarets beside it, so cutting across them would invent an edge.
    const seamed = constructStrokes(block(10, 40), {
      fuseGapsBelow: DP.intentionalVerticalGap,
      manualSeams: [{ row: 20, from: 3, to: 6 }],
    });

    for (const column of seamed.columns) {
      const inRange = column.x >= 3 && column.x <= 6;
      expect(column.runs.length).toBe(inRange ? 2 : 1);
    }
  });

  it("cuts two seams on the same row and leaves the middle whole", () => {
    // A symmetric facade: the same level is cut on the left and on the right,
    // while the centre part runs through uninterrupted.
    const seamed = constructStrokes(block(11, 40), {
      fuseGapsBelow: DP.intentionalVerticalGap,
      manualSeams: [
        { row: 20, from: 0, to: 2 },
        { row: 20, from: 8, to: 10 },
      ],
    });

    for (const column of seamed.columns) {
      const cut = column.x <= 2 || column.x >= 8;
      expect(column.runs.length).toBe(cut ? 2 : 1);
    }
  });

  it("leaves no run below the minimum length between two close seams", () => {
    // Two seams 3 dp apart: whatever sits between them is shorter than a legal
    // stroke, so it has to go rather than survive as a stub.
    const seamed = constructStrokes(block(6, 40), {
      fuseGapsBelow: DP.intentionalVerticalGap,
      manualSeams: [{ row: 20 }, { row: 23 }],
    });

    for (const column of seamed.columns) {
      for (const run of column.runs) {
        expect(run.height).toBeGreaterThanOrEqual(DP.minStrokeLength);
      }
    }
  });

  it("keeps the seam open after sweeping fragments", () => {
    // The fragment sweep runs after the final cut, so it must not be able to
    // close the gap the cut just guaranteed.
    const seamed = constructStrokes(block(6, 40), {
      fuseGapsBelow: DP.intentionalVerticalGap,
      manualSeams: [{ row: 20 }],
    });

    for (const column of seamed.columns) {
      expect(column.runs.length).toBe(2);
    }
  });

  it("treats an open ended range as reaching the edge", () => {
    const seamed = constructStrokes(block(10, 40), {
      fuseGapsBelow: DP.intentionalVerticalGap,
      manualSeams: [{ row: 20, to: 4 }],
    });

    for (const column of seamed.columns) {
      expect(column.runs.length).toBe(column.x <= 4 ? 2 : 1);
    }
  });

  it("survives every automatic rule, including edge alignment", () => {
    // A seam is the last operation, so nothing downstream can close it: not the
    // fuse, not edge normalisation, not fragment removal, not gap snapping.
    const seamed = constructStrokes(block(10, 40), {
      fuseGapsBelow: DP.intentionalVerticalGap,
      edgeTolerance: 8,
      manualSeams: [{ row: 20 }],
    });

    for (const column of seamed.columns) {
      const runs = [...column.runs].sort((a, b) => a.y - b.y);
      expect(runs.length).toBe(2);
      expect(runs[1].y - (runs[0].y + runs[0].height)).toBe(DP.tightVerticalGap);
    }
  });

  it("drops a stub that a seam leaves too short, but keeps the gap open", () => {
    // A single tall column, so the stub below the seam cannot be mistaken for a
    // horizontal level. Seam near the bottom leaves a 2 dp piece below it, which
    // is shorter than the minimum stroke and should be cleaned away.
    const column = block(1, 40);
    const seamed = constructStrokes(column, {
      fuseGapsBelow: DP.intentionalVerticalGap,
      manualSeams: [{ row: 37 }],
    });

    const runs = [...seamed.columns[0].runs].sort((a, b) => a.y - b.y);
    // only the long upper stroke remains; the stub below the seam is gone
    expect(runs.length).toBe(1);
    expect(runs[0].y + runs[0].height).toBeLessThanOrEqual(37);
  });
});

/**
 * Popsicle: domed top, straight bottom edge, narrow stick below. The straight
 * bottom is the case that a contour stagger used to destroy.
 */
function popsicle(): OccupancyGrid {
  const width = 48;
  const height = 96;
  const bodyLeft = 8;
  const bodyRight = 39;
  const bodyTop = 4;
  const bodyBottom = 64;
  const stickLeft = 20;
  const stickRight = 27;
  const stickBottom = 92;
  const radius = (bodyRight - bodyLeft) / 2;
  const centreX = (bodyLeft + bodyRight) / 2;

  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      let filled = false;

      if (y >= bodyTop && y <= bodyBottom && x >= bodyLeft && x <= bodyRight) {
        const intoDome = y - bodyTop;
        if (intoDome >= radius) {
          filled = true;
        } else {
          // circular cap on top of the straight sides
          const dy = radius - intoDome;
          const halfWidth = Math.sqrt(Math.max(0, radius * radius - dy * dy));
          filled = Math.abs(x - centreX) <= halfWidth;
        }
      }

      if (y > bodyBottom && y <= stickBottom && x >= stickLeft && x <= stickRight) {
        filled = true;
      }

      line += filled ? "#" : ".";
    }
    rows.push(line);
  }

  return { widthCells: width, heightCells: height, rows };
}

describe("straight edges", () => {
  it("keeps the straight bottom of a popsicle body straight", () => {
    const { illustration } = maskToSignature(
      { subject: "Eis", grid: popsicle() },
      {},
    );

    // Columns that only carry the body end on its bottom edge. Stick columns
    // continue further down and are therefore excluded.
    const bottoms = illustration.bars.map((bar) => {
      const last = bar.segments[bar.segments.length - 1];
      return last.y + last.height;
    });

    const deepest = Math.max(...bottoms);
    const bodyBottoms = bottoms.filter((bottom) => bottom < deepest);

    expect(bodyBottoms.length).toBeGreaterThan(4);
    expect(new Set(bodyBottoms).size).toBe(1);
  });

  it("keeps the straight bottom of the stick straight", () => {
    const { illustration } = maskToSignature(
      { subject: "Eis", grid: popsicle() },
      {},
    );

    const bottoms = illustration.bars.map((bar) => {
      const last = bar.segments[bar.segments.length - 1];
      return last.y + last.height;
    });

    const deepest = Math.max(...bottoms);
    const stickBottoms = bottoms.filter((bottom) => bottom === deepest);

    expect(stickBottoms.length).toBeGreaterThan(1);
  });
});

describe("strokesToIllustration", () => {
  it("uses the dp accurate system and the 3 dp safe area", () => {
    const plan = planSignatureCanvas(block(40, 40), "square");
    const strokes = constructStrokes(block(plan.columns, plan.rows));
    const illustration = strokesToIllustration({ subject: "Block" }, strokes, plan);

    expect(illustration.system).toEqual(SIGNATURE_SYSTEM);
    expect(illustration.system.barWidthUnits).toBe(DP.strokeWidth);
    expect(illustration.system.gapUnits).toBe(DP.horizontalGap);
    expect(illustration.canvas.paddingUnits).toBe(DP.safeArea);
    expect(validateIllustration(illustration).ok).toBe(true);
  });

  it("renders strokes 2 dp wide and 2 dp apart", () => {
    const plan = planSignatureCanvas(block(40, 40), "square");
    const strokes = constructStrokes(block(plan.columns, plan.rows));
    const illustration = strokesToIllustration({ subject: "Block" }, strokes, plan);

    // one pixel per dp keeps the assertion readable
    const rects = layoutRects(illustration, 1);
    for (const rect of rects) {
      expect(rect.width).toBe(DP.strokeWidth);
    }

    const lefts = [...new Set(rects.map((rect) => rect.x))].sort((a, b) => a - b);
    for (let index = 1; index < lefts.length; index += 1) {
      const distance = lefts[index] - lefts[index - 1];
      // neighbouring slots sit one pitch apart, a staggered band half a pitch
      expect(distance === DP_PITCH || distance === DP.rowOffset).toBe(true);
    }
  });
});

describe("format and cropping", () => {
  /** A motif with a wide empty margin and a speck in a far corner. */
  function motifWithMargin(): OccupancyGrid {
    const size = 120;
    const rows: string[] = [];
    for (let y = 0; y < size; y += 1) {
      let line = "";
      for (let x = 0; x < size; x += 1) {
        const inMotif = y >= 40 && y <= 79 && x >= 40 && x <= 79;
        const isSpeck = y === 2 && x === 2;
        line += inMotif || isSpeck ? "#" : ".";
      }
      rows.push(line);
    }
    return { widthCells: size, heightCells: size, rows };
  }

  it("renders exactly the 96x96 dp format", () => {
    const { illustration } = maskToSignature(
      { subject: "Block", grid: motifWithMargin() },
      {},
    );
    const { width, height } = renderIllustration(illustration, { unitSize: 1 });

    expect(width).toBe(DP.baseCanvas);
    expect(height).toBe(DP.baseCanvas);
  });

  it("crops the empty margin away so the motif fills the drawable area", () => {
    const { plan } = maskToSignature(
      { subject: "Block", grid: motifWithMargin() },
      {},
    );

    // A square motif fills both axes of the square drawable area.
    expect(plan.rowsUsed).toBe(plan.rows);
    expect(plan.columnsUsed).toBeGreaterThanOrEqual(plan.columns - 1);
  });

  it("removes a stray speck before cropping, so it cannot shrink the motif", () => {
    // The speck sits far from the motif. If it survived into the crop, the
    // bounding box would roughly triple and the motif would be fitted tiny.
    const { mask } = maskToSignature(
      { subject: "Block", grid: motifWithMargin() },
      {},
    );

    expect(mask.widthCells).toBeLessThanOrEqual(41);
    expect(mask.heightCells).toBeLessThanOrEqual(41);
  });

  it("renders the extended format only when it is permitted", () => {
    const tall = { subject: "Turm", grid: block(20, 60) } as const;

    const square = renderIllustration(
      maskToSignature(tall, { allowExtendedFormat: false }).illustration,
      { unitSize: 1 },
    );
    expect(square.width).toBe(DP.baseCanvas);
    expect(square.height).toBe(DP.baseCanvas);

    const extended = renderIllustration(
      maskToSignature(tall, { allowExtendedFormat: true }).illustration,
      { unitSize: 1 },
    );
    expect(extended.width).toBe(DP.baseCanvas);
    expect(extended.height).toBe(DP.extendedCanvas);
  });
});

describe("tips and thin features", () => {
  /** Tower with a spire tapering to a point. */
  function spire(): OccupancyGrid {
    const w = 120;
    const h = 240;
    const centre = 60;
    const rows: string[] = [];

    for (let y = 0; y < h; y += 1) {
      let line = "";
      for (let x = 0; x < w; x += 1) {
        const half = y < 60 ? (y / 60) * 22 : y < 220 ? 30 : 45;
        line += Math.abs(x - centre) <= half ? "#" : ".";
      }
      rows.push(line);
    }
    return { widthCells: w, heightCells: h, rows };
  }

  it("keeps a pointed spire pointed as a descending staircase", () => {
    const { illustration } = maskToSignature(
      { subject: "Turm", grid: spire() },
      { allowExtendedFormat: true },
    );

    const tops = illustration.bars
      .slice()
      .sort((a, b) => a.x - b.x)
      .map((bar) => bar.segments[0].y);

    const highest = Math.min(...tops);

    // the tip reaches the very top of the drawable area
    expect(highest).toBe(0);

    // An even number of slots puts the tip on the two centre columns, so the
    // flanks are measured from the outer edge of that pair.
    const lastAtTop = tops.lastIndexOf(highest);
    expect(tops[lastAtTop + 1]).toBeGreaterThan(highest);
    expect(tops[lastAtTop + 2]).toBeGreaterThan(tops[lastAtTop + 1]);
  });

  it("shrinks the shape monotonically as the coverage threshold rises", () => {
    // The two sampling modes are the ends of one axis, so raising the threshold
    // must never add strokes or make a stroke longer.
    const filled = [0, 0.2, 0.4, 0.6, 0.8].map((coverage) => {
      const { illustration } = maskToSignature(
        { subject: "Turm", grid: spire() },
        { coverage, allowExtendedFormat: true },
      );
      return illustration.bars.reduce(
        (sum, bar) => sum + bar.segments.reduce((s, segment) => s + segment.height, 0),
        0,
      );
    });

    for (let index = 1; index < filled.length; index += 1) {
      expect(filled[index]).toBeLessThanOrEqual(filled[index - 1]);
    }
  });

  it("does not cut the tip off horizontally", () => {
    const { illustration } = maskToSignature(
      { subject: "Turm", grid: spire() },
      { allowExtendedFormat: true },
    );

    const tops = illustration.bars.map((bar) => bar.segments[0].y);
    const atTop = tops.filter((top) => top === Math.min(...tops));

    // a horizontal cut would leave a wide plateau of equally tall strokes
    expect(atTop.length).toBeLessThanOrEqual(2);
  });
});

describe("edge normalisation", () => {
  /** Flat topped block whose top edge jitters by 1-2 dp, as perspective does. */
  function jittered(): OccupancyGrid {
    const width = 40;
    const height = 60;
    const jitter = [0, 2, 1, 0, 2, 1, 0, 1, 2, 0];
    const rows: string[] = [];

    for (let y = 0; y < height; y += 1) {
      let line = "";
      for (let x = 0; x < width; x += 1) {
        const top = 6 + jitter[Math.floor(x / 4) % jitter.length];
        line += y >= top ? "#" : ".";
      }
      rows.push(line);
    }
    return { widthCells: width, heightCells: height, rows };
  }

  it("leaves the jitter alone when switched off", () => {
    const strokes = constructStrokes(jittered(), { edgeTolerance: 0 });
    const tops = new Set(strokes.columns.map((column) => column.runs[0].y));
    expect(tops.size).toBeGreaterThan(1);
    expect(strokes.report.edgesNormalised).toBe(0);
  });

  it("pulls an almost aligned top edge onto one level", () => {
    const strokes = constructStrokes(jittered(), { edgeTolerance: 4 });
    const tops = new Set(strokes.columns.map((column) => column.runs[0].y));
    expect(tops.size).toBe(1);
    expect(strokes.report.edgesNormalised).toBeGreaterThan(0);
  });

  it("keeps a deliberate staircase intact", () => {
    // steps of 10 dp, far above the tolerance
    const width = 40;
    const height = 80;
    const rows: string[] = [];
    for (let y = 0; y < height; y += 1) {
      let line = "";
      for (let x = 0; x < width; x += 1) {
        const step = Math.floor(x / 8);
        line += y >= 10 + step * 10 ? "#" : ".";
      }
      rows.push(line);
    }

    const plain = constructStrokes({ widthCells: width, heightCells: height, rows });
    const snapped = constructStrokes(
      { widthCells: width, heightCells: height, rows },
      { edgeTolerance: 4 },
    );

    const levels = (strokes: typeof plain) =>
      new Set(strokes.columns.map((column) => column.runs[0].y)).size;

    expect(levels(snapped)).toBe(levels(plain));
  });

  it("still produces a legal graphic after snapping", () => {
    const { illustration } = maskToSignature(
      { subject: "Tor", grid: jittered() },
      { edgeTolerance: 6 },
    );

    expect(validateIllustration(illustration).ok).toBe(true);
    for (const bar of illustration.bars) {
      for (const segment of bar.segments) {
        expect(segment.height).toBeGreaterThanOrEqual(DP.minStrokeLength);
      }
    }
  });
});

describe("maskToSignature", () => {
  it("produces a valid illustration at every cleanup strength", () => {
    for (const cleanup of [0, 0.25, 0.5, 0.75, 1]) {
      const { illustration, plan } = maskToSignature(
        { subject: "Turm", grid: block(24, 48) },
        { cleanup },
      );

      expect(validateIllustration(illustration).ok).toBe(true);
      expect(illustration.bars.length).toBeGreaterThan(0);
      expect(plan.columns).toBeGreaterThan(0);
    }
  });

  it("keeps size and stroke count independent of the cleanup strength", () => {
    // Cleanup decides what survives, never how big the graphic is - that is
    // fixed by the format.
    const plans = [0, 0.5, 1].map(
      (cleanup) =>
        maskToSignature({ subject: "Turm", grid: block(24, 48) }, { cleanup }).plan,
    );

    for (const plan of plans) {
      expect(plan.columns).toBe(plans[0].columns);
      expect(plan.rows).toBe(plans[0].rows);
    }
  });

  it("emits only vertical strokes - no horizontal or diagonal geometry", () => {
    const { illustration } = maskToSignature(
      { subject: "Sockel", grid: block(40, 40) },
      {},
    );
    const { svg } = renderIllustration(illustration, { unitSize: 1 });

    expect(svg).not.toMatch(/<path/);
    expect(svg).not.toMatch(/<line/);
    expect(svg).not.toMatch(/<polygon/);
    // every drawn element is an axis aligned rectangle
    const rects = layoutRects(illustration, 1);
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      expect(rect.width).toBe(DP.strokeWidth);
      expect(rect.height).toBeGreaterThanOrEqual(DP.minStrokeLength);
    }
  });

  it("is deterministic", () => {
    const input = { subject: "Turm", grid: block(24, 48) } as const;
    const first = maskToSignature(input, {});
    const second = maskToSignature(input, {});
    expect(second.illustration).toEqual(first.illustration);
  });
});

describe("horizontal spacing", () => {
  /**
   * Smallest horizontal gap between two strokes that overlap vertically.
   *
   * Strokes that do not overlap vertically never appear side by side, so no gap is
   * expected between them. Measured from the constructed columns, since the
   * sideways offset lives there.
   */
  function narrowestGap(constructed: ConstructedStrokes): number {
    const strokes = constructed.columns.flatMap((column) =>
      column.runs.map((run) => ({
        left: column.x * DP_PITCH + column.offset,
        run,
      })),
    );

    let narrowest = Number.POSITIVE_INFINITY;
    for (const a of strokes) {
      for (const b of strokes) {
        if (a.left >= b.left) continue;
        const overlaps =
          a.run.y < b.run.y + b.run.height && b.run.y < a.run.y + a.run.height;
        if (!overlaps) continue;
        narrowest = Math.min(narrowest, b.left - (a.left + DP.strokeWidth));
      }
    }

    return narrowest;
  }

  /**
   * Three columns carrying nothing but a short run are read as a level band, which
   * is the one rule that shifts strokes sideways. The tall column beside them is
   * what the band would be shifted into: half a pitch to the right ends exactly
   * where that neighbour begins, leaving no gap at all.
   */
  const bandBesideNeighbour = grid([
    "###.#",
    "###.#",
    "....#",
    "....#",
    "....#",
    "....#",
    "....#",
    "....#",
  ]);

  it("staggers a level band when it has room", () => {
    // Without the neighbour the band is free to take the offset, so the guard is
    // not simply switching staggering off altogether.
    const alone = grid(["###", "###", "...", "...", "...", "..."]);
    const constructed = constructStrokes(alone);

    expect(constructed.columns.some((column) => column.offset === DP.rowOffset)).toBe(
      true,
    );
  });

  it("never puts two strokes closer than the horizontal gap", () => {
    const shapes: OccupancyGrid[] = [
      block(12, 30),
      bandBesideNeighbour,
      grid([
        "..####..",
        "..####..",
        ".######.",
        "########",
        "########",
        "#..##..#",
        "#..##..#",
      ]),
      grid(["#.....#", "#.....#", "#######", "#######", "#.....#", "#.....#"]),
    ];

    // Seams split columns and can leave short runs behind, so they are part of
    // what has to hold this invariant.
    for (const shape of shapes) {
      for (const manualSeams of [[], [{ row: 4 }], [{ row: 4 }, { row: 9 }]]) {
        const gap = narrowestGap(constructStrokes(shape, { manualSeams }));
        if (Number.isFinite(gap)) {
          expect(gap).toBeGreaterThanOrEqual(DP.horizontalGap);
        }
      }
    }
  });
});
