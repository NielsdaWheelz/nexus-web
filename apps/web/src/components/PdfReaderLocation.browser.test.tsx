import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { onePagePdf } from "./__tests__/pdfFixtures";
import { LocationReader, QUADS } from "./__tests__/pdfLocation";

it("holds PDF location completion through pulse retirement and cancels replaced or aborted work", async () => {
  await page.viewport(1280, 800);
  const url = URL.createObjectURL(onePagePdf("Retained PDF location"));
  const outcomes = new Map<number, string>();
  const view = render(
    <MobileViewportProvider>
      <MobileChromeProvider>
        <ShareControllerProvider>
          <LocationReader
            url={url}
            quads={QUADS}
            observe={(id, outcome) => outcomes.set(id, outcome)}
          />
        </ShareControllerProvider>
      </MobileChromeProvider>
    </MobileViewportProvider>,
  );
  try {
    await screen.findByTestId("pdf-page-text-layer-1", {}, { timeout: 10000 });
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "reader ready" }).textContent,
      ).toBe("true"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "locate target" }),
    );
    await waitFor(() =>
      expect(
        screen.queryAllByTestId(/^pdf-highlight-reader-pulse-/).length,
      ).toBe(1),
    );
    expect(
      screen.getByRole("status", { name: "location 1" }).textContent,
      "PDF location completed before its pulse geometry retired",
    ).toBe("pending");
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "location 1" }).textContent,
        ).toBe("true:0"),
      { timeout: 3000 },
    );

    await userEvent.click(
      screen.getByRole("button", { name: "locate then abort" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "location 2" }).textContent,
      ).toBe("aborted:0"),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "locate target" }),
    );
    await waitFor(() =>
      expect(
        screen.queryAllByTestId(/^pdf-highlight-reader-pulse-/).length,
      ).toBe(1),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "abort location" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "location 3" }).textContent,
      ).toBe("aborted:0"),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "locate target" }),
    );
    await waitFor(() =>
      expect(
        screen.queryAllByTestId(/^pdf-highlight-reader-pulse-/).length,
      ).toBe(1),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "locate target" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "location 4" }).textContent,
      ).toBe("false:0"),
    );
    await waitFor(
      () =>
        expect(
          screen.getByRole("status", { name: "location 5" }).textContent,
        ).toBe("true:0"),
      { timeout: 3000 },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "locate unavailable page" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "location 6" }).textContent,
      ).toBe("false:0"),
    );

    await userEvent.click(screen.getByRole("button", { name: "locate page" }));
    await waitFor(() => expect(outcomes.get(7), "PDF page location did not settle without fabricated geometry").toBe("true:0"));
    const viewport = screen.getByRole("region", { name: "PDF document" }).getBoundingClientRect();
    const firstPage = screen.getByTestId("pdf-page-surface-1").getBoundingClientRect();
    expect(Math.abs(firstPage.top - viewport.top), "PDF page location acknowledged before positioning the page").toBeLessThanOrEqual(1);
    await userEvent.click(screen.getByRole("button", { name: "locate page then abort" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "location 8" })).toHaveTextContent("aborted:0"));

    await userEvent.click(
      screen.getByRole("button", { name: "locate target" }),
    );
    await waitFor(() =>
      expect(
        screen.queryAllByTestId(/^pdf-highlight-reader-pulse-/).length,
      ).toBe(1),
    );
    view.unmount();
    await waitFor(() =>
      expect(
        outcomes.get(9),
        "unmounted PDF left its location caller pending",
      ).toBe("false:0"),
    );
    expect(
      screen.queryAllByTestId(/^pdf-highlight-reader-pulse-/),
    ).toHaveLength(0);
  } finally {
    view.unmount();
    URL.revokeObjectURL(url);
  }
});
