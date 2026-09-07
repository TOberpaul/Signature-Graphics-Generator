# Where the internal documentation is

`docs/` holds the reasoning behind this codebase. Read the relevant file **before**
changing code in the area it covers - each one records decisions that are easy to
break without noticing.

| File                    | Read it before                                              |
| ----------------------- | ----------------------------------------------------------- |
| `docs/pipeline.md`      | touching `src/lib/illustration/` - the conversion, in order, and its invariants |
| `docs/editing-tools.md` | changing or adding a tool that edits the graphic by hand     |
| `docs/ui.md`            | touching `globals.css`, the preview layout, or the zoom      |

Three things that catch people out, in case you only read this far:

- Hand edits are stored as **coordinates on the drawable grid, never as geometry**.
  The geometry is rebuilt on every settings change.
- The canvas fit is decided from the **image's pixel dimensions, before any
  thresholding**. Deriving it from a mask makes the preview jump on every slider move.
- One unit is **one dp**, and every measurement comes from `DP` in `geometry.ts`.

Keep these files current when behaviour changes. They are short on purpose - they
explain why, and leave the what to the code, which is commented densely.
