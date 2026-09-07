/**
 * Strokes added by hand.
 *
 * The counterpart to `segments.ts`: that module takes parts out of a finished
 * graphic, this one puts strokes in. Both are construction steps applied to the
 * built geometry and validated afterwards, so a hand edited graphic still has to
 * obey every rule of the system.
 *
 * A template does not always carry everything the motif needs. A mast, an aerial,
 * a flagpole, the gap between two buildings that should read as one - these are
 * either too thin to survive thresholding or simply not in the source at all.
 * Rather than fight the threshold for them, they are drawn in.
 *
 * An added stroke is stored as a slot plus a row and a height, not as geometry.
 * That is deliberate and the same reasoning as for seams: the geometry is rebuilt
 * from the template whenever a setting moves, so there is no lasting identity for
 * "that stroke" - but a position on the drawable grid keeps meaning the same
 * thing, so the addition survives a change of threshold.
 */

import { DP, LIMITS, maxBarIndex } from "./geometry";
import type { Bar, BarIllustration, BarSegment } from "./types";

/**
 * One stroke placed by hand.
 *
 * Coordinates are the drawable grid: `slot` is a stroke slot counted from the
 * left, `row` a dp row counted from the top of the drawable area - the safe area
 * is not included in either. This is the same system seams use.
 */
export type AddedStroke = {
  /** Stroke slot, 0 being the leftmost. */
  slot: number;
  /** Top edge, in dp rows of the drawable area. */
  row: number;
  /** Length in dp. Never below {@link MIN_ADDED_HEIGHT}. */
  height: number;
};

/**
 * Shortest stroke that may be added.
 *
 * The guideline's minimum stroke length: anything shorter is a fragment, and the
 * construction rules would remove it. Offering a shorter one would mean offering
 * a stroke that vanishes.
 */
export const MIN_ADDED_HEIGHT = DP.minStrokeLength;

/**
 * Brings a stroke inside the drawable area, or returns null if it cannot fit.
 *
 * The height is honoured before the position: a stroke dragged past the bottom
 * edge keeps its length and slides up, rather than being cut short. That is what
 * makes dragging along an edge feel solid instead of springy.
 */
export function clampAddedStroke(
  stroke: AddedStroke,
  rows: number,
  lastSlot: number,
): AddedStroke | null {
  if (rows < MIN_ADDED_HEIGHT || lastSlot < 0) return null;

  const height = Math.min(
    Math.max(Math.round(stroke.height), MIN_ADDED_HEIGHT),
    rows,
  );
  const row = Math.min(Math.max(Math.round(stroke.row), 0), rows - height);
  const slot = Math.min(Math.max(Math.round(stroke.slot), 0), lastSlot);

  return { slot, row, height };
}

/**
 * Merges segments so the result is ordered and never overlaps.
 *
 * Required by the validator, which rejects a bar whose segments overlap or run
 * out of order. Touching counts as overlapping here: two segments that meet edge
 * to edge are one stroke, and keeping them apart would only be a second way to
 * describe the same thing.
 */
function mergeSegments(segments: BarSegment[]): BarSegment[] {
  const sorted = [...segments].sort((a, b) => a.y - b.y);
  const merged: BarSegment[] = [];

  for (const segment of sorted) {
    const previous = merged[merged.length - 1];
    const end = segment.y + segment.height;

    if (previous && segment.y <= previous.y + previous.height) {
      previous.height = Math.max(previous.y + previous.height, end) - previous.y;
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
}

/**
 * Draws the added strokes into the graphic.
 *
 * Applied after the hand removals, so an addition always survives: the two tools
 * would otherwise fight over the same place, and "what I drew stays" is the only
 * predictable of the two orders.
 *
 * A stroke lands in the bar of its slot when there is one, and creates that bar
 * when there is not. Staggered bars are left alone: they sit at a different x by
 * design (a level band offset by 2 dp), so merging into one would shift the added
 * stroke sideways from where it was drawn.
 */
export function addStrokes(
  illustration: BarIllustration,
  strokes: AddedStroke[],
): BarIllustration {
  if (strokes.length === 0) return illustration;

  const rows = illustration.canvas.heightUnits;
  const lastSlot = maxBarIndex(illustration.canvas.widthUnits, illustration.system);

  const bySlot = new Map<number, BarSegment[]>();
  for (const stroke of strokes) {
    const fitted = clampAddedStroke(stroke, rows, lastSlot);
    if (!fitted) continue;
    const list = bySlot.get(fitted.slot) ?? [];
    list.push({ y: fitted.row, height: fitted.height });
    bySlot.set(fitted.slot, list);
  }

  if (bySlot.size === 0) return illustration;

  // Copied before touching anything, so the input illustration stays untouched -
  // it is rebuilt from the template and reused elsewhere.
  const bars: Bar[] = illustration.bars.map((bar) => ({
    ...bar,
    segments: [...bar.segments],
  }));

  const unstaggered = new Map<number, Bar>();
  for (const bar of bars) {
    if ((bar.xOffsetUnits ?? 0) === 0) unstaggered.set(bar.x, bar);
  }

  for (const [slot, segments] of bySlot) {
    const target = unstaggered.get(slot);

    if (target) {
      const merged = mergeSegments([...target.segments, ...segments]);
      // The cap is a hard limit of the model. Dropping the addition is better
      // than producing a graphic the validator will reject, which would take the
      // whole preview down instead of just this one stroke.
      if (merged.length <= LIMITS.maxSegmentsPerBar) target.segments = merged;
      continue;
    }

    if (bars.length >= LIMITS.maxBars) continue;
    const bar: Bar = { x: slot, segments: mergeSegments(segments) };
    bars.push(bar);
    unstaggered.set(slot, bar);
  }

  // Sorted by slot, so the bars read left to right like the ones the pipeline
  // produces. Nothing depends on the order, but a stable one keeps the debug
  // output and the exported markup comparable.
  bars.sort(
    (a, b) => a.x - b.x || (a.xOffsetUnits ?? 0) - (b.xOffsetUnits ?? 0),
  );

  return { ...illustration, bars };
}
