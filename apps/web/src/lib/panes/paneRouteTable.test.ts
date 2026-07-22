import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  MAX_STANDARD_PANE_WIDTH_PX,
  PANE_ROUTE_MODELS,
  resolvePaneRouteWidthContract,
  sectionDestinationIdForHref,
} from "@/lib/panes/paneRouteModel";
import { resolvePaneResourceLocator } from "@/lib/panes/paneResourceLocator";
import { resolvePaneRoute } from "./paneRouteTable";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const BLOCK_ID = "22222222-2222-4222-8222-222222222222";

describe("pane route table", () => {
  it("declares section and resource header contracts independently of layout", () => {
    const route = resolvePaneRoute("/search");
    const mediaRoute = resolvePaneRoute(`/media/${PAGE_ID}`);

    expect(route.id).toBe("search");
    expect(route.defaultLabel).toBe("Search");
    expect(route.definition?.header).toEqual({
      kind: "section",
      destinationId: "search",
      defaultFolio: "none",
    });
    expect(mediaRoute.definition?.bodyMode).toBe("document");
    expect(mediaRoute.definition?.header).toEqual({
      kind: "resource",
      pendingLabel: "Loading media…",
    });
  });

  it("declares a header contract for every route and only media is resource-owned", () => {
    expect(
      PANE_ROUTE_MODELS.filter(({ header }) => header.kind === "resource").map(
        ({ id }) => id,
      ),
    ).toEqual(["media"]);

    expect(sectionDestinationIdForHref(`/media/${PAGE_ID}`)).toBe("libraries");
  });

  it("resolves author routes with contributor handle locators", () => {
    const route = resolvePaneRoute("/authors/ursula-k-le-guin");

    expect(route.id).toBe("author");
    expect(route.params).toEqual({ handle: "ursula-k-le-guin" });
    expect(resolvePaneResourceLocator(route)).toEqual({
      kind: "contributor_handle",
      handle: "ursula-k-le-guin",
    });
    expect(route.definition?.bodyMode).toBe("standard");
  });

  it("has no root Authors directory route and rejects reserved handle segments", () => {
    // The /authors directory pane is deleted (author-dedup §7 / D-26); the root
    // and the reserved collection segments the handle space shadows fall to the
    // unsupported placeholder rather than mounting an author detail pane.
    expect(resolvePaneRoute("/authors").id).toBe("unsupported");
    expect(resolvePaneRoute("/authors/directory").id).toBe("unsupported");
    expect(resolvePaneRoute("/authors/reconciliation-candidates").id).toBe(
      "unsupported",
    );
  });

  it("resolves page routes as document panes", () => {
    const route = resolvePaneRoute(`/pages/${PAGE_ID}`);

    expect(route.id).toBe("page");
    expect(route.params).toEqual({ pageId: PAGE_ID });
    expect(resolvePaneResourceLocator(route)).toEqual({
      kind: "resource_ref",
      ref: `page:${PAGE_ID}`,
    });
    expect(route.definition?.bodyMode).toBe("document");
    // Machine-output-in-place §13.2 — page connections render inline, not via a
    // notes-tools secondary drawer.
    expect(route.definition?.secondaryGroups).toBeUndefined();
  });

  it("resolves notes and note block routes", () => {
    const notesRoute = resolvePaneRoute("/notes");
    const noteRoute = resolvePaneRoute(`/notes/${BLOCK_ID}`);

    expect(notesRoute.id).toBe("notes");
    expect(resolvePaneResourceLocator(notesRoute)).toBeNull();
    expect(notesRoute.definition?.bodyMode).toBe("standard");

    expect(noteRoute.id).toBe("note");
    expect(noteRoute.params).toEqual({ blockId: BLOCK_ID });
    expect(resolvePaneResourceLocator(noteRoute)).toEqual({
      kind: "resource_ref",
      ref: `note_block:${BLOCK_ID}`,
    });
    expect(noteRoute.definition?.bodyMode).toBe("document");
    expect(noteRoute.definition?.secondaryGroups).toBeUndefined();
  });

  it("returns the unsupported placeholder for redirected /daily routes", () => {
    expect(resolvePaneRoute("/daily").id).toBe("unsupported");
    expect(resolvePaneRoute("/daily/2026-05-06").id).toBe("unsupported");
  });

  it("resolves oracle routes as registered pane routes after shell dissolution", () => {
    expect(resolvePaneRoute("/oracle").id).toBe("oracle");
    expect(resolvePaneRoute("/oracle/reading-1").id).toBe("oracleReading");
  });

  it("declares max width policy on representative routes", () => {
    expect(resolvePaneRoute("/libraries").definition).toMatchObject({
      maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      allowsIntrinsicPrimaryWidth: false,
    });
    expect(resolvePaneRoute("/media/media-1").definition).toMatchObject({
      maxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
      allowsIntrinsicPrimaryWidth: true,
    });
    expect(resolvePaneRoute("/podcasts/podcast-1").definition).toMatchObject({
      maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      allowsIntrinsicPrimaryWidth: false,
    });
    expect(resolvePaneRoute("/settings").definition).toMatchObject({
      maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      allowsIntrinsicPrimaryWidth: false,
    });
    expect(resolvePaneRouteWidthContract("/oracle")).toMatchObject({
      maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      allowsIntrinsicPrimaryWidth: false,
    });
  });

  it("keeps route metadata aligned with workspace width policy", () => {
    for (const href of [
      "/libraries",
      "/libraries/lib-1",
      "/media/media-1",
      "/conversations",
      "/conversations/new",
      "/conversations/conversation-1",
      "/podcasts",
      "/podcasts/podcast-1",
      "/search",
      "/authors/ursula-k-le-guin",
      "/notes",
      "/notes/block-1",
      "/pages/page-1",
      "/settings",
      "/settings/reader",
      "/settings/billing",
      "/settings/appearance",
      "/settings/keys",
      "/settings/local-vault",
      "/settings/identities",
      "/settings/keybindings",
    ]) {
      const route = resolvePaneRoute(href);
      expect(route.definition).toMatchObject(resolvePaneRouteWidthContract(href));
    }
  });
});
