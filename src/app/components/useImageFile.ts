"use client";

import { useCallback, useRef, useState } from "react";
import type { RasterImage } from "@/lib/illustration/imageMask";
import { DEMO_TEMPLATE_NAME, DEMO_TEMPLATE_SRC } from "./demoTemplate";

/** Longest edge the template is decoded to. Keeps the conversion instant. */
const DECODE_SIZE = 512;

export type ImageFile = {
  /** Attach to a visually hidden `<input type="file">`. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Pass to that input's `onChange`. */
  onInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  image: RasterImage | null;
  fileName: string | null;
  /** Data URL of the decoded bitmap, for the thumbnail. */
  preview: string | null;
  /** Opens the file dialog. */
  open: () => void;
  /** Loads the built in example template. */
  loadDemo: () => Promise<void>;
  clear: () => void;
};

/**
 * Owns the picked file and its decoded pixels.
 *
 * Extracted from the settings panel because the picker is needed in two places:
 * as the only call to action in the empty content area, and as "replace" once an
 * image is loaded. Both need to trigger the same hidden input.
 */
export function useImageFile(onError: (message: string) => void): ImageFile {
  const inputRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<RasterImage | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  /**
   * Draws a decoded image into a canvas at the working size and keeps the pixels.
   *
   * Shared by both sources so a file and the demo end up as exactly the same
   * raster, and the size the pipeline sees never depends on where it came from.
   */
  const store = useCallback(
    (
      source: CanvasImageSource,
      sourceWidth: number,
      sourceHeight: number,
      name: string,
    ) => {
      const scale = Math.min(1, DECODE_SIZE / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas nicht verfügbar");

      // The templates are silhouettes on white, so a transparent source has to land
      // on white rather than on nothing - otherwise every transparent pixel reads as
      // background of unknown brightness.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);

      const data = context.getImageData(0, 0, width, height);
      setImage({ width, height, data: data.data });
      setFileName(name);
      setPreview(canvas.toDataURL("image/png"));
    },
    [],
  );

  const load = useCallback(
    async (file: File) => {
      try {
        const bitmap = await createImageBitmap(file);
        store(bitmap, bitmap.width, bitmap.height, file.name);
        bitmap.close?.();
      } catch {
        onError("Das Bild konnte nicht gelesen werden. Bitte PNG, JPG oder WebP verwenden.");
      }
    },
    [onError, store],
  );

  /**
   * Loads the built in demo template.
   *
   * Goes through `Image` rather than `createImageBitmap`: the demo is an SVG, and
   * browser support for decoding SVG that way is patchy, while an `Image` element
   * handles it everywhere. The same reason the export rasterises through an
   * `Image`.
   */
  const loadDemo = useCallback(async () => {
    try {
      const element = new Image();
      await new Promise<void>((resolve, reject) => {
        element.onload = () => resolve();
        element.onerror = () => reject(new Error("demo failed to decode"));
        element.src = DEMO_TEMPLATE_SRC;
      });

      // An SVG has no intrinsic pixel size to rely on, so fall back to the working
      // size when the browser reports none.
      const width = element.naturalWidth || DECODE_SIZE;
      const height = element.naturalHeight || DECODE_SIZE;
      store(element, width, height, DEMO_TEMPLATE_NAME);
    } catch {
      onError("Das Beispiel konnte nicht geladen werden.");
    }
  }, [onError, store]);

  const onInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void load(file);
    },
    [load],
  );

  const open = useCallback(() => inputRef.current?.click(), []);

  const clear = useCallback(() => {
    setImage(null);
    setFileName(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  return { inputRef, onInputChange, image, fileName, preview, open, loadDemo, clear };
}
