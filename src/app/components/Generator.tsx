"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { RangeInput } from "./Setting";
import { useImageFile } from "./useImageFile";
import { renderIllustration } from "@/lib/illustration/renderer";
import { DP } from "@/lib/illustration/geometry";
import type { ConversionResult } from "@/lib/illustration/result";
import type { SegmentAnchor } from "@/lib/illustration/segments";
import type { AddedStroke } from "@/lib/illustration/strokes";
import type { Seam } from "@/lib/illustration/signature";
import { DEMO_TEMPLATE_PRESET } from "./demoTemplate";
import type { TemplateSettings } from "./ImageTemplate";

/**
 * The preview is always rendered at this pixel size per dp and scaled to fit
 * its stage. Output size is a concern of the export, so changing the target
 * size can never make the preview overflow.
 */
const PREVIEW_UNIT_SIZE = 3;

/** Target widths in pixels for the raster export. */
const EXPORT_WIDTHS = [512, 1024, 2048, 4096];

/**
 * Added to a template search, so the results are the kind of image that converts.
 *
 * Each word earns its place: `silhouette` gets a filled shape rather than an
 * outline, `clipart` and `flat` push photographs and 3D renders down the results,
 * and `black on white` is the contrast the threshold works best on. Without them a
 * plain search returns mostly photos, which are the hardest case for the converter.
 *
 * The search opens in a new tab rather than being fetched: reading the pixels of a
 * third party image needs permissive CORS headers, which image hosts do not send,
 * and every API that returns results needs a key this static app cannot keep
 * secret. Handing the query to Google and letting the file arrive through the
 * normal picker avoids both, and leaves the licence decision with the user.
 */
const SEARCH_KEYWORDS = "silhouette clipart flat black on white";

/** Google Images for a template, with the keywords that make results usable. */
function templateSearchUrl(term: string): string {
  const query = encodeURIComponent(`${term.trim()} ${SEARCH_KEYWORDS}`);
  // `tbm=isch` is the image tab.
  return `https://www.google.com/search?q=${query}&tbm=isch`;
}

/** How far one press of the zoom buttons takes it. */
const ZOOM_STEP = 1.25;

/** Zoom range, as a multiple of the canvas's natural size at PREVIEW_UNIT_SIZE. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

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

  // Canvas zoom, as a multiple of the canvas's natural size. A template opens at
  // 100 %, so a graphic is always first seen at one pixel per rendered unit rather
  // than at whatever size the window happens to allow.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);

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

  // Strokes drawn by hand: a mast, an aerial, a flagpole - things too thin to
  // survive thresholding, or simply not in the template. Stored as slots and rows
  // on the drawable grid, so like the seams they keep their meaning when a setting
  // moves and the geometry is rebuilt.
  const [addedStrokes, setAddedStrokes] = useState<AddedStroke[]>([]);
  const [drawTool, setDrawTool] = useState(false);

  // Deleting an added stroke takes the addition back rather than recording a
  // removal. Additions are applied after the removals, so an anchor pointing at one
  // would never catch it - and a stroke that visibly ignores the delete tool reads
  // as a bug. Gone means gone here; the draw tool's undo is what brings it back.
  const deleteAddedStroke = useCallback((index: number) => {
    setAddedStrokes((current) => current.filter((_, at) => at !== index));
  }, []);

  // The preview owns the whole gesture and reports the resulting list. Strokes
  // sharing a slot and row are folded together, so drawing twice over the same
  // place does not stack duplicates that behave as one.
  const changeAddedStrokes = useCallback((next: AddedStroke[]) => {
    const seen = new Set<string>();
    setAddedStrokes(
      next.filter((stroke) => {
        const key = `${stroke.slot}:${stroke.row}:${stroke.height}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }, []);

  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const zoomBy = useCallback(
    (factor: number) => setZoom((current) => clampZoom(current * factor)),
    [],
  );

  // Ctrl/Cmd plus the wheel zooms the canvas instead of the page, which is also
  // how a trackpad pinch arrives. Registered by hand because React attaches wheel
  // listeners passively, and `preventDefault` does nothing on a passive listener -
  // the browser would zoom the whole page alongside.
  //
  // Keyed on whether there is a result, because that is when the viewport exists:
  // with no dependency the effect ran once on mount, found the ref still empty and
  // never came back, so the listener was never attached at all.
  const hasResult = result !== null;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // Exponential, so the same wheel movement changes the zoom by the same ratio
      // at every level - a linear step crawls when zoomed in and jumps when out.
      setZoom((current) => clampZoom(current * Math.exp(-event.deltaY / 200)));
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [hasResult]);

  // A name the user has set by hand, overriding the one derived from the file.
  // Drives both the title and the export file name. Reset when the template goes.
  const [customName, setCustomName] = useState<string | null>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  // Template search. Only the term is ours to keep; the results live in a new tab,
  // and the chosen file comes back through the normal picker.
  const [searchTerm, setSearchTerm] = useState("");

  const openSearch = useCallback(() => {
    const term = searchTerm.trim();
    if (term.length === 0) return;
    // `noopener` and `noreferrer`: the new tab gets no handle back onto this one.
    window.open(templateSearchUrl(term), "_blank", "noopener,noreferrer");
  }, [searchTerm]);

  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [exportWidth, setExportWidth] = useState(1024);
  const [exporting, setExporting] = useState(false);

  const file = useImageFile(setError);
  const hasImage = Boolean(file.image);

  // Preset capture, switched on with `?preset` in the URL.
  //
  // The sliders can simply be read off the panel, but the seams and the removals
  // cannot - they are coordinates on the grid. So there has to be a way to read the
  // current state out as a value. Behind a URL flag rather than in the interface:
  // it is a tool for setting up a preset, not something to explain to everyone.
  const [presetMode, setPresetMode] = useState(false);
  const [presetCopied, setPresetCopied] = useState(false);

  useEffect(() => {
    setPresetMode(new URLSearchParams(window.location.search).has("preset"));
  }, []);

  // Counts the templates loaded so far. Used as the settings panel's key, so a
  // new image remounts it and every construction setting is back at its default.
  // The settings belong to the template they were dialled in for; carrying a
  // threshold tuned for one motif over to the next is never what is wanted.
  const [templateGeneration, setTemplateGeneration] = useState(0);

  // Start values for the settings panel. Set for the demo, which opens as a worked
  // example, and cleared for a picked file, which starts from the defaults. Read
  // when the panel mounts, which is why it changes together with the generation.
  const [initialSettings, setInitialSettings] = useState<TemplateSettings | undefined>(
    undefined,
  );

  // Everything the user built on top of the old template goes when a new one
  // arrives: the tools, their results, and the name derived from the file. Done
  // here rather than in the hook so the hook stays about files only.
  const resetForNewTemplate = useCallback(() => {
    setSeams([]);
    setSeamTool(false);
    setRemovedParts([]);
    setDeleteTool(false);
    setAddedStrokes([]);
    setDrawTool(false);
    setCustomName(null);
    setError(null);
    // Back to 100 %: a zoom dialled in for one motif says nothing about the next,
    // and a new template can have a different format entirely.
    setZoom(1);
    setTemplateGeneration((generation) => generation + 1);
  }, []);

  const loadTemplate = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      resetForNewTemplate();
      setInitialSettings(undefined);
      file.onInputChange(event);
    },
    [file, resetForNewTemplate],
  );

  // The demo opens as a finished example rather than at the defaults, so it shows
  // what the tool is for straight away - including the seams, which are the part
  // nobody would find by guessing. Applied after the reset, so it wins.
  const loadDemo = useCallback(() => {
    resetForNewTemplate();
    setInitialSettings(DEMO_TEMPLATE_PRESET.settings);
    setSeams(DEMO_TEMPLATE_PRESET.seams);
    setColour(DEMO_TEMPLATE_PRESET.colour);
    setCustomName(DEMO_TEMPLATE_PRESET.name);
    void file.loadDemo();
  }, [file, resetForNewTemplate]);

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

  /**
   * Puts the current state on the clipboard as JSON, and logs it as a fallback for
   * when the clipboard is not available.
   */
  const copyPreset = useCallback(() => {
    if (!result) return;

    const preset = {
      name: displayName,
      settings: result.settings,
      colour,
      seams,
      removedParts,
      addedStrokes,
    };

    const json = JSON.stringify(preset, null, 2);
    console.log("Preset:\n" + json);
    void navigator.clipboard?.writeText(json).then(
      () => {
        setPresetCopied(true);
        window.setTimeout(() => setPresetCopied(false), 2000);
      },
      () => setPresetCopied(false),
    );
  }, [result, colour, seams, removedParts, addedStrokes, displayName]);

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
              Erst eine Vorlage auswählen, dann sind die Einstellungen verfügbar.
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
                Zuerst eine Vorlage auswählen.
              </DBInfotext>
            ) : null}

            <ImageTemplate
              key={templateGeneration}
              file={file}
              allowExtendedFormat={allowExtendedFormat}
              manualSeams={seams}
              removedParts={removedParts}
              addedStrokes={addedStrokes}
              initial={initialSettings}
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
                    setDrawTool(false);
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
                    setDrawTool(false);
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
                  bleibt rot sichtbar, ein Klick darauf holt es zurück. Ergänzte
                  Striche werden dabei ganz entfernt.
                </DBInfotext>
              ) : null}

              <div className="tool-row">
                <DBButton
                  type="button"
                  variant="filled"
                  size="medium"
                  width="full"
                  aria-pressed={drawTool}
                  disabled={!result}
                  onClick={() => {
                    setDrawTool((open) => !open);
                    setSeamTool(false);
                    setDeleteTool(false);
                  }}
                >
                  {drawTool ? "Striche ergänzen beenden" : "Striche ergänzen"}
                </DBButton>
                {addedStrokes.length > 0 ? (
                  <>
                    <IconAction
                      icon="undo"
                      label="Letzten Strich zurücknehmen"
                      onClick={() => setAddedStrokes((current) => current.slice(0, -1))}
                    />
                    <IconAction
                      icon="bin"
                      label={`Alle ${addedStrokes.length} ergänzten Striche entfernen`}
                      onClick={() => setAddedStrokes([])}
                    />
                  </>
                ) : null}
              </div>
              {drawTool ? (
                <DBInfotext semantic="adaptive" size="small" showIcon={false}>
                  Klicken setzt einen Strich von {DP.minStrokeLength} dp. Beim Ziehen
                  wächst er mit, an den Enden ziehen ändert die Höhe, in der Mitte
                  ziehen verschiebt ihn. Option an den Enden wächst nach beiden
                  Seiten, Option in der Mitte kopiert. Doppelklick entfernt.
                </DBInfotext>
              ) : null}
            </DBStack>

            {/* Only with `?preset` in the URL. Copies the current state as JSON so
                it can be pasted in as a template's starting point. */}
            {presetMode ? (
              <DBButton
                type="button"
                variant="ghost"
                size="medium"
                width="full"
                icon="copy"
                disabled={!result}
                onClick={copyPreset}
              >
                {presetCopied ? "Preset kopiert" : "Preset kopieren"}
              </DBButton>
            ) : null}

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

              {/* Opposite the name, because it belongs to the artefact rather than
                  to the view of it: this row is what the graphic *is*, the toolbar
                  below is how it is displayed. It also has to stay out of the
                  canvas window, which scrolls once the graphic is zoomed in. */}
              <DBButton
                className="preview-replace"
                type="button"
                variant="filled"
                size="medium"
                icon="upload"
                onClick={file.open}
              >
                Ersetzen
              </DBButton>
            </header>

            <div className="preview-stage">
              {/* The scrolling window onto the canvas. Zooming past its edges
                  scrolls here, so the actions below stay where they are. */}
              <div className="preview-viewport" ref={viewportRef}>
                <div className={compare ? "preview-compare" : "preview-single"}>
                  <BarPreview
                    illustration={result.illustration}
                    unitSize={PREVIEW_UNIT_SIZE}
                    scale={zoom}
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
                    addedStrokes={addedStrokes}
                    onAddedStrokesChange={drawTool ? changeAddedStrokes : undefined}
                    onDeleteAddedStroke={deleteTool ? deleteAddedStroke : undefined}
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
                      scale={zoom}
                      foreground={colour}
                      overlay={result.overlay}
                      overlayOpacity={1}
                      strokesOpacity={0}
                      sampledOpacity={0}
                    />
                  ) : null}
                </div>
              </div>
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
                  <RangeInput
                    min={0}
                    max={1}
                    step={0.05}
                    value={overlayOpacity}
                    onChange={setOverlayOpacity}
                  />
                </label>
                <label className="overlay-control" data-font-size="xs">
                  Striche {Math.round(strokesOpacity * 100)} %
                  <RangeInput
                    min={0}
                    max={1}
                    step={0.05}
                    value={strokesOpacity}
                    onChange={setStrokesOpacity}
                  />
                </label>
                <label className="overlay-control" data-font-size="xs">
                  Raster {Math.round(sampledOpacity * 100)} %
                  <RangeInput
                    min={0}
                    max={1}
                    step={0.05}
                    value={sampledOpacity}
                    onChange={setSampledOpacity}
                  />
                </label>

                {/* Zoom: out, the current level, in. The level doubles as the way
                    back to 100 %, so the three sit together as one control instead
                    of needing a fourth. */}
                <div className="zoom-control">
                  <IconAction
                    icon="minus"
                    label="Verkleinern"
                    disabled={zoom <= MIN_ZOOM}
                    onClick={() => zoomBy(1 / ZOOM_STEP)}
                  />
                  <DBButton
                    type="button"
                    variant="ghost"
                    size="medium"
                    disabled={zoom === 1}
                    onClick={() => setZoom(1)}
                  >
                    {Math.round(zoom * 100)} %
                    <DBTooltip placement="top">Auf 100 % zoomen</DBTooltip>
                  </DBButton>
                  <IconAction
                    icon="plus"
                    label="Vergrößern"
                    disabled={zoom >= MAX_ZOOM}
                    onClick={() => zoomBy(ZOOM_STEP)}
                  />
                </div>

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
            <DBStack className="empty-stack" gap="large" alignment="center">
              <DBIcon className="preview-empty-icon" icon="image" weight="64" />

              {/* Sits above the actions as a description of them, not below as an
                  afterthought. Says what to do; what makes a good template is the
                  search field's job further down and the README's. */}
              <DBInfotext id="pick-template-help" semantic="adaptive" showIcon={false}>
                Teste die Demo oder wähle eine eigene Vorlage.
              </DBInfotext>

              {/* The two ways in, grouped: pick or demo on one row, search on the
                  next. Grouped so the two rows sit at the same spacing as the
                  buttons within a row, while the description above keeps the
                  larger gap of the outer stack. */}
              <div className="empty-entry">
                {/* Two ways in, side by side: bring your own template, or see what
                    the tool does without having to find a suitable image first. */}
                <DBStack className="empty-actions" direction="row" gap="small">
                  {/* The description above applies to this button, so it is
                      referenced here. `aria-*` props are passed straight through to
                      the button element. */}
                  <DBButton
                    type="button"
                    variant="brand"
                    icon="upload"
                    aria-describedby="pick-template-help"
                    onClick={file.open}
                  >
                    Vorlage auswählen
                  </DBButton>
                  <DBButton
                    type="button"
                    variant="filled"
                    icon="image"
                    onClick={loadDemo}
                  >
                    Demo laden
                  </DBButton>
                </DBStack>

                {/* No template to hand: search for one. A form, so Enter submits.
                    The results open in a new tab and the file comes back through the
                    picker above - see SEARCH_KEYWORDS for why it works this way.

                    No icon on the button: `type="search"` already draws a magnifier
                    inside the field, and a second one reads as a mistake. */}
                <form
                  className="template-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    openSearch();
                  }}
                >
                  {/* `required` rather than a disabled button: submitting an empty
                      field asks for it natively, which is feedback where a dead
                      button gives none. The browser blocks the submit, so the form's
                      own handler never runs. The asterisk is off - there is one field
                      here, and nothing to complete. */}
                  <DBInput
                    label="Vorlage suchen"
                    variant="floating"
                    type="search"
                    placeholder="z. B. Fernsehturm Berlin"
                    value={searchTerm}
                    required
                    showRequiredAsterisk={false}
                    // Suppresses the browser's own validation bubble, which is drawn
                    // by the browser and looks nothing like the design system. The
                    // validation itself stays: the submit is still blocked, the field
                    // still matches `:user-invalid`, and DB's own red message below
                    // the field is the one that shows.
                    onInvalid={(event) => event.preventDefault()}
                    onChange={(event) => setSearchTerm(event.target.value)}
                  />
                  {/* The tooltip can live on the submit button because it is never
                      disabled - `required` covers the empty case instead. A disabled
                      button receives no mouse events, so a tooltip on one can never
                      close again once shown. */}
                  <DBButton type="submit" variant="filled">
                    Suchen
                    <DBTooltip placement="top">
                      Öffnet die Bildersuche in einem neuen Tab. Bild herunterladen,
                      dann oben auswählen.
                    </DBTooltip>
                  </DBButton>
                </form>
              </div>
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
            {/* `ariaDescribedBy` is the documented way to override the automatic
                handling, and it replaces the ids DBInput would generate itself. That
                is safe here only because this field has no message, validMessage or
                invalidMessage - there is nothing to replace. Adding one of those
                later means folding its id in here too, otherwise the validation text
                silently loses its association. */}
            <DBInput
              label="Name der Grafik"
              variant="floating"
              value={nameDraft}
              autoFocus
              ariaDescribedBy="graphic-name-help"
              onChange={(event) => setNameDraft(event.target.value)}
            />
            <DBInfotext
              id="graphic-name-help"
              semantic="adaptive"
              size="small"
              showIcon={false}
            >
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
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <DBButton
      type="button"
      variant="ghost"
      size="medium"
      icon={icon}
      noText
      disabled={disabled}
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
