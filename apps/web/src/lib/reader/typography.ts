import type { CSSProperties } from "react";
import type { Schema } from "@/lib/api/wire";

/** Current reader typography, shared by mounted sources and frozen evidence; a companion shrinks evidence's size and sets its leading. */
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

/** The reader role, spread on one element: authored notes are set in the profile. `large` is where
 * signs step from 14px to 16px; the threshold lives here alone. */
export function readerType(profile: Readonly<Schema<"ReaderProfileOut">>): { "data-type-role": "reader"; "data-type-scale": "large" | undefined; style: CSSProperties } {
  return { "data-type-role": "reader", "data-type-scale": profile.font_size_px >= 20 ? "large" : undefined, style: readerSurfaceStyle(profile) };
}
