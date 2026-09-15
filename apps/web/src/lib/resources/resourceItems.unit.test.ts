import { describe, expect, it } from "vitest";
import {
  decodeResourceSurfaceSnapshot,
  normalizeResourceSurface,
} from "./resourceItems";

const PAGE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const OCCURRENCE_ID = "bbbbbbbb-1111-4111-8111-111111111111";

const PAGE_ITEM = {
  ref: `page:${PAGE_ID}`,
  scheme: "page",
  id: PAGE_ID,
  label: "Page",
  summary: "",
  route: `/pages/${PAGE_ID}`,
  activation: {
    resourceRef: `page:${PAGE_ID}`,
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

const WIRE_SURFACE = {
  source: {
    item: PAGE_ITEM,
    content: { kind: "page_title", title: "Page" },
  },
  ordered_items: [
    {
      occurrence_id: OCCURRENCE_ID,
      target: {
        item: PAGE_ITEM,
        content: { kind: "resource_summary" },
      },
    },
  ],
};

const SNAPSHOT_SURFACE = {
  source: WIRE_SURFACE.source,
  orderedItems: [
    {
      occurrenceId: OCCURRENCE_ID,
      target: WIRE_SURFACE.ordered_items[0].target,
    },
  ],
};

describe("resource surface contracts", () => {
  it("decodes the exact snake-case wire and camel-case snapshot separately", () => {
    expect(normalizeResourceSurface(WIRE_SURFACE)).toEqual(SNAPSHOT_SURFACE);
    expect(decodeResourceSurfaceSnapshot(SNAPSHOT_SURFACE)).toEqual(
      SNAPSHOT_SURFACE,
    );
  });

  it("rejects extra fields, alternate casing, and noncanonical occurrences", () => {
    expect(() =>
      normalizeResourceSurface({ ...WIRE_SURFACE, extra: true }),
    ).toThrow("resource surface must contain exactly");
    expect(() => decodeResourceSurfaceSnapshot(WIRE_SURFACE)).toThrow(
      "resource surface snapshot must contain exactly",
    );
    expect(() =>
      normalizeResourceSurface({
        ...WIRE_SURFACE,
        ordered_items: [
          { ...WIRE_SURFACE.ordered_items[0], occurrence_id: "NOT-A-UUID" },
        ],
      }),
    ).toThrow("must be a canonical lowercase UUID");
  });
});
