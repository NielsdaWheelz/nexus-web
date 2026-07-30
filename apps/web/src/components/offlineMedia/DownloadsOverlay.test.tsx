import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { OfflineMediaClientStore } from "@/lib/offlineMedia/clientStore";
import type { OfflineMediaController } from "@/lib/offlineMedia/controller";
import DownloadsOverlay from "./DownloadsOverlay";

const READY_ID = "11111111-1111-4111-8111-111111111111";
const FAILED_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_ID = "33333333-3333-4333-8333-333333333333";

function controller(): OfflineMediaController {
  return {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    setNetworkPolicy: vi.fn(async () => undefined),
    openDownloads: vi.fn(),
    resolveStreamUrl: (_mediaId, remoteUrl) => remoteUrl,
  };
}

function renderOverlay(
  store: OfflineMediaClientStore,
  offlineController: OfflineMediaController,
  onClose = vi.fn(),
) {
  return {
    onClose,
    ...render(
      <MobileViewportProvider>
        <DownloadsOverlay
          open
          onClose={onClose}
          store={store}
          controller={offlineController}
        />
      </MobileViewportProvider>,
    ),
  };
}

describe("DownloadsOverlay", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1280);
  });

  it("renders the exact empty state and focuses the desktop close control", async () => {
    renderOverlay(new OfflineMediaClientStore(), controller());

    const dialog = await screen.findByRole("dialog", { name: "Downloads" });
    expect(within(dialog).getByText("No downloaded episodes.")).toBeVisible();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Close dialog" }),
      ).toHaveFocus(),
    );
  });

  it("shows inventory state, completed bytes, and every applicable action", async () => {
    const store = new OfflineMediaClientStore();
    store.installSnapshot(
      [
        {
          mediaId: ACTIVE_ID,
          title: "Active transfer",
          state: {
            kind: "Downloading",
            bytesDownloaded: 47,
            totalBytes: { kind: "Present", value: 100 },
          },
        },
        {
          mediaId: READY_ID,
          title: "Ready episode with a title that is allowed to wrap",
          state: {
            kind: "Ready",
            sizeBytes: 2_000,
            contentType: "audio/mpeg",
            updatedAt: "2026-07-30T19:00:00Z",
          },
        },
        {
          mediaId: FAILED_ID,
          title: "Failed episode",
          state: { kind: "Failed", code: "DownloadFailed" },
        },
      ],
      "UnmeteredOnly",
    );
    const offlineController = controller();
    const user = userEvent.setup();
    renderOverlay(store, offlineController);

    expect(await screen.findByText("47 B of 100 B")).toBeVisible();
    expect(screen.getByText("2 KB downloaded")).toBeVisible();
    const [active, ready, failed] = screen.getAllByRole("listitem");
    if (!active || !ready || !failed) throw new Error("Missing inventory row");

    await user.click(within(active).getByRole("button", { name: "Cancel" }));
    await user.click(within(ready).getByRole("button", { name: "Remove" }));
    await user.click(within(failed).getByRole("button", { name: "Retry" }));
    expect(offlineController.cancel).toHaveBeenCalledWith(ACTIVE_ID);
    expect(offlineController.remove).toHaveBeenCalledWith(READY_ID);
    expect(offlineController.retry).toHaveBeenCalledWith(FAILED_ID);
  });

  it("requires one explicit global confirmation before enabling mobile data", async () => {
    const store = new OfflineMediaClientStore();
    const offlineController = controller();
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const user = userEvent.setup();
    renderOverlay(store, offlineController);
    const policy = await screen.findByRole("checkbox", {
      name: /Download over mobile data/,
    });

    await user.click(policy);
    expect(confirm).toHaveBeenCalledWith(
      "Allow all episode downloads over mobile data? This global setting releases every download waiting for Wi-Fi.",
    );
    expect(offlineController.setNetworkPolicy).not.toHaveBeenCalled();

    await user.click(policy);
    expect(offlineController.setNetworkPolicy).toHaveBeenCalledWith(
      "AnyConnected",
    );
  });

  it("uses the stay-mounted mobile sheet and focuses Done", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.spyOn(history, "pushState").mockImplementation(() => {});
    vi.spyOn(history, "back").mockImplementation(() => {});
    renderOverlay(new OfflineMediaClientStore(), controller());

    const sheet = await screen.findByRole("dialog", { name: "Downloads" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(within(sheet).getByText("No downloaded episodes.")).toBeVisible();
    await waitFor(() =>
      expect(within(sheet).getByRole("button", { name: "Done" })).toHaveFocus(),
    );
  });
});
