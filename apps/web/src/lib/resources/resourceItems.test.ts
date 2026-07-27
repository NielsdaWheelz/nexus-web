import { describe, expect, it } from "vitest";
import { normalizeResourceItem, normalizeResourceSurface } from "./resourceItems";

function rawResourceItem(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ref: "media:11111111-1111-4111-8111-111111111111",
    scheme: "media",
    id: "11111111-1111-4111-8111-111111111111",
    label: "A media item",
    summary: "",
    route: "/media/11111111-1111-4111-8111-111111111111",
    activation: {
      resource_ref: "media:11111111-1111-4111-8111-111111111111",
      kind: "route",
      href: "/media/11111111-1111-4111-8111-111111111111",
      unresolved_reason: null,
    },
    missing: false,
    capabilities: {
      user_relation: {
        user_link_source: true,
        user_link_target: "direct",
        note_reference_target: true,
      },
      sharing: "ResourceGrants",
      library_placement: "ManageEntries",
      attachable: true,
      chat_subject: "label",
      readable: "body",
      inspectable: "preview",
      citable_result_type: null,
      citation_output_source: false,
      app_search_scope: false,
      conversation_search_scope: false,
      prompt_render: "inline_body",
      expansion_policy: "none",
      expandable: false,
      adjacency_source: false,
      adjacency_target: true,
    },
    version_by_lane: { body: 3 },
    ...overrides,
  };
}

describe("normalizeResourceItem", () => {
  it("normalizes snake_case wire fields into the camelCase ResourceItem shape", () => {
    const item = normalizeResourceItem(rawResourceItem());

    expect(item).toMatchObject({
      ref: "media:11111111-1111-4111-8111-111111111111",
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
      label: "A media item",
      route: "/media/11111111-1111-4111-8111-111111111111",
      missing: false,
      versionByLane: { body: 3 },
    });
    expect(item.activation).toMatchObject({
      resourceRef: "media:11111111-1111-4111-8111-111111111111",
      kind: "route",
      href: "/media/11111111-1111-4111-8111-111111111111",
    });
    expect(item.capabilities).toMatchObject({
      userRelation: {
        userLinkSource: true,
        userLinkTarget: "direct",
        noteReferenceTarget: true,
      },
      sharing: "ResourceGrants",
      libraryPlacement: "ManageEntries",
      attachable: true,
      chatSubject: "label",
      readable: "body",
      inspectable: "preview",
      citableResultType: null,
      promptRender: "inline_body",
      expansionPolicy: "none",
      adjacencyTarget: true,
    });
  });

  it("accepts already-camelCase fields (already-normalized re-entry)", () => {
    const item = normalizeResourceItem(
      rawResourceItem({
        capabilities: {
          userRelation: {
            userLinkSource: false,
            userLinkTarget: "materialize_passage",
            noteReferenceTarget: false,
          },
          sharing: "None",
          libraryPlacement: "None",
          attachable: false,
          chatSubject: "none",
          readable: "none",
          inspectable: "none",
          citableResultType: "highlight",
          citationOutputSource: true,
          appSearchScope: true,
          conversationSearchScope: true,
          promptRender: "none",
          expansionPolicy: "none",
          expandable: true,
          adjacencySource: true,
          adjacencyTarget: false,
        },
        versionByLane: { title: 1 },
      }),
    );

    expect(item.capabilities.userRelation).toEqual({
      userLinkSource: false,
      userLinkTarget: "materialize_passage",
      noteReferenceTarget: false,
    });
    expect(item.capabilities.citableResultType).toBe("highlight");
    expect(item.capabilities.libraryPlacement).toBe("None");
    expect(item.versionByLane).toEqual({ title: 1 });
  });

  it("defaults missing optional/string fields", () => {
    const item = normalizeResourceItem(
      rawResourceItem({
        label: undefined,
        summary: undefined,
        route: undefined,
        missing: undefined,
        version_by_lane: undefined,
      }),
    );

    expect(item.label).toBe("");
    expect(item.summary).toBe("");
    expect(item.route).toBeNull();
    expect(item.missing).toBe(false);
    expect(item.versionByLane).toEqual({});
  });

  it("throws when activation is missing or invalid", () => {
    expect(() =>
      normalizeResourceItem(rawResourceItem({ activation: null })),
    ).toThrow("Invalid resource activation");
  });

  it("throws when a required string field is missing", () => {
    expect(() =>
      normalizeResourceItem(rawResourceItem({ ref: undefined })),
    ).toThrow();
  });

  it("rejects missing or unknown library placement modes", () => {
    const value = rawResourceItem();
    const capabilities = value.capabilities as Record<string, unknown>;
    expect(() =>
      normalizeResourceItem({
        ...value,
        capabilities: { ...capabilities, library_placement: undefined },
      }),
    ).toThrow("Invalid resource library placement capability");
    expect(() =>
      normalizeResourceItem({
        ...value,
        capabilities: { ...capabilities, library_placement: "Manage" },
      }),
    ).toThrow("Invalid resource library placement capability");
  });

  it("accepts only canonical snake_case surface occurrences", () => {
    const surface = normalizeResourceSurface({
      source: {
        item: rawResourceItem(),
        content: { kind: "page_title", title: "Page" },
      },
      ordered_items: [
        {
          occurrence_id: "edge-1",
          target: {
            item: rawResourceItem(),
            content: {
              kind: "note_body",
              body_pm_json: { type: "paragraph" },
              body_text: "A note",
            },
          },
        },
      ],
    });

    expect(surface.orderedItems[0]?.occurrenceId).toBe("edge-1");
    expect(surface.orderedItems[0]?.target.content).toMatchObject({
      kind: "note_body",
      bodyText: "A note",
    });
    expect(() =>
      normalizeResourceSurface({
        source: { item: rawResourceItem(), content: { kind: "page_title" } },
        orderedItems: [],
      }),
    ).toThrow("ordered_items");
  });
});
