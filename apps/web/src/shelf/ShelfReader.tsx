// A downloaded copy in the shared reader. The source reads the copy's
// reader.json (the reader document as the server built it); the progress
// port keeps the position on the device through the bridge, which syncs it.
// Annotations are the account's local authored state, not part of the copy.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Fact } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import type { Schema } from "@/lib/api/wire";
import { WIRE_HEADER } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import {
  Contents,
  SourceIssuesNotice,
} from "@/lib/documentReader/chrome/Contents";
import { MapRail } from "@/lib/documentReader/chrome/MapRail";
import { CompactAnnotationLayer, type ReaderAnnotationProps } from "@/lib/documentReader/chrome/CompactAnnotations";
import { AuthoredProvider } from "@/lib/authored/provider";
import { ReaderProfileProvider } from "@/lib/reader/ReaderProfileContext";
import { ReaderNoteEditorHost } from "@/lib/notes/editorHost";
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
  currentLocalContent,
  localMutation,
  LocalMutationObservationError,
  readLocalContent,
  type LocalItem,
} from "@/lib/offline/localContent";
import styles from "./shelf.module.css";

const copyUrl = (mediaId: string, path: string) =>
  new URL(`/shelf/copies/${mediaId}/${path}`, window.location.href).href;

/** The copy's publication is the generation the device pinned when it saved the copy, never
 * a field its reader.json may predate. Thread copies keep their per-post owner generations. */
function shelfSource(mediaId: string, generation: number): ReaderSource {
  const pdf = { url: copyUrl(mediaId, "document.pdf"), expiresAtMs: null };
  return {
    async load(signal) {
      const response = await fetch(copyUrl(mediaId, "reader.json"), { signal, headers: { [WIRE_HEADER]: String(WIRE_REVISION) } });
      if (!response.ok)
        throw new Error(`reader.json answered ${response.status}`);
      const copy = (await response.json()) as {
        readonly document: ReaderDocumentOut;
      };
      if (copy.document.kind !== "pdf" && (copy.document.x_article_content === undefined || copy.document.x_capture === undefined || copy.document.units.some((unit) => unit.x_post === undefined)))
        throw new Error("this copy predates the current reader format; download it again");
      const out = copy.document;
      const doc = readerDocument(out.kind === "pdf" ? { ...out, publication_generation: generation }
        : out.kind === "web_article" || out.kind === "epub" ? { ...out, publication_generation: out.units.some(unit => unit.x_post) ? null : generation } : out);
      if (doc.kind === "pdf") return { ...doc, file: pdf };
      // Epub html points at the hosted asset route; the copy carries the same assets.
      const assets = `/api/media/${mediaId}/assets/`;
      const units = doc.units.map((unit) => ({
        ...unit,
        html: unit.html.replaceAll(assets, copyUrl(mediaId, "assets/")).replaceAll("/nexus-copy/", copyUrl(mediaId, "")),
      }));
      return { ...doc, units };
    },
    refreshPdf: async () => pdf,
  };
}

/**
 * The device position; mutations await a readable index covering the receipt. A save never touches canonical: in a conflict it moves the device side.
 */
function shelfProgress(mediaId: string): ReaderProgressPort {
  let pendingReceipt: string | null = null;
  const view = (): ProgressView => {
    const item = currentLocalContent().index?.items.find(
      (entry) => entry.media_id === mediaId,
    );
    if (!item?.progress)
      throw new Error("This downloaded copy is no longer on this device");
    return item.progress.kind === "Canonical" ? item.progress : { ...item.progress, adoptUnresolved: item.progress.adopt_unresolved };
  };
  return {
    load: async () => {
      if (pendingReceipt !== null) { await readLocalContent(pendingReceipt); pendingReceipt = null; }
      return view();
    },
    async save(locator, base) {
      try {
        await localMutation("save", { media_id: mediaId, locator, base_revision: base.revision,
          expected_reader_generation: base.expectedReaderGeneration, adopt_unresolved: base.adoptUnresolved });
      } catch (error) {
        if (error instanceof LocalMutationObservationError) {
          pendingReceipt = error.observation.receipt;
          return { kind: "Unobserved", acceptance: pendingReceipt === null ? "Unknown" : "Accepted", error };
        }
        if (error instanceof Error && error.message === "ContentChanged") return { kind: "ContentChanged" };
        if (error instanceof Error && error.message === "Conflict") {
          const current = view();
          const canonical = current.kind === "Canonical" ? current.snapshot : current.kind === "Conflict" ? current.canonical : current.baseline;
          return { kind: "Stale", canonical };
        }
        throw error;
      }
      return { kind: "Device", view: view() };
    },
    async resolve(choice) {
      try { await localMutation("resolve", { media_id: mediaId, choice }); }
      catch (error) {
        if (!(error instanceof LocalMutationObservationError)) throw error;
        pendingReceipt = error.observation.receipt;
        return { kind: "Unobserved", acceptance: pendingReceipt === null ? "Unknown" : "Accepted", error };
      }
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

/** The native progress kinds that leave this copy and its position on the device alone. */
const NOTICE: Partial<Record<ProgressView["kind"], { fact: string; reason: string }>> = {
  ContentChanged: { fact: "a newer source version exists.", reason: "this copy and position stay only on this device." },
  SourceUnavailable: { fact: "the source is unavailable.", reason: "this copy and position remain on this device." },
};

export default function ShelfReader({
  item,
  onRemove,
}: {
  readonly item: LocalItem;
  readonly onRemove: () => void;
}) {
  const options = useMemo(
    () => ({
      source: shelfSource(item.media_id, item.generation),
      progress: shelfProgress(item.media_id),
      entry: { fresh: null, cold: null },
    }),
    [item.media_id, item.generation],
  );
  // No redownload in place: a copy's identity is its media and when it was saved.
  const reader = useDocumentReader(`${item.media_id}:${item.saved_at}`, options);
  const document = useReaderState(reader, (state) => state.document);
  const progress = useReaderState(reader, (state) =>
    state.progress?.kind === "Ready" ? state.progress.view.kind : null,
  );
  const frame = useRef<HTMLDivElement>(null);
  const [contents, setContents] = useState(false);
  const [continued, setContinued] = useState(false);
  const [annotations, setAnnotations] = useState<ReaderAnnotationProps | null>(null);
  const account = useContext(ShelfAccount);
  // A sync pass may settle or conflict this position while the copy is open.
  useEffect(() => reader.revalidate(), [item.progress, reader]);
  // The copy's bytes never wait on the account store: annotations join when it opens.
  // the shelf hosts the same editor through reader ports: drafts, feedback and the account store.
  const layer = account.kind === "Ready" ? <AuthoredProvider accountId={account.id} host="shelf">
    <ReaderNoteEditorHost identity={`shelf:${item.media_id}:${item.saved_at}`}>
      <CompactAnnotationLayer reader={reader} mediaId={item.media_id} source={{ kind: item.kind, label: item.title }} available report={setAnnotations} />
    </ReaderNoteEditorHost>
  </AuthoredProvider> : account.kind === "Unavailable" ? <Fact line={{ fact: "couldn’t open your notes here." }}
    verbs={[{ label: "retry", commandKey: "RetryShelfAccount", run: account.retry, busy: account.retrying }]} /> : null;

  const text =
    document.status === "ready" && document.doc.kind === "text"
      ? document.doc
      : null;
  const notice = progress && NOTICE[progress];
  // one tree for both states: the annotation layer keeps its place across a retried load.
  return (
    <ReaderProfileProvider profile={SHELF_PROFILE}><div className={styles.documentReader} ref={frame} tabIndex={-1}>
      {document.status === "failed" ? (
        <Fact line={{ fact: "couldn’t open this downloaded copy." }} speak verbs={[
          { label: "retry", commandKey: "RetryDownloadedCopy", run: reader.retryLoad, busy: document.retrying },
          { label: "remove copy", commandKey: "RemoveDownloadedCopy", run: onRemove },
        ]} />
      ) : <>
        {text ? <SourceIssuesNotice issues={text.sourceIssues} readable /> : null}
        {text?.format === "web" ? (
          <Fact line={{ fact: "text-only copy.", reason: "images aren’t included." }} />
        ) : null}
        {notice ? (
          <Fact line={notice} speak />
        ) : null}
        {progress === "ContentChanged" && !continued ? (
          <div className={styles.actions} aria-label="Changed source">
            <Button
              emphasis="strong"
              onClick={() => setContinued(true)}
            >
              Continue reading
            </Button>
            <Button
              tone="danger"
              onClick={onRemove}
            >
              Remove downloaded copy
            </Button>
          </div>
        ) : null}
        {text && text.toc.length > 0 ? (
          <div className={`${styles.actions} ${styles.readerActions}`}>
            <Button
              aria-expanded={contents}
              onClick={() => setContents(!contents)}
            >
              Contents
            </Button>
          </div>
        ) : null}
        {contents ? (
          <div className={styles.readerMapPanel}>
            <Contents reader={reader} />
          </div>
        ) : null}
        <div className={styles.textWithMap}>
          <DocumentReaderView playback={null} reader={reader} profile={SHELF_PROFILE} isMobile showCaptureTitle={false}
            decorations={annotations?.decorations} onSelection={annotations?.onSelection} onMarks={annotations?.onMarks} />
          <MapRail reader={reader} evidence={null} />
        </div>
      </>}
      {layer}
    </div></ReaderProfileProvider>
  );
}

/** The native session's account for this shelf document; the shelf never chooses one. */
export type ShelfAccountState = { readonly kind: "Loading" } | { readonly kind: "Ready"; readonly id: string } | { readonly kind: "Unavailable"; readonly occurrence: object; readonly retrying: boolean; readonly retry: () => void };
export const ShelfAccount = createContext<ShelfAccountState>({ kind: "Loading" });
