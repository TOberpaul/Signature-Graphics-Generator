import { z } from "zod";
import { LIMITS } from "./geometry";
import type { BarIllustration } from "./types";

/** Non-negative integer. */
const unit = z.number().int().min(0);

export const barSegmentSchema = z.strictObject({
  y: unit.max(LIMITS.maxHeightUnits),
  height: z.number().int().min(1).max(LIMITS.maxHeightUnits),
});

export const barSchema = z.strictObject({
  x: unit.max(LIMITS.maxWidthUnits),
  xOffsetUnits: unit.max(LIMITS.maxWidthUnits).optional(),
  segments: z
    .array(barSegmentSchema)
    .min(1)
    .max(LIMITS.maxSegmentsPerBar),
});

export const illustrationMetaSchema = z.strictObject({
  subject: z.string().min(1).max(LIMITS.maxSubjectLength),
  label: z.string().max(LIMITS.maxSubjectLength).optional(),
  symmetry: z.enum(["none", "vertical"]).optional(),
});

export const illustrationCanvasSchema = z.strictObject({
  widthUnits: z.number().int().min(1).max(LIMITS.maxWidthUnits),
  heightUnits: z.number().int().min(1).max(LIMITS.maxHeightUnits),
  paddingUnits: unit.max(LIMITS.maxPaddingUnits),
});

/**
 * Stroke width and gap are constant per illustration. They must be equal, which
 * is what keeps the rhythm even: every stroke is as wide as the space next to
 * it. `{1,1}` is the abstract system, `{2,2}` the dp accurate signature system.
 */
export const illustrationSystemSchema = z
  .strictObject({
    barWidthUnits: z.number().int().min(1).max(8),
    gapUnits: z.number().int().min(1).max(8),
  })
  .refine((system) => system.barWidthUnits === system.gapUnits, {
    message: "barWidthUnits and gapUnits must be equal so the rhythm stays even",
  });

export const barIllustrationSchema = z.strictObject({
  meta: illustrationMetaSchema,
  canvas: illustrationCanvasSchema,
  system: illustrationSystemSchema,
  bars: z.array(barSchema).min(1).max(LIMITS.maxBars),
});

export type BarIllustrationInput = z.input<typeof barIllustrationSchema>;

/* -------------------------------------------------------------------------- */
/* OccupancyGrid - the format the AI layer actually produces                   */
/* -------------------------------------------------------------------------- */

export const occupancyGridSchema = z.strictObject({
  widthCells: z.number().int().min(3).max(LIMITS.maxBars),
  heightCells: z.number().int().min(3).max(LIMITS.maxHeightUnits),
  rows: z.array(z.string()).min(3).max(LIMITS.maxHeightUnits),
});

export const occupancyDocumentSchema = z.strictObject({
  subject: z.string().min(1).max(LIMITS.maxSubjectLength),
  label: z.string().max(LIMITS.maxSubjectLength).optional(),
  symmetry: z.enum(["none", "vertical"]).optional(),
  grid: occupancyGridSchema,
});

export type OccupancyDocumentInput = z.input<typeof occupancyDocumentSchema>;

/** Compile-time check that schema output and hand written type stay in sync. */
export type SchemaMatchesType = z.output<typeof barIllustrationSchema> extends BarIllustration
  ? true
  : never;
