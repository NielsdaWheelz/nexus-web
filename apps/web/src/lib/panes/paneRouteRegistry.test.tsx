import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
  DEFAULT_MEDIA_PANE_WIDTH_PX,
  DEFAULT_PODCAST_DETAIL_PANE_WIDTH_PX,
  DEFAULT_STANDARD_PANE_WIDTH_PX,
  MAX_MEDIA_PANE_WIDTH_PX,
  MIN_PODCAST_DETAIL_PANE_WIDTH_PX,
  resolvePaneWidthContract,
} from "@/lib/workspace/schema";
import { resolvePaneRoute } from "./paneRouteRegistry";

describe("pane route registry", () => {
  it("uses broad search copy for evidence-backed search", () => {
    const route = resolvePaneRoute("/search");
    const chrome = route.definition?.getChrome?.({ href: "/search", params: {} });

    expect(route.id).toBe("search");
    expect(chrome?.subtitle).toBe(
      "Search across authors, media, podcasts, evidence, notes, and chat."
    );
  });

  it("resolves author routes with contributor resource refs", () => {
    const route = resolvePaneRoute("/authors/ursula-k-le-guin");

    expect(route.id).toBe("author");
    expect(route.params).toEqual({ handle: "ursula-k-le-guin" });
    expect(route.resourceRef).toBe("contributor:ursula-k-le-guin");
    expect(route.render).toEqual(expect.any(Function));
    expect(route.definition?.bodyMode).toBe("standard");
  });

  it("resolves page routes as document panes", () => {
    const route = resolvePaneRoute("/pages/page-1");

    expect(route.id).toBe("page");
    expect(route.params).toEqual({ pageId: "page-1" });
    expect(route.resourceRef).toBe("page:page-1");
    expect(route.render).toEqual(expect.any(Function));
    expect(route.definition?.bodyMode).toBe("document");
  });

  it("resolves notes and note block routes", () => {
    const notesRoute = resolvePaneRoute("/notes");
    const noteRoute = resolvePaneRoute("/notes/block-1");

    expect(notesRoute.id).toBe("notes");
    expect(notesRoute.resourceRef).toBeNull();
    expect(notesRoute.render).toEqual(expect.any(Function));
    expect(notesRoute.definition?.bodyMode).toBe("standard");

    expect(noteRoute.id).toBe("note");
    expect(noteRoute.params).toEqual({ blockId: "block-1" });
    expect(noteRoute.resourceRef).toBe("note_block:block-1");
    expect(noteRoute.render).toEqual(expect.any(Function));
    expect(noteRoute.definition?.bodyMode).toBe("document");
  });

  it("resolves daily note routes as document panes", () => {
    const todayRoute = resolvePaneRoute("/daily");
    const datedRoute = resolvePaneRoute("/daily/2026-05-06");

    expect(todayRoute.id).toBe("daily");
    expect(todayRoute.resourceRef).toBeNull();
    expect(todayRoute.render).toEqual(expect.any(Function));
    expect(todayRoute.definition?.bodyMode).toBe("document");

    expect(datedRoute.id).toBe("dailyDate");
    expect(datedRoute.params).toEqual({ localDate: "2026-05-06" });
    expect(datedRoute.resourceRef).toBe("daily:2026-05-06");
    expect(datedRoute.render).toEqual(expect.any(Function));
    expect(datedRoute.definition?.bodyMode).toBe("document");
  });

  it("returns the unsupported placeholder for full-screen Oracle routes", () => {
    expect(resolvePaneRoute("/oracle").id).toBe("unsupported");
    expect(resolvePaneRoute("/oracle/reading-1").id).toBe("unsupported");
  });

  it("declares width contracts on representative routes", () => {
    expect(resolvePaneRoute("/libraries").definition).toMatchObject({
      defaultWidthPx: DEFAULT_DENSE_LIST_PANE_WIDTH_PX,
      layoutKind: "dense-list",
    });
    expect(resolvePaneRoute("/media/media-1").definition).toMatchObject({
      defaultWidthPx: DEFAULT_MEDIA_PANE_WIDTH_PX,
      maxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
      layoutKind: "media-reader",
    });
    expect(resolvePaneRoute("/podcasts/podcast-1").definition).toMatchObject({
      defaultWidthPx: DEFAULT_PODCAST_DETAIL_PANE_WIDTH_PX,
      minWidthPx: MIN_PODCAST_DETAIL_PANE_WIDTH_PX,
      layoutKind: "podcast-detail",
    });
    expect(resolvePaneRoute("/settings").definition).toMatchObject({
      defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
      layoutKind: "standard",
    });
    expect(resolvePaneWidthContract("/oracle")).toMatchObject({
      defaultWidthPx: DEFAULT_STANDARD_PANE_WIDTH_PX,
      layoutKind: "standard",
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
      "/browse",
      "/podcasts",
      "/podcasts/podcast-1",
      "/search",
      "/authors/ursula-k-le-guin",
      "/notes",
      "/notes/block-1",
      "/pages/page-1",
      "/daily",
      "/daily/2026-05-06",
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
      expect(route.definition).toMatchObject(resolvePaneWidthContract(href));
    }
  });
});
