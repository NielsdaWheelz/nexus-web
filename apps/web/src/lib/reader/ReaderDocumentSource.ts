import { isApiError, type ApiPath } from "@/lib/api/client";
import { publicationPayloadBytes, type ResourceCache, type PublicationUnitLease } from "@/lib/api/resourceCache";
import { expectExactRecord } from "@/lib/validation";
import type { SelectedReaderSource } from "./readerIntentStore";
import {
  decodeReaderPublicationDescriptor, decodeReaderPublicationFindPage, decodeReaderPublicationSectionContext,
  decodeReaderPublicationIndex, decodeReaderPublicationResolution,
  decodeReaderPublicationUnit, type ReaderMemberRef, type ReaderPublicationDescriptor,
  type ReaderPublicationFindPage, type ReaderPublicationFindScope, type ReaderPublicationIndex, type ReaderPublicationSectionContext,
  type ReaderPublicationResolution, type ReaderPublicationTarget, type ReaderPublicationSourceRangeTarget, type ReaderPublicationSourceRangeResolution,
} from "./publicationContract";
import { readPublicationMember, readPublicationQuery } from "./publicationTransport";
import { readReaderPublicationEmbeds, readReaderPublicationHighlights,
  readReaderPublicationApparatus, lookupReaderPublicationApparatus, readReaderPublicationApparatusTargets,
  readReaderPublicationApparatusText, readReaderPublicationApparatusLocation,
  readReaderPublicationPdfHighlights, type ReaderPublicationPdfHighlightsRequest, type ReaderPublicationPdfHighlightsPage,
  readReaderPublicationEvidenceGutter, type ReaderPublicationEvidenceGutterRequest, type ReaderPublicationEvidenceGutterPage,
  readReaderPublicationEvidenceFacts, readReaderPublicationEvidenceSeek, readReaderPublicationEvidenceAssociations,
  readReaderPublicationEvidenceMarkerPreview, type ReaderPublicationEvidenceMarkerPreviewRequest, type ReaderPublicationEvidenceMarkerPreview,
  readReaderPublicationEvidenceLocation, readReaderPublicationEvidenceOverview, readReaderPublicationEvidenceBucket,
  type ReaderPublicationEvidenceLocationRequest, type ReaderPublicationEvidenceLocationResponse,
  type ReaderPublicationEvidenceOverviewRequest, type ReaderPublicationEvidenceOverview,
  type ReaderPublicationEvidenceBucketRequest, type ReaderPublicationEvidenceBucketPage,
  type ReaderPublicationEvidenceFactsRequest, type ReaderPublicationEvidenceFactsPage,
  type ReaderPublicationEvidenceSeekRequest, type ReaderPublicationEvidenceAssociationsRequest, type ReaderPublicationEvidenceAssociationsPage,
  type ReaderPublicationEmbedsPage, type ReaderPublicationHighlightsPage,
  type ReaderPublicationEmbedsRequest, type ReaderPublicationHighlightsRequest,
  type ReaderPublicationApparatusRequest, type ReaderPublicationApparatusPage, type ReaderPublicationApparatusSummary,
  type ReaderPublicationApparatusTargetsPage, type ReaderPublicationApparatusTextRequest,
  type ReaderPublicationApparatusTextPage, type ReaderPublicationApparatusLocation,
} from "./readerPublicationOverlays";
import { READER_DECODE_RESERVATION_FACTOR, type ReaderCapacity } from "./readerCapacity";
import { readerResumeStatesEqual, type ReaderResumeState } from "./types";

/** Bound the existing source target envelope before retaining or encoding its quote. */
export function readerSourceRangeInputBytes(locator: ReaderPublicationSourceRangeTarget["locator"]): number {
  return 512 + publicationPayloadBytes(locator) * 3;
}

export type ReaderMedia = ReaderPublicationDescriptor & {
  readonly source: Extract<SelectedReaderSource, { kind: "Publication" }>;
};

export interface ResolvedPdfDocument { readonly url: string }
export type MediaId = string;

export type ReaderUnitAcquisition =
  | { readonly kind: "Acquired"; readonly lease: PublicationUnitLease }
  | ReaderSourceCapacity;
/** `Content` is the API's terminal 422 oversize refusal, never an occupancy one. */
export type ReaderSourceCapacity = { readonly kind: "Capacity"; readonly reason: "Payload" | "Reads" | "Content" };

export interface ReaderPublicationFindQuery {
  readonly query: string;
  readonly match_case: boolean;
  readonly whole_word: boolean;
  readonly scope: ReaderPublicationFindScope;
  readonly after: string | null;
}

export type ReaderPublicationOverlayRequest =
  | { readonly kind: "EvidenceGutter"; readonly request: ReaderPublicationEvidenceGutterRequest }
  | { readonly kind: "Embeds"; readonly request: ReaderPublicationEmbedsRequest }
  | { readonly kind: "Highlights"; readonly request: ReaderPublicationHighlightsRequest }
  | { readonly kind: "PdfHighlights"; readonly request: ReaderPublicationPdfHighlightsRequest }
  | { readonly kind: "Apparatus"; readonly request: ReaderPublicationApparatusRequest }
  | { readonly kind: "ApparatusLookup"; readonly request: { readonly stable_key: string } }
  | { readonly kind: "ApparatusTargets"; readonly itemId: string; readonly request: ReaderPublicationApparatusRequest }
  | { readonly kind: "ApparatusText"; readonly itemId: string; readonly request: ReaderPublicationApparatusTextRequest }
  | { readonly kind: "ApparatusLocation"; readonly itemId: string }
  | { readonly kind: "EvidenceFacts"; readonly request: ReaderPublicationEvidenceFactsRequest }
  | { readonly kind: "EvidenceSeek"; readonly request: ReaderPublicationEvidenceSeekRequest }
  | { readonly kind: "EvidenceAssociations"; readonly request: ReaderPublicationEvidenceAssociationsRequest }
  | { readonly kind: "EvidenceLocation"; readonly request: ReaderPublicationEvidenceLocationRequest }
  | { readonly kind: "EvidenceOverview"; readonly request: ReaderPublicationEvidenceOverviewRequest }
  | { readonly kind: "EvidenceBucket"; readonly request: ReaderPublicationEvidenceBucketRequest }
  | { readonly kind: "EvidenceMarkerPreview"; readonly request: ReaderPublicationEvidenceMarkerPreviewRequest };
export type ReaderPublicationOverlayPage =
  | { readonly kind: "EvidenceGutter"; readonly page: ReaderPublicationEvidenceGutterPage }
  | { readonly kind: "Embeds"; readonly page: ReaderPublicationEmbedsPage }
  | { readonly kind: "Highlights"; readonly page: ReaderPublicationHighlightsPage }
  | { readonly kind: "PdfHighlights"; readonly page: ReaderPublicationPdfHighlightsPage }
  | { readonly kind: "Apparatus"; readonly page: ReaderPublicationApparatusPage }
  | { readonly kind: "ApparatusLookup"; readonly page: ReaderPublicationApparatusSummary }
  | { readonly kind: "ApparatusTargets"; readonly page: ReaderPublicationApparatusTargetsPage }
  | { readonly kind: "ApparatusText"; readonly page: ReaderPublicationApparatusTextPage }
  | { readonly kind: "ApparatusLocation"; readonly page: ReaderPublicationApparatusLocation }
  | { readonly kind: "EvidenceFacts" | "EvidenceSeek"; readonly page: ReaderPublicationEvidenceFactsPage }
  | { readonly kind: "EvidenceAssociations"; readonly page: ReaderPublicationEvidenceAssociationsPage }
  | { readonly kind: "EvidenceLocation"; readonly page: ReaderPublicationEvidenceLocationResponse }
  | { readonly kind: "EvidenceOverview"; readonly page: ReaderPublicationEvidenceOverview }
  | { readonly kind: "EvidenceBucket"; readonly page: ReaderPublicationEvidenceBucketPage }
  | { readonly kind: "EvidenceMarkerPreview"; readonly page: ReaderPublicationEvidenceMarkerPreview };

/** Every operation after selection is bound to that immutable descriptor. */
export interface ReaderDocumentSource {
  /** Decode/reduction scratch, derived by this source from its bounded read algorithm. */
  readonly queryScratchBytes: number;
  loadDescriptor(mediaId: MediaId, signal: AbortSignal): Promise<ReaderMedia | ReaderSourceCapacity>;
  readIndex(descriptor: ReaderMedia, reference: ReaderMemberRef, signal: AbortSignal): Promise<ReaderPublicationIndex | ReaderSourceCapacity>;
  acquireUnit(descriptor: ReaderMedia, reference: ReaderMemberRef): ReaderUnitAcquisition;
  resolve(descriptor: ReaderMedia, target: ReaderPublicationTarget, signal: AbortSignal): Promise<ReaderPublicationResolution | ReaderSourceCapacity>;
  readonly sourceRange: ((descriptor: ReaderMedia, locator: ReaderPublicationSourceRangeTarget["locator"], signal: AbortSignal) => Promise<ReaderPublicationSourceRangeResolution | Extract<ReaderPublicationResolution, { kind: "Unresolved" }> | ReaderSourceCapacity>) | null;
  readonly sectionContext: ((descriptor: ReaderMedia, locator: Extract<ReaderResumeState, { kind: "web" | "epub" }>, signal: AbortSignal) => Promise<ReaderPublicationSectionContext | ReaderSourceCapacity>) | null;
  readonly find: ((descriptor: ReaderMedia, query: ReaderPublicationFindQuery, signal: AbortSignal) => Promise<ReaderPublicationFindPage | ReaderSourceCapacity>) | null;
  readonly overlays: ((descriptor: ReaderMedia, query: ReaderPublicationOverlayRequest, signal: AbortSignal) => Promise<ReaderPublicationOverlayPage | ReaderSourceCapacity>) | null;
  assetUrl(descriptor: ReaderMedia, reference: ReaderMemberRef): string;
}

function publicationPath(descriptor: ReaderMedia): ApiPath {
  return `/api/media/${descriptor.media_id}/reader-publications/${descriptor.reader_generation}`;
}

function memberPath(reference: ReaderMemberRef, role: "units" | "assets"): string {
  const segments = reference.key.split("/");
  if (segments[0] !== role || segments.length < 2 || segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Reader member has an invalid role or path");
  }
  return segments.map(encodeURIComponent).join("/");
}

/**
 * One physical read under the cache's foreground admission. The API refuses
 * content it cannot serve inside the qualified profile with a terminal 422
 * `E_READER_CONTENT_TOO_LARGE`; that is a capacity answer to this reader, not a
 * transport failure, and no caller may retry it.
 */
async function admittedRead<T>(cache: ResourceCache, run: () => Promise<T>): Promise<T | ReaderSourceCapacity> {
  const permit = cache.acquireRead();
  if (permit.kind === "Capacity") return permit;
  try {
    return await run();
  } catch (error) {
    if (isApiError(error) && error.code === "E_READER_CONTENT_TOO_LARGE") return { kind: "Capacity", reason: "Content" };
    throw error;
  } finally { permit.release(); }
}

/** One transport attempt; a reader or explicit download command owns retries. */
export function selectHostedReaderPublication(
  { mediaId, signal, capacity, cache }: { mediaId: MediaId; signal: AbortSignal; capacity: ReaderCapacity; cache: ResourceCache },
): Promise<ReaderMedia | ReaderSourceCapacity> {
  return admittedRead(cache, async () => {
    const { data: descriptor, generation } = await readPublicationMember({
      path: `/api/media/${mediaId}/reader-publication`, signal,
      maxBytes: capacity.descriptorBytes, decode: decodeReaderPublicationDescriptor,
    });
    if (descriptor.media_id !== mediaId || descriptor.reader_generation !== generation) {
      throw new Error("Reader descriptor identity mismatch");
    }
    return { ...descriptor, source: { kind: "Publication" as const, reader_generation: generation } };
  });
}

class HostedReaderSource implements ReaderDocumentSource {
  constructor(private readonly accountId: string, private readonly cache: ResourceCache, private readonly capacity: ReaderCapacity) {}
  get queryScratchBytes(): number { return this.capacity.indexBytes * READER_DECODE_RESERVATION_FACTOR; }

  loadDescriptor(mediaId: MediaId, signal: AbortSignal): Promise<ReaderMedia | ReaderSourceCapacity> {
    return selectHostedReaderPublication({ mediaId, signal, capacity: this.capacity, cache: this.cache });
  }

  readIndex(descriptor: ReaderMedia, reference: ReaderMemberRef, signal: AbortSignal): Promise<ReaderPublicationIndex | ReaderSourceCapacity> {
    return admittedRead(this.cache, async () => (await readPublicationMember({
      path: `${publicationPath(descriptor)}/index?after=${encodeURIComponent(reference.key)}`,
      signal, maxBytes: this.capacity.indexBytes, expected: reference,
      generation: descriptor.reader_generation, decode: decodeReaderPublicationIndex,
    })).data);
  }

  acquireUnit(descriptor: ReaderMedia, reference: ReaderMemberRef): ReaderUnitAcquisition {
    if (reference.bytes > this.capacity.unitBytes) throw new Error("Reader unit exceeds the configured format bound");
    return this.cache.acquirePublicationUnit({
      accountId: this.accountId, mediaId: descriptor.media_id,
      generation: descriptor.reader_generation, reference,
      read: async (signal) => (await readPublicationMember({
        path: `${publicationPath(descriptor)}/${memberPath(reference, "units")}`,
        signal, maxBytes: this.capacity.unitBytes, expected: reference,
        generation: descriptor.reader_generation,
        decode: (raw) => {
          const unit = decodeReaderPublicationUnit(raw);
          if (unit.word_boundaries === null) throw new Error("Hosted reader publication lacks required Find metadata");
          if ((descriptor.kind === "epub") !== (unit.epub_target !== null)) throw new Error("Reader unit target does not match its publication format");
          if (unit.end_cp - unit.start_cp > this.capacity.unitCodePoints) throw new Error("Reader unit exceeds its code-point bound");
          if (unit.render_nodes.length + 2 > this.capacity.unitDomNodes) throw new Error("Reader unit exceeds its node bound");
          return unit;
        },
      })).data,
    });
  }

  async resolve(descriptor: ReaderMedia, target: ReaderPublicationTarget, signal: AbortSignal): Promise<ReaderPublicationResolution | ReaderSourceCapacity> {
    const result = await this.readResolution(descriptor, target, signal);
    if (result.kind === "SourceRange") throw new Error("Navigation received a source-range resolution");
    return result;
  }

  async sourceRange(descriptor: ReaderMedia, locator: ReaderPublicationSourceRangeTarget["locator"], signal: AbortSignal) {
    if (locator.media_id !== descriptor.media_id || descriptor.kind === "pdf" ||
        (descriptor.kind === "epub") !== (locator.type === "epub_fragment_offsets")) throw new Error("Source range belongs to another reader");
    const result = await this.readResolution(descriptor, { kind: "SourceRange", locator }, signal);
    if (result.kind !== "SourceRange" && result.kind !== "Unresolved" && result.kind !== "Capacity") throw new Error("Source range received an unrelated resolution");
    if (result.kind === "SourceRange" && (result.locator.kind === "epub") !== (descriptor.kind === "epub")) throw new Error("Source range changed reader format");
    return result;
  }

  private readResolution(descriptor: ReaderMedia, target: ReaderPublicationTarget | ReaderPublicationSourceRangeTarget, signal: AbortSignal) {
    return admittedRead(this.cache, () =>
      readPublicationQuery({ path: `${publicationPath(descriptor)}/resolve`, body: { target }, signal,
        maxBytes: this.capacity.indexBytes, decode: (value) => {
        const result = decodeReaderPublicationResolution(expectExactRecord(value, ["data"], "Reader resolution response").data);
        if (target.kind === "SourceRange") {
          if (result.kind !== "SourceRange" && !(result.kind === "Unresolved" && result.locator === null)) throw new Error("Source range returned an unrelated resolution");
        } else if (target.kind === "Unit") {
          if (result.kind !== "Unit" || result.unit_ref.key !== target.unit_key) throw new Error("Reader resolution changed the requested member");
        } else if (target.kind === "Navigation" || target.kind === "EpubHref") {
          if (result.kind !== "Text" && !(result.kind === "Unresolved" && result.locator === null)) throw new Error("Reader navigation returned an unrelated resolution");
        } else if (result.kind === "Unit" || result.kind === "SourceRange" || result.locator === null || !readerResumeStatesEqual(result.locator, target.locator)) {
          throw new Error("Reader resolution changed the requested locator");
        }
        return result;
      } }));
  }

  find(descriptor: ReaderMedia, query: ReaderPublicationFindQuery, signal: AbortSignal): Promise<ReaderPublicationFindPage | ReaderSourceCapacity> {
    return admittedRead(this.cache, () =>
      readPublicationQuery({ path: `${publicationPath(descriptor)}/find`, body: query, signal,
        maxBytes: this.capacity.indexBytes, decode: (value) => decodeReaderPublicationFindPage(
          expectExactRecord(value, ["data"], "Reader find response").data,
        ) }));
  }

  sectionContext(descriptor: ReaderMedia, locator: Extract<ReaderResumeState, { kind: "web" | "epub" }>, signal: AbortSignal): Promise<ReaderPublicationSectionContext | ReaderSourceCapacity> {
    if (locator.locations.text_offset === null) throw new Error("Reader section context requires a captured canonical offset");
    return admittedRead(this.cache, () =>
      readPublicationQuery({ path: `${publicationPath(descriptor)}/section-context`, body: { locator }, signal,
        maxBytes: this.capacity.indexBytes, decode: (value) => decodeReaderPublicationSectionContext(
          expectExactRecord(value, ["data"], "Reader section context response").data,
        ) }));
  }

  overlays(descriptor: ReaderMedia, query: ReaderPublicationOverlayRequest, signal: AbortSignal): Promise<ReaderPublicationOverlayPage | ReaderSourceCapacity> {
    return admittedRead(this.cache, async () => {
      switch (query.kind) {
        case "Embeds": return { kind: query.kind, page: await readReaderPublicationEmbeds(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "Highlights": return { kind: query.kind, page: await readReaderPublicationHighlights(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "Apparatus": return { kind: query.kind, page: await readReaderPublicationApparatus(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "ApparatusLookup": return { kind: query.kind, page: await lookupReaderPublicationApparatus(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "ApparatusTargets": return { kind: query.kind, page: await readReaderPublicationApparatusTargets(descriptor, query.itemId, query.request, signal, this.capacity.indexBytes) };
        case "ApparatusText": return { kind: query.kind, page: await readReaderPublicationApparatusText(descriptor, query.itemId, query.request, signal, this.capacity.indexBytes) };
        case "ApparatusLocation": return { kind: query.kind, page: await readReaderPublicationApparatusLocation(descriptor, query.itemId, signal, this.capacity.indexBytes) };
        case "EvidenceLocation": return { kind: query.kind, page: await readReaderPublicationEvidenceLocation(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "EvidenceGutter": return { kind: query.kind, page: await readReaderPublicationEvidenceGutter(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "EvidenceOverview": return { kind: query.kind, page: await readReaderPublicationEvidenceOverview(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "EvidenceMarkerPreview": return { kind: query.kind, page: await readReaderPublicationEvidenceMarkerPreview(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "EvidenceBucket": return { kind: query.kind, page: await readReaderPublicationEvidenceBucket(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "EvidenceFacts": return { kind: query.kind, page: await readReaderPublicationEvidenceFacts(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "EvidenceSeek": return { kind: query.kind, page: await readReaderPublicationEvidenceSeek(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "EvidenceAssociations": return { kind: query.kind, page: await readReaderPublicationEvidenceAssociations(descriptor, query.request, signal, this.capacity.indexBytes) };
        case "PdfHighlights": return { kind: query.kind, page: await readReaderPublicationPdfHighlights(descriptor, query.request, signal, this.capacity.indexBytes) };
      }
    });
  }

  assetUrl(descriptor: ReaderMedia, reference: ReaderMemberRef): string {
    return `${publicationPath(descriptor)}/${memberPath(reference, "assets")}`;
  }
}

export function createHostedReaderSource(
  { accountId, cache, capacity }: { accountId: string; cache: ResourceCache; capacity: ReaderCapacity },
): HostedReaderSource {
  return new HostedReaderSource(accountId, cache, capacity);
}
