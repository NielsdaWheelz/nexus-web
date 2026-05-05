import { describe, expect, it } from "vitest";
import { getParentHref, resolvePaneRoute } from "./paneRouteRegistry";

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
    expect(getParentHref(route)).toBeNull();
  });

  it("resolves page routes as document panes", () => {
    const route = resolvePaneRoute("/pages/page-1");

    expect(route.id).toBe("page");
    expect(route.params).toEqual({ pageId: "page-1" });
    expect(route.resourceRef).toBe("page:page-1");
    expect(route.render).toEqual(expect.any(Function));
    expect(route.definition?.bodyMode).toBe("document");
    expect(getParentHref(route)).toBeNull();
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
    expect(getParentHref(noteRoute)).toBe("/notes");
  });

  it("returns the unsupported placeholder for full-screen Oracle routes", () => {
    expect(resolvePaneRoute("/oracle").id).toBe("unsupported");
    expect(resolvePaneRoute("/oracle/reading-1").id).toBe("unsupported");
  });
});
