# UI, styling and layout

Conventions and the handful of non-obvious mechanisms in `src/app/`. Read this
before touching `globals.css` or the preview layout.

## Design system first

The UI is built from DB UX Design System v3 (`@db-ux/react-core-components`).
Typography, colour and component styling come from it; `globals.css` is for
application layout only.

- **Use tokens, never magic numbers.** Spacing, colour, sizing and radii all have
  `--db-*` tokens.
- **Do not restyle design system components.** If something looks wrong, the
  component usually has a prop for it.
- The one place a native control is styled by hand is the range input, because the
  design system has no slider. It lives in `Setting.tsx` so every slider in the app
  is identical.

### Two CSS mechanisms worth knowing

**Unlayered CSS beats layered CSS**, whatever the specificity. The design system is
imported into `@layer db-theme, db-ux`, so our unlayered rules win without
`!important`. This is how the square corners work: the radius tokens are set to `0`
on `:root` and reach every component at once.

**The slider fill is a gradient driven by `--range-fill`.** `accent-color` filled
the track until the track got its own background, and Chromium has no pseudo element
for the filled part. So `RangeInput` computes the percentage and passes it in. Any
new slider must go through `RangeInput` or it will render without a fill.

## Language

German for anything the user reads. English for identifiers, comments and commits.

## Accessibility

`DBTooltip` attaches its `aria-describedby` to its **own parent**. In a `Setting`
that parent is the wrapping field, not the control - so the control needs the
reference itself. Every control inside a `Setting` therefore passes the tooltip's
id explicitly, and leaves it off while disabled, because `Setting` does not render
the tooltip then and a reference to a missing id is worse than none.

For design system form components the prop is `ariaDescribedBy`, and it **replaces**
the ids the component generates for its own message and validation text. Setting it
is only safe on a field that has no `message`, `validMessage` or `invalidMessage`.
Adding one later means folding its id in too.

## The preview layout

Three nested elements, each with one job:

```
.preview-stage      column, holds the window
  .preview-viewport scrolls, this is the window onto the canvas
    .bar-preview    the canvas, sized natural size x zoom
```

**The canvas is sized explicitly, not clamped to its container.** Width comes in
inline as `result.width * scale`, and the aspect ratio gives the height. Clamping it
to the window is what would make zooming in do nothing.

**Centring is `margin: auto` on the flex item, not `justify-content` on the
container.** Auto margins centre while the canvas fits and, once it does not, still
allow scrolling all the way to the top left; flex centring pins the overflow on both
sides and makes that corner unreachable. The auto margin also suppresses the cross
axis stretch, so the aspect ratio survives.

**Watch out for `display: contents`.** `.preview-single` has it, so the flex item of
the viewport is the `.bar-preview` inside it, while a child selector still matches
the wrapper - and a `display: contents` element generates no box for a margin to
apply to. Both flex items are therefore named explicitly in the CSS rather than
selected with `> *`. This exact trap cost a debugging round already.

## Zoom

Zoom is a plain multiple of the canvas's natural size at `PREVIEW_UNIT_SIZE`, and a
template opens at 100 %. There is no fit-to-window mode.

**The wheel listener is registered by hand with `{ passive: false }`.** React
attaches wheel listeners passively, where `preventDefault` does nothing, and without
it the browser zooms the whole page alongside. Ctrl or Cmd plus the wheel is also
how a trackpad pinch arrives. The step is exponential so the same movement changes
the zoom by the same ratio at every level.

Nothing else needs to know about the zoom: the tools read the rendered box, and the
SVG is vector, so it stays crisp with no re-render.

## Markers and cursors

Every editing mark uses `--db-brand-origin-default`, solid. A mark belongs to the
tool, not to the graphic, so they share one colour; `critical` was wrong because
nothing about placing a stroke is an error. At 2 dp a semi transparent fill only
muddies the colour instead of marking anything, so only the *uncommitted* previews -
the placement guide and the Alt copy - are faint.

There is no ambiguity from sharing one colour, because only one tool owns the canvas
at a time.

Cursors hang off `data-seam-tool`, `data-delete-tool` and `data-draw-tool` on
`.bar-preview`, each carrying which handle is under the pointer.

## Layout areas

- **Control panel (top)**: the one global action, Export, plus the colour.
- **Side panel (left)**: construction settings in pipeline order, then the tools.
- **Title row**: what the graphic *is* - its name, and Ersetzen.
- **Toolbar (bottom)**: how it is *displayed* - layer opacities, zoom, compare.

Putting an action in the wrong one of these is the most common layout mistake here.
Ersetzen sits in the title row rather than under the canvas because the canvas
scrolls and a button under it would scroll away.
