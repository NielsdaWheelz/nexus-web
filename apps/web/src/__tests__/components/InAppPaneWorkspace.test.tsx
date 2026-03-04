import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InAppPaneWorkspace from "@/components/InAppPaneWorkspace";
import { NEXUS_OPEN_PANE_EVENT } from "@/lib/panes/openInAppPane";
import {
  PANE_GRAPH_STORAGE_KEY,
  PaneGraphProvider,
} from "@/lib/panes/paneGraphStore";

function renderWorkspace() {
  return render(
    <PaneGraphProvider>
      <InAppPaneWorkspace>
        <div>primary content</div>
      </InAppPaneWorkspace>
    </PaneGraphProvider>
  );
}

async function waitForWorkspaceReady() {
  await waitFor(() => {
    expect(localStorage.getItem(PANE_GRAPH_STORAGE_KEY)).toContain('"schemaVersion":"1"');
  });
}

describe("InAppPaneWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists pane graph and restores panes after remount", async () => {
    const { unmount } = renderWorkspace();
    await waitForWorkspaceReady();

    window.dispatchEvent(
      new CustomEvent(NEXUS_OPEN_PANE_EVENT, {
        detail: {
          href: "/not-supported",
        },
      })
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Close pane" })).toHaveLength(1);
    });
    await waitFor(() => {
      expect(localStorage.getItem(PANE_GRAPH_STORAGE_KEY)).toContain("/not-supported");
    });
    expect(localStorage.getItem(PANE_GRAPH_STORAGE_KEY)).toContain('"schemaVersion":"1"');

    unmount();
    renderWorkspace();
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Close pane" })).toHaveLength(1);
    });
  });

  it("renders panes without iframe route embedding", async () => {
    renderWorkspace();
    await waitForWorkspaceReady();

    window.dispatchEvent(
      new CustomEvent(NEXUS_OPEN_PANE_EVENT, {
        detail: {
          href: "/not-supported",
        },
      })
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Close pane" })).toHaveLength(1);
    });
    expect(document.querySelector("iframe")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Close pane" })[0]!);
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "Close pane" })).toHaveLength(0);
    });
    expect(localStorage.getItem(PANE_GRAPH_STORAGE_KEY)).toContain('"panes":[]');
  });

  it("opens panes from same-origin postMessage events", async () => {
    renderWorkspace();
    await waitForWorkspaceReady();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: {
          type: "nexus:open-pane",
          href: "/another-unsupported",
        },
      })
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Close pane" })).toHaveLength(1);
    });
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("ignores cross-origin postMessage open-pane events", async () => {
    renderWorkspace();
    await waitForWorkspaceReady();

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://example.invalid",
        data: {
          type: "nexus:open-pane",
          href: "/should-not-open",
        },
      })
    );

    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "Close pane" })).toHaveLength(0);
    });
  });
});
