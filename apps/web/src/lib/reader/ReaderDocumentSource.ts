import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import type { EpubSectionContent } from "@/lib/media/epubFind";
import {
  decodeMediaNavigationResponse,
  type MediaNavigation,
} from "@/lib/media/readerNavigation";
import {
  normalizeFragments,
  type Fragment,
} from "@/lib/media/transcriptView";

export type ReaderMediaKind = "pdf" | "epub" | "web_article";

export interface ReaderMedia {
  readonly id: string;
  readonly title: string;
  readonly kind: ReaderMediaKind;
}

export interface ReaderTextDocument {
  readonly fragments: readonly Fragment[];
  readonly navigation?: readonly {
    readonly fragment_id: string;
    readonly label: string;
  }[];
}

export type ReaderNavigation = MediaNavigation;

export interface ResolvedPdfDocument {
  readonly url: string;
  readonly expiresAtMs: number | null;
}

/** Contract-named identifier aliases from the Cut-1 reader contract. */
export type MediaId = string;
export type SectionId = string;
export type ReaderAssetRef = string;
export type ReaderAssetUrl = string;

export interface ReaderDocumentSource {
  loadDescriptor(mediaId: MediaId, signal: AbortSignal): Promise<ReaderMedia>;
  loadTextDocument(
    mediaId: MediaId,
    signal: AbortSignal,
  ): Promise<ReaderTextDocument>;
  loadEpubNavigation(
    mediaId: MediaId,
    signal: AbortSignal,
  ): Promise<ReaderNavigation>;
  loadEpubSection(
    mediaId: MediaId,
    sectionId: SectionId,
    signal: AbortSignal,
  ): Promise<EpubSectionContent>;
  openPdf(
    mediaId: MediaId,
    signal: AbortSignal,
  ): Promise<ResolvedPdfDocument>;
  resolveAsset(ref: ReaderAssetRef): ReaderAssetUrl;
}

interface ReaderDescriptorResponse {
  readonly data: ReaderMedia;
}

interface ReaderFragmentsResponse {
  readonly data: readonly Fragment[];
}

interface ReaderSectionResponse {
  readonly data: EpubSectionContent;
}

interface PdfFileAccessResponse {
  readonly data: {
    readonly url: string;
    readonly expires_at: string;
  };
}

function resolvedPdfDocument(response: PdfFileAccessResponse): ResolvedPdfDocument {
  const expiresAtMs = Date.parse(response.data.expires_at);
  return {
    url: response.data.url,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

class HostedReaderSource implements ReaderDocumentSource {
  async loadDescriptor(mediaId: string, signal: AbortSignal): Promise<ReaderMedia> {
    const response = await apiFetch<ReaderDescriptorResponse>(
      `/api/media/${mediaId}`,
      { signal },
    );
    return response.data;
  }

  async loadTextDocument(
    mediaId: string,
    signal: AbortSignal,
  ): Promise<ReaderTextDocument> {
    const response = await apiFetch<ReaderFragmentsResponse>(
      `/api/media/${mediaId}/fragments`,
      { signal },
    );
    return { fragments: normalizeFragments(response.data) };
  }

  async loadEpubNavigation(
    mediaId: string,
    signal: AbortSignal,
  ): Promise<ReaderNavigation> {
    const response = decodeApiPayload(
      await apiFetch<unknown>(`/api/media/${mediaId}/navigation`, { signal }),
      decodeMediaNavigationResponse,
      "GET /api/media/{id}/navigation",
    );
    return response.data;
  }

  async loadEpubSection(
    mediaId: string,
    sectionId: string,
    signal: AbortSignal,
  ): Promise<EpubSectionContent> {
    const response = await apiFetch<ReaderSectionResponse>(
      `/api/media/${mediaId}/sections/${encodeURIComponent(sectionId)}`,
      { signal },
    );
    return response.data;
  }

  async openPdf(
    mediaId: string,
    signal: AbortSignal,
  ): Promise<ResolvedPdfDocument> {
    return resolvedPdfDocument(
      await apiFetch<PdfFileAccessResponse>(`/api/media/${mediaId}/file`, {
        signal,
      }),
    );
  }

  resolveAsset(ref: ReaderAssetRef): ReaderAssetUrl {
    return ref;
  }
}

export function createHostedReaderSource(): ReaderDocumentSource {
  return new HostedReaderSource();
}
