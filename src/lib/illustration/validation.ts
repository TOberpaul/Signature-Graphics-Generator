import { barIllustrationSchema, occupancyDocumentSchema } from "./schema";
import { LIMITS, maxBarIndex, pitchUnitsOf } from "./geometry";
import {
  EMPTY_CHARS,
  OCCUPIED_CHARS,
  columnSegments,
  isOccupied,
  normalizeGrid,
  trimGrid,
} from "./occupancy";
import type { OccupancyDocument } from "./occupancy";
import type { BarIllustration } from "./types";

export type ValidationResult =
  | { ok: true; value: BarIllustration }
  | { ok: false; errors: string[] };

export type OccupancyValidationResult =
  | { ok: true; value: OccupancyDocument; notes: string[] }
  | { ok: false; errors: string[] };

/**
 * Strict validation of an AI produced OccupancyGrid.
 *
 * Checks the structure, the allowed characters and every limit that the derived
 * BarIllustration would have to respect, so an invalid grid never reaches the
 * mapping.
 */
export function validateOccupancyDocument(data: unknown): OccupancyValidationResult {
  const parsed = occupancyDocumentSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    };
  }

  const value = parsed.data as OccupancyDocument;
  const { grid } = value;
  const errors: string[] = [];
  const notes: string[] = [];

  // Declared dimensions are hints. Mismatches are noted, not rejected - the
  // rows themselves carry the drawing.
  if (grid.rows.length !== grid.heightCells) {
    notes.push(
      `heightCells war ${grid.heightCells}, tatsächlich ${grid.rows.length} Zeilen - Zeilen sind maßgeblich.`,
    );
  }

  const longestRow = Math.max(...grid.rows.map((row) => row.length));
  if (longestRow !== grid.widthCells) {
    notes.push(
      `widthCells war ${grid.widthCells}, längste Zeile ${longestRow} Zeichen - auf ${Math.max(longestRow, grid.widthCells)} Spalten normalisiert.`,
    );
  }

  for (const [y, row] of grid.rows.entries()) {
    for (const char of row) {
      if (!isOccupied(char) && !EMPTY_CHARS.has(char)) {
        errors.push(
          `grid.rows[${y}]: unsupported character "${char}". Use ${[...OCCUPIED_CHARS].slice(0, 2).join(" or ")} for occupied and "." for empty`,
        );
        break;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const trimmed = trimGrid(grid);
  if (trimmed.widthCells === 0) {
    errors.push("grid: contains no occupied cell");
  }
  if (trimmed.widthCells > LIMITS.maxBars) {
    errors.push(`grid: ${trimmed.widthCells} columns exceed the limit of ${LIMITS.maxBars} bars`);
  }
  if (trimmed.heightCells > LIMITS.maxHeightUnits) {
    errors.push(`grid: ${trimmed.heightCells} rows exceed the limit of ${LIMITS.maxHeightUnits}`);
  }

  for (let x = 0; x < trimmed.widthCells; x += 1) {
    const segments = columnSegments(trimmed, x);
    if (segments.length > LIMITS.maxSegmentsPerBar) {
      errors.push(
        `grid: column ${x} produces ${segments.length} segments, more than ${LIMITS.maxSegmentsPerBar}`,
      );
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { ...value, grid: normalizeGrid(grid) }, notes };
}

/**
 * Strict validation of untrusted (AI produced) illustration data.
 *
 * Runs the structural zod schema first, then the semantic grid rules that a
 * schema cannot express: canvas overflow, duplicate bars, overlapping or
 * unordered segments.
 */
export function validateIllustration(data: unknown): ValidationResult {
  const parsed = barIllustrationSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    };
  }

  const value = parsed.data as BarIllustration;
  const errors: string[] = [];
  const { canvas, bars } = value;
  const lastSlot = maxBarIndex(canvas.widthUnits, value.system);

  if (lastSlot < 0) {
    errors.push("canvas.widthUnits is too small to hold a single bar");
  }

  const pitch = pitchUnitsOf(value.system);
  const seen = new Set<string>();
  for (const [index, bar] of bars.entries()) {
    const at = `bars[${index}]`;
    const offset = bar.xOffsetUnits ?? 0;

    // A slot may hold a second stroke only when it is staggered, which is how a
    // level band avoids sitting flush against the silhouette.
    const key = `${bar.x}:${offset}`;
    if (seen.has(key)) {
      errors.push(`${at}: duplicate bar index x=${bar.x} with offset ${offset}u`);
    }
    seen.add(key);

    if (offset >= pitch) {
      errors.push(
        `${at}: xOffsetUnits=${offset}u must stay below one pitch (${pitch}u), otherwise the stroke lands in the next slot`,
      );
    }

    if (bar.x > lastSlot) {
      errors.push(
        `${at}: bar index x=${bar.x} exceeds the canvas (max index ${lastSlot})`,
      );
    }

    if (bar.segments.length > LIMITS.maxSegmentsPerBar) {
      errors.push(`${at}: too many segments (${bar.segments.length})`);
    }

    let previousEnd = -1;
    for (const [s, segment] of bar.segments.entries()) {
      const segAt = `${at}.segments[${s}]`;
      const end = segment.y + segment.height;

      if (end > canvas.heightUnits) {
        errors.push(
          `${segAt}: segment ends at ${end}u, outside the canvas height ${canvas.heightUnits}u`,
        );
      }
      if (segment.y < previousEnd) {
        errors.push(
          `${segAt}: segment overlaps or is unordered (starts at ${segment.y}u, previous segment ends at ${previousEnd}u)`,
        );
      }
      previousEnd = end;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
