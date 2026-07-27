import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import SwitchboardFind from "./SwitchboardFind";

describe("SwitchboardFind", () => {
  it("shows scope chips only after a query and keeps one metadata line per result", () => {
    const view = render(
      <SwitchboardFind
        query=""
        scope="All"
        rows={[]}
        activeId={null}
        busy={false}
        openablesFailed={false}
        deepFailed={false}
        onBack={() => {}}
        onQuery={() => {}}
        onScope={() => {}}
        onActive={() => {}}
        onSelect={() => {}}
        onFork={() => {}}
        actionsFor={() => []}
        onAction={() => {}}
        onRetryOpenables={() => {}}
        onRetryDeep={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Find scope")).toBeNull();

    view.rerender(
      <SwitchboardFind
        query="left hand"
        scope="All"
        rows={[
          {
            id: "OpenPane:pane-a",
            item: {
              kind: "OpenPane",
              paneId: "pane-a",
              activationRouteId:
                resolveWorkspaceActivationRouteId("/media/owner"),
            },
            label: "The Left Hand of Darkness",
            metadata: "Open tab",
            recent: false,
          },
        ]}
        activeId="OpenPane:pane-a"
        busy={false}
        openablesFailed={false}
        deepFailed={false}
        onBack={() => {}}
        onQuery={() => {}}
        onScope={() => {}}
        onActive={() => {}}
        onSelect={() => {}}
        onFork={() => {}}
        actionsFor={() => []}
        onAction={() => {}}
        onRetryOpenables={() => {}}
        onRetryDeep={() => {}}
      />,
    );
    expect(screen.getByLabelText("Find scope")).toBeVisible();
    expect(screen.getByText("Open tab")).toBeVisible();
    expect(screen.getByText("1 result")).toBeInTheDocument();
  });

  it("keeps successful rows when one remote source fails and offers source retry", () => {
    const onRetryDeep = vi.fn();
    render(
      <SwitchboardFind
        query="darkness"
        scope="All"
        rows={[
          {
            id: "Destination:notes",
            item: { kind: "Destination", destinationId: "notes" },
            label: "Notes",
            metadata: "Place",
            recent: false,
          },
        ]}
        activeId={null}
        busy={false}
        openablesFailed={false}
        deepFailed
        onBack={() => {}}
        onQuery={() => {}}
        onScope={() => {}}
        onActive={() => {}}
        onSelect={() => {}}
        onFork={() => {}}
        actionsFor={() => []}
        onAction={() => {}}
        onRetryOpenables={() => {}}
        onRetryDeep={onRetryDeep}
      />,
    );
    expect(screen.getByRole("button", { name: "Notes Place" })).toBeVisible();
    expect(screen.getByText(/Couldn’t search inside content/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(onRetryDeep).toHaveBeenCalledOnce();
  });
});
