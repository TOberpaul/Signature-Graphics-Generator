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

- **Hard limit: 1700 characters** for the complete serialised payload, braces,
  quotes, whitespace and all.
- **Target: 1200 characters.** Anything above that is too close to the edge.
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

## Self check before answering

Work through this every time. If any line fails, fix it and count again.

- [ ] Serialised the payload and **counted** the characters
- [ ] Count ≤ 1700, and ≤ 1200 unless there was a reason to go higher
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
