/**
 * OccupancyGrid - the intermediate format between the AI layer and the renderer.
 *
 * The AI no longer computes y/height coordinates. It draws a filled 2D
 * silhouette as a small ASCII raster ("#" occupied, "." empty). This code turns
 * that raster into bars deterministically via run length merging, so the
 * geometry never depends on the model doing arithmetic.
 */
import { DEFAULT_SYSTEM, slotCount, widthUnitsForSlots } from "./geometry";
import type { Bar, BarIllustration, BarSegment, IllustrationSystem } from "./types";

export type OccupancyGrid = {
  /** Number of columns. One column becomes one bar slot. */
  widthCells: number;
  /** Number of rows. One row becomes one unit of height. */
  heightCells: number;
  /** One string per row, "#" for occupied and "." for empty. */
  rows: string[];
};

export type OccupancyDocument = {
  subject: string;
  label?: string;
  symmetry?: "none" | "vertical";
  grid: OccupancyGrid;
};

/** Characters accepted as occupied. "#" is the documented default. */
export const OCCUPIED_CHARS = new Set(["#", "X", "x", "█", "*", "1", "@"]);
/** Characters accepted as empty. "." is the documented default. */
export const EMPTY_CHARS = new Set([".", " ", "0", "-", "_"]);

export function isOccupied(char: string): boolean {
  return OCCUPIED_CHARS.has(char);
}

/**
 * Brings a grid into canonical form: every cell either "#" or ".", all rows the
 * same length.
 *
 * The **rows are authoritative**, the declared `widthCells` and `heightCells`
 * are treated as hints. Models reliably draw a correct silhouette but miscount
 * the declaration by a character or two; rejecting that would throw away a
 * perfectly good drawing. Rows are therefore padded to the longest row and the
 * dimensions are re-derived. Empty borders are removed later by `trimGrid`.
 */
export function normalizeGrid(grid: OccupancyGrid): OccupancyGrid {
  const width = Math.max(grid.widthCells, 0, ...grid.rows.map((row) => row.length));

  const rows = grid.rows.map((row) => {
    const cells: string[] = [];
    for (let x = 0; x < width; x += 1) {
      cells.push(isOccupied(row[x] ?? ".") ? "#" : ".");
    }
    return cells.join("");
  });

  return { widthCells: width, heightCells: rows.length, rows };
}

/** Inclusive bounding box of the occupied cells, or null when the grid is empty. */
export type TrimBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Dimensions of the full (normalised) grid, so bounds can be turned into fractions. */
  gridWidth: number;
  gridHeight: number;
};

/** Bounding box of the occupied cells on the normalised grid. */
export function trimBounds(grid: OccupancyGrid): TrimBounds | null {
  const normalized = normalizeGrid(grid);
  const occupiedRows = normalized.rows
    .map((row, y) => (row.includes("#") ? y : -1))
    .filter((y) => y >= 0);

  if (occupiedRows.length === 0) return null;

  const top = occupiedRows[0];
  const bottom = occupiedRows[occupiedRows.length - 1];

  let left = normalized.widthCells;
  let right = -1;
  for (let y = top; y <= bottom; y += 1) {
    const row = normalized.rows[y];
    for (let x = 0; x < normalized.widthCells; x += 1) {
      if (row[x] === "#") {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  return {
    left,
    right,
    top,
    bottom,
    gridWidth: normalized.widthCells,
    gridHeight: normalized.rows.length,
  };
}

/**
 * Removes fully empty border rows and columns so the motif sits tight in its
 * canvas. Padding is added later by the renderer.
 */
export function trimGrid(grid: OccupancyGrid): OccupancyGrid {
  const normalized = normalizeGrid(grid);
  const bounds = trimBounds(normalized);

  if (!bounds) {
    return { widthCells: 0, heightCells: 0, rows: [] };
  }

  const { left, right, top, bottom } = bounds;
  const rows = normalized.rows.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
  return { widthCells: right - left + 1, heightCells: rows.length, rows };
}

/** Vertical runs of one column, already ordered and non overlapping. */
export function columnSegments(grid: OccupancyGrid, x: number): BarSegment[] {
  const segments: BarSegment[] = [];
  let runStart: number | null = null;

  for (let y = 0; y <= grid.heightCells; y += 1) {
    const filled = y < grid.heightCells && grid.rows[y]?.[x] === "#";
    if (filled && runStart === null) runStart = y;
    if (!filled && runStart !== null) {
      segments.push({ y: runStart, height: y - runStart });
      runStart = null;
    }
  }

  return segments;
}

/**
 * Deterministic mapping OccupancyGrid -> BarIllustration.
 *
 * One column becomes one bar, one vertical run becomes one segment. Bar width
 * and gap are untouched by definition: the renderer places bar `x` at
 * `padding + x * pitch`, so barWidth stays 1u and gap stays 1u.
 */
export function occupancyToIllustration(
  document: OccupancyDocument,
  paddingUnits = 2,
  system: IllustrationSystem = DEFAULT_SYSTEM,
): BarIllustration {
  const grid = trimGrid(document.grid);
  const bars: Bar[] = [];

  for (let x = 0; x < grid.widthCells; x += 1) {
    const segments = columnSegments(grid, x);
    if (segments.length > 0) bars.push({ x, segments });
  }

  return {
    meta: {
      subject: document.subject,
      ...(document.label ? { label: document.label } : {}),
      ...(document.symmetry ? { symmetry: document.symmetry } : {}),
    },
    canvas: {
      widthUnits: widthUnitsForSlots(grid.widthCells, system),
      heightUnits: grid.heightCells,
      paddingUnits,
    },
    system,
    bars,
  };
}

/** Renders a grid back to ASCII, used for the debug view and for tests. */
export function gridToAscii(grid: OccupancyGrid): string {
  return normalizeGrid(grid).rows.join("\n");
}

/** Rebuilds the grid from an illustration, so the debug view always has one. */
export function illustrationToGrid(illustration: BarIllustration): OccupancyGrid {
  const widthCells = slotCount(illustration.canvas.widthUnits, illustration.system);
  const heightCells = illustration.canvas.heightUnits;
  const cells = Array.from({ length: heightCells }, () => Array(widthCells).fill("."));

  for (const bar of illustration.bars) {
    for (const segment of bar.segments) {
      for (let y = segment.y; y < segment.y + segment.height; y += 1) {
        if (y < heightCells && bar.x < widthCells) cells[y][bar.x] = "#";
      }
    }
  }

  return { widthCells, heightCells, rows: cells.map((row) => row.join("")) };
}

/* -------------------------------------------------------------------------- */
/* Shape metrics - used by tests to assert silhouette character               */
/* -------------------------------------------------------------------------- */

export type ShapeMetrics = {
  /** Occupied cells per row, top to bottom. */
  rowWidths: number[];
  maxWidth: number;
  /** Relative height of the widest row: 0 = top, 1 = bottom. */
  widestAt: number;
  /** Width of the topmost and bottommost occupied row. */
  topWidth: number;
  bottomWidth: number;
  /** True when every bar ends on the same row - the bar chart failure mode. */
  sharesBaseline: boolean;
};

export function shapeMetrics(grid: OccupancyGrid): ShapeMetrics {
  const trimmed = trimGrid(grid);
  const rowWidths = trimmed.rows.map((row) => [...row].filter((c) => c === "#").length);
  const maxWidth = Math.max(0, ...rowWidths);
  const widestIndex = rowWidths.indexOf(maxWidth);

  const bottoms = new Set<number>();
  for (let x = 0; x < trimmed.widthCells; x += 1) {
    const segments = columnSegments(trimmed, x);
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      bottoms.add(last.y + last.height);
    }
  }

  return {
    rowWidths,
    maxWidth,
    widestAt: trimmed.heightCells <= 1 ? 0 : widestIndex / (trimmed.heightCells - 1),
    topWidth: rowWidths[0] ?? 0,
    bottomWidth: rowWidths[rowWidths.length - 1] ?? 0,
    sharesBaseline: bottoms.size === 1,
  };
}
