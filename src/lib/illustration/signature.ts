/**
 * Signature graphics construction.
 *
 * The sampler in `shapeMask` answers "where is the shape?". This module answers
 * "what is a legal signature graphic?" and is the part that turns a sampled
 * silhouette into the drawing system defined by the guideline:
 *
 * - only vertical strokes, 2 dp wide, 2 dp apart (pitch 4 dp)
 * - shortest stroke 4 dp, anything shorter is a fragment and is removed
 * - two strokes stacked in a column are either 1 dp apart (tight) or at least
 *   4 dp apart (a deliberate negative space) - never something in between
 * - horizontal features (platforms, bases, levels, roof edges) are rendered as
 *   a row of short vertical strokes, never as a horizontal line
 * - a row or element may be staggered horizontally by 2 dp, and neighbouring
 *   elements must never sit flush next to each other
 * - the ideal base area is 96x96 dp with a 3 dp safe area; extreme aspect
 *   ratios extend the canvas instead of squashing the motif
 *
 * One unit is one dp throughout this module.
 */
import {
  DP,
  DP_PITCH,
  FORMATS,
  LIMITS,
  SIGNATURE_SYSTEM,
  drawableArea,
  strokeSlots,
} from "./geometry";
import type { FormatName } from "./geometry";
import { columnSegments, normalizeGrid, trimGrid } from "./occupancy";
import type { OccupancyDocument, OccupancyGrid } from "./occupancy";
import type { Bar, BarIllustration, BarSegment, DetailLevel } from "./types";

/** Cleanup strength that reproduces the previous `medium` behaviour. */
export const DEFAULT_CLEANUP = 0.35;

/** Largest speck removed at full cleanup strength, in cells of the stroke grid. */
const MAX_FRAGMENT_CELLS_AT_FULL = 8;

/**
 * Cleanup thresholds for a strength between 0 and 1.
 *
 * The format is fixed, so this cannot change the size or the stroke count -
 * those follow from the format. It only decides how much of the motif survives
 * the cleanup: which components count as fragments and which holes count as
 * pinholes.
 *
 * Fragments are measured in absolute cells, not relative to the shape, so a real
 * but small detached feature is never mistaken for noise just because the rest
 * of the motif is large. At `0` only single cells count as noise; at full
 * strength a speck may be up to `MAX_FRAGMENT_CELLS_AT_FULL` cells.
 */
export function cleanupTuning(strength: number): CleanMaskOptions {
  const clamped = clamp(strength, 0, 1);
  return {
    maxFragmentCells: 1 + Math.round(clamped * (MAX_FRAGMENT_CELLS_AT_FULL - 1)),
    maxHoleRatio: clamped * 0.03,
  };
}

/** How many adjacent columns a thin run needs to count as a horizontal level. */
const LEVEL_MIN_COLUMNS = 3;

/** Smallest sensible sampled height, in dp. */
const MIN_ROWS = DP.minStrokeLength * 2;

/**
 * Aspect ratio at which an extended format is worth using.
 *
 * The extended formats are 144:96 = 1.5, so a motif has to lean clearly in one
 * direction before switching pays off. Below this it stays square.
 */
const EXTENDED_FORMAT_THRESHOLD = 1.2;

/**
 * Picks the format for a motif.
 *
 * Without permission the ideal square format is always used - a motif is fitted
 * into it, never stretched. With permission, a clearly tall or clearly wide
 * motif gets the matching extended format so it does not end up as a thin band
 * in a mostly empty square.
 */
export function chooseFormat(
  mask: OccupancyGrid,
  allowExtended: boolean,
  /**
   * Set when the grid's full extent already *is* the motif, because the template
   * was cropped to its content beforehand. Then the extent must be taken as it
   * is: re-trimming it would make the format depend on the threshold again.
   */
  extentIsMotif = false,
): FormatName {
  const source = extentIsMotif ? normalizeGrid(mask) : trimGrid(mask);
  return chooseFormatForExtent(source.widthCells, source.heightCells, allowExtended);
}

/**
 * Format for a motif of the given extent, in square units.
 *
 * Takes the extent directly, so it can be driven by the pixel dimensions of a
 * content cropped image - before any rastering or thresholding has happened.
 */
export function chooseFormatForExtent(
  width: number,
  height: number,
  allowExtended: boolean,
): FormatName {
  if (!allowExtended) return "square";
  if (width <= 0 || height <= 0) return "square";

  const aspect = height / width;
  if (aspect >= EXTENDED_FORMAT_THRESHOLD) return "portrait";
  if (aspect <= 1 / EXTENDED_FORMAT_THRESHOLD) return "landscape";
  return "square";
}

export type SignatureCanvasPlan = {
  format: FormatName;
  /** Outer format in dp, safe area included. */
  formatDp: { widthDp: number; heightDp: number };
  /** Stroke slots across the drawable area. Fixed by the format. */
  columns: number;
  /** Drawable height in dp, which equals the number of sampling rows. */
  rows: number;
  /** Drawable width in dp that the slots occupy. */
  widthDp: number;
  /** Slots the motif itself occupies after aspect preserving fitting. */
  columnsUsed: number;
  /** Rows the motif itself occupies. */
  rowsUsed: number;
  /** Left offset of the motif inside the drawable area, in slots. */
  offsetColumns: number;
  /** Top offset of the motif inside the drawable area, in dp. */
  offsetRows: number;
};

/**
 * Plans the drawable grid and how the motif sits inside it.
 *
 * The format is fixed, so the grid is too: a 96 dp format has a 90 dp drawable
 * area, which holds exactly 23 strokes. The motif is fitted into that area with
 * its aspect ratio preserved (contain, never stretch) and centred, so the safe
 * area is respected on all four sides.
 */
export function planSignatureCanvas(
  mask: OccupancyGrid,
  format: FormatName,
  /** See {@link chooseFormat}: the grid's full extent already is the motif. */
  extentIsMotif = false,
): SignatureCanvasPlan {
  const source = extentIsMotif ? normalizeGrid(mask) : trimGrid(mask);
  return planSignatureCanvasForExtent(source.widthCells, source.heightCells, format);
}

/**
 * Nudges `used` so that `total - used` is even, keeping it within `[min, total]`.
 *
 * Only an even leftover can be split into two equal margins, which is what makes
 * a motif sit exactly in the middle of the format. Shrinking by one is preferred
 * over growing, so the motif never outgrows the area it was fitted into.
 */
function evenLeftover(used: number, total: number, min: number): number {
  if ((total - used) % 2 === 0) return used;
  if (used - 1 >= min) return used - 1;
  return Math.min(total, used + 1);
}

/**
 * Plans the canvas for a motif of the given extent, in square units.
 *
 * Takes the extent directly, so the fit can be derived from the pixel dimensions
 * of a content cropped image. That makes the placement independent of the
 * threshold: it is decided before a single cell has been classified.
 */
export function planSignatureCanvasForExtent(
  extentWidth: number,
  extentHeight: number,
  format: FormatName,
): SignatureCanvasPlan {
  const formatDp = FORMATS[format];
  const drawable = drawableArea(formatDp);
  const columns = Math.min(LIMITS.maxBars, strokeSlots(drawable.widthDp));
  const widthDp = columns * DP_PITCH - DP.horizontalGap;
  const rows = Math.min(LIMITS.maxHeightUnits - DP.safeArea * 2, drawable.heightDp);

  const source = { widthCells: extentWidth, heightCells: extentHeight };
  if (source.widthCells === 0 || source.heightCells === 0) {
    return {
      format,
      formatDp,
      columns,
      rows,
      widthDp,
      columnsUsed: 0,
      rowsUsed: 0,
      offsetColumns: 0,
      offsetRows: 0,
    };
  }

  // Contain: whichever axis runs out first decides the scale.
  const maskAspect = source.heightCells / source.widthCells;
  const availableAspect = rows / widthDp;

  let usedWidthDp: number;
  let usedRowsDp: number;
  if (maskAspect > availableAspect) {
    usedRowsDp = rows;
    usedWidthDp = rows / maskAspect;
  } else {
    usedWidthDp = widthDp;
    usedRowsDp = widthDp * maskAspect;
  }

  // Round to whole slots and rows, then make the leftover even. An odd leftover
  // cannot be split in two, so the motif would sit half a slot off centre - at a
  // 4 dp pitch that is a visible shift. Giving up at most one slot of size buys
  // exact centring, which reads far better than the extra 4 dp of width.
  const columnsUsed = evenLeftover(
    clamp(Math.round((usedWidthDp + DP.horizontalGap) / DP_PITCH), 1, columns),
    columns,
    1,
  );
  const rowsUsed = evenLeftover(
    clamp(Math.round(usedRowsDp), Math.min(MIN_ROWS, rows), rows),
    rows,
    Math.min(MIN_ROWS, rows),
  );

  return {
    format,
    formatDp,
    columns,
    rows,
    widthDp,
    columnsUsed,
    rowsUsed,
    // Round the centring offset instead of flooring it. With floor, a single
    // leftover slot or row always fell to the right/bottom, so a motif that did
    // not fill the format exactly clung to the left edge. Rounding splits the
    // leftover evenly and keeps the motif visually centred.
    offsetColumns: Math.round((columns - columnsUsed) / 2),
    offsetRows: Math.round((rows - rowsUsed) / 2),
  };
}

/**
 * Places the fitted motif into the full drawable raster.
 *
 * Everything outside stays empty, which is what keeps the safe area clear and
 * the motif centred in its format.
 */
export function placeInDrawable(
  motif: OccupancyGrid,
  plan: SignatureCanvasPlan,
): OccupancyGrid {
  const rows: string[] = [];
  const empty = ".".repeat(plan.columns);

  for (let y = 0; y < plan.rows; y += 1) {
    const sourceY = y - plan.offsetRows;
    const sourceRow =
      sourceY >= 0 && sourceY < motif.heightCells ? motif.rows[sourceY] : undefined;

    if (!sourceRow) {
      rows.push(empty);
      continue;
    }

    let line = "";
    for (let x = 0; x < plan.columns; x += 1) {
      const sourceX = x - plan.offsetColumns;
      line += sourceRow[sourceX] === "#" ? "#" : ".";
    }
    rows.push(line);
  }

  return { widthCells: plan.columns, heightCells: plan.rows, rows };
}

/* -------------------------------------------------------------------------- */
/* 1. Silhouette cleanup                                                      */
/* -------------------------------------------------------------------------- */

export type CleanMaskOptions = {
  /**
   * Largest component, in cells, still treated as noise.
   *
   * A speck is small in absolute terms - a handful of cells - no matter how big
   * the shape is. Measuring against the shape size was the mistake: a real but
   * detached feature (a bicycle's handlebar) is small next to the frame, so it
   * got deleted although it is not noise. An absolute cap removes specks while
   * leaving anything of substance alone.
   */
  maxFragmentCells?: number;
  /** Holes smaller than this share of the shape area get filled. */
  maxHoleRatio?: number;
};

/**
 * Removes small fragments and fills pinholes.
 *
 * Both are required by the guideline: small fragments are noise that survives
 * thresholding, while pinholes would later turn into illegal sub-4 dp gaps.
 * Large characteristic negative spaces are far above these thresholds and are
 * therefore preserved.
 */
export function cleanMask(grid: OccupancyGrid, options: CleanMaskOptions = {}): OccupancyGrid {
  const tuning = cleanupTuning(DEFAULT_CLEANUP);
  const maxFragmentCells = options.maxFragmentCells ?? tuning.maxFragmentCells!;
  const maxHoleRatio = options.maxHoleRatio ?? tuning.maxHoleRatio!;

  const normalized = normalizeGrid(grid);
  if (normalized.widthCells === 0 || normalized.heightCells === 0) return normalized;

  const cells = normalized.rows.map((row) => [...row]);
  const filled = components(cells, "#");
  if (filled.length === 0) return normalized;

  // A fragment is small in absolute terms - never removed just for being small
  // next to a larger part of the same motif. The largest component is always a
  // real part, so it is kept even if the cap somehow exceeds it.
  const largest = Math.max(...filled.map((component) => component.length));
  const isFragment = (size: number) => size <= maxFragmentCells && size < largest;
  for (const component of filled) {
    if (isFragment(component.length)) {
      for (const [y, x] of component) cells[y][x] = ".";
    }
  }

  const shapeArea = filled.reduce(
    (sum, component) => (isFragment(component.length) ? sum : sum + component.length),
    0,
  );
  const holeLimit = Math.max(1, shapeArea * maxHoleRatio);
  for (const component of components(cells, ".")) {
    const touchesBorder = component.some(
      ([y, x]) =>
        y === 0 || x === 0 || y === cells.length - 1 || x === cells[0].length - 1,
    );
    if (!touchesBorder && component.length <= holeLimit) {
      for (const [y, x] of component) cells[y][x] = "#";
    }
  }

  return {
    widthCells: normalized.widthCells,
    heightCells: normalized.heightCells,
    rows: cells.map((row) => row.join("")),
  };
}

/** 4-connected components of a given character. */
function components(cells: string[][], match: string): Array<Array<[number, number]>> {
  const height = cells.length;
  const width = cells[0]?.length ?? 0;
  const seen = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  const found: Array<Array<[number, number]>> = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (seen[y][x] || cells[y][x] !== match) continue;

      const component: Array<[number, number]> = [];
      const stack: Array<[number, number]> = [[y, x]];
      seen[y][x] = true;

      while (stack.length > 0) {
        const [cy, cx] = stack.pop()!;
        component.push([cy, cx]);

        for (const [dy, dx] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const ny = cy + dy;
          const nx = cx + dx;
          if (ny < 0 || nx < 0 || ny >= height || nx >= width) continue;
          if (seen[ny][nx] || cells[ny][nx] !== match) continue;
          seen[ny][nx] = true;
          stack.push([ny, nx]);
        }
      }

      found.push(component);
    }
  }

  return found;
}

/* -------------------------------------------------------------------------- */
/* 2-6. Stroke construction                                                   */
/* -------------------------------------------------------------------------- */

type Run = BarSegment & {
  /** Marks a run that came out of a detected horizontal feature. */
  level?: boolean;
};

type Column = {
  x: number;
  offset: number;
  runs: Run[];
};

export type ConstructionReport = {
  /** Number of runs dropped as fragments. */
  fragmentsRemoved: number;
  /** Number of horizontal features turned into rows of short strokes. */
  levelsBanded: number;
  /** Number of gaps snapped to a legal size. */
  gapsSnapped: number;
  /** Number of columns staggered horizontally by 2 dp. */
  columnsStaggered: number;
  /** Number of stroke edges pulled onto a shared level. */
  edgesNormalised: number;
};

export type ConstructStrokesOptions = {
  /**
   * How far apart two edges may be and still be treated as the same level, in dp.
   *
   * `0` disables normalisation. Perspective in a clipart makes edges that belong
   * to one level land a few dp apart; a tolerance just above that jitter pulls
   * them together. Deliberate steps are far larger than the jitter, so they
   * survive as long as the tolerance stays below the step size.
   */
  edgeTolerance?: number;
  /**
   * Gaps smaller than this, in dp, are swallowed: the runs around them fuse into
   * one stroke. `0` fuses nothing.
   *
   * This is the dial between silhouette and texture. At
   * `intentionalVerticalGap` every gap that is not a deliberate opening closes,
   * which gives the signature look: one stroke per column, its length set by the
   * silhouette, broken only by the few large openings that read as features
   * (arches, passages). Lower values let more of the inner structure survive - the
   * lattice of a tower, the masonry of an arena - at the price of strokes that
   * come out increasingly chopped up. Defaults to `intentionalVerticalGap`.
   */
  fuseGapsBelow?: number;
  /**
   * Seams cut by hand, each one a row of the drawable grid.
   *
   * A horizontal feature only reads as its own band when there is a hair of space
   * beneath it. Detecting those places automatically needs a clear step in the
   * silhouette, which a soft shape - a dome, a rounded roof - simply does not
   * have, so the seams are placed deliberately instead. They are cut after
   * fusing, so they always survive.
   */
  manualSeams?: Seam[];
};

/**
 * One hand placed cut through the graphic.
 *
 * A seam can be limited to a range of stroke slots, because a level is often a
 * feature of one part of the motif only: the storeys of a central building are
 * not storeys of the minarets beside it, and cutting across those would invent
 * an edge that the object does not have. Leaving the range open cuts everything,
 * which is the right default for a plinth or a ground line.
 */
export type Seam = {
  /** Row of the drawable grid. */
  row: number;
  /** First stroke slot to cut. Omitted means from the left edge. */
  from?: number;
  /** Last stroke slot to cut, inclusive. Omitted means to the right edge. */
  to?: number;
};

export type ConstructedStrokes = {
  columns: Column[];
  rows: number;
  report: ConstructionReport;
};

/**
 * Applies the construction rules to a sampled raster.
 *
 * The raster is expected to be at 1 dp vertical resolution and one column per
 * stroke slot, which is what `planSignatureCanvas` sizes it for.
 */
export function constructStrokes(
  raster: OccupancyGrid,
  options: ConstructStrokesOptions = {},
): ConstructedStrokes {
  const grid = normalizeGrid(raster);
  const rows = grid.heightCells;
  const report: ConstructionReport = {
    fragmentsRemoved: 0,
    levelsBanded: 0,
    gapsSnapped: 0,
    columnsStaggered: 0,
    edgesNormalised: 0,
  };

  const columns: Column[] = [];
  for (let x = 0; x < grid.widthCells; x += 1) {
    columns.push({ x, offset: 0, runs: columnSegments(grid, x).map((run) => ({ ...run })) });
  }

  // Swallow the small gaps first, so the later rules work on the clean strokes
  // rather than on the raw texture of the motif.
  const fuseGapsBelow = options.fuseGapsBelow ?? DP.intentionalVerticalGap;
  if (fuseGapsBelow > 0) {
    solidifyColumns(columns, fuseGapsBelow);
  }

  const seams = options.manualSeams ?? [];

  // Cut the hand placed seams once up front, so the rules that follow can tidy
  // up around them - a stub left below a seam that is now too short is removed
  // by `removeFragments`, exactly as the guideline wants.
  applySeams(columns, seams, report);

  markLevels(columns, report);

  // Normalisation runs first so the rules that follow can repair anything it
  // breaks: a snapped run may fall below the minimum length or produce an
  // illegal gap, and those are exactly what the later steps enforce.
  normaliseEdges(columns, options.edgeTolerance ?? 0, rows, report);
  removeFragments(columns, rows, report);
  snapGaps(columns, rows, report);
  staggerLevelBands(columns, report);

  // Cut them a second time, so the seam itself always survives: whatever the
  // rules did in between - edge normalisation bridging it, gap snapping
  // tightening it away - the deliberate cut is reopened.
  applySeams(columns, seams, report);

  // That second cut can leave a run below the minimum length, and two seams close
  // together always do: the piece between them is shorter than a legal stroke.
  // Sweeping fragments once more is therefore the last step. Only fragments -
  // snapping gaps again would be free to close the seam that was just reopened.
  removeFragments(columns, rows, report);

  return { columns: columns.filter((column) => column.runs.length > 0), rows, report };
}

/**
 * Cuts each seam, splitting the runs it passes through.
 *
 * Only the columns inside the seam's slot range are touched, so a seam limited to
 * one part of the motif leaves the rest intact.
 */
function applySeams(columns: Column[], seams: Seam[], report: ConstructionReport): void {
  for (const seam of seams) {
    const from = seam.from ?? Number.NEGATIVE_INFINITY;
    const to = seam.to ?? Number.POSITIVE_INFINITY;

    let cut = false;
    for (const column of columns) {
      if (column.x < from || column.x > to) continue;
      if (splitRunsAtRow(column, seam.row)) cut = true;
    }
    if (cut) report.gapsSnapped += 1;
  }
}

/**
 * Pulls edges that are almost on the same level onto a shared level.
 *
 * Perspective in a clipart is the usual cause: the base of a gate photographed
 * slightly from below ends a few dp lower on one side, and the converter
 * faithfully reproduces that as ragged stroke ends. Grouping edges within a
 * tolerance and snapping each group to its dominant value removes the jitter
 * without touching real steps.
 *
 * Clusters are bounded by the tolerance in total, not chained. Without that, a
 * gentle staircase of 3 dp steps would collapse into one level at a 3 dp
 * tolerance, because every step is within tolerance of its neighbour.
 */
function normaliseEdges(
  columns: Column[],
  tolerance: number,
  rows: number,
  report: ConstructionReport,
): void {
  if (tolerance <= 0) return;

  const counts = new Map<number, number>();
  for (const column of columns) {
    for (const run of column.runs) {
      counts.set(run.y, (counts.get(run.y) ?? 0) + 1);
      const end = run.y + run.height;
      counts.set(end, (counts.get(end) ?? 0) + 1);
    }
  }

  const values = [...counts.keys()].sort((a, b) => a - b);
  if (values.length === 0) return;

  const snap = new Map<number, number>();
  let cluster: number[] = [];

  const flush = () => {
    if (cluster.length === 0) return;
    // the level most edges already sit on wins, ties go to the lower edge
    let best = cluster[0];
    let bestCount = -1;
    for (const value of cluster) {
      const count = counts.get(value) ?? 0;
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    for (const value of cluster) snap.set(value, best);
    cluster = [];
  };

  for (const value of values) {
    if (cluster.length > 0 && value - cluster[0] > tolerance) flush();
    cluster.push(value);
  }
  flush();

  for (const column of columns) {
    const next: Run[] = [];
    for (const run of column.runs) {
      const start = snap.get(run.y) ?? run.y;
      const end = snap.get(run.y + run.height) ?? run.y + run.height;
      if (start !== run.y) report.edgesNormalised += 1;
      if (end !== run.y + run.height) report.edgesNormalised += 1;

      const y = clamp(Math.min(start, rows - 1), 0, rows - 1);
      const height = Math.min(rows - y, Math.max(1, end - y));
      next.push({ ...run, y, height });
    }
    column.runs = next;
  }
}

/**
 * Step 2 and 3: detect horizontal features and turn them into short strokes.
 *
 * A platform, base or roof edge appears in the raster as a run that is shorter
 * than the minimum stroke length but repeats across many neighbouring columns.
 * Such a run is not a fragment - it carries the horizontal feature - so it is
 * grown to the minimum stroke length instead of being deleted. The result is a
 * row of short vertical strokes, which is exactly how the guideline wants a
 * horizontal feature drawn.
 */
/**
 * Fuses the runs of each column into as few strokes as possible.
 *
 * Two runs are joined unless the gap between them is a deliberate opening
 * (`fuseGapsBelow` or more). So the fine internal texture of a motif - the gaps
 * of a lattice, the courses of masonry - collapses into one solid stroke set by
 * the silhouette, while the openings above the threshold survive. This is what
 * makes the result look like the hand-built signature graphics rather than a
 * sampled bitmap.
 */
function solidifyColumns(columns: Column[], fuseGapsBelow: number): void {
  for (const column of columns) {
    const runs = [...column.runs].sort((a, b) => a.y - b.y);
    const merged: Run[] = [];

    for (const run of runs) {
      const previous = merged[merged.length - 1];
      const gap = previous ? run.y - (previous.y + previous.height) : Infinity;

      if (previous && gap < fuseGapsBelow) {
        // Join: extend the current stroke down to the end of this run.
        const end = Math.max(previous.y + previous.height, run.y + run.height);
        previous.height = end - previous.y;
        continue;
      }

      merged.push({ ...run });
    }

    column.runs = merged;
  }
}

function markLevels(columns: Column[], report: ConstructionReport): void {
  for (const column of columns) {
    for (const run of column.runs) {
      if (run.height >= DP.minStrokeLength) continue;
      if (spanOfLevel(columns, column.x, run) >= LEVEL_MIN_COLUMNS) {
        run.level = true;
        report.levelsBanded += 1;
      }
    }
  }
}

/**
 * Removes one row from whichever run of the column contains it, splitting that
 * run into an upper and a lower stroke. Returns whether anything was cut.
 */
function splitRunsAtRow(column: Column, row: number): boolean {
  let cut = false;
  const next: Run[] = [];

  for (const run of column.runs) {
    const end = run.y + run.height;
    if (row < run.y || row >= end) {
      next.push(run);
      continue;
    }
    const upper = { ...run, height: row - run.y };
    const lower = { ...run, y: row + 1, height: end - (row + 1) };
    if (upper.height > 0) next.push(upper);
    if (lower.height > 0) next.push(lower);
    cut = true;
  }

  column.runs = next;
  return cut;
}

/** Number of adjacent columns carrying a run at roughly the same height. */
function spanOfLevel(columns: Column[], x: number, run: Run): number {
  let span = 1;
  for (const direction of [-1, 1]) {
    let cursor = x + direction;
    while (true) {
      const column = columns.find((candidate) => candidate.x === cursor);
      if (!column) break;
      const aligned = column.runs.some(
        (other) =>
          Math.abs(other.y - run.y) <= DP.rowOffset &&
          other.height <= DP.minStrokeLength + DP.rowOffset,
      );
      if (!aligned) break;
      span += 1;
      cursor += direction;
    }
  }
  return span;
}

/**
 * Step 6a: minimum stroke length.
 *
 * A run below the minimum is either a detected level, in which case it grows to
 * the minimum, or a fragment, in which case it is removed. A column that would
 * lose all of its content keeps its longest run and grows that instead, so the
 * silhouette never develops holes just because it is thin somewhere.
 */
function removeFragments(columns: Column[], rows: number, report: ConstructionReport): void {
  for (const column of columns) {
    const keep: Run[] = [];

    for (const run of column.runs) {
      if (run.height >= DP.minStrokeLength || run.level) {
        keep.push(grow(run, rows));
        continue;
      }
      report.fragmentsRemoved += 1;
    }

    if (keep.length === 0 && column.runs.length > 0) {
      const longest = column.runs.reduce((best, run) =>
        run.height > best.height ? run : best,
      );
      keep.push(grow({ ...longest }, rows));
      report.fragmentsRemoved -= 1;
    }

    column.runs = keep;
  }
}

/** Grows a run to the minimum stroke length, staying inside the canvas. */
function grow(run: Run, rows: number): Run {
  if (run.height >= DP.minStrokeLength) return run;
  const height = DP.minStrokeLength;
  const y = Math.max(0, Math.min(run.y, rows - height));
  return { ...run, y, height };
}

/**
 * Step 6b: only two vertical gaps are legal.
 *
 * Anything below the intentional gap is tightened to the 1 dp default, which
 * removes the ambiguous 2-3 dp gaps that would read as an accident. Gaps at or
 * above the intentional size are left alone, which is what preserves the large
 * characteristic negative spaces.
 */
function snapGaps(columns: Column[], rows: number, report: ConstructionReport): void {
  for (const column of columns) {
    const runs = [...column.runs].sort((a, b) => a.y - b.y);
    const merged: Run[] = [];

    for (const run of runs) {
      const previous = merged[merged.length - 1];
      if (!previous) {
        merged.push({ ...run });
        continue;
      }

      const gap = run.y - (previous.y + previous.height);

      if (gap <= 0) {
        // Overlap or contact: fuse into one stroke.
        const end = Math.max(previous.y + previous.height, run.y + run.height);
        previous.height = end - previous.y;
        previous.level = previous.level || run.level;
        continue;
      }

      if (gap >= DP.intentionalVerticalGap) {
        merged.push({ ...run });
        continue;
      }

      if (gap === DP.tightVerticalGap) {
        merged.push({ ...run });
        continue;
      }

      // 2-3 dp: tighten to the 1 dp default by extending the upper stroke.
      previous.height += gap - DP.tightVerticalGap;
      merged.push({ ...run });
      report.gapsSnapped += 1;
    }

    column.runs = merged.filter((run) => run.height > 0 && run.y + run.height <= rows);
  }
}

/*
 * On "Elemente dürfen niemals horizontal bündig nebeneinander liegen"
 *
 * This rule is about two *elements* sitting side by side, not about the outer
 * contour of a single shape. It is answered by `staggerLevelBands`, which moves
 * a band half a pitch sideways so its strokes no longer share the column
 * positions of the element above or below it.
 *
 * An earlier version also broke up any contour edge shared by several columns,
 * by pulling alternate columns in by 2 dp. That was wrong: a straight bottom
 * edge - the base of a popsicle, a plinth, a baseline - is a characteristic part
 * of the object's form, and a row of vertical strokes ending on the same line is
 * still nothing but vertical strokes. The guideline forbids horizontal *lines*
 * as geometry, not aligned stroke ends. Staggering the contour turned every
 * straight edge into visual noise, so it is deliberately not done.
 */

/**
 * Step 4: a level band may be staggered horizontally by 2 dp.
 *
 * Shifting the whole band by half a pitch keeps its internal rhythm intact -
 * every stroke inside the band still sits 4 dp from the next - while making
 * sure the band never lines up flush with the strokes above and below it.
 */
function staggerLevelBands(columns: Column[], report: ConstructionReport): void {
  const banded = columns.filter((column) => column.runs.some((run) => run.level));
  if (banded.length < LEVEL_MIN_COLUMNS) return;

  // A band that is the only content of its columns can carry the offset itself.
  const pureBand = banded.every((column) => column.runs.every((run) => run.level));
  if (!pureBand) return;

  for (const column of banded) {
    column.offset = DP.rowOffset;
    report.columnsStaggered += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

export type SignatureIllustration = {
  illustration: BarIllustration;
  plan: SignatureCanvasPlan;
  report: ConstructionReport;
};

/**
 * Builds the final illustration from constructed strokes.
 *
 * The safe area of the guideline becomes the canvas padding, and the system is
 * the dp accurate 2 dp stroke / 2 dp gap pair.
 */
export function strokesToIllustration(
  document: Pick<OccupancyDocument, "subject" | "label" | "symmetry">,
  strokes: ConstructedStrokes,
  plan: SignatureCanvasPlan,
): BarIllustration {
  // The canvas is the drawable area; the safe area is added around it by the
  // renderer, so together they add up to the format of the guideline.
  const bars: Bar[] = strokes.columns.map((column) => ({
    x: column.x,
    ...(column.offset > 0 ? { xOffsetUnits: column.offset } : {}),
    segments: column.runs
      .map(({ y, height }) => ({ y, height }))
      .sort((a, b) => a.y - b.y),
  }));

  return {
    meta: {
      subject: document.subject,
      ...(document.label ? { label: document.label } : {}),
      ...(document.symmetry ? { symmetry: document.symmetry } : {}),
    },
    canvas: {
      widthUnits: plan.widthDp,
      heightUnits: strokes.rows,
      paddingUnits: DP.safeArea,
    },
    system: SIGNATURE_SYSTEM,
    bars,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
