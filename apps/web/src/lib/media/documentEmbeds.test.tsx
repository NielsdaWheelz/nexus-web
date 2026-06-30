import { describe, expect, it } from "vitest";
import {
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

const embed: DocumentEmbed = {
  id: "embed-1",
  media_id: "media-1",
  fragment_id: "fragment-1",
  ordinal: 0,
  occurrence_key: "embed:000000:youtube:dQw4w9WgXcQ",
  provider: "youtube",
  kind: "video",
  source_url: {
    status: "present",
    value: "https://www.youtube.com/embed/dQw4w9WgXcQ",
  },
  canonical_url: {
    status: "present",
    value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  },
  locator: {
    canonical_start_offset: 7,
    canonical_end_offset: 35,
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
      },
    ],
  },
  target: {
    status: "exact",
    media_id: "child-1",
    kind: "video",
    title: "Launch video",
    thumbnail_url: null,
    playback: null,
  },
};

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
    expect(renderDocumentEmbedsInHtml("<p>Before</p>", [embed], classNames)).toBe(
      "<p>Before</p>",
    );
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
              actions: [{ kind: "open_original", label: "Original", href: "//evil.test/path" }],
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
