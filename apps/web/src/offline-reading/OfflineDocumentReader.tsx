import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import PdfReader, {
  type PdfReaderDecorationWrites,
} from "@/components/PdfReader";
import TextDocumentReader from "@/components/reader/TextDocumentReader";
import ReaderContentsPage from "@/components/reader/ReaderContentsPage";
import type { PdfHighlightOut } from "@/lib/reader/ReaderDecorations";
import {
  findFirstVisibleCanonicalOffset,
  measureCanonicalTextAnchorViewportDelta,
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
} from "@/app/(authenticated)/media/[id]/paneTextAnchor";
import {
  buildTextReaderLocatorAtOffset,
  createDocumentReaderSession,
  preferredReaderLocator,
  type ReaderUnitLease,
} from "@/lib/reader/DocumentReaderSession";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { buildReaderSurfaceStyle } from "@/lib/reader/readerSurfaceStyle";
import type { ReaderProfile, ReaderResumeState } from "@/lib/reader/types";
import {
  useDocumentReaderWindow,
  type ReaderWindowUnit,
} from "@/lib/reader/useDocumentReaderWindow";
import {
  applyReaderUnitResources,
  prepareReaderUnit,
  type PreparedReaderUnit,
} from "@/lib/reader/publicationDom";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { ResourceCacheContext } from "@/lib/api/resourceCache";
import { useResource } from "@/lib/api/useResource";
import type { ReaderSessionLoad } from "@/lib/reader/DocumentReaderSession";
import {
  normalizeEpubHref,
  normalizeEpubPathname,
} from "@/lib/reader/epubHref";
import { useReaderContents } from "@/lib/reader/useReaderContents";
import type { ReaderPublicationTarget } from "@/lib/reader/publicationContract";
import {
  OfflineReaderProgressPort,
  OfflineReaderSource,
} from "@/lib/offlineReading/OfflineReaderAdapters";
import {
  OFFLINE_READING_COPY,
  offlineReaderLocatorContext,
  offlineReaderProgressCopy,
  offlineReadingConflictChoiceLabel,
  offlineReadingConflictLocators,
} from "@/lib/offlineReading/presentation";
import type {
  OfflineReadingControllerRuntime,
  OpenedOfflineReading,
} from "@/lib/offlineReading/runtime";
import styles from "./offlineReading.module.css";

const offlinePositioner: ReaderScrollPositioner = {
  async run(operation) {
    await operation({
      setTop(scrollport, top) {
        scrollport.scrollTop = Math.max(0, top);
      },
      adjustTop(scrollport, delta) {
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
      },
      reveal(scrollport, target) {
        const top =
          target.getBoundingClientRect().top -
          scrollport.getBoundingClientRect().top;
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + top);
      },
    });
  },
};

/**
 * The packaged shelf never reaches the reader-profile service (offline
 * personalization is a non-goal), so it states the reading typography it
 * renders with. Without this the shared reader resolves `--reader-*` through
 * their fallbacks and sets prose in the mono stack.
 */
const OFFLINE_SHELF_READER_PROFILE: ReaderProfile = {
  theme: "dark",
  font_family: "serif",
  font_size_px: 19,
  line_height: 1.6,
  column_width_ch: 66,
  focus_mode: "off",
  hyphenation: "auto",
};
const offlineReaderSurfaceStyle = buildReaderSurfaceStyle(
  OFFLINE_SHELF_READER_PROFILE,
);

const noOfflinePdfDecorations: PdfReaderDecorationWrites = {
  adoptHighlightPaint() { throw new Error("Highlights are unavailable in downloaded copies"); },
  async createHighlight(): Promise<PdfHighlightOut> {
    throw new Error("Highlights are unavailable in downloaded copies");
  },
  async updateHighlight(): Promise<PdfHighlightOut> {
    throw new Error("Highlights are unavailable in downloaded copies");
  },
};

function progressNotice(view: ReaderProgressView): string | null {
  switch (view.kind) {
    case "ContentChanged":
      return OFFLINE_READING_COPY.changedSourceNotice;
    case "SourceUnavailable":
      return OFFLINE_READING_COPY.sourceUnavailableNotice;
    case "Conflict":
      return OFFLINE_READING_COPY.conflictNotice;
    case "Canonical":
    case "Pending":
      return null;
  }
}

const CAPACITY_NOTICE =
  "Release the current selection or editing interaction to load this part.";

type PreparedUnitView = {
  readonly item: ReaderWindowUnit;
  readonly view: PreparedReaderUnit;
};

type OfflineDocumentReaderProps = {
  readonly controller: OfflineReadingControllerRuntime;
  readonly mediaId: string;
  readonly opened: OpenedOfflineReading;
  readonly authoritativeProgress: ReaderProgressView | null;
  readonly onClose: () => void;
  readonly onRemoveRequested: () => void;
};

export default function OfflineDocumentReader(
  props: OfflineDocumentReaderProps,
) {
  const cache = useContext(ResourceCacheContext);
  if (cache === null)
    throw new Error("Offline reader requires its shared resource owner");
  const binding = props.controller.getSnapshot()?.binding;
  if (binding?.kind !== "Present")
    throw new Error("Offline reader requires its selected native account");
  const accountId = binding.value.accountId;
  const [attempt, setAttempt] = useState(0);
  const identity = useMemo(
    () => ({
      controller: props.controller,
      mediaId: props.mediaId,
      opened: props.opened,
      accountId,
      cache,
      attempt,
    }),
    [props.controller, props.mediaId, props.opened, accountId, cache, attempt],
  );
  const [owned, setOwned] = useState<{
    identity: typeof identity;
    session: ReturnType<typeof createDocumentReaderSession>;
    source: OfflineReaderSource;
    progressPort: OfflineReaderProgressPort;
  } | null>(null);
  useEffect(() => {
    const progressPort = new OfflineReaderProgressPort(
      identity.controller,
      identity.mediaId,
      identity.opened,
    );
    const source = new OfflineReaderSource(
      identity.mediaId,
      identity.opened,
      identity.accountId,
      READER_CAPACITY,
      identity.cache,
    );
    const session = createDocumentReaderSession({
      mediaId: identity.mediaId,
      source,
      progress: progressPort,
      capacity: READER_CAPACITY,
    });
    setOwned({ identity, session, source, progressPort });
    return () => session.close();
  }, [identity]);
  if (owned?.identity !== identity)
    return <p role="status">Opening verified copy…</p>;
  return (
    <OfflineDocumentReaderBody
      {...props}
      session={owned.session}
      source={owned.source}
      progressPort={owned.progressPort}
      attempt={attempt}
      retry={() => setAttempt((value) => value + 1)}
    />
  );
}

function OfflineDocumentReaderBody({
  mediaId,
  opened,
  authoritativeProgress,
  onClose,
  onRemoveRequested,
  session,
  source,
  progressPort,
  attempt,
  retry,
}: OfflineDocumentReaderProps & {
  readonly session: ReturnType<typeof createDocumentReaderSession>;
  readonly source: OfflineReaderSource;
  readonly progressPort: OfflineReaderProgressPort;
  readonly attempt: number;
  readonly retry: () => void;
}) {
  const liveSession = useRef(session);
  liveSession.current = session;
  const [progress, setProgress] = useState(opened.progress);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [changedSourceAcknowledged, setChangedSourceAcknowledged] =
    useState(false);
  const [unresolvedNavigation, setUnresolvedNavigation] = useState(false);
  const [pdfEpoch, setPdfEpoch] = useState(0);
  const [renderDefect, setRenderDefect] = useState<unknown>(null);
  const readerRootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLElement>(null);
  const prepared = useRef(new Map<ReaderUnitLease, PreparedUnitView>());
  const [preparedViews, setPreparedViews] = useState<
    readonly PreparedUnitView[]
  >([]);
  const [domCapacity, setDomCapacity] = useState(false);
  /** Position the reader keeps across a window mutation. */
  const pendingAnchor = useRef<{
    readonly lease: ReaderUnitLease;
    readonly offset: number | null;
    readonly delta: number;
    readonly scrollLeft: number;
  } | null>(null);
  const appliedNavigation = useRef<number | null>(null);
  const scrolled = useRef(false);
  const savedPosition = useRef<string | null>(null);
  const writer = useRef<{
    inFlight: boolean;
    queued: ReaderResumeState | null;
  }>({ inFlight: false, queued: null });
  const retireUnits = useCallback((units: readonly ReaderWindowUnit[]) => {
    const selection = window.getSelection();
    for (const item of units) {
      const root = prepared.current.get(item.lease)?.view.root;
      if (root === undefined) continue;
      item.lease.pin(
        "Selection",
        selection !== null &&
          !selection.isCollapsed &&
          Array.from({ length: selection.rangeCount }, (_, index) =>
            selection.getRangeAt(index),
          ).some((range) => range.intersectsNode(root)),
      );
      item.lease.pin(
        "Focus",
        document.activeElement !== null &&
          root.contains(document.activeElement),
      );
    }
    if (units.some((item) => item.lease.pinned)) return false;
    for (const item of units) {
      prepared.current.get(item.lease)?.view.release();
      prepared.current.delete(item.lease);
    }
    // The mounted window reads in document order, not acquisition order.
    setPreparedViews(
      [...prepared.current.values()].sort(
        (left, right) => left.item.address.ordinal - right.item.address.ordinal,
      ),
    );
    return true;
  }, []);
  const initial = useResource<ReaderSessionLoad>({
    cacheKey: `offline:${opened.leaseId}:${attempt}`,
    load: (signal) => session.load(signal, { fresh: null, cold: null }),
    onDefect: setRenderDefect,
  });
  const reader = useDocumentReaderWindow({
    session,
    initial,
    retryInitial: retry,
    retireUnits,
  });
  const loaded =
    initial.status === "ready" && "document" in initial.data
      ? initial.data
      : null;
  const descriptor = loaded?.document.descriptor ?? null;
  const active = reader.activeUnit;
  const preferred =
    descriptor === null
      ? null
      : preferredReaderLocator(progress, descriptor.source);

  useEffect(() => {
    if (authoritativeProgress !== null) {
      progressPort.observeNativeProgress(authoritativeProgress);
      setProgress(authoritativeProgress);
    }
  }, [authoritativeProgress, progressPort]);
  useLayoutEffect(() => {
    const owned = prepared.current;
    setRenderDefect(null);
    setPreparedViews([]);
    appliedNavigation.current = null;
    pendingAnchor.current = null;
    savedPosition.current = null;
    scrolled.current = false;
    return () => {
      for (const { view } of owned.values()) view.release();
      owned.clear();
    };
  }, [session]);
  useLayoutEffect(() => {
    if (descriptor === null) return;
    let full = false;
    for (const item of reader.units) {
      if (prepared.current.has(item.lease)) continue;
      try {
        const result = prepareReaderUnit({
          session,
          unit: item.unit,
          unitKey: item.address.unit_ref.key,
          highlights: [],
          headingLevelOffset: 0,
        });
        if (result.kind === "Capacity") {
          full = true;
          break;
        }
        // The package archived these members; resolve them against the same
        // verified lease origin the unit bytes came from.
        applyReaderUnitResources(result.value, (member) =>
          source.assetUrl(descriptor, member),
        );
        prepared.current.set(item.lease, { item, view: result.value });
      } catch (error) {
        setRenderDefect(error);
        break;
      }
    }
    setDomCapacity(full);
    setPreparedViews(
      reader.units.flatMap((item) => {
        const value = prepared.current.get(item.lease);
        return value === undefined ? [] : [value];
      }),
    );
  }, [reader.units, session, descriptor, source]);

  const firstIndex =
    descriptor !== null && descriptor.kind !== "pdf"
      ? descriptor.contents_ref
      : null;
  const contents = useReaderContents({
    session,
    first: firstIndex,
    enabled: true,
  });
  const navigation =
    contents.state.kind === "Ready" ? contents.state.page : null;
  const sectionLabel = (id: string) =>
    navigation?.sections.find((section) => section.section_id === id)?.label ??
    null;
  /** One capture in flight; newer movement replaces the unsent locator. */
  const save = (locator: ReaderResumeState) => {
    if (writer.current.inFlight) {
      writer.current.queued = locator;
      return;
    }
    writer.current.inFlight = true;
    void progressPort
      .capture(mediaId, locator)
      .then((result) => {
        if (liveSession.current !== session) return;
        const next =
          result.kind === "Canonical" || result.kind === "Conflict"
            ? result
            : result.view;
        setProgress(next);
        setSaveStatus(offlineReaderProgressCopy(next));
      })
      .catch(() => {
        if (liveSession.current === session)
          setSaveStatus(OFFLINE_READING_COPY.saveFailedNotice);
      })
      .finally(() => {
        writer.current.inFlight = false;
        const queued = writer.current.queued;
        writer.current.queued = null;
        if (queued !== null && liveSession.current === session) save(queued);
      });
  };
  const locatorAt = (
    item: ReaderWindowUnit,
    offset: number,
  ): ReaderResumeState | null => {
    if (descriptor === null || descriptor.kind === "pdf") return null;
    const unit = item.unit;
    return buildTextReaderLocatorAtOffset({
      anchorOffset: offset - unit.start_cp,
      canonicalText: unit.canonical_text,
      fragmentId: unit.fragment_id,
      format: descriptor.kind === "epub" ? "epub" : "web",
      fragmentStartOffset: unit.start_cp,
      fragmentLength: unit.fragment_length_cp,
      documentStartOffset: unit.fragment_document_start_cp,
      documentLength: descriptor.canonical_length,
      isFinalUnit: item.address.next_ref === null,
      epubSection: unit.epub_target,
      epubAnchorId: unit.epub_target?.anchor_id ?? null,
      positionBucketCodePoints: 1000,
    });
  };
  /**
   * Navigation owns the focus it is about to retire: an activated link inside
   * the outgoing unit hands keyboard focus to the destination viewport, so the
   * focus pin only ever refuses an interaction the reader still owns.
   */
  const runNavigation = (target: ReaderPublicationTarget) => {
    const focused = document.activeElement;
    if (
      focused !== null &&
      [...prepared.current.values()].some(({ view }) => view.root.contains(focused))
    )
      viewportRef.current?.focus({ preventScroll: true });
    setUnresolvedNavigation(false);
    return reader.navigate(target).then((result) => {
      if (liveSession.current === session && result.kind === "Unresolved")
        setUnresolvedNavigation(true);
      return result;
    });
  };
  const navigate = (target: ReaderPublicationTarget) => {
    void runNavigation(target).then((result) => {
      if (
        liveSession.current !== session ||
        result.kind !== "Ready" ||
        !result.isCurrent()
      )
        return;
      const locator = locatorAt(
        result.item,
        result.target.kind === "Text"
          ? result.target.offset_cp
          : result.item.unit.start_cp,
      );
      if (locator !== null)
        save(
          locator.kind === "epub" &&
            result.target.kind === "Text" &&
            result.target.locator.kind === "epub"
            ? { ...locator, target: result.target.locator.target }
            : locator,
        );
    });
  };
  const preserveAnchor = (entry: PreparedUnitView, offset: number | null) => {
    const viewport = viewportRef.current;
    if (viewport === null || pendingAnchor.current !== null) return;
    const delta =
      offset === null
        ? entry.view.root.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top
        : measureCanonicalTextAnchorViewportDelta(
            viewport,
            entry.view.cursor,
            offset,
          );
    if (delta === null) return;
    pendingAnchor.current = {
      lease: entry.item.lease,
      offset,
      delta,
      scrollLeft: viewport.scrollLeft,
    };
  };
  const saveVisiblePosition = (entry: PreparedUnitView, offset: number) => {
    const position = `${entry.item.address.unit_ref.key}:${offset}`;
    if (savedPosition.current === position) return;
    const locator = locatorAt(
      entry.item,
      entry.item.unit.render_start_cp + offset,
    );
    if (locator === null) return;
    savedPosition.current = position;
    save(locator);
  };
  /**
   * The reading window follows the viewport: the first visible unit is the
   * active one, contiguous ends beyond one neighbour retire, and an approaching
   * edge demands the next unit. Only a capacity refusal stops the window
   * growing, and the part actions below are then the explicit continuation.
   */
  const maintain = useRef<() => void>(() => {});
  maintain.current = () => {
    const viewport = viewportRef.current;
    if (viewport === null || descriptor === null || descriptor.kind === "pdf")
      return;
    if (
      reader.navigationTarget !== null &&
      appliedNavigation.current !== reader.navigationTarget.id
    )
      return;
    const bounds = viewport.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const entries = [...prepared.current.values()]
      .filter(({ view }) => view.root.isConnected)
      .sort((left, right) => left.item.address.ordinal - right.item.address.ordinal);
    const visible = entries.filter(({ view }) => {
      const rect = view.root.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    const firstVisible = visible[0];
    const lastVisible = visible.at(-1);
    if (firstVisible === undefined || lastVisible === undefined) return;
    if (reader.activeUnit?.lease !== firstVisible.item.lease) {
      reader.setActiveUnit(firstVisible.item.lease);
      return;
    }
    const offset = findFirstVisibleCanonicalOffset(
      viewport,
      firstVisible.view.cursor,
    );
    if (scrolled.current && offset !== null)
      saveVisiblePosition(firstVisible, offset);
    // A pinned end stays charged; it cannot leave a hole in the mounted window.
    const retire = (entry: PreparedUnitView) => {
      if (entry.item.lease.pinned) return false;
      preserveAnchor(firstVisible, offset);
      if (!retireUnits([entry.item])) return false;
      if (!reader.releaseUnit(entry.item.lease))
        throw new Error("Reader unit became pinned during synchronous retirement");
      return true;
    };
    let retired = false;
    for (const entry of entries) {
      if (
        entry.item.address.ordinal >= firstVisible.item.address.ordinal - 1 ||
        !retire(entry)
      )
        break;
      retired = true;
    }
    for (const entry of [...entries].reverse()) {
      if (
        entry.item.address.ordinal <= lastVisible.item.address.ordinal + 1 ||
        !retire(entry)
      )
        break;
      retired = true;
    }
    if (
      retired ||
      reader.unitRequest.status !== "ready" ||
      reader.contentDefect !== null ||
      reader.capacity !== null ||
      domCapacity
    )
      return;
    const head = entries[0];
    const tail = entries.at(-1);
    if (
      tail !== undefined &&
      tail.item.address.next_ref !== null &&
      tail.view.root.getBoundingClientRect().bottom <=
        bounds.bottom + bounds.height
    )
      void reader.loadNeighbor("Next");
    else if (
      head !== undefined &&
      head.item.address.previous_ref !== null &&
      head.view.root.getBoundingClientRect().top >= bounds.top - bounds.height
    )
      void reader.loadNeighbor("Previous");
  };
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    const viewport = viewportRef.current;
    const entry = anchor === null ? undefined : prepared.current.get(anchor.lease);
    if (
      anchor === null ||
      viewport === null ||
      entry === undefined ||
      !entry.view.root.isConnected
    )
      return;
    void offlinePositioner
      .run((commands) => {
        if (anchor.offset === null) {
          commands.adjustTop(
            viewport,
            entry.view.root.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top -
              anchor.delta,
          );
          viewport.scrollLeft = anchor.scrollLeft;
        } else
          restoreCanonicalTextAnchorViewportPosition(
            commands,
            viewport,
            entry.view.cursor,
            anchor.offset,
            anchor.delta,
            anchor.scrollLeft,
          );
      })
      .catch((error: unknown) => setRenderDefect(error));
  }, [preparedViews]);
  useLayoutEffect(() => {
    const target = reader.navigationTarget;
    const viewport = viewportRef.current;
    if (
      target === null ||
      viewport === null ||
      appliedNavigation.current === target.id
    )
      return;
    const entry = [...prepared.current.values()].find(
      ({ item, view }) => item.address.unit_ref.key === target.target.unit_ref.key && view.root.isConnected,
    );
    if (entry === undefined) return;
    appliedNavigation.current = target.id;
    const unit = entry.item.unit;
    const offset =
      target.target.kind === "Text"
        ? target.target.offset_cp
        : unit.render_start_cp;
    void offlinePositioner
      .run((commands) => {
        const local = Math.max(
          0,
          Math.min(entry.view.cursor.length, offset - unit.render_start_cp),
        );
        if (
          !scrollToExactCanonicalTextAnchor(
            commands,
            viewport,
            entry.view.cursor,
            local,
          )
        )
          commands.reveal(viewport, entry.view.root);
      })
      .catch((error: unknown) => setRenderDefect(error));
  }, [preparedViews, reader.navigationTarget]);
  useLayoutEffect(() => {
    maintain.current();
  }, [
    preparedViews,
    reader.activeUnit,
    reader.unitRequest,
    reader.capacity,
    domCapacity,
  ]);
  const choose = (choice: "Canonical" | "Device") => {
    void progressPort
      .resolve(mediaId, choice)
      .then((next) => {
        if (liveSession.current !== session) return;
        setProgress(next);
        if (descriptor === null) return;
        const locator = preferredReaderLocator(next, descriptor.source);
        if (locator !== null && locator.kind !== "pdf")
          void runNavigation({ kind: "Locator", locator });
        else setPdfEpoch((epoch) => epoch + 1);
      })
      .catch(() => {
        if (liveSession.current === session)
          setSaveStatus(OFFLINE_READING_COPY.saveFailedNotice);
      });
  };

  const failure =
    renderDefect !== null ||
    reader.contentDefect !== null ||
    initial.status === "error";
  if (failure)
    return (
      <div className={styles.documentReader}>
        <p role="alert" className={styles.notice}>
          This downloaded copy could not be opened. Its files may be incomplete
          or no longer verified on this device.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={retry}>
            Try again
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onClose}
          >
            Back to downloads
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemoveRequested}
          >
            Remove downloaded copy
          </button>
        </div>
      </div>
    );
  if (initial.status === "ready" && !("document" in initial.data))
    return (
      <div>
        <p role="status">The reader is busy finishing its previous request.</p>
        <button type="button" onClick={reader.retryUnit}>
          Try again
        </button>
      </div>
    );
  if (loaded === null || descriptor === null)
    return <p role="status">Opening verified copy…</p>;
  const notice = progressNotice(progress);
  const conflict =
    progress.kind === "Conflict"
      ? offlineReadingConflictLocators(progress)
      : null;
  const capacityBlocked = reader.capacity !== null || domCapacity;
  const firstPart = preparedViews[0];
  const lastPart = preparedViews.at(-1);
  const textState =
    preparedViews.length > 0
      ? {
          status: "ready" as const,
          preparedRoots: preparedViews.map(({ item, view }) => ({
            key: item.address.unit_ref.key,
            root: view.root,
          })),
        }
      : capacityBlocked
        ? {
            status: "error" as const,
            message: CAPACITY_NOTICE,
            retry: reader.retryUnit,
          }
        : reader.unitRequest.status === "error"
          ? {
              status: "error" as const,
              message: "This part could not be opened.",
              retry: reader.retryUnit,
            }
          : { status: "loading" as const, message: "Opening document part…" };
  return (
    <div className={styles.documentReader}>
      {notice === null ? null : (
        <p role="alert" className={styles.notice}>
          {notice}
        </p>
      )}
      {progress.kind === "ContentChanged" && !changedSourceAcknowledged ? (
        <div className={styles.actions} aria-label="Changed source">
          <button
            type="button"
            className={styles.action}
            onClick={() => setChangedSourceAcknowledged(true)}
          >
            {OFFLINE_READING_COPY.continueAction}
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemoveRequested}
          >
            {OFFLINE_READING_COPY.removeConfirmAction}
          </button>
        </div>
      ) : null}
      {conflict === null ? null : (
        <div className={styles.actions} aria-label="Choose saved location">
          <button
            type="button"
            className={styles.action}
            onClick={() => choose("Canonical")}
          >
            {offlineReadingConflictChoiceLabel(
              "Canonical",
              offlineReaderLocatorContext(conflict.canonical, sectionLabel),
            )}
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => choose("Device")}
          >
            {offlineReadingConflictChoiceLabel(
              "Device",
              offlineReaderLocatorContext(conflict.device, sectionLabel),
            )}
          </button>
        </div>
      )}
      {saveStatus === null ? null : (
        <p className={styles.saved} role="status">
          {saveStatus}
        </p>
      )}
      {unresolvedNavigation ? (
        <p role="alert" className={styles.notice}>
          This copy does not contain that location. The reader stayed where it
          was.
        </p>
      ) : reader.unresolved === null ? null : (
        <p role="alert" className={styles.notice}>
          The saved location is unavailable in this copy. Showing its first
          part.
        </p>
      )}
      {loaded.document.kind === "Pdf" ? (
        <PdfReader
          key={`pdf:${pdfEpoch}`}
          mediaId={mediaId}
          resources={{
            signedUrl: { status: "ready", data: loaded.document.document },
            pageHighlights: { status: "idle" },
            retryPageHighlights: null,
            requestSignedUrlRefresh: () => undefined,
          }}
          decorations={noOfflinePdfDecorations}
          isMobile
          mobileChromeEnabled={false}
          acquireMobileChromeVisibleLock={() => () => undefined}
          scrollPositioner={offlinePositioner}
          handleAuthenticationError={() => false}
          startPageNumber={preferred?.kind === "pdf" ? preferred.page : 1}
          startPageProgression={
            preferred?.kind === "pdf"
              ? (preferred.page_progression ?? undefined)
              : undefined
          }
          startZoom={
            preferred?.kind === "pdf"
              ? (preferred.zoom ?? undefined)
              : undefined
          }
          onSemanticViewportChange={(viewport) => {
            if (viewport?.intent === "Reader") save(viewport.primaryLocator);
          }}
        />
      ) : (
        <>
          <ReaderContentsPage
            contents={contents}
            activeSectionId={
              active?.unit.epub_target?.section_id ??
              navigation?.sections.find(
                (entry) => entry.unit_key === active?.address.unit_ref.key,
              )?.section_id ??
              null
            }
            onNavigate={(sectionId) =>
              navigate({ kind: "Navigation", target_id: sectionId })
            }
          />
          {capacityBlocked && firstPart !== undefined && lastPart !== undefined ? (
            <>
              <p role="alert" className={styles.notice}>
                {CAPACITY_NOTICE}
              </p>
              <div className={styles.actions} aria-label="Document parts">
                <button
                  type="button"
                  disabled={firstPart.item.address.previous_ref === null}
                  onClick={() => {
                    const previous = firstPart.item.address.previous_ref;
                    if (previous !== null)
                      navigate({ kind: "Unit", unit_key: previous.key });
                  }}
                >
                  Previous part
                </button>
                <button
                  type="button"
                  disabled={lastPart.item.address.next_ref === null}
                  onClick={() => {
                    const next = lastPart.item.address.next_ref;
                    if (next !== null)
                      navigate({ kind: "Unit", unit_key: next.key });
                  }}
                >
                  Next part
                </button>
              </div>
            </>
          ) : null}
          <TextDocumentReader
            mediaId={mediaId}
            scrollPositioner={offlinePositioner}
            readerRootRef={readerRootRef}
            contentRef={contentRef}
            textViewportRef={viewportRef}
            textEndRef={endRef}
            readerThemeClassName=""
            readerSurfaceStyle={offlineReaderSurfaceStyle}
            focusMode={OFFLINE_SHELF_READER_PROFILE.focus_mode}
            hyphenation={OFFLINE_SHELF_READER_PROFILE.hyphenation}
            contentState={textState}
            onViewportReady={() => maintain.current()}
            onViewportScroll={() => maintain.current()}
            onTrustedScrollIntent={() => {
              // The reader's own scrolling owns the position from here: it both
              // authorizes saves and ends any unapplied navigation placement.
              scrolled.current = true;
              if (reader.navigationTarget !== null)
                appliedNavigation.current = reader.navigationTarget.id;
            }}
            endContent={null}
            onInternalLinkClick={(href, anchor) => {
              if (descriptor.kind !== "epub" || href === null) return false;
              const origin = [...prepared.current.values()].find(({ view }) =>
                view.root.contains(anchor),
              )?.item.unit.epub_target;
              if (origin === null || origin === undefined) {
                setRenderDefect(
                  new Error("EPUB link has no admitted source unit"),
                );
                return true;
              }
              const normalized = normalizeEpubHref(href, origin.href_path);
              if (normalized === null) return false;
              const pathname =
                normalized.path ?? normalizeEpubPathname(origin.href_path);
              if (pathname === null) {
                setRenderDefect(
                  new Error("EPUB link has no valid source pathname"),
                );
                return true;
              }
              navigate({
                kind: "EpubHref",
                pathname,
                anchor_id: normalized.anchorId,
              });
              return true;
            }}
            onContentClick={() => undefined}
            onContentPointerOver={() => undefined}
            onContentPointerOut={() => undefined}
            onContentFocus={() => undefined}
            onContentBlur={() => undefined}
          />
        </>
      )}
    </div>
  );
}
