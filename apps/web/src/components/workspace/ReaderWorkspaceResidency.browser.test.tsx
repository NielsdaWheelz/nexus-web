import { act, render, screen, waitFor } from "@testing-library/react";
import { cdp, page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/app/globals.css";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import ActivityCaptureLifecycle from "@/lib/consumption/ActivityCaptureLifecycle";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ArtworkProvider } from "@/lib/media/ArtworkProvider";
import { ARTWORK_CAPACITY } from "@/lib/media/artworkCapacity";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { HostedReaderProgressProvider } from "@/lib/reader/HostedReaderProgressProvider";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { ResourceOverlaysProvider } from "@/lib/resources/resourceOverlaysController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";

import WorkspaceHost from "@/components/workspace/WorkspaceHost";
import { ImportsProvider } from "@/lib/imports/ImportsProvider";
import { OfflineReadingProvider } from "@/lib/offlineReading/OfflineReadingProvider";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { createEmptyPaneHistory, createPaneVisit, createWorkspaceStateFromPrimaryPanes } from "@/lib/workspace/schema";
import { onePagePdf } from "../__tests__/pdfFixtures";

/** The actual host restores twelve compact visits; hidden readers must not start PDF workers. */
it("opens only displayed PDF bodies when twelve reader visits are restored", async () => {
  await page.viewport(1500, 950);
  const accountId = crypto.randomUUID();
  const mediaIds = Array.from({ length: 12 }, () => crypto.randomUUID());
  const pdf = onePagePdf("Restored reader source");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const descriptors = await Promise.all(mediaIds.map(async (mediaId) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ media_id: mediaId, reader_generation: 7, reader_contract_version: 1,
      title: "Restored PDF", kind: "pdf", page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256: digest } }));
    return { bytes, hash: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) };
  }));
  const json = (data: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength) } });
  };
  const profile = { theme: "light", font_family: "serif", font_size_px: 18, line_height: 1.6, column_width_ch: 65, focus_mode: "off", hyphenation: "off" } as const;
  const counts = { contents: 0, embeds: 0, highlights: 0, source_references: 0, generated_citations: 0, links: 0, synapses: 0 };
  const opened = new Set<string>();
  const acquired = new Set<string>();
  const hydrated = new Set<string>();
  const originalFetch = window.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (!path.startsWith("/api/")) return originalFetch(input, init);
    if (path === "/api/me/reader-profile") return json(profile);
    if (path === "/api/lectern") return json({ items: [] });
    if (path === "/api/resource-items/locators/resolve") {
      const { locators } = JSON.parse(String(init?.body));
      return json({ resolutions: locators.map((locator: { ref: string }) => {
        const id = locator.ref.slice("media:".length);
        const href = `/media/${id}`;
        return { locator, canonicalHref: href, documentReader: true, resourceItem: { ref: locator.ref, scheme: "media", id,
          label: "Restored PDF", summary: "", route: href, missing: false,
          activation: { resourceRef: locator.ref, kind: "route", href, unresolvedReason: null }, versionByLane: {},
          capabilities: { userRelation: { userLinkSource: false, userLinkTarget: "none", noteReferenceTarget: false },
            sharing: "None", libraryPlacement: "None", attachable: false, chatSubject: "none", readable: "none", inspectable: "none",
            citableResultType: null, citationOutputSource: false, appSearchScope: false, conversationSearchScope: false,
            promptRender: "none", expansionPolicy: "none", expandable: false, adjacencySource: true, adjacencyTarget: true } } };
      }) });
    }
    const mediaId = path.split("/")[3];
    const ordinal = mediaIds.indexOf(mediaId);
    if (ordinal < 0) throw new Error(`Unexpected reader workspace request: ${path}`);
    if (path === `/api/media/${mediaId}`) {
      hydrated.add(mediaId);
      return json({ id: mediaId, kind: "pdf", title: "Restored PDF", canonical_source_url: null,
      processing_status: "ready_for_reading", source_progress: { kind: "Absent" }, transcript_state: null, transcript_coverage: null, transcript_origin: { kind: "Absent" },
      retrieval_status: "ready", retrieval_status_reason: null, failure_stage: null, last_error_code: null, playback_source: null,
      listening_state: null, episode_state: null, chapters: [], capabilities: {
        can_read: true, can_highlight: true, can_quote: true, can_search: true, can_play: false, can_download_file: false, can_delete: false,
        can_retry: false, can_refresh_source: false, can_retry_metadata: false, can_repair_source: false, can_repair_search: false,
        can_edit_authors: false, can_read_embeds: false,
      }, document_embed_summary: null, contributors: [], author_mode: "automatic", published_date: null, publisher: null, language: "en",
      description: null, description_html: null, description_text: null, metadata_enriched_at: null, read_state: "unread", progress_fraction: null,
      progress_resettable: false, last_engaged_at: null, playerDescriptor: { kind: "Absent" }, created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z" });
    }

    if (path.endsWith("/reader-publication")) {
      acquired.add(mediaId);
      const descriptor = descriptors[ordinal];
      return new Response(descriptor.bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(descriptor.bytes.byteLength),
        "Content-Digest": `sha-256=:${btoa(String.fromCharCode(...descriptor.hash))}:`, "X-Nexus-Reader-Generation": "7" } });
    }
    if (path.endsWith("/assets/document.pdf")) {
      opened.add(mediaId);
      return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Length": String(pdf.size) } });
    }
    if (path.endsWith("/offline-reader-state")) return json({ accountId, readerGeneration: 7, cursor: { state: "Empty", revision: 0 } });
    if (path.endsWith("/pdf-highlights")) return json({ page_number: JSON.parse(String(init?.body)).page_number,
      source_sha256: digest, highlights: [], next_cursor: null });
    if (path.endsWith("/evidence/overview")) return json({ bucket_count: JSON.parse(String(init?.body)).bucket_count, buckets: [], unavailable_counts: counts });
    if (path.endsWith("/evidence/gutter")) return json({ items: [], total_count: 0, next_cursor: null });
    throw new Error(`Unexpected reader workspace request: ${path}`);
  });
  const metrics = { primaryMinWidthPx: 684, primaryDefaultWidthPx: 720 };
  const initialState = createWorkspaceStateFromPrimaryPanes({ activePrimaryPaneId: "reader-0", primaryPanes: mediaIds.map((id, index) => ({
    id: `reader-${index}`, currentVisit: createPaneVisit(`/media/${id}`), primaryWidthPx: index === 1 ? 1200 : 720,
    visibility: index < 2 ? "visible" : "minimized", history: createEmptyPaneHistory(), attachedSecondaryPaneId: null,
  })) });
  const client = cdp();
  const outerPoint = (x: number, y: number) => {
    const frame = window.frameElement;
    if (frame === null) throw new Error("Trusted input requires the actual browser test frame");
    const style = window.getComputedStyle(frame);
    expect([style.borderLeftWidth, style.borderRightWidth, style.borderTopWidth, style.borderBottomWidth,
      style.paddingLeft, style.paddingRight, style.paddingTop, style.paddingBottom],
      "browser test frame must expose an uninset content viewport").toEqual(Array(8).fill("0px"));
    const bounds = frame.getBoundingClientRect();
    if (frame.clientWidth <= 0 || frame.clientHeight <= 0) throw new Error("Browser test frame has no content viewport");
    return { x: bounds.left + x * bounds.width / frame.clientWidth,
      y: bounds.top + y * bounds.height / frame.clientHeight };
  };
  const workers = async () => (await client.send("Target.getTargets")).targetInfos
    .filter((target) => target.type === "worker" && target.url === `${window.location.origin}/pdfjs/pdf.worker.min.mjs`).map((target) => target.targetId);
  const baseline = new Set(await workers());
  const view = render(<RenderEnvironmentProvider value={{ androidShell: false, platform: "linux", displayLocale: "en-US", displayTimeZone: "UTC",
    currentInstant: "2026-09-14T00:00:00Z", currentLocalDate: "2026-09-14", initialViewport: "desktop" }}>
    <AuthenticatedAccountProvider account={{ accountId, calendarTimeZone: "UTC" }}>
      <ActivityCaptureLifecycle accountId={accountId} />
      <ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}><ArtworkProvider limits={ARTWORK_CAPACITY}>
        <ReaderProvider initialProfile={profile}><MobileViewportProvider><MobileChromeProvider><FeedbackProvider><ShareControllerProvider>
          <LibraryPlacementControllerProvider><PaneReturnMementoProvider><KeybindingsProvider>
            <WorkspaceStoreProvider initialState={initialState} workspacePrimaryMetrics={metrics}>
              <HostedReaderProgressProvider accountId={accountId}><LecternProvider><OfflineReadingProvider accountId={accountId}>
                <OfflineMediaProvider accountId={accountId} transport={null}><ResourceOverlaysProvider><GlobalPlayerProvider accountId={accountId}>
                  <ResourceActionRuntimeProvider><ImportsProvider><div style={{ position: "fixed", inset: 20, height: 900 }}><WorkspaceHost /></div></ImportsProvider></ResourceActionRuntimeProvider>
                </GlobalPlayerProvider></ResourceOverlaysProvider></OfflineMediaProvider>
              </OfflineReadingProvider></LecternProvider></HostedReaderProgressProvider>
            </WorkspaceStoreProvider>
          </KeybindingsProvider></PaneReturnMementoProvider></LibraryPlacementControllerProvider>
        </ShareControllerProvider></FeedbackProvider></MobileChromeProvider></MobileViewportProvider></ReaderProvider>
      </ArtworkProvider></ResourceCacheProvider>
    </AuthenticatedAccountProvider>
  </RenderEnvironmentProvider>, { reactStrictMode: true });
  try {
    await waitFor(() => expect(screen.getAllByTestId("pdf-page-text-layer-1").filter((node) => node.getBoundingClientRect().width > 0)).toHaveLength(2), { timeout: 15000 });
    expect([...hydrated].filter((id) => mediaIds.indexOf(id) >= 2), "minimized restored readers hydrated full media bodies").toHaveLength(0);
    expect([...acquired].filter((id) => mediaIds.indexOf(id) >= 2), "minimized restored readers acquired document descriptors").toHaveLength(0);
    expect([...opened].filter((id) => mediaIds.indexOf(id) >= 2), "minimized restored readers opened PDF source bodies").toHaveLength(0);
    let resident = (await workers()).filter((id) => !baseline.has(id));
    expect(resident, "two displayed readers retained extra PDF workers").toHaveLength(2);
    await page.viewport(1000, 950);
    const host = screen.getByRole("region", { name: "Workspace host" }).getBoundingClientRect();
    const firstReader = screen.getAllByRole("region", { name: "PDF document" })[0];
    const secondReader = screen.getAllByRole("region", { name: "PDF document" })[1];
    act(() => firstReader.focus());
    expect(firstReader).toHaveFocus();
    const wheelPoint = (() => {
      const chrome = screen.getAllByTestId("pane-shell-chrome")[0];
      const bounds = chrome.getBoundingClientRect();
      // The PDF instrument row contains horizontal overscroll. Wheel the canvas
      // through its ordinary top chrome, as the later return gesture does.
      const point = { x: (Math.max(host.left, bounds.left) + Math.min(host.right, bounds.right)) / 2,
        y: bounds.top + 4 };
      const target = document.elementFromPoint(point.x, point.y);
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: Chromium hit-testing verifies the native wheel is outside the independently scrolling instrument row
      expect(target?.closest('[data-testid="pane-shell-chrome"]')).toBe(chrome);
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: the contextual row contains its own horizontal overscroll, so it is not a canvas-wheel target
      expect(target?.closest('[data-testid="pane-contextual-row"]')).toBeNull();
      return point;
    })();
    const wheelOuter = outerPoint(wheelPoint.x, wheelPoint.y);
    let trustedWheel = false;
    const observeWheel = (event: WheelEvent) => { trustedWheel = event.isTrusted; };
    document.addEventListener("wheel", observeWheel, { capture: true, once: true });
    try {
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheelOuter, deltaX: 2000, deltaY: 0 });
      await waitFor(() => expect(trustedWheel, "canvas movement requires a trusted wheel").toBe(true));
      await waitFor(() => expect(firstReader.getBoundingClientRect().right,
        "the canvas wheel did not move the focused reader offscreen").toBeLessThanOrEqual(host.left));
    } finally { document.removeEventListener("wheel", observeWheel, true); }
    expect(firstReader, "moving a focused reader offscreen retired its body").toBeInTheDocument();
    expect(firstReader).toHaveFocus();
    act(() => secondReader.focus());
    await waitFor(() => expect(firstReader, "an offscreen reader stayed mounted after focus left").not.toBeInTheDocument());
    await waitFor(async () => expect((await workers()).filter((id) => !baseline.has(id))).toHaveLength(1));
    const returnToFirstReader = async () => {
      const chrome = screen.getAllByTestId("pane-shell-chrome")[1];
      const bounds = chrome.getBoundingClientRect();
      const x = (Math.max(host.left, bounds.left) + Math.min(host.right, bounds.right)) / 2;
      const y = bounds.top + 4;
      // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: Chromium hit-testing verifies the real wheel reaches pane chrome
      expect(document.elementFromPoint(x, y)?.closest('[data-testid="pane-shell-chrome"]')).toBe(chrome);
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...outerPoint(x, y), deltaX: -2000, deltaY: 0 });
    };
    await returnToFirstReader();
    await waitFor(() => expect(screen.getAllByTestId("pdf-page-text-layer-1")).toHaveLength(2), { timeout: 15000 });

    const draggedReader = screen.getAllByRole("region", { name: "PDF document" })[0];
    const dragChrome = screen.getAllByTestId("pane-shell-chrome")[0];
    await waitFor(() => expect(dragChrome.getBoundingClientRect().left,
      "return gesture did not bring the active pane's chrome into view").toBeGreaterThanOrEqual(host.left));
    const dragBounds = dragChrome.getBoundingClientRect();
    const resize = screen.getAllByRole("separator", { name: "Resize pane Restored PDF" })[0].getBoundingClientRect();
    const dragX = Math.min(host.right, resize.left) - 4;
    const dragY = dragBounds.top + 4;
    const dragEndX = Math.max(1, host.left - 19);
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: Chromium hit-testing verifies a non-interactive chrome drag target
    expect(document.elementFromPoint(dragX, dragY)?.closest('[data-testid="pane-shell-chrome"]')).toBe(dragChrome);
    const interactive = "button, a, input, select, textarea, [role='button'], [contenteditable]";
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: Chromium hit-testing verifies the production chrome drag exclusion
    expect(document.elementFromPoint(dragX, dragY)?.closest(interactive)).toBeNull();
    const trustedDrag = { down: false, move: false };
    const observeDown = (event: MouseEvent) => { trustedDrag.down = event.isTrusted; };
    const observeMove = (event: MouseEvent) => { trustedDrag.move = event.isTrusted; };
    document.addEventListener("mousedown", observeDown, { capture: true, once: true });
    let pressed = false;
    try {
      pressed = true;
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...outerPoint(dragX, dragY) });
      await waitFor(() => expect(trustedDrag.down, "canvas drag requires a trusted press").toBe(true));
      document.addEventListener("mousemove", observeMove, { capture: true, once: true });
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1,
        ...outerPoint(dragEndX, dragY) });
      await waitFor(() => expect(trustedDrag.move, "canvas drag requires trusted movement").toBe(true));
      await waitFor(() => expect(draggedReader.getBoundingClientRect().right,
        "the canvas drag did not move the reader offscreen").toBeLessThanOrEqual(host.left));
      expect(draggedReader, "an unfinished canvas drag retired an offscreen reader").toBeInTheDocument();
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1,
        ...outerPoint(dragEndX, dragY) });
      pressed = false;
      await waitFor(() => expect(draggedReader, "completed drag kept an unpinned reader mounted").not.toBeInTheDocument());
    } finally {
      document.removeEventListener("mousedown", observeDown, true);
      document.removeEventListener("mousemove", observeMove, true);
      if (pressed) await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1,
        ...outerPoint(dragEndX, dragY) });
    }
    await returnToFirstReader();
    await waitFor(() => expect(screen.getAllByTestId("pdf-page-text-layer-1")).toHaveLength(2), { timeout: 15000 });
    await page.viewport(1500, 950);
    resident = (await workers()).filter((id) => !baseline.has(id));
    expect(resident, "displayed reader restoration retained retired workers").toHaveLength(2);
    const selectedSource = screen.getAllByTestId("pdf-page-text-layer-1")[0];
    const selection = document.getSelection();
    if (selection === null) throw new Error("Chromium selection is unavailable");
    const range = document.createRange();
    range.selectNodeContents(selectedSource);
    const minimize = screen.getAllByRole("button", { name: "Minimize Restored PDF" })[0];
    // Selection capture and the real workspace action share one commit. The
    // stabilization delay has not yet published the floating action surface.
    act(() => {
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      minimize.click();
    });
    await waitFor(() => expect(selectedSource).not.toBeVisible());
    expect(selectedSource, "minimizing during selection capture retired its source").toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Highlight" }), "hidden selection kept floating controls visible").not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Restore Restored PDF" })[0]);
    await waitFor(() => expect(selectedSource).toBeVisible());
    await screen.findByRole("button", { name: "Highlight" });
    expect(selection.toString()).toContain("Restored reader source");
    expect(new Set((await workers()).filter((id) => !baseline.has(id))), "restoring a pinned source reopened its binary").toEqual(new Set(resident));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Highlight" })).not.toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Minimize Restored PDF" })[0]);
    await waitFor(() => expect(selectedSource, "an unpinned minimized source remained mounted").not.toBeInTheDocument());
    await waitFor(async () => expect((await workers()).filter((id) => !baseline.has(id)), "suspending a reader did not retire its physical worker").toHaveLength(1));
  } finally {
    view.unmount();
    await waitFor(async () => expect((await workers()).filter((id) => !baseline.has(id)), "retired workspace kept PDF workers").toHaveLength(0), { timeout: 15000 });
    vi.unstubAllGlobals();
  }
}, 30000);
