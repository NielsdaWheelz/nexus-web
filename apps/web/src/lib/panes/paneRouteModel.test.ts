import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  MAX_STANDARD_PANE_WIDTH_PX,
  PANE_ROUTE_MODELS,
  resolvePaneRouteModel,
  resolvePaneRouteWidthContract,
  sectionDestinationIdForHref,
} from "@/lib/panes/paneRouteModel";

const LIBRARY_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const PODCAST_ID = "33333333-3333-4333-8333-333333333333";
const PAGE_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";

describe("pane route model", () => {
  it("resolves representative routes with identity, body mode, and width policy", () => {
    expect(resolvePaneRouteModel("/libraries")).toMatchObject({
      id: "libraries",
      params: {},
      definition: {
        bodyMode: "standard",
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: false,
      },
    });
    expect(resolvePaneRouteModel(`/libraries/${LIBRARY_ID}`)).toMatchObject({
      id: "library",
      params: { id: LIBRARY_ID },
      definition: { allowsIntrinsicPrimaryWidth: false },
    });
    expect(resolvePaneRouteModel(`/media/${MEDIA_ID}`)).toMatchObject({
      id: "media",
      params: { id: MEDIA_ID },
      definition: {
        bodyMode: "document",
        maxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: true,
      },
    });
    expect(resolvePaneRouteModel(`/podcasts/${PODCAST_ID}`)).toMatchObject({
      id: "podcastDetail",
      params: { podcastId: PODCAST_ID },
      definition: {
        bodyMode: "standard",
        returnMemento: { kind: "ShellScroll" },
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: false,
      },
    });
    expect(resolvePaneRouteModel(`/pages/${PAGE_ID}`)).toMatchObject({
      id: "page",
      params: { pageId: PAGE_ID },
      definition: {
        bodyMode: "standard",
        returnMemento: { kind: "ShellScroll" },
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      },
    });
  });

  it("resolves specific routes before parameter routes", () => {
    expect(resolvePaneRouteModel("/conversations/new")).toMatchObject({
      id: "conversationNew",
    });
    expect(resolvePaneRouteModel(`/conversations/${CONVERSATION_ID}`)).toMatchObject({
      id: "conversation",
      params: { id: CONVERSATION_ID },
    });
  });

  it("returns unsupported routes with standard max policy only", () => {
    for (const href of ["/media", "/pages/a/b"]) {
      expect(resolvePaneRouteModel(href)).toMatchObject({
        id: "unsupported",
        definition: null,
      });
      expect(resolvePaneRouteWidthContract(href)).toEqual({
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: false,
      });
    }
  });

  it("resolves oracle routes as registered pane routes", () => {
    expect(resolvePaneRouteModel("/oracle")).toMatchObject({ id: "oracle" });
    expect(resolvePaneRouteModel("/oracle/some-uuid")).toMatchObject({
      id: "oracleReading",
      params: { readingId: "some-uuid" },
    });
  });

  it("resolves the grand atlas as its own pane route", () => {
    // /oracle/atlas is no longer a pane route (oracleAtlas is dead); its App
    // Router page redirects legacy links to /atlas?layer=readings.
    expect(resolvePaneRouteModel("/atlas")).toMatchObject({ id: "atlas" });
  });

  it("projects detail routes to their owning navigation section", () => {
    expect(sectionDestinationIdForHref(`/media/${MEDIA_ID}`)).toBe("libraries");
    expect(sectionDestinationIdForHref(`/libraries/${LIBRARY_ID}`)).toBe("libraries");
    expect(sectionDestinationIdForHref(`/podcasts/${PODCAST_ID}`)).toBe("podcasts");
    expect(sectionDestinationIdForHref(`/conversations/${CONVERSATION_ID}`)).toBe(
      "chats",
    );
    expect(sectionDestinationIdForHref("/settings/appearance")).toBe("settings");
    expect(sectionDestinationIdForHref("/not-a-pane")).toBeNull();
  });

  it("declares unique model ids", () => {
    const ids = PANE_ROUTE_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies every supported route under one return owner", () => {
    const byKind = Object.groupBy(
      PANE_ROUTE_MODELS,
      (model) =>
        model.returnMemento.kind === "Excluded"
          ? `${model.returnMemento.kind}.${model.returnMemento.owner}`
          : model.returnMemento.kind,
    );

    expect(byKind.ShellScroll?.map((model) => model.id)).toEqual([
      "lectern",
      "libraries",
      "library",
      "conversations",
      "podcasts",
      "podcastDetail",
      "search",
      "author",
      "notes",
      "page",
      "note",
      "settings",
      "settingsAccount",
      "settingsBilling",
      "settingsReader",
      "settingsAppearance",
      "settingsLocalVault",
      "settingsIdentities",
      "settingsKeybindings",
      "oracle",
      "oracleReading",
    ]);
    expect(byKind.NoVerticalScroll?.map((model) => model.id)).toEqual(["atlas"]);
    expect(byKind["Excluded.Reader"]?.map((model) => model.id)).toEqual(["media"]);
    expect(byKind["Excluded.Chat"]?.map((model) => model.id)).toEqual([
      "conversationNew",
      "conversation",
    ]);
  });
});
