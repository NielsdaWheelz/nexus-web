// A downloaded copy in the shared reader. The source reads the copy's
// reader.json (the reader document as the server built it); the progress
// port keeps the position on the device through the bridge, which syncs it.
import { useEffect, useMemo, useState } from "react";
import type { Schema } from "@/lib/api/wire";
import {
  Contents,
  SourceIssuesNotice,
} from "@/lib/documentReader/chrome/Contents";
import { MapRail } from "@/lib/documentReader/chrome/MapRail";
import DocumentReaderView, {
  useDocumentReader,
  useReaderState,
} from "@/lib/documentReader/DocumentReader";
import {
  readerDocument,
  type ReaderDocumentOut,
} from "@/lib/documentReader/model";
import type {
  ProgressView,
  ReaderProgressPort,
  ReaderSource,
} from "@/lib/documentReader/ports";
import {
  currentOfflineSnapshot,
  offlineCall,
  type OfflineItem,
} from "@/lib/offline/bridge";
import styles from "./shelf.module.css";

const copyUrl = (mediaId: string, path: string) =>
  new URL(`/shelf/copies/${mediaId}/${path}`, window.location.href).href;

function shelfSource(mediaId: string): ReaderSource {
  const pdf = {
    url: copyUrl(mediaId, "document.pdf"),
    headers: {},
    expiresAtMs: null,
  };
  return {
    async load(signal) {
      const response = await fetch(copyUrl(mediaId, "reader.json"), { signal });
      if (!response.ok)
        throw new Error(`reader.json answered ${response.status}`);
      const copy = (await response.json()) as {
        readonly document: ReaderDocumentOut;
      };
      const doc = readerDocument(copy.document);
      if (doc.kind === "pdf") return { ...doc, file: pdf };
      // Epub html points at the hosted asset route; the copy carries the same assets.
      const assets = `/api/media/${mediaId}/assets/`;
      const units = doc.units.map((unit) => ({
        ...unit,
        html: unit.html.replaceAll(assets, copyUrl(mediaId, "assets/")),
      }));
      return { ...doc, units };
    },
    refreshPdf: async () => pdf,
  };
}

/**
 * The device position; the snapshot the bridge pushes before each reply is the
 * new view. A save never touches canonical: in a conflict it moves the device side.
 */
function shelfProgress(mediaId: string): ReaderProgressPort {
  const view = (): ProgressView => {
    const item = currentOfflineSnapshot()?.items.find(
      (entry) => entry.mediaId === mediaId,
    );
    if (!item?.progress)
      throw new Error("This downloaded copy is no longer on this device");
    return item.progress;
  };
  return {
    load: async () => view(),
    async save(locator) {
      await offlineCall("save", { mediaId, locator });
      return { kind: "Device", view: view() };
    },
    async resolve(choice, conflict) {
      if (choice === "Device")
        await offlineCall("save", { mediaId, locator: conflict.device });
      await offlineCall("resolve", { mediaId, choice });
      return view();
    },
  };
}

/** The shelf never reaches the reader-profile service, so it states its typography. */
const SHELF_PROFILE: Schema<"ReaderProfileOut"> = {
  theme: "dark",
  font_family: "serif",
  font_size_px: 19,
  line_height: 1.6,
  column_width_ch: 66,
  focus_mode: "off",
  hyphenation: "auto",
};

const NOTICE: Partial<Record<ProgressView["kind"], string>> = {
  ContentChanged:
    "A newer source version exists. This downloaded copy and its position remain only on this device.",
  SourceUnavailable:
    "The source was deleted or is unavailable. Your downloaded copy and device position remain.",
};

export default function ShelfReader({
  item,
  onRemove,
}: {
  readonly item: OfflineItem;
  readonly onRemove: () => void;
}) {
  const options = useMemo(
    () => ({
      source: shelfSource(item.mediaId),
      progress: shelfProgress(item.mediaId),
      entry: { fresh: null, cold: null },
    }),
    [item.mediaId],
  );
  // No redownload in place: a copy's identity is its media and when it was saved.
  const reader = useDocumentReader(`${item.mediaId}:${item.savedAt}`, options);
  const document = useReaderState(reader, (state) => state.document);
  const progress = useReaderState(reader, (state) =>
    state.progress?.kind === "Ready" ? state.progress.view.kind : null,
  );
  const [contents, setContents] = useState(false);
  const [continued, setContinued] = useState(false);
  // A sync pass may settle or conflict this position while the copy is open.
  useEffect(() => reader.revalidate(), [item.progress, reader]);

  if (document.status === "failed") {
    return (
      <div className={styles.documentReader}>
        <p role="alert" className={styles.notice}>
          This downloaded copy could not be opened. Its files may be incomplete
          or from an older version of Nexus; remove it and download it again.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={reader.retryLoad}
          >
            Try again
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemove}
          >
            Remove downloaded copy
          </button>
        </div>
      </div>
    );
  }
  const text =
    document.status === "ready" && document.doc.kind === "text"
      ? document.doc
      : null;
  const notice = progress && NOTICE[progress];
  return (
    <div className={styles.documentReader}>
      {text ? <SourceIssuesNotice issues={text.sourceIssues} readable /> : null}
      {text?.format === "web" ? (
        <p className={styles.notice}>Text-only copy; images not included</p>
      ) : null}
      {notice ? (
        <p role="alert" className={styles.notice}>
          {notice}
        </p>
      ) : null}
      {progress === "ContentChanged" && !continued ? (
        <div className={styles.actions} aria-label="Changed source">
          <button
            type="button"
            className={styles.action}
            onClick={() => setContinued(true)}
          >
            Continue reading
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemove}
          >
            Remove downloaded copy
          </button>
        </div>
      ) : null}
      {text && text.toc.length > 0 ? (
        <div className={`${styles.actions} ${styles.readerActions}`}>
          <button
            type="button"
            className={styles.action}
            aria-expanded={contents}
            onClick={() => setContents(!contents)}
          >
            Contents
          </button>
        </div>
      ) : null}
      {contents ? (
        <div className={styles.readerMapPanel}>
          <Contents reader={reader} />
        </div>
      ) : null}
      <div className={styles.textWithMap}>
        <DocumentReaderView reader={reader} profile={SHELF_PROFILE} isMobile />
        <MapRail reader={reader} markers={[]} onMarker={() => undefined} />
      </div>
    </div>
  );
}
