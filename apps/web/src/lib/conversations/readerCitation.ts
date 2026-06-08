import type { ReaderSourceTarget } from "./readerTarget";

export type ReaderCitationColor =
  | "yellow"
  | "green"
  | "blue"
  | "pink"
  | "purple"
  | "neutral";

export interface ReaderCitationPreview {
  title?: string;
  excerpt?: string;
  summary?: string;
  meta?: string[];
  copyText?: string;
}

export interface ReaderCitationData {
  index: number;
  color: ReaderCitationColor;
  preview: ReaderCitationPreview;
  target: ReaderSourceTarget | null;
  href?: string | null;
}

const READER_CITATION_COLORS: ReaderCitationColor[] = [
  "yellow",
  "green",
  "blue",
  "pink",
  "purple",
];

export function readerCitationColorForIndex(
  index: number,
): ReaderCitationColor {
  return (
    READER_CITATION_COLORS[(index - 1) % READER_CITATION_COLORS.length] ??
    "neutral"
  );
}
