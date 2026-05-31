import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    document.body.style.overflow = "";
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
});
