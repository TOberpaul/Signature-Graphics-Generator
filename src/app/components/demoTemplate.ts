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

/** Shown as the graphic's name once the demo is loaded. */
export const DEMO_TEMPLATE_NAME = "Museum";
