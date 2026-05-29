import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PANE_WIDTH_PX,
  MAX_STANDARD_PANE_WIDTH_PX,
  PANE_ROUTE_MODELS,
  resolvePaneRouteModel,
  resolvePaneRouteWidthContract,
} from "@/lib/panes/paneRouteModel";

describe("pane route model", () => {
  it("resolves representative routes with identity, body mode, and width policy", () => {
    expect(resolvePaneRouteModel("/libraries")).toMatchObject({
      id: "libraries",
      params: {},
      resourceRef: null,
      definition: {
        bodyMode: "standard",
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: false,
      },
    });
    expect(resolvePaneRouteModel("/libraries/lib-1")).toMatchObject({
      id: "library",
      params: { id: "lib-1" },
      resourceRef: "library:lib-1",
      definition: { allowsIntrinsicPrimaryWidth: false },
    });
    expect(resolvePaneRouteModel("/media/media-1")).toMatchObject({
      id: "media",
      params: { id: "media-1" },
      resourceRef: "media:media-1",
      definition: {
        bodyMode: "document",
        maxWidthPx: MAX_MEDIA_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: true,
      },
    });
    expect(resolvePaneRouteModel("/podcasts/podcast-1")).toMatchObject({
      id: "podcastDetail",
      params: { podcastId: "podcast-1" },
      resourceRef: "podcast:podcast-1",
      definition: {
        bodyMode: "document",
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
        allowsIntrinsicPrimaryWidth: false,
      },
    });
    expect(resolvePaneRouteModel("/pages/page-1")).toMatchObject({
      id: "page",
      resourceRef: "page:page-1",
      definition: {
        bodyMode: "document",
        maxWidthPx: MAX_STANDARD_PANE_WIDTH_PX,
      },
    });
  });

  it("resolves specific routes before parameter routes", () => {
    expect(resolvePaneRouteModel("/conversations/new")).toMatchObject({
      id: "conversationNew",
      resourceRef: null,
    });
    expect(resolvePaneRouteModel("/conversations/conversation-1")).toMatchObject({
      id: "conversation",
      resourceRef: "conversation:conversation-1",
    });
  });

  it("returns unsupported routes with standard max policy only", () => {
    for (const href of ["/oracle", "/media", "/pages/a/b"]) {
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

  it("declares unique model ids", () => {
    const ids = PANE_ROUTE_MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
