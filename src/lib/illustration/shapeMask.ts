/**
 * Shape mask -> vertical sampling -> normalised bars.
 *
 * The AI layer draws an iconic silhouette as a binary mask with *square* cells,
 * at a resolution that has nothing to do with the final bar count. This module
 * performs the deterministic part of the guideline's construction principle:
 * the silhouette is sampled column by column, the intersection with the filled
 * area becomes one or more vertical segments, and only then do bars exist.
 *
 * Decoupling mask resolution from bar resolution is what makes the result look
 * designed instead of hand counted: the model reasons about area, the sampler
 * owns all geometry.
 */
import { LIMITS, PITCH_UNITS } from "./geometry";
import { DEFAULT_THRESHOLD, imageToGridWithDetail } from "./imageMask";
import type { RasterImage } from "./imageMask";
import { normalizeGrid, occupancyToIllustration, trimGrid } from "./occupancy";
import type { OccupancyDocument, OccupancyGrid } from "./occupancy";
import {
  DEFAULT_CLEANUP,
  chooseFormat,
  chooseFormatForExtent,
  cleanMask,
  cleanupTuning,
  constructStrokes,
  placeInDrawable,
  planSignatureCanvas,
  planSignatureCanvasForExtent,
  strokesToIllustration,
} from "./signature";
import type { ConstructionReport, Seam, SignatureCanvasPlan } from "./signature";
import type { BarIllustration, DetailLevel } from "./types";

/** Horizontal sampling density per detail level, in bar columns. */
export const DETAIL_COLUMNS: Record<DetailLevel, number> = {
  low: 19,
  medium: 29,
  high: 43,
};

/**
 * Share of a sampling cell that must be covered by the silhouette for the cell
 * to count as occupied. Slightly below one half so thin but characteristic
 * features - a stem, a mast, a leg - survive the downsampling.
 */
export const COVERAGE_THRESHOLD = 0.4;

/**
 * How a mask cell is reduced to a stroke cell.
 *
 * - `coverage` a cell is filled when enough of its **area** is filled. Faithful
 *   to the mass of the shape, but it eats tips: a tapering spire is a thin
 *   sliver inside a 4 dp wide cell, never reaches the threshold and gets cut
 *   off horizontally.
 * - `extent` a cell is filled when the shape reaches into it at all. This is
 *   what a stroke actually means in this system - how far the object extends at
 *   this x - so tips, masts and antennas survive and a point becomes a proper
 *   staircase. Noise is not a concern here because `cleanMask` runs first.
 */
export type SamplingMode = "coverage" | "extent";

/** Smallest sensible sampled height. */
const MIN_ROWS = 6;

/**
 * Rows needed so the sampled graphic keeps the aspect ratio of the mask.
 *
 * A bar column occupies `pitch` units horizontally while a row is one unit
 * high, so the row count has to compensate for the pitch.
 */
export function targetRowsFor(mask: OccupancyGrid, targetColumns: number): number {
  if (mask.widthCells === 0 || mask.heightCells === 0) return 0;
  const aspect = mask.heightCells / mask.widthCells;
  const rows = Math.round(aspect * targetColumns * PITCH_UNITS);
  return Math.max(MIN_ROWS, Math.min(LIMITS.maxHeightUnits, rows));
}

/** Overlap of [aStart, aEnd) with [bStart, bEnd). */
function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Deterministic area based resampling of the mask onto the sampling raster.
 *
 * Every target cell covers a rectangle of the mask. The occupied area inside
 * that rectangle is measured exactly and compared against the threshold, so the
 * result is stable and independent of the mask resolution.
 */
export function resampleMask(
  mask: OccupancyGrid,
  targetColumns: number,
  coverageThreshold = COVERAGE_THRESHOLD,
): OccupancyGrid {
  const source = trimGrid(mask);
  if (source.widthCells === 0) return { widthCells: 0, heightCells: 0, rows: [] };

  const columns = Math.max(1, Math.min(LIMITS.maxBars, Math.round(targetColumns)));
  return resampleMaskTo(source, columns, targetRowsFor(source, columns), coverageThreshold);
}

/**
 * Area based resampling onto an explicit raster size.
 *
 * The signature pipeline needs both dimensions fixed up front, because the
 * canvas plan derives them from the guideline's base area and the aspect ratio
 * of the motif.
 */
export function resampleMaskTo(
  mask: OccupancyGrid,
  targetColumns: number,
  targetRows: number,
  coverageThreshold = COVERAGE_THRESHOLD,
  mode: SamplingMode = "coverage",
  /**
   * Set when the grid's full extent already is the motif. Trimming would then
   * re-crop after thresholding and shift the motif inside its box.
   */
  extentIsMotif = false,
): OccupancyGrid {
  const source = extentIsMotif ? normalizeGrid(mask) : trimGrid(mask);
  if (source.widthCells === 0 || targetColumns <= 0 || targetRows <= 0) {
    return { widthCells: 0, heightCells: 0, rows: [] };
  }

  if (mode === "extent") {
    return resampleByExtent(source, targetColumns, targetRows);
  }

  const columns = targetColumns;
  const rows = targetRows;
  const scaleX = source.widthCells / columns;
  const scaleY = source.heightCells / rows;

  const out: string[] = [];
  for (let ty = 0; ty < rows; ty += 1) {
    const y0 = ty * scaleY;
    const y1 = (ty + 1) * scaleY;
    let line = "";

    for (let tx = 0; tx < columns; tx += 1) {
      const x0 = tx * scaleX;
      const x1 = (tx + 1) * scaleX;

      let occupied = 0;
      for (let sy = Math.floor(y0); sy < Math.min(source.heightCells, Math.ceil(y1)); sy += 1) {
        const rowText = source.rows[sy];
        const weightY = overlap(y0, y1, sy, sy + 1);
        if (weightY <= 0) continue;

        for (let sx = Math.floor(x0); sx < Math.min(source.widthCells, Math.ceil(x1)); sx += 1) {
          if (rowText[sx] !== "#") continue;
          occupied += overlap(x0, x1, sx, sx + 1) * weightY;
        }
      }

      const area = (x1 - x0) * (y1 - y0);
      line += area > 0 && occupied / area >= coverageThreshold ? "#" : ".";
    }

    out.push(line);
  }

  return { widthCells: columns, heightCells: rows, rows: out };
}

/** Union sampling: the cell is filled as soon as the shape reaches into it. */
function resampleByExtent(
  source: OccupancyGrid,
  columns: number,
  rows: number,
): OccupancyGrid {
  const scaleX = source.widthCells / columns;
  const scaleY = source.heightCells / rows;
  const out: string[] = [];

  for (let ty = 0; ty < rows; ty += 1) {
    const y0 = Math.floor(ty * scaleY);
    const y1 = Math.max(y0 + 1, Math.ceil((ty + 1) * scaleY));
    let line = "";

    for (let tx = 0; tx < columns; tx += 1) {
      const x0 = Math.floor(tx * scaleX);
      const x1 = Math.max(x0 + 1, Math.ceil((tx + 1) * scaleX));

      let filled = false;
      for (let sy = y0; sy < Math.min(source.heightCells, y1) && !filled; sy += 1) {
        const row = source.rows[sy];
        for (let sx = x0; sx < Math.min(source.widthCells, x1); sx += 1) {
          if (row[sx] === "#") {
            filled = true;
            break;
          }
        }
      }

      line += filled ? "#" : ".";
    }

    out.push(line);
  }

  return { widthCells: columns, heightCells: rows, rows: out };
}

/**
 * How vertical symmetry is enforced.
 *
 * - `none`   leave the raster untouched
 * - `left`   the left half is authoritative and is mirrored onto the right
 * - `right`  the right half is authoritative
 * - `union`  a cell is occupied when it or its mirror partner is occupied
 *
 * `left` and `right` preserve the silhouette exactly and never widen it, which
 * is what an image template needs. `union` is the forgiving variant for a motif
 * that is meant to be symmetric but was drawn slightly unevenly.
 */
export type MirrorMode = "none" | "left" | "right" | "union";

/**
 * Makes a raster exactly mirror symmetric.
 *
 * Neither a hand drawn mask nor a bitmap template is ever pixel exact, and
 * resampling does not stay symmetric either because the sampling columns rarely
 * align with the centre. This turns the intention into a guarantee.
 */
export function mirrorGrid(grid: OccupancyGrid, mode: MirrorMode): OccupancyGrid {
  if (mode === "none" || grid.widthCells === 0) return grid;

  const width = grid.widthCells;
  const rows = grid.rows.map((row) => {
    const cells: string[] = [];

    for (let x = 0; x < width; x += 1) {
      const mirrored = width - 1 - x;

      if (mode === "union") {
        cells.push(row[x] === "#" || row[mirrored] === "#" ? "#" : ".");
        continue;
      }

      // pick the value from the authoritative half
      const inLeftHalf = x < width / 2;
      const source = mode === "left" ? (inLeftHalf ? x : mirrored) : inLeftHalf ? mirrored : x;
      cells.push(row[source] === "#" ? "#" : ".");
    }

    return cells.join("");
  });

  return { ...grid, rows };
}

/** Convenience wrapper kept for the declared `symmetry: "vertical"` case. */
export function symmetriseGrid(grid: OccupancyGrid): OccupancyGrid {
  return mirrorGrid(grid, "union");
}

export type SampledIllustration = {
  illustration: BarIllustration;
  /** The mask as drawn by the AI layer, trimmed. */
  mask: OccupancyGrid;
  /** The sampling raster the bars were derived from. */
  sampled: OccupancyGrid;
};

/**
 * Full deterministic pipeline: mask -> vertical sampling -> BarIllustration.
 *
 * The detail level only changes the sampling density. Bar width and gap stay at
 * 1 unit each by construction, because the renderer places bar `x` at
 * `padding + x * pitch`.
 */
export type MaskToIllustrationOptions = {
  paddingUnits?: number;
  /**
   * Overrides the mirroring. Without it, `symmetry: "vertical"` implies `union`
   * and everything else stays untouched.
   */
  mirror?: MirrorMode;
};

export function maskToIllustration(
  document: OccupancyDocument,
  detail: DetailLevel,
  options: MaskToIllustrationOptions = {},
): SampledIllustration {
  const mirror: MirrorMode =
    options.mirror ?? (document.symmetry === "vertical" ? "union" : "none");

  // Mirror the mask first, so the debug view shows the shape the bars come from,
  // then again after sampling, because resampling can reintroduce a one cell
  // offset when the sampling columns do not align with the centre.
  const mask = mirrorGrid(trimGrid(document.grid), mirror);
  const resampled = resampleMask(mask, DETAIL_COLUMNS[detail]);
  const sampled = mirrorGrid(resampled, mirror);
  const illustration = occupancyToIllustration(
    { ...document, grid: sampled },
    options.paddingUnits ?? 2,
  );

  return { illustration, mask, sampled };
}

/* -------------------------------------------------------------------------- */
/* Signature graphics pipeline                                                */
/* -------------------------------------------------------------------------- */

export type SignaturePipelineResult = {
  illustration: BarIllustration;
  /** The cleaned and cropped mask the strokes were derived from. */
  mask: OccupancyGrid;
  /** The drawable raster at 1 dp vertical resolution, motif already placed. */
  sampled: OccupancyGrid;
  plan: SignatureCanvasPlan;
  report: ConstructionReport;
};

export type SignatureOptions = {
  /**
   * How aggressively fragments and pinholes are removed, from 0 to 1.
   * Defaults to `DEFAULT_CLEANUP`.
   */
  cleanup?: number;
  /** Permits the 144x96 / 96x144 formats for clearly tall or wide motifs. */
  allowExtendedFormat?: boolean;
  mirror?: MirrorMode;
  /**
   * Area a cell needs before it counts as filled, from 0 to 1.
   *
   * The two sampling modes are the ends of this one axis, so a single value
   * covers both: `0` means every touch counts and is handled by the exact
   * `extent` implementation, anything above is area based. Defaults to `0`.
   */
  coverage?: number;
  /** Tolerance in dp for pulling almost aligned edges onto one level. 0 = off. */
  edgeTolerance?: number;
  /** Gaps below this size in dp are swallowed. 0 keeps every gap. */
  fuseGapsBelow?: number;
  /**
   * Set when the template was already cropped to its content, so the grid's full
   * extent *is* the motif.
   *
   * Then the crop and the fit happen before any thresholding, which is what keeps
   * the motif still: the threshold can only change which cells are filled, never
   * the size or position of the motif on the canvas. Without this the mask is
   * re-cropped after thresholding, and a shrinking silhouette gets refitted and
   * re-centred on every move of the slider.
   */
  extentIsMotif?: boolean;
};

/**
 * Full signature graphics pipeline.
 *
 * ```
 * cleanup -> crop -> format -> fit -> sample at 1 dp -> construction rules
 * ```
 *
 * The cleanup runs **before** the crop on purpose. Cropping first would let a
 * single speck in a corner define the bounding box, and the motif would end up
 * fitted smaller than it should be.
 *
 * Mirroring is applied to the mask only, before the rules run.
 */
/**
 * Maps the detail strength onto the second, stricter threshold.
 *
 * Interpolating from the outline threshold upwards keeps the strict pass strict by
 * construction: it can never fall below the outline, where it would have nothing
 * to add. The ceiling stays short of 1 because a cell needs some room below full
 * coverage to still count as material.
 */
const DETAIL_THRESHOLD_CEILING = 0.95;

export function detailThreshold(threshold: number, detail: number): number {
  const strength = Math.min(Math.max(detail, 0), 1);
  if (strength <= 0) return threshold;
  return threshold + strength * (DETAIL_THRESHOLD_CEILING - threshold);
}

export function maskToSignature(
  document: OccupancyDocument,
  options: SignatureOptions = {},
): SignaturePipelineResult {
  const tuning = cleanupTuning(options.cleanup ?? DEFAULT_CLEANUP);
  const mirror: MirrorMode =
    options.mirror ?? (document.symmetry === "vertical" ? "union" : "none");

  // 1. normalise: mirror, remove fragments, then crop to what is actually filled.
  // When the template was cropped to its content beforehand, the extent is
  // already the motif and must be kept as it is - see `extentIsMotif`.
  const extentIsMotif = options.extentIsMotif ?? false;
  const mirrored = mirrorGrid(normalizeGrid(document.grid), mirror);
  const cleaned = cleanMask(mirrored, tuning);
  const mask = extentIsMotif ? normalizeGrid(cleaned) : trimGrid(cleaned);

  // 2. fixed format, motif fitted into the drawable area
  const format = chooseFormat(mask, options.allowExtendedFormat ?? false, extentIsMotif);
  const plan = planSignatureCanvas(mask, format, extentIsMotif);

  // 3. sample the motif at its fitted size, then place it in the drawable area
  const coverage = options.coverage ?? 0;
  const motif = resampleMaskTo(
    mask,
    plan.columnsUsed,
    plan.rowsUsed,
    coverage,
    coverage <= 0 ? "extent" : "coverage",
    extentIsMotif,
  );
  const sampled = placeInDrawable(motif, plan);

  // 4. apply the construction rules
  const strokes = constructStrokes(sampled, {
    edgeTolerance: options.edgeTolerance,
    fuseGapsBelow: options.fuseGapsBelow,
  });
  const illustration = strokesToIllustration(document, strokes, plan);

  return { illustration, mask, sampled, plan, report: strokes.report };
}

export type ImageSignatureOptions = {
  /** Ink coverage from 0 to 1 at which a stroke cell counts as filled. */
  threshold?: number;
  /** How aggressively fragments and pinholes are removed, from 0 to 1. */
  cleanup?: number;
  /** Permits the 144x96 / 96x144 formats for clearly tall or wide motifs. */
  allowExtendedFormat?: boolean;
  mirror?: MirrorMode;
  /** Tolerance in dp for pulling almost aligned edges onto one level. 0 = off. */
  edgeTolerance?: number;
  /** Gaps below this size in dp are swallowed. 0 keeps every gap. */
  fuseGapsBelow?: number;
  /**
   * How strictly the inside is measured, from 0 to 1, independently of the
   * outline. 0 leaves the shape solid; higher values open up windows, portals and
   * other inner structure without touching the silhouette.
   */
  detail?: number;
  /** Seams cut by hand, optionally limited to a range of stroke slots. */
  manualSeams?: Seam[];
  /** Set for a light silhouette on a dark background. */
  invert?: boolean;
};

/**
 * Single stage pipeline: content cropped image -> signature graphic.
 *
 * ```
 * fit the image into the format -> measure ink per stroke cell -> threshold
 *   -> mirror -> cleanup -> construction rules
 * ```
 *
 * The difference to {@link maskToSignature} is that there is no intermediate
 * mask: the image is measured **directly** on the stroke grid, so it is
 * quantised once instead of twice. Two consequences follow, and they are the
 * reason for this path:
 *
 * - the threshold works on the real ink of a cell rather than on an average of
 *   already binarised cells, so it is an exact area decision
 * - the fit is derived from the image's own dimensions, before any cell has been
 *   classified, so the threshold can never move or resize the motif
 *
 * The image must already be cropped to its content, so its extent *is* the
 * motif - see `cropToContent`.
 */
export function imageToSignature(
  image: RasterImage,
  document: Omit<OccupancyDocument, "grid">,
  options: ImageSignatureOptions = {},
): SignaturePipelineResult {
  const tuning = cleanupTuning(options.cleanup ?? DEFAULT_CLEANUP);
  const mirror: MirrorMode =
    options.mirror ?? (document.symmetry === "vertical" ? "union" : "none");

  // 1. The fit comes from the image itself. Pixels are square, so the aspect can
  // be used directly; nothing here depends on the threshold.
  const format = chooseFormatForExtent(
    image.width,
    image.height,
    options.allowExtendedFormat ?? false,
  );
  const plan = planSignatureCanvasForExtent(image.width, image.height, format);

  // 2. Measure the image straight onto the fitted stroke grid and threshold it.
  // The outline follows `threshold`; `detail` adds a second, stricter pass that
  // only carves openings out of the inside, leaving the outline alone.
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const measured = imageToGridWithDetail(
    image,
    plan.columnsUsed,
    plan.rowsUsed,
    threshold,
    detailThreshold(threshold, options.detail ?? 0),
    options.invert ?? false,
  );

  // 3. Mirror and clean on that grid, keeping its extent - the motif fills it by
  // construction, so trimming would only undo the fit.
  const motif = cleanMask(mirrorGrid(measured, mirror), tuning);
  const sampled = placeInDrawable(motif, plan);

  // 4. apply the construction rules
  const strokes = constructStrokes(sampled, {
    edgeTolerance: options.edgeTolerance,
    fuseGapsBelow: options.fuseGapsBelow,
    manualSeams: options.manualSeams,
  });
  const illustration = strokesToIllustration(document, strokes, plan);

  return { illustration, mask: motif, sampled, plan, report: strokes.report };
}
