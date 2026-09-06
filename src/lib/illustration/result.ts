import type { BarIllustration } from "./types";
import type { OccupancyGrid } from "./occupancy";
import type { RemovedSegment } from "./segments";

/**
 * Places the binary intermediate mask back over the finished graphic, aligned
 * to the exact area the motif was fitted into.
 *
 * The mask is shown as a grid at the chosen resolution, so it does move with the
 * threshold and resolution - that is its purpose. The raw source photo is not
 * part of this: it is a fixed reference drawn straight from the uploaded file,
 * so it never moves. The box places the mask on the canvas as fractions of the
 * full canvas (padding included), so it lines up regardless of the scale the
 * stage renders the SVG at.
 */
/** A box on the canvas, as fractions of the full canvas (padding included). */
export type OverlayBox = {
  /** Left edge, 0..1 of the total canvas width. */
  left: number;
  /** Top edge, 0..1 of the total canvas height. */
  top: number;
  /** Width, 0..1 of the total canvas width. */
  width: number;
  /** Height, 0..1 of the total canvas height. */
  height: number;
};

export type OverlayGeometry = {
  /**
   * Data URL of the source image, already cropped to its content, so the photo
   * lines up with the graphic instead of carrying its own margin.
   */
  src?: string;
  /**
   * The area the motif was fitted into. Derived from the image's own dimensions
   * before any cell is classified, so no setting can move it.
   */
  sourceBox: OverlayBox;
  /** Kept as a separate name for the mask layer, currently the same box. */
  maskBox: OverlayBox;
};

/**
 * Result of one conversion.
 *
 * The whole pipeline runs in the browser, so this is a plain in memory value
 * rather than an API payload. The two grids are kept for the debug view: they
 * make the two reduction steps - image to mask, mask to construction raster -
 * inspectable without re-running anything.
 */
export type ConversionResult = {
  illustration: BarIllustration;
  /** The cleaned shape mask the strokes were derived from. */
  mask?: OccupancyGrid;
  /** The construction raster at 1 dp vertical resolution. */
  grid?: OccupancyGrid;
  /** Where the illustration came from. Currently always an image template. */
  provider: "image";
  subject: string;
  /** Cleanup strength the result was produced with, from 0 to 1. */
  cleanup: number;
  durationMs: number;
  warnings: string[];
  /** Source template laid over the graphic, aligned to the fitted motif area. */
  overlay?: OverlayGeometry;
  /**
   * Segments taken out by hand, in grid units.
   *
   * Carried along because the graphic no longer contains them: the delete tool
   * shows them in place so a removal stays visible and can be taken back.
   */
  removed?: RemovedSegment[];
  /**
   * The panel settings this result was produced with.
   *
   * Readable here because the panel owns them, which is what allows the current
   * state to be captured without lifting every control into the parent.
   */
  settings?: {
    threshold: number;
    detail: number;
    edgeTolerance: number;
    mirror?: string;
  };
  /** Construction report, shown in the debug view. */
  raw?: unknown;
};
