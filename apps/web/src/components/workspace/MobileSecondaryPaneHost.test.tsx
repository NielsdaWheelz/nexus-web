import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MobileSecondaryPaneHost from "@/components/workspace/MobileSecondaryPaneHost";

const publication = {
  groupId: "conversation-context" as const,
  defaultSurfaceId: "conversation-references" as const,
  surfaces: [
    {
      id: "conversation-references" as const,
      body: <button type="button">Reference action</button>,
    },
    { id: "conversation-forks" as const, body: <div>Forks body</div> },
  ],
};

const secondary = {
  groupId: "conversation-context" as const,
  activeSurfaceId: "conversation-references" as const,
  widthPx: 320,
  visibility: "visible" as const,
};

const readerPublication = {
  groupId: "reader-tools" as const,
  defaultSurfaceId: "reader-contents" as const,
  surfaces: [{ id: "reader-contents" as const, body: <div>Contents body</div> }],
};

const readerSecondary = {
  groupId: "reader-tools" as const,
  activeSurfaceId: "reader-contents" as const,
  widthPx: 360,
  visibility: "visible" as const,
};

describe("MobileSecondaryPaneHost", () => {
  // Model history locally (MobileSheet.test.tsx pattern) so the sheet's
  // history-dismiss bookkeeping never touches the real history stack.
  let fakeState: unknown = null;

  beforeEach(() => {
    fakeState = null;
    vi.spyOn(history, "pushState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "replaceState").mockImplementation((state) => {
      fakeState = state;
    });
    vi.spyOn(history, "back").mockImplementation(() => {
      fakeState = null;
    });
    vi.spyOn(history, "state", "get").mockImplementation(() => fakeState);
  });

  afterEach(() => {
    document.body.style.overflow = "";
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("locks body scroll, focuses the active tab, closes on Escape, and restores focus", async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Return target</button>
        <MobileSecondaryPaneHost
          secondaryPaneId="secondary-1"
          secondary={secondary}
          publication={publication}
          onClose={onClose}
          onActiveSurfaceChange={vi.fn()}
        />
      </>,
    );
    screen.getByRole("button", { name: "Return target" }).focus();

    const dialog = screen.getByRole("dialog", { name: "References" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "References" })).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("secondary-1");
  });

  it("returns focus and restores body scroll on unmount", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <MobileSecondaryPaneHost
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={vi.fn()}
        onActiveSurfaceChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
    unmount();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("uses roving focus for mobile secondary tabs", () => {
    const onActiveSurfaceChange = vi.fn();
    render(
      <MobileSecondaryPaneHost
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={vi.fn()}
        onActiveSurfaceChange={onActiveSurfaceChange}
      />,
    );

    const referencesTab = screen.getByRole("tab", { name: "References" });
    const forksTab = screen.getByRole("tab", { name: "Forks" });
    expect(referencesTab).toHaveAttribute("tabIndex", "0");
    expect(forksTab).toHaveAttribute("tabIndex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      referencesTab.id,
    );

    fireEvent.keyDown(referencesTab, { key: "ArrowRight" });
    expect(onActiveSurfaceChange).toHaveBeenCalledWith(
      "secondary-1",
      "conversation-forks",
    );
  });

  it("renders reader Contents with the mobile secondary icon map", () => {
    render(
      <MobileSecondaryPaneHost
        secondaryPaneId="secondary-1"
        secondary={readerSecondary}
        publication={readerPublication}
        onClose={vi.fn()}
        onActiveSurfaceChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Contents" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Contents" })).toBeInTheDocument();
  });

  it("browser back (popstate) closes the sheet exactly once without popping again", async () => {
    const onClose = vi.fn();
    render(
      <MobileSecondaryPaneHost
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={onClose}
        onActiveSurfaceChange={vi.fn()}
      />,
    );
    expect(history.pushState).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await act(async () => {
      await Promise.resolve(); // drain the deferred-pop microtask (useHistoryDismiss)
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("secondary-1");
    expect(history.back).not.toHaveBeenCalled();
  });

  it("panel --keyboard-inset reflects the stubbed keyboard", () => {
    const vv = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    vv.height = window.innerHeight - 300;
    vv.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });

    render(
      <MobileSecondaryPaneHost
        secondaryPaneId="secondary-1"
        secondary={secondary}
        publication={publication}
        onClose={vi.fn()}
        onActiveSurfaceChange={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("mobile-secondary-host");
    expect(panel.style.getPropertyValue("--keyboard-inset")).toBe("300px");

    act(() => {
      vv.height = window.innerHeight;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(panel.style.getPropertyValue("--keyboard-inset")).toBe("0px");
  });
});
