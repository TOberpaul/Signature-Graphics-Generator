# The conversion pipeline

How an uploaded image becomes a signature graphic. Read this before changing
anything in `src/lib/illustration/`.

The code itself carries the reasoning in comments. This file is the map: which
module answers which question, in what order, and which properties must not break.

## One unit is one dp

Throughout `src/lib/illustration/` a unit is one dp of the guideline. That is the
only mapping in which every constant is an integer - a 1 dp vertical gap and a
3 dp safe area cannot be expressed when a unit is 2 dp.

All guideline constants live in `geometry.ts` as `DP`. Nothing else may define a
measurement. A 2 dp stroke, a 4 dp pitch, a 4 dp minimum stroke length, a 3 dp
safe area: they come from there or they are a bug.

## The order

`ImageTemplate` runs the whole thing in one effect, re-running whenever the image
or any setting changes. Everything is synchronous and local to the browser.

1. **`imageMask.cropToContent`** - once, before anything else. From here the
   motif's extent is fixed.
2. **`shapeMask.imageToSignature`** orchestrates the conversion itself:
   1. `signature.chooseFormatForExtent` picks square, portrait or landscape.
   2. `signature.planSignatureCanvasForExtent` fits the motif into the format,
      aspect preserved (contain, never stretch), and centres it.
   3. `imageMask.imageToGridWithDetail` measures the image **straight onto the
      fitted stroke grid** and thresholds it. `detail` is a second, stricter pass
      that only carves openings out of the interior and leaves the outline alone.
   4. `mirrorGrid` and `signature.cleanMask` mirror and de-speck, keeping the
      extent. `placeInDrawable` puts the motif into the full drawable raster.
   5. **`signature.constructStrokes`** applies the drawing system: fuse gaps,
      cut manual seams, detect horizontal levels, normalise edges, drop
      fragments, snap gaps, stagger level bands, cut the seams again.
   6. `strokesToIllustration` turns columns and runs into `BarIllustration`.
3. **`segments.removeSegmentsAt`** - the hand removals.
4. **`strokes.addStrokes`** - the hand additions.
5. **`validation.validateIllustration`** - the gate. Nothing reaches the preview
   without passing.
6. **`renderer.renderIllustration`** - deterministic SVG.

## Invariants

Break one of these and the tool feels broken in a way that is hard to trace back.

**The fit is decided before any cell is classified.** `chooseFormatForExtent` and
`planSignatureCanvasForExtent` take the *image's own pixel dimensions*, not the
thresholded mask. This is what keeps the motif from jumping around the canvas
while the threshold slider moves. If you ever re-derive the fit from a mask, the
preview will shift on every slider move. `extentIsMotif` exists for the same
reason: it stops a second trimming pass from undoing the fit.

**Validation is not optional.** `validateIllustration` enforces what a schema
cannot: segments ordered and non-overlapping within a bar, no duplicate bar at the
same slot and offset, nothing outside the canvas. Any new construction step runs
*before* it, never after.

**Preview and export share one renderer.** `renderIllustration` is used by both,
so they cannot drift. Do not add a second rendering path.

**Construction rules run after the hand edits they interact with.** Seams are cut
inside `constructStrokes`, twice: once early so the later rules can tidy up around
the cut, once at the end so the cut always survives whatever those rules did.
Removals and additions come afterwards, on the finished geometry.

## Where things live

| Module          | Answers                                                        |
| --------------- | -------------------------------------------------------------- |
| `geometry.ts`   | What are the guideline's measurements and formats?             |
| `imageMask.ts`  | Which cells of the grid are ink? (crop, raster, threshold)     |
| `occupancy.ts`  | Grid primitives: normalise, trim, column runs.                 |
| `shapeMask.ts`  | Orchestrates image to illustration. Mirroring lives here.      |
| `signature.ts`  | What is a legal signature graphic? All construction rules.     |
| `segments.ts`   | Which strokes belong together, and how is one removed?         |
| `strokes.ts`    | How is a hand drawn stroke added?                              |
| `validation.ts` | Is this illustration legal?                                    |
| `renderer.ts`   | Units to pixels, deterministic SVG.                            |
| `types.ts`      | The data model. Integer units only, never pixels.              |

## Testing

`lib/` modules have unit tests next to them and are the place to test. Components
are not tested. Run `npm test`; `npm run lint` is a type check, and the CI runs
lint, test and build in that order.
