"use client";

import { useCallback, useState } from "react";
import {
  DBButton,
  DBCard,
  DBControlPanelActions1,
  DBControlPanelBrand,
  DBControlPanelDesktop,
  DBControlPanelMobile,
  DBDrawer,
  DBDrawerHeader,
  DBIcon,
  DBInfotext,
  DBInput,
  DBSelect,
  DBShell,
  DBShellContent,
  DBShellSubNavigation,
  DBStack,
  DBTooltip,
} from "@db-ux/react-core-components";
import { BarPreview } from "./BarPreview";
import { ImageTemplate } from "./ImageTemplate";
import { useImageFile } from "./useImageFile";
import { renderIllustration } from "@/lib/illustration/renderer";
import { DP } from "@/lib/illustration/geometry";
import type { ConversionResult } from "@/lib/illustration/result";
import type { SegmentAnchor } from "@/lib/illustration/segments";
import type { Seam } from "@/lib/illustration/signature";

/**
 * The preview is always rendered at this pixel size per dp and scaled to fit
 * its stage. Output size is a concern of the export, so changing the target
 * size can never make the preview overflow.
 */
const PREVIEW_UNIT_SIZE = 3;

/** Target widths in pixels for the raster export. */
const EXPORT_WIDTHS = [512, 1024, 2048, 4096];

/** The three permitted graphic colours. */
const COLOURS = [
  { value: "#090F1B", label: "Schwarz" },
  { value: "#FF002B", label: "Rot" },
  { value: "#AA99FF", label: "Lilac" },
] as const;

type ExportFormat = "png" | "svg";

/**
 * Three levels of control, deliberately kept apart:
 *
 * - the control panel holds the one global action, Export
 * - the side panel holds the construction settings, in pipeline order
 * - the content holds what belongs to the artefact on screen: the source of the
 *   template and how it is displayed
 */
export function Generator() {
  // The format is detected automatically; the extended formats are always
  // allowed, so a clearly tall or wide motif is never squashed into a square.
  const allowExtendedFormat = true;
  const [colour, setColour] = useState<string>(COLOURS[0].value);
  const [overlayOpacity, setOverlayOpacity] = useState(0.1);
  const [strokesOpacity, setStrokesOpacity] = useState(1);
  const [sampledOpacity, setSampledOpacity] = useState(0);

  // Side-by-side view: the strokes in one canvas, the untouched template photo
  // in a second next to it, so both can be judged against each other directly.
  const [compare, setCompare] = useState(false);

  // Hand placed seams: rows of the drawable grid that are cut across every
  // stroke. Automatic detection cannot find a level on a soft shape like a dome,
  // so these are set by clicking the canvas with the tool open.
  const [seams, setSeams] = useState<Seam[]>([]);
  const [seamTool, setSeamTool] = useState(false);

  // The preview owns the whole interaction (place, drag, limit, remove) and
  // reports the resulting list, so there is no gesture logic duplicated here.
  //
  // Several seams may share a row: on a symmetric facade the same level is cut on
  // the left and on the right while the centre stays whole. Only fully identical
  // seams are folded together, and the order is left as reported - the preview
  // identifies a seam by its position in this list.
  const changeSeams = useCallback((next: Seam[]) => {
    const seen = new Set<string>();
    setSeams(
      next.filter((seam) => {
        const key = `${seam.row}:${seam.from ?? ""}:${seam.to ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }, []);

  // Connected parts the user removed, stored as the points that were clicked.
  // The geometry is rebuilt from the template whenever a setting changes, so
  // there is no lasting identity for "that shape" - but the place stays
  // meaningful, and the part sitting there is removed again after every rebuild.
  const [removedParts, setRemovedParts] = useState<SegmentAnchor[]>([]);
  const [deleteTool, setDeleteTool] = useState(false);

  const removePart = useCallback((anchor: SegmentAnchor) => {
    setRemovedParts((current) => [...current, anchor]);
  }, []);

  // Clicking a removal drops the anchor behind it, so the strokes it took out come
  // back on the next pass.
  const restorePart = useCallback((anchorIndex: number) => {
    setRemovedParts((current) => current.filter((_, index) => index !== anchorIndex));
  }, []);

  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A name the user has set by hand, overriding the one derived from the file.
  // Drives both the title and the export file name. Reset when the template goes.
  const [customName, setCustomName] = useState<string | null>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [exportWidth, setExportWidth] = useState(1024);
  const [exporting, setExporting] = useState(false);

  const file = useImageFile(setError);
  const hasImage = Boolean(file.image);

  // Counts the templates loaded so far. Used as the settings panel's key, so a
  // new image remounts it and every construction setting is back at its default.
  // The settings belong to the template they were dialled in for; carrying a
  // threshold tuned for one motif over to the next is never what is wanted.
  const [templateGeneration, setTemplateGeneration] = useState(0);

  // Everything the user built on top of the old template goes when a new one
  // arrives: the tools, their results, and the name derived from the file. Done
  // here rather than in the hook so the hook stays about files only.
  const loadTemplate = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setSeams([]);
      setSeamTool(false);
      setRemovedParts([]);
      setDeleteTool(false);
      setCustomName(null);
      setError(null);
      setTemplateGeneration((generation) => generation + 1);
      file.onInputChange(event);
    },
    [file],
  );

  // The name shown and exported: the user's own if set, otherwise the one the
  // pipeline derived from the file.
  const derivedName = result
    ? (result.illustration.meta.label ?? result.subject)
    : "";
  const displayName = customName ?? derivedName;

  const handleResult = useCallback((next: ConversionResult) => {
    setError(null);
    setResult(next);
  }, []);

  const openNameDialog = useCallback(() => {
    setNameDraft(displayName);
    setNameOpen(true);
  }, [displayName]);

  const saveName = useCallback(() => {
    const trimmed = nameDraft.trim();
    setCustomName(trimmed.length > 0 ? trimmed : null);
    setNameOpen(false);
  }, [nameDraft]);

  const runExport = useCallback(async () => {
    if (!result) return;
    setExporting(true);
    setError(null);
    try {
      // The safe area of the guideline is part of the artwork, so it is rendered
      // into the export exactly as it is shown in the preview.
      const { svg, width, height } = renderIllustration(result.illustration, {
        unitSize: PREVIEW_UNIT_SIZE,
        foreground: colour,
      });
      const name = slug(displayName);

      if (exportFormat === "svg") {
        download(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), `${name}.svg`);
      } else {
        const blob = await rasterize(svg, width, height, exportWidth);
        download(blob, `${name}-${exportWidth}px.png`);
      }

      setExportOpen(false);
    } catch {
      setError("Der Export hat nicht funktioniert. Bitte noch einmal versuchen.");
    } finally {
      setExporting(false);
    }
  }, [result, exportFormat, exportWidth, colour, displayName]);

  const brand = <DBControlPanelBrand>Signature Graphics Generator</DBControlPanelBrand>;

  // Colour is the last decision before exporting, so it sits next to the export
  // action rather than among the construction settings.
  const exportAction = (
    <DBControlPanelActions1>
      {/* The floating variant renders an empty placeholder option by default.
          There is always a colour selected, so there is nothing to place hold. */}
      <DBSelect
        label="Farbe"
        variant="floating"
        showEmptyOption={false}
        value={colour}
        disabled={!result}
        onChange={(event) => setColour(event.target.value)}
        options={COLOURS.map(({ value, label }) => ({ value, label }))}
      />
      <DBButton
        type="button"
        variant="brand"
        icon="download"
        disabled={!result}
        onClick={() => setExportOpen(true)}
      >
        Export
      </DBButton>
    </DBControlPanelActions1>
  );

  return (
    <DBShell
      controlPanelDesktopPosition="top"
      showSubNavigation
      subNavigationDesktopPosition="left"
      subNavigationMobilePosition="top"
      fadeIn
    >
      {/* One hidden input for both triggers: the empty state call to action and
          "replace" below the canvas. Out of the tab order so the buttons are the
          only focusable controls. */}
      <input
        ref={file.inputRef}
        className="db-visually-hidden"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={loadTemplate}
      />

      <DBControlPanelDesktop brand={brand} actions1={exportAction} />

      <DBControlPanelMobile
        brand={brand}
        actions1={exportAction}
        drawerHeaderText="Signature Graphics Generator"
        burgerMenuLabel="Menü öffnen"
      />

      {/* The sub navigation is a generic collapsible side panel, so the settings
          live in it as children instead of navigation items. */}
      {/* `expanded` is only the initial state, and the panel owns its open/close
          afterwards. Remounting via `key` when an image arrives or leaves lets us
          drive that initial state: collapsed with no image, open once one loads,
          while the user can still toggle it by hand in between. */}
      <DBShellSubNavigation
        key={hasImage ? "with-image" : "empty"}
        expanded={hasImage}
        expandButtonTooltipFn={(open) =>
          open ? "Einstellungen einklappen" : "Einstellungen ausklappen"
        }
      >
        {/* `role="group"` makes the label and the description below apply to the
            panel as a whole, which is what they describe. */}
        <div className="settings" role="group" aria-label="Einstellungen">
          {/* One explanation for the whole panel while it cannot be used, instead
              of every field repeating it. Hovering anywhere over the disabled
              settings shows it, since the tooltip anchors to this container. */}
          {!hasImage ? (
            <DBTooltip placement="right">
              Erst ein Bild auswählen, dann sind die Einstellungen verfügbar.
            </DBTooltip>
          ) : null}

          <h2 className="settings-title" data-font-size="lg">
            Einstellungen
          </h2>
          <div className="settings-list">
            {/* Stated once for the whole panel. The individual settings keep
                their own explanation instead of all repeating this. */}
            {!hasImage ? (
              <DBInfotext semantic="informational" size="small">
                Zuerst ein Bild auswählen.
              </DBInfotext>
            ) : null}

            <ImageTemplate
              key={templateGeneration}
              file={file}
              allowExtendedFormat={allowExtendedFormat}
              manualSeams={seams}
              removedParts={removedParts}
              onResult={handleResult}
              onError={setError}
            />

            {/* Seams are placed on the canvas rather than dialled in, so they get
                their own heading instead of sitting among the settings. */}
            <h2 className="settings-title settings-title-section" data-font-size="lg">
              Werkzeuge
            </h2>

            {/* Only one tool can own the canvas at a time, so opening one closes
                the other. */}
            {/* Each tool is one row: the toggle takes the width, its reset
                actions sit next to it as icons. They only appear once there is
                something to undo, so the row stays quiet until then. Their text
                is kept as the accessible name. */}
            <DBStack gap="medium">
              <div className="tool-row">
                {/* A tool being open is a state of the control, not a call to
                    action, so it reads as pressed rather than brand coloured.
                    `aria-pressed` carries that state to assistive tech and is
                    what the styling hangs off. */}
                <DBButton
                  type="button"
                  variant="filled"
                  size="medium"
                  width="full"
                  aria-pressed={seamTool}
                  disabled={!result}
                  onClick={() => {
                    setSeamTool((open) => !open);
                    setDeleteTool(false);
                  }}
                >
                  {seamTool ? "Trennlinien setzen beenden" : "Trennlinien setzen"}
                </DBButton>
                {seams.length > 0 ? (
                  <IconAction
                    icon="bin"
                    label={`Alle ${seams.length} ${
                      seams.length === 1 ? "Linie" : "Linien"
                    } entfernen`}
                    onClick={() => setSeams([])}
                  />
                ) : null}
              </div>
              {seamTool ? (
                <DBInfotext semantic="adaptive" size="small" showIcon={false}>
                  Klicken setzt eine Linie. Seitwärts ziehen macht sie kürzer, an
                  der Unterkante ziehen höher, in der Mitte ziehen verschiebt sie.
                  Option kopiert, Doppelklick entfernt.
                </DBInfotext>
              ) : null}

              <div className="tool-row">
                <DBButton
                  type="button"
                  variant="filled"
                  size="medium"
                  width="full"
                  icon="eraser"
                  aria-pressed={deleteTool}
                  disabled={!result}
                  onClick={() => {
                    setDeleteTool((open) => !open);
                    setSeamTool(false);
                  }}
                >
                  {deleteTool ? "Striche löschen beenden" : "Striche löschen"}
                </DBButton>
                {removedParts.length > 0 ? (
                  <>
                    <IconAction
                      icon="undo"
                      label="Letzte Löschung zurücknehmen"
                      onClick={() => setRemovedParts((current) => current.slice(0, -1))}
                    />
                    <IconAction
                      icon="bin"
                      label={`Alle ${removedParts.length} Striche zurückholen`}
                      onClick={() => setRemovedParts([])}
                    />
                  </>
                ) : null}
              </div>
              {deleteTool ? (
                <DBInfotext semantic="adaptive" size="small" showIcon={false}>
                  Klicken löscht den markierten Strich, Ziehen wischt mehrere weg.
                  Shift nimmt den ganzen zusammenhängenden Bereich. Gelöschtes
                  bleibt rot sichtbar, ein Klick darauf holt es zurück.
                </DBInfotext>
              ) : null}
            </DBStack>

            {error ? <DBInfotext semantic="critical">{error}</DBInfotext> : null}
          </div>
        </div>
      </DBShellSubNavigation>

      <DBShellContent variant="fixed" mainLabel="Vorschau">
        {result ? (
          <div className="workspace-preview">
            <header className="preview-head">
              <strong className="preview-title">{displayName}</strong>
              <DBButton
                type="button"
                variant="ghost"
                size="small"
                icon="pen"
                noText
                onClick={openNameDialog}
              >
                Namen bearbeiten
                <DBTooltip variant="label" placement="bottom">
                  Namen bearbeiten
                </DBTooltip>
              </DBButton>
            </header>

            <div className="preview-stage">
              <div className={compare ? "preview-compare" : "preview-single"}>
                <BarPreview
                  illustration={result.illustration}
                  unitSize={PREVIEW_UNIT_SIZE}
                  foreground={colour}
                  overlay={result.overlay}
                  overlayOpacity={overlayOpacity}
                  strokesOpacity={strokesOpacity}
                  sampledOpacity={sampledOpacity}
                  seams={seams}
                  onSeamsChange={seamTool ? changeSeams : undefined}
                  onDeletePart={deleteTool ? removePart : undefined}
                  removed={result.removed}
                  onRestorePart={restorePart}
                />

                {/* The second canvas: the same preview with the strokes hidden
                    and the template fully opaque. Reusing BarPreview keeps both
                    canvases at the identical box - the (invisible) graphic is
                    what gives the box its size, and the template stays aligned
                    to the fitted motif. */}
                {compare && result.overlay?.src ? (
                  <BarPreview
                    illustration={result.illustration}
                    unitSize={PREVIEW_UNIT_SIZE}
                    foreground={colour}
                    overlay={result.overlay}
                    overlayOpacity={1}
                    strokesOpacity={0}
                    sampledOpacity={0}
                  />
                ) : null}
              </div>

              {/* Directly under the canvas, centred with it. DBStack owns the
                  spacing so there is no custom layout css here. */}
              <DBStack direction="column" alignment="center" gap="small">
                <DBButton
                  type="button"
                  variant="filled"
                  size="medium"
                  icon="upload"
                  onClick={file.open}
                >
                  Ersetzen
                </DBButton>
              </DBStack>
            </div>

            <footer className="preview-foot">
              <div className="preview-meta">
                {result.warnings.map((warning, index) => (
                  <DBInfotext key={index} semantic="informational" size="small">
                    {warning}
                  </DBInfotext>
                ))}
                <DBInfotext semantic="adaptive" size="small" showIcon={false}>
                  {/* Stroke width, gap and safe area were listed here too, but they
                      are fixed by the system and never change - so they were noise
                      rather than information. The format is only repeated when no
                      warning already carries it, so it never shows twice. */}
                  {result.warnings.length === 0 ? `${formatLabel(result)} · ` : ""}
                  {result.illustration.bars.length} Striche
                </DBInfotext>
              </div>

              {/* One slider per layer, bottom to top: the template photo, the
                  strokes over it, the dp grid on top. Each fades its layer in and
                  out, so any combination can be compared. */}
              <DBCard className="preview-toolbar" spacing="small" elevationLevel="1">
                <label className="overlay-control" data-font-size="xs">
                  Vorlage {Math.round(overlayOpacity * 100)} %
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={overlayOpacity}
                    onChange={(event) => setOverlayOpacity(Number(event.target.value))}
                  />
                </label>
                <label className="overlay-control" data-font-size="xs">
                  Striche {Math.round(strokesOpacity * 100)} %
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={strokesOpacity}
                    onChange={(event) => setStrokesOpacity(Number(event.target.value))}
                  />
                </label>
                <label className="overlay-control" data-font-size="xs">
                  Raster {Math.round(sampledOpacity * 100)} %
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={sampledOpacity}
                    onChange={(event) => setSampledOpacity(Number(event.target.value))}
                  />
                </label>

                {/* Sits at the far end of the toolbar, toggling the second
                    canvas with the template beside the strokes. */}
                <DBButton
                  type="button"
                  className="preview-toolbar-compare"
                  variant="ghost"
                  size="medium"
                  icon="eye"
                  aria-pressed={compare}
                  disabled={!result.overlay?.src}
                  onClick={() => setCompare((open) => !open)}
                >
                  Vergleichen
                </DBButton>
              </DBCard>
            </footer>
          </div>
        ) : (
          <div className="preview-empty">
            <DBStack gap="large" alignment="center">
              <DBIcon className="preview-empty-icon" icon="image" weight="64" />
              <DBButton type="button" variant="brand" icon="upload" onClick={file.open}>
                Bild auswählen
              </DBButton>
              <DBInfotext semantic="adaptive" showIcon={false}>
                Am besten eine schwarze Silhouette auf weißem Hintergrund.
              </DBInfotext>
            </DBStack>
          </div>
        )}
      </DBShellContent>

      <DBDrawer
        variant="modal"
        containerSize="small"
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        header={<DBDrawerHeader closeButtonText="Schließen">Export</DBDrawerHeader>}
      >
        {/* Options fill the top, the confirm button is pinned full-width to the
            bottom of the drawer. */}
        <div className="drawer-body">
          <DBStack gap="medium">
            <DBSelect
              label="Format"
              value={exportFormat}
              onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
              options={[
                { value: "png", label: "PNG (Pixel)" },
                { value: "svg", label: "SVG (Vektor)" },
              ]}
            />

            {exportFormat === "png" ? (
              <DBSelect
                label="Breite"
                value={String(exportWidth)}
                onChange={(event) => setExportWidth(Number(event.target.value))}
                options={EXPORT_WIDTHS.map((width) => ({
                  value: String(width),
                  label: `${width} px`,
                }))}
              />
            ) : (
              <DBInfotext semantic="informational" size="small">
                SVG lässt sich beliebig groß skalieren.
              </DBInfotext>
            )}
          </DBStack>

          <DBButton
            type="button"
            variant="brand"
            icon="download"
            width="full"
            disabled={exporting}
            onClick={() => void runExport()}
          >
            {exporting ? "Exportiere …" : "Herunterladen"}
          </DBButton>
        </div>
      </DBDrawer>

      <DBDrawer
        variant="modal"
        containerSize="small"
        open={nameOpen}
        onClose={() => setNameOpen(false)}
        header={<DBDrawerHeader closeButtonText="Schließen">Name</DBDrawerHeader>}
      >
        {/* A form so Enter submits natively - quick type-and-return renaming.
            Field on top, confirm button pinned full-width to the bottom. */}
        <form
          className="drawer-body"
          onSubmit={(event) => {
            event.preventDefault();
            saveName();
          }}
        >
          <DBStack gap="medium">
            <DBInput
              label="Name der Grafik"
              variant="floating"
              value={nameDraft}
              autoFocus
              onChange={(event) => setNameDraft(event.target.value)}
            />
            <DBInfotext semantic="adaptive" size="small" showIcon={false}>
              Wird oben angezeigt und beim Export als Dateiname verwendet.
            </DBInfotext>
          </DBStack>

          <DBButton type="submit" variant="brand" icon="check" width="full">
            Übernehmen
          </DBButton>
        </form>
      </DBDrawer>
    </DBShell>
  );
}

/**
 * An icon only button that says what it does on hover and on focus.
 *
 * `noText` keeps the label as the accessible name but hides it visually, which
 * leaves sighted users guessing at the icon. The tooltip closes that gap, and
 * takes the label over as the accessible name (`variant="label"`) so the name is
 * announced once rather than twice. The label is passed in once and used for
 * both; the hidden text stays as a fallback name.
 */
function IconAction({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <DBButton
      type="button"
      variant="ghost"
      size="medium"
      icon={icon}
      noText
      onClick={onClick}
    >
      {label}
      <DBTooltip variant="label" placement="bottom">
        {label}
      </DBTooltip>
    </DBButton>
  );
}

/** Rasterises the SVG to a PNG of the requested width, keeping the aspect ratio. */
async function rasterize(
  svg: string,
  width: number,
  height: number,
  targetWidth: number,
): Promise<Blob> {
  const targetHeight = Math.max(1, Math.round((height / width) * targetWidth));

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("SVG konnte nicht geladen werden."));
    // A data URL keeps the canvas untainted, so toBlob stays available.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas nicht verfügbar.");
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG konnte nicht erzeugt werden."));
    }, "image/png");
  });
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** Outer format of the graphic: drawable area plus the safe area on both sides. */
function formatLabel(result: ConversionResult): string {
  const { canvas } = result.illustration;
  const width = canvas.widthUnits + canvas.paddingUnits * 2;
  const height = canvas.heightUnits + canvas.paddingUnits * 2;
  return `${width}×${height} dp`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "illustration"
  );
}
