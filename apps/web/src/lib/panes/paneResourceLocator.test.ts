import { describe, expect, it } from "vitest";
import { resolvePaneResourceLocator } from "@/lib/panes/paneResourceLocator";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";

const LIBRARY_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const PODCAST_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";
const BLOCK_ID = "55555555-5555-4555-8555-555555555555";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";

function locatorFor(href: string) {
  return resolvePaneResourceLocator(resolvePaneRouteModel(href));
}

describe("pane resource locator", () => {
  it("builds resource-ref locators for UUID-backed routes", () => {
    expect(locatorFor(`/libraries/${LIBRARY_ID}`)).toEqual({
      kind: "resource_ref",
      ref: `library:${LIBRARY_ID}`,
    });
    expect(locatorFor(`/media/${MEDIA_ID}`)).toEqual({
      kind: "resource_ref",
      ref: `media:${MEDIA_ID}`,
    });
    expect(locatorFor(`/podcasts/${PODCAST_ID}`)).toEqual({
      kind: "resource_ref",
      ref: `podcast:${PODCAST_ID}`,
    });
    expect(locatorFor(`/pages/${PAGE_ID}`)).toEqual({
      kind: "resource_ref",
      ref: `page:${PAGE_ID}`,
    });
    expect(locatorFor(`/notes/${BLOCK_ID}`)).toEqual({
      kind: "resource_ref",
      ref: `note_block:${BLOCK_ID}`,
    });
    expect(locatorFor(`/conversations/${CONVERSATION_ID}`)).toEqual({
      kind: "resource_ref",
      ref: `conversation:${CONVERSATION_ID}`,
    });
  });

  it("rejects malformed UUID resource routes instead of inventing refs", () => {
    expect(locatorFor("/media/not-a-uuid")).toBeNull();
    expect(locatorFor("/pages/44444444-4444-4444-8444-zzzzzzzzzzzz")).toBeNull();
  });

  it("builds product alias locators for author routes", () => {
    expect(locatorFor("/authors/ursula-k-le-guin")).toEqual({
      kind: "contributor_handle",
      handle: "ursula-k-le-guin",
    });
  });

  it("keeps non-resource routes explicit", () => {
    for (const href of [
      "/libraries",
      "/conversations",
      "/conversations/new",
      "/podcasts",
      "/search",
      "/authors",
      "/notes",
      "/settings",
      "/oracle",
    ]) {
      expect(locatorFor(href), href).toBeNull();
    }
  });

});
