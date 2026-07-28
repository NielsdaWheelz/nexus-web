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
        pending={false}
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
        pending={false}
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
        pending={false}
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

  it("suppresses the empty state while a remote search is still pending", () => {
    const emptyProps = {
      query: "zzz",
      scope: "All" as const,
      rows: [],
      activeId: null,
      busy: false,
      openablesFailed: false,
      deepFailed: false,
      onBack: () => {},
      onQuery: () => {},
      onScope: () => {},
      onActive: () => {},
      onSelect: () => {},
      onFork: () => {},
      actionsFor: () => [],
      onAction: () => {},
      onRetryOpenables: () => {},
      onRetryDeep: () => {},
    };
    // Pending (in-flight, before the delayed busy indicator) must NOT flash "No results".
    const view = render(<SwitchboardFind {...emptyProps} pending />);
    expect(screen.queryByText(/No results for/)).toBeNull();
    // Once no remote work is in flight and nothing matched, the empty state shows.
    view.rerender(<SwitchboardFind {...emptyProps} pending={false} />);
    expect(screen.getByText(/No results for “zzz”/)).toBeVisible();
  });
});
