"use client";

import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { CheckCircle2, Download, RotateCcw, Trash2, XCircle } from "lucide-react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type {
  OfflineMediaClientStore,
  OfflineMediaInventoryItem,
} from "@/lib/offlineMedia/clientStore";
import type { OfflineMediaController } from "@/lib/offlineMedia/controller";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import styles from "./DownloadsOverlay.module.css";

const EMPTY_INVENTORY: readonly OfflineMediaInventoryItem[] = [];

function formatByteCount(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1_000;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1_000) break;
    value /= 1_000;
    unit = nextUnit;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)} ${unit}`;
}

function stateCopy(state: LocalAvailability): string {
  switch (state.kind) {
    case "Resolving":
      return "Preparing download…";
    case "Queued":
      switch (state.reason) {
        case "Capacity":
          return "Download queued";
        case "WaitingForNetwork":
          return "Waiting for network";
        case "WaitingForUnmetered":
          return "Waiting for Wi-Fi";
        case "SystemLimit":
          return "Download paused by Android";
      }
    case "Downloading":
      return state.totalBytes.kind === "Present"
        ? `${formatByteCount(state.bytesDownloaded)} of ${formatByteCount(
            state.totalBytes.value,
          )}`
        : formatByteCount(state.bytesDownloaded);
    case "Restarting":
      return "Restarting download…";
    case "Ready":
      return `Downloaded · ${formatByteCount(state.sizeBytes)}`;
    case "Failed":
      return "Download failed";
    case "Removing":
      return "Removing download…";
  }
}

function InventoryAction({
  item,
  controller,
}: {
  readonly item: OfflineMediaInventoryItem;
  readonly controller: OfflineMediaController;
}) {
  switch (item.state.kind) {
    case "Resolving":
    case "Queued":
    case "Downloading":
    case "Restarting":
      return (
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<XCircle size={16} aria-hidden="true" />}
          onClick={() => void controller.cancel(item.mediaId)}
        >
          Cancel
        </Button>
      );
    case "Ready":
      return (
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Trash2 size={16} aria-hidden="true" />}
          onClick={() => void controller.remove(item.mediaId)}
        >
          Remove
        </Button>
      );
    case "Failed":
      return (
        <span className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
            onClick={() => void controller.retry(item.mediaId)}
          >
            Retry
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Trash2 size={16} aria-hidden="true" />}
            onClick={() => void controller.remove(item.mediaId)}
          >
            Remove
          </Button>
        </span>
      );
    case "Removing":
      return (
        <Button
          variant="ghost"
          size="sm"
          disabled
          leadingIcon={<Trash2 size={16} aria-hidden="true" />}
        >
          Removing…
        </Button>
      );
  }
}

function DownloadsPanel({
  inventory,
  controller,
  networkPolicy,
  onClose,
}: {
  readonly inventory: readonly OfflineMediaInventoryItem[];
  readonly controller: OfflineMediaController;
  readonly networkPolicy: "UnmeteredOnly" | "AnyConnected";
  readonly onClose: () => void;
}) {
  const downloadedBytes = inventory.reduce(
    (total, item) =>
      item.state.kind === "Ready" ? total + item.state.sizeBytes : total,
    0,
  );

  const openItem = (
    event: MouseEvent<HTMLButtonElement>,
    item: OfflineMediaInventoryItem,
  ) => {
    if (
      requestWorkspaceTargetActivation({
        target: { href: `/media/${item.mediaId}`, labelHint: item.title },
        disposition: { kind: "Follow" },
        modality: event.detail === 0 ? "Keyboard" : "Pointer",
      })
    ) {
      onClose();
    }
  };

  return (
    <div className={styles.panel}>
      <label className={styles.policy}>
        <input
          type="checkbox"
          checked={networkPolicy === "AnyConnected"}
          onChange={(event) => {
            const allowMobileData = event.currentTarget.checked;
            if (
              allowMobileData &&
              !window.confirm(
                "Allow all episode downloads over mobile data? This global setting releases every download waiting for Wi-Fi.",
              )
            ) {
              event.currentTarget.checked = false;
              return;
            }
            void controller.setNetworkPolicy(
              allowMobileData ? "AnyConnected" : "UnmeteredOnly",
            );
          }}
        />
        <span>
          <strong>Download over mobile data</strong>
          <small>When off, downloads wait for Wi-Fi.</small>
        </span>
      </label>

      {inventory.length === 0 ? (
        <p className={styles.empty}>No downloaded episodes.</p>
      ) : (
        <>
          <p className={styles.total}>
            <Download size={16} aria-hidden="true" />
            {formatByteCount(downloadedBytes)} downloaded
          </p>
          <ul className={styles.list}>
            {inventory.map((item) => (
              <li key={item.mediaId} className={styles.item}>
                <button
                  type="button"
                  className={styles.title}
                  onClick={(event) => openItem(event, item)}
                >
                  {item.title}
                </button>
                <p className={styles.state}>
                  {item.state.kind === "Ready" ? (
                    <CheckCircle2 size={15} aria-hidden="true" />
                  ) : null}
                  {stateCopy(item.state)}
                </p>
                <InventoryAction item={item} controller={controller} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function DownloadsOverlay({
  open,
  onClose,
  store,
  controller,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly store: OfflineMediaClientStore;
  readonly controller: OfflineMediaController;
}) {
  const isMobile = useIsMobileViewport();
  const mobileCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const subscribeInventory = useCallback(
    (listener: () => void) => store.subscribeInventory(listener),
    [store],
  );
  const subscribeNetworkPolicy = useCallback(
    (listener: () => void) => store.subscribeNetworkPolicy(listener),
    [store],
  );
  const inventory = useSyncExternalStore(
    subscribeInventory,
    store.getInventory,
    () => EMPTY_INVENTORY,
  );
  const networkPolicy = useSyncExternalStore(
    subscribeNetworkPolicy,
    store.getNetworkPolicy,
    () => "UnmeteredOnly" as const,
  );
  const panel = (
    <DownloadsPanel
      inventory={inventory}
      controller={controller}
      networkPolicy={networkPolicy}
      onClose={onClose}
    />
  );

  return (
    <>
      <Dialog
        open={open && !isMobile}
        onClose={onClose}
        title="Downloads"
      >
        {panel}
      </Dialog>
      <MobileSheet
        active={open && isMobile}
        onDismiss={onClose}
        ariaLabel="Downloads"
        panelId="offline-downloads-sheet"
        initialFocus={() => mobileCloseButtonRef.current}
      >
        <header className={styles.mobileHeader}>
          <h2>Downloads</h2>
          <Button
            ref={mobileCloseButtonRef}
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            Done
          </Button>
        </header>
        {panel}
      </MobileSheet>
    </>
  );
}
