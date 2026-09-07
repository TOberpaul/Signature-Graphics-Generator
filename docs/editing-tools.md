# The editing tools

Three tools let the user correct what the template could not deliver. Read this
before adding a fourth, or before changing how one of them stores its work.

## The one principle that matters

**Hand edits are stored as coordinates on the drawable grid, never as geometry.**

The geometry is rebuilt from the template on every settings change. After a new
threshold there is no stable identity for "that stroke" - the bar array is a
different array. But a *position* keeps meaning the same thing, so an edit anchored
to a position survives a change of threshold.

This is why:

- a seam is a `row` plus an optional slot range (`signature.Seam`)
- a removal is a point in grid units (`segments.SegmentAnchor`)
- an added stroke is a `slot`, a `row` and a `height` (`strokes.AddedStroke`)

None of them stores a bar index or a segment index. If you add a tool that does,
its edits will drift the moment a slider moves.

The one exception is `segments.RemovedSegment`, which carries geometry *out* of the
removal - once a stroke is gone there is nothing left in the illustration to look
up, and the preview needs its box to show what is missing and offer it back.

## Order of application, and why

| Step        | Where                                    |
| ----------- | ---------------------------------------- |
| Seams       | inside `constructStrokes`, cut twice     |
| Removals    | `removeSegmentsAt`, on finished geometry |
| Additions   | `addStrokes`, after the removals         |

**Additions come last on purpose.** Both tools can point at the same place, and
"what I drew stays" is the only one of the two orders that behaves predictably.

The consequence is that a removal anchor can never catch an added stroke. That
made the delete tool look broken - the stroke was visible and refused to be
deleted. So the delete tool detects a hit on an added stroke and takes the
*addition* back instead, via `onDeleteAddedStroke`. Deleting it is final; the draw
tool's undo is what brings it back.

## Who owns what

- **`Generator`** owns the tool state: the lists, which tool is open, and the
  reset when a new template arrives. Only one tool owns the canvas at a time, so
  opening one closes the others.
- **`ImageTemplate`** owns the construction settings and runs the pipeline. It
  takes the hand edits as props.
- **`BarPreview`** owns every gesture. No gesture logic lives in `Generator`; the
  preview reports the resulting list and the parent just stores it.

`Generator` folds exact duplicates out of the reported lists, which is what makes
an Alt-click that does not move a no-op rather than a stacked duplicate.

## Gesture model

Both the seam tool and the draw tool follow the same shape, and a new tool should
too.

A drag state holds the item's index, the mode, the item **as it was when the
gesture began** (`origin`), and where the pointer went down. Everything is derived
from `origin` plus the distance travelled since - never from the item's current
value. That is what lets Alt be pressed and released mid-drag: the result depends
only on where the pointer is now and what the item looked like at the start, so
switching behaviour part way through recomputes cleanly.

Alt means two things, decided by where the grab happened:

- on an **end**: resize about the centre, mirroring the movement onto the other end
- on the **body**: copy. The original stays, the copy follows the pointer as a
  faint preview, and nothing joins the list until the button is released.

Double click removes. A deliberate gesture, so a single click stays free for
placing and dragging.

## Coordinate mapping

`BarPreview` maps pointer positions with `getBoundingClientRect()`, so it reads the
*rendered* box. This is why the tools keep working at any zoom without a single
change - do not replace it with anything that assumes a fixed scale.

Three helpers do the work: `rowFromEvent` (drawable row, or null outside),
`slotFromEvent` (stroke slot, clamped rather than nulled so dragging past an edge
extends to the edge instead of aborting) and `pointFromEvent` (grid units,
safe area included).

## Adding a tool: checklist

- [ ] Store it as coordinates on the drawable grid, not as geometry
- [ ] Put the construction step in `src/lib/illustration/`, with unit tests
- [ ] Apply it before `validateIllustration`, and make sure the result validates
- [ ] Add state plus a reset in `Generator`, and close the other tools when it opens
- [ ] Put the gestures in `BarPreview`, deriving everything from `origin`
- [ ] Give it a marker in brand colour and a cursor via a `data-*-tool` attribute
- [ ] Add it to the preset capture in `copyPreset`
- [ ] Say what the gestures are in the tool's `DBInfotext`
