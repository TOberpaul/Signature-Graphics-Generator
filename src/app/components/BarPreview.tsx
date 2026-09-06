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
import type { SegmentAnchor } from "@/lib/illustration/segments";
import type { Seam } from "@/lib/illustration/signature";
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
}: Props) {
  const showSource = overlay?.src && overlayOpacity > 0;
  const showSampled = sampledOpacity > 0;
  /** Row under the cursor while the seam tool is open, for the guide line. */
  const [hoverRow, setHoverRow] = useState<number | null>(null);
  /** Slot under the cursor, needed to tell seams sharing a row apart. */
  const [hoverSlot, setHoverSlot] = useState(0);
  /**
   * The seam currently being dragged, by its index in `seams`.
   *
   * Not by row: several seams can share a row, which is the point of limiting
   * them - the same level cut left and right while the centre stays whole.
   */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  /**
   * Slot the pointer went down on while drawing a new seam. Dragging away from it
   * limits the seam to the slots covered; releasing without moving sideways
   * leaves it spanning the full width.
   */
  const [drawFromSlot, setDrawFromSlot] = useState<number | null>(null);
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

  /** Erases at a point, if there is anything there. */
  const eraseAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onDeletePart) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const whole = event.shiftKey;
    if (!targetAt(point, whole)) return;
    onDeletePart(whole ? { ...point, whole: true } : point);
    setHoverPart(null);
  };

  // Press erases straight away and starts wiping, so a whole row of strokes can
  // be taken out in one gesture instead of one click each.
  const handleEraseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    setErasing(true);
    eraseAt(event);
  };

  const handleEraseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (erasing) {
      eraseAt(event);
      return;
    }
    const point = pointFromEvent(event);
    setHoverPart(point ? targetAt(point, event.shiftKey) : null);
  };

  /** Does the seam cover this slot? An open range covers everything. */
  const seamCovers = (seam: Seam, slot: number): boolean =>
    slot >= (seam.from ?? Number.NEGATIVE_INFINITY) &&
    slot <= (seam.to ?? Number.POSITIVE_INFINITY);

  /**
   * Index of the seam under the pointer, or -1.
   *
   * The slot decides between seams sharing a row, so grabbing the left hand cut
   * of a pair picks that one and not its counterpart on the right.
   */
  const seamIndexAt = (row: number, slot: number): number => {
    const onRow = seams
      .map((seam, index) => ({ seam, index }))
      .filter(({ seam }) => Math.abs(seam.row - row) <= SEAM_GRAB_DP);

    const covering = onRow.find(({ seam }) => seamCovers(seam, slot));
    return covering ? covering.index : -1;
  };

  // Pressing an existing seam picks it up; pressing empty space starts a new one
  // and picks it up straight away, so row and range are set in one gesture.
  const handleDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeamsChange) return;
    const row = rowFromEvent(event);
    if (row === null) return;

    const existing = seamIndexAt(row, slotFromEvent(event));
    if (existing >= 0) {
      setDragIndex(existing);
      return;
    }

    // Starts as a full width seam. Dragging sideways narrows it down; releasing
    // without moving leaves it as it is, which keeps a plain click the shortest
    // path to the common case. Appended, so the index stays put while dragging.
    onSeamsChange([...seams, { row }]);
    setDragIndex(seams.length);
    setDrawFromSlot(slotFromEvent(event));
  };

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeamsChange) return;
    const row = rowFromEvent(event);
    setHoverRow(row);
    setHoverSlot(slotFromEvent(event));

    if (dragIndex === null || row === null) return;
    const dragged = seams[dragIndex];
    if (!dragged) return;

    const replace = (seam: Seam) =>
      onSeamsChange(seams.map((item, index) => (index === dragIndex ? seam : item)));

    // While drawing a new seam, sideways movement defines the slot range. One
    // slot of travel is treated as intent, so a click that wobbles by a pixel
    // still cuts the full width.
    if (drawFromSlot !== null) {
      const slot = slotFromEvent(event);
      const spans = Math.abs(slot - drawFromSlot) >= 1;
      replace(
        spans
          ? { row, from: Math.min(drawFromSlot, slot), to: Math.max(drawFromSlot, slot) }
          : { row },
      );
      return;
    }

    if (row === dragged.row) return;
    // Moving an existing seam keeps whatever range it already has.
    replace({ ...dragged, row });
  };

  const endDrag = () => {
    setDragIndex(null);
    setDrawFromSlot(null);
  };

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
          ? dragIndex !== null
            ? "dragging"
            : hoverRow !== null && seamIndexAt(hoverRow, hoverSlot) >= 0
              ? "grab"
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
        onSeamsChange ? endDrag : onDeletePart ? () => setErasing(false) : undefined
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
        ? seams.map((seam, index) => {
            // A limited seam is drawn only over the slots it cuts, so its reach is
            // visible without having to read it off the strokes.
            const from = seam.from ?? 0;
            const to = seam.to ?? Math.max(geometry.slots - 1, 0);
            const limited = seam.from !== undefined || seam.to !== undefined;
            const start = limited
              ? (geometry.padding + from * geometry.pitch) / geometry.totalWidth
              : 0;
            const width = limited
              ? ((to - from + 1) * geometry.pitch - illustration.system.gapUnits) /
                geometry.totalWidth
              : 1;

            return (
              <div
                key={index}
                className="bar-preview-seam"
                aria-hidden="true"
                style={{
                  insetBlockStart: `${((geometry.padding + seam.row) / geometry.totalHeight) * 100}%`,
                  blockSize: `${(1 / geometry.totalHeight) * 100}%`,
                  insetInlineStart: `${start * 100}%`,
                  inlineSize: `${width * 100}%`,
                }}
              />
            );
          })
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
      {onSeamsChange &&
      dragIndex === null &&
      hoverRow !== null &&
      seamIndexAt(hoverRow, hoverSlot) < 0 ? (
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
