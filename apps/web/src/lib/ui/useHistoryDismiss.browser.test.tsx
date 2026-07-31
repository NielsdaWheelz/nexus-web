import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { useHistoryDismiss } from "./useHistoryDismiss";

function NavigatingOverlay() {
  const [active, setActive] = useState(true);
  useHistoryDismiss(active, () => setActive(false), { isTopmost: true });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          history.replaceState(
            history.state,
            "",
            "/settings/keybindings?from=overlay",
          );
          setActive(false);
        }}
      >
        Open destination
      </button>
      <output aria-label="Current destination">
        {window.location.pathname}
        {window.location.search}
      </output>
    </>
  );
}

it("preserves a new destination when navigation precedes dismiss", async () => {
  const originalHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const originalState = history.state;
  const view = render(<NavigatingOverlay />);

  try {
    fireEvent.click(screen.getByRole("button", { name: "Open destination" }));

    await waitFor(() => {
      expect(
        `${window.location.pathname}${window.location.search}`,
      ).toBe("/settings/keybindings?from=overlay");
      expect(screen.getByLabelText("Current destination")).toHaveTextContent(
        "/settings/keybindings?from=overlay",
      );
      expect(history.state).not.toEqual(
        expect.objectContaining({ __nexusOverlayHistory: true }),
      );
    });
  } finally {
    view.unmount();
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const stillHasMarker =
      isRecord(history.state) && history.state.__nexusOverlayHistory === true;
    if (currentHref !== originalHref || stillHasMarker) {
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        history.back();
      });
    }
    history.replaceState(originalState, "", originalHref);
  }
});
