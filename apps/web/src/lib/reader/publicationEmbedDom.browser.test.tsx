import { expect, it } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { selectionToOffsets } from "@/lib/highlights/selectionToOffsets";
import type { DocumentEmbed } from "@/lib/media/documentEmbeds";
import { createDocumentReaderSession } from "./DocumentReaderSession";
import { createHostedReaderSource } from "./ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "./hostedReaderProgress";
import { prepareReaderUnit } from "./publicationDom";
import { decodeReaderPublicationUnit } from "./publicationContract";
import { READER_CAPACITY } from "./readerCapacity";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const CHILD = "55555555-5555-4555-8555-555555555555";
const embed: DocumentEmbed = {
  id: "33333333-3333-4333-8333-333333333333", media_id: MEDIA, fragment_id: MEDIA,
  ordinal: 0, occurrence_key: "quotation", provider: "generic", kind: "link_preview", source_shape: "anchor",
  source_url: { status: "present", value: "https://example.invalid/article" },
  canonical_url: { status: "present", value: "https://example.invalid/article" },
  locator: { canonical_start_offset: 7, canonical_end_offset: 12, placeholder_text: "quote" },
  display: { mode: "resolved", label: "Live title", description: "Current description", actions: [
    { kind: "open_child_media", label: "Open", href: `/media/${CHILD}`, disabled: false },
  ] },
  target: { status: "exact", media_id: CHILD, href: `/media/${CHILD}`, kind: "web_article", title: "Current title",
    thumbnail_url: "https://example.invalid/cover.png", playback: null },
};
const secondEmbed = { ...embed, id: "44444444-4444-4444-8444-444444444444", occurrence_key: "second-quotation", ordinal: 1,
  locator: { ...embed.locator, canonical_start_offset: 17, canonical_end_offset: 22 },
  target: { ...embed.target, title: "Second current title" } };
const classNames = { card: "card", media: "media", thumbnail: "thumbnail", body: "body", meta: "meta",
  provider: "provider", state: "state", title: "title", description: "description", actions: "actions", action: "action", actionDisabled: "disabled" };
const unit = decodeReaderPublicationUnit({
  fragment_id: MEDIA, fragment_idx: 0, document_word_start: 0, starts_in_word: false, epub_target: null,
  document_embeds: [{ id: embed.id, ordinal: 0, occurrence_key: "quotation", provider: "generic", embed_kind: "link_preview",
    source_shape: "anchor", source_url: "https://example.invalid/article", canonical_source_url: "https://example.invalid/article",
    provider_target_ref: null, title: null, authored_text: "quote", placeholder_text: "quote",
    canonical_start_offset: 7, canonical_end_offset: 12, target: { kind: "materialized", media_id: CHILD } },
    { id: secondEmbed.id, ordinal: 1, occurrence_key: "second-quotation", provider: "generic", embed_kind: "link_preview",
    source_shape: "anchor", source_url: "https://example.invalid/article", canonical_source_url: "https://example.invalid/article",
    provider_target_ref: null, title: null, authored_text: "quote", placeholder_text: "quote",
    canonical_start_offset: 17, canonical_end_offset: 22, target: { kind: "materialized", media_id: CHILD } }],
  fragment_document_start_cp: 0, fragment_length_cp: 28,
  start_cp: 0, end_cp: 28, render_start_cp: 0, render_end_cp: 28,
  canonical_text: "before quote and quote after", word_boundaries: [0, 6, 7, 12, 13, 16, 17, 22, 23, 28],
  render_nodes: [
    { kind: "Element", parent: null, namespace: "html", name: "p", attributes: [] },
    { kind: "Text", parent: 0, text: "before " },
    { kind: "Element", parent: 0, namespace: "html", name: "span", attributes: [{ namespace: null, name: "data-nexus-document-embed-id", value: "quotation" }] },
    { kind: "Text", parent: 2, text: "quote" },
    { kind: "Text", parent: 0, text: " and " },
    { kind: "Element", parent: 0, namespace: "html", name: "span", attributes: [{ namespace: null, name: "data-nexus-document-embed-id", value: "second-quotation" }] },
    { kind: "Text", parent: 5, text: "quote" },
    { kind: "Text", parent: 0, text: " after" },
  ], assets: [], table_contexts: [],
});

it("admits live cards separately while preserving authored nodes and selection coordinates", () => {
  for (const maxDomNodes of [10, 64]) {
    const capacity = { ...READER_CAPACITY, view: { ...READER_CAPACITY.view, maxDomNodes } };
    const runtime = new HostedReaderProgressRuntime(ACCOUNT, () => {});
    const session = createDocumentReaderSession({ mediaId: MEDIA, capacity,
      source: createHostedReaderSource({ accountId: ACCOUNT, cache: new ResourceCache({}, capacity.cache), capacity }), progress: runtime.createPort(MEDIA) });
    try {
      const result = prepareReaderUnit({ session, unit, unitKey: "unit", highlights: [], headingLevelOffset: 1,
        embeds: { items: [embed, secondEmbed], classNames } });
      if (maxDomNodes === 10) {
        expect(result, "live cards must be admitted before allocating their nodes").toEqual({ kind: "Capacity", reason: "Dom" });
        continue;
      }
      if (result.kind !== "Ready") throw new Error("Admitted source and card failed to render");
      try {
        document.body.append(result.value.root);
        expect(result.value.root.querySelector("p")?.textContent).toBe("before quote and quote after");
        expect(result.value.root.querySelector("figure")?.parentElement).toBe(result.value.root);
        expect(result.value.root.textContent).toContain("Current title");
        expect([...result.value.root.querySelectorAll("figure")].map((card) => card.getAttribute("data-nexus-document-embed-id")),
          "live cards reversed their original occurrence order").toEqual(["quotation", "second-quotation"]);
        expect(result.value.cursor.emitted, "live card UI entered canonical source coordinates").toBe("before quote and quote after");
        expect(result.value.cursor.length).toBe(28);
        expect(result.value.artwork[0].image.getAttribute("src")).toBeNull();
        const quote = result.value.root.querySelector("span[data-nexus-document-embed-id]")?.firstChild;
        const title = result.value.root.querySelector("strong")?.firstChild;
        if (quote === undefined || quote === null || title === undefined || title === null) throw new Error("Source/card text is absent");
        const range = document.createRange();
        range.setStart(quote, 0); range.setEnd(quote, 5);
        expect(selectionToOffsets(range, result.value.cursor, [{ start: 0, text: unit.canonical_text }])).toEqual({ success: true, startOffset: 7, endOffset: 12, selectedText: "quote" });
        range.setStart(title, 0); range.setEnd(title, 4);
        expect(selectionToOffsets(range, result.value.cursor, [{ start: 0, text: unit.canonical_text }])).toMatchObject({ success: false, error: "OUTSIDE_CONTENT" });
      } finally { result.value.release(); }
    } finally { session.close(); runtime.close(); }
  }
});
