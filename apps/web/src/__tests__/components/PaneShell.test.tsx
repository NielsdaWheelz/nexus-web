import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PaneShell, { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import type { EffectivePaneSizing } from "@/lib/workspace/paneSizing";

vi.mock("@/lib/workspace/mobileChrome", () => ({
  useMobileChrome: () => ({
    hidden: false,
    paneChrome: null,
    setPaneChrome: () => {},
    onDocumentScroll: () => {},
    acquireVisibleLock: () => () => {},
  }),
  usePaneMobileChromeController: () => ({
    onDocumentScroll: () => {},
    acquireVisibleLock: () => () => {},
  }),
}));

const disabledNavigation = {
  canGoBack: false,
  canGoForward: false,
  onBack: vi.fn(),
  onForward: vi.fn(),
};

function paneSizing(input: {
  widthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
  fixedChromeWidthPx?: number;
}): EffectivePaneSizing {
  const fixedChromeWidthPx = input.fixedChromeWidthPx ?? 0;
  const primaryWidthPx = Math.min(
    input.maxWidthPx,
    Math.max(input.minWidthPx, input.widthPx)
  );
  return {
    primaryWidthPx,
    primaryMinWidthPx: input.minWidthPx,
    primaryMaxWidthPx: input.maxWidthPx,
    renderedPrimarySlotWidthPx: primaryWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMinWidthPx: input.minWidthPx + fixedChromeWidthPx,
    renderedPrimarySlotMaxWidthPx: input.maxWidthPx + fixedChromeWidthPx,
    fixedChromeWidthPx,
    storedWidthCorrectionPx: null,
  };
}

describe("PaneShell", () => {
  it("delegates keyboard resize to the focused resize handle", () => {
    const onResizePrimaryPane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={onResizePrimaryPane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Libraries" });
    expect(handle).toHaveAttribute("aria-valuemin", "320");
    expect(handle).toHaveAttribute("aria-valuemax", "1400");
    expect(handle).toHaveAttribute("aria-valuenow", "560");
    expect(handle).toHaveAttribute("aria-controls", "pane-a-body");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyDown(handle, { key: "End" });

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 576);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 544);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 320);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 1400);
  });

  it("forwards pane Back and Forward controls", () => {
    const navigation = {
      canGoBack: true,
      canGoForward: true,
      onBack: vi.fn(),
      onForward: vi.fn(),
    };
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={navigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
      >
        <div>Body content</div>
      </PaneShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back in this pane" }));
    fireEvent.click(screen.getByRole("button", { name: "Go forward in this pane" }));

    expect(navigation.onBack).toHaveBeenCalledTimes(1);
    expect(navigation.onForward).toHaveBeenCalledTimes(1);
  });

  it("keyboard resize clamps to a raised runtime minimum", () => {
    const onResizePrimaryPane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Reader"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 500, minWidthPx: 684, maxWidthPx: 2400 })}
        bodyMode="document"
        onResizePrimaryPane={onResizePrimaryPane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Reader" });
    expect(handle).toHaveAttribute("aria-valuemin", "684");
    expect(handle).toHaveAttribute("aria-valuenow", "684");

    fireEvent.keyDown(handle, {
      key: "ArrowRight",
    });

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 700);
  });

  it("supports pointer drag resize on desktop", () => {
    const onResizePrimaryPane = vi.fn();
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={onResizePrimaryPane}
      >
        <div>Body content</div>
      </PaneShell>
    );

    const handle = screen.getByRole("separator", { name: "Resize pane Libraries" });
    fireEvent.mouseDown(handle, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 760 });
    fireEvent.mouseMove(document, { clientX: 40 });
    fireEvent.mouseUp(document);

    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 720);
    expect(onResizePrimaryPane).toHaveBeenCalledWith("pane-a", 320);
  });

  it("keeps Copy pane link first and renders pane options after separators", async () => {
    render(
      <PaneShell
        paneId="pane-a"
        href="/media/media-1"
        title="Designing Data-Intensive Applications"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
        options={[
          { id: "chat", label: "Chat about this document", onSelect: () => {} },
          { id: "reader-settings", label: "Reader settings", href: "/settings/reader" },
          {
            id: "delete",
            label: "Delete document",
            tone: "danger",
            separatorBefore: true,
            onSelect: () => {},
          },
        ]}
      >
        <div>Body content</div>
      </PaneShell>
    );

    fireEvent.click(screen.getByRole("button", { name: "Options" }));

    const menu = await screen.findByRole("menu");
    await waitFor(() => {
      expect(within(menu).getByRole("menuitem", { name: "Copy pane link" })).toBeInTheDocument();
    });
    expect(
      within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())
    ).toEqual([
      "Copy pane link",
      "Chat about this document",
      "Reader settings",
      "Delete document",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  });

  it("clears chrome overrides when an overriding child unmounts", () => {
    const { rerender } = render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
      >
        <ChromeOverrideProbe shouldOverride />
      </PaneShell>
    );

    expect(screen.getByText("Override toolbar")).toBeInTheDocument();
    expect(screen.getByText("Override action")).toBeInTheDocument();
    expect(screen.getByText("Override meta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();

    rerender(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
      >
        <div>Replacement body</div>
      </PaneShell>
    );

    expect(screen.getByText("Default toolbar")).toBeInTheDocument();
    expect(screen.getByText("Default action")).toBeInTheDocument();
    expect(screen.queryByText("Override toolbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Override action")).not.toBeInTheDocument();
    expect(screen.queryByText("Override meta")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
  });

  it("clears chrome overrides when a mounted child stops overriding", () => {
    const { rerender } = render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
      >
        <ChromeOverrideProbe shouldOverride />
      </PaneShell>
    );

    expect(screen.getByText("Override toolbar")).toBeInTheDocument();
    expect(screen.getByText("Override action")).toBeInTheDocument();
    expect(screen.getByText("Override meta")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();

    rerender(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        toolbar={<div>Default toolbar</div>}
        actions={<button type="button">Default action</button>}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
      >
        <ChromeOverrideProbe shouldOverride={false} />
      </PaneShell>
    );

    expect(screen.getByText("Default toolbar")).toBeInTheDocument();
    expect(screen.getByText("Default action")).toBeInTheDocument();
    expect(screen.queryByText("Override toolbar")).not.toBeInTheDocument();
    expect(screen.queryByText("Override action")).not.toBeInTheDocument();
    expect(screen.queryByText("Override meta")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
  });

  it("does not render an app-nav command palette button on mobile", () => {
    render(
      <PaneShell
        paneId="pane-a"
        title="Libraries"
        navigation={disabledNavigation}
        sizing={paneSizing({ widthPx: 560, minWidthPx: 320, maxWidthPx: 1400 })}
        bodyMode="standard"
        onResizePrimaryPane={() => {}}
        isMobile
        toolbar={<div>Reader toolbar</div>}
      >
        <div>Body content</div>
      </PaneShell>
    );

    expect(
      screen.queryByRole("button", { name: /command palette/i })
    ).toBeNull();
    expect(screen.getByText("Reader toolbar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Options" })).toBeNull();
  });

  it("composes visible secondary width without changing primary resize values", async () => {
    const onResizeSecondaryPane = vi.fn();
    const secondaryPublication = {
      groupId: "reader-tools" as const,
      defaultSurfaceId: "reader-highlights" as const,
      surfaces: [
        {
          id: "reader-highlights" as const,
          body: <div>Highlights secondary</div>,
        },
        {
          id: "reader-doc-chat" as const,
          body: <div>Document chat secondary</div>,
        },
      ],
    };
    const props = {
      paneId: "pane-a",
      title: "Reader",
      bodyMode: "document" as const,
      onResizePrimaryPane: () => {},
      onResizeSecondaryPane,
      navigation: disabledNavigation,
    };
    const { rerender } = render(
      <PaneShell
        {...props}
        sizing={paneSizing({ widthPx: 700, minWidthPx: 684, maxWidthPx: 2400 })}
      >
        <div>Body content</div>
      </PaneShell>
    );
    const shell = screen.getByTestId("pane-shell-root");
    expect(shell).toHaveStyle({ width: "700px" });
    expect(shell).toHaveStyle({ minWidth: "684px" });
    expect(shell).toHaveStyle({ maxWidth: "2400px" });
    expect(screen.getByRole("separator", { name: "Resize pane Reader" })).toHaveAttribute(
      "aria-valuenow",
      "700",
    );

    rerender(
      <PaneShell
        {...props}
        sizing={paneSizing({
          widthPx: 700,
          minWidthPx: 684,
          maxWidthPx: 2400,
        })}
        secondaryPane={{
          id: "secondary-a",
          parentPrimaryPaneId: "pane-a",
          groupId: "reader-tools",
          activeSurfaceId: "reader-doc-chat",
          widthPx: 360,
          visibility: "visible",
        }}
        secondarySizing={{
          widthPx: 360,
          minWidthPx: 280,
          maxWidthPx: 720,
          storedWidthCorrectionPx: null,
        }}
        secondaryPublication={secondaryPublication}
      >
        <div>Body content</div>
      </PaneShell>
    );
    await screen.findByTestId("workspace-secondary-pane");
    expect(shell).toHaveStyle({ width: "1060px" });
    expect(shell).toHaveStyle({ minWidth: "1044px" });
    expect(shell).toHaveStyle({ maxWidth: "2760px" });
    expect(screen.getByRole("separator", { name: "Resize pane Reader" })).toHaveAttribute(
      "aria-valuenow",
      "700",
    );

    rerender(
      <PaneShell
        {...props}
        sizing={paneSizing({ widthPx: 700, minWidthPx: 684, maxWidthPx: 2400 })}
        secondaryPane={{
          id: "secondary-a",
          parentPrimaryPaneId: "pane-a",
          groupId: "reader-tools",
          activeSurfaceId: "reader-doc-chat",
          widthPx: 360,
          visibility: "collapsed",
        }}
        secondaryPublication={secondaryPublication}
      >
        <div>Body content</div>
      </PaneShell>
    );
    expect(shell).toHaveStyle({ width: "700px" });
  });
});

function ChromeOverrideProbe({ shouldOverride }: { shouldOverride: boolean }) {
  usePaneChromeOverride(
    shouldOverride
      ? {
          toolbar: <div>Override toolbar</div>,
          actions: <button type="button">Override action</button>,
          meta: <div>Override meta</div>,
          options: [
            {
              id: "override-option",
              label: "Override option",
              onSelect: () => {},
            },
          ],
        }
      : {}
  );

  return <div>Override body</div>;
}
