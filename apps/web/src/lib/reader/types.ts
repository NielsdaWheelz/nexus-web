/**
 * Reader profile and resume state types.
 *
 * Backend contract assumptions:
 * - GET /api/me/reader-profile returns { data: ReaderProfile }
 * - PATCH /api/me/reader-profile accepts Partial<ReaderProfile>
 * - GET /api/media/{id}/reader-state returns { data: ReaderResumeState }
 * - PATCH /api/media/{id}/reader-state accepts Partial<ReaderResumeState>
 */

export type ReaderTheme = "light" | "dark";
export type ReaderFontFamily = "serif" | "sans";
export type LocatorKind = "fragment_offset" | "epub_section" | "pdf_page";

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

export interface ReaderResumeState {
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
