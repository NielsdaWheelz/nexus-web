import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  decodeReaderDocumentMap,
  getReaderDocumentMap,
  readerSurfaceForMarkerKind,
} from "./documentMap";

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>(
      "@/lib/api/client",
    );
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

function emptyMap() {
  return {
    media_id: "media-1",
    media_kind: "web_article",
    title: "Reader",
    status: "ready",
    source_version: {
      media_updated_at: { kind: "Absent" },
      apparatus_source_fingerprint: { kind: "Absent" },
      graph_max_updated_at: { kind: "Absent" },
      highlights_max_updated_at: { kind: "Absent" },
    },
    navigation: { kind: "Absent" },
    embeds: [],
    evidence: {
      counts: {
        highlights: 0,
        citations: 0,
        links: 0,
        synapses: 0,
        passages: 0,
        document: 0,
      },
      passage_groups: [],
      document_items: [],
    },
    markers: [],
    diagnostics: { omitted_item_counts: {} },
  };
}

describe("readerSurfaceForMarkerKind", () => {
  it("maps marker facts to their owning secondary surface", () => {
    expect(readerSurfaceForMarkerKind("Contents")).toBe("reader-contents");
    expect(readerSurfaceForMarkerKind("Highlight")).toBe("reader-evidence");
    expect(readerSurfaceForMarkerKind("SourceReference")).toBe(
      "reader-evidence",
    );
    expect(readerSurfaceForMarkerKind("Embed")).toBeNull();
  });
});

describe("Reader Document Map contract", () => {
  beforeEach(() => apiFetchMock.mockReset());

  it("reads the one aggregate route without legacy pagination", async () => {
    const signal = new AbortController().signal;
    apiFetchMock.mockResolvedValueOnce({ data: emptyMap() });

    await expect(
      getReaderDocumentMap("media-1", { signal }),
    ).resolves.toMatchObject({
      title: "Reader",
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/media/media-1/document-map",
      {
        signal,
      },
    );
  });

  it("rejects legacy top-level fields and nullable Presence values", () => {
    expect(() =>
      decodeReaderDocumentMap({ ...emptyMap(), connections: [] }),
    ).toThrow(/must contain exactly/);

    const raw = emptyMap();
    raw.evidence.document_items = [
      {
        id: "link:e1",
        kind: "Link",
        label: "Related",
        excerpt: null,
        associations: [],
        edge_id: "e1",
        role: "related",
        origin: "user",
        object: {},
      } as never,
    ];
    expect(() => decodeReaderDocumentMap(raw)).toThrow(/excerpt is invalid/);

    expect(() =>
      decodeReaderDocumentMap({ ...emptyMap(), navigation: null }),
    ).toThrow(/navigation is invalid/);
    expect(() =>
      decodeReaderDocumentMap({
        ...emptyMap(),
        source_version: {
          ...emptyMap().source_version,
          content_fingerprint: { kind: "Absent" },
        },
      }),
    ).toThrow(/source_version must contain exactly/);
    expect(() =>
      decodeReaderDocumentMap({
        ...emptyMap(),
        diagnostics: { omitted_item_counts: {}, warnings: [] },
      }),
    ).toThrow(/diagnostics must contain exactly/);
    expect(() =>
      decodeReaderDocumentMap({ ...emptyMap(), status: "failed" }),
    ).toThrow(/ReaderDocumentMap.status/);
  });

  it("strictly composes the navigation and embed owner contracts", () => {
    expect(() =>
      decodeReaderDocumentMap({
        ...emptyMap(),
        navigation: {
          kind: "Present",
          value: {
            media_id: "media-1",
            kind: "web_article",
            sections: [],
            toc_nodes: [],
            landmarks: [],
            page_list: [],
            legacy_sections: [],
          },
        },
      }),
    ).toThrow(/ReaderDocumentMap.navigation is invalid/);

    expect(() =>
      decodeReaderDocumentMap({ ...emptyMap(), embeds: [{ id: "embed-1" }] }),
    ).toThrow(/ReaderDocumentMap.embeds\[0\] must contain exactly/);
  });

  it("decodes the canonical nonempty association and target-resolution wire", () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const targetId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const chat = {
      ref: `message:${messageId}`,
      kind: "Chat",
      label: "Research chat",
      excerpt: { kind: "Present", value: "Discussed here" },
      activation: {
        resource_ref: `message:${messageId}`,
        kind: "route",
        href: "/conversations/conversation-1?message=message-1",
        unresolved_reason: null,
      },
      conversation_id: "conversation-1",
      message_ref: { kind: "Present", value: `message:${messageId}` },
    };
    const resolution = (resourceId: string, startOffset: number) => ({
      kind: "Resolved",
      anchor: {
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: startOffset,
          end_offset: startOffset + 2,
        },
      },
      order_key: `document:${startOffset}`,
    });
    const raw = {
      ...emptyMap(),
      evidence: {
        counts: {
          highlights: 1,
          citations: 2,
          links: 0,
          synapses: 0,
          passages: 3,
          document: 0,
        },
        passage_groups: [
          {
            locus_ref: `reader_apparatus_item:${ownerId}`,
            resolution: resolution(ownerId, 1),
            target_excerpt: { kind: "Present", value: "Selected text" },
            items: [
              {
                id: "highlight:h1",
                kind: "Highlight",
                label: "A highlight",
                excerpt: { kind: "Present", value: "Selected text" },
                associations: [
                  {
                    relationship: "DirectlyAttached",
                    object: chat,
                    edge_id: "edge-chat",
                    role: "context",
                    origin: "user",
                    direction: "Outgoing",
                  },
                ],
                highlight_id: "h1",
                quote: "Selected text",
                prefix: "",
                suffix: "",
                color: "yellow",
                created_at: "2026-07-20T00:00:00Z",
                updated_at: "2026-07-20T00:00:00Z",
                author_user_id: "user-1",
                is_owner: true,
              },
              {
                id: "source-reference:owner",
                kind: "SourceReference",
                label: "Footnote 1",
                excerpt: { kind: "Absent" },
                associations: [],
                stable_key: "owner",
                apparatus_kind: "footnote_ref",
                confidence: "exact",
                targets: [
                  {
                    ref: `reader_apparatus_item:${targetId}`,
                    stable_key: "target",
                    apparatus_kind: "footnote",
                    label: { kind: "Present", value: "Footnote target" },
                    body: { kind: "Present", value: "Target body" },
                    activation: {
                      resource_ref: `reader_apparatus_item:${targetId}`,
                      kind: "route",
                      href: "/media/media-1?apparatus=target",
                      unresolved_reason: null,
                    },
                    resolution: resolution(targetId, 30),
                  },
                ],
              },
              {
                id: "generated-citation:edge-cite",
                kind: "GeneratedCitation",
                label: "Cited by chat",
                excerpt: { kind: "Absent" },
                associations: [{ relationship: "AuthoredIn", object: chat }],
                edge_id: "edge-cite",
                role: "context",
              },
            ],
            also_references: [],
          },
        ],
        document_items: [],
      },
    };

    const decoded = decodeReaderDocumentMap(raw);
    const group = decoded.evidence.passage_groups[0]!;
    expect(group.items).toHaveLength(decoded.evidence.counts.passages);
    expect(group.items[0]?.associations[0]).toMatchObject({
      relationship: "DirectlyAttached",
      edge_id: "edge-chat",
      direction: "Outgoing",
    });
    expect(group.items[1]).toMatchObject({
      kind: "SourceReference",
      targets: [
        {
          stable_key: "target",
          resolution: {
            kind: "Resolved",
            anchor: { locator: { start_offset: 30 } },
          },
        },
      ],
    });
    expect(group.items[2]?.associations[0]?.object).toMatchObject({
      kind: "Chat",
      message_ref: { kind: "Present", value: `message:${messageId}` },
    });

    const invalidLocator = {
      ...raw,
      evidence: {
        ...raw.evidence,
        passage_groups: [
          {
            ...raw.evidence.passage_groups[0],
            resolution: {
              kind: "Resolved",
              anchor: {
                locator: {
                  type: "message_offsets",
                  conversation_id: "conversation-1",
                  message_id: messageId,
                  start_offset: 0,
                  end_offset: 1,
                },
              },
              order_key: "document:1",
            },
          },
        ],
      },
    };
    expect(() => decodeReaderDocumentMap(invalidLocator)).toThrow(
      /not a supported media reader locator/,
    );
  });
});
