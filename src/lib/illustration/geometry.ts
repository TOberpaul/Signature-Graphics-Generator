import type { DetailLevel, IllustrationSystem } from "./types";

/** Bar width in units of the legacy 1u system. */
export const BAR_WIDTH_UNITS = 1 as const;

/** Horizontal gap between two neighbouring bar slots, in units. */
export const GAP_UNITS = 1 as const;

/** Distance from one bar slot to the next: barWidth + gap. */
export const PITCH_UNITS = BAR_WIDTH_UNITS + GAP_UNITS; // 2

/**
 * The original abstract system: one unit per bar, one unit per gap. Still used
 * by the prompt based abstraction path, which reasons in relative units.
 */
export const DEFAULT_SYSTEM: IllustrationSystem = {
  barWidthUnits: BAR_WIDTH_UNITS,
  gapUnits: GAP_UNITS,
};

/**
 * Construction constants of the signature graphics guideline, in dp.
 *
 * The signature pipeline maps **one unit to one dp**, which is the only mapping
 * that can express every value below as an integer: a 1 dp vertical gap and a
 * 3 dp safe area are not representable when a unit is 2 dp.
 */
export const DP = {
  /**
   * Ideal format, in dp. This is the **outer** format: the safe area lies
   * inside it, so the drawable area is `baseCanvas - 2 * safeArea`.
   */
  baseCanvas: 96,
  /** Extended edge for a deliberately non square format. */
  extendedCanvas: 144,
  /** Clear space kept to every edge of the format. */
  safeArea: 3,
  /** Width of a single vertical stroke. */
  strokeWidth: 2,
  /** Horizontal distance between two strokes. */
  horizontalGap: 2,
  /** Shortest legal stroke. Anything shorter is a fragment. */
  minStrokeLength: 4,
  /** Normal separation of two strokes stacked in the same column. */
  tightVerticalGap: 1,
  /** Separation that reads as a deliberate negative space. */
  intentionalVerticalGap: 4,
  /** Allowed horizontal stagger between neighbouring rows or elements. */
  rowOffset: 2,
} as const;

/**
 * The three legal formats, in dp, measured on the outside.
 *
 * The format is fixed and the motif is fitted into it. `square` is the ideal;
 * the two extended formats exist for motifs whose aspect ratio would otherwise
 * leave most of the format empty.
 */
export const FORMATS = {
  square: { widthDp: DP.baseCanvas, heightDp: DP.baseCanvas },
  landscape: { widthDp: DP.extendedCanvas, heightDp: DP.baseCanvas },
  portrait: { widthDp: DP.baseCanvas, heightDp: DP.extendedCanvas },
} as const;

export type FormatName = keyof typeof FORMATS;
export type SignatureFormat = (typeof FORMATS)[FormatName];

/** Drawable area of a format: the format minus the safe area on both sides. */
export function drawableArea(format: SignatureFormat): {
  widthDp: number;
  heightDp: number;
} {
  return {
    widthDp: format.widthDp - DP.safeArea * 2,
    heightDp: format.heightDp - DP.safeArea * 2,
  };
}

/**
 * Number of strokes that fit into a drawable width.
 *
 * At a 2 dp stroke and a 2 dp gap, 90 dp hold exactly 23 strokes
 * (23 * 4 - 2 = 90), so the ideal format has a fixed stroke count.
 */
export function strokeSlots(drawableWidthDp: number): number {
  return Math.floor((drawableWidthDp + DP.horizontalGap) / DP_PITCH);
}

/** Distance from stroke to stroke in the signature system: 2 dp + 2 dp. */
export const DP_PITCH = DP.strokeWidth + DP.horizontalGap; // 4

/** The signature graphics system: 2 dp stroke, 2 dp gap, expressed in dp units. */
export const SIGNATURE_SYSTEM: IllustrationSystem = {
  barWidthUnits: DP.strokeWidth,
  gapUnits: DP.horizontalGap,
};

/** Hard limits, enforced during validation. */
export const LIMITS = {
  maxBars: 64,
  maxSegmentsPerBar: 24,
  maxWidthUnits: 260,
  maxHeightUnits: 260,
  maxPaddingUnits: 20,
  maxSubjectLength: 80,
} as const;

/** Distance from one bar slot to the next for a given system. */
export function pitchUnitsOf(system: IllustrationSystem = DEFAULT_SYSTEM): number {
  return system.barWidthUnits + system.gapUnits;
}

/** Number of bar slots that fit into a content area of `widthUnits`. */
export function slotCount(
  widthUnits: number,
  system: IllustrationSystem = DEFAULT_SYSTEM,
): number {
  return Math.floor((widthUnits + system.gapUnits) / pitchUnitsOf(system));
}

/** Content width in units required for `slots` bars (no trailing gap). */
export function widthUnitsForSlots(
  slots: number,
  system: IllustrationSystem = DEFAULT_SYSTEM,
): number {
  return slots <= 0 ? 0 : slots * pitchUnitsOf(system) - system.gapUnits;
}

/** Logical bar index -> x offset in units inside the content area. */
export function barOffsetUnits(
  x: number,
  system: IllustrationSystem = DEFAULT_SYSTEM,
): number {
  return x * pitchUnitsOf(system);
}

/** Highest legal bar index for a given content width. */
export function maxBarIndex(
  widthUnits: number,
  system: IllustrationSystem = DEFAULT_SYSTEM,
): number {
  return slotCount(widthUnits, system) - 1;
}

/* The detail level no longer maps to a bar count hint. It selects the base area
   in `DETAIL_BASE_DP`, and the stroke count follows from that area at a fixed
   4 dp pitch. See src/lib/illustration/signature.ts. */
