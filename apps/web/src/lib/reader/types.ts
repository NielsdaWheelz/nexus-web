/**
 * Reader profile and state types.
 *
 * Backend contract assumptions:
 * - GET /api/me/reader-profile returns { data: ReaderProfile }
 * - PATCH /api/me/reader-profile accepts Partial<ReaderProfile>
 * - GET /api/media/{id}/reader-state returns { data: ReaderState }
 * - PATCH /api/media/{id}/reader-state accepts Partial<ReaderState>
 */

export type ReaderTheme = "light" | "dark" | "sepia";
export type ReaderFontFamily = "serif" | "sans";
export type ReaderViewMode = "scroll" | "paged";
export type LocatorKind = "fragment_offset" | "epub_section" | "pdf_page";

export interface ReaderProfile {
  theme: ReaderTheme;
  font_family: ReaderFontFamily;
  font_size_px: number;
  line_height: number;
  column_width_ch: number;
  focus_mode: boolean;
  default_view_mode: ReaderViewMode;
}

export const DEFAULT_READER_PROFILE: ReaderProfile = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: false,
  default_view_mode: "scroll",
};

export interface ReaderState {
  theme: ReaderTheme;
  font_family: ReaderFontFamily;
  font_size_px: number;
  line_height: number;
  column_width_ch: number;
  focus_mode: boolean;
  view_mode: ReaderViewMode;
  locator_kind: LocatorKind | null;
  /** For fragment_offset: optional fragment anchor + offset */
  fragment_id: string | null;
  offset: number | null;
  /** For epub_section: section_id from navigation */
  section_id: string | null;
  /** For pdf_page: 1-based page number */
  page: number | null;
  /** Optional PDF zoom if available */
  zoom: number | null;
}

export const DEFAULT_READER_STATE: ReaderState = {
  theme: DEFAULT_READER_PROFILE.theme,
  font_family: DEFAULT_READER_PROFILE.font_family,
  font_size_px: DEFAULT_READER_PROFILE.font_size_px,
  line_height: DEFAULT_READER_PROFILE.line_height,
  column_width_ch: DEFAULT_READER_PROFILE.column_width_ch,
  focus_mode: DEFAULT_READER_PROFILE.focus_mode,
  view_mode: DEFAULT_READER_PROFILE.default_view_mode,
  locator_kind: null,
  fragment_id: null,
  offset: null,
  section_id: null,
  page: null,
  zoom: null,
};
