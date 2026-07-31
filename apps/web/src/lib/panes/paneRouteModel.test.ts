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
const ARTIFACT_REF = "artifact:66666666-6666-4666-8666-666666666666";

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
        queryNavigation: "in-place",
        returnMemento: { kind: "ShellScroll" },
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: false,
      },
    });
    expect(resolvePaneRouteModel("/podcasts?sort=alpha")).toMatchObject({
      id: "podcasts",
      params: {},
      definition: {
        queryNavigation: "in-place",
        returnMemento: { kind: "ShellScroll" },
      },
    });
    expect(resolvePaneRouteModel("/browse?kind=Video&q=nexus")).toMatchObject({
      id: "browse",
      definition: {
        queryNavigation: "in-place",
        returnMemento: { kind: "ShellScroll" },
      },
    });
    expect(
      resolvePaneRouteModel("/browse/preview?target=ndt1.example.example"),
    ).toMatchObject({
      id: "browsePreview",
      definition: {
        returnMemento: { kind: "ShellScroll" },
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
    expect(
      resolvePaneRouteModel(
        `/artifacts/${encodeURIComponent(ARTIFACT_REF)}?revision=artifact_revision%3Aold`,
      ),
    ).toMatchObject({
      id: "artifact",
      params: { artifactRef: ARTIFACT_REF },
      definition: {
        bodyMode: "standard",
        queryNavigation: "in-place",
        secondaryGroups: ["resource-inspector"],
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

  it("resolves Stats as a standard section pane", () => {
    expect(resolvePaneRouteModel("/stats?view=year&year=2026")).toMatchObject({
      id: "stats",
      definition: {
        bodyMode: "standard",
        returnMemento: { kind: "ShellScroll" },
        queryNavigation: "in-place",
      },
    });
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
      "browse",
      "browsePreview",
      "artifact",
      "conversations",
      "podcasts",
      "podcastDetail",
      "search",
      "author",
      "notes",
      "page",
      "dailyDate",
      "note",
      "stats",
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
