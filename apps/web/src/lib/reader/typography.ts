import type { CSSProperties } from "react";
import type { Schema } from "@/lib/api/wire";

/** Current reader typography, shared by mounted sources and frozen evidence. */
export const READER_FONT_STACKS: Record<Schema<"ReaderProfileOut">["font_family"], string> = {
  serif: "Iowan Old Style, Palatino Linotype, Book Antiqua, Palatino, Georgia, Times New Roman, serif",
  sans: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

export function readerSurfaceStyle(profile: Readonly<Schema<"ReaderProfileOut">>): CSSProperties {
  // justify-type-assertion: React's style type omits CSS custom properties.
  return {
    "--reader-font-family": READER_FONT_STACKS[profile.font_family],
    "--reader-font-size-px": `${profile.font_size_px}px`,
    "--reader-line-height": String(profile.line_height),
    "--reader-column-width-ch": `${profile.column_width_ch}ch`,
  } as CSSProperties;
}
