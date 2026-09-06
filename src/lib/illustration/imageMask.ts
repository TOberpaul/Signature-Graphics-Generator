/**
 * Image template -> shape mask.
 *
 * A bitmap silhouette (for example a flat black pictogram from an image tool, or
 * a rasterised icon) is reduced to a binary shape mask. From there the existing
 * deterministic pipeline takes over: vertical sampling, segments, bars, SVG.
 *
 * Everything here is pure and runs in the browser, so no image ever leaves the
 * machine and the threshold can be adjusted with instant feedback.
 */
import type { OccupancyGrid } from "./occupancy";

/** RGBA pixel buffer, matching the browser's ImageData shape. */
export type RasterImage = {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel. */
  data: Uint8ClampedArray | number[];
};

export type ImageMaskOptions = {
  /** Mask resolution in columns. The row count follows the image aspect. */
  columns?: number;
  /** Ink coverage from 0 to 1 at which a cell counts as occupied. */
  threshold?: number;
  /** Set for a light silhouette on a dark background. */
  invert?: boolean;
};

export const DEFAULT_MASK_COLUMNS = 64;
export const DEFAULT_THRESHOLD = 0.5;
const MIN_ROWS = 8;

/**
 * Ink value of one pixel, 0 = background, 1 = fully part of the silhouette.
 *
 * Transparent pixels count as background, which makes cut out PNGs work without
 * any extra handling.
 */
function inkAt(image: RasterImage, x: number, y: number, invert: boolean): number {
  const offset = (y * image.width + x) * 4;
  const r = image.data[offset] ?? 0;
  const g = image.data[offset + 1] ?? 0;
  const b = image.data[offset + 2] ?? 0;
  const alpha = (image.data[offset + 3] ?? 255) / 255;

  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const ink = invert ? luminance : 1 - luminance;
  return ink * alpha;
}

/** Average ink per mask cell, box filtered. Values run from 0 to 1. */
export function inkCoverage(
  image: RasterImage,
  columns: number,
  invert = false,
): { columns: number; rows: number; values: number[] } {
  const cols = Math.max(1, Math.round(columns));
  const rows = Math.max(
    MIN_ROWS,
    Math.round((cols * image.height) / Math.max(1, image.width)),
  );
  const values: number[] = [];

  const scaleX = image.width / cols;
  const scaleY = image.height / rows;

  for (let ty = 0; ty < rows; ty += 1) {
    const y0 = Math.floor(ty * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * scaleY));

    for (let tx = 0; tx < cols; tx += 1) {
      const x0 = Math.floor(tx * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * scaleX));

      let sum = 0;
      let count = 0;
      for (let y = y0; y < Math.min(image.height, y1); y += 1) {
        for (let x = x0; x < Math.min(image.width, x1); x += 1) {
          sum += inkAt(image, x, y, invert);
          count += 1;
        }
      }

      values.push(count > 0 ? sum / count : 0);
    }
  }

  return { columns: cols, rows, values };
}

/**
 * Otsu threshold over the ink histogram.
 *
 * Gives a sensible default for images whose background is not pure white, so the
 * user rarely has to touch the slider.
 */
export function autoThreshold(coverage: number[]): number {
  const buckets = 64;
  const histogram = new Array(buckets).fill(0);
  for (const value of coverage) {
    histogram[Math.min(buckets - 1, Math.floor(value * buckets))] += 1;
  }

  const total = coverage.length;
  if (total === 0) return DEFAULT_THRESHOLD;

  let sum = 0;
  for (let i = 0; i < buckets; i += 1) sum += i * histogram[i];

  let weightBackground = 0;
  let sumBackground = 0;
  let bestVariance = -1;
  let firstBestCut = buckets / 2;
  let lastBestCut = buckets / 2;

  for (let cut = 0; cut < buckets; cut += 1) {
    weightBackground += histogram[cut];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += cut * histogram[cut];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance =
      weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (variance > bestVariance) {
      bestVariance = variance;
      firstBestCut = cut;
      lastBestCut = cut;
    } else if (variance === bestVariance) {
      // flat optimum, for example a purely black and white image
      lastBestCut = cut;
    }
  }

  // centre of the optimal range, which sits between the two modes
  const cut = (firstBestCut + lastBestCut) / 2;
  return Math.min(0.95, Math.max(0.05, (cut + 0.5) / buckets));
}

/** Converts a bitmap silhouette into a binary shape mask. */
export function imageToMask(
  image: RasterImage,
  options: ImageMaskOptions = {},
): OccupancyGrid {
  const invert = options.invert ?? false;
  const { columns, rows, values } = inkCoverage(
    image,
    options.columns ?? DEFAULT_MASK_COLUMNS,
    invert,
  );
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  const gridRows: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    let line = "";
    for (let x = 0; x < columns; x += 1) {
      line += values[y * columns + x] >= threshold ? "#" : ".";
    }
    gridRows.push(line);
  }

  return { widthCells: columns, heightCells: rows, rows: gridRows };
}

/** Overlap of [aStart, aEnd) with [bStart, bEnd). */
function span(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Average ink per cell of an explicit `columns x rows` grid, area weighted.
 *
 * Unlike {@link inkCoverage} the row count is given rather than derived, so the
 * grid can be anisotropic - which is exactly what the stroke grid is: a cell is
 * one stroke slot wide (4 dp) but only 1 dp tall. Every source pixel contributes
 * in proportion to how much of it falls inside the cell, so the value is an exact
 * area measurement rather than a nearest-pixel estimate.
 *
 * Measuring straight onto the target grid avoids quantising the image twice: no
 * intermediate binary mask is built, so the threshold works on real grey values
 * instead of on averaged yes/no cells.
 */
export function inkCoverageGrid(
  image: RasterImage,
  columns: number,
  rows: number,
  invert = false,
): number[] {
  const cols = Math.max(1, Math.round(columns));
  const rowCount = Math.max(1, Math.round(rows));
  const values: number[] = [];

  const scaleX = image.width / cols;
  const scaleY = image.height / rowCount;

  for (let ty = 0; ty < rowCount; ty += 1) {
    const y0 = ty * scaleY;
    const y1 = (ty + 1) * scaleY;

    for (let tx = 0; tx < cols; tx += 1) {
      const x0 = tx * scaleX;
      const x1 = (tx + 1) * scaleX;

      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.min(image.height, Math.ceil(y1)); y += 1) {
        const weightY = span(y0, y1, y, y + 1);
        if (weightY <= 0) continue;

        for (let x = Math.floor(x0); x < Math.min(image.width, Math.ceil(x1)); x += 1) {
          const weight = span(x0, x1, x, x + 1) * weightY;
          if (weight <= 0) continue;
          sum += inkAt(image, x, y, invert) * weight;
          area += weight;
        }
      }

      values.push(area > 0 ? sum / area : 0);
    }
  }

  return values;
}

/**
 * Thresholds an image straight onto an explicit `columns x rows` grid.
 *
 * This is the single rastering step of the pipeline: measure the real ink of the
 * image per target cell, then decide filled or empty. One quantisation, not two.
 */
export function imageToGrid(
  image: RasterImage,
  columns: number,
  rows: number,
  threshold = DEFAULT_THRESHOLD,
  invert = false,
): OccupancyGrid {
  const cols = Math.max(1, Math.round(columns));
  const rowCount = Math.max(1, Math.round(rows));
  const values = inkCoverageGrid(image, cols, rowCount, invert);

  const gridRows: string[] = [];
  for (let y = 0; y < rowCount; y += 1) {
    let line = "";
    for (let x = 0; x < cols; x += 1) {
      line += values[y * cols + x] >= threshold ? "#" : ".";
    }
    gridRows.push(line);
  }

  return { widthCells: cols, heightCells: rowCount, rows: gridRows };
}

/**
 * Thresholds twice on one measurement: the outline generously, the inside
 * strictly, and punches the openings the strict pass finds into the generous one.
 *
 * A single threshold has to serve two purposes at once, and they pull in opposite
 * directions. Low, and the outline is clean while every window and portal fills
 * in, because their soft edges carry enough ink to pass. High, and the inner
 * structure appears while the outline itself starts breaking up, because real
 * wall is only partly covered too. Neither setting is wrong; the two decisions
 * simply do not belong on one control.
 *
 * So the shape comes from `threshold` and the openings from `detailThreshold`.
 * The distinction that makes this work: a cell the generous pass filled and the
 * strict pass did not is only turned into a hole when its whole group sits
 * enclosed by material. Groups that reach the outside are the soft edge of the
 * silhouette, and eroding those is exactly what must not happen - that is the
 * outline falling apart at a high threshold.
 *
 * `detailThreshold <= threshold` means there is nothing stricter to find, so the
 * result is the plain single threshold grid.
 */
export function imageToGridWithDetail(
  image: RasterImage,
  columns: number,
  rows: number,
  threshold: number,
  detailThreshold: number,
  invert = false,
): OccupancyGrid {
  const cols = Math.max(1, Math.round(columns));
  const rowCount = Math.max(1, Math.round(rows));

  if (detailThreshold <= threshold) {
    return imageToGrid(image, cols, rowCount, threshold, invert);
  }

  // One measurement for all of it. Measuring again per level would be the same
  // numbers with a different cut off.
  const values = inkCoverageGrid(image, cols, rowCount, invert);
  const holes = new Uint8Array(cols * rowCount);

  // Sweeping the levels rather than testing only the final one is what makes the
  // control behave predictably. A group of candidate cells grows as the level
  // rises, and at some point it breaks through to the outside and stops counting
  // as enclosed - so testing the final level alone made openings appear and then
  // disappear again as the slider went up. Accumulating every level up to it means
  // an opening found once stays found, and raising the setting can only ever add.
  for (const level of detailLevels(threshold, detailThreshold)) {
    markEnclosedHoles(values, cols, rowCount, threshold, level, holes);
  }

  const gridRows: string[] = [];
  for (let y = 0; y < rowCount; y += 1) {
    let line = "";
    for (let x = 0; x < cols; x += 1) {
      const index = y * cols + x;
      line += values[index] >= threshold && !holes[index] ? "#" : ".";
    }
    gridRows.push(line);
  }

  return { widthCells: cols, heightCells: rowCount, rows: gridRows };
}

/** Step between the levels swept between the two thresholds. */
const DETAIL_SWEEP_STEP = 0.05;

/**
 * The levels to sweep, always including the requested one.
 *
 * Raising `detailThreshold` extends this list without changing the entries below
 * it, which is what carries the monotonicity: more levels can only find more.
 */
function detailLevels(threshold: number, detailThreshold: number): number[] {
  const levels: number[] = [];
  for (
    let level = threshold + DETAIL_SWEEP_STEP;
    level < detailThreshold;
    level += DETAIL_SWEEP_STEP
  ) {
    levels.push(level);
  }
  levels.push(detailThreshold);
  return levels;
}

/**
 * Marks every enclosed group of candidate cells at one level into `holes`.
 *
 * A candidate is inside the shape at `threshold` but below `level`, so it is
 * material the generous pass kept and the strict pass would drop. Those groups are
 * either an opening or the soft rim of the silhouette, and the difference is
 * whether the group reaches the outside - the rim does, and eroding it is what
 * makes an outline fray.
 */
function markEnclosedHoles(
  values: number[],
  cols: number,
  rowCount: number,
  threshold: number,
  level: number,
  holes: Uint8Array,
): void {
  /** 0 = outside the shape, 1 = material, 2 = candidate for an opening. */
  const state = new Uint8Array(cols * rowCount);
  for (let index = 0; index < state.length; index += 1) {
    const ink = values[index];
    state[index] = ink < threshold ? 0 : ink >= level ? 1 : 2;
  }

  const visited = new Uint8Array(cols * rowCount);

  for (let start = 0; start < state.length; start += 1) {
    if (state[start] !== 2 || visited[start]) continue;

    const group: number[] = [];
    const queue: number[] = [start];
    visited[start] = 1;
    let enclosed = true;

    while (queue.length > 0) {
      const index = queue.pop()!;
      group.push(index);

      const x = index % cols;
      const y = (index - x) / cols;

      // Sitting on the border means being open to the outside.
      if (x === 0 || y === 0 || x === cols - 1 || y === rowCount - 1) {
        enclosed = false;
      }

      const neighbours = [
        y > 0 ? index - cols : -1,
        y < rowCount - 1 ? index + cols : -1,
        x > 0 ? index - 1 : -1,
        x < cols - 1 ? index + 1 : -1,
      ];

      for (const neighbour of neighbours) {
        if (neighbour < 0) continue;
        if (state[neighbour] === 0) {
          enclosed = false;
          continue;
        }
        if (state[neighbour] === 2 && !visited[neighbour]) {
          visited[neighbour] = 1;
          queue.push(neighbour);
        }
      }
    }

    if (enclosed) {
      for (const index of group) holes[index] = 1;
    }
  }
}

/**
 * Ink level above which a pixel counts as content rather than empty background.
 *
 * This only decides where the empty border of a template ends - what belongs to
 * the silhouette is the threshold's job, later and on the already cropped image.
 *
 * Set well clear of white rather than just above zero: at a hair above zero a
 * single JPEG artefact or a stray antialiasing pixel counts as content, stretches
 * the crop to that side and the motif ends up visibly off centre on the canvas.
 * At this level near-white noise is ignored while genuinely light grey parts of a
 * motif are still kept.
 */
const CONTENT_INK_FLOOR = 0.15;

/** Pixel rectangle, as returned by {@link contentBounds}. */
export type PixelBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Bounding box of everything that is not empty background.
 *
 * Measured directly on the pixels with a fixed floor, so it does **not** depend
 * on the threshold. That is the whole point: the motif is cropped and fitted once
 * per image, and moving the threshold afterwards can only change which cells are
 * filled - never where the motif sits or how large it is.
 *
 * Returns null when the image is empty.
 */
export function contentBounds(image: RasterImage, invert = false): PixelBox | null {
  let left = image.width;
  let right = -1;
  let top = image.height;
  let bottom = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (inkAt(image, x, y, invert) < CONTENT_INK_FLOOR) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < 0 || bottom < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Copies a rectangular region into a new raster. Pure, no canvas involved. */
export function cropRaster(image: RasterImage, box: PixelBox): RasterImage {
  const width = Math.max(1, Math.min(box.width, image.width - box.x));
  const height = Math.max(1, Math.min(box.height, image.height - box.y));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((box.y + y) * image.width + (box.x + x)) * 4;
      const to = (y * width + x) * 4;
      data[to] = image.data[from] ?? 0;
      data[to + 1] = image.data[from + 1] ?? 0;
      data[to + 2] = image.data[from + 2] ?? 0;
      data[to + 3] = image.data[from + 3] ?? 255;
    }
  }

  return { width, height, data };
}

/**
 * Crops a template to its content, so the motif's extent - and therefore its
 * placement on the canvas - is fixed before any threshold is applied.
 */
export function cropToContent(image: RasterImage, invert = false): RasterImage {
  const box = contentBounds(image, invert);
  return box ? cropRaster(image, box) : image;
}

/**
 * Suggests a threshold for an image, based on its own ink distribution.
 * Returned separately so the UI can preselect the slider.
 */
export function suggestThreshold(image: RasterImage, options: ImageMaskOptions = {}): number {
  const { values } = inkCoverage(
    image,
    options.columns ?? DEFAULT_MASK_COLUMNS,
    options.invert ?? false,
  );
  return autoThreshold(values);
}
