import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { publicationPayloadBytes } from "@/lib/api/resourceCache";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import { createPaneFindResultKey, createPaneFindSourceKey, type PaneFindResultKey, type PaneFindResultRow } from "@/lib/panes/paneSearch";
import type { PaneFindSessionRequest } from "@/lib/panes/usePaneFind";
import { findFirstVisibleCanonicalOffset, measureCanonicalTextAnchorViewportDelta, restoreCanonicalTextAnchorViewportPosition, scrollToExactCanonicalTextAnchor } from "@/app/(authenticated)/media/[id]/paneTextAnchor";
import type { MediaFindPreviewLease } from "@/app/(authenticated)/media/[id]/mediaFindPreviewLease";
import { createCanonicalTextFindPresentationOwner, type CanonicalTextFindAdapter } from "./canonicalTextFindPresentation";
import { readerCapacityNotice } from "./readerCapacity";
import type { DocumentReaderSession, ReaderFindLease, ReaderViewCapacity } from "./DocumentReaderSession";
import type { ReaderMedia } from "./ReaderDocumentSource";
import { READER_PUBLICATION_FIND_MATCH_LIMIT, type ReaderPublicationFindPage } from "./publicationContract";
import type { DocumentReaderWindow, ReaderWindowUnit } from "./useDocumentReaderWindow";
import type { ReaderScrollPositioner } from "./paneScroll";
import type { ReaderResumeState } from "./types";

type Occurrence = ReaderPublicationFindPage["occurrences"][number];
interface FindRow extends PaneFindResultRow { readonly fragmentId: string; readonly fragmentIdx: number; readonly startCp: number; readonly endCp: number; readonly locator: ReaderResumeState }
type FindResult = { readonly kind: "Ready"; readonly rows: readonly FindRow[] } | { readonly kind: "TooManyMatches"; readonly threshold: typeof READER_PUBLICATION_FIND_MATCH_LIMIT };
export type PublicationFindError = ReaderViewCapacity | { readonly kind: "OriginUnavailable" | "RequestUnavailable" };
export interface PublicationFindPart {
  readonly item: ReaderWindowUnit;
  readonly root: HTMLElement;
  readonly cursor: CanonicalCursorResult;
}
export type PublicationFindRenderResult =
  | { readonly kind: "Rendered"; readonly part: PublicationFindPart }
  | ReaderViewCapacity
  | { readonly kind: "Failed"; readonly error: unknown };
interface Origin {
  readonly unitKey: string;
  readonly fragmentIdx: number;
  readonly offset: number;
  readonly delta: number;
  readonly scrollLeft: number;
  readonly locator: Extract<ReaderResumeState, { kind: "web" | "epub" }>;
}
interface PublicationFindAdapter extends CanonicalTextFindAdapter<PublicationFindError> { release(): void }

/** Find owns one bounded result projection; the existing window owns all displayed units. */
export function createPublicationFindAdapter({ session, descriptor, window, getRendered, waitForUnit, previewLease, scrollPositioner, focusViewport }: {
  readonly session: DocumentReaderSession;
  readonly descriptor: ReaderMedia;
  readonly window: Pick<DocumentReaderWindow, "navigate" | "loadNeighbor">;
  readonly getRendered: () => { readonly viewport: HTMLElement; readonly parts: readonly PublicationFindPart[] } | null;
  readonly waitForUnit: (item: ReaderWindowUnit, signal: AbortSignal) => Promise<PublicationFindRenderResult>;
  readonly previewLease: MediaFindPreviewLease;
  readonly scrollPositioner: ReaderScrollPositioner;
  readonly focusViewport: () => void;
}): PublicationFindAdapter {
  if (descriptor.kind === "pdf" || session.find === null || session.sectionContext === null) throw new Error("Hosted text Find requires retained query capabilities");
  const sourceKey = createPaneFindSourceKey({ kind: "Publication", mediaId: descriptor.media_id, generation: descriptor.reader_generation });
  const readFind = session.find;
  const readContext = session.sectionContext;
  const presentation = createCanonicalTextFindPresentationOwner();
  let preparedSession: number | null = null;
  let sectionId: string | null = null;
  let anchor: Origin | null = null;
  let origin: Origin | null = null;
  let result: { queryId: number; lease: ReaderFindLease<FindResult> } | null = null;
  let activeKey: PaneFindResultKey | null = null;
  const assertCurrent = (request: PaneFindSessionRequest) => {
    request.signal.throwIfAborted();
    if (request.sourceKey !== sourceKey || preparedSession !== request.sessionId) throw new DOMException("Reader Find was superseded", "AbortError");
  };
  const capture = (): Origin | null => {
    const rendered = getRendered();
    if (rendered === null) return null;
    for (const part of rendered.parts) {
      const local = findFirstVisibleCanonicalOffset(rendered.viewport, part.cursor);
      if (local === null) continue;
      const delta = measureCanonicalTextAnchorViewportDelta(rendered.viewport, part.cursor, local);
      if (delta === null) continue;
      const unit = part.item.unit;
      const offset = unit.render_start_cp + local;
      const fields = { locations: { text_offset: offset, progression: null, total_progression: null, position: null },
        text: { quote: null, quote_prefix: null, quote_suffix: null } };
      const locator = unit.epub_target === null
        ? { kind: "web" as const, target: { fragment_id: unit.fragment_id }, ...fields }
        : { kind: "epub" as const, target: unit.epub_target, ...fields };
      return { unitKey: part.item.address.unit_ref.key, fragmentIdx: unit.fragment_idx, offset, delta, scrollLeft: rendered.viewport.scrollLeft, locator };
    }
    return null;
  };
  const row = (match: Occurrence): FindRow => ({
    key: createPaneFindResultKey({ source: sourceKey, locator: [match.fragment_id, match.start_offset, match.end_offset] }),
    context: match.section_label === null ? [] : [match.section_label], snippet: match.snippet,
    fragmentId: match.fragment_id, fragmentIdx: match.fragment_idx, startCp: match.start_offset, endCp: match.end_offset, locator: match.locator,
  });
  const publish = () => {
    const rendered = getRendered();
    const current = result?.lease.result;
    if (rendered === null || current?.kind !== "Ready" || result === null) { presentation.clear(); return false; }
    return presentation.publishWindow({ viewport: rendered.viewport,
      parts: rendered.parts.map(({ item, cursor }) => ({ fragmentId: item.unit.fragment_id, startCp: item.unit.start_cp,
        endCp: item.unit.end_cp, renderStartCp: item.unit.render_start_cp, cursor })),
      targets: current.rows, activeKey,
    }).activeComplete;
  };
  const releaseResult = () => { result = null; activeKey = null; presentation.clear(); };
  const modeledError = (error: unknown): PublicationFindError => {
    if (handleUnauthenticatedApiError(error)) throw new DOMException("Find authentication boundary took ownership", "AbortError");
    if (isApiError(error) && !isSameSystemApiDefect(error)) return { kind: "RequestUnavailable" };
    throw error;
  };
  return {
    sourceKey,
    async prepare(request) {
      request.signal.throwIfAborted();
      preparedSession = request.sessionId;
      releaseResult();
      origin = null; sectionId = null; anchor = capture();
      if (anchor !== null) {
        try {
          const response = await readContext(anchor.locator, request.signal);
          try {
            assertCurrent(request);
            if (response.kind === "Capacity") return { kind: "Failed", sessionId: request.sessionId, sourceKey, error: response };
            sectionId = response.lease.context.current?.section_id ?? null;
          } finally { if (response.kind === "Acquired") response.lease.release(); }
        } catch (error) { return { kind: "Failed", sessionId: request.sessionId, sourceKey, error: modeledError(error) }; }
      }
      return { kind: "Prepared", session: { sessionId: request.sessionId, sourceKey, scopes: [
        { kind: "EntireResource", id: "EntireResource", label: descriptor.kind === "epub" ? "Entire book" : "Entire article" },
        ...(sectionId === null ? [] : [{ kind: "Narrow" as const, id: `Section:${sectionId}`, label: "This section" }]),
      ] } };
    },
    async find(request) {
      assertCurrent(request);
      if (request.scopeId !== "EntireResource" && (sectionId === null || request.scopeId !== `Section:${sectionId}`)) throw new Error("Reader Find scope is outside its captured publication context");
      releaseResult();
      const identity = { sessionId: request.sessionId, queryId: request.queryId, sourceKey };
      try {
        const response = await readFind({ query: request.query, match_case: request.matchCase, whole_word: request.wholeWord,
          scope: request.scopeId === "EntireResource" ? { kind: "EntireResource" } : { kind: "Section", section_id: request.scopeId.slice("Section:".length) },
        }, request.signal, {
          bytes: (value) => value.kind === "Ready"
            ? publicationPayloadBytes({ kind: "Ready", rows: [] }) + value.occurrences.reduce((sum, match) => sum + publicationPayloadBytes(row(match)), 0)
            : publicationPayloadBytes(value),
          create: (value): FindResult => value.kind === "Ready" ? { kind: "Ready", rows: value.occurrences.map(row) } : value,
        });
        if (response.kind === "Capacity") return { kind: "Failed", ...identity, error: response };
        try { assertCurrent(request); } catch (error) { response.lease.release(); throw error; }
        const matches = response.lease.result;
        if (matches.kind === "TooManyMatches") { response.lease.release(); return { kind: "TooManyMatches", ...identity, threshold: matches.threshold }; }
        if (matches.rows.length === 0) { response.lease.release(); return { kind: "NoMatches", ...identity, completeness: "Complete" }; }
        const owned = { queryId: request.queryId, lease: response.lease };
        result = owned;
        const afterAnchor = anchor === null ? -1 : matches.rows.findIndex((match) =>
          match.fragmentIdx > anchor!.fragmentIdx || (match.fragmentIdx === anchor!.fragmentIdx && match.startCp >= anchor!.offset));
        return { kind: "Ready", ...identity, completeness: "Complete", rows: matches.rows,
          initialActiveKey: matches.rows[Math.max(0, afterAnchor)]!.key,
          releaseRows() {
            if (result === owned) releaseResult();
            owned.lease.release();
          } };
      } catch (error) { return { kind: "Failed", ...identity, error: modeledError(error) }; }
    },
    async preview(request) {
      assertCurrent(request);
      const owned = result;
      if (owned === null || owned.queryId !== request.queryId || owned.lease.result.kind !== "Ready") throw new Error("Reader Find result is no longer owned");
      const match = owned.lease.result.rows.find((item) => item.key === request.key);
      if (match === undefined) throw new Error("Reader Find key does not identify a result");
      const rejected = (error: PublicationFindError) => ({ kind: "Rejected" as const, returnAvailable: origin !== null, sessionId: request.sessionId, queryId: request.queryId, sourceKey, key: request.key, error });
      origin ??= capture();
      if (origin === null) return rejected({ kind: "OriginUnavailable" });
      previewLease.acquire();
      const completion = await window.navigate({ kind: "Locator", locator: match.locator });
      assertCurrent(request);
      if (completion.kind === "Superseded") throw new DOMException("Reader Find preview superseded", "AbortError");
      if (completion.kind === "Failed") return rejected(modeledError(completion.error));
      if (completion.kind !== "Ready") return rejected(completion.kind === "Capacity" ? completion : { kind: "RequestUnavailable" });
      const assertPreview = () => {
        assertCurrent(request);
        if (!completion.isCurrent()) throw new DOMException("Reader Find navigation superseded", "AbortError");
      };
      const first = await waitForUnit(completion.item, request.signal);
      assertPreview();
      if (first.kind !== "Rendered") return rejected(first.kind === "Capacity" ? first : modeledError(first.error));
      activeKey = request.key;
      while (!publish()) {
        const next = await window.loadNeighbor("Next");
        assertPreview();
        if (next?.kind === "Superseded") throw new DOMException("Reader Find preview superseded", "AbortError");
        if (next?.kind === "Failed") return rejected(modeledError(next.error));
        if (next?.kind !== "Ready") return rejected(next?.kind === "Capacity" ? next : { kind: "RequestUnavailable" });
        if (next.item.unit.fragment_id !== match.fragmentId) throw new Error("Reader Find range escaped its retained fragment");
        const neighbor = await waitForUnit(next.item, request.signal);
        assertPreview();
        if (neighbor.kind !== "Rendered") return rejected(neighbor.kind === "Capacity" ? neighbor : modeledError(neighbor.error));
      }
      const rendered = getRendered();
      const anchor = rendered?.parts.find(({ item }) => item.lease === completion.item.lease);
      if (rendered === null || anchor === undefined) throw new Error("Reader Find lost its admitted preview before positioning");
      await scrollPositioner.run((commands) => {
        assertPreview();
        if (!scrollToExactCanonicalTextAnchor(commands, rendered.viewport, anchor.cursor, Math.max(0, match.startCp - anchor.item.unit.render_start_cp))) throw new Error("Reader Find match could not be positioned exactly");
      });
      assertPreview();
      return { kind: "Previewed", sessionId: request.sessionId, queryId: request.queryId, sourceKey, key: request.key, returnAvailable: true };
    },
    async clearPresentation(request) { assertCurrent(request); activeKey = null; presentation.clear(); },
    async returnToReadingPosition(request) {
      assertCurrent(request);
      const captured = origin;
      if (captured === null) return { kind: "Returned" };
      previewLease.acquire();
      const completion = await window.navigate({ kind: "Unit", unit_key: captured.unitKey });
      assertCurrent(request);
      if (completion.kind === "Superseded") throw new DOMException("Reader Find return superseded", "AbortError");
      if (completion.kind === "Failed") return { kind: "Failed", error: modeledError(completion.error) };
      if (completion.kind !== "Ready") return { kind: "Failed", error: completion.kind === "Capacity" ? completion : { kind: "RequestUnavailable" } };
      const assertReturn = () => {
        assertCurrent(request);
        if (!completion.isCurrent()) throw new DOMException("Reader Find return superseded", "AbortError");
      };
      const settled = await waitForUnit(completion.item, request.signal);
      assertReturn();
      if (settled.kind !== "Rendered") return { kind: "Failed", error: settled.kind === "Capacity" ? settled : modeledError(settled.error) };
      const rendered = getRendered();
      if (rendered === null) throw new Error("Reader Find return lost its viewport");
      await scrollPositioner.run((commands) => {
        assertReturn();
        restoreCanonicalTextAnchorViewportPosition(commands, rendered.viewport, settled.part.cursor,
          captured.offset - settled.part.item.unit.render_start_cp, captured.delta, captured.scrollLeft);
      });
      assertReturn();
      activeKey = null; origin = null; presentation.clear(); previewLease.completeReturn(); focusViewport();
      return { kind: "Returned" };
    },
    errorMessage(error) {
      switch (error.kind) {
        case "Capacity": return readerCapacityNotice(error.reason).message;
        case "OriginUnavailable": return "Reading position is unavailable.";
        case "RequestUnavailable": return "Find request unavailable. Retry.";
      }
    },
    rebuildPresentation() { publish(); },
    release() { preparedSession = null; releaseResult(); origin = null; anchor = null; sectionId = null; },
  };
}
