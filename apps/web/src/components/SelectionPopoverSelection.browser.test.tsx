import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import SelectionPopover from "./SelectionPopover";

it("browser back dismisses one reader's selection actions without erasing another reader's selection", async () => {
  function Reader() {
    const root = useRef<HTMLElement>(null);
    const [rect, setRect] = useState<DOMRect | null>(null);
    return <MobileViewportProvider><ShareControllerProvider>
      <article ref={root} aria-label="Source reader"><p>Original selected passage</p></article>
      <article aria-label="Other reader">A later reader selection</article>
      <button type="button" onClick={() => {
        const range = document.createRange(); range.selectNodeContents(root.current!);
        const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        setRect(range.getBoundingClientRect());
      }}>Open source selection</button>
      {rect === null ? null : <SelectionPopover selectionRect={rect} containerRef={root}
        onCreateHighlight={async () => { throw new Error("Selection dismissal does not create a highlight"); }}
        onDismiss={() => setRect(null)} />}
    </ShareControllerProvider></MobileViewportProvider>;
  }
  const view = render(<Reader />);
  try {
    await userEvent.click(screen.getByRole("button", { name: "Open source selection" }));
    await screen.findByRole("button", { name: "Highlight" });
    const selection = document.getSelection()!;
    const later = document.createRange(); later.selectNodeContents(screen.getByRole("article", { name: "Other reader" }));
    selection.removeAllRanges(); selection.addRange(later);
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Highlight" })).not.toBeInTheDocument());
    expect(selection.toString(), "selection history dismissal erased another reader's range").toBe("A later reader selection");
    await userEvent.click(screen.getByRole("button", { name: "Open source selection" }));
    await screen.findByRole("button", { name: "Highlight" });
    expect(selection.toString()).toBe("Original selected passage");
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Highlight" })).not.toBeInTheDocument());
    expect(selection.toString(), "selection history dismissal left its own range selected").toBe("");
  } finally { view.unmount(); }
});
