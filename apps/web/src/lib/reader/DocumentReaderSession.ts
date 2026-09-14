"use client";

import type { RetrievalLocator } from "@/lib/api/sse/locators";
import { decodePdfHighlightQuad, type PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { publicationPayloadBytes } from "@/lib/api/resourceCache";
import { READER_DECODE_RESERVATION_FACTOR, type ReaderCapacity, type ReaderCapacityReason } from "./readerCapacity";
import type { DocumentEmbed, DocumentEmbedSource } from "@/lib/media/documentEmbeds";
import { READER_PUBLICATION_FIND_MATCH_LIMIT, type ReaderMemberRef, type ReaderPublicationFindPage, type ReaderPublicationIndex, type ReaderPublicationSectionContext, type ReaderPublicationResolution, type ReaderPublicationSourceRangeTarget, type ReaderPublicationSourceRangeResolution, type ReaderPublicationTarget, type ReaderPublicationUnit, type ReaderPublicationUnitAddress } from "./publicationContract";
import { buildCanonicalQuoteWindow } from "./canonicalQuote";
import { readerCursorSourcesEqual } from "./readerProgress";
import type { SelectedReaderSource } from "./readerIntentStore";
import { canonicalCpLength } from "./textOffsets";
import type { ReaderResumeState } from "./types";
import type { ReaderPublicationEvidenceGutterRequest, ReaderPublicationEvidenceGutterPage, ReaderPublicationHighlightPaint, ReaderPublicationPdfHighlightsPage } from "./readerPublicationOverlays";
import type { ReaderGutterWindow } from "./publicationGutter";
import { PDF_PULSE_KEY_PREFIX, pdfHighlightProjectionPayloadBytes } from "./ReaderDecorations";
import type { PdfHighlightOut, PdfHighlightPaint } from "./ReaderDecorations";
import { readerSourceRangeInputBytes } from "./ReaderDocumentSource";
import type {
  ReaderDocumentSource,
  ReaderMedia,
  ResolvedPdfDocument,
  ReaderPublicationFindQuery, ReaderPublicationOverlayRequest, ReaderPublicationOverlayPage,
} from "./ReaderDocumentSource";
import type {
  ReaderProgressPort,
  ReaderProgressView,
} from "./ReaderProgressPort";

export interface LeasedReaderUnit {
  readonly kind: "Unit";
  readonly address: ReaderPublicationUnitAddress;
  /** Borrow while its unit lease is live; the handle clears on final release. */
  readonly unit: ReaderPublicationUnit;
}

export type ReaderViewCapacity = { readonly kind: "Capacity"; readonly reason: ReaderCapacityReason };
export interface ReaderUnitLease {
  readonly address: ReaderPublicationUnitAddress;
  readonly promise: Promise<LeasedReaderUnit | ReaderViewCapacity>;
  readonly pinned: boolean;
  readonly released: boolean;
  pin(reason: "Selection" | "Focus" | "Interaction", pinned: boolean): void;
  /** Keep this exact source/root stable through one navigation command. */
  holdNavigation(): () => void;
  release(): boolean;
}
export type ReaderViewUnit = { readonly kind: "Acquired"; readonly lease: ReaderUnitLease } | ReaderViewCapacity;

export type LoadedReaderDocument =
  | {
      readonly kind: "WebArticle" | "Epub";
      readonly descriptor: ReaderMedia;
      readonly initial: ReaderPublicationTarget;
    }
  | { readonly kind: "Pdf"; readonly descriptor: ReaderMedia; readonly document: ResolvedPdfDocument };

export interface LoadedDocumentReaderSession {
  readonly document: LoadedReaderDocument;
  readonly progress: ReaderProgressView;
}
export type ReaderSessionLoad = LoadedDocumentReaderSession | ReaderViewCapacity;

export interface ReaderIndexLease { readonly page: ReaderPublicationIndex; release(): void }
export type ReaderFindResult =
  | { readonly kind: "Ready"; readonly occurrences: ReaderPublicationFindPage["occurrences"] }
  | { readonly kind: "TooManyMatches"; readonly threshold: typeof READER_PUBLICATION_FIND_MATCH_LIMIT };
export interface ReaderSourceRangeLease {
  /** Reserve the next exact visible rectangle before materializing its DOM. */
  reservePulseRect(): ReaderViewCapacity | null;
  readonly result: ReaderPublicationSourceRangeResolution | Extract<ReaderPublicationResolution, { kind: "Unresolved" }>;
  release(): void;
}
export interface ReaderSectionContextLease { readonly context: ReaderPublicationSectionContext; readonly released: boolean; release(): void }
export interface ReaderFindLease<T> { readonly result: T; release(): void }
export interface ReaderFindProjection<T> {
  /** Size one bounded row at a time under the retained read scratch. */
  bytes(result: ReaderFindResult): number;
  create(result: ReaderFindResult): T;
}
export type ReaderOverlayRequest =
  | { readonly kind: "Embeds"; readonly unit: LeasedReaderUnit & { readonly lease: ReaderUnitLease } }
  | { readonly kind: "Highlights"; readonly unit: LeasedReaderUnit & { readonly lease: ReaderUnitLease }; readonly mine_only: boolean }
  | Exclude<ReaderPublicationOverlayRequest, { kind: "Embeds" | "Highlights" | "PdfHighlights" | "EvidenceGutter" }>;
type ReaderOverlayValidation =
  | { readonly kind: "Embeds"; readonly fragmentId: string; readonly occurrences: readonly ReturnType<typeof overlayOccurrence>[] }
  | { readonly kind: "Highlights"; readonly start: number; readonly end: number; readonly length: number };
function overlayOccurrence(source: DocumentEmbedSource) {
  return { id: source.id, ordinal: source.ordinal, key: source.occurrence_key,
    start: source.canonical_start_offset, end: source.canonical_end_offset,
    targetMediaId: source.target.kind === "materialized" ? source.target.media_id : null };
}
export type ReaderOverlayResult =
  | { readonly kind: "Embeds"; readonly items: readonly DocumentEmbed[] }
  | { readonly kind: "Highlights"; readonly items: readonly ReaderPublicationHighlightPaint[] }
  | Exclude<ReaderPublicationOverlayPage, { kind: "Embeds" | "Highlights" | "PdfHighlights" }>;
export interface ReaderOverlayLease { readonly result: ReaderOverlayResult; release(): void }
export interface ReaderPdfPaintLease {
  readonly page: Omit<ReaderPublicationPdfHighlightsPage, "next_cursor">;
  /** Payload for both old/new rect projections; JS/DOM allocator overhead is measured separately. */
  readonly projectionPayloadBytes: number;
  readonly domNodes: number;
  readonly released: boolean;
  /** The leaf holds its exact committed projection through overlay DOM retirement. */
  retain(): () => void;
  /** Withdraw the query or acknowledged-write owner's desired result. */
  release(): void;
}
export interface ReaderDomLease {
  /** Reserve additions before a projection mutates its admitted nodes. */
  extend(nodes: number): boolean;
  release(): void;
}

export interface DocumentReaderSession {
  load(signal: AbortSignal, targets: { readonly fresh: ReaderPublicationTarget | null; readonly cold: ReaderPublicationTarget | null }): Promise<ReaderSessionLoad>;
  acquireUnit(address: ReaderPublicationUnitAddress): ReaderViewUnit;
  reserveDomNodes(nodes: number): ReaderDomLease | null;
  resolve(target: ReaderPublicationTarget, signal: AbortSignal): Promise<ReaderPublicationResolution | ReaderViewCapacity>;
  pdfSourceLocation(locator: Extract<RetrievalLocator, { type: "pdf_page_geometry" }>): { readonly kind: "Acquired"; readonly lease: { readonly location: { readonly page: number; readonly quads: readonly PdfHighlightQuad[] }; release(): void } } | ReaderViewCapacity | { readonly kind: "Unavailable" };
  readonly sourceRange: ((locator: ReaderPublicationSourceRangeTarget["locator"], signal: AbortSignal) => Promise<{ readonly kind: "Acquired"; readonly lease: ReaderSourceRangeLease } | ReaderViewCapacity>) | null;
  readonly sectionContext: ((locator: Extract<ReaderResumeState, { kind: "web" | "epub" }>, signal: AbortSignal) => Promise<{ readonly kind: "Acquired"; readonly lease: ReaderSectionContextLease } | ReaderViewCapacity>) | null;
  readonly find: (<T>(query: Omit<ReaderPublicationFindQuery, "after">, signal: AbortSignal, projection: ReaderFindProjection<T>) => Promise<{ readonly kind: "Acquired"; readonly lease: ReaderFindLease<T> } | ReaderViewCapacity>) | null;
  readonly overlays: ((query: ReaderOverlayRequest, signal: AbortSignal) => Promise<{ readonly kind: "Acquired"; readonly lease: ReaderOverlayLease } | ReaderViewCapacity>) | null;
  readonly gutter: ((query: Omit<ReaderPublicationEvidenceGutterRequest, "window"> & { readonly readWindow: (maxBytes: number) => ReaderGutterWindow | null }, signal: AbortSignal) => Promise<{ readonly kind: "Acquired"; readonly lease: { readonly page: ReaderPublicationEvidenceGutterPage; release(): void } } | ReaderViewCapacity>) | null;
  readonly pdfHighlights: ((query: { readonly page_number: number; readonly mine_only: boolean }, signal: AbortSignal) => Promise<{ readonly kind: "Acquired"; readonly lease: ReaderPdfPaintLease } | ReaderViewCapacity>) | null;
  adoptPdfHighlight(highlight: PdfHighlightOut): { readonly kind: "Acquired"; readonly lease: ReaderPdfPaintLease } | ReaderViewCapacity;
  readIndex(reference: ReaderMemberRef, signal: AbortSignal): Promise<ReaderIndexLease | ReaderViewCapacity>;
  /** The authorized URL for an archived member of the selected generation. */
  memberAssetUrl(reference: ReaderMemberRef): string;
  openPdf(signal: AbortSignal): Promise<ResolvedPdfDocument>;
  close(): void;
  readonly progress: ReaderProgressPort;
  readonly capacity: ReaderCapacity;
  /** Primitive payload/DOM; leases counts units and index/find/overlay entries, excluding resolve/context metadata. */
  readonly residency: { readonly payloadBytes: number; readonly domNodes: number; readonly leases: number };
}

/**
 * The reader leaves' async-input contract: a structural subset of the one
 * async-resource hook's `AsyncResource` states (`@/lib/api/useResource`
 * produces these). Hosts pass resources straight through; `retry`, when
 * present, re-runs the owning load under its single invalidation identity.
 * The lowercase discriminators deliberately mirror `AsyncResource` so no
 * mapping layer exists between the owner hook and the leaves.
 */
export type ReaderResource<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | {
      readonly status: "error";
      readonly error: unknown;
      readonly retry?: () => void;
    };

export function buildTextReaderLocatorAtOffset({
  anchorOffset,
  canonicalText,
  fragmentId,
  format,
  fragmentStartOffset,
  fragmentLength,
  documentStartOffset,
  documentLength,
  isFinalUnit,
  epubSection,
  epubAnchorId,
  positionBucketCodePoints,
}: {
  readonly anchorOffset: number;
  readonly canonicalText: string;
  readonly fragmentId: string;
  readonly format: "web" | "epub" | "transcript";
  /** Original fragment coordinate of canonicalText[0]. */
  readonly fragmentStartOffset: number;
  readonly fragmentLength: number;
  /** Original fragment's prefix in the full document, without artificial separators. */
  readonly documentStartOffset: number;
  readonly documentLength: number;
  readonly isFinalUnit: boolean;
  readonly epubSection: { readonly section_id: string; readonly href_path: string | null } | null;
  readonly epubAnchorId: string | null;
  readonly positionBucketCodePoints: number;
}): ReaderResumeState | null {
  const quoteWindow = buildCanonicalQuoteWindow(canonicalText, anchorOffset);
  const activeLength = canonicalCpLength(canonicalText);
  const fragmentOffset = fragmentStartOffset + anchorOffset;
  const absoluteOffset = documentStartOffset + fragmentOffset;
  const terminal = isFinalUnit && anchorOffset === activeLength;
  const locations = {
    text_offset: fragmentOffset,
    progression: terminal
      ? 1
      : fragmentLength > 0
        ? Math.min(1, fragmentOffset / fragmentLength)
        : 0,
    total_progression: terminal
      ? 1
      : documentLength > 0
        ? Math.min(1, absoluteOffset / documentLength)
        : 0,
    position: Math.floor(absoluteOffset / positionBucketCodePoints) + 1,
  };
  const text = {
    quote: quoteWindow.quote,
    quote_prefix: quoteWindow.quotePrefix,
    quote_suffix: quoteWindow.quoteSuffix,
  };
  if (format === "epub") {
    if (epubSection?.href_path === null || epubSection === null) return null;
    return {
      kind: "epub",
      target: {
        section_id: epubSection.section_id,
        href_path: epubSection.href_path,
        anchor_id: epubAnchorId,
      },
      locations,
      text,
    };
  }
  return {
    kind: format,
    target: { fragment_id: fragmentId },
    locations,
    text,
  };
}

export function preferredReaderLocator(view: ReaderProgressView, selectedSource: SelectedReaderSource): ReaderResumeState | null {
  if (view.kind === "Canonical") {
    return view.snapshot.state === "Positioned" && readerCursorSourcesEqual(view.snapshot.source, selectedSource)
      ? view.snapshot.locator : null;
  }
  return readerCursorSourcesEqual(view.source, selectedSource) ? view.device : null;
}

/** One view owns these leases; shared bytes belong to the resource cache. */
export function createDocumentReaderSession({ mediaId, source, progress, capacity }: {
  readonly mediaId: string;
  readonly source: ReaderDocumentSource;
  readonly progress: ReaderProgressPort;
  readonly capacity: ReaderCapacity;
}): DocumentReaderSession {
  const readFind = source.find === null ? null : source.find.bind(source);
  const readSourceRange = source.sourceRange === null ? null : source.sourceRange.bind(source);
  const readContext = source.sectionContext === null ? null : source.sectionContext.bind(source);
  const readOverlay = source.overlays === null ? null : source.overlays.bind(source);
  let descriptor: ReaderMedia | null = null;
  let closed = false;
  let payloadBytes = capacity.descriptorBytes * READER_DECODE_RESERVATION_FACTOR;
  let domNodes = 0;
  type UnitEntry = {
    readonly lease: ReaderUnitLease;
    readonly pins: Set<"Selection" | "Focus" | "Interaction">;
    navigationHolds: number;
    payloadBytes: number;
    pending: boolean;
    released: boolean;
  };
  const ownedUnits = new Set<UnitEntry>();
  interface ReadEntry {
    readonly kind: "Index" | "Find" | "Resolve" | "Context" | "Overlay";
    readonly controller: AbortController;
    published: boolean;
    pending: boolean;
    released: boolean;
    bytes: number;
    resize(bytes: number): boolean;
    release(): void;
  }
  const reads = new Set<ReadEntry>();
  // Content residency and query/decoration leases are separate pools: a
  // highlight or embed lease taken for a resident unit must never deny the
  // reader the next unit of text. Constant-cardinality address metadata
  // (resolve/context) still reserves payload and shares physical read
  // admission, but holds no lease in either pool.
  const queryLeaseCount = () => [...reads].filter((entry) => entry.kind !== "Resolve" && entry.kind !== "Context").length;
  function reserveRead(kind: ReadEntry["kind"], bytes: number): ReadEntry | ReaderViewCapacity {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Reader query scratch must be a positive derived bound");
    if (kind !== "Resolve" && kind !== "Context" && queryLeaseCount() >= capacity.view.maxQueryLeases) return { kind: "Capacity", reason: "Leases" };
    if (payloadBytes + bytes > capacity.view.maxPayloadBytes) return { kind: "Capacity", reason: "Payload" };
    const entry: ReadEntry = {
      kind, controller: new AbortController(), bytes, published: false, pending: true, released: false,
      resize(next) {
        if (entry.released) throw new Error("Cannot resize a retired reader query");
        if (payloadBytes + next - entry.bytes > capacity.view.maxPayloadBytes) return false;
        payloadBytes += next - entry.bytes;
        entry.bytes = next;
        return true;
      },
      release() {
        if (entry.released) return;
        entry.released = true;
        entry.controller.abort();
        if (!entry.pending) { reads.delete(entry); payloadBytes -= entry.bytes; }
      },
    };
    reads.add(entry); payloadBytes += bytes;
    return entry;
  }
  function settleRead(entry: ReadEntry) {
    entry.pending = false;
    if (entry.released) { reads.delete(entry); payloadBytes -= entry.bytes; }
  }

  function retainPdfPaint(entry: ReadEntry, page: ReaderPdfPaintLease["page"]): { readonly kind: "Acquired"; readonly lease: ReaderPdfPaintLease } | ReaderViewCapacity {
    let projectionPayloadBytes = 0;
    let rectangles = 0;
    for (const highlight of page.highlights) {
      projectionPayloadBytes += pdfHighlightProjectionPayloadBytes(highlight.id, highlight.color, highlight.quads.length);
      rectangles += highlight.quads.length;
    }
    if (!entry.resize(publicationPayloadBytes(page) + projectionPayloadBytes)) {
      entry.release(); return { kind: "Capacity", reason: "Payload" };
    }
    const nodes = rectangles === 0 ? 0 : rectangles + 1;
    if (domNodes + nodes > capacity.view.maxDomNodes) {
      entry.release(); return { kind: "Capacity", reason: "Dom" };
    }
    domNodes += nodes;
    let retainedPage: ReaderPdfPaintLease["page"] | null = page;
    let consumers = 1;
    let desired = true;
    const release = () => {
      consumers -= 1;
      if (consumers !== 0) return;
      retainedPage = null;
      domNodes -= nodes;
      entry.release();
    };
    entry.published = true;
    return { kind: "Acquired", lease: {
      get page() { if (retainedPage === null) throw new Error("PDF paint lease has retired"); return retainedPage; },
      projectionPayloadBytes, domNodes: nodes, get released() { return consumers === 0; },
      retain() {
        if (consumers === 0) throw new Error("PDF paint lease has retired");
        consumers += 1;
        let current = true;
        return () => { if (current) { current = false; release(); } };
      },
      release() { if (desired) { desired = false; release(); } },
    } };
  }

  function selected(): ReaderMedia {
    if (closed) throw new Error("Reader session is closed");
    if (descriptor === null) throw new Error("Reader publication has not been selected");
    return descriptor;
  }

  async function resolve(target: ReaderPublicationTarget, signal: AbortSignal): Promise<ReaderPublicationResolution | ReaderViewCapacity> {
    const publication = selected();
    const entry = reserveRead("Resolve", source.queryScratchBytes);
    if (entry.kind === "Capacity") return entry;
    const boundary = AbortSignal.any([signal, entry.controller.signal]);
    try {
      // One request, one answer: resolution has no continuation to walk.
      const result = await requestWithRetry((attemptSignal) => source.resolve(publication, target, attemptSignal), boundary);
      if (result.kind === "Incomplete") throw new Error("Reader resolution returned a retired continuation");
      return result;
    } finally { entry.release(); settleRead(entry); }
  }

  function acquireUnit(address: ReaderPublicationUnitAddress): ReaderViewUnit {
    const publication = selected();
    if (ownedUnits.size >= capacity.view.maxUnits) return { kind: "Capacity", reason: "Leases" };
    const reservation = address.unit_ref.bytes * READER_DECODE_RESERVATION_FACTOR;
    if (payloadBytes + reservation > capacity.view.maxPayloadBytes) return { kind: "Capacity", reason: "Payload" };
    const acquired = source.acquireUnit(publication, address.unit_ref);
    if (acquired.kind === "Capacity") return acquired;
    payloadBytes += reservation;
    let retainedUnit: ReaderPublicationUnit | null = null;
    const entry: UnitEntry = {
      pins: new Set<"Selection" | "Focus" | "Interaction">(), navigationHolds: 0, payloadBytes: reservation,
      pending: true, released: false,
      lease: {
        address,
        get pinned() { return entry.pins.size > 0 || entry.navigationHolds > 0; },
        get released() { return entry.released; },
        promise: acquired.lease.promise.then((settled): LeasedReaderUnit | ReaderViewCapacity => {
          if (closed || entry.released) throw new DOMException("Reader unit released", "AbortError");
          if (settled.kind === "Capacity") { entry.lease.release(); return settled; }
          const retained = publicationPayloadBytes(settled.unit);
          payloadBytes += retained - entry.payloadBytes;
          entry.payloadBytes = retained;
          retainedUnit = settled.unit;
          return { kind: "Unit", address, get unit() {
            if (retainedUnit === null) throw new Error("Reader unit source has retired");
            return retainedUnit;
          } };
        }).catch((error: unknown) => {
          entry.pins.clear();
          entry.lease.release();
          throw error;
        }).finally(() => {
          entry.pending = false;
          if (entry.released) {
            ownedUnits.delete(entry);
            payloadBytes -= entry.payloadBytes;
          }
        }),
        pin(reason, pinned) {
          if (entry.released) {
            if (pinned) throw new Error("Cannot pin a released reader unit");
            return;
          }
          if (pinned) entry.pins.add(reason);
          else entry.pins.delete(reason);
        },
        holdNavigation() {
          if (closed || entry.released) throw new DOMException("Reader unit retired", "AbortError");
          entry.navigationHolds += 1;
          let held = true;
          return () => {
            if (!held) return;
            held = false;
            entry.navigationHolds -= 1;
            if (closed) entry.lease.release();
          };
        },
        release() {
          if (entry.released) return true;
          if (entry.pins.size !== 0 || entry.navigationHolds > 0) return false;
          entry.released = true;
          retainedUnit = null;
          if (!entry.pending) {
            ownedUnits.delete(entry);
            payloadBytes -= entry.payloadBytes;
          }
          acquired.lease.release();
          return true;
        },
      },
    };
    ownedUnits.add(entry);
    return { kind: "Acquired", lease: entry.lease };
  }

  function reserveDomNodes(nodes: number): ReaderDomLease | null {
      if (closed) throw new Error("Reader session is closed");
      if (!Number.isSafeInteger(nodes) || nodes < 1) throw new Error("Reader DOM reservation must be positive");
      if (domNodes + nodes > capacity.view.maxDomNodes) return null;
      domNodes += nodes;
      let reserved = nodes;
      let released = false;
      return {
        extend(additional) {
          if (closed || released) throw new Error("Reader DOM lease is closed");
          if (!Number.isSafeInteger(additional) || additional < 0) throw new Error("Reader DOM addition must be nonnegative");
          if (domNodes + additional > capacity.view.maxDomNodes) return false;
          domNodes += additional;
          reserved += additional;
          return true;
        },
        release() {
          if (released) return;
          released = true;
          domNodes -= reserved;
        },
      };
    }
  function admitPdfLocation(entry: ReadEntry, retainedBytes: number, quadCount: number): ReaderDomLease | ReaderViewCapacity {
    const projectionBytes = pdfHighlightProjectionPayloadBytes(`${PDF_PULSE_KEY_PREFIX}${Number.MAX_SAFE_INTEGER}`, "yellow", quadCount);
    if (!entry.resize(retainedBytes + projectionBytes)) return { kind: "Capacity", reason: "Payload" };
    return reserveDomNodes(quadCount + 1) ?? { kind: "Capacity", reason: "Dom" };
  }

  async function openPdf(signal: AbortSignal): Promise<ResolvedPdfDocument> {
    signal.throwIfAborted();
    const publication = selected();
    if (publication.kind !== "pdf") throw new Error("Selected publication is not a PDF");
    return { url: source.assetUrl(publication, publication.document_asset_ref) };
  }

  return {
    progress, capacity,
    get residency() { return { payloadBytes, domNodes, leases: ownedUnits.size + queryLeaseCount() }; },
    async load(signal, targets) {
        signal.throwIfAborted();
        if (descriptor === null) {
          // The composed load is the single retry owner; the memo below keeps a
          // retried composed load from re-reading a descriptor it already holds.
          const candidate = await source.loadDescriptor(mediaId, signal);
          signal.throwIfAborted();
          if (candidate.kind === "Capacity") return candidate;
          descriptor ??= candidate;
        }
        const publication = selected();
        progress.bindSource(mediaId, publication.source);
        const view = await progress.load(mediaId, signal);
        signal.throwIfAborted();
        if (publication.kind === "pdf") {
          return { document: { kind: "Pdf", descriptor: publication, document: await openPdf(signal) }, progress: view };
        }
        const locator = preferredReaderLocator(view, publication.source);
        const initial: ReaderPublicationTarget = targets.fresh ?? (locator === null
          ? targets.cold ?? { kind: "Unit", unit_key: publication.first_unit_ref.key }
          : { kind: "Locator", locator });
        signal.throwIfAborted();
        return {
          document: { kind: publication.kind === "epub" ? "Epub" : "WebArticle", descriptor: publication, initial },
          progress: view,
        };
    },
    acquireUnit,
    reserveDomNodes,
    resolve,
    find: readFind === null ? null : async (query, signal, project) => {
      const publication = selected();
      const scratch = source.queryScratchBytes;
      const entry = reserveRead("Find", scratch);
      if (entry.kind === "Capacity") return entry;
      try {
        const completed = await (async () => {
          const occurrences: ReaderPublicationFindPage["occurrences"][number][] = [];
          let retained = 0;
          let after: string | null = null;
          const boundary = AbortSignal.any([signal, entry.controller.signal]);
          // One retry owner per page: the collector and its payload reservation
          // are only advanced after a page's retry boundary has returned.
          let result: ReaderFindResult | ReaderViewCapacity | null = null;
          while (result === null) {
            const page = await requestWithRetry((attemptSignal) => readFind(publication, { ...query, after }, attemptSignal), boundary);
            if ("kind" in page) { result = page; continue; }
            for (const occurrence of page.occurrences) {
              const previous = occurrences.at(-1);
              if (previous !== undefined && (occurrence.fragment_idx < previous.fragment_idx ||
                (occurrence.fragment_idx === previous.fragment_idx && (occurrence.fragment_id !== previous.fragment_id || occurrence.start_offset <= previous.start_offset)))) {
                throw new Error("Reader find pages repeat or reorder a source match");
              }
              if (occurrences.length === READER_PUBLICATION_FIND_MATCH_LIMIT) { result = { kind: "TooManyMatches", threshold: READER_PUBLICATION_FIND_MATCH_LIMIT }; break; }
              const next = retained + publicationPayloadBytes(occurrence);
              if (!entry.resize(scratch + next)) { result = { kind: "Capacity", reason: "Payload" }; break; }
              retained = next;
              occurrences.push(occurrence);
            }
            if (result !== null) continue;
            if (page.next_cursor === null) { result = { kind: "Ready", occurrences }; continue; }
            if (page.next_cursor === after) throw new Error("Reader find continuation did not advance");
            after = page.next_cursor;
          }
          if (result.kind !== "Ready") occurrences.length = 0;
          if (result.kind === "Capacity") return result;
          const resultBytes = publicationPayloadBytes(result);
          const projectedBytes = project.bytes(result);
          if (!Number.isSafeInteger(projectedBytes) || projectedBytes < 0) throw new Error("Reader find projection requires a nonnegative payload bound");
          if (!entry.resize(scratch + resultBytes + projectedBytes)) return { kind: "Capacity" as const, reason: "Payload" as const };
          const projection = project.create(result);
          if (publicationPayloadBytes(projection) > projectedBytes) throw new Error("Reader find projection exceeded its reserved payload");
          return { kind: "Projected" as const, value: projection };
        })();
        if (completed.kind === "Capacity") { entry.release(); return completed; }
        // The collector's storage has left scope; only the final projection is retained.
        if (!entry.resize(publicationPayloadBytes(completed.value))) throw new Error("Reader find result exceeded its admitted reduction");
        entry.published = true;
        return { kind: "Acquired", lease: { result: completed.value, release: entry.release } };
      } catch (error) {
        entry.release();
        throw error;
      } finally { settleRead(entry); }
    },
    pdfSourceLocation(locator) {
      const publication = selected();
      if (publication.kind !== "pdf" || locator.media_id !== publication.media_id ||
          locator.source_sha256 == null || locator.source_sha256 !== publication.document_asset_ref.sha256 ||
          locator.page_number > publication.page_count) return { kind: "Unavailable" };
      const bytes = publicationPayloadBytes(locator);
      const entry = reserveRead("Resolve", bytes * 2);
      if (entry.kind === "Capacity") return entry;
      try {
        const location = { page: locator.page_number, quads: locator.quads.map((quad) => decodePdfHighlightQuad(quad, "Cited PDF quad")) };
        const dom = admitPdfLocation(entry, bytes + publicationPayloadBytes(location), location.quads.length);
        if ("kind" in dom) { entry.release(); return dom; }
        let retained: typeof location | null = location;
        entry.published = true;
        return { kind: "Acquired", lease: {
          get location() { if (retained === null) throw new Error("PDF source location has retired"); return retained; },
          release() { retained = null; dom.release(); entry.release(); },
        } };
      } catch (error) { entry.release(); throw error; }
      finally { settleRead(entry); }
    },
    sourceRange: readSourceRange === null ? null : async (locator, signal) => {
      const publication = selected();
      // The fixed locator vocabulary has a small wrapper. Six-byte JSON string
      // escapes are at most three times the primitive UTF-16 payload model.
      const inputBytes = readerSourceRangeInputBytes(locator);
      if (inputBytes > capacity.indexBytes) return { kind: "Capacity", reason: "Payload" };
      const entry = reserveRead("Resolve", source.queryScratchBytes + inputBytes * 3);
      if (entry.kind === "Capacity") return entry;
      try {
        const result = await requestWithRetry((attemptSignal) => readSourceRange(publication, locator, attemptSignal),
          AbortSignal.any([signal, entry.controller.signal]));
        if (result.kind === "Capacity") { entry.release(); return result; }
        if (!entry.resize(publicationPayloadBytes(locator) + publicationPayloadBytes(result))) throw new Error("Source range exceeded its admitted representation");
        let retained: ReaderSourceRangeLease["result"] | null = result;
        let pulseDom: ReaderDomLease | null = null;
        entry.published = true;
        return { kind: "Acquired", lease: {
          get result() { if (retained === null) throw new Error("Source range lease has retired"); return retained; },
          reservePulseRect() {
            if (retained === null || retained.kind !== "SourceRange") throw new Error("Cannot project a retired or unresolved source range");
            const previousBytes = entry.bytes;
            if (!entry.resize(previousBytes + publicationPayloadBytes({ left: 0, top: 0, width: 0, height: 0 }))) return { kind: "Capacity", reason: "Payload" };
            const admitted = pulseDom === null ? (pulseDom = reserveDomNodes(1)) !== null : pulseDom.extend(1);
            if (!admitted) { entry.resize(previousBytes); return { kind: "Capacity", reason: "Dom" }; }
            return null;
          },
          release() { retained = null; pulseDom?.release(); pulseDom = null; entry.release(); },
        } };
      } catch (error) { entry.release(); throw error; }
      finally { settleRead(entry); }
    },
    sectionContext: readContext === null ? null : async (locator, signal) => {
      const publication = selected();
      const entry = reserveRead("Context", source.queryScratchBytes);
      if (entry.kind === "Capacity") return entry;
      try {
        const context = await requestWithRetry((attemptSignal) => readContext(publication, locator, attemptSignal),
          AbortSignal.any([signal, entry.controller.signal]));
        if ("kind" in context) { entry.release(); return context; }
        if (!entry.resize(publicationPayloadBytes(context))) throw new Error("Reader section context exceeded its admitted representation");
        entry.published = true;
        let retained: ReaderPublicationSectionContext | null = context;
        return { kind: "Acquired", lease: {
          get context() { if (retained === null) throw new Error("Reader section context has retired"); return retained; },
          get released() { return retained === null; },
          release() { retained = null; entry.release(); },
        } };
      } catch (error) { entry.release(); throw error; }
      finally { settleRead(entry); }
    },
    gutter: readOverlay === null ? null : async ({ readWindow, ...query }, signal) => {
      const publication = selected();
      // Local source coordinates and the wire wrapper share interval arrays.
      // Reserve their primitive payload plus JSON text/bytes and response decode
      // before the synchronous viewport projection or any physical read.
      const entry = reserveRead("Overlay", source.queryScratchBytes + capacity.indexBytes * 5);
      if (entry.kind === "Capacity") return entry;
      let snapshot: ReaderGutterWindow | null = null;
      let request: ReaderPublicationOverlayRequest | null = null;
      try {
        signal.throwIfAborted();
        const fixed = { window: null, kinds: query.kinds, include_stances: query.include_stances, after: query.after, limit: query.limit };
        const available = capacity.indexBytes - new TextEncoder().encode(JSON.stringify(fixed)).byteLength;
        snapshot = readWindow(available);
        readWindow = () => null;
        if (snapshot === null) { entry.release(); return { kind: "Capacity", reason: "Payload" }; }
        const window = snapshot.kind === "Pdf" ? snapshot : { kind: "Text" as const,
          units: snapshot.units.map(({ unit_key, ranges }) => ({ unit_key, ranges })) };
        request = { kind: "EvidenceGutter", request: { ...fixed, window } };
        const result = await requestWithRetry((attemptSignal) => {
          if (request === null) throw new Error("Gutter request has retired");
          return readOverlay(publication, request, attemptSignal);
        }, AbortSignal.any([signal, entry.controller.signal]));
        if (result.kind === "Capacity") { entry.release(); return result; }
        if (result.kind !== "EvidenceGutter") throw new Error("Gutter received another query result");
        for (const item of result.page.items) {
          const location = item.location;
          if (location.kind === "Text") {
            const range = location.range;
            const point = range.start_cp === range.end_cp;
            if (snapshot.kind !== "Text" || !snapshot.units.some((unit) => unit.fragment_id === range.fragment_id &&
              (point ? unit.unit_key === range.unit_key && (unit.ranges.length === 0 || unit.ranges.some(([start, end]) => start <= range.start_cp && range.start_cp <= end))
                : unit.ranges.some(([start, end]) => start < range.end_cp && range.start_cp < end)))) throw new Error("Gutter range escaped its visible source window");
          } else {
            if (snapshot.kind !== "Pdf" || publication.kind !== "pdf" || location.source_sha256 !== publication.document_asset_ref.sha256 ||
              location.page > publication.page_count || !snapshot.pages.some(({ page, rect }) => page === location.page &&
                (location.kind === "PdfPage" || location.quads.some((quad) =>
                  Math.max(quad.x1, quad.x2, quad.x3, quad.x4) > rect.left && Math.min(quad.x1, quad.x2, quad.x3, quad.x4) < rect.right &&
                  Math.max(quad.y1, quad.y2, quad.y3, quad.y4) > rect.top && Math.min(quad.y1, quad.y2, quad.y3, quad.y4) < rect.bottom)))) throw new Error("Gutter geometry escaped its selected PDF viewport");
          }
        }
        snapshot = null; request = null;
        // The bounded row placer holds source ids, desired/final tops and heights.
        const projectionBytes = result.page.items.reduce((bytes, item) => bytes + publicationPayloadBytes({ id: item.id, desiredTop: 0, top: 0, height: 0 }), 0);
        if (!entry.resize(publicationPayloadBytes(result.page) + projectionBytes)) { entry.release(); return { kind: "Capacity", reason: "Payload" }; }
        entry.published = true;
        return { kind: "Acquired", lease: { page: result.page, release: () => entry.release() } };
      } catch (error) { entry.release(); throw error; }
      finally { readWindow = () => null; snapshot = null; request = null; settleRead(entry); }
    },
    pdfHighlights: readOverlay === null ? null : (query, signal) => {
      signal.throwIfAborted();
      const publication = selected();
      if (publication.kind !== "pdf" || query.page_number < 1 || query.page_number > publication.page_count) {
        throw new Error("PDF paint requires a page of the selected document");
      }
      const entry = reserveRead("Overlay", source.queryScratchBytes);
      if (entry.kind === "Capacity") return Promise.resolve(entry);
      const highlights: PdfHighlightPaint[] = [];
      const identities = new Set<string>();
      let retainedBytes = publicationPayloadBytes({ kind: "PdfHighlights", page: {
        page_number: query.page_number, source_sha256: publication.document_asset_ref.sha256, highlights: [],
      } });
      let identityBytes = 0;
      let next: Extract<ReaderPublicationOverlayRequest, { kind: "PdfHighlights" }> = { kind: "PdfHighlights",
        request: { page_number: query.page_number, mine_only: query.mine_only, after: null, limit: 100 } };
      const boundary = AbortSignal.any([signal, entry.controller.signal]);
      // One retry owner per page: the paint collector, its identities and its
      // payload reservation advance only after a page's boundary has returned.
      return (async (): Promise<Omit<ReaderPublicationPdfHighlightsPage, "next_cursor"> | ReaderViewCapacity> => {
        for (;;) {
          const result = await requestWithRetry((attemptSignal) => readOverlay(publication, next, attemptSignal), boundary);
          if (result.kind === "Capacity") return result;
          if (result.kind !== "PdfHighlights" || result.page.page_number !== query.page_number ||
              result.page.source_sha256 !== publication.document_asset_ref.sha256) {
            throw new Error("PDF paint escaped its selected document page");
          }
          const additional = publicationPayloadBytes(result.page.highlights);
          const additionalIdentities = result.page.highlights.reduce((bytes, item) => bytes + item.id.length * 2, 0);
          if (!entry.resize(source.queryScratchBytes + retainedBytes + additional + identityBytes + additionalIdentities)) {
            return { kind: "Capacity", reason: "Payload" };
          }
          retainedBytes += additional;
          identityBytes += additionalIdentities;
          for (const highlight of result.page.highlights) {
            if (identities.has(highlight.id)) throw new Error("PDF paint repeats a highlight");
            identities.add(highlight.id); highlights.push(highlight);
          }
          if (result.page.next_cursor === null) return { page_number: query.page_number, source_sha256: result.page.source_sha256, highlights };
          if (result.page.highlights.length === 0 || result.page.next_cursor === next.request.after) {
            throw new Error("PDF paint continuation did not advance");
          }
          next = { kind: next.kind, request: { ...next.request, after: result.page.next_cursor } };
        }
      })().then((result) => {
        if ("kind" in result) { entry.release(); return result; }
        return retainPdfPaint(entry, result);
      }).catch((error: unknown) => { entry.release(); throw error; }).finally(() => settleRead(entry));
    },
    adoptPdfHighlight(highlight) {
      const publication = selected();
      if (publication.kind !== "pdf" || highlight.anchor.media_id !== publication.media_id ||
          highlight.anchor.source_sha256 !== publication.document_asset_ref.sha256 ||
          highlight.anchor.page_number < 1 || highlight.anchor.page_number > publication.page_count) {
        throw new Error("Acknowledged PDF paint belongs to another document source");
      }
      const paint = { id: highlight.id, color: highlight.color, created_at: highlight.created_at,
        author_user_id: highlight.author_user_id, is_owner: highlight.is_owner, quads: highlight.anchor.quads };
      const page = { page_number: highlight.anchor.page_number, source_sha256: highlight.anchor.source_sha256, highlights: [paint] };
      const entry = reserveRead("Overlay", publicationPayloadBytes(page));
      if (entry.kind === "Capacity") return entry;
      try { return retainPdfPaint(entry, page); }
      finally { settleRead(entry); }
    },
    overlays: readOverlay === null ? null : (query, signal) => {
      signal.throwIfAborted();
      const publication = selected();
      if (query.kind !== "Embeds" && query.kind !== "Highlights") {
        const entry = reserveRead("Overlay", source.queryScratchBytes);
        if (entry.kind === "Capacity") return Promise.resolve(entry);
        return requestWithRetry((attemptSignal) => readOverlay(publication, query, attemptSignal),
          AbortSignal.any([signal, entry.controller.signal])).then((result) => {
          if (result.kind === "Capacity") { entry.release(); return result; }
          if (result.kind === "Embeds" || result.kind === "Highlights" || result.kind === "PdfHighlights" || result.kind !== query.kind) throw new Error("Reader overlay response changed its requested kind");
          let locationDom: ReaderDomLease | null = null;
          const geometry = result.kind === "ApparatusLocation" && result.page.kind === "Pdf" ? result.page
            : result.kind === "EvidenceLocation" && result.page.location.kind === "PdfGeometry" ? result.page.location : null;
          if (result.kind === "EvidenceLocation") {
            const location = result.page.location;
            if ((location.kind === "PdfGeometry" || location.kind === "PdfPage") && (publication.kind !== "pdf" ||
                location.source_sha256 !== publication.document_asset_ref.sha256 || location.page > publication.page_count)) throw new Error("Evidence geometry escaped its selected PDF");
            if (location.kind === "Text" && publication.kind === "pdf") throw new Error("PDF evidence returned a text source");
          }
          if (geometry !== null) {
            if (publication.kind !== "pdf" || geometry.page > publication.page_count) throw new Error("Source-note geometry escaped its selected PDF");
            const admitted = admitPdfLocation(entry, publicationPayloadBytes(result), geometry.quads.length);
            if ("kind" in admitted) { entry.release(); return admitted; }
            locationDom = admitted;
          } else if (!entry.resize(publicationPayloadBytes(result))) {
            entry.release(); return { kind: "Capacity", reason: "Payload" } as const;
          }
          entry.published = true;
          let retained = true;
          return { kind: "Acquired" as const, lease: { result, release() {
            if (!retained) return;
            retained = false;
            locationDom?.release();
            entry.release();
          } } };
        }).catch((error: unknown) => { entry.release(); throw error; }).finally(() => settleRead(entry));
      }
      let request: ReaderPublicationOverlayRequest;
      let projectionBytes: number;
      {
        const { lease, unit, address } = query.unit;
        if (lease.released) throw new DOMException("Reader overlay unit retired", "AbortError");
        if (address !== lease.address || ![...ownedUnits].some((entry) => entry.lease === lease)) throw new Error("Reader overlay requires this session's exact unit");
        const unit_key = address.unit_ref.key;
        if (query.kind === "Embeds") {
          request = { kind: query.kind, request: { unit_key, after_ordinal: null } };
          projectionBytes = publicationPayloadBytes({ kind: query.kind, fragmentId: unit.fragment_id, occurrences: [] }) +
            unit.document_embeds.reduce((bytes, occurrence) => bytes + publicationPayloadBytes(overlayOccurrence(occurrence)), 0);
        } else {
          request = { kind: query.kind, request: { unit_key, mine_only: query.mine_only, after: null, limit: 100 } };
          projectionBytes = publicationPayloadBytes({ kind: query.kind, start: unit.start_cp, end: unit.end_cp, length: unit.fragment_length_cp });
        }
      }
      const entry = reserveRead("Overlay", source.queryScratchBytes + projectionBytes);
      if (entry.kind === "Capacity") return Promise.resolve(entry);
      // The bounded source projection is charged before allocation. The async
      // validator receives no raw unit/lease, so navigation may retire that unit.
      const validation: ReaderOverlayValidation = query.kind === "Highlights" ? { kind: query.kind, start: query.unit.unit.start_cp, end: query.unit.unit.end_cp, length: query.unit.unit.fragment_length_cp }
          : { kind: query.kind, fragmentId: query.unit.unit.fragment_id, occurrences: query.unit.unit.document_embeds.map(overlayOccurrence) };
      return (async (expected: ReaderOverlayValidation) => {
        let next = request;
        const embeds: DocumentEmbed[] = [];
        const paints: ReaderPublicationHighlightPaint[] = [];
        const identities = new Set<string>();
        let retainedBytes = publicationPayloadBytes({ kind: expected.kind, items: [] });
        let identityBytes = 0;
        const boundary = AbortSignal.any([signal, entry.controller.signal]);
        // One retry owner per page: the collectors, identities and payload
        // reservation advance only after a page's boundary has returned.
        return await (async (): Promise<ReaderOverlayResult | ReaderViewCapacity> => {
          for (;;) {
            const result = await requestWithRetry((attemptSignal) => readOverlay(publication, next, attemptSignal), boundary);
            if (result.kind === "Capacity") return result;
            if ((result.kind !== "Embeds" && result.kind !== "Highlights") || result.kind !== expected.kind) throw new Error("Reader overlay response changed its requested kind");
            const additional = publicationPayloadBytes(result.page.items);
            const additionalIdentities = result.page.items.reduce((bytes, item) => bytes + item.id.length * 2, 0);
            if (!entry.resize(source.queryScratchBytes + projectionBytes + retainedBytes + additional + identityBytes + additionalIdentities)) {
              return { kind: "Capacity", reason: "Payload" };
            }
            retainedBytes += additional;
            identityBytes += additionalIdentities;
            if (result.kind === "Embeds" && expected.kind === "Embeds" && next.kind === "Embeds") {
              for (const item of result.page.items) {
                if (identities.has(item.id)) throw new Error("Reader overlay repeats an item");
                const authored = expected.occurrences.find((source) => source.id === item.id);
                if (authored === undefined || item.media_id !== publication.media_id || item.fragment_id !== expected.fragmentId ||
                    authored.ordinal !== item.ordinal || authored.key !== item.occurrence_key ||
                    authored.start !== item.locator.canonical_start_offset || authored.end !== item.locator.canonical_end_offset ||
                    (item.target.media_id !== null && item.target.media_id !== authored.targetMediaId) ||
                    (next.request.after_ordinal !== null && item.ordinal <= next.request.after_ordinal)) {
                  throw new Error("Reader embed projection escaped its retained occurrence");
                }
                identities.add(item.id); embeds.push(item);
              }
              if (result.page.next_ordinal === null) {
                if (embeds.length !== expected.occurrences.length) throw new Error("Reader embeds omitted a retained occurrence");
                return { kind: "Embeds", items: embeds };
              }
              next = { kind: next.kind, request: { ...next.request, after_ordinal: result.page.next_ordinal } };
            } else if (result.kind === "Highlights" && expected.kind === "Highlights" && next.kind === "Highlights") {
              for (const item of result.page.items) {
                if (identities.has(item.id)) throw new Error("Reader overlay repeats an item");
                if (item.start_offset >= expected.end || item.end_offset <= expected.start || item.end_offset > expected.length) {
                  throw new Error("Reader highlight paint escaped its retained unit");
                }
                identities.add(item.id); paints.push(item);
              }
              if (result.page.next_cursor === null) return { kind: "Highlights", items: paints };
              if (result.page.items.length === 0 || result.page.next_cursor === next.request.after) throw new Error("Reader paint continuation did not advance");
              next = { kind: next.kind, request: { ...next.request, after: result.page.next_cursor } };
            } else throw new Error("Reader overlay continuation changed its kind");
          }
        })();
      })(validation).then((result) => {
        if (result.kind === "Capacity") { entry.release(); return result; }
        if (!entry.resize(publicationPayloadBytes(result))) throw new Error("Reader overlay exceeded its admitted representation");
        entry.published = true;
        return { kind: "Acquired" as const, lease: { result, release: entry.release } };
      }).catch((error: unknown) => { entry.release(); throw error; }).finally(() => settleRead(entry));
    },
    async readIndex(reference, signal) {
      const publication = selected();
      const entry = reserveRead("Index", reference.bytes * READER_DECODE_RESERVATION_FACTOR);
      if (entry.kind === "Capacity") return entry;
      try {
        const page = await requestWithRetry((attemptSignal) => source.readIndex(publication, reference, attemptSignal),
          AbortSignal.any([signal, entry.controller.signal]));
        if (closed) throw new DOMException("Reader session closed", "AbortError");
        if ("kind" in page) { entry.release(); return page; }
        if (!entry.resize(publicationPayloadBytes(page))) throw new Error("Reader index exceeded its admitted representation");
        entry.published = true;
        return { page, release: entry.release };
      } catch (error) {
        entry.release();
        throw error;
      } finally { settleRead(entry); }
    },
    memberAssetUrl(reference) {
      return source.assetUrl(selected(), reference);
    },
    openPdf,
    close() {
      closed = true;
      for (const entry of ownedUnits) {
        entry.pins.clear();
        entry.lease.release();
      }
      for (const entry of reads) {
        entry.controller.abort();
        // Published results belong to their actual consumers through DOM/row retirement.
        if (!entry.published) entry.release();
      }
    },
  };
}
