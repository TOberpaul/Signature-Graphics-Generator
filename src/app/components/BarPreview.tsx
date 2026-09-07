"use client";

import { useMemo, useState } from "react";
import {
  canvasSizeUnits,
  effectivePadding,
  renderIllustration,
  renderSampledOverlay,
} from "@/lib/illustration/renderer";
import type { BarIllustration } from "@/lib/illustration/types";
import type { OverlayGeometry } from "@/lib/illustration/result";
import {
  findComponents,
  refKey,
  segmentBoxes,
  segmentNear,
  SEGMENT_PICK_TOLERANCE_DP,
} from "@/lib/illustration/segments";
import type { RemovedSegment, SegmentAnchor } from "@/lib/illustration/segments";
import type { Seam } from "@/lib/illustration/signature";
import { snapSeamHeight } from "@/lib/illustration/signature";
import { MIN_ADDED_HEIGHT } from "@/lib/illustration/strokes";
import type { AddedStroke } from "@/lib/illustration/strokes";
import { pitchUnitsOf, slotCount } from "@/lib/illustration/geometry";

type Props = {
  illustration: BarIllustration;
  unitSize: number;
  /**
   * Zoom, as a multiple of the canvas's natural size at `unitSize`.
   *
   * The graphic is sized from this rather than being clamped to its container, so
   * zooming in genuinely makes it bigger and the surrounding window scrolls. The
   * pointer maths is unaffected: it reads the rendered box, whatever its size.
   */
  scale?: number;
  /** Overrides the safe area from the illustration. Normally left untouched. */
  paddingUnits?: number;
  /** Stroke colour, so the preview matches the export. */
  foreground?: string;
  /** Source photo, aligned with the fitted motif. */
  overlay?: OverlayGeometry | null;
  /** 0 hides the source photo, 1 shows it fully opaque. */
  overlayOpacity?: number;
  /** 0 hides the strokes, 1 shows them fully opaque. */
  strokesOpacity?: number;
  /** 0 hides the dp grid overlay, 1 shows it fully opaque. */
  sampledOpacity?: number;
  /** Hand placed seams, each a row with an optional slot range. */
  seams?: Seam[];
  /**
   * Set while the seam tool is active. The canvas then becomes interactive:
   * pressing empty space starts a seam and dragging sideways limits it to the
   * slots dragged across, while a plain click cuts the full width. Pressing an
   * existing seam picks it up and dragging moves it. Double click removes.
   * Reports the full new list.
   */
  onSeamsChange?: (seams: Seam[]) => void;
  /**
   * Set while the delete tool is active. Hovering highlights the connected part
   * under the pointer, clicking reports the point so the parent can remove it.
   * Mutually exclusive with the seam tool.
   */
  onDeletePart?: (anchor: SegmentAnchor) => void;
  /** Segments removed by hand, shown in place while the delete tool is open. */
  removed?: RemovedSegment[];
  /** Called with the anchor index behind a removal, to take it back. */
  onRestorePart?: (anchorIndex: number) => void;
  /**
   * Called while the delete tool is open and the pointer is on a stroke that was
   * added by hand. Those cannot be removed the usual way - additions are applied
   * after the removals, so a removal anchor has nothing to catch - and a stroke
   * that visibly refuses to be deleted reads as broken. Taking the addition itself
   * back is the honest answer: what is visible can be removed.
   */
  onDeleteAddedStroke?: (index: number) => void;
  /** Strokes drawn by hand, shown as markers while the draw tool is open. */
  addedStrokes?: AddedStroke[];
  /**
   * Set while the draw tool is active. Pressing empty space starts a stroke at
   * that slot and dragging sets its length; pressing an existing one moves it, and
   * pressing either end drags that end. Double click removes. Reports the full new
   * list, like the seam tool. Mutually exclusive with the other two tools.
   */
  onAddedStrokesChange?: (strokes: AddedStroke[]) => void;
};

/** How close, in dp, the pointer has to be to grab an existing seam. */
const SEAM_GRAB_DP = 2;

/**
 * How many dp at each end of an added stroke drag that end instead of moving it.
 *
 * A stroke is at least 4 dp long, so a single dp at each end always leaves a
 * middle to grab - the handles can never take over the whole stroke.
 */
const STROKE_HANDLE_DP = 1;

/**
 * Renders the illustration with the same deterministic renderer that produces
 * the exported file, so preview and export can never drift apart.
 *
 * When an overlay is given, the source template is drawn on top of the graphic
 * at the same box so both can be compared directly. The graphic keeps its own
 * intrinsic size (from the SVG), and the overlay is stretched to that same box,
 * matching how the template was sampled into the canvas.
 */
export function BarPreview({
  illustration,
  unitSize,
  scale = 1,
  paddingUnits,
  foreground,
  overlay,
  overlayOpacity = 0,
  strokesOpacity = 1,
  sampledOpacity = 0,
  seams = [],
  onSeamsChange,
  onDeletePart,
  removed = [],
  onRestorePart,
  addedStrokes = [],
  onAddedStrokesChange,
  onDeleteAddedStroke,
}: Props) {
  const showSource = overlay?.src && overlayOpacity > 0;
  const showSampled = sampledOpacity > 0;
  /** Row under the cursor while the seam tool is open, for the guide line. */
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  /** Slot under the cursor, needed to tell seams sharing a row apart. */
  const [hoverSlot, setHoverSlot] = useState(0);
  /**
   * The gesture in progress on a seam.
   *
   * A seam is addressed by its index in `seams`, not by its row: several seams can
   * share a row, which is the point of limiting them - the same level cut left and
   * right while the centre stays whole.
   *
   * - `draw` while a new seam is being pulled out. `anchorSlot` is where the
   *   pointer went down; moving away from it limits the seam to the slots covered.
   * - `move` shifts the seam, keeping its length. `grabSlot` is the offset the
   *   pointer had inside it, so it does not jump to the cursor.
   * - `from` / `to` drag one end, which is how a seam is lengthened or shortened.
   */
  /**
   * The gesture in progress on a seam.
   *
   * Everything is worked out from `origin` plus the distance travelled since the
   * grab, rather than from the seam's current value. That is what lets Alt be
   * pressed and released mid-drag: the result only depends on where the pointer is
   * now and what the seam looked like at the start, so switching behaviour part way
   * through recomputes cleanly instead of accumulating whatever happened before.
   *
   * While Alt copies, `preview` holds the copy and the seam itself stays at
   * `origin`. Nothing is added to the list until the pointer is released.
   */
  type SeamDrag = {
    index: number;
    mode: "draw" | "move" | "from" | "to" | "height";
    /** The seam as it was when the gesture began. */
    origin: Seam;
    grabRow: number;
    grabSlot: number;
    preview?: Seam;
  };

  const [drag, setDrag] = useState<SeamDrag | null>(null);

  /**
   * The gesture in progress on an added stroke.
   *
   * Like {@link SeamDrag}, everything is derived from `origin` plus how far the
   * pointer has travelled, never from the stroke's current value - so a drag stays
   * stable no matter how often it recomputes.
   *
   * - `draw` while a new stroke is being pulled out of the canvas
   * - `top` / `bottom` drag one end, which is how the length is changed
   * - `move` shifts the whole stroke, keeping its length
   *
   * Alt is read per movement rather than at the press, so it can be taken up or
   * dropped mid-drag: on an end it grows the stroke about its centre, on the body
   * it copies. While it copies, `preview` holds the copy and the stroke itself stays
   * at `origin` - nothing joins the list until the pointer is released.
   */
  type StrokeDrag = {
    index: number;
    mode: "draw" | "top" | "bottom" | "move";
    origin: AddedStroke;
    grabRow: number;
    preview?: AddedStroke;
  };

  const [strokeDrag, setStrokeDrag] = useState<StrokeDrag | null>(null);
  /** Boxes of what a click would remove, while the delete tool is open. */
  const [hoverPart, setHoverPart] = useState<
    { x: number; y: number; width: number; height: number }[] | null
  >(null);
  /** Set while the pointer is held down, so dragging keeps erasing. */
  const [erasing, setErasing] = useState(false);

  // The graphic itself is always transparent; the white ground lives on the
  // wrapper. That way the template (drawn beneath the strokes) shows through the
  // gaps at any opacity, while the canvas never loses its white background.
  const result = useMemo(
    () =>
      renderIllustration(illustration, {
        unitSize,
        paddingUnits,
        foreground,
        background: "none",
      }),
    [illustration, unitSize, paddingUnits, foreground],
  );

  // The raster shares the graphic's canvas exactly, so it can be laid over as a
  // second SVG at the same box with no positioning maths. It shows the dp grid
  // plus the cells the threshold produced, so the difference to the graphic
  // underneath is what the construction rules changed.
  const sampledSvg = useMemo(
    () =>
      showSampled
        ? renderSampledOverlay(illustration, { unitSize, paddingUnits }).svg
        : null,
    [showSampled, illustration, unitSize, paddingUnits],
  );

  // Canvas geometry in dp, so a click can be mapped to a drawable row and a seam
  // can be drawn at the right height. `padding` is the safe area above the
  // drawable area, which is where row 0 starts.
  const geometry = useMemo(() => {
    const { widthUnits, heightUnits } = canvasSizeUnits(illustration, paddingUnits);
    return {
      totalHeight: heightUnits,
      totalWidth: widthUnits,
      padding: effectivePadding(illustration, paddingUnits),
      rows: illustration.canvas.heightUnits,
      pitch: pitchUnitsOf(illustration.system),
      slots: slotCount(illustration.canvas.widthUnits, illustration.system),
    };
  }, [illustration, paddingUnits]);

  // Boxes and grouping of the current geometry, so a hover can go from a point
  // to a whole connected part without walking the bars again on every move.
  const parts = useMemo(() => {
    if (!onDeletePart) return null;
    return {
      boxes: segmentBoxes(illustration, paddingUnits),
      components: findComponents(illustration),
    };
  }, [onDeletePart, illustration, paddingUnits]);

  /** Drawable row under the pointer, or null when outside the drawable area. */
  const rowFromEvent = (event: React.MouseEvent<HTMLDivElement>): number | null => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.height === 0) return null;
    // Fraction of the canvas -> dp from the top -> row inside the drawable area.
    const dp = ((event.clientY - box.top) / box.height) * geometry.totalHeight;
    const row = Math.floor(dp) - geometry.padding;
    return row >= 0 && row < geometry.rows ? row : null;
  };

  /**
   * Stroke slot under the pointer, clamped to the drawable range.
   *
   * Clamped rather than nulled outside the slots: dragging a seam's range past
   * the edge of the motif should extend it to the edge, not abort the gesture.
   */
  const slotFromEvent = (event: React.MouseEvent<HTMLDivElement>): number => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return 0;
    const dp = ((event.clientX - box.left) / box.width) * geometry.totalWidth;
    const slot = Math.floor((dp - geometry.padding) / geometry.pitch);
    return Math.min(Math.max(slot, 0), Math.max(geometry.slots - 1, 0));
  };

  /** Pointer position in grid units, safe area included. */
  const pointFromEvent = (
    event: React.MouseEvent<HTMLDivElement>,
  ): SegmentAnchor | null => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return {
      x: ((event.clientX - box.left) / box.width) * geometry.totalWidth,
      y: ((event.clientY - box.top) / box.height) * geometry.totalHeight,
    };
  };

  /**
   * What would be removed at a point, as boxes ready to be drawn: the single
   * segment under the pointer, or its whole connected part when `whole` is set.
   */
  const targetAt = (point: SegmentAnchor, whole: boolean) => {
    if (!parts) return null;
    const hit = segmentNear(
      parts.boxes,
      point.x,
      point.y,
      SEGMENT_PICK_TOLERANCE_DP,
    );
    if (!hit) return null;

    const wanted = new Set<string>();
    if (whole) {
      const id = parts.components.idOf.get(refKey(hit));
      if (id === undefined) return null;
      for (const ref of parts.components.members[id]) wanted.add(refKey(ref));
    } else {
      wanted.add(refKey(hit));
    }

    return parts.boxes
      .filter((box) => wanted.has(refKey(box.ref)))
      .map(({ x, y, width, height }) => ({ x, y, width, height }));
  };

  /** The removal marker under a point, if any. */
  const removalAt = (point: SegmentAnchor): RemovedSegment | undefined =>
    removed.find(
      (box) =>
        point.x >= box.x &&
        point.x <= box.x + box.width &&
        point.y >= box.y &&
        point.y <= box.y + box.height,
    );

  /**
   * Erases at a point, or puts back what was removed there.
   *
   * Restoring is only offered on a deliberate press, not while wiping: dragging
   * across a removal is meant to keep erasing, not to undo on the way past.
   */
  const eraseAt = (event: React.MouseEvent<HTMLDivElement>, allowRestore: boolean) => {
    if (!onDeletePart) return;
    const point = pointFromEvent(event);
    if (!point) return;

    // A stroke added by hand is checked first, because it is the one thing here
    // that is really there: it cannot be removed by an anchor, so it is taken out
    // of the additions instead. Also runs while wiping, so dragging across a mix of
    // added and generated strokes clears both.
    if (onDeleteAddedStroke) {
      const row = rowFromEvent(event);
      if (row !== null) {
        const added = strokeIndexAt(row, slotFromEvent(event));
        if (added >= 0) {
          onDeleteAddedStroke(added);
          setHoverPart(null);
          return;
        }
      }
    }

    // Checked before erasing, because the gap a removal left is empty and the
    // nearest stroke would be taken instead - deleting something else on a click
    // that was meant to bring one back.
    if (allowRestore) {
      const undo = removalAt(point);
      if (undo) {
        onRestorePart?.(undo.anchorIndex);
        setHoverPart(null);
        return;
      }
    }

    const whole = event.shiftKey;
    if (!targetAt(point, whole)) return;
    onDeletePart(whole ? { ...point, whole: true } : point);
    setHoverPart(null);
  };

  // Press erases straight away and starts wiping, so a whole row of strokes can
  // be taken out in one gesture instead of one click each.
  const handleEraseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    setErasing(true);
    eraseAt(event, true);
  };

  const handleEraseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (erasing) {
      eraseAt(event, false);
      return;
    }

    // On an added stroke only that stroke is at stake, so only that box is marked.
    // Falling through to the generated geometry would highlight the whole merged
    // segment and promise far more than the click removes.
    if (onDeleteAddedStroke) {
      const row = rowFromEvent(event);
      const added = row === null ? -1 : strokeIndexAt(row, slotFromEvent(event));
      if (added >= 0) {
        setHoverPart([addedStrokeBox(addedStrokes[added])]);
        return;
      }
    }

    const point = pointFromEvent(event);
    // Over a removal the highlight would suggest something is about to be deleted,
    // when a click puts it back instead. The red marker already shows the target.
    setHoverPart(
      point && !removalAt(point) ? targetAt(point, event.shiftKey) : null,
    );
  };

  const lastSlot = Math.max(geometry.slots - 1, 0);

  /** The seam's range as concrete slots, resolving an open range to the edges. */
  const seamRange = (seam: Seam): { from: number; to: number } => ({
    from: seam.from ?? 0,
    to: seam.to ?? lastSlot,
  });

  /** Height of the cut in rows. */
  const seamHeight = (seam: Seam): number => Math.max(1, Math.round(seam.height ?? 1));

  /**
   * Rebuilds a seam with a new row and slot range, keeping everything else.
   *
   * The range is dropped when it spans the full width, so there is one
   * representation for "cuts everything" instead of two that behave the same.
   * `height` is carried over deliberately: reshaping and moving must not silently
   * reset the height of the cut.
   */
  const seamWithRange = (seam: Seam, row: number, from: number, to: number): Seam => {
    const left = Math.min(Math.max(from, 0), lastSlot);
    const right = Math.min(Math.max(to, 0), lastSlot);
    const spansAll = left <= 0 && right >= lastSlot;

    return {
      row,
      ...(seam.height !== undefined ? { height: seam.height } : {}),
      ...(spansAll ? {} : { from: left, to: right }),
    };
  };

  /** Does the seam cover this slot? An open range covers everything. */
  const seamCovers = (seam: Seam, slot: number): boolean => {
    const { from, to } = seamRange(seam);
    return slot >= from && slot <= to;
  };

  /** Is the row within grabbing distance of the seam, top or bottom? */
  const seamNearRow = (seam: Seam, row: number): boolean =>
    row >= seam.row - SEAM_GRAB_DP &&
    row <= seam.row + seamHeight(seam) - 1 + SEAM_GRAB_DP;

  /**
   * Index of the seam under the pointer, or -1.
   *
   * The slot decides between seams sharing a row, so grabbing the left hand cut
   * of a pair picks that one and not its counterpart on the right.
   */
  const seamIndexAt = (row: number, slot: number): number => {
    const covering = seams
      .map((seam, index) => ({ seam, index }))
      .filter(({ seam }) => seamNearRow(seam, row))
      .find(({ seam }) => seamCovers(seam, slot));

    return covering ? covering.index : -1;
  };

  /**
   * Which part of a seam the pointer is on.
   *
   * `from` / `to` are the side handles that lengthen and shorten it, `height` is
   * the bottom edge that makes the cut taller. A seam only offers the side handles
   * once it is wide enough to still have a middle to grab, otherwise it could no
   * longer be moved at all.
   */
  const seamGrip = (
    seam: Seam,
    slot: number,
    row: number,
  ): "from" | "to" | "height" | "move" => {
    // Below the cut is the height handle, on it and above is everything else. The
    // zones do not overlap, so a gesture is either about the position or about the
    // size - never both at once.
    const bottom = seam.row + seamHeight(seam) - 1;
    if (row > bottom) return "height";

    const { from, to } = seamRange(seam);
    if (to - from >= 2) {
      if (slot <= from) return "from";
      if (slot >= to) return "to";
    }
    return "move";
  };

  // Pressing an existing seam picks it up; pressing empty space starts a new one
  // and picks it up straight away, so row and range are set in one gesture.
  const handleDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeamsChange) return;
    const row = rowFromEvent(event);
    if (row === null) return;
    const slot = slotFromEvent(event);

    const existing = seamIndexAt(row, slot);
    if (existing >= 0) {
      // Which handle was grabbed decides what Alt will mean: copying on the body,
      // resizing about the centre on an end. Whether Alt is held is not read here -
      // that is decided per movement, so it can be taken up or dropped mid-drag.
      setDrag({
        index: existing,
        mode: seamGrip(seams[existing], slot, row),
        origin: { ...seams[existing] },
        grabRow: row,
        grabSlot: slot,
      });
      return;
    }

    // Starts as a full width seam. Dragging sideways narrows it down; releasing
    // without moving leaves it as it is, which keeps a plain click the shortest
    // path to the common case. Appended, so the index stays put while dragging.
    const fresh: Seam = { row };
    onSeamsChange([...seams, fresh]);
    setDrag({
      index: seams.length,
      mode: "draw",
      origin: fresh,
      grabRow: row,
      grabSlot: slot,
    });
  };

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeamsChange) return;
    const row = rowFromEvent(event);
    const slot = slotFromEvent(event);
    setHoverRow(row);
    setHoverSlot(slot);

    if (!drag || row === null) return;
    if (!seams[drag.index]) return;

    const replace = (seam: Seam) =>
      onSeamsChange(seams.map((item, index) => (index === drag.index ? seam : item)));

    const { origin } = drag;
    const { from, to } = seamRange(origin);

    if (drag.mode === "draw") {
      // Sideways movement defines the range. One slot of travel counts as intent,
      // so a click that wobbles by a pixel still cuts the full width.
      const spans = Math.abs(slot - drag.grabSlot) >= 1;
      replace(
        spans
          ? seamWithRange(
              origin,
              row,
              Math.min(drag.grabSlot, slot),
              Math.max(drag.grabSlot, slot),
            )
          : { row },
      );
      return;
    }

    if (drag.mode === "height") {
      // Only the height changes, the row stays put. Snapped to the legal gaps, so
      // dragging cannot produce a 2 to 3 dp cut - the sizes the construction rules
      // would treat as a mistake anyway.
      const height = snapSeamHeight(row - origin.row + 1);
      replace(height === 1 ? { ...origin, height: undefined } : { ...origin, height });
      return;
    }

    if (drag.mode === "from" || drag.mode === "to") {
      // Only the range changes, the row stays where it is. Alt mirrors the change
      // onto the other end - resizing about the centre - and the centre comes from
      // the original, so it does not drift as the range changes.
      const fixed = drag.mode === "from" ? to : from;

      if (event.altKey) {
        const centre = (from + to) / 2;
        const reach = Math.abs(slot - centre);
        replace(
          seamWithRange(
            origin,
            origin.row,
            Math.round(centre - reach),
            Math.round(centre + reach),
          ),
        );
        return;
      }

      // Dragging one end past the other flips them, so the seam cannot invert.
      replace(
        seamWithRange(origin, origin.row, Math.min(slot, fixed), Math.max(slot, fixed)),
      );
      return;
    }

    // Move: the whole seam travels, keeping its length and height. Computed from the
    // start of the gesture, so releasing Alt puts everything back exactly.
    const limited = origin.from !== undefined || origin.to !== undefined;
    const targetRow = origin.row + (row - drag.grabRow);
    let target: Seam;

    if (!limited) {
      target = { ...origin, row: Math.min(Math.max(targetRow, 0), geometry.rows - 1) };
    } else {
      const width = to - from;
      // Clamped rather than truncated, so pushing a seam against an edge slides it
      // there instead of shortening it.
      const start = Math.min(Math.max(from + (slot - drag.grabSlot), 0), lastSlot - width);
      target = seamWithRange(
        origin,
        Math.min(Math.max(targetRow, 0), geometry.rows - 1),
        start,
        start + width,
      );
    }

    // Alt copies: the seam stays where it started and the copy follows the pointer.
    // Checked here rather than at the press, so it can be taken up or dropped in the
    // middle of a drag the way a drawing tool allows.
    if (event.altKey) {
      replace(origin);
      setDrag({ ...drag, preview: target });
      return;
    }

    replace(target);
    if (drag.preview) setDrag({ ...drag, preview: undefined });
  };

  const endDrag = () => setDrag(null);

  /**
   * Releasing commits the copy.
   *
   * A copy dropped where it started is an exact duplicate of the original, and
   * those are folded together upstream - so an Alt-click without dragging needs no
   * special case here and simply changes nothing.
   */
  const handleUp = () => {
    if (drag?.preview && onSeamsChange) {
      onSeamsChange([...seams, drag.preview]);
    }
    endDrag();
  };

  /* ---------------------------------------------------------------------- */
  /* Draw tool: strokes added by hand                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Which part of an added stroke the pointer is on.
   *
   * `top` and `bottom` are the ends that change the length, the rest moves the
   * whole stroke. A stroke is never shorter than 4 dp, so there is always a middle
   * left between the two handles.
   */
  const strokeGrip = (stroke: AddedStroke, row: number): "top" | "bottom" | "move" => {
    const last = stroke.row + stroke.height - 1;
    if (row <= stroke.row + STROKE_HANDLE_DP - 1) return "top";
    if (row >= last - (STROKE_HANDLE_DP - 1)) return "bottom";
    return "move";
  };

  /** Index of the added stroke under the pointer, or -1. */
  const strokeIndexAt = (row: number, slot: number): number =>
    addedStrokes.findIndex(
      (stroke) =>
        stroke.slot === slot &&
        row >= stroke.row &&
        row <= stroke.row + stroke.height - 1,
    );

  /**
   * A stroke from two rows, whichever way round they were dragged.
   *
   * Kept at the minimum length rather than refusing to go below it, so dragging
   * back past the start shortens the stroke to 4 dp instead of aborting.
   */
  const strokeBetween = (slot: number, a: number, b: number): AddedStroke => {
    const top = Math.min(a, b);
    const height = Math.max(Math.abs(b - a) + 1, MIN_ADDED_HEIGHT);
    const row = Math.min(Math.max(top, 0), Math.max(geometry.rows - height, 0));
    return { slot, row, height: Math.min(height, geometry.rows) };
  };

  const handleDrawDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onAddedStrokesChange) return;
    const row = rowFromEvent(event);
    if (row === null) return;
    const slot = slotFromEvent(event);

    const existing = strokeIndexAt(row, slot);
    if (existing >= 0) {
      setStrokeDrag({
        index: existing,
        mode: strokeGrip(addedStrokes[existing], row),
        origin: { ...addedStrokes[existing] },
        grabRow: row,
      });
      return;
    }

    // A fresh stroke starts at the minimum length, so a plain click already places
    // something legal. Dragging from there sets the real length.
    const fresh = strokeBetween(slot, row, row);
    onAddedStrokesChange([...addedStrokes, fresh]);
    setStrokeDrag({
      index: addedStrokes.length,
      mode: "draw",
      origin: fresh,
      grabRow: row,
    });
  };

  const handleDrawMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onAddedStrokesChange) return;
    const row = rowFromEvent(event);
    const slot = slotFromEvent(event);
    setHoverRow(row);
    setHoverSlot(slot);

    if (!strokeDrag || row === null) return;
    const current = addedStrokes[strokeDrag.index];
    if (!current) return;

    const replace = (stroke: AddedStroke) =>
      onAddedStrokesChange(
        addedStrokes.map((item, index) =>
          index === strokeDrag.index ? stroke : item,
        ),
      );

    const { origin } = strokeDrag;

    if (strokeDrag.mode === "draw") {
      // The slot follows the pointer too, so a stroke started in the wrong column
      // can be corrected without letting go.
      replace(strokeBetween(slot, strokeDrag.grabRow, row));
      return;
    }

    if (strokeDrag.mode === "top" || strokeDrag.mode === "bottom") {
      const top = origin.row;
      const bottom = origin.row + origin.height - 1;

      // Alt grows the stroke about its centre, mirroring the movement onto the
      // other end. The centre comes from the original, so it does not drift as the
      // length changes.
      if (event.altKey) {
        const centre = (top + bottom) / 2;
        const reach = Math.abs(row - centre);
        replace(
          strokeBetween(
            origin.slot,
            Math.round(centre - reach),
            Math.round(centre + reach),
          ),
        );
        return;
      }

      // Otherwise the opposite end stays put and the grabbed one follows the
      // pointer. Dragging past the other end shortens to the minimum instead of
      // flipping, which `strokeBetween` takes care of.
      replace(
        strokeBetween(origin.slot, strokeDrag.mode === "top" ? bottom : top, row),
      );
      return;
    }

    // Move: the stroke keeps its length and travels with the pointer, in both
    // directions. Computed from the start of the gesture so it cannot drift.
    const targetRow = Math.min(
      Math.max(origin.row + (row - strokeDrag.grabRow), 0),
      Math.max(geometry.rows - origin.height, 0),
    );
    const target: AddedStroke = { ...origin, slot, row: targetRow };

    // Alt copies: the stroke stays where it started and the copy follows the
    // pointer. Nothing is committed until the button is released.
    if (event.altKey) {
      replace(origin);
      setStrokeDrag({ ...strokeDrag, preview: target });
      return;
    }

    replace(target);
    if (strokeDrag.preview) setStrokeDrag({ ...strokeDrag, preview: undefined });
  };

  /**
   * Releasing commits the copy.
   *
   * A copy dropped where it started is an exact duplicate, and those are folded
   * together upstream - so an Alt-click without dragging needs no special case and
   * simply changes nothing.
   */
  const handleDrawUp = () => {
    if (strokeDrag?.preview && onAddedStrokesChange) {
      onAddedStrokesChange([...addedStrokes, strokeDrag.preview]);
    }
    setStrokeDrag(null);
  };

  // Double click removes, the same deliberate gesture the seam tool uses.
  const handleDrawDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onAddedStrokesChange) return;
    const row = rowFromEvent(event);
    if (row === null) return;
    const existing = strokeIndexAt(row, slotFromEvent(event));
    if (existing < 0) return;
    onAddedStrokesChange(addedStrokes.filter((_, index) => index !== existing));
    setStrokeDrag(null);
  };

  /** An added stroke's box in grid units, safe area included - like a segment box. */
  const addedStrokeBox = (stroke: AddedStroke) => ({
    x: geometry.padding + stroke.slot * geometry.pitch,
    y: geometry.padding + stroke.row,
    width: illustration.system.barWidthUnits,
    height: stroke.height,
  });

  /** Where an added stroke sits on the canvas, as fractions of it. */
  const addedStrokeStyle = (stroke: AddedStroke): React.CSSProperties => {
    const box = addedStrokeBox(stroke);
    return {
      insetInlineStart: `${(box.x / geometry.totalWidth) * 100}%`,
      inlineSize: `${(box.width / geometry.totalWidth) * 100}%`,
      insetBlockStart: `${(box.y / geometry.totalHeight) * 100}%`,
      blockSize: `${(box.height / geometry.totalHeight) * 100}%`,
    };
  };

  /** The added stroke under the cursor, for the cursor shape and the guide. */
  const hoverStroke =
    onAddedStrokesChange && hoverRow !== null
      ? addedStrokes[strokeIndexAt(hoverRow, hoverSlot)]
      : undefined;

  /**
   * Where a seam sits on the canvas, as fractions of it.
   *
   * A limited seam is drawn only over the slots it cuts, so its reach is visible
   * without having to read it off the strokes.
   */
  const seamStyle = (seam: Seam): React.CSSProperties => {
    const { from, to } = seamRange(seam);
    const limited = seam.from !== undefined || seam.to !== undefined;
    const start = limited
      ? (geometry.padding + from * geometry.pitch) / geometry.totalWidth
      : 0;
    const width = limited
      ? ((to - from + 1) * geometry.pitch - illustration.system.gapUnits) /
        geometry.totalWidth
      : 1;

    return {
      insetBlockStart: `${((geometry.padding + seam.row) / geometry.totalHeight) * 100}%`,
      blockSize: `${(seamHeight(seam) / geometry.totalHeight) * 100}%`,
      insetInlineStart: `${start * 100}%`,
      inlineSize: `${width * 100}%`,
    };
  };

  /** The seam under the cursor, for the cursor shape and the placement guide. */
  const hoverSeam =
    onSeamsChange && hoverRow !== null
      ? seams[seamIndexAt(hoverRow, hoverSlot)]
      : undefined;

  /** Which handle of that seam the cursor is over. */
  const hoverGrip =
    hoverSeam && hoverRow !== null
      ? seamGrip(hoverSeam, hoverSlot, hoverRow)
      : undefined;

  // Double click removes: a deliberate gesture, so a single click can be used for
  // placing and dragging without ever destroying a seam by accident.
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeamsChange) return;
    const row = rowFromEvent(event);
    if (row === null) return;
    const existing = seamIndexAt(row, slotFromEvent(event));
    if (existing < 0) return;
    onSeamsChange(seams.filter((_, index) => index !== existing));
    endDrag();
  };

  // The overlay box is expressed as fractions of the full canvas, so it lines up
  // with the fitted motif at whatever scale the stage renders the SVG at. The
  // graphic sizes the wrapper via the grid, and every overlay shares that single
  // grid cell, so they always cover exactly the graphic - no matter whether the
  // stage constrains it by width or by height.
  // The SVG is generated locally from validated integer data only.
  return (
    <div
      className="bar-preview"
      data-seam-tool={
        onSeamsChange
          ? drag
            ? drag.mode === "from" || drag.mode === "to"
              ? "resize"
              : drag.mode === "height"
                ? "resize-height"
                : "dragging"
            : hoverSeam && hoverRow !== null
              ? // The handles read as resizable, so it is discoverable that a seam
                // can be reshaped rather than only moved.
                hoverGrip === "move"
                ? "grab"
                : hoverGrip === "height"
                  ? "resize-height"
                  : "resize"
              : "true"
          : undefined
      }
      data-delete-tool={
        onDeletePart ? (hoverPart ? "target" : "true") : undefined
      }
      data-draw-tool={
        onAddedStrokesChange
          ? strokeDrag
            ? strokeDrag.mode === "move"
              ? "dragging"
              : "resize-height"
            : hoverStroke && hoverRow !== null
              ? strokeGrip(hoverStroke, hoverRow) === "move"
                ? "grab"
                : "resize-height"
              : "true"
          : undefined
      }
      style={{
        aspectRatio: `${result.width} / ${result.height}`,
        inlineSize: `${result.width * scale}px`,
      }}
      onMouseDown={
        onSeamsChange
          ? handleDown
          : onDeletePart
            ? handleEraseDown
            : onAddedStrokesChange
              ? handleDrawDown
              : undefined
      }
      onMouseMove={
        onSeamsChange
          ? handleMove
          : onDeletePart
            ? handleEraseMove
            : onAddedStrokesChange
              ? handleDrawMove
              : undefined
      }
      onMouseUp={
        onSeamsChange
          ? handleUp
          : onDeletePart
            ? () => setErasing(false)
            : onAddedStrokesChange
              ? handleDrawUp
              : undefined
      }
      onDoubleClick={
        onSeamsChange
          ? handleDoubleClick
          : onAddedStrokesChange
            ? handleDrawDoubleClick
            : undefined
      }
      onMouseLeave={
        onSeamsChange
          ? () => {
              setHoverRow(null);
              endDrag();
            }
          : onDeletePart
            ? () => {
                setHoverPart(null);
                setErasing(false);
              }
            : onAddedStrokesChange
              ? () => {
                  setHoverRow(null);
                  setStrokeDrag(null);
                }
              : undefined
      }
    >
      {/* Layer order bottom to top: source photo, then the strokes over it, then
          the dp grid on top. So the template shows through beneath the graphic. */}
      {showSource ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="bar-preview-overlay"
          src={overlay.src}
          alt=""
          aria-hidden="true"
          style={{
            opacity: overlayOpacity,
            insetInlineStart: `${overlay.sourceBox.left * 100}%`,
            insetBlockStart: `${overlay.sourceBox.top * 100}%`,
            inlineSize: `${overlay.sourceBox.width * 100}%`,
            blockSize: `${overlay.sourceBox.height * 100}%`,
          }}
        />
      ) : null}
      <div
        className="bar-preview-graphic"
        style={{ opacity: strokesOpacity }}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
      {sampledSvg ? (
        <div
          className="bar-preview-sampled"
          style={{ opacity: sampledOpacity }}
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: sampledSvg }}
        />
      ) : null}
      {/* Markers for the hand placed seams, on top so they stay findable while
          the tool is open. Only shown with the tool active - the seam itself is
          already visible in the graphic. */}
      {onSeamsChange
        ? seams.map((seam, index) => (
            <div
              key={index}
              className="bar-preview-seam"
              aria-hidden="true"
              style={seamStyle(seam)}
            />
          ))
        : null}
      {/* The copy while it is being placed: same width, drawn faint so the original
          underneath stays readable and it is clear this one is not committed yet. */}
      {drag?.preview ? (
        <div
          className="bar-preview-seam bar-preview-seam-copy"
          aria-hidden="true"
          style={seamStyle(drag.preview)}
        />
      ) : null}
      {/* What was taken out, shown where it used to be. Otherwise a removal is only
          visible as absence, and there is nothing left to click to undo it. */}
      {onDeletePart
        ? removed.map((box, index) => (
            <div
              key={index}
              className="bar-preview-removed"
              aria-hidden="true"
              style={{
                insetInlineStart: `${(box.x / geometry.totalWidth) * 100}%`,
                insetBlockStart: `${(box.y / geometry.totalHeight) * 100}%`,
                inlineSize: `${(box.width / geometry.totalWidth) * 100}%`,
                blockSize: `${(box.height / geometry.totalHeight) * 100}%`,
              }}
            />
          ))
        : null}
      {/* What a click would remove, drawn stroke by stroke over the graphic so
          the extent of the connected part is unambiguous before committing. */}
      {hoverPart?.map((box, index) => (
        <div
          key={index}
          className="bar-preview-part"
          aria-hidden="true"
          style={{
            insetInlineStart: `${(box.x / geometry.totalWidth) * 100}%`,
            insetBlockStart: `${(box.y / geometry.totalHeight) * 100}%`,
            inlineSize: `${(box.width / geometry.totalWidth) * 100}%`,
            blockSize: `${(box.height / geometry.totalHeight) * 100}%`,
          }}
        />
      ))}
      {/* The strokes drawn by hand, marked while the draw tool is open so they can
          be told apart from the ones the template produced. They are already part
          of the graphic underneath - this only makes them findable. */}
      {onAddedStrokesChange
        ? addedStrokes.map((stroke, index) => (
            <div
              key={index}
              className="bar-preview-added"
              aria-hidden="true"
              style={addedStrokeStyle(stroke)}
            />
          ))
        : null}
      {/* The copy while it is being placed: drawn faint so the original underneath
          stays readable and it is clear this one is not committed yet. */}
      {strokeDrag?.preview ? (
        <div
          className="bar-preview-added bar-preview-added-copy"
          aria-hidden="true"
          style={addedStrokeStyle(strokeDrag.preview)}
        />
      ) : null}
      {/* Where a click would put a stroke: the slot and the minimum length, so the
          size and the column are both clear before committing. Hidden over an
          existing one, which already shows its own marker. */}
      {onAddedStrokesChange && !strokeDrag && hoverRow !== null && !hoverStroke ? (
        <div
          className="bar-preview-added bar-preview-added-guide"
          aria-hidden="true"
          style={addedStrokeStyle(
            strokeBetween(hoverSlot, hoverRow, hoverRow + MIN_ADDED_HEIGHT - 1),
          )}
        />
      ) : null}
      {/* The guide only shows on empty rows, so it never doubles a placed seam. */}
      {onSeamsChange && !drag && hoverRow !== null && !hoverSeam ? (
        <div
          className="bar-preview-seam-guide"
          aria-hidden="true"
          style={{
            insetBlockStart: `${((geometry.padding + hoverRow) / geometry.totalHeight) * 100}%`,
            blockSize: `${(1 / geometry.totalHeight) * 100}%`,
          }}
        />
      ) : null}
    </div>
  );
}

/** Shared helper so the export uses exactly the previewed options. */
export function buildSvg(
  illustration: BarIllustration,
  unitSize: number,
  paddingUnits: number,
): string {
  return renderIllustration(illustration, { unitSize, paddingUnits }).svg;
}
