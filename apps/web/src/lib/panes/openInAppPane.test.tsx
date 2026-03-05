import { describe, expect, it, vi } from "vitest";
import {
  consumePendingPaneOpenQueue,
  isOpenInAppPaneMessage,
  requestOpenInAppPane,
  type OpenInAppPaneDetail,
} from "@/lib/panes/openInAppPane";

describe("openInAppPane contract", () => {
  it("posts title hints and resource refs when forwarding to parent", () => {
    const postMessageSpy = vi.spyOn(window.parent, "postMessage");

    const accepted = requestOpenInAppPane("/media/media-123", {
      titleHint: "Interesting article",
      resourceRef: "media:media-123",
    });

    expect(accepted).toBe(true);
    expect(postMessageSpy).toHaveBeenCalled();
    const payload = postMessageSpy.mock.calls[0]?.[0];
    expect(isOpenInAppPaneMessage(payload)).toBe(true);
    if (!isOpenInAppPaneMessage(payload)) {
      return;
    }
    expect(payload).toEqual({
      type: "nexus:open-pane",
      href: "/media/media-123",
      titleHint: "Interesting article",
      resourceRef: "media:media-123",
    });
    postMessageSpy.mockRestore();
  });

  it("returns structured queue entries with title hints and resource refs", () => {
    const currentWindow = window as Window & {
      __nexusPendingPaneOpenQueue?: OpenInAppPaneDetail[];
    };
    currentWindow.__nexusPendingPaneOpenQueue = [
      {
        href: "/libraries/lib-123",
        titleHint: "Research library",
        resourceRef: "library:lib-123",
      },
    ];

    expect(consumePendingPaneOpenQueue()).toEqual([
      {
        href: "/libraries/lib-123",
        titleHint: "Research library",
        resourceRef: "library:lib-123",
      },
    ]);
  });
});
