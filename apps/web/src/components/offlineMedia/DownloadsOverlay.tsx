"use client";

import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { CheckCircle2, Download, RotateCcw, Trash2, XCircle } from "lucide-react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { OfflineMediaInventoryItem } from "@/lib/offlineMedia/clientStore";
import type { OfflineMediaController } from "@/lib/offlineMedia/controller";
import type { OfflineMediaCapability } from "@/lib/offlineMedia/OfflineMediaProvider";
import type { LocalAvailability } from "@/lib/offlineMedia/contract";
import type { NetworkPolicy, ReadingSnapshot } from "@/lib/offlineReading/contract";
import type { OfflineReadingCapability } from "@/lib/offlineReading/OfflineReadingProvider";
import {
  OFFLINE_READING_COPY,
  offlineReaderProgressCopy,
  offlineReadingAvailabilityCopy,
  offlineReadingHasUnsyncedPosition,
  offlineReadingKindCopy,
} from "@/lib/offlineReading/presentation";
import { formatByteCount } from "@/lib/text/formatByteCount";
import { pointerModality } from "@/lib/ui/pointerModality";
import styles from "./DownloadsOverlay.module.css";

type ReadyOfflineMedia = Extract<OfflineMediaCapability, { kind: "Ready" }>;
type ReadyOfflineReading = Extract<OfflineReadingCapability, { kind: "Ready" }>;

const EMPTY_INVENTORY: readonly OfflineMediaInventoryItem[] = [];
const NO_INVENTORY = () => EMPTY_INVENTORY;
const NO_READING_SNAPSHOT = (): ReadingSnapshot | null => null;
const DEFAULT_NETWORK_POLICY = (): NetworkPolicy => "UnmeteredOnly";

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

function ReadingAction({
  item,
  capability,
}: {
  readonly item: ReadingSnapshot["items"][number];
  readonly capability: ReadyOfflineReading;
}) {
  switch (item.availability.kind) {
    case "Preparing":
    case "Queued":
    case "Authorizing":
    case "Downloading":
    case "Verifying":
    case "Restarting":
      return <Button variant="ghost" size="sm" onClick={() => void capability.controller.cancel(item.mediaId)}>Cancel</Button>;
    case "Failed":
      // TB-04 requires both a Retry and a Remove path on a failed transfer.
      return <span className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
          onClick={() => void capability.controller.retry(item.mediaId)}
        >Retry</Button>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Trash2 size={16} aria-hidden="true" />}
          onClick={() => void capability.controller.remove(item.mediaId)}
        >Remove</Button>
      </span>;
    case "Ready": {
      const progress = item.availability.progress;
      // One primary action per ready row; removal lives in the row overflow.
      return <span className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={() => void capability.controller.openDownloadedCopy(item.mediaId)}>Open downloaded copy</Button>
        <ActionMenu
          label={`More actions for ${item.title}`}
          options={[{
            kind: "command",
            id: "remove",
            label: "Remove",
            tone: "danger",
            icon: <Trash2 size={16} aria-hidden="true" />,
            onSelect: () => {
              if (
                offlineReadingHasUnsyncedPosition(progress) &&
                !window.confirm(OFFLINE_READING_COPY.pendingRemoveConfirmation)
              ) return;
              void capability.controller.remove(item.mediaId);
            },
          }]}
        />
      </span>;
    }
    case "Removing":
      return <Button variant="ghost" size="sm" disabled>Removing…</Button>;
  }
}

function ReadingInventory({
  capability,
  snapshot,
  onClose,
}: {
  readonly capability: ReadyOfflineReading;
  readonly snapshot: ReadingSnapshot;
  readonly onClose: () => void;
}) {
  if (snapshot.items.length === 0) return null;
  return <>
    <h3>Reading</h3>
    <ul className={styles.list} aria-label="Downloaded reading">
      {snapshot.items.map((item) => <li key={`reading:${item.mediaId}`} className={styles.item}>
        <button
          type="button"
          className={styles.title}
          onClick={(event) => {
            if (requestWorkspaceTargetActivation({
              target: { href: `/media/${item.mediaId}`, labelHint: item.title },
              disposition: { kind: "Follow" },
              modality: pointerModality(event),
            })) {
              onClose();
            }
          }}
        >{item.title}</button>
        <p className={styles.state}>{offlineReadingKindCopy(item.mediaKind)}</p>
        <p className={styles.state}>{offlineReadingAvailabilityCopy(item.availability)}</p>
        {item.availability.kind === "Ready" ? (
          <p className={styles.state}>
            {offlineReaderProgressCopy(item.availability.progress)}
          </p>
        ) : null}
        {item.mediaKind === "WebArticle" ? (
          <p className={styles.state}>{OFFLINE_READING_COPY.textOnlyNotice}</p>
        ) : null}
        <ReadingAction item={item} capability={capability} />
      </li>)}
    </ul>
  </>;
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
  audio,
  onClose,
  reading,
}: {
  readonly audio: ReadyOfflineMedia | null;
  readonly onClose: () => void;
  readonly reading: OfflineReadingCapability;
}) {
  const [policyRetry, setPolicyRetry] = useState<NetworkPolicy | null>(null);
  const store = audio?.store ?? null;
  const readingController = reading.kind === "Ready" ? reading.controller : null;
  const subscribeInventory = useCallback(
    (listener: () => void) =>
      store === null ? () => undefined : store.subscribeInventory(listener),
    [store],
  );
  const subscribeNetworkPolicy = useCallback(
    (listener: () => void) =>
      store === null ? () => undefined : store.subscribeNetworkPolicy(listener),
    [store],
  );
  const subscribeReading = useCallback(
    (listener: () => void) =>
      readingController === null ? () => undefined : readingController.subscribe(listener),
    [readingController],
  );
  const inventory = useSyncExternalStore(
    subscribeInventory,
    store?.getInventory ?? NO_INVENTORY,
    NO_INVENTORY,
  );
  const audioNetworkPolicy = useSyncExternalStore(
    subscribeNetworkPolicy,
    store?.getNetworkPolicy ?? DEFAULT_NETWORK_POLICY,
    DEFAULT_NETWORK_POLICY,
  );
  const readingSnapshot = useSyncExternalStore(
    subscribeReading,
    readingController?.getSnapshot ?? NO_READING_SNAPSHOT,
    NO_READING_SNAPSHOT,
  );
  // One shared policy shown once: audio owns it when the audio bridge is
  // connected, otherwise the reading snapshot carries the same device setting.
  const networkPolicy =
    store !== null
      ? audioNetworkPolicy
      : readingSnapshot?.networkPolicy ?? DEFAULT_NETWORK_POLICY();
  const downloadedBytes = inventory.reduce(
    (total, item) =>
      item.state.kind === "Ready" ? total + item.state.sizeBytes : total,
    0,
  ) + (readingSnapshot?.items.reduce(
    (total, item) => item.availability.kind === "Ready"
      ? total + item.availability.sizeBytes
      : total,
    0,
  ) ?? 0);
  const hasAnyDownload = inventory.length > 0 || (readingSnapshot?.items.length ?? 0) > 0;
  const applyNetworkPolicy = useCallback(async (policy: NetworkPolicy) => {
    try {
      if (readingController !== null) {
        await readingController.setNetworkPolicy(policy);
      } else if (audio !== null) {
        await audio.controller.setNetworkPolicy(policy);
      }
      setPolicyRetry(null);
    } catch {
      setPolicyRetry(policy);
    }
  }, [audio, readingController]);

  const openItem = (
    event: MouseEvent<HTMLButtonElement>,
    item: OfflineMediaInventoryItem,
  ) => {
    if (
      requestWorkspaceTargetActivation({
        target: { href: `/media/${item.mediaId}`, labelHint: item.title },
        disposition: { kind: "Follow" },
        modality: pointerModality(event),
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
                "Allow all downloads over mobile data? This global setting releases every download waiting for Wi-Fi.",
              )
            ) {
              event.currentTarget.checked = false;
              return;
            }
            const policy = allowMobileData ? "AnyConnected" : "UnmeteredOnly";
            void applyNetworkPolicy(policy);
          }}
        />
        <span>
          <strong>Download over mobile data</strong>
          <small>When off, downloads wait for Wi-Fi.</small>
        </span>
      </label>
      {policyRetry !== null ? (
        <p role="alert">
          The download network setting could not be applied to every download.
          {" "}
          <button type="button" onClick={() => void applyNetworkPolicy(policyRetry)}>
            Retry setting
          </button>
        </p>
      ) : null}

      {hasAnyDownload ? (
        <>
          <p className={styles.total}>
            <Download size={16} aria-hidden="true" />
            {formatByteCount(downloadedBytes)} downloaded
          </p>
          {inventory.length > 0 && audio !== null ? <>
            <h3>Listening</h3>
            <ul className={styles.list} aria-label="Downloaded listening">
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
                <InventoryAction item={item} controller={audio.controller} />
              </li>
              ))}
            </ul>
          </> : null}
          {reading.kind === "Ready" && readingSnapshot !== null ? (
            <ReadingInventory
              capability={reading}
              snapshot={readingSnapshot}
              onClose={onClose}
            />
          ) : null}
        </>
      ) : (
        // One empty state for the whole surface, never one per group.
        <p className={styles.empty}>No downloads.</p>
      )}
    </div>
  );
}

export default function DownloadsOverlay({
  open,
  onClose,
  audio = null,
  reading = { kind: "Unavailable" },
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly audio?: ReadyOfflineMedia | null;
  readonly reading?: OfflineReadingCapability;
}) {
  const isMobile = useIsMobileViewport();
  const mobileCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const panel = (
    <DownloadsPanel audio={audio} onClose={onClose} reading={reading} />
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
