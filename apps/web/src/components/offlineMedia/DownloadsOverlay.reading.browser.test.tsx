import { render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import DownloadsOverlay from "./DownloadsOverlay";
import DownloadsSurface from "./DownloadsSurface";
import { requestDownloadsOpen } from "./downloadsSurfaceIngress";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { OfflineReadingProvider } from "@/lib/offlineReading/OfflineReadingProvider";
import { OfflineMediaClientStore } from "@/lib/offlineMedia/clientStore";
import type { OfflineMediaController } from "@/lib/offlineMedia/controller";
import type { ReadingCommand } from "@/lib/offlineReading/contract";
import {
  OfflineReadingControllerRuntime,
  type OfflineReadingTransport,
} from "@/lib/offlineReading/runtime";

const AUDIO_ID = "018f2e74-5efc-7d0d-8a3a-142857142857";
const READING_ID = "018f2e74-5efc-7d1e-8a3a-142857142857";

function audioFixture() {
  const store = new OfflineMediaClientStore();
  store.installSnapshot(
    [{
      mediaId: AUDIO_ID,
      title: "Episode already downloaded",
      state: {
        kind: "Ready",
        sizeBytes: 2_000_000,
        contentType: "audio/mpeg",
        updatedAt: "2026-08-13T10:00:00Z",
      },
    }],
    "UnmeteredOnly",
  );
  const controller: OfflineMediaController = {
    enqueue: vi.fn(), cancel: vi.fn(), retry: vi.fn(), remove: vi.fn(),
    setNetworkPolicy: vi.fn(), openDownloads: vi.fn(),
  };
  return { kind: "Ready" as const, store, controller };
}

class ReadingBoundary implements OfflineReadingTransport {
  listener: ((message: unknown) => void) | null = null;
  readonly removed: string[] = [];
  readonly opened: string[] = [];
  readonly policies: string[] = [];
  rejectNextPolicy = false;
  items = true;

  start(listener: (message: unknown) => void) {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  send(command: ReadingCommand) {
    const snapshot = {
      binding: {
        kind: "Present",
        value: {
          accountId: "018f2e74-5efc-7d9e-8a3a-142857142857",
          authorizationRequired: false,
        },
      },
      networkPolicy: "UnmeteredOnly",
      items: this.items ? [{
        mediaId: READING_ID,
        title: "Plane Notes EPUB",
        mediaKind: "Epub",
        availability: {
          kind: "Ready",
          sizeBytes: 1_000_000,
          installedAt: "2026-08-13T10:00:00Z",
          readerGeneration: 1,
          readerRevisionKey: "a".repeat(64),
          progress: {
            kind: "Pending",
            baseline: { state: "Empty", revision: 0 },
            device: {
              kind: "epub",
              target: { section_id: "chapter-1", href_path: "EPUB/chapter-1.xhtml", anchor_id: null },
              locations: { text_offset: 12, progression: 0.5, total_progression: 0.5, position: 1 },
              text: { quote: null, quote_prefix: null, quote_suffix: null },
            },
          },
        },
      }] : [],
    };
    if (command.kind === "Remove") this.removed.push(command.mediaId);
    if (command.kind === "OpenDownloadedCopy") this.opened.push(command.mediaId);
    if (command.kind === "SetNetworkPolicy") {
      if (this.rejectNextPolicy) {
        this.rejectNextPolicy = false;
        queueMicrotask(() => this.listener?.({
          protocolVersion: 1,
          requestId: command.requestId,
          outcome: { kind: "Rejected", code: "Failed" },
        }));
        return;
      }
      this.policies.push(command.policy);
    }
    queueMicrotask(() => this.listener?.({
      protocolVersion: 1,
      requestId: command.requestId,
      outcome: command.kind === "ConnectHosted"
        ? { kind: "Connected", snapshot }
        : command.kind === "GetSnapshot"
          ? { kind: "Snapshot", snapshot: { ...snapshot, items: [] } }
          : { kind: "Accepted" },
    }));
  }
}

async function connectedReading(boundary: ReadingBoundary) {
  const controller = new OfflineReadingControllerRuntime(boundary);
  await controller.connect("Hosted");
  return { kind: "Ready" as const, controller };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("single Downloads surface composition", () => {
  it("preserves the audio-only inventory and actions", async () => {
    const audio = audioFixture();
    render(<MobileViewportProvider>
      <DownloadsOverlay open onClose={() => undefined} audio={audio} />
    </MobileViewportProvider>);

    await expect.element(screen.getByText("Episode already downloaded")).toBeVisible();
    await expect.element(screen.getByText("Downloaded · 2 MB")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(audio.controller.remove).toHaveBeenCalledWith(AUDIO_ID);
  });

  it("adds verified reading rows and dispatches to the reading owner", async () => {
    const audio = audioFixture();
    const boundary = new ReadingBoundary();
    const reading = await connectedReading(boundary);
    render(<MobileViewportProvider>
      <DownloadsOverlay open onClose={() => undefined} audio={audio} reading={reading} />
    </MobileViewportProvider>);

    await expect.element(screen.getByText("Plane Notes EPUB")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Listening" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Reading" })).toBeVisible();
    expect(screen.getByText("3 MB downloaded")).toBeVisible();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    boundary.rejectNextPolicy = true;
    await userEvent.click(screen.getByRole("checkbox", { name: /Download over mobile data/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be applied/u);
    expect(audio.controller.setNetworkPolicy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry setting" }));
    await vi.waitFor(() => expect(boundary.policies).toEqual(["AnyConnected"]));
    expect(audio.controller.setNetworkPolicy).not.toHaveBeenCalled();

    // One primary action on a ready reading row; removal lives in its overflow.
    const readingRow = within(screen.getByRole("list", { name: "Downloaded reading" }));
    expect(readingRow.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open downloaded copy" }));
    await vi.waitFor(() => expect(boundary.opened).toEqual([READING_ID]));

    await userEvent.click(
      readingRow.getByRole("button", { name: "More actions for Plane Notes EPUB" }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(confirm).toHaveBeenCalledWith(
      "Remove downloaded copy and discard this device's unsynced position.",
    );
    await vi.waitFor(() => expect(boundary.removed).toEqual([READING_ID]));
    expect(audio.controller.remove).not.toHaveBeenCalled();
    reading.controller.dispose();
  });

  it("lists reading downloads when only the reading capability connected", async () => {
    // Audio connect rejection is a supported degraded state; the one Downloads
    // surface must still show, and act on, reading downloads.
    const boundary = new ReadingBoundary();
    const reading = await connectedReading(boundary);
    render(<MobileViewportProvider>
      <DownloadsOverlay open onClose={() => undefined} audio={null} reading={reading} />
    </MobileViewportProvider>);

    await expect.element(screen.getByText("Plane Notes EPUB")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Reading" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Listening" })).not.toBeInTheDocument();
    expect(screen.getByText("1 MB downloaded")).toBeVisible();
    expect(screen.queryByText("No downloads.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open downloaded copy" }));
    await vi.waitFor(() => expect(boundary.opened).toEqual([READING_ID]));
    reading.controller.dispose();
  });

  it("shows one empty state for the whole surface", async () => {
    const boundary = new ReadingBoundary();
    boundary.items = false;
    const reading = await connectedReading(boundary);
    render(<MobileViewportProvider>
      <DownloadsOverlay open onClose={() => undefined} audio={null} reading={reading} />
    </MobileViewportProvider>);

    await expect.element(screen.getByText("No downloads.")).toBeVisible();
    expect(screen.queryByText("No downloaded reading.")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reading" })).not.toBeInTheDocument();
    reading.controller.dispose();
  });

  it("mounts the one Downloads surface when only the reading capability is Ready", async () => {
    // The audio bridge is absent on this device (a supported degraded state).
    // The single Downloads surface and its trigger must still exist, otherwise
    // reading downloads can be enqueued with nowhere to see or remove them.
    const boundary = new ReadingBoundary();
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineReadingProvider
            accountId="018f2e74-5efc-7d9e-8a3a-142857142857"
            transport={boundary}
          >
            <OfflineMediaProvider
              accountId="018f2e74-5efc-7d9e-8a3a-142857142857"
              transport={null}
            >
              <button type="button" onClick={() => requestDownloadsOpen()}>
                Open downloads
              </button>
              <DownloadsSurface />
            </OfflineMediaProvider>
          </OfflineReadingProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Open downloads" }));
    expect(await screen.findByRole("dialog", { name: "Downloads" })).toBeVisible();
    expect(await screen.findByText("Plane Notes EPUB")).toBeVisible();
  });
});
