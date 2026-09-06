"use client";

import { useCallback, useRef, useState } from "react";
import type { RasterImage } from "@/lib/illustration/imageMask";

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

  const load = useCallback(
    async (file: File) => {
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, DECODE_SIZE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas nicht verfügbar");

        context.drawImage(bitmap, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height);
        bitmap.close?.();

        setImage({ width, height, data: data.data });
        setFileName(file.name);
        setPreview(canvas.toDataURL("image/png"));
      } catch {
        onError("Das Bild konnte nicht gelesen werden. Bitte PNG, JPG oder WebP verwenden.");
      }
    },
    [onError],
  );

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

  return { inputRef, onInputChange, image, fileName, preview, open, clear };
}
