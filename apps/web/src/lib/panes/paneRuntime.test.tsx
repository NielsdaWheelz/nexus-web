import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PaneRuntimeProvider, useSetPaneTitle } from "@/lib/panes/paneRuntime";

function PaneTitlePublisher({ title }: { title: string }) {
  useSetPaneTitle(title);
  return null;
}

function PaneTitleHarness({ onSetPaneTitle }: {
  onSetPaneTitle: (
    paneId: string,
    title: string | null,
    metadata: { routeId: string; resourceRef: string | null }
  ) => void;
}) {
  const [renderTick, setRenderTick] = useState(0);
  const [title, setTitle] = useState("Library A");

  return (
    <>
      <button type="button" onClick={() => setRenderTick((value) => value + 1)}>
        Force rerender
      </button>
      <button type="button" onClick={() => setTitle("Library B")}>
        Change title
      </button>
      <output data-testid="render-tick">{renderTick}</output>
      <PaneRuntimeProvider
        paneId="pane-1"
        href="/libraries/lib-1"
        routeId="library"
        resourceRef="library:lib-1"
        pathParams={{ id: "lib-1" }}
        onNavigatePane={() => {}}
        onReplacePane={() => {}}
        onOpenInNewPane={() => {}}
        onSetPaneTitle={onSetPaneTitle}
      >
        <PaneTitlePublisher title={title} />
      </PaneRuntimeProvider>
    </>
  );
}

describe("useSetPaneTitle", () => {
  it("does not republish unchanged title on provider rerenders", async () => {
    const user = userEvent.setup();
    const onSetPaneTitle = vi.fn();
    render(<PaneTitleHarness onSetPaneTitle={onSetPaneTitle} />);

    await waitFor(() => {
      expect(onSetPaneTitle).toHaveBeenCalledTimes(1);
    });
    expect(onSetPaneTitle).toHaveBeenLastCalledWith("pane-1", "Library A", {
      routeId: "library",
      resourceRef: "library:lib-1",
    });

    await user.click(screen.getByRole("button", { name: "Force rerender" }));
    await user.click(screen.getByRole("button", { name: "Force rerender" }));
    await user.click(screen.getByRole("button", { name: "Force rerender" }));

    expect(onSetPaneTitle).toHaveBeenCalledTimes(1);
  });

  it("publishes again when pane title changes", async () => {
    const user = userEvent.setup();
    const onSetPaneTitle = vi.fn();
    render(<PaneTitleHarness onSetPaneTitle={onSetPaneTitle} />);

    await waitFor(() => {
      expect(onSetPaneTitle).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: "Change title" }));

    await waitFor(() => {
      expect(onSetPaneTitle).toHaveBeenCalledTimes(2);
    });
    expect(onSetPaneTitle).toHaveBeenLastCalledWith("pane-1", "Library B", {
      routeId: "library",
      resourceRef: "library:lib-1",
    });
  });
});
