import { barOffsetUnits, pitchUnitsOf, slotCount } from "./geometry";
import type { BarIllustration } from "./types";

export type RenderOptions = {
  /** Pixel size of one grid unit. */
  unitSize?: number;
  background?: string;
  foreground?: string;
  /** Draw the underlying bar slot grid (development aid). */
  showGrid?: boolean;
  gridColor?: string;
  /** Overrides canvas.paddingUnits, e.g. to change the canvas ratio. */
  paddingUnits?: number;
};

export type RenderedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RenderResult = {
  svg: string;
  width: number;
  height: number;
  rects: RenderedRect[];
};

const DEFAULTS = {
  unitSize: 4,
  background: "#ffffff",
  foreground: "#111111",
  gridColor: "#e2e6ea",
} as const;

/** Padding actually used for rendering. Always a non negative integer. */
export function effectivePadding(
  illustration: BarIllustration,
  paddingOverride?: number,
): number {
  const value = paddingOverride ?? illustration.canvas.paddingUnits;
  return Math.max(0, Math.round(value));
}

/** Total canvas size in units, padding included. */
export function canvasSizeUnits(
  illustration: BarIllustration,
  paddingOverride?: number,
): {
  widthUnits: number;
  heightUnits: number;
} {
  const { widthUnits, heightUnits } = illustration.canvas;
  const pad = effectivePadding(illustration, paddingOverride);
  return {
    widthUnits: widthUnits + pad * 2,
    heightUnits: heightUnits + pad * 2,
  };
}

/**
 * Pure unit -> pixel mapping of every segment.
 *
 * svgX = (padding + x * pitch) * unitSize
 * svgY = (padding + y) * unitSize
 */
export function layoutRects(
  illustration: BarIllustration,
  unitSize: number,
  paddingOverride?: number,
): RenderedRect[] {
  const pad = effectivePadding(illustration, paddingOverride);
  const rects: RenderedRect[] = [];

  for (const bar of illustration.bars) {
    const xUnits =
      pad + barOffsetUnits(bar.x, illustration.system) + (bar.xOffsetUnits ?? 0);
    for (const segment of bar.segments) {
      rects.push({
        x: xUnits * unitSize,
        y: (pad + segment.y) * unitSize,
        width: illustration.system.barWidthUnits * unitSize,
        height: segment.height * unitSize,
      });
    }
  }

  return rects;
}

/**
 * Deterministic SVG renderer. Consumes validated data only and emits one
 * <rect> per segment - no paths, no curves, no diagonals.
 */
export function renderIllustration(
  illustration: BarIllustration,
  options: RenderOptions = {},
): RenderResult {
  const unitSize = options.unitSize ?? DEFAULTS.unitSize;
  const background = options.background ?? DEFAULTS.background;
  const foreground = options.foreground ?? DEFAULTS.foreground;
  const gridColor = options.gridColor ?? DEFAULTS.gridColor;

  const { widthUnits, heightUnits } = canvasSizeUnits(illustration, options.paddingUnits);
  const width = widthUnits * unitSize;
  const height = heightUnits * unitSize;
  const rects = layoutRects(illustration, unitSize, options.paddingUnits);

  // `background: "none"` leaves the canvas transparent, so the preview can show a
  // template underneath the strokes. The export always passes a solid colour.
  const body: string[] =
    background === "none"
      ? []
      : [`  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>`];

  if (options.showGrid) {
    const pad = effectivePadding(illustration, options.paddingUnits);
    const pitch = pitchUnitsOf(illustration.system);
    const slots = slotCount(illustration.canvas.widthUnits, illustration.system);
    const guides: string[] = [];
    for (let slot = 0; slot < slots; slot += 1) {
      guides.push(
        `    <rect x="${(pad + slot * pitch) * unitSize}" y="${pad * unitSize}" width="${
          illustration.system.barWidthUnits * unitSize
        }" height="${illustration.canvas.heightUnits * unitSize}"/>`,
      );
    }
    body.push(`  <g fill="${gridColor}">`, ...guides, "  </g>");
  }

  body.push(
    `  <g fill="${foreground}" shape-rendering="crispEdges">`,
    ...rects.map(
      (r) =>
        `    <rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/>`,
    ),
    "  </g>",
  );

  const title = escapeXml(illustration.meta.label ?? illustration.meta.subject);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
    `  <title>${title}</title>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");

  return { svg, width, height, rects };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Renders the dp grid over the same canvas as {@link renderIllustration}.
 *
 * The grid is the real unit grid of the guideline: one line per dp across the
 * whole format, safe area included, so a 96x96 dp graphic shows a 96x96 grid.
 * Every measurement in the system - 2 dp stroke, 2 dp gap, 3 dp safe area,
 * 4 dp minimum length - can be counted off on it. Lines only, no fill: the
 * strokes themselves are already visible underneath.
 */
export function renderSampledOverlay(
  illustration: BarIllustration,
  options: {
    unitSize?: number;
    paddingUnits?: number;
    gridColor?: string;
  } = {},
): { svg: string; width: number; height: number } {
  const unitSize = options.unitSize ?? DEFAULTS.unitSize;
  const gridColor = options.gridColor ?? "#0087b9";

  const { widthUnits, heightUnits } = canvasSizeUnits(illustration, options.paddingUnits);
  const width = widthUnits * unitSize;
  const height = heightUnits * unitSize;

  // The real dp grid: one line per dp across the whole format, safe area
  // included. So a 96x96 dp graphic shows a 96x96 grid, which is the unit every
  // measurement in the guideline is expressed in.
  const lineWidth = Math.max(0.3, unitSize * 0.05);
  const lines: string[] = [];
  for (let x = 0; x <= widthUnits; x += 1) {
    const px = x * unitSize;
    lines.push(`    <line x1="${px}" y1="0" x2="${px}" y2="${height}"/>`);
  }
  for (let y = 0; y <= heightUnits; y += 1) {
    const py = y * unitSize;
    lines.push(`    <line x1="0" y1="${py}" x2="${width}" y2="${py}"/>`);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">`,
    `  <g stroke="${gridColor}" stroke-width="${lineWidth}" stroke-opacity="0.5" shape-rendering="crispEdges">`,
    ...lines,
    "  </g>",
    "</svg>",
    "",
  ].join("\n");

  return { svg, width, height };
}
