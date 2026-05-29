import type { CSSProperties } from "react";
import type { ReaderProfile } from "@/lib/reader/types";

export function buildReaderSurfaceStyle(profile: ReaderProfile): CSSProperties {
  const readerFontFamily =
    profile.font_family === "sans"
      ? "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif";

  return {
    "--reader-font-family": readerFontFamily,
    "--reader-font-size-px": `${profile.font_size_px}px`,
    "--reader-line-height": String(profile.line_height),
    "--reader-column-width-ch": `${profile.column_width_ch}ch`,
  } as CSSProperties;
}
