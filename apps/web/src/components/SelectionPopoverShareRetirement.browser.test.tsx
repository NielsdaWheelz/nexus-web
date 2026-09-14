import { useLayoutEffect, useRef, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { cdp, page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import SelectionPopover from "./SelectionPopover";

it("releases the retired Share trigger while its highlight write is pending and opens the acknowledged destination", async () => {
  const highlightId = "22222222-2222-4222-8222-222222222222";
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const pending: { finish: ((value: { id: string }) => void) | null } = { finish: null };
  const shareSubjects: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path !== `/api/resource-items/${encodeURIComponent(`highlight:${highlightId}`)}/shares`) {
      throw new Error(`Sharing escaped the acknowledged highlight: ${path}`);
    }
    shareSubjects.push(`highlight:${highlightId}`);
    return Response.json({ data: { subject: `highlight:${highlightId}`, sharing: "HighlightGrants",
      authenticatedHref: `${process.env.NEXT_PUBLIC_APP_PUBLIC_ORIGIN}/media/${mediaId}#highlight-${highlightId}`,
      creationAvailability: { user: { kind: "Available" }, link: { kind: "Available" } },
      shares: [], receivedAccess: [] } });
  });
  function Reader({ open }: { open: boolean }) {
    const root = useRef<HTMLElement>(null);
    const [rect, setRect] = useState<DOMRect | null>(null);
    useLayoutEffect(() => { setRect(root.current!.getBoundingClientRect()); }, []);
    return <MobileViewportProvider><ShareControllerProvider>
      <article ref={root} aria-label="Source reader"><p>Original selected passage</p></article>
      {open && rect !== null ? <SelectionPopover selectionRect={rect} containerRef={root}
        onCreateHighlight={() => new Promise<{ id: string }>((resolve) => { pending.finish = resolve; })}
        onDismiss={() => {}} /> : null}
    </ShareControllerProvider></MobileViewportProvider>;
  }
  const view = render(<Reader open />, { reactStrictMode: true });
  try {
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: selector-backed browser input keeps Vitest completion errors from retaining the retired DOM
    await page.getByRole("button", { name: "More", exact: true }).click();
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: selector-backed browser input keeps Vitest completion errors from retaining the retired DOM
    await page.getByRole("menuitem", { name: "Share", exact: true }).click();
    await waitFor(() => expect(pending.finish).not.toBeNull());
    await act(async () => pending.finish!({ id: highlightId }));
    pending.finish = null;
    await screen.findByRole("dialog", { name: "Share" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Share" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "More" }), "closing Share did not return focus to the live selection trigger").toHaveFocus();
    const trigger = new WeakRef(screen.getByRole("button", { name: "More" }));
    // Observe liveness before the existing browser actions; deref itself keeps
    // its target alive through the current execution of JavaScript.
    expect(trigger.deref()?.isConnected).toBe(true);
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: selector-backed browser input keeps Vitest completion errors from retaining the retired DOM
    await page.getByRole("button", { name: "More", exact: true }).click();
    // eslint-disable-next-line testing-library/prefer-screen-queries -- justify-eslint-override: selector-backed browser input keeps Vitest completion errors from retaining the retired DOM
    await page.getByRole("menuitem", { name: "Share", exact: true }).click();
    await waitFor(() => expect(pending.finish).not.toBeNull());
    view.rerender(<Reader open={false} />);
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
    expect(document.visibilityState).toBe("visible");
    // Synchronous detach can precede Blink's retirement of the old layout tree.
    // Cross one rendering opportunity before collecting the detached trigger.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await cdp().send("HeapProfiler.collectGarbage");
    expect(trigger.deref(), "pending Share retained its retired return-focus button").toBeUndefined();
    await act(async () => pending.finish!({ id: highlightId }));
    await screen.findByRole("dialog", { name: "Share" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled());
    expect(new Set(shareSubjects), "retiring selection discarded its acknowledged Share destination").toEqual(new Set([`highlight:${highlightId}`]));
  } finally { pending.finish?.({ id: highlightId }); view.unmount(); vi.unstubAllGlobals(); }
});
