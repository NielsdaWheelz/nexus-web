import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  MAX_STANDARD_PANE_WIDTH_PX,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";
import { resolvePaneResourceLocator } from "@/lib/panes/paneResourceLocator";
import { resolvePaneRoute } from "./paneRouteTable";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const BLOCK_ID = "22222222-2222-4222-8222-222222222222";

describe("pane route table", () => {
  it("uses broad search copy for evidence-backed search", () => {
    const route = resolvePaneRoute("/search");
    const chrome = route.definition?.getChrome?.({ href: "/search", params: {} });

    expect(route.id).toBe("search");
    expect(chrome?.subtitle).toBe(
      "Search across authors, media, podcasts, evidence, notes, and chat."
    );
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

  it("resolves page routes as document panes", () => {
    const route = resolvePaneRoute(`/pages/${PAGE_ID}`);

    expect(route.id).toBe("page");
    expect(route.params).toEqual({ pageId: PAGE_ID });
    expect(resolvePaneResourceLocator(route)).toEqual({
      kind: "resource_ref",
      ref: `page:${PAGE_ID}`,
    });
    expect(route.definition?.bodyMode).toBe("document");
    expect(route.definition?.secondaryGroups).toContain("notes-tools");
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
    expect(noteRoute.definition?.secondaryGroups).toContain("notes-tools");
  });

  it("resolves daily note routes as document panes", () => {
    const todayRoute = resolvePaneRoute("/daily");
    const datedRoute = resolvePaneRoute("/daily/2026-05-06");

    expect(todayRoute.id).toBe("daily");
    expect(resolvePaneResourceLocator(todayRoute, { timeZone: "UTC" })).toEqual({
      kind: "daily_note_today",
      timeZone: "UTC",
    });
    expect(todayRoute.definition?.bodyMode).toBe("document");
    expect(todayRoute.definition?.secondaryGroups).toContain("notes-tools");

    expect(datedRoute.id).toBe("dailyDate");
    expect(datedRoute.params).toEqual({ localDate: "2026-05-06" });
    expect(resolvePaneResourceLocator(datedRoute, { timeZone: "UTC" })).toEqual({
      kind: "daily_note_date",
      localDate: "2026-05-06",
      timeZone: "UTC",
    });
    expect(datedRoute.definition?.bodyMode).toBe("document");
    expect(datedRoute.definition?.secondaryGroups).toContain("notes-tools");
  });

  it("returns the unsupported placeholder for full-screen Oracle routes", () => {
    expect(resolvePaneRoute("/oracle").id).toBe("unsupported");
    expect(resolvePaneRoute("/oracle/reading-1").id).toBe("unsupported");
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
      expect(route.definition).toMatchObject(resolvePaneRouteWidthContract(href));
    }
  });
});
