/**
 * Data model of the bar illustration system.
 *
 * All values are integer units of the abstract grid. Pixel coordinates are
 * never part of this model - they are derived by the deterministic renderer.
 */

/** One uninterrupted vertical segment inside a bar. */
export type BarSegment = {
  /** Top edge of the segment, in units, measured from the top of the canvas. */
  y: number;
  /** Segment length in units. Must be > 0. */
  height: number;
};

/** One vertical bar of the grid. */
export type Bar = {
  /**
   * Logical bar index on the horizontal grid (0 = leftmost slot).
   * The pixel position is computed by the renderer as
   * `padding + x * pitch + xOffsetUnits`, never by the LLM.
   */
  x: number;
  /**
   * Horizontal stagger of this stroke against the base grid, in units.
   *
   * The guideline allows a row or element to be offset horizontally by 2 dp so
   * neighbouring elements never sit flush next to each other. Must stay below
   * one pitch, otherwise the stroke would land in the next slot.
   */
  xOffsetUnits?: number;
  /** Disjoint, ordered segments. Multiple segments create negative space. */
  segments: BarSegment[];
};

export type IllustrationMeta = {
  /** The subject as understood by the abstraction layer. */
  subject: string;
  label?: string;
  symmetry?: "none" | "vertical";
};

export type IllustrationCanvas = {
  /** Width of the drawable content area in units (padding excluded). */
  widthUnits: number;
  /** Height of the drawable content area in units (padding excluded). */
  heightUnits: number;
  /** Padding around the content area in units. */
  paddingUnits: number;
};

/**
 * Geometric system of the graphic. Both values are fixed for a given
 * illustration and the detail level must never change them.
 *
 * Two systems exist:
 * - `{ 1, 1 }` the abstract legacy system, one unit per stroke and per gap
 * - `{ 2, 2 }` the signature graphics system, where one unit is one dp, so a
 *   stroke is 2 dp wide and strokes sit 2 dp apart
 */
export type IllustrationSystem = {
  /** Width of one stroke, in units. */
  barWidthUnits: number;
  /** Horizontal gap between two strokes, in units. */
  gapUnits: number;
};

export type BarIllustration = {
  meta: IllustrationMeta;
  canvas: IllustrationCanvas;
  system: IllustrationSystem;
  bars: Bar[];
};

export type DetailLevel = "low" | "medium" | "high";

/** Options accepted by every abstraction provider. */
export type AbstractionOptions = {
  detail: DetailLevel;
};
