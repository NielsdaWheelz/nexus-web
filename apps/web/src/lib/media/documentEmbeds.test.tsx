import { describe, expect, it } from "vitest";
import {
  decodeDocumentEmbed,
  decodeDocumentEmbeds,
  renderDocumentEmbedsInHtml,
  type DocumentEmbed,
} from "@/lib/media/documentEmbeds";

const classNames = {
  card: "embed-card",
  media: "embed-media",
  thumbnail: "embed-thumbnail",
  body: "embed-body",
  meta: "embed-meta",
  provider: "embed-provider",
  state: "embed-state",
  title: "embed-title",
  description: "embed-description",
  actions: "embed-actions",
  action: "embed-action",
  actionDisabled: "embed-action-disabled",
};

const embedWire = {
  id: "embed-1",
  media_id: "media-1",
  fragment_id: "fragment-1",
  ordinal: 0,
  occurrence_key: "embed:000000:youtube:dQw4w9WgXcQ",
  provider: "youtube",
  kind: "video",
  source_shape: "iframe",
  resolution_status: "resolved",
  source_url: {
    status: "present",
    value: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    error_code: null,
    reason: null,
  },
  canonical_url: {
    status: "present",
    value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    error_code: null,
    reason: null,
  },
  provider_target_ref: {
    kind: "present",
    value: "dQw4w9WgXcQ",
    reason: null,
  },
  title: {
    kind: "present",
    value: "Launch video",
    reason: null,
  },
  description: {
    kind: "present",
    value: "Launch video",
    reason: null,
  },
  thumbnail_url: {
    status: "absent",
    value: null,
    error_code: null,
    reason: "not_in_source",
  },
  authored_text: {
    kind: "present",
    value: "Launch video",
    reason: null,
  },
  locator: {
    kind: "anchored",
    fragment_id: "fragment-1",
    canonical_start_offset: 7,
    canonical_end_offset: 35,
    document_order_key: "000000",
    placeholder_text: "Launch video",
  },
  display: {
    mode: "resolved",
    label: "Embedded video: Launch video",
    description: "Launch video",
    actions: [
      {
        kind: "open_child_media",
        label: "Open",
        href: "/media/child-1",
        disabled: false,
      },
    ],
  },
  target: {
    status: "exact",
    media_id: "child-1",
    resource_ref: "media:child-1",
    href: "/media/child-1",
    kind: "video",
    title: "Launch video",
    thumbnail_url: null,
    playback: null,
  },
  error_code: {
    kind: "absent",
    value: null,
    reason: "not_in_source",
  },
};

const embed: DocumentEmbed = decodeDocumentEmbed(embedWire);

describe("DocumentEmbed contract", () => {
  it("validates the complete owner DTO before projecting the reader view", () => {
    expect(decodeDocumentEmbeds([embedWire])).toEqual([embed]);
    expect(embed).not.toHaveProperty("resolution_status");
    expect(embed.fragment_id).toBe("fragment-1");
  });

  it("rejects extra and malformed nested owner fields", () => {
    expect(() =>
      decodeDocumentEmbed({ ...embedWire, legacy_status: "ready" }),
    ).toThrow(/must contain exactly/);
    expect(() =>
      decodeDocumentEmbed({
        ...embedWire,
        locator: {
          ...embedWire.locator,
          canonical_start_offset: -1,
        },
      }),
    ).toThrow(/canonical_start_offset must be nonnegative/);
    expect(() =>
      decodeDocumentEmbed({
        ...embedWire,
        display: {
          ...embedWire.display,
          actions: [{ ...embedWire.display.actions[0], legacy_href: null }],
        },
      }),
    ).toThrow(/actions\[0\] must contain exactly/);
  });
});

describe("renderDocumentEmbedsInHtml", () => {
  it("replaces authored placeholders with embed cards", () => {
    const output = String(
      renderDocumentEmbedsInHtml(
        '<p>Before</p><figure data-nexus-document-embed-id="embed:000000:youtube:dQw4w9WgXcQ"><figcaption>Embedded video: Launch video</figcaption></figure>',
        [embed],
        classNames,
      ),
    );

    expect(output).toContain('class="embed-card"');
    expect(output).toContain("Launch video");
    expect(output).toContain('href="/media/child-1"');
  });

  it("does not append unanchored cards when placeholders are missing", () => {
    expect(
      renderDocumentEmbedsInHtml("<p>Before</p>", [embed], classNames),
    ).toBe("<p>Before</p>");
  });

  it("rejects protocol-relative action and thumbnail URLs", () => {
    const output = String(
      renderDocumentEmbedsInHtml(
        '<figure data-nexus-document-embed-id="embed:000000:youtube:dQw4w9WgXcQ"></figure>',
        [
          {
            ...embed,
            display: {
              ...embed.display,
              actions: [
                {
                  kind: "open_original",
                  label: "Original",
                  href: "//evil.test/path",
                },
              ],
            },
            source_url: { status: "absent", value: null },
            canonical_url: { status: "absent", value: null },
            target: {
              ...embed.target,
              thumbnail_url: "//evil.test/thumb.jpg",
            },
          },
        ],
        classNames,
      ),
    );

    expect(output).not.toContain("evil.test");
    expect(output).not.toContain("embed-thumbnail");
  });
});
