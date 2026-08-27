import { describe, expect, it } from "vitest";
import { decodeStoredNoteEditorDraft } from "./noteEditorDraftStore";

const DRAFT = {
  version: 1,
  bodyPmJson: {
    type: "paragraph",
    content: [{ type: "text", text: "Exact draft" }],
  },
  bodyText: "Exact draft",
  metadata: { blockId: "block-1" },
  sequence: 2,
  clientMutationId: "note-2-aaaaaaaa-1111-4111-8111-111111111111",
  updatedAt: "2026-08-26T00:00:00Z",
};

describe("stored note editor draft contract", () => {
  it("decodes the exact current draft", () => {
    expect(decodeStoredNoteEditorDraft(DRAFT)).toEqual({
      version: 1,
      body: {
        bodyPmJson: DRAFT.bodyPmJson,
        bodyText: DRAFT.bodyText,
      },
      metadata: DRAFT.metadata,
      sequence: DRAFT.sequence,
      clientMutationId: DRAFT.clientMutationId,
      updatedAt: DRAFT.updatedAt,
    });
  });

  it("rejects extra and legacy fields", () => {
    expect(() =>
      decodeStoredNoteEditorDraft({ ...DRAFT, legacyBody: "Exact draft" }),
    ).toThrow("note editor draft must contain exactly");
  });

  it("rejects mismatched projections and mutation identities", () => {
    expect(() =>
      decodeStoredNoteEditorDraft({ ...DRAFT, bodyText: "Different" }),
    ).toThrow("note editor draft.bodyText must match bodyPmJson");
    expect(() =>
      decodeStoredNoteEditorDraft({
        ...DRAFT,
        clientMutationId: "note-3-aaaaaaaa-1111-4111-8111-111111111111",
      }),
    ).toThrow("must match its sequence and canonical UUID");
  });

  it("rejects malformed body JSON and timestamps without deleting data", () => {
    expect(() =>
      decodeStoredNoteEditorDraft({
        ...DRAFT,
        bodyPmJson: { type: "unknown" },
      }),
    ).toThrow("note editor draft.bodyPmJson must be a valid note body");
    expect(() =>
      decodeStoredNoteEditorDraft({ ...DRAFT, updatedAt: "yesterday" }),
    ).toThrow("note editor draft.updatedAt must be an ISO 8601 aware instant");
  });
});
