import { expect, it } from "vitest";
import {
  documentEmbedThumbnail,
  planDocumentEmbedCards,
  renderDocumentEmbedsInHtml,
  type DocumentEmbed,
} from "./documentEmbeds";

const MEDIA = "11111111-1111-4111-8111-111111111111";
const CHILD = "55555555-5555-4555-8555-555555555555";
const classNames = { card: "card", media: "media", thumbnail: "thumbnail", body: "body", meta: "meta",
  provider: "provider", state: "state", title: "title", description: "description", actions: "actions",
  action: "action", actionDisabled: "disabled" };

function embedWithThumbnail(thumbnailUrl: string | null): DocumentEmbed {
  return {
    id: "33333333-3333-4333-8333-333333333333", media_id: MEDIA, fragment_id: MEDIA,
    ordinal: 0, occurrence_key: "quotation", provider: "generic", kind: "link_preview", source_shape: "anchor",
    source_url: { status: "present", value: "https://example.invalid/article" },
    canonical_url: { status: "present", value: "https://example.invalid/article" },
    locator: { canonical_start_offset: 7, canonical_end_offset: 12, placeholder_text: "quote" },
    display: { mode: "resolved", label: "Live title", description: "Current description", actions: [] },
    target: { status: "exact", media_id: CHILD, href: `/media/${CHILD}`, kind: "web_article",
      title: "Current title", thumbnail_url: thumbnailUrl, playback: null },
  };
}

it("classifies an ingested thumbnail by how it can actually be fetched", () => {
  expect(documentEmbedThumbnail("https://example.invalid/cover.png")).toEqual({
    kind: "ProxiedRemote", url: "https://example.invalid/cover.png",
  });
  expect(documentEmbedThumbnail("/covers/thumb.png")).toEqual({ kind: "SameOrigin", path: "/covers/thumb.png" });
  // A crafted value that the remote-image proxy's own parser rejects is absent
  // or same-origin — never a demand the proxy route can only refuse.
  expect(documentEmbedThumbnail("/api/media/image?url=%zz")).toEqual({ kind: "SameOrigin", path: "/api/media/image?url=%zz" });
  expect(documentEmbedThumbnail("javascript:alert(1)")).toEqual({ kind: "Absent" });
  expect(documentEmbedThumbnail("//evil.invalid/cover.png")).toEqual({ kind: "Absent" });
  expect(documentEmbedThumbnail(null)).toEqual({ kind: "Absent" });
  expect(documentEmbedThumbnail("   ")).toEqual({ kind: "Absent" });
});

it("serves a same-origin embed thumbnail directly instead of demanding it through the remote-image proxy", () => {
  const transcript = document.createElement("div");
  transcript.innerHTML = renderDocumentEmbedsInHtml(
    '<p>before <span data-nexus-document-embed-id="quotation">quote</span> after</p>',
    [embedWithThumbnail("/covers/thumb.png")],
    classNames,
  );
  expect(transcript.querySelector("img")?.getAttribute("src")).toBe("/covers/thumb.png");
  expect(transcript.innerHTML, "a same-origin thumbnail was laundered through the remote-image proxy").not.toContain("/api/media/image");
});

it("hands the publication reader a thumbnail already narrowed to its fetch route", () => {
  const artwork: { image: HTMLImageElement; source: { kind: string } }[] = [];
  const root = document.createElement("div");
  root.innerHTML = '<p>before <span data-nexus-document-embed-id="quotation">quote</span> after</p>';
  const plan = planDocumentEmbedCards(root, [embedWithThumbnail("/api/media/image?url=%zz")], classNames,
    (image, source) => { artwork.push({ image, source }); });
  expect(plan.additionalNodes, "a present thumbnail was not charged its card nodes").toBe(16);
  plan.apply();
  // The pane consumes only this union, so the crafted value can never reach the
  // proxy parser that throws out of its layout effect.
  expect(artwork.map(({ source }) => source)).toEqual([{ kind: "SameOrigin", path: "/api/media/image?url=%zz" }]);

  const absent: { image: HTMLImageElement; source: { kind: string } }[] = [];
  const bare = document.createElement("div");
  bare.innerHTML = '<p>before <span data-nexus-document-embed-id="quotation">quote</span> after</p>';
  const withoutThumbnail = planDocumentEmbedCards(bare, [embedWithThumbnail("javascript:alert(1)")], classNames,
    (image, source) => { absent.push({ image, source }); });
  expect(withoutThumbnail.additionalNodes).toBe(14);
  withoutThumbnail.apply();
  expect(absent, "an unfetchable thumbnail still demanded an image").toEqual([]);
  expect(bare.querySelector("img")).toBeNull();
});
