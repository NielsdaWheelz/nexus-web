import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { onePagePdf } from "./__tests__/pdfFixtures";
import { LocationReader, QUADS } from "./__tests__/pdfLocation";

// A location whose page has left the layout holds its caller instead of
// acknowledging an unpositioned target. Nothing re-renders that page once it
// returns, so the only resumption signal is the reader's layout callback
// changing identity: the target must re-arm on it rather than stay retired
// behind its idempotency key, and the acknowledgment must follow a real scroll.
it("resumes the same PDF target after its layout callback is replaced", async () => {
  await page.viewport(1280, 800);
  const url = URL.createObjectURL(onePagePdf("Retained PDF callback"));
  let reads = 0;
  const quads = new Proxy(QUADS, {
    get(target, key, receiver) {
      reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const outcomes = new Map<number, string>();
  const view = render(
    <MobileViewportProvider>
      <MobileChromeProvider>
        <ShareControllerProvider>
          <LocationReader
            url={url}
            quads={quads}
            observe={(id, outcome) => outcomes.set(id, outcome)}
          />
        </ShareControllerProvider>
      </MobileChromeProvider>
    </MobileViewportProvider>,
  );
  let pageElement: HTMLElement | null = null;
  let parent: HTMLElement | null = null;
  try {
    const textLayer = await screen.findByTestId(
      "pdf-page-text-layer-1",
      {},
      { timeout: 10000 },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "reader ready" }).textContent,
      ).toBe("true"),
    );
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: external PDF.js layout interruption requires detaching its actual page node.
    pageElement = textLayer.closest<HTMLElement>(".page");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: retain the exact external page parent for restoration after the controlled layout interruption.
    parent = pageElement?.parentElement ?? null;
    if (!pageElement || !parent)
      throw new Error("PDF.js did not install a page");
    const scrollport = screen.getByRole("region", { name: "PDF document" });

    pageElement.remove();
    await userEvent.click(
      screen.getByRole("button", { name: "locate target" }),
    );
    expect(
      reads,
      "PDF location never consulted its target geometry",
    ).toBeGreaterThan(0);
    expect(
      scrollport.scrollTop,
      "PDF location scrolled to a page that had left the layout",
    ).toBe(0);

    parent.append(pageElement);
    await userEvent.click(
      screen.getByRole("button", { name: "replace layout callback" }),
    );
    // Read the scroll the moment the replacement runs (PDF.js resets it about a
    // second later when it notices the DOM surgery), but judge the settle first:
    // a location that never resumes is the invariant, the scroll its symptom.
    const resumedScrollTop = scrollport.scrollTop;
    await waitFor(
      () =>
        expect(
          outcomes.get(1),
          "PDF location stalled after its layout callback changed",
        ).toBe("true:0"),
      { timeout: 4000 },
    );
    expect(
      resumedScrollTop,
      "resumed PDF location did not scroll to its target",
    ).toBeGreaterThan(0);
  } finally {
    if (pageElement && parent && !pageElement.isConnected)
      parent.append(pageElement);
    view.unmount();
    URL.revokeObjectURL(url);
  }
});
