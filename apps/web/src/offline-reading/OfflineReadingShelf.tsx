import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Dialog from "@/components/ui/Dialog";
import type {
  OfflineReadingControllerRuntime,
  OpenedOfflineReading,
} from "@/lib/offlineReading/runtime";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import {
  OFFLINE_READING_COPY,
  formatOfflineReadingDate,
  offlineReaderProgressCopy,
  offlineReadingConflictChoiceLabel,
  offlineReadingAvailabilityCopy,
  offlineReadingHasUnsyncedPosition,
  offlineReadingKindCopy,
  offlineReadingRemoveConfirmation,
} from "@/lib/offlineReading/presentation";
import styles from "./offlineReading.module.css";
import OfflineDocumentReader from "./OfflineDocumentReader";

export default function OfflineReadingShelf({
  controller,
}: {
  readonly controller: OfflineReadingControllerRuntime;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => null,
  );
  const [opened, setOpened] = useState<{
    readonly mediaId: string;
    readonly title: string;
    readonly lease: OpenedOfflineReading;
  } | null>(null);
  const openedRef = useRef(opened);
  const openButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusMediaIdRef = useRef<string | null>(null);
  const openSequenceRef = useRef<Promise<void>>(Promise.resolve());
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const updateOpened = useCallback((next: typeof opened) => {
    openedRef.current = next;
    setOpened(next);
  }, []);

  useEffect(() => {
    if (opened !== null || returnFocusMediaIdRef.current === null) return;
    const mediaId = returnFocusMediaIdRef.current;
    openButtonRefs.current.get(mediaId)?.focus();
    returnFocusMediaIdRef.current = null;
  }, [opened]);

  const openReading = useCallback((mediaId: string) => {
    openSequenceRef.current = openSequenceRef.current.then(async () => {
      const active = openedRef.current;
      if (active !== null) {
        await controller.close(active.lease.leaseId);
        if (openedRef.current === active) updateOpened(null);
      }
      const title = controller
        .getSnapshot()
        ?.items.find((candidate) => candidate.mediaId === mediaId)?.title;
      if (title === undefined) {
        throw new Error("Downloaded reading item is absent from the native snapshot");
      }
      const lease = await controller.open(mediaId);
      updateOpened({ mediaId, title, lease });
    }).catch(() => {
      setError("This downloaded copy could not be opened.");
    });
  }, [controller, updateOpened]);

  const closeReading = useCallback(() => {
    const active = openedRef.current;
    if (active === null) return;
    returnFocusMediaIdRef.current = active.mediaId;
    void controller.close(active.lease.leaseId);
    updateOpened(null);
  }, [controller, updateOpened]);

  useEffect(() => {
    const unsubscribeOpen = controller.subscribeOpenRequest(openReading);
    // A protocol/transport defect ends the session; it must be visible instead
    // of leaving the shelf on its opening status line forever.
    const unsubscribeDefect = controller.subscribeDefect(() => {
      setError("Offline reading stopped responding on this device. Reopen Nexus to continue.");
    });
    void controller.connect("Offline").catch(() => {
      setError("Offline reading is unavailable. Reconnect to Nexus and try again.");
    });
    return () => {
      unsubscribeOpen();
      unsubscribeDefect();
      controller.dispose();
    };
  }, [controller, openReading]);

  const item = removeId === null
    ? null
    : snapshot?.items.find((candidate) => candidate.mediaId === removeId) ?? null;
  const authoritativeOpenedProgress: ReaderProgressView | null = (() => {
    if (opened === null) return null;
    const activeItem = snapshot?.items.find(
      (candidate) => candidate.mediaId === opened.mediaId,
    );
    if (
      activeItem?.availability.kind !== "Ready" ||
      activeItem.availability.readerGeneration !== opened.lease.readerGeneration ||
      activeItem.availability.readerRevisionKey !== opened.lease.readerRevisionKey
    ) {
      return null;
    }
    return activeItem.availability.progress;
  })();

  const removeDialog = item === null ? null : (
    <Dialog
      open
      onClose={() => setRemoveId(null)}
      title={OFFLINE_READING_COPY.removeConfirmationTitle}
    >
      <div className={styles.dialogBody}>
        <p>
          {item.availability.kind === "Failed"
            ? item.availability.recoveryProgress === undefined
              ? "Remove this failed download from this device."
              : "Remove this item and its local saved position. A sync already underway may still finish on Nexus."
            : offlineReadingRemoveConfirmation(
              item.availability.kind === "Ready" &&
                offlineReadingHasUnsyncedPosition(item.availability.progress),
            )}
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              void controller.remove(item.mediaId).then(() => {
                setRemoveId(null);
                if (openedRef.current?.mediaId === item.mediaId) updateOpened(null);
              });
            }}
          >
            {OFFLINE_READING_COPY.removeConfirmAction}
          </button>
          <button type="button" className={styles.quietAction} onClick={() => setRemoveId(null)}>
            Keep copy
          </button>
        </div>
      </div>
    </Dialog>
  );

  const discardDialog = discardId === null ? null : (
    <Dialog open onClose={() => setDiscardId(null)} title="Discard old reading position?">
      <div className={styles.dialogBody}>
        <p>The source changed. Your saved device position cannot sync to it. Discard that position to download the new copy.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={() => {
            void controller.discardChangedReaderProgress(discardId).then(() => {
              setDiscardId(null);
            }).catch(() => setError("Could not discard the old position."));
          }}>Discard position</button>
          <button type="button" className={styles.quietAction} onClick={() => setDiscardId(null)}>Keep position</button>
        </div>
      </div>
    </Dialog>
  );

  if (opened !== null) {
    return (
      <main className={`${styles.shell} ${styles.readerShell}`}>
        <header className={styles.readerHeader}>
          <button type="button" className={styles.quietAction} onClick={closeReading}>
            Downloads
          </button>
          <div>
            <h1 title={opened.title}>{opened.title}</h1>
            <p>Downloaded copy · saved {formatOfflineReadingDate(opened.lease.installedAt)}</p>
          </div>
        </header>
        {error === null ? null : <p role="alert" className={styles.error}>{error}</p>}
        <section className={styles.readerSurface} aria-label="Downloaded reader">
          <OfflineDocumentReader
            controller={controller}
            mediaId={opened.mediaId}
            opened={opened.lease}
            authoritativeProgress={authoritativeOpenedProgress}
            onClose={closeReading}
            onRemoveRequested={() => setRemoveId(opened.mediaId)}
          />
        </section>
        {removeDialog}
        {discardDialog}
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Nexus · Offline</p>
        <h1>Downloaded reading</h1>
        <p className={styles.lede}>Your verified copies, available without a connection.</p>
      </header>

      {error === null ? null : <p role="alert" className={styles.error}>{error}</p>}
      {snapshot?.binding.kind === "Present" &&
      snapshot.binding.value.authorizationRequired ? (
        <p role="alert" className={styles.notice}>
          Reconnect to Nexus to authorize future downloads and sync reading positions. Downloaded copies remain available.
        </p>
      ) : null}
      {snapshot === null ? (
        <p role="status" className={styles.empty}>Opening downloaded copies…</p>
      ) : signedOut ? (
        <section className={styles.empty}>
          <h2>Offline data removed</h2>
          <p>Reconnect to Nexus to sign in and download reading again.</p>
          <button type="button" className={styles.action} onClick={() => void controller.openHosted()}>
            Reconnect
          </button>
        </section>
      ) : snapshot.items.length === 0 ? (
        <section className={styles.empty}>
          <h2>Nothing downloaded for offline reading</h2>
          <p>Reconnect to Nexus to save a document for later.</p>
          <button type="button" className={styles.action} onClick={() => void controller.openHosted()}>
            Reconnect
          </button>
        </section>
      ) : (
        <ul className={styles.list}>
          {snapshot.items.map(({ mediaId, title, mediaKind, availability }) => (
            <li key={mediaId} className={styles.row}>
              <div>
                <p className={styles.rowKind}>{offlineReadingKindCopy(mediaKind)}</p>
                <h2 className={styles.rowTitle}>{title}</h2>
                <p className={styles.rowMeta}>{offlineReadingAvailabilityCopy(availability)}</p>
                {availability.kind === "Ready" ? (
                  <p className={styles.rowMeta}>{offlineReaderProgressCopy(availability.progress)}</p>
                ) : null}
                {availability.kind === "Failed" && availability.recoveryProgress !== undefined ? (
                  <p className={styles.notice}>{offlineReaderProgressCopy(availability.recoveryProgress)}</p>
                ) : null}
                {availability.kind === "Failed" && availability.recoveryProgress?.kind === "SourceUnavailable" ? (
                  <p className={styles.notice}>The source may still be unavailable. Your position stays here until sync succeeds or you remove it.</p>
                ) : null}
                {mediaKind === "WebArticle" ? (
                  <p className={styles.notice}>{OFFLINE_READING_COPY.textOnlyNotice}</p>
                ) : null}
              </div>
              <div className={styles.rowActions}>
                {availability.kind === "Ready" ? (
                  <button
                    type="button"
                    className={styles.action}
                    ref={(element) => {
                      if (element === null) openButtonRefs.current.delete(mediaId);
                      else openButtonRefs.current.set(mediaId, element);
                    }}
                    onClick={() => openReading(mediaId)}
                    aria-label={`Open ${title}`}
                  >
                    Open
                  </button>
                ) : null}
                {availability.kind === "Failed" && availability.recoveryProgress === undefined ? (
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => void controller.retry(mediaId)}
                  >
                    {availability.reason === "RecoveryRequired" || availability.reason === "UnsupportedPackage"
                      ? "Redownload" : "Retry"}
                  </button>
                ) : null}
                {availability.kind === "Failed" &&
                  (availability.recoveryProgress?.kind === "Pending" ||
                    availability.recoveryProgress?.kind === "SourceUnavailable") ? (
                  <button type="button" className={styles.action} onClick={() => {
                    void controller.syncReaderProgress(mediaId).catch(() => setError("Could not sync the saved position. Reconnect and try again."));
                  }}>Sync position</button>
                ) : null}
                {availability.kind === "Failed" && availability.recoveryProgress?.kind === "Conflict" ? (
                  <div className={styles.actions} aria-label="Choose saved position">
                    <button type="button" className={styles.action} onClick={() => {
                      void controller.resolveReaderProgress(mediaId, "Canonical").catch(() => setError("Could not choose the Nexus position."));
                    }}>{offlineReadingConflictChoiceLabel("Canonical", null)}</button>
                    <button type="button" className={styles.action} onClick={() => {
                      void controller.resolveReaderProgress(mediaId, "Device").catch(() => setError("Could not keep the device position."));
                    }}>{offlineReadingConflictChoiceLabel("Device", null)}</button>
                  </div>
                ) : null}
                {availability.kind === "Failed" && availability.recoveryProgress?.kind === "ContentChanged" ? (
                  <button type="button" className={styles.action} onClick={() => setDiscardId(mediaId)}>Discard old position</button>
                ) : null}
                {availability.kind !== "Removing" ? (
                  <button
                    type="button"
                    className={styles.quietAction}
                    onClick={() => setRemoveId(mediaId)}
                    aria-label={`Remove ${title}`}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!signedOut && snapshot !== null && snapshot.binding.kind === "Present" ? (
        <button
          type="button"
          className={styles.signOut}
          onClick={() => setPurgeConfirm(true)}
        >
          Remove offline data and sign out
        </button>
      ) : null}

      {removeDialog}
      {discardDialog}

      {purgeConfirm ? (
        <Dialog
          open
          onClose={() => setPurgeConfirm(false)}
          title="Remove all offline data and sign out?"
        >
          <div className={styles.dialogBody}>
            <p>Every downloaded episode and reading copy, including unsynced reading positions, will be removed from this device.</p>
            <div className={styles.actions}>
              <button type="button" className={styles.action} onClick={() => {
                void controller.logoutAndPurge().then(() => {
                  setPurgeConfirm(false);
                  setSignedOut(true);
                }).catch(() => {
                  setError("Offline data could not be removed. Try again.");
                });
              }}>
                Remove data and sign out
              </button>
              <button type="button" className={styles.quietAction} onClick={() => setPurgeConfirm(false)}>
                Keep offline data
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
}
