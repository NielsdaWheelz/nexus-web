import { describe, expect, it } from "vitest";
import type {
  ResourceItem,
  ResourceSurface,
} from "@/lib/resources/resourceItems";
import {
  createResourceSurfaceIntent,
  materializeResourceSurfaceIntent,
  projectResourceSurface,
  projectResourceSurfaceCommand,
  resourceSurfaceLaneVersion,
} from "./model";

const PAGE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const NOTE_ID = "bbbbbbbb-1111-4111-8111-111111111111";
const NEW_NOTE_ID = "cccccccc-1111-4111-8111-111111111111";
const FIRST_OCCURRENCE_ID = "dddddddd-1111-4111-8111-111111111111";
const SECOND_OCCURRENCE_ID = "eeeeeeee-1111-4111-8111-111111111111";
const MUTATION_ID = "ffffffff-1111-4111-8111-111111111111";
const PAGE_REF = `page:${PAGE_ID}`;
const NOTE_REF = `note_block:${NOTE_ID}`;
const BODY_PM_JSON = {
  type: "paragraph",
  content: [{ type: "text", text: "Draft" }],
};

const CAPABILITIES = {
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
} satisfies ResourceItem["capabilities"];

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
  capabilities: CAPABILITIES,
  versionByLane: { title: 3, outgoing_edges: 5 },
} satisfies ResourceItem;

const NOTE_ITEM = {
  ...PAGE_ITEM,
  ref: NOTE_REF,
  scheme: "note_block",
  id: NOTE_ID,
  label: "",
  route: `/notes/${NOTE_ID}`,
  activation: {
    resourceRef: NOTE_REF,
    kind: "route",
    href: `/notes/${NOTE_ID}`,
    unresolvedReason: null,
  },
  versionByLane: { body: 2, outgoing_edges: 1 },
} satisfies ResourceItem;

const SURFACE: ResourceSurface = {
  source: {
    item: PAGE_ITEM,
    content: { kind: "page_title", title: "Page" },
  },
  orderedItems: [
    {
      occurrenceId: FIRST_OCCURRENCE_ID,
      target: {
        item: NOTE_ITEM,
        content: {
          kind: "note_body",
          bodyPmJson: BODY_PM_JSON,
          bodyText: "Draft",
        },
      },
    },
    {
      occurrenceId: SECOND_OCCURRENCE_ID,
      target: {
        item: PAGE_ITEM,
        content: { kind: "resource_summary" },
      },
    },
  ],
};

describe("resource surface model", () => {
  it("owns lane versions and exact optimistic command projection", () => {
    expect(resourceSurfaceLaneVersion(PAGE_ITEM, "outgoing_edges")).toBe(5);
    expect(() => resourceSurfaceLaneVersion(PAGE_ITEM, "body")).toThrow(
      "missing body version",
    );
    expect(() =>
      projectResourceSurfaceCommand(SURFACE, {
        type: "remove_occurrence",
        occurrenceId: MUTATION_ID,
      }),
    ).toThrow("occurrence is not in the source");
    expect(() =>
      projectResourceSurfaceCommand(SURFACE, {
        type: "insert_note",
        noteId: NEW_NOTE_ID,
        position: { kind: "after", occurrenceId: MUTATION_ID },
        bodyPmJson: BODY_PM_JSON,
      }),
    ).toThrow("position is not in the source");
    expect(() =>
      projectResourceSurfaceCommand(SURFACE, {
        type: "split_note",
        occurrenceId: SECOND_OCCURRENCE_ID,
        noteId: NEW_NOTE_ID,
        leftBodyPmJson: BODY_PM_JSON,
        rightBodyPmJson: BODY_PM_JSON,
      }),
    ).toThrow("Only note occurrences can be split");
  });

  it("records and rematerializes stable replay intent", () => {
    const command = {
      type: "move_occurrence" as const,
      occurrenceId: FIRST_OCCURRENCE_ID,
      position: { kind: "after" as const, occurrenceId: SECOND_OCCURRENCE_ID },
    };
    const intent = createResourceSurfaceIntent({
      surface: SURFACE,
      command,
      clientMutationId: MUTATION_ID,
    });
    expect(intent).toEqual({
      clientMutationId: MUTATION_ID,
      command,
      occurrenceTargetRef: NOTE_REF,
      position: { kind: "after", targetRef: PAGE_REF },
    });
    expect(materializeResourceSurfaceIntent(SURFACE, intent!)).toEqual(command);
  });

  it("projects queued commands, title, and authored bodies in one owner", () => {
    const intent = createResourceSurfaceIntent({
      surface: SURFACE,
      command: {
        type: "insert_note",
        noteId: NEW_NOTE_ID,
        position: { kind: "start" },
        bodyPmJson: BODY_PM_JSON,
      },
      clientMutationId: MUTATION_ID,
    });
    const projected = projectResourceSurface({
      acknowledgedSurface: SURFACE,
      intents: [intent!],
      title: { value: "Edited", clientMutationId: MUTATION_ID },
      bodies: new Map([
        [
          NOTE_REF,
          {
            bodyPmJson: { type: "paragraph" },
            bodyText: "",
            clientMutationId: MUTATION_ID,
          },
        ],
      ]),
    });
    expect(projected.source.content).toEqual({
      kind: "page_title",
      title: "Edited",
    });
    expect(projected.orderedItems.map((item) => item.occurrenceId)).toEqual([
      `local:${NEW_NOTE_ID}`,
      FIRST_OCCURRENCE_ID,
      SECOND_OCCURRENCE_ID,
    ]);
    expect(projected.orderedItems[1]?.target.content).toEqual({
      kind: "note_body",
      bodyPmJson: { type: "paragraph" },
      bodyText: "",
    });
  });
});
