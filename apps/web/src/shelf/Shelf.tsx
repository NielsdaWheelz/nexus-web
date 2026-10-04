// The Downloads screen: one list for episodes and reading copies, rendered from
// Android's snapshot with the same copy online and offline. A ready reading
// copy opens here in ShelfReader; everything else is a row with its actions.
import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import {
  offlineCall,
  useOfflineSnapshot,
  type FailureReason,
  type OfflineItem,
  type OfflineSnapshot,
} from "@/lib/offline/bridge";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import { formatByteCount } from "@/lib/text/formatByteCount";
import ShelfReader from "./ShelfReader";
import styles from "./shelf.module.css";

interface Confirmation {
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly run: () => void;
}

const FAILURE_COPY: Record<FailureReason, string> = {
  AuthorizationRequired: "sign in required",
  SourceUnavailable: "source unavailable",
  Changed: "source changed · retry",
  Storage: "not enough storage",
  Network: "network interrupted",
  Server: "server unavailable",
  Invalid: "not a playable file",
  Stopped: "stopped by Android",
};

const KIND_COPY: Record<OfflineItem["kind"], string> = {
  podcast_episode: "Episode",
  pdf: "PDF",
  epub: "EPUB",
  web_article: "Web article",
};

const POSITION_COPY: Record<ReaderProgressView["kind"], string> = {
  Canonical: "Position synced",
  Pending: "Position saved on this device",
  Conflict: "Position needs your choice",
  ContentChanged:
    "A newer source version exists. This downloaded copy and its position remain only on this device.",
  SourceUnavailable: "Position kept locally · source unavailable",
};

const SHELF_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function statusCopy(item: OfflineItem, snapshot: OfflineSnapshot): string {
  switch (item.state) {
    case "Queued":
      return [
        item.attempts > 0 ? "Retrying after interruption" : "Download queued",
        snapshot.policy === "UnmeteredOnly" ? "waits for Wi-Fi" : null,
        snapshot.items.some((other) => other.state === "Downloading")
          ? "another download is active"
          : null,
      ].filter((part) => part !== null).join(" · ");
    case "Downloading":
      return item.total === null
        ? formatByteCount(item.received)
        : `${formatByteCount(item.received)} of ${formatByteCount(item.total)}`;
    case "Ready":
      return [
        "Downloaded",
        formatByteCount(item.sizeBytes),
        item.savedAt === null ? null : `saved ${SHELF_DATE.format(new Date(item.savedAt))}`,
      ].filter((part) => part !== null).join(" · ");
    case "Failed":
      return `Download failed · ${FAILURE_COPY[item.failure!]}`;
    case "Removing":
      // The player or an open reader still holds the file; it goes when released.
      return item.kind === "podcast_episode"
        ? "Removes when playback stops"
        : "Removes when closed";
  }
}

const isReading = (item: OfflineItem) => item.kind !== "podcast_episode";

export default function Shelf() {
  const snapshot = useOfflineSnapshot();
  const [openId, setOpenId] = useState<string | null>(null);
  const openRef = useRef<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState(() => window.location.hash);

  const run = useCallback((op: string, args: Record<string, unknown> = {}) => {
    setError(null);
    void offlineCall(op, args).catch(() =>
      setError("Nexus couldn’t change that download. Try again."),
    );
  }, []);

  const openCopy = useCallback((mediaId: string) => {
    const previous = openRef.current;
    if (previous === mediaId) return;
    // The bridge handles frames in order, so the old lease is released first.
    if (previous !== null) void offlineCall("close", { mediaId: previous }).catch(() => undefined);
    openRef.current = null;
    setOpenId(null);
    setError(null);
    offlineCall("open", { mediaId }).then(
      () => {
        openRef.current = mediaId;
        setOpenId(mediaId);
      },
      () => setError("This downloaded copy could not be opened."),
    );
  }, []);

  const closeCopy = useCallback(() => {
    const mediaId = openRef.current;
    if (mediaId === null) return;
    void offlineCall("close", { mediaId }).catch(() => undefined);
    openRef.current = null;
    setOpenId(null);
  }, []);

  // `#open={id}`: a launch link or an in-shelf app link to a ready copy.
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    const mediaId = /^#open=([0-9a-f-]{36})$/.exec(hash)?.[1];
    if (mediaId === undefined || snapshot === null) return;
    window.history.replaceState(null, "", window.location.pathname);
    setHash("");
    const item = snapshot.items.find((candidate) => candidate.mediaId === mediaId);
    if (item?.state === "Ready" && isReading(item)) openCopy(mediaId);
  }, [hash, snapshot, openCopy]);

  const remove = (item: OfflineItem) => {
    const removeNow = () => {
      if (openRef.current === item.mediaId) closeCopy();
      run("remove", { mediaId: item.mediaId });
    };
    if (item.progress === null || item.progress.kind === "Canonical") {
      removeNow();
      return;
    }
    setConfirmation({
      title: "Remove downloaded copy?",
      body: "Its position saved on this device has not reached Nexus and will be lost.",
      action: "Remove copy and position",
      run: removeNow,
    });
  };

  const dialog = confirmation === null ? null : (
    <Dialog open onClose={() => setConfirmation(null)} title={confirmation.title}>
      <div className={styles.dialogBody}>
        <p>{confirmation.body}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={() => {
            setConfirmation(null);
            confirmation.run();
          }}>{confirmation.action}</button>
          <button type="button" className={styles.quietAction} onClick={() => setConfirmation(null)}>
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
  const alert = error === null ? null : <p role="alert" className={styles.error}>{error}</p>;

  const opened = snapshot?.items.find((item) => item.mediaId === openId);
  const openedReady = opened?.state === "Ready";
  // A copy that stops being Ready while open (purge, a remove elsewhere) closes.
  useEffect(() => {
    if (openId !== null && !openedReady) closeCopy();
  }, [openId, openedReady, closeCopy]);

  if (snapshot === null) {
    return (
      <main className={styles.shell}>
        <p role="status" className={styles.empty}>Opening downloads…</p>
      </main>
    );
  }
  if (opened !== undefined && openedReady) {
    return (
      <main className={`${styles.shell} ${styles.readerShell}`}>
        <header className={styles.readerHeader}>
          <button type="button" className={styles.quietAction} onClick={closeCopy}>Downloads</button>
          <div>
            <h1 title={opened.title}>{opened.title}</h1>
            <p>{statusCopy(opened, snapshot)}</p>
          </div>
        </header>
        {alert}
        <ShelfReader key={opened.mediaId} item={opened} onRemove={() => remove(opened)} />
        {dialog}
      </main>
    );
  }

  const section = (label: string, items: readonly OfflineItem[]) =>
    items.length === 0 ? null : (
      <section aria-label={label}>
        <h2 className={`${styles.label} ${styles.sectionTitle}`}>{label}</h2>
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.mediaId} className={styles.row}>
              <div>
                <p className={styles.label}>{KIND_COPY[item.kind]}</p>
                <h3 className={styles.rowTitle}>
                  <button type="button" onClick={() => run("openHosted", { path: `/media/${item.mediaId}` })}>
                    {item.title}
                  </button>
                </h3>
                <p className={styles.rowMeta}>{statusCopy(item, snapshot)}</p>
                {item.progress === null ? null : (
                  <p className={item.progress.kind === "Canonical" || item.progress.kind === "Pending"
                    ? styles.rowMeta : styles.notice}>
                    {POSITION_COPY[item.progress.kind]}
                  </p>
                )}
              </div>
              <div className={styles.rowActions}>
                {item.state === "Ready" && isReading(item) ? (
                  <button type="button" className={styles.action} aria-label={`Open ${item.title}`}
                    onClick={() => openCopy(item.mediaId)}>Open</button>
                ) : null}
                {item.state === "Queued" || item.state === "Downloading" ? (
                  <button type="button" className={styles.quietAction}
                    onClick={() => run("cancel", { mediaId: item.mediaId })}>Cancel</button>
                ) : null}
                {item.state === "Failed" ? (
                  <button type="button" className={styles.action}
                    onClick={() => run("retry", { mediaId: item.mediaId })}>Retry</button>
                ) : null}
                {item.state === "Ready" || item.state === "Failed" ? (
                  <button type="button" className={styles.quietAction} aria-label={`Remove ${item.title}`}
                    onClick={() => remove(item)}>Remove</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    );

  const downloaded = snapshot.items.reduce(
    (total, item) => (item.state === "Ready" ? total + item.sizeBytes : total),
    0,
  );
  return (
    <main className={styles.shell}>
      <header className={styles.hero}>
        <p className={`${styles.label} ${styles.eyebrow}`}>Nexus</p>
        <h1>Downloads</h1>
        <button type="button" className={styles.quietAction} onClick={() => run("openHosted", { path: "/" })}>
          Back to Nexus
        </button>
      </header>
      {alert}
      {snapshot.authRequired ? (
        <p role="alert" className={styles.notice}>
          Sign in to Nexus again to download and sync reading positions. Downloads stay on this device.
        </p>
      ) : null}
      <div className={styles.summary}>
        <span>{formatByteCount(downloaded)} downloaded</span>
        <label className={styles.policy}>
          <input
            type="checkbox"
            checked={snapshot.policy === "AnyConnected"}
            onChange={(event) => {
              if (!event.currentTarget.checked) {
                run("policy", { value: "UnmeteredOnly" });
                return;
              }
              setConfirmation({
                title: "Allow all downloads over mobile data?",
                body: "This releases every download waiting for Wi-Fi.",
                action: "Allow mobile data",
                run: () => run("policy", { value: "AnyConnected" }),
              });
            }}
          />
          <span>Download over mobile data</span>
        </label>
      </div>
      {snapshot.items.length === 0 ? <p className={styles.empty}>No downloads.</p> : null}
      {section("Listening", snapshot.items.filter((item) => !isReading(item)))}
      {section("Reading", snapshot.items.filter(isReading))}
      {dialog}
    </main>
  );
}
