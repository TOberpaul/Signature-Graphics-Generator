/**
 * Connected parts of a graphic.
 *
 * The renderer emits one rect per bar segment and knows nothing about which of
 * them belong together. For editing, that grouping is exactly what matters: a
 * caption under a building, a detached annex, a speck the cleanup missed - each
 * is a set of segments that touch, and the user wants to remove it as one thing.
 *
 * Two segments are connected when they sit in neighbouring bar slots and their
 * vertical extents overlap. Diagonal-only contact does not count, so a hand
 * placed seam genuinely separates what is above it from what is below.
 */

import { barOffsetUnits } from "./geometry";
import { effectivePadding } from "./renderer";
import type { Bar, BarIllustration } from "./types";

/**
 * How far, in dp, a point may sit from a stroke and still count as pointing at
 * it. Half a pitch, so every point inside the graphic reaches the nearer of the
 * two strokes around it - pointing into a gap still selects a shape.
 */
export const SEGMENT_PICK_TOLERANCE_DP = 2;

/** Points at one segment inside the bars array. */
export type SegmentRef = {
  /** Index into `illustration.bars`. */
  bar: number;
  /** Index into `bar.segments`. */
  segment: number;
};

/** One segment's box in grid units, safe area included, plus its identity. */
export type SegmentBox = {
  ref: SegmentRef;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * A point in the graphic that identifies what to remove.
 *
 * Stored instead of the geometry itself because that is rebuilt from the
 * template whenever a setting changes: after a new threshold there is no stable
 * identity for "that stroke", but the place the user pointed at still means the
 * same thing. Coordinates are grid units including the safe area, the same
 * system the boxes use.
 */
export type SegmentAnchor = {
  x: number;
  y: number;
  /**
   * Remove everything connected to the segment at this point instead of only
   * that one segment. The default is the single segment, because that is the
   * precise operation; whole parts are the shortcut.
   */
  whole?: boolean;
};

/** Every segment's box in grid units, safe area included. */
export function segmentBoxes(
  illustration: BarIllustration,
  paddingOverride?: number,
): SegmentBox[] {
  const pad = effectivePadding(illustration, paddingOverride);
  const boxes: SegmentBox[] = [];

  illustration.bars.forEach((bar, barIndex) => {
    const x =
      pad + barOffsetUnits(bar.x, illustration.system) + (bar.xOffsetUnits ?? 0);
    bar.segments.forEach((segment, segmentIndex) => {
      boxes.push({
        ref: { bar: barIndex, segment: segmentIndex },
        x,
        y: pad + segment.y,
        width: illustration.system.barWidthUnits,
        height: segment.height,
      });
    });
  });

  return boxes;
}

/** Do the two vertical extents share at least one unit? */
function overlaps(
  a: { y: number; height: number },
  b: { y: number; height: number },
): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Groups all segments into connected parts.
 *
 * Returned as a lookup from `"bar:segment"` to a component id plus the members
 * of each component, so a hit test can go from one segment to its whole group in
 * constant time.
 */
export function findComponents(illustration: BarIllustration): {
  /** Component id per segment, keyed by {@link refKey}. */
  idOf: Map<string, number>;
  /** Members of each component, indexed by component id. */
  members: SegmentRef[][];
} {
  const { bars } = illustration;

  // Flat list of all segments, so union-find can work on plain indices.
  const nodes: { ref: SegmentRef; y: number; height: number; x: number }[] = [];
  const nodeAt = new Map<string, number>();

  bars.forEach((bar, barIndex) => {
    bar.segments.forEach((segment, segmentIndex) => {
      const ref = { bar: barIndex, segment: segmentIndex };
      nodeAt.set(refKey(ref), nodes.length);
      nodes.push({ ref, y: segment.y, height: segment.height, x: bar.x });
    });
  });

  const parent = nodes.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    // Path compression, so repeated lookups stay flat.
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk];
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  // Segments within one bar are disjoint by definition, so only neighbouring
  // slots can connect. Bars are looked up by their logical x, not by array
  // order, because the array is not required to be sorted.
  const barsByX = new Map<number, { bar: Bar; index: number }>();
  bars.forEach((bar, index) => barsByX.set(bar.x, { bar, index }));

  bars.forEach((bar, barIndex) => {
    const right = barsByX.get(bar.x + 1);
    if (!right) return;
    bar.segments.forEach((segment, segmentIndex) => {
      const own = nodeAt.get(refKey({ bar: barIndex, segment: segmentIndex }));
      if (own === undefined) return;
      right.bar.segments.forEach((other, otherIndex) => {
        if (!overlaps(segment, other)) return;
        const neighbour = nodeAt.get(
          refKey({ bar: right.index, segment: otherIndex }),
        );
        if (neighbour !== undefined) union(own, neighbour);
      });
    });
  });

  // Renumber roots to dense component ids.
  const idOfRoot = new Map<number, number>();
  const members: SegmentRef[][] = [];
  const idOf = new Map<string, number>();

  nodes.forEach((node, index) => {
    const root = find(index);
    let id = idOfRoot.get(root);
    if (id === undefined) {
      id = members.length;
      idOfRoot.set(root, id);
      members.push([]);
    }
    members[id].push(node.ref);
    idOf.set(refKey(node.ref), id);
  });

  return { idOf, members };
}

export function refKey(ref: SegmentRef): string {
  return `${ref.bar}:${ref.segment}`;
}

/**
 * The segment nearest to a point, within `tolerance` units.
 *
 * A tolerance is needed because the strokes are 2 units wide with 2 units of
 * gap: pointing at a shape usually means pointing between two of its strokes,
 * and demanding a direct hit would make the tool feel broken.
 */
export function segmentNear(
  boxes: SegmentBox[],
  x: number,
  y: number,
  tolerance: number,
): SegmentRef | null {
  let best: SegmentRef | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const box of boxes) {
    // Distance to the box, zero when the point is inside it.
    const dx = Math.max(box.x - x, 0, x - (box.x + box.width));
    const dy = Math.max(box.y - y, 0, y - (box.y + box.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = box.ref;
    }
  }

  return bestDistance <= tolerance ? best : null;
}

/** All segments belonging to the connected part at a point, if any. */
export function componentAt(
  illustration: BarIllustration,
  point: SegmentAnchor,
  tolerance: number,
  paddingOverride?: number,
): SegmentRef[] | null {
  const boxes = segmentBoxes(illustration, paddingOverride);
  const hit = segmentNear(boxes, point.x, point.y, tolerance);
  if (!hit) return null;

  const { idOf, members } = findComponents(illustration);
  const id = idOf.get(refKey(hit));
  return id === undefined ? null : members[id];
}

/**
 * A segment that was taken out, in grid units, plus the anchor responsible.
 *
 * Kept so the preview can show what is missing and let a click put it back. Once
 * removed there is nothing left in the illustration to point at, so the geometry
 * has to be carried out of the removal rather than looked up afterwards.
 */
export type RemovedSegment = {
  /** Index into the anchor list that removed this segment. */
  anchorIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RemovalResult = {
  illustration: BarIllustration;
  removed: RemovedSegment[];
};

/**
 * Removes whatever the anchors point at: one segment each, or the whole
 * connected part when the anchor says so.
 *
 * Applied after the graphic is constructed and before it is validated, so the
 * removal is just another construction step and the result still has to satisfy
 * every rule. Bars left without segments are dropped entirely.
 */
export function removeSegmentsAt(
  illustration: BarIllustration,
  anchors: SegmentAnchor[],
  tolerance: number,
  paddingOverride?: number,
): RemovalResult {
  if (anchors.length === 0) return { illustration, removed: [] };

  const boxes = segmentBoxes(illustration, paddingOverride);
  // Only needed for the "whole part" anchors, so the grouping is not computed
  // when the user only ever erased single strokes.
  const grouping = anchors.some((anchor) => anchor.whole)
    ? findComponents(illustration)
    : null;

  /** Which anchor removed a segment, so a click on it can undo that one anchor. */
  const doomed = new Map<string, number>();

  anchors.forEach((anchor, anchorIndex) => {
    const hit = segmentNear(boxes, anchor.x, anchor.y, tolerance);
    if (!hit) return;

    const claim = (ref: SegmentRef) => {
      const key = refKey(ref);
      if (!doomed.has(key)) doomed.set(key, anchorIndex);
    };

    if (!anchor.whole || !grouping) {
      claim(hit);
      return;
    }

    const id = grouping.idOf.get(refKey(hit));
    if (id === undefined) return;
    for (const ref of grouping.members[id]) claim(ref);
  });

  if (doomed.size === 0) return { illustration, removed: [] };

  // The boxes of what went, so the preview can show it and offer it back. Taken
  // from the geometry before the removal, which is the only place it still exists.
  const removed: RemovedSegment[] = boxes
    .filter((box) => doomed.has(refKey(box.ref)))
    .map((box) => ({
      anchorIndex: doomed.get(refKey(box.ref))!,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    }));

  const bars = illustration.bars
    .map((bar, barIndex) => ({
      ...bar,
      segments: bar.segments.filter(
        (_, segmentIndex) => !doomed.has(refKey({ bar: barIndex, segment: segmentIndex })),
      ),
    }))
    .filter((bar) => bar.segments.length > 0);

  return { illustration: { ...illustration, bars }, removed };
}
