import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import { requestEpubFragment, type EpubFragmentContent } from "@/lib/media/epubFragment";
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
}

export type ReaderNavigation = MediaNavigation;

export interface ResolvedPdfDocument {
  readonly url: string;
  readonly expiresAtMs: number | null;
}

export interface ReaderDocumentSource {
  loadDescriptor(mediaId: string, signal: AbortSignal): Promise<ReaderMedia>;
  loadTextDocument(
    mediaId: string,
    signal: AbortSignal,
  ): Promise<ReaderTextDocument>;
  loadNavigation(
    mediaId: string,
    signal: AbortSignal,
  ): Promise<ReaderNavigation>;
  loadEpubFragment(
    mediaId: string,
    fragmentId: string,
    signal: AbortSignal,
  ): Promise<EpubFragmentContent>;
  openPdf(mediaId: string, signal: AbortSignal): Promise<ResolvedPdfDocument>;
}

interface ReaderDescriptorResponse {
  readonly data: ReaderMedia;
}

interface ReaderFragmentsResponse {
  readonly data: readonly Fragment[];
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

  async loadNavigation(
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

  loadEpubFragment(mediaId: string, fragmentId: string, signal: AbortSignal): Promise<EpubFragmentContent> {
    return requestEpubFragment({ mediaId, fragmentId, signal });
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
}

export function createHostedReaderSource(): ReaderDocumentSource {
  return new HostedReaderSource();
}
