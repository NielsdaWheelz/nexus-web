import type { FeedbackContent } from "@/components/feedback/Feedback";
import {
  getFileUploadError,
  getFileUploadKind,
  type UploadFileKind,
} from "@/lib/imports/ingest";

export type DraftSource =
  | { readonly kind: "Url"; readonly text: string }
  | { readonly kind: "File"; readonly file: File };

export type AddSource =
  | { readonly kind: "Url"; readonly url: string }
  | {
      readonly kind: "File";
      readonly file: File;
      readonly fileKind: UploadFileKind;
    };

export type DraftValidation =
  | { kind: "Empty" }
  | { kind: "Invalid"; feedback: FeedbackContent }
  | { kind: "Ready"; source: AddSource };

const LIST_DELIMITER = /,\s+|\r\n?|\n|\t/u;

/** Commas are separators only before whitespace; URL punctuation stays intact. */
export function parseAddUrlList(text: string): {
  hasDelimiters: boolean;
  cells: readonly string[];
} {
  const trimmed = text.trim();
  return {
    hasDelimiters: LIST_DELIMITER.test(trimmed),
    cells: trimmed
      .split(LIST_DELIMITER)
      .map((cell) => cell.trim())
      .filter((cell) => cell !== ""),
  };
}

function validUrl(text: string): boolean {
  // URL repairs missing authority slashes and backslashes; reject those inputs.
  if (!/^https?:\/\/[^/?#\\]+/i.test(text) || /[\s\\]/u.test(text)) {
    return false;
  }
  try {
    return new URL(text).hostname !== "";
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export function validateDraftSource(source: DraftSource): DraftValidation {
  switch (source.kind) {
    case "Url": {
      const url = source.text.trim();
      if (url === "") return { kind: "Empty" };
      return validUrl(url)
        ? { kind: "Ready", source: { kind: "Url", url } }
        : {
            kind: "Invalid",
            feedback: {
              tone: "Danger",
              title: "Use an http:// or https:// link.",
            },
          };
    }
    case "File": {
      const error = getFileUploadError(source.file);
      const fileKind = getFileUploadKind(source.file);
      return error !== null || fileKind === null
        ? {
            kind: "Invalid",
            feedback: {
              tone: "Danger",
              title: error ?? "Only PDF and EPUB files are supported.",
            },
          }
        : { kind: "Ready", source: { ...source, fileKind } };
    }
  }
}

/** A no-space comma is ambiguous: offer this split without applying it. */
export function findAmbiguousUrlSplit(text: string): readonly string[] | null {
  const cells = text.trim().split(/,(?=https?:\/\/)/i);
  return cells.length >= 2 && cells.every(validUrl) ? cells : null;
}
