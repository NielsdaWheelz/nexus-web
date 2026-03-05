import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
const requestOpenInAppPaneMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/panes/openInAppPane", () => ({
  requestOpenInAppPane: requestOpenInAppPaneMock,
}));
import { AppList, AppListItem } from "@/components/ui/AppList";

describe("AppListItem", () => {
  afterEach(() => {
    requestOpenInAppPaneMock.mockClear();
  });

  it("opens links in a new in-app pane when shift-clicked", () => {
    render(
      <AppList>
        <AppListItem href="/media/123" title="Example media" />
      </AppList>
    );

    fireEvent.click(screen.getByRole("link", { name: "Example media" }), {
      shiftKey: true,
    });

    expect(requestOpenInAppPaneMock).toHaveBeenCalledTimes(1);
    expect(requestOpenInAppPaneMock).toHaveBeenCalledWith("/media/123", {
      resourceRef: undefined,
      titleHint: "Example media",
    });
  });
});
