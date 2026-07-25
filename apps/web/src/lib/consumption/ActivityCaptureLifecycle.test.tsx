import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActivityCaptureLifecycle from "./ActivityCaptureLifecycle";

const activity = vi.hoisted(() => ({
  setCaptureReady: vi.fn(),
  flushForPageHide: vi.fn(),
}));

const viewport = vi.hoisted(() => ({
  hydrated: false,
}));

vi.mock("./activityRecorder", () => ({
  activityRecorder: () => activity,
}));

vi.mock("@/lib/renderEnvironment/provider", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/renderEnvironment/provider")>();
  return {
    ...actual,
    useViewportState: () => ({
      kind: "desktop" as const,
      isMobile: false,
      hydrated: viewport.hydrated,
    }),
  };
});

afterEach(() => {
  activity.setCaptureReady.mockReset();
  activity.flushForPageHide.mockReset();
  viewport.hydrated = false;
});

describe("ActivityCaptureLifecycle", () => {
  it("arms capture only after hydration and wires pagehide to the recorder keepalive flush", () => {
    const view = render(<ActivityCaptureLifecycle />);
    expect(activity.setCaptureReady).toHaveBeenLastCalledWith(false);

    viewport.hydrated = true;
    view.rerender(<ActivityCaptureLifecycle />);
    expect(activity.setCaptureReady).toHaveBeenLastCalledWith(true);

    window.dispatchEvent(new Event("pagehide"));
    expect(activity.flushForPageHide).toHaveBeenCalledOnce();

    view.unmount();
    window.dispatchEvent(new Event("pagehide"));
    expect(activity.flushForPageHide).toHaveBeenCalledOnce();
  });
});
