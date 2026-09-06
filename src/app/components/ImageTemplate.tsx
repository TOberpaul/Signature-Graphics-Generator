"use client";

import { useEffect, useMemo, useState } from "react";
import { DBCheckbox, DBSelect } from "@db-ux/react-core-components";
import { cropToContent } from "@/lib/illustration/imageMask";
import type { RasterImage } from "@/lib/illustration/imageMask";
import { imageToSignature } from "@/lib/illustration/shapeMask";
import type { MirrorMode } from "@/lib/illustration/shapeMask";
import { validateIllustration } from "@/lib/illustration/validation";
import { DP, DP_PITCH } from "@/lib/illustration/geometry";
import type { SignatureCanvasPlan } from "@/lib/illustration/signature";
import type { ConversionResult, OverlayGeometry } from "@/lib/illustration/result";
import {
  removeSegmentsAt,
  SEGMENT_PICK_TOLERANCE_DP,
} from "@/lib/illustration/segments";
import type { SegmentAnchor } from "@/lib/illustration/segments";
import type { ImageFile } from "./useImageFile";
import { RangeSetting, Setting } from "./Setting";

type Props = {
  /** The picked file and its pixels, owned by the parent. */
  file: ImageFile;
  allowExtendedFormat: boolean;
  /** Rows of the drawable grid to cut as seams, placed by hand in the preview. */
  manualSeams?: number[];
  /** Points at connected parts the user removed by hand in the preview. */
  removedParts?: SegmentAnchor[];
  onResult: (result: ConversionResult) => void;
  onError: (message: string) => void;
};

/**
 * Places the source photo on the canvas, on exactly the area the motif was
 * fitted into.
 *
 * The image arrives cropped to its content, and the fit is derived from its own
 * dimensions, so this box is settled before any cell is classified - no setting
 * can move it.
 */
function buildOverlayGeometry(
  image: RasterImage,
  plan: SignatureCanvasPlan,
  canvas: { widthUnits: number; heightUnits: number; paddingUnits: number },
): OverlayGeometry | null {
  if (plan.columnsUsed === 0 || plan.rowsUsed === 0) return null;

  const src = imageToDataUrl(image);
  if (!src) return null;

  const pad = canvas.paddingUnits;
  const totalWidth = canvas.widthUnits + pad * 2;
  const totalHeight = canvas.heightUnits + pad * 2;
  const box = {
    left: (pad + plan.offsetColumns * DP_PITCH) / totalWidth,
    top: (pad + plan.offsetRows) / totalHeight,
    width: (plan.columnsUsed * DP_PITCH - DP.horizontalGap) / totalWidth,
    height: plan.rowsUsed / totalHeight,
  };

  return { src, sourceBox: box, maskBox: box };
}

/** Turns the raster into a data URL so it can be shown as an overlay. */
function imageToDataUrl(image: RasterImage): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  // Copy into a fresh buffer so the ImageData is backed by an ArrayBuffer.
  const pixels = new Uint8ClampedArray(image.width * image.height * 4);
  pixels.set(image.data);
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Settings that describe how the template is read.
 *
 * The image is measured directly on the stroke grid and thresholded there, so
 * there is exactly one rastering step and one decision per cell. Everything runs
 * locally, so every knob has instant feedback.
 */
export function ImageTemplate({
  file,
  allowExtendedFormat,
  manualSeams,
  removedParts,
  onResult,
  onError,
}: Props) {
  const { image: rawImage, fileName } = file;

  // The template is cropped to its content once, before anything else. From here
  // on the motif's extent - and therefore its size and position on the canvas -
  // is fixed, so moving the threshold can only change which cells are filled.
  const image = useMemo(() => (rawImage ? cropToContent(rawImage) : null), [rawImage]);

  const [threshold, setThreshold] = useState(0.5);
  const [cleanup, setCleanup] = useState(0);
  const [edgeTolerance, setEdgeTolerance] = useState(0);
  const [solidStrokes, setSolidStrokes] = useState(true);
  const [mirrorOn, setMirrorOn] = useState(false);
  const [mirrorHalf, setMirrorHalf] = useState<MirrorMode>("left");

  const disabled = !image;

  // recompute whenever the image or a knob changes
  useEffect(() => {
    if (!image) return;

    const label = fileName?.replace(/\.[^.]+$/, "") || "Bildvorlage";
    const mirror: MirrorMode = mirrorOn ? mirrorHalf : "none";
    const { illustration, mask, sampled, plan, report } = imageToSignature(
      image,
      {
        subject: label.slice(0, 80),
        label: label.slice(0, 80),
        ...(mirrorOn ? { symmetry: "vertical" as const } : {}),
      },
      {
        threshold,
        cleanup,
        mirror,
        allowExtendedFormat,
        edgeTolerance,
        // On swallows everything below a deliberate opening; off keeps every gap.
        fuseGapsBelow: solidStrokes ? DP.intentionalVerticalGap : 0,
        manualSeams,
      },
    );

    if (illustration.bars.length === 0) {
      onError("Aus dem Bild ließ sich keine Fläche ableiten. Schwellwert anpassen.");
      return;
    }

    // Hand removals are a construction step like any other: applied to the
    // finished geometry, then validated, so a pruned graphic still has to obey
    // every rule of the system.
    const pruned = removeSegmentsAt(
      illustration,
      removedParts ?? [],
      SEGMENT_PICK_TOLERANCE_DP,
    );

    if (pruned.bars.length === 0) {
      onError("Es sind keine Striche übrig. Letzte Löschung zurücknehmen.");
      return;
    }

    const validation = validateIllustration(pruned);
    if (!validation.ok) {
      onError(`Die konstruierte Grafik ist ungültig: ${validation.errors[0]}`);
      return;
    }

    const warnings =
      plan.format === "square"
        ? []
        : [
            plan.format === "portrait"
              ? `Hohes Motiv: Format ${plan.formatDp.widthDp}×${plan.formatDp.heightDp} dp.`
              : `Breites Motiv: Format ${plan.formatDp.widthDp}×${plan.formatDp.heightDp} dp.`,
          ];

    const overlay =
      buildOverlayGeometry(image, plan, validation.value.canvas) ?? undefined;

    onResult({
      illustration: validation.value,
      mask,
      grid: sampled,
      provider: "image",
      subject: label,
      cleanup,
      durationMs: 0,
      warnings,
      overlay,
      raw: {
        source: "image-template",
        threshold,
        mirror,
        plan,
        construction: report,
      },
    });
    // onResult / onError are stable callbacks from the parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    image,
    threshold,
    mirrorOn,
    mirrorHalf,
    cleanup,
    allowExtendedFormat,
    edgeTolerance,
    solidStrokes,
    manualSeams,
    removedParts,
    fileName,
  ]);

  // The order follows the pipeline: the threshold turns the fitted image into
  // strokes, mirroring and cleanup work on that grid. No wrapping stack, because
  // `.db-stack` carries `block-size: 100%` and would take the full height of the
  // settings list.
  return (
    <>
      <RangeSetting
        id="threshold"
        label={`Schwellwert ${threshold.toFixed(2)}`}
        help="Die eine Entscheidung pro Rasterzelle: ab welcher Flächendeckung eine Zelle zum Strich wird. Gemessen wird direkt auf dem Strichraster, also am echten Bild - nicht an einer Zwischenmaske. Niedrig lässt die Form wachsen und nimmt weiche Ränder mit, hoch lässt sie schrumpfen und dünne Teile abreißen."
        value={threshold}
        min={0.05}
        max={0.95}
        step={0.01}
        disabled={disabled}
        onChange={setThreshold}
      />

      <Setting
        id="solid-help"
        help="An: pro Spalte ein durchgezogener Strich, dessen Länge der Umriss bestimmt. Große Öffnungen wie Bögen oder Durchgänge bleiben als Lücke erhalten. Aus: jedes Detail der Vorlage wird abgetastet - Gitterwerk, Fenster, Mauerwerk - und zerlegt die Striche in viele kurze Segmente."
        state={
          solidStrokes
            ? "Nur der Umriss zählt, große Öffnungen bleiben."
            : "Jedes Detail der Vorlage wird zu einer Lücke."
        }
        disabled={disabled}
      >
        <DBCheckbox
          label="Durchgängige Striche"
          size="small"
          checked={solidStrokes}
          disabled={disabled}
          onChange={(event) => setSolidStrokes(event.target.checked)}
        />
      </Setting>

      <RangeSetting
        id="cleanup"
        label={`Bereinigung ${Math.round(cleanup * 100)} %`}
        help="Räumt das Raster auf: entfernt kleine freistehende Flecken neben der Form und schließt winzige Löcher darin. Je weiter rechts, desto größer dürfen die Teile sein, die verschwinden - dann fallen auch feine echte Details weg. Größe und Strichanzahl bleiben davon unberührt, die legt das Format fest."
        state={
          cleanup === 0
            ? "Aus: nur einzelne Pixel gelten als Rauschen, sonst bleibt alles."
            : cleanup <= 0.35
              ? "Entfernt kleine freistehende Flecken und schließt winzige Lücken."
              : "Räumt kräftig auf: auch kleine echte Details fallen weg."
        }
        value={cleanup}
        min={0}
        max={1}
        step={0.05}
        disabled={disabled}
        onChange={setCleanup}
      />

      <RangeSetting
        id="edgeTolerance"
        label={`Kantenausgleich ${edgeTolerance} dp`}
        help="Zieht Kanten, die fast auf einer Ebene liegen, auf eine gemeinsame Ebene. Hilft gegen Perspektive in der Vorlage, die Strichenden ungleich ausfransen lässt. Die Toleranz ist der Schutz: nur Kanten innerhalb dieser Spanne verschmelzen, bewusste Abstufungen wie Turmspitzen sind größer und bleiben erhalten."
        state={
          edgeTolerance === 0
            ? "Aus: jede Kante bleibt, wo die Vorlage sie hat."
            : `Kanten bis ${edgeTolerance} dp Abstand rasten auf eine Ebene.`
        }
        value={edgeTolerance}
        min={0}
        max={8}
        step={1}
        disabled={disabled}
        onChange={setEdgeTolerance}
      />

      <Setting
        id="mirror-help"
        help="Erzwingt exakte Spiegelsymmetrie auf dem Raster, bevor die Regeln laufen. Nur für echte Frontalansichten sinnvoll. Der Kantenausgleich kann die Symmetrie danach minimal wieder brechen."
        disabled={disabled}
      >
        <DBCheckbox
          label="Exakte Spiegelung"
          size="small"
          checked={mirrorOn}
          disabled={disabled}
          onChange={(event) => setMirrorOn(event.target.checked)}
        />
      </Setting>

      {mirrorOn && !disabled ? (
        <Setting
          id="mirror-half-help"
          help="Welche Hälfte maßgeblich ist. Links und rechts erhalten die Form exakt, beide vereinen behält jedes Detail beider Seiten und macht die Form dadurch etwas breiter."
        >
          {/* The floating variant renders an empty placeholder option by default.
              There is always a half selected, so there is nothing to place hold. */}
          <DBSelect
            label="Gespiegelte Hälfte"
            variant="floating"
            showEmptyOption={false}
            value={mirrorHalf}
            onChange={(event) => setMirrorHalf(event.target.value as MirrorMode)}
            options={[
              { value: "left", label: "linke Hälfte" },
              { value: "right", label: "rechte Hälfte" },
              { value: "union", label: "beide vereinen" },
            ]}
          />
        </Setting>
      ) : null}
    </>
  );
}
