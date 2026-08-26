import { beforeEach, describe, expect, it } from "vitest";
import {
  noteEditorDraftStorageKey,
  readStoredNoteEditorDraft,
} from "./noteEditorDraftStore";

describe("stored note editor draft browser boundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("preserves malformed authored recovery data while surfacing the defect", () => {
    const key = noteEditorDraftStorageKey("highlight:one");
    const malformed = JSON.stringify({ version: 1, unexpected: "Keep me" });
    window.localStorage.setItem(key, malformed);

    expect(() => readStoredNoteEditorDraft("highlight:one")).toThrow(
      "note editor draft must contain exactly",
    );
    expect(window.localStorage.getItem(key)).toBe(malformed);
  });
});
