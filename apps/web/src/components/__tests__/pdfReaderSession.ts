import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { createHostedReaderSource } from "@/lib/reader/ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "@/lib/reader/hostedReaderProgress";
import { READER_CAPACITY, type ReaderCapacity } from "@/lib/reader/readerCapacity";
import { readerPublicationMemberResponse } from "@/lib/reader/readerPublicationMemberResponse";
import type { ReaderPublicationDescriptor } from "@/lib/reader/publicationContract";

/** Actual source/session/IndexedDB progress; only HTTP representations are supplied. */
export async function pdfReaderSession(descriptor: Extract<ReaderPublicationDescriptor, { kind: "pdf" }>, capacity: ReaderCapacity = READER_CAPACITY) {
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const cache = new ResourceCache({}, capacity.cache);
  const session = createDocumentReaderSession({ mediaId: descriptor.media_id, capacity,
    source: createHostedReaderSource({ accountId, cache, capacity }), progress: runtime.createPort(descriptor.media_id) });
  const representation = await readerPublicationMemberResponse(descriptor);
  return {
    session,
    read(path: string): Response | null {
      if (path.endsWith("/reader-publication")) return representation.clone();
      if (path.endsWith("/offline-reader-state")) return Response.json({ data: {
        accountId, readerGeneration: descriptor.reader_generation, cursor: { state: "Empty", revision: 0 },
      } });
      return null;
    },
    async load() { await session.load(new AbortController().signal, { fresh: null, cold: null }); },
    close() { session.close(); runtime.close(); cache.clear(); },
  };
}
