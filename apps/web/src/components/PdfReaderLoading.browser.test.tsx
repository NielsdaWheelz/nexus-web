import { render, screen, waitFor } from "@testing-library/react";
import { afterAll, expect, it } from "vitest";
import { cdp, commands, page, server } from "vitest/browser";
import "pdfjs-dist/web/pdf_viewer.css";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { nativeBrowserMemory } from "./__tests__/browserMemory";
import type { PdfFindRuntime } from "./pdfPaneFind";
import type { PdfReaderControlActions, PdfReaderResources } from "./PdfReader";
import { PdfLoadingReader } from "./__tests__/pdfLoading";

const observations: object[] = [];
for (const [mode, mib, cycle] of [["range", 16, 1], ["range", 100, 1], ["range", 100, 2], ["range", 100, 3], ["whole", 16, 1]] as const) {
  it(`reads distant pages and complete Find through ${mode} HTTP at ${mib} MiB, cycle ${cycle}, without unsolicited range prefetch`, async () => {
    await page.viewport(1280, 800);
    const url = `${window.location.origin}/__pdf_loading/${mode}/${mib}.pdf?visit=${crypto.randomUUID()}`;
    const client = cdp();
    // Observe byte events without making DevTools preserve response bodies.
    await client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    const browser = await client.send("Browser.getVersion");
    const workers = async () => (await client.send("Target.getTargets")).targetInfos
      .filter((target) => target.type === "worker" && target.url === `${window.location.origin}/pdfjs/pdf.worker.min.mjs`)
      .map((target) => target.targetId);
    const baselineWorkers = new Set(await workers());
    let sourceWorkers: string[] = [];
    const requests = new Map<string, { status: number | null; bytes: number; finished: boolean; failed: boolean }>();
    let sourceSha256: string | null = null;
    const start: Parameters<typeof client.on<"Network.requestWillBeSent">>[1] = (event) => {
      if (event.request.url === url) requests.set(event.requestId, { status: null, bytes: 0, finished: false, failed: false });
    };
    const response: Parameters<typeof client.on<"Network.responseReceived">>[1] = (event) => {
      const request = requests.get(event.requestId);
      if (request !== undefined) {
        request.status = event.response.status;
        for (const [key, value] of Object.entries(event.response.headers)) if (key.toLowerCase() === "x-nexus-test-source-sha256") {
          if (typeof value !== "string") throw new Error("PDF fixture omitted its exact source hash");
          sourceSha256 = value;
        }
      }
    };
    const receive: Parameters<typeof client.on<"Network.dataReceived">>[1] = (event) => {
      const request = requests.get(event.requestId); if (request !== undefined) request.bytes += event.dataLength;
    };
    const finish: Parameters<typeof client.on<"Network.loadingFinished">>[1] = (event) => {
      const request = requests.get(event.requestId); if (request !== undefined) request.finished = true;
    };
    const fail: Parameters<typeof client.on<"Network.loadingFailed">>[1] = (event) => {
      const request = requests.get(event.requestId); if (request !== undefined) { request.finished = true; request.failed = true; }
    };
    client.on("Network.requestWillBeSent", start); client.on("Network.responseReceived", response);
    client.on("Network.dataReceived", receive); client.on("Network.loadingFinished", finish); client.on("Network.loadingFailed", fail);
    const settled = () => waitFor(() => {
      expect(requests.size, "actual PDF HTTP transport was never observed").toBeGreaterThan(0);
      expect([...requests.values()].filter((request) => !request.finished), "PDF HTTP requests remained active").toHaveLength(0);
    }, { timeout: 30000 });
    const memory = async () => ({ heap: await client.send("Runtime.getHeapUsage"), dom: await client.send("Memory.getDOMCounters"), native: await nativeBrowserMemory() });
    const snapshot = () => ({ requests: [...requests.values()].map((request) => ({ ...request })), bytes: [...requests.values()].reduce((sum, request) => sum + request.bytes, 0) });
    const actual = { controls: null as PdfReaderControlActions | null, find: null as PdfFindRuntime | null };
    const source: PdfReaderResources = { signedUrl: { status: "ready", data: { url } }, pageHighlights: { status: "idle" },
      retryPageHighlights: null, requestSignedUrlRefresh: () => { throw new Error("Fresh fixture unexpectedly required signed URL renewal"); } };
    await client.send("HeapProfiler.collectGarbage");
    const baseline = await memory();
    const began = performance.now();
    const view = render(<MobileViewportProvider><MobileChromeProvider><ShareControllerProvider><PdfLoadingReader resources={source} observe={actual} /></ShareControllerProvider></MobileChromeProvider></MobileViewportProvider>);
    const phases: Record<string, object> = { baseline };
    try {
      await screen.findByTestId("pdf-page-text-layer-1", {}, { timeout: 15000 });
      await waitFor(() => expect(screen.getByTestId("pdf-page-text-layer-1")).toHaveTextContent(`Page 1 of ${mib * 2}: needle`));
      sourceWorkers = (await workers()).filter((id) => !baselineWorkers.has(id));
      expect(sourceWorkers, "actual PDF opened without an observable owned worker").toHaveLength(1);
      await settled();
      expect(sourceSha256, "actual PDF HTTP source omitted its identity receipt").toMatch(/^[0-9a-f]{64}$/);
      phases.open = { ...snapshot(), memory: await memory(), readyMs: performance.now() - began };
      // Browser frame and transport barriers observe the settled idle state;
      // no timeout or simulated scheduler stands in for transfer completion.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await settled();
      phases.idle = { ...snapshot(), memory: await memory() };
      const first = snapshot();
      if (mode === "range") {
        expect(first.requests.some((request) => request.status === 206), "PDF ignored available range delivery").toBe(true);
        expect(first.bytes, "opening one PDF page eagerly consumed the complete source").toBeLessThan(mib * 1024 ** 2 / 2);
      } else expect(first.bytes, "non-range fallback omitted source bytes").toBeGreaterThanOrEqual(mib * 1024 ** 2);
      await waitFor(() => expect(actual.controls === null || actual.find === null, "PDF failed to publish ready navigation/Find capabilities").toBe(false));
      if (actual.controls === null || actual.find === null) throw new Error("Ready PDF capabilities retired unexpectedly");
      expect(await actual.controls.locatePage(mib * 2, new AbortController().signal), "distant page was acknowledged without position").toBe(true);
      await screen.findByTestId(`pdf-page-text-layer-${mib * 2}`, {}, { timeout: 15000 });
      await waitFor(() => expect(screen.getByTestId(`pdf-page-text-layer-${mib * 2}`)).toHaveTextContent(`Page ${mib * 2} of ${mib * 2}: needle`));
      await settled();
      phases.distant = { ...snapshot(), memory: await memory() };
      const found = await actual.find.search({ generation: 1, query: "needle", scope: { kind: "EntirePdf" }, matchCase: true, wholeWord: true, signal: new AbortController().signal });
      expect(found.kind, "complete Find could not search unloaded PDF pages").toBe("Ready");
      if (found.kind !== "Ready") throw new Error("Complete Find did not produce occurrences");
      expect(found.occurrences.map((item) => item.locator.pageNumber), "complete Find omitted or duplicated independently labeled pages").toEqual(Array.from({ length: mib * 2 }, (_, i) => i + 1));
      await settled();
      phases.find = { ...snapshot(), memory: await memory() };
    } finally {
      view.unmount();
      await settled();
      await waitFor(async () => expect((await workers()).filter((id) => sourceWorkers.includes(id)), "retired PDF retained its physical worker").toHaveLength(0), { timeout: 15000 });
      await client.send("Network.disable");
      await client.send("HeapProfiler.collectGarbage");
      phases.released = { ...snapshot(), memory: await memory() };
      observations.push({ mode, cycle, browser, sourceWorkers, sourceSha256, sourceBytes: mib * 1024 ** 2, pages: mib * 2, phases });
      client.off("Network.requestWillBeSent", start); client.off("Network.responseReceived", response);
      client.off("Network.dataReceived", receive); client.off("Network.loadingFinished", finish); client.off("Network.loadingFailed", fail);
    }
  }, 120000);
}

afterAll(async () => {
  const directory = server.config.env.NEXUS_TEST_RESULTS_DIR;
  const runId = server.config.env.NEXUS_TEST_EVIDENCE_RUN_ID;
  if (!/^[0-9a-f]{16}$/.test(runId) || !directory.startsWith("/") || !directory.endsWith(`/test-results/runs/${runId}`)) throw new Error("PDF measurements require the controller-owned evidence directory");
  const evidence = JSON.stringify({ version: 1, runId,
    scope: "actual Chromium HTTP and PdfReader byte-demand experiment; excludes production object-store, Android WebView, complex images/operators and profiler-free capacity qualification; high-water sums are not simultaneous peaks",
    observations });
  if (evidence.length > 512 * 1024) throw new Error("PDF measurements exceeded their diagnostic byte bound");
  await commands.writeFile(`${directory}/pdf-loading.json`, evidence);
});
