---
name: "signature-graphic-source"
description: "Writes Adobe Firefly prompts that produce silhouette source images suitable for the signature graphics converter. Use when a motif needs a clipart template, or when an existing template converts badly."
---

# Source images for signature graphics

You write **prompts for an image generator**, not the graphic itself. The converter
turns a silhouette into vertical strokes; your job is to get a silhouette it can
read. Everything below exists because of how the converter works.

## What the converter needs

It samples the silhouette column by column. Each column becomes one 2 dp stroke,
and a stroke shows how far the shape extends at that x position. It reads
**area and extent**, nothing else. Consequences:

- **Only the outline carries meaning.** Colour, gradients, texture and shading
  are discarded. Ask for flat pure black on pure white.
- **Detail below the stroke pitch disappears.** With 23 strokes across the
  format, anything narrower than about 1/23 of the width collapses onto one
  stroke. Ask for bold, simplified forms and no fine ornament.
- **Interior structure only survives as holes.** A solid black shape produces
  solid strokes. Windows, passages and separations must be **white cut outs**
  inside the black shape, otherwise they cannot exist in the output.
- **Thin white separator lines create the horizontal edges** that the best
  practice examples show. The converter turns a thin white line into a 1 dp
  vertical gap in every stroke it crosses, and that gap reads as an edge. This is
  the only way to get those edges from a clipart, so ask for them explicitly
  wherever the object has a structural boundary: a plinth, a cornice, a roof
  line, a deck, a floor division.
- **Tips survive, hairlines do not.** A spire or mast is kept if it is at least
  as wide as a stroke. Ask for masts and spires to be drawn solid and slightly
  thickened.
- **One closed shape.** Free floating specks get removed as fragments. Parts that
  belong together must touch.

## The character budget

**The whole JSON is pasted into Firefly, so the whole JSON counts, not just the
prompt text.** This is the rule that is easiest to get wrong.

- **Hard limit: 1600 characters** for the complete serialised payload, braces,
  quotes, whitespace and all.
- **Target: 1400 characters.** That leaves room for a long subject line, or for
  one more edge instruction once the first result comes back.
- **The payload carries generative fields only.** No character count, no notes,
  no converter settings. Those are for the human and belong outside the block,
  where they cost nothing.
- **Compute the length, never estimate it.** Serialise the payload, count the
  characters, report the number. An estimate that turns out wrong is worse than
  no number at all, because it is believed.
- If the count is over budget, cut in this order: ornament wording, then
  redundant exclusions, then merge `form` and `edges`. Never cut the style and
  colour statement or the white separator lines.

## Prompt rules

- English throughout the payload, no line breaks inside a value, no markdown.
- Always state, across the fields: subject and view,
  `flat 2D vector-style silhouette`, `solid pure black on pure white background`,
  `centered`, `full object visible with a small even margin`, the structural
  white cut outs and separator lines, then the exclusions.
- Always exclude: `no gradients, no shading, no texture, no outline stroke, no
  perspective, no 3D, no text, no watermark, no drop shadow, no background
  elements`.
- Name the view explicitly. Side view for vehicles, animals and tools. Front
  elevation for buildings, gates and towers. Free standing front view for fruit,
  bottles and plants.
- Never ask for stripes, bars or line patterns. That is the converter's job, and
  a striped source produces noise.

## Output contract

Deliver **two separate things**, in this order.

**1. The Firefly payload.** One fenced JSON block, nothing else inside it, so it
can be copied in one go. Generative fields only:

```json
{
  "subject": "Frauenkirche Dresden, front elevation, perfectly symmetric",
  "style": "flat 2D vector-style silhouette, solid pure black on pure white background",
  "composition": "centered, full building visible with a small even margin",
  "form": "wide rectangular base block, tall central dome, slender lantern with a small cross, one square corner tower each side, outline closed and all parts connected",
  "edges": "crisp thin white lines across the full width where the base meets the dome, around the dome below the lantern, and above the ground line; lantern opening cut out in white; cross and lantern columns solid and thickened",
  "exclude": "gradients, shading, texture, outline stroke, perspective, 3D, text, watermark, drop shadow, background elements, stripes or line patterns"
}
```

**2. The metadata**, as prose *after* the block, never inside it:

- the measured character count of the payload
- why anything was left out
- converter settings: `allowExtendedFormat` for clearly tall or wide motifs,
  mirroring only for genuinely symmetric front views, and the detail level

## The general purpose prompt

For when someone just wants a template to keep, rather than a prompt written for
one specific motif. Everything that does not depend on the subject is already
settled, so the only thing left to do is replace `[OBJECT]` with the motif in one
to three words. It measures **1256 characters** with the placeholder still in.

```json
{
  "subject": "[OBJECT], one single object, seen straight on at eye level from its most recognisable side: the main entrance facade for buildings, gates and towers, the full side profile for vehicles, animals and tools, upright from the front for plants, bottles and fruit",
  "style": "flat 2D black and white clipart, silhouette in solid pure black on a pure white background, exactly two tones and no other colour anywhere",
  "composition": "orthographic elevation, all verticals strictly parallel and upright, centered, full object visible with a small even margin",
  "form": "bold simplified massing, few large parts, outline closed and all parts touching, masts spires and thin tips drawn solid and thickened",
  "edges": "crisp thin white lines across the full width at every structural boundary such as a plinth, ground line, floor division, deck, cornice or roof edge; openings and inner separations cut out in white",
  "exclude": "colour, tinted roofs or domes, gradients, shading, texture, photographic lighting, rear view, three-quarter or angled view, perspective, converging verticals, low or high camera angle, 3D, outline stroke, text, watermark, drop shadow, background elements, stripes or line patterns, fine ornament, extra props"
}
```

### Why the view is phrased the way it is

**"Always from the front" is the wrong rule.** It is right for buildings, gates and
towers, and it ruins everything else: a tram head on is a rectangle, an animal head
on loses the profile that identifies it. So the template carries the mapping -
facade for buildings, side profile for vehicles and animals, upright front for
plants and bottles - and lets the generator apply it.

What actually fixes a view coming back wrong is more specific than "front":

- **"main entrance facade"** is what stops a building being shown from the choir
  or the rear. Plain "front elevation" leaves the model free to pick an end.
- **"straight on at eye level"** plus `orthographic elevation` and **"all verticals
  strictly parallel and upright"** is what stops the three-quarter view and the
  tilted-up camera. This has to be said in the positive; listing `perspective`
  under exclusions alone does not carry enough weight.

If a result still comes back at an angle, replace the whole view clause with the
single view that is wanted. That is the most effective edit to this template.

`form` and `edges` stay generic: they ask for structural edges *wherever the object
has them* rather than naming the plinth and the cornice. A motif with known
structure converts better with those spelled out, so a written-to-order prompt is
still worth it for anything important.

### Using a reference image in Firefly

A reference image is for **which shape**, never for how it is rendered. Left
unchecked it drags in exactly the two things the converter cannot read.

- **Colour bleeds through.** A photograph of a copper roof produces green domes
  even with `no colour` in the payload. This is why `style` states *exactly two
  tones* and `exclude` names both `colour` and `tinted roofs or domes` - the
  general statement on its own gets overridden.
- **The camera angle bleeds through.** A photograph taken from street level has
  converging verticals, and they survive into the result as a building that tapers
  towards the top.

So:

- **Strip the reference before attaching it.** Convert it to black and white, or
  better, threshold it to a flat silhouette. What is not in the reference cannot be
  imported from it - far more reliable than out-arguing it in the prompt.
- Prefer a **straight-on** reference. A photograph shot from below hands the model
  its perspective; an elevation drawing hands it the geometry we want.
- Attach it as a composition or structure reference, not as a style reference.
  Style is what this payload pins down.
- **Lower the reference strength** until the colour and the perspective drop out.
  Colour appearing at all is the signal that it is still too strong.
- Never weaken `style` or `exclude` to accommodate a reference. They are working
  against it by design.

## Self check before answering

Work through this every time. If any line fails, fix it and count again.

- [ ] Serialised the payload and **counted** the characters
- [ ] Count ≤ 1600, and ≤ 1400 unless there was a reason to go higher
- [ ] Payload contains no count, no notes, no converter settings
- [ ] Style field names flat, vector, solid pure black, pure white
- [ ] White separator lines requested wherever the object has a structural edge
- [ ] Exclusions include stripes and line patterns
- [ ] View named explicitly
- [ ] Metadata sits outside the block

## Failure modes to avoid

| Symptom in the output          | Cause in the source                       |
| ------------------------------ | ----------------------------------------- |
| Blob with no inner structure   | no white cut outs requested               |
| No horizontal edges anywhere   | no thin white separator lines requested   |
| Tip cut off flat               | spire drawn as a hairline                 |
| Scattered short strokes        | texture, shading or specks in the source  |
| Motif tiny in the format       | large empty margin, or a stray speck      |
| Unreadable mush                | too much ornament for 23 strokes          |
| Firefly truncates the input    | metadata left inside the payload          |
