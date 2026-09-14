import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ResourceCacheContext } from "@/lib/api/resourceCache";
import Dialog from "@/components/ui/Dialog";
import {
  OfflineReadingControllerRuntime,
  OfflineReadingRejectedError,
  type OpenedOfflineReading,
} from "@/lib/offlineReading/runtime";
import FeatureErrorBoundary from "@/components/feedback/FeatureErrorBoundary";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import {
  OFFLINE_READING_COPY,
  formatOfflineReadingDate,
  offlineReaderProgressCopy,
  offlineReadingAvailabilityCopy,
  offlineReadingHasUnsyncedPosition,
  offlineReadingKindCopy,
  offlineReadingRemoveConfirmation,
  offlineReadingRejectionMessage,
} from "@/lib/offlineReading/presentation";
import styles from "./offlineReading.module.css";
import OfflineDocumentReader from "./OfflineDocumentReader";

export default function OfflineReadingShelf(props: {
  readonly controller: OfflineReadingControllerRuntime;
}) {
  return (
    <FeatureErrorBoundary
      scope="ReaderContent"
      onRetry={() => window.location.reload()}
      fallback={(retry) => (
        <section role="alert">
          <p>
            Downloaded reading stopped responding. Your saved copies remain on
            this device.
          </p>
          <button type="button" onClick={retry}>
            Reload downloaded copies
          </button>
        </section>
      )}
    >
      <OfflineReadingShelfBody {...props} />
    </FeatureErrorBoundary>
  );
}

function OfflineReadingShelfBody({
  controller,
}: {
  readonly controller: OfflineReadingControllerRuntime;
}) {
  const cache = useContext(ResourceCacheContext);
  if (cache === null)
    throw new Error("Offline shelf requires its shared resource owner");
  const activeController = useRef<OfflineReadingControllerRuntime | null>(null);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const controllerFailure = useSyncExternalStore(
    controller.subscribe,
    controller.getDefect,
    controller.getDefect,
  );
  const [defect, setDefect] = useState<Error | null>(null);
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
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const actionRef = useRef<object | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const updateOpened = useCallback((next: typeof opened) => {
    openedRef.current = next;
    setOpened(next);
  }, []);

  const runCommand = useCallback(
    async (
      command:
        | { readonly kind: "Retry" | "Remove"; readonly mediaId: string }
        | {
            readonly kind: "Close";
            readonly leaseId: string;
            readonly mediaId: string;
          },
    ) => {
      const owner = activeController.current;
      if (owner === null) return;
      if (actionRef.current !== null) {
        setError(offlineReadingRejectionMessage("Busy"));
        return;
      }
      actionRef.current = command;
      setActionPending(true);
      setError(null);
      const current = () =>
        activeController.current === owner && actionRef.current === command;
      try {
        switch (command.kind) {
          case "Retry":
            await owner.retry(command.mediaId);
            break;
          case "Remove":
            await owner.remove(command.mediaId);
            if (current()) {
              setRemoveId((value) =>
                value === command.mediaId ? null : value,
              );
              if (openedRef.current?.mediaId === command.mediaId)
                updateOpened(null);
            }
            break;
          case "Close":
            await owner.close(command.leaseId);
            if (
              current() &&
              openedRef.current?.lease.leaseId === command.leaseId
            ) {
              returnFocusMediaIdRef.current = command.mediaId;
              updateOpened(null);
            }
            break;
        }
      } catch (failure) {
        if (!current()) return;
        if (failure instanceof OfflineReadingRejectedError)
          setError(offlineReadingRejectionMessage(failure.code));
        else
          setDefect(
            failure instanceof Error
              ? failure
              : new Error("Offline reading command failed"),
          );
      } finally {
        if (current()) {
          actionRef.current = null;
          setActionPending(false);
        }
      }
    },
    [updateOpened],
  );

  useEffect(() => {
    if (opened !== null || returnFocusMediaIdRef.current === null) return;
    const mediaId = returnFocusMediaIdRef.current;
    openButtonRefs.current.get(mediaId)?.focus();
    returnFocusMediaIdRef.current = null;
  }, [opened]);

  const openReading = useCallback(
    (owner: OfflineReadingControllerRuntime, mediaId: string) => {
      openSequenceRef.current = openSequenceRef.current
        .then(async () => {
          if (activeController.current !== owner) return;
          const active = openedRef.current;
          if (active !== null) {
            await owner.close(active.lease.leaseId);
            if (openedRef.current === active) updateOpened(null);
          }
          const title = owner
            .getSnapshot()
            ?.items.find((candidate) => candidate.mediaId === mediaId)?.title;
          if (title === undefined) {
            throw new Error(
              "Downloaded reading item is absent from the native snapshot",
            );
          }
          const lease = await owner.open(mediaId);
          if (activeController.current === owner)
            updateOpened({ mediaId, title, lease });
        })
        .catch(() => {
          if (activeController.current === owner)
            setError("This downloaded copy could not be opened.");
        });
    },
    [updateOpened],
  );

  const closeReading = useCallback(() => {
    const active = openedRef.current;
    if (active !== null)
      void runCommand({
        kind: "Close",
        leaseId: active.lease.leaseId,
        mediaId: active.mediaId,
      });
  }, [runCommand]);

  useEffect(() => {
    const owner = controller;
    activeController.current = owner;
    updateOpened(null);
    setError(null);
    actionRef.current = null;
    setActionPending(false);
    let accountId: string | null = null;
    const unsubscribeAccount = owner.subscribe(() => {
      const binding = owner.getSnapshot()?.binding;
      const next = binding?.kind === "Present" ? binding.value.accountId : null;
      if (next !== accountId) {
        accountId = next;
        cache.clear();
        updateOpened(null);
      }
    });
    const unsubscribeOpen = owner.subscribeOpenRequest((mediaId) =>
      openReading(owner, mediaId),
    );
    return () => {
      if (activeController.current === owner) {
        activeController.current = null;
        actionRef.current = null;
      }
      unsubscribeAccount();
      unsubscribeOpen();
      cache.clear();
    };
  }, [controller, cache, openReading, updateOpened]);

  if (defect !== null) throw defect;
  if (controllerFailure !== null) {
    if (!(controllerFailure instanceof OfflineReadingRejectedError))
      throw controllerFailure;
    return (
      <section role="alert">
        <p>{offlineReadingRejectionMessage(controllerFailure.code)}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload downloaded copies
        </button>
      </section>
    );
  }

  const item =
    removeId === null
      ? null
      : (snapshot?.items.find((candidate) => candidate.mediaId === removeId) ??
        null);
  const authoritativeOpenedProgress: ReaderProgressView | null = (() => {
    if (opened === null) return null;
    const activeItem = snapshot?.items.find(
      (candidate) => candidate.mediaId === opened.mediaId,
    );
    if (
      activeItem?.availability.kind !== "Ready" ||
      activeItem.availability.readerGeneration !==
        opened.lease.readerGeneration ||
      activeItem.availability.readerRevisionKey !==
        opened.lease.readerRevisionKey
    ) {
      return null;
    }
    return activeItem.availability.progress;
  })();

  const removeDialog =
    item === null ? null : (
      <Dialog
        open
        onClose={() => setRemoveId(null)}
        title={OFFLINE_READING_COPY.removeConfirmationTitle}
      >
        <div className={styles.dialogBody}>
          <p>
            {offlineReadingRemoveConfirmation(
              item.availability.kind === "UpgradeRequired" ||
                item.availability.kind === "UpgradeBlockedByStorage" ||
                item.availability.kind === "UpgradeFailed" ||
                (item.availability.kind === "Ready" &&
                  offlineReadingHasUnsyncedPosition(
                    item.availability.progress,
                  )),
            )}
          </p>
          {error === null ? null : (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              disabled={actionPending}
              onClick={() =>
                void runCommand({ kind: "Remove", mediaId: item.mediaId })
              }
            >
              {OFFLINE_READING_COPY.removeConfirmAction}
            </button>
            <button
              type="button"
              className={styles.quietAction}
              onClick={() => setRemoveId(null)}
            >
              Keep copy
            </button>
          </div>
        </div>
      </Dialog>
    );

  if (opened !== null) {
    return (
      <main className={styles.shell}>
        <header className={styles.readerHeader}>
          <button
            type="button"
            className={styles.quietAction}
            onClick={closeReading}
          >
            Downloads
          </button>
          <div>
            <h1>{opened.title}</h1>
            <p>
              Downloaded copy · saved{" "}
              {formatOfflineReadingDate(opened.lease.installedAt)}
            </p>
          </div>
        </header>
        {error === null || item !== null ? null : (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <section
          className={styles.readerSurface}
          aria-label="Downloaded reader"
        >
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
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Nexus · Offline</p>
        <h1>Downloaded reading</h1>
        <p className={styles.lede}>
          Your verified copies, available without a connection.
        </p>
      </header>

      {error === null || item !== null ? null : (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {snapshot?.binding.kind === "Present" &&
      snapshot.binding.value.authorizationRequired ? (
        <p role="alert" className={styles.notice}>
          Reconnect to Nexus to authorize future downloads and sync reading
          positions. Downloaded copies remain available.
        </p>
      ) : null}
      {snapshot === null ? (
        <p role="status" className={styles.empty}>
          Opening downloaded copies…
        </p>
      ) : signedOut ? (
        <section className={styles.empty}>
          <h2>Offline data removed</h2>
          <p>Reconnect to Nexus to sign in and download reading again.</p>
          <button
            type="button"
            className={styles.action}
            onClick={() => void controller.openHosted()}
          >
            Reconnect
          </button>
        </section>
      ) : snapshot.items.length === 0 ? (
        <section className={styles.empty}>
          <h2>Nothing downloaded for offline reading</h2>
          <p>Reconnect to Nexus to save a document for later.</p>
          <button
            type="button"
            className={styles.action}
            onClick={() => void controller.openHosted()}
          >
            Reconnect
          </button>
        </section>
      ) : (
        <ul className={styles.list}>
          {snapshot.items.map(({ mediaId, title, mediaKind, availability }) => (
            <li key={mediaId} className={styles.row}>
              <div>
                <p className={styles.rowKind}>
                  {offlineReadingKindCopy(mediaKind)}
                </p>
                <h2 className={styles.rowTitle}>{title}</h2>
                <p className={styles.rowMeta}>
                  {offlineReadingAvailabilityCopy(availability)}
                </p>
                {availability.kind === "Ready" ? (
                  <p className={styles.rowMeta}>
                    {offlineReaderProgressCopy(availability.progress)}
                  </p>
                ) : null}
              </div>
              <div className={styles.rowActions}>
                {availability.kind === "Ready" ? (
                  <button
                    type="button"
                    className={styles.action}
                    ref={(element) => {
                      if (element === null)
                        openButtonRefs.current.delete(mediaId);
                      else openButtonRefs.current.set(mediaId, element);
                    }}
                    onClick={() => openReading(controller, mediaId)}
                    aria-label={`Open ${title}`}
                  >
                    Open
                  </button>
                ) : null}
                {availability.kind === "Failed" ||
                availability.kind === "UpgradeRequired" ||
                availability.kind === "UpgradeBlockedByStorage" ||
                availability.kind === "UpgradeFailed" ? (
                  <button
                    type="button"
                    className={styles.action}
                    disabled={actionPending}
                    onClick={() => void runCommand({ kind: "Retry", mediaId })}
                  >
                    Retry
                  </button>
                ) : null}
                {availability.kind !== "Removing" ? (
                  <button
                    type="button"
                    className={styles.quietAction}
                    onClick={() => {
                      setError(null);
                      setRemoveId(mediaId);
                    }}
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

      {!signedOut &&
      snapshot !== null &&
      snapshot.binding.kind === "Present" ? (
        <button
          type="button"
          className={styles.signOut}
          onClick={() => setPurgeConfirm(true)}
        >
          Remove offline data and sign out
        </button>
      ) : null}

      {removeDialog}

      {purgeConfirm ? (
        <Dialog
          open
          onClose={() => setPurgeConfirm(false)}
          title="Remove all offline data and sign out?"
        >
          <div className={styles.dialogBody}>
            <p>
              Every downloaded episode and reading copy, including unsynced
              reading positions, will be removed from this device.
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  void controller
                    .logoutAndPurge()
                    .then(() => {
                      setPurgeConfirm(false);
                      setSignedOut(true);
                    })
                    .catch(() => {
                      setError("Offline data could not be removed. Try again.");
                    });
                }}
              >
                Remove data and sign out
              </button>
              <button
                type="button"
                className={styles.quietAction}
                onClick={() => setPurgeConfirm(false)}
              >
                Keep offline data
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
}
