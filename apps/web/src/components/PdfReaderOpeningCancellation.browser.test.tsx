import { render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { cdp } from "vitest/browser";
import "pdfjs-dist/web/pdf_viewer.css";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PdfLoadingReader } from "./__tests__/pdfLoading";
import type { PdfReaderResources } from "./PdfReader";

it("closing a reader aborts its unfinished initial PDF HTTP work before source opening completes", async () => {
  const visit = crypto.randomUUID();
  const url = `${window.location.origin}/__pdf_loading/range/16.pdf?hold=1&visit=${visit}`;
  const source: PdfReaderResources = { signedUrl: { status: "ready", data: { url } }, pageHighlights: { status: "idle" },
    retryPageHighlights: null, requestSignedUrlRefresh: () => { throw new Error("Held source cannot need URL renewal"); } };
  const client = cdp();
  await client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  const started = new Set<string>();
  const pending = new Set<string>();
  const cancelled = new Set<string>();
  const begin: Parameters<typeof client.on<"Network.requestWillBeSent">>[1] = (event) => {
    if (event.request.url === url) { started.add(event.requestId); pending.add(event.requestId); }
  };
  const finish: Parameters<typeof client.on<"Network.loadingFinished">>[1] = (event) => { pending.delete(event.requestId); };
  const fail: Parameters<typeof client.on<"Network.loadingFailed">>[1] = (event) => {
    pending.delete(event.requestId);
    if (started.has(event.requestId) && event.canceled) cancelled.add(event.requestId);
  };
  client.on("Network.requestWillBeSent", begin); client.on("Network.loadingFinished", finish); client.on("Network.loadingFailed", fail);
  const actual = { controls: null, find: null };
  const view = render(<MobileViewportProvider><MobileChromeProvider><ShareControllerProvider><PdfLoadingReader resources={source} observe={actual} /></ShareControllerProvider></MobileChromeProvider></MobileViewportProvider>);
  try {
    await waitFor(() => expect(pending.size, "held PDF source never began physical HTTP work").toBeGreaterThan(0), { timeout: 15000 });
    expect(screen.getByText("Loading PDF…")).toBeVisible();
    expect(actual.find, "held PDF unexpectedly completed source opening").toBeNull();
    view.unmount();
    await waitFor(() => expect(pending.size, "retired reader left its unfinished PDF HTTP task running").toBe(0));
    expect(cancelled.size, "retired PDF source completed instead of cancelling held HTTP work").toBeGreaterThan(0);
  } finally {
    view.unmount();
    await fetch(`/__pdf_loading/release?visit=${visit}`);
    await waitFor(() => expect(pending.size).toBe(0), { timeout: 30000 });
    await client.send("Network.disable");
    client.off("Network.requestWillBeSent", begin); client.off("Network.loadingFinished", finish); client.off("Network.loadingFailed", fail);
  }
});
