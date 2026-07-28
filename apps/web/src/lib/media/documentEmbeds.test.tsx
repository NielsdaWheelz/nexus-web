import { describe, expect, it } from "vitest";
import {
  buildCanonicalCursor,
  validateCanonicalText,
} from "@/lib/highlights/canonicalCursor";
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
const quoteLabel = "Quoted X post by @alice — Open in Nexus";
const quoteEmbed: DocumentEmbed = {
  ...embed,
  id: "quote-embed-1",
  occurrence_key: "x-quote:1880000000000000000:1890000000000000000",
  provider: "x",
  kind: "post",
  source_shape: "provider_json",
  canonical_url: {
    status: "present",
    value: "https://x.com/i/status/1890000000000000000",
  },
  locator: {
    ...embed.locator,
    canonical_start_offset: 8,
    canonical_end_offset: 52,
    placeholder_text: quoteLabel,
  },
  display: {
    mode: "resolved",
    label: quoteLabel,
    description: "Quoted body must not render",
    actions: [
      {
        kind: "open_child_media",
        label: "Extra action must not render",
        href: "/media/quote-child-1",
        disabled: false,
      },
      {
        kind: "open_original",
        label: "Original must not render",
        href: "https://x.com/i/status/1890000000000000000",
        disabled: false,
      },
    ],
  },
  target: {
    status: "exact",
    media_id: "quote-child-1",
    href: "/media/quote-child-1",
    kind: "web_article",
    title: "Quoted title must not render",
    thumbnail_url: "https://images.example.test/quote.jpg",
    playback: null,
  },
};

function quoteReferenceRoot(value: DocumentEmbed): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = renderDocumentEmbedsInHtml(
    `<figure data-nexus-document-embed-id="${value.occurrence_key}"></figure>`,
    [value],
    classNames,
  );
  return root;
}

describe("DocumentEmbed contract", () => {
  it("validates the complete owner DTO before projecting the reader view", () => {
    expect(decodeDocumentEmbeds([embedWire])).toEqual([embed]);
    expect(embed).not.toHaveProperty("resolution_status");
    expect(embed.fragment_id).toBe("fragment-1");
    expect(embed.source_shape).toBe("iframe");
    expect(embed.locator.placeholder_text).toBe("Launch video");
    expect(embed.target.href).toBe("/media/child-1");
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

  it("renders a resolved X quote as one relative link with exact canonical-text parity", () => {
    const sourceHtml =
      `<p>Before</p><figure data-nexus-document-embed-id="${quoteEmbed.occurrence_key}">` +
      `<figcaption>${quoteLabel}</figcaption></figure><p>After</p>`;
    const sourceRoot = document.createElement("div");
    sourceRoot.innerHTML = sourceHtml;
    const canonicalText = buildCanonicalCursor(sourceRoot).emitted;

    const renderedRoot = document.createElement("div");
    renderedRoot.innerHTML = renderDocumentEmbedsInHtml(
      sourceHtml,
      [quoteEmbed],
      classNames,
    );
    const cursor = buildCanonicalCursor(renderedRoot);
    const reference = renderedRoot.querySelector(
      '[data-document-embed-presentation="compact-reference"]',
    );
    const link = reference?.querySelector("a");

    expect(validateCanonicalText(cursor, canonicalText, "fragment-1")).toBe(
      true,
    );
    expect(cursor.emitted).toBe(canonicalText);
    expect(reference?.textContent).toBe(quoteLabel);
    expect(link?.textContent).toBe(quoteLabel);
    expect(link?.getAttribute("href")).toBe("/media/quote-child-1");
    expect(link?.hasAttribute("target")).toBe(false);
    expect(reference?.querySelector("img")).toBeNull();
  });

  it.each([
    ["missing", "failed"],
    ["forbidden", "pending"],
    ["partial", "pending"],
  ] as const)(
    "renders an X quote with a %s child target as one canonical external link",
    (targetStatus, displayMode) => {
      const unavailable: DocumentEmbed = {
        ...quoteEmbed,
        id: "quote-embed-unavailable",
        occurrence_key: "x-quote:1880000000000000001:1890000000000000001",
        canonical_url: {
          status: "present",
          value: "https://x.com/i/status/1890000000000000001",
        },
        locator: {
          ...quoteEmbed.locator,
          placeholder_text: "Quoted X post unavailable — Open on X",
        },
        display: {
          mode: displayMode,
          label: "Quoted X post unavailable — Open on X",
          description: "Provider diagnostic must not render",
          actions: [
            {
              kind: "open_original",
              label: "Action label must not render",
              href: "https://x.com/i/status/1890000000000000001",
              disabled: false,
            },
          ],
        },
        target: {
          status: targetStatus,
          media_id: null,
          href: null,
          kind: null,
          title: null,
          thumbnail_url: null,
          playback: null,
        },
      };
      const sourceHtml =
        `<figure data-nexus-document-embed-id="${unavailable.occurrence_key}">` +
        `<figcaption>${unavailable.locator.placeholder_text}</figcaption></figure>`;
      const sourceRoot = document.createElement("div");
      sourceRoot.innerHTML = sourceHtml;
      const canonicalText = buildCanonicalCursor(sourceRoot).emitted;
      const root = document.createElement("div");
      root.innerHTML = renderDocumentEmbedsInHtml(
        sourceHtml,
        [unavailable],
        classNames,
      );
      const html = root.innerHTML;
      const link = root.querySelector("a");

      expect(
        validateCanonicalText(
          buildCanonicalCursor(root),
          canonicalText,
          "fragment-1",
        ),
      ).toBe(true);
      expect(root.textContent).toBe("Quoted X post unavailable — Open on X");
      expect(link?.getAttribute("href")).toBe(
        "https://x.com/i/status/1890000000000000001",
      );
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noreferrer");
      expect(html).not.toContain("Action label");
      expect(html).not.toContain("Provider diagnostic");
    },
  );

  it.each(["pending", "failed"] as const)(
    "keeps an exact readable X quote target internal while display mode is %s",
    (mode) => {
      const root = quoteReferenceRoot({
        ...quoteEmbed,
        display: { ...quoteEmbed.display, mode },
      });
      const link = root.querySelector("a");

      expect(link?.getAttribute("href")).toBe("/media/quote-child-1");
      expect(link?.hasAttribute("target")).toBe(false);
    },
  );

  it("defects on mismatched quote text or unsafe quote activation targets", () => {
    expect(() =>
      quoteReferenceRoot({
        ...quoteEmbed,
        locator: { ...quoteEmbed.locator, placeholder_text: " " },
        display: { ...quoteEmbed.display, label: " " },
      }),
    ).toThrow(/mismatched placeholder and display text/);

    expect(() =>
      quoteReferenceRoot({
        ...quoteEmbed,
        display: { ...quoteEmbed.display, label: "Different text" },
      }),
    ).toThrow(/mismatched placeholder and display text/);

    expect(() =>
      quoteReferenceRoot({
        ...quoteEmbed,
        target: {
          ...quoteEmbed.target,
          href: "https://nexus.example/media/quote-child-1",
        },
      }),
    ).toThrow(/no valid activation target/);

    expect(() =>
      quoteReferenceRoot({
        ...quoteEmbed,
        display: {
          ...quoteEmbed.display,
          mode: "failed",
          actions: [
            {
              kind: "open_original",
              label: "Original",
              href: "javascript:alert(1)",
              disabled: false,
            },
          ],
        },
        target: {
          ...quoteEmbed.target,
          status: "missing",
          media_id: null,
          href: null,
        },
      }),
    ).toThrow(/no valid activation target/);
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
