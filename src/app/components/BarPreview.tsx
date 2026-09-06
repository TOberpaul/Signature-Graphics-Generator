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
import { pitchUnitsOf, slotCount } from "@/lib/illustration/geometry";

type Props = {
  illustration: BarIllustration;
  unitSize: number;
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
};

/** How close, in dp, the pointer has to be to grab an existing seam. */
const SEAM_GRAB_DP = 2;

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
  type SeamDrag =
    | { index: number; mode: "draw"; anchorSlot: number }
    | { index: number; mode: "move"; grabSlot: number }
    | { index: number; mode: "from" }
    | { index: number; mode: "to" }
    /** Dragging the bottom edge, which makes the cut taller. */
    | { index: number; mode: "height" }
    /**
     * Alt-dragging a copy. The original is left untouched and nothing is added to
     * the list until the pointer is released - until then `preview` is drawn as a
     * faint seam at the cursor, so the copy can be placed instead of appearing
     * somewhere first and having to be moved from there.
     */
    | { mode: "copy"; grabSlot: number; preview: Seam };

  const [drag, setDrag] = useState<SeamDrag | null>(null);
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
      const grip = seamGrip(seams[existing], slot, row);

      // Alt (Option) duplicates instead of moving, the usual gesture in drawing
      // tools. The original stays where it is and the copy follows the pointer,
      // keeping the range - a limited seam is tedious to draw twice by hand.
      //
      // Only on the body: on an end handle Alt means resizing symmetrically, which
      // is the other half of the same convention.
      if (event.altKey && grip === "move") {
        setDrag({ mode: "copy", grabSlot: slot, preview: { ...seams[existing] } });
        return;
      }
      setDrag(
        grip === "move"
          ? { index: existing, mode: "move", grabSlot: slot }
          : { index: existing, mode: grip },
      );
      return;
    }

    // Starts as a full width seam. Dragging sideways narrows it down; releasing
    // without moving leaves it as it is, which keeps a plain click the shortest
    // path to the common case. Appended, so the index stays put while dragging.
    onSeamsChange([...seams, { row }]);
    setDrag({ index: seams.length, mode: "draw", anchorSlot: slot });
  };

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeamsChange) return;
    const row = rowFromEvent(event);
    const slot = slotFromEvent(event);
    setHoverRow(row);
    setHoverSlot(slot);

    if (!drag || row === null) return;

    // The copy only exists as a preview until the pointer is released, so this
    // moves local state and leaves the seam list alone.
    if (drag.mode === "copy") {
      const { from, to } = seamRange(drag.preview);
      const limited = drag.preview.from !== undefined || drag.preview.to !== undefined;
      if (!limited) {
        setDrag({ ...drag, preview: { row } });
        return;
      }

      const width = to - from;
      const shift = slot - drag.grabSlot;
      const start = Math.min(Math.max(from + shift, 0), lastSlot - width);
      setDrag({
        ...drag,
        grabSlot: slot,
        preview: seamWithRange(drag.preview, row, start, start + width),
      });
      return;
    }

    const dragged = seams[drag.index];
    if (!dragged) return;

    const replace = (seam: Seam) =>
      onSeamsChange(seams.map((item, index) => (index === drag.index ? seam : item)));

    if (drag.mode === "draw") {
      // Sideways movement defines the range. One slot of travel counts as intent,
      // so a click that wobbles by a pixel still cuts the full width.
      const spans = Math.abs(slot - drag.anchorSlot) >= 1;
      replace(
        spans
          ? seamWithRange(
              dragged,
              row,
              Math.min(drag.anchorSlot, slot),
              Math.max(drag.anchorSlot, slot),
            )
          : { row },
      );
      return;
    }

    if (drag.mode === "height") {
      // Only the height changes here, the row stays put. Snapped to the legal gaps,
      // so dragging cannot produce a 2 to 3 dp cut - the sizes the construction
      // rules would treat as a mistake anyway.
      const height = snapSeamHeight(row - dragged.row + 1);
      if (height === seamHeight(dragged)) return;
      replace(
        height === 1
          ? { ...dragged, height: undefined }
          : { ...dragged, height },
      );
      return;
    }

    const { from, to } = seamRange(dragged);

    if (drag.mode === "from" || drag.mode === "to") {
      // Only the range changes here, the row stays where it is. Alt mirrors the
      // change onto the other end, the usual shortcut for resizing about the
      // centre; the two ends then move by the same amount in opposite directions.
      const fixed = drag.mode === "from" ? to : from;
      const moving = slot;

      if (event.altKey) {
        const centre = (from + to) / 2;
        const reach = Math.abs(moving - centre);
        replace(
          seamWithRange(
            dragged,
            dragged.row,
            Math.round(centre - reach),
            Math.round(centre + reach),
          ),
        );
        return;
      }

      // Dragging one end past the other flips them, so the seam cannot invert.
      replace(
        seamWithRange(
          dragged,
          dragged.row,
          Math.min(moving, fixed),
          Math.max(moving, fixed),
        ),
      );
      return;
    }

    // Move: the row follows the pointer and the range travels with it, keeping its
    // length and height. Shifting is clamped rather than truncated, so pushing a
    // seam against an edge slides it there instead of shortening it.
    const limited = dragged.from !== undefined || dragged.to !== undefined;
    if (!limited) {
      if (row === dragged.row) return;
      replace({ ...dragged, row });
      return;
    }

    const width = to - from;
    const shift = slot - drag.grabSlot;
    const start = Math.min(Math.max(from + shift, 0), lastSlot - width);
    if (row === dragged.row && start === from) return;

    replace(seamWithRange(dragged, row, start, start + width));
    setDrag({ ...drag, grabSlot: slot });
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
    if (drag?.mode === "copy" && onSeamsChange) {
      onSeamsChange([...seams, drag.preview]);
    }
    endDrag();
  };

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
      style={{ aspectRatio: `${result.width} / ${result.height}` }}
      onMouseDown={
        onSeamsChange ? handleDown : onDeletePart ? handleEraseDown : undefined
      }
      onMouseMove={
        onSeamsChange ? handleMove : onDeletePart ? handleEraseMove : undefined
      }
      onMouseUp={
        onSeamsChange ? handleUp : onDeletePart ? () => setErasing(false) : undefined
      }
      onDoubleClick={onSeamsChange ? handleDoubleClick : undefined}
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
      {drag?.mode === "copy" ? (
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
