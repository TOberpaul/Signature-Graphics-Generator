import type { MirrorMode } from "@/lib/illustration/shapeMask";
import type { Seam } from "@/lib/illustration/signature";

/**
 * The template behind "Demo laden".
 *
 * A colonnade, chosen because it exercises both halves of the tool in one motif:
 * a clear outline with a gable and a plinth, and an inside made of white gaps
 * between the columns. So the threshold shapes the silhouette while the detail
 * setting decides whether the columns come through - which is exactly the pair
 * of decisions that is hard to explain in a tooltip and obvious once seen.
 *
 * Kept inline rather than as a file in `public`: no request that could fail, and
 * no path to get wrong when the app is served from a sub directory on Pages.
 */
const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="100" viewBox="0 0 120 100">
  <rect width="120" height="100" fill="#ffffff"/>
  <g fill="#1a1a1a">
    <polygon points="60,6 116,38 4,38"/>
    <rect x="10" y="38" width="100" height="8"/>
    <rect x="14" y="46" width="8" height="40"/>
    <rect x="28" y="46" width="8" height="40"/>
    <rect x="42" y="46" width="8" height="40"/>
    <rect x="56" y="46" width="8" height="40"/>
    <rect x="70" y="46" width="8" height="40"/>
    <rect x="84" y="46" width="8" height="40"/>
    <rect x="98" y="46" width="8" height="40"/>
    <rect x="8" y="86" width="104" height="8"/>
  </g>
</svg>`;

/** Data URL of the demo template, ready to hand to an `Image`. */
export const DEMO_TEMPLATE_SRC = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  DEMO_SVG,
)}`;

/**
 * The state the demo opens with.
 *
 * Dialled in by hand on this exact template, so it is a worked example rather than
 * the defaults: mirrored for a symmetric front, and three seams that give the
 * gable, the capitals and the plinth their own bands - the kind of edge a soft
 * shape does not offer on its own and that has to be placed.
 *
 * The rows belong to this template's format. They are meaningful only together
 * with the threshold, which is why the settings and the seams live in one value.
 */
export const DEMO_TEMPLATE_PRESET = {
  name: "Greek",
  settings: {
    threshold: 0.49,
    detail: 0,
    edgeTolerance: 0,
    mirror: "left" as MirrorMode,
  },
  colour: "#090F1B",
  seams: [{ row: 33 }, { row: 41 }, { row: 81 }] as Seam[],
};

/**
 * Name the demo is filed under, standing in for a file name.
 *
 * Taken from the preset so the name exists once: it is part of the state a preset
 * describes, like the settings and the seams.
 */
export const DEMO_TEMPLATE_NAME = DEMO_TEMPLATE_PRESET.name;
