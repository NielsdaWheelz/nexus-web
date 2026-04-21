/**
 * Reader profile and locator types.
 *
 * Backend contract assumptions:
 * - GET /api/me/reader-profile returns { data: ReaderProfile }
 * - PATCH /api/me/reader-profile accepts Partial<ReaderProfile>
 * - GET /api/media/{id}/reader-state returns { data: ReaderLocator | null }
 * - PUT /api/media/{id}/reader-state accepts ReaderLocator | null
 */

export type ReaderTheme = "light" | "dark";
export type ReaderFontFamily = "serif" | "sans";

export interface ReaderProfile {
  theme: ReaderTheme;
  font_family: ReaderFontFamily;
  font_size_px: number;
  line_height: number;
  column_width_ch: number;
  focus_mode: boolean;
}

export const DEFAULT_READER_PROFILE: ReaderProfile = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: false,
};

export interface ReaderLocator {
  source: string | null;
  anchor: string | null;
  text_offset: number | null;
  quote: string | null;
  quote_prefix: string | null;
  quote_suffix: string | null;
  progression: number | null;
  total_progression: number | null;
  position: number | null;
  page: number | null;
  page_progression: number | null;
  zoom: number | null;
}
