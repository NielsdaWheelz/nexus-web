import { describe, expect, it } from "vitest";
import { decodeResourceItem, normalizeResourceSurface } from "./resourceItems";

const ID = "11111111-1111-4111-8111-111111111111";
const REF = `media:${ID}`;
const ROUTE = `/media/${ID}`;

function wireResourceItem(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ref: REF,
    scheme: "media",
    id: ID,
    label: "A media item",
    summary: "",
    route: ROUTE,
    activation: {
      resourceRef: REF,
      kind: "route",
      href: ROUTE,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
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
      inspectable: "media_document_map",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "inline_body",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: false,
      adjacencyTarget: true,
    },
    versionByLane: { body: 3 },
    ...overrides,
  };
}

describe("decodeResourceItem", () => {
  it("decodes the exact canonical camel-case ResourceItemOut wire", () => {
    expect(decodeResourceItem(wireResourceItem())).toEqual({
      ref: REF,
      scheme: "media",
      id: ID,
      label: "A media item",
      summary: "",
      route: ROUTE,
      activation: {
        resourceRef: REF,
        kind: "route",
        href: ROUTE,
        unresolvedReason: null,
      },
      missing: false,
      capabilities: {
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
        inspectable: "media_document_map",
        citableResultType: null,
        citationOutputSource: false,
        appSearchScope: false,
        conversationSearchScope: false,
        promptRender: "inline_body",
        expansionPolicy: "none",
        expandable: false,
        adjacencySource: false,
        adjacencyTarget: true,
      },
      versionByLane: { body: 3 },
    });
  });

  it.each([
    ["top-level alternate casing", { versionByLane: undefined, version_by_lane: {} }],
    [
      "activation alternate casing",
      {
        activation: {
          resource_ref: REF,
          kind: "route",
          href: ROUTE,
          unresolved_reason: null,
        },
      },
    ],
    [
      "capability alternate casing",
      {
        capabilities: {
          ...(wireResourceItem().capabilities as Record<string, unknown>),
          libraryPlacement: undefined,
          library_placement: "ManageEntries",
        },
      },
    ],
    [
      "relation alternate casing",
      {
        capabilities: {
          ...(wireResourceItem().capabilities as Record<string, unknown>),
          userRelation: {
            userLinkSource: undefined,
            user_link_source: true,
            userLinkTarget: "direct",
            noteReferenceTarget: true,
          },
        },
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeResourceItem(wireResourceItem(value))).toThrow();
  });

  it.each([
    "ref",
    "scheme",
    "id",
    "label",
    "summary",
    "route",
    "activation",
    "missing",
    "capabilities",
    "versionByLane",
  ])("requires top-level field %s", (field) => {
    const raw = wireResourceItem();
    delete raw[field];
    expect(() => decodeResourceItem(raw)).toThrow();
  });

  it("requires every capability, activation, and relation field", () => {
    const capabilities = wireResourceItem().capabilities as Record<string, unknown>;
    for (const field of Object.keys(capabilities)) {
      const incomplete = { ...capabilities };
      delete incomplete[field];
      expect(() =>
        decodeResourceItem(wireResourceItem({ capabilities: incomplete })),
      ).toThrow();
    }
    const activation = wireResourceItem().activation as Record<string, unknown>;
    for (const field of Object.keys(activation)) {
      const incomplete = { ...activation };
      delete incomplete[field];
      expect(() =>
        decodeResourceItem(wireResourceItem({ activation: incomplete })),
      ).toThrow();
    }
    const relation = capabilities.userRelation as Record<string, unknown>;
    for (const field of Object.keys(relation)) {
      const incomplete = { ...relation };
      delete incomplete[field];
      expect(() =>
        decodeResourceItem(
          wireResourceItem({
            capabilities: { ...capabilities, userRelation: incomplete },
          }),
        ),
      ).toThrow();
    }
  });

  it("rejects extra keys at every ResourceItem-owned object level", () => {
    const capabilities = wireResourceItem().capabilities as Record<string, unknown>;
    const activation = wireResourceItem().activation as Record<string, unknown>;
    const relation = capabilities.userRelation as Record<string, unknown>;
    expect(() =>
      decodeResourceItem({ ...wireResourceItem(), extra: true }),
    ).toThrow();
    expect(() =>
      decodeResourceItem(
        wireResourceItem({ activation: { ...activation, extra: true } }),
      ),
    ).toThrow();
    expect(() =>
      decodeResourceItem(
        wireResourceItem({ capabilities: { ...capabilities, extra: true } }),
      ),
    ).toThrow();
    expect(() =>
      decodeResourceItem(
        wireResourceItem({
          capabilities: {
            ...capabilities,
            userRelation: { ...relation, extra: true },
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects identity drift and invalid route/version capability values", () => {
    expect(() =>
      decodeResourceItem(wireResourceItem({ scheme: "page" })),
    ).toThrow();
    expect(() =>
      decodeResourceItem(wireResourceItem({ id: crypto.randomUUID() })),
    ).toThrow();
    expect(() =>
      decodeResourceItem(
        wireResourceItem({
          activation: {
            resourceRef: `page:${ID}`,
            kind: "route",
            href: ROUTE,
            unresolvedReason: null,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeResourceItem(wireResourceItem({ versionByLane: { body: 0 } })),
    ).toThrow();
    expect(() =>
      decodeResourceItem(wireResourceItem({ missing: "false" })),
    ).toThrow();
  });

  it.each([
    ["sharing", "LegacyShare"],
    ["libraryPlacement", "legacy"],
    ["attachable", "true"],
    ["chatSubject", "legacy"],
    ["readable", "legacy"],
    ["inspectable", "legacy"],
    ["citableResultType", 1],
    ["citationOutputSource", "false"],
    ["appSearchScope", "false"],
    ["conversationSearchScope", "false"],
    ["promptRender", "legacy"],
    ["expansionPolicy", "legacy"],
    ["expandable", "false"],
    ["adjacencySource", "false"],
    ["adjacencyTarget", "false"],
  ])("rejects an invalid %s capability", (field, value) => {
    const capabilities = wireResourceItem().capabilities as Record<
      string,
      unknown
    >;
    expect(() =>
      decodeResourceItem(
        wireResourceItem({
          capabilities: { ...capabilities, [field]: value },
        }),
      ),
    ).toThrow();
  });

  it.each([
    ["userLinkSource", "true"],
    ["userLinkTarget", "legacy"],
    ["noteReferenceTarget", "true"],
  ])("rejects an invalid user relation %s", (field, value) => {
    const capabilities = wireResourceItem().capabilities as Record<
      string,
      unknown
    >;
    const relation = capabilities.userRelation as Record<string, unknown>;
    expect(() =>
      decodeResourceItem(
        wireResourceItem({
          capabilities: {
            ...capabilities,
            userRelation: { ...relation, [field]: value },
          },
        }),
      ),
    ).toThrow();
  });

  it.each([
    ["non-object", null],
    [
      "unknown kind",
      {
        resourceRef: REF,
        kind: "legacy",
        href: ROUTE,
        unresolvedReason: null,
      },
    ],
    [
      "route without href",
      {
        resourceRef: REF,
        kind: "route",
        href: null,
        unresolvedReason: null,
      },
    ],
    [
      "external without href",
      {
        resourceRef: REF,
        kind: "external",
        href: null,
        unresolvedReason: null,
      },
    ],
    [
      "none with href",
      {
        resourceRef: REF,
        kind: "none",
        href: ROUTE,
        unresolvedReason: "missing",
      },
    ],
    [
      "non-string href",
      {
        resourceRef: REF,
        kind: "route",
        href: 1,
        unresolvedReason: null,
      },
    ],
    [
      "non-string unresolved reason",
      {
        resourceRef: REF,
        kind: "none",
        href: null,
        unresolvedReason: 1,
      },
    ],
  ])("rejects invalid activation shape: %s", (_label, activation) => {
    expect(() =>
      decodeResourceItem(wireResourceItem({ activation })),
    ).toThrow();
  });

  it.each([
    ["null map", null],
    ["array map", []],
    ["string version", { body: "1" }],
    ["fractional version", { body: 1.5 }],
    ["zero version", { body: 0 }],
    ["negative version", { body: -1 }],
  ])("rejects invalid version shape: %s", (_label, versionByLane) => {
    expect(() =>
      decodeResourceItem(wireResourceItem({ versionByLane })),
    ).toThrow();
  });

  it("correlates route with the activation variant and href", () => {
    expect(() =>
      decodeResourceItem(
        wireResourceItem({
          route: "/media/other",
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeResourceItem(
        wireResourceItem({
          route: ROUTE,
          activation: {
            resourceRef: REF,
            kind: "external",
            href: "https://example.com/resource",
            unresolvedReason: null,
          },
        }),
      ),
    ).toThrow();
  });

  it("accepts explicit nulls only where the canonical wire permits them", () => {
    const item = decodeResourceItem(
      wireResourceItem({
        route: null,
        activation: {
          resourceRef: REF,
          kind: "none",
          href: null,
          unresolvedReason: "not_routeable",
        },
      }),
    );
    expect(item.route).toBeNull();
    expect(item.activation.kind).toBe("none");
  });
});

describe("normalizeResourceSurface", () => {
  it("keeps the outer surface snake-case contract and decodes nested items once", () => {
    const surface = normalizeResourceSurface({
      source: {
        item: wireResourceItem(),
        content: { kind: "page_title", title: "Page" },
      },
      ordered_items: [
        {
          occurrence_id: "edge-1",
          target: {
            item: wireResourceItem(),
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
  });
});
