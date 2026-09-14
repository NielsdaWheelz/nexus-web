export const READER_APPARATUS_KINDS = [
  "footnote_ref", "endnote_ref", "bibliography_ref", "sidenote_ref", "margin_note_ref",
  "footnote", "endnote", "bibliography_entry", "sidenote", "margin_note", "reference_section",
] as const;
export type ReaderApparatusKind = (typeof READER_APPARATUS_KINDS)[number];

export const READER_APPARATUS_CONFIDENCES = ["exact", "strong", "probable"] as const;
export type ReaderApparatusConfidence = (typeof READER_APPARATUS_CONFIDENCES)[number];

export const READER_APPARATUS_RELATIONS = [
  "points_to_note", "points_to_endnote", "points_to_sidenote", "points_to_margin_note",
  "cites_bibliography_entry", "backlink_to_marker", "contains_reference",
] as const;
export type ReaderApparatusRelation = (typeof READER_APPARATUS_RELATIONS)[number];
