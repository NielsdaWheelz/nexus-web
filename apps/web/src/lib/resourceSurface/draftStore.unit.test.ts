import { describe, expect, it } from "vitest";
import { decodeResourceSurfaceDraft } from "./draftStore";

const PAGE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const NOTE_ID = "bbbbbbbb-1111-4111-8111-111111111111";
const MUTATION_ID = "cccccccc-1111-4111-8111-111111111111";
const PAGE_REF = `page:${PAGE_ID}`;
const NOTE_REF = `note_block:${NOTE_ID}`;
const BODY_PM_JSON = {
  type: "paragraph",
  content: [{ type: "text", text: "Exact draft" }],
};

const PAGE_ITEM = {
  ref: PAGE_REF,
  scheme: "page",
  id: PAGE_ID,
  label: "Page",
  summary: "",
  route: `/pages/${PAGE_ID}`,
  activation: {
    resourceRef: PAGE_REF,
    kind: "route",
    href: `/pages/${PAGE_ID}`,
    unresolvedReason: null,
  },
  missing: false,
  capabilities: {
    userRelation: {
      userLinkSource: false,
      userLinkTarget: "none",
      noteReferenceTarget: false,
    },
    sharing: "None",
    libraryPlacement: "None",
    attachable: false,
    chatSubject: "none",
    readable: "none",
    inspectable: "none",
    citableResultType: null,
    citationOutputSource: false,
    appSearchScope: false,
    conversationSearchScope: false,
    promptRender: "none",
    expansionPolicy: "none",
    expandable: false,
    adjacencySource: true,
    adjacencyTarget: true,
  },
  versionByLane: { title: 1, outgoing_edges: 1 },
};

const DRAFT = {
  version: 1,
  source_ref: PAGE_REF,
  acknowledged_surface: {
    source: {
      item: PAGE_ITEM,
      content: { kind: "page_title", title: "Page" },
    },
    orderedItems: [],
  },
  commands: [
    {
      clientMutationId: MUTATION_ID,
      command: {
        type: "insert_note",
        noteId: NOTE_ID,
        position: { kind: "start" },
        bodyPmJson: BODY_PM_JSON,
      },
      position: { kind: "start" },
    },
  ],
  title: { value: "Edited", client_mutation_id: MUTATION_ID },
  bodies: {
    [NOTE_REF]: {
      body_pm_json: BODY_PM_JSON,
      body_text: "Exact draft",
      client_mutation_id: MUTATION_ID,
    },
  },
};

describe("resource surface draft contract", () => {
  it("decodes the exact current persisted draft", () => {
    expect(decodeResourceSurfaceDraft(DRAFT, PAGE_REF)).toEqual(DRAFT);
  });

  it("rejects extra fields and alternate snapshot casing", () => {
    expect(() =>
      decodeResourceSurfaceDraft({ ...DRAFT, legacy: true }, PAGE_REF),
    ).toThrow("resource surface draft must contain exactly");
    expect(() =>
      decodeResourceSurfaceDraft(
        {
          ...DRAFT,
          acknowledged_surface: {
            ...DRAFT.acknowledged_surface,
            ordered_items: [],
          },
        },
        PAGE_REF,
      ),
    ).toThrow("resource surface snapshot must contain exactly");
  });

  it("binds the storage key, mutation identity, and body projection", () => {
    expect(() => decodeResourceSurfaceDraft(DRAFT, `page:${NOTE_ID}`)).toThrow(
      "resource surface draft.source_ref must match its key",
    );
    expect(() =>
      decodeResourceSurfaceDraft(
        {
          ...DRAFT,
          commands: [
            { ...DRAFT.commands[0], clientMutationId: "not-a-uuid" },
          ],
        },
        PAGE_REF,
      ),
    ).toThrow("must be a canonical lowercase UUID");
    expect(() =>
      decodeResourceSurfaceDraft(
        {
          ...DRAFT,
          commands: [
            {
              ...DRAFT.commands[0],
              command: {
                ...DRAFT.commands[0].command,
                bodyPmJson: { type: "unknown_legacy_node" },
              },
            },
          ],
        },
        PAGE_REF,
      ),
    ).toThrow("must be a valid note body");
    expect(() =>
      decodeResourceSurfaceDraft(
        {
          ...DRAFT,
          bodies: {
            [NOTE_REF]: { ...DRAFT.bodies[NOTE_REF], body_text: "Different" },
          },
        },
        PAGE_REF,
      ),
    ).toThrow("bodyText must match bodyPmJson");
  });
});
