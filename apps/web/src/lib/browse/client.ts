import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import {
  checkBrowsePageLeaves,
  checkBrowsePreviewLeaves,
  parseDiscoveryTargetHandle,
  type BrowseKind,
  type BrowsePage,
  type BrowsePreview,
  type BrowseSort,
  type BrowseSource,
  type DiscoveryTargetHandle,
} from "./contract";

export type EpisodeAcquisitionResult = Omit<
  ApiJson<"/podcast-episodes/from-discovery", "post">["data"],
  "collectionRevision"
> & {
  readonly collectionRevision: CollectionRevision;
};

interface BrowsePageIdentity {
  readonly query: string;
  readonly kind: BrowseKind;
  readonly source: BrowseSource;
  readonly sort: BrowseSort;
}

function bindBrowsePageIdentity(
  page: BrowsePage,
  expected: BrowsePageIdentity,
): BrowsePage {
  const actualSort =
    page.sort.kind === "Present" ? page.sort.value : "Relevance";
  if (
    page.query !== expected.query ||
    page.kind !== expected.kind ||
    page.source !== expected.source ||
    actualSort !== expected.sort ||
    page.items.some(
      (candidate) =>
        candidate.source !== expected.source ||
        (candidate.kind === "OwnedMedia"
          ? candidate.resolution.mediaSummary.mediaKind !== {
              Pdf: "pdf",
              Epub: "epub",
              WebArticle: "web_article",
              Video: "video",
              Podcast: null,
            }[expected.kind]
          : candidate.kind !== expected.kind),
    )
  ) {
    throw new TypeError("BrowsePage response changed request identity");
  }
  return page;
}

export async function fetchBrowsePage(
  input: BrowsePageIdentity & {
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  },
): Promise<BrowsePage> {
  const params = new URLSearchParams({
    q: input.query,
    kind: input.kind,
    source: input.source,
    limit: String(input.limit),
  });
  if (input.sort === "Newest") params.set("sort", "Newest");
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await apiFetch<ApiJson<"/browse", "get">>(
    `/api/browse?${params}`,
    { signal: input.signal },
  );
  checkBrowsePageLeaves(response.data);
  return bindBrowsePageIdentity(response.data, input);
}

export async function fetchBrowsePreview(input: {
  target: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<BrowsePreview> {
  const target = parseDiscoveryTargetHandle(input.target);
  const params = new URLSearchParams({
    target,
    limit: String(input.limit ?? 20),
  });
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await apiFetch<ApiJson<"/browse/preview", "get">>(
    `/api/browse/preview?${params}`,
    { signal: input.signal },
  );
  const preview = response.data;
  checkBrowsePreviewLeaves(preview);
  if (
    preview.target !== input.target ||
    (preview.resolution.kind === "Preview" &&
      preview.resolution.target !== input.target)
  ) {
    throw new TypeError("BrowsePreview response changed request identity");
  }
  return preview;
}

export async function addEpisodeFromDiscovery(input: {
  target: DiscoveryTargetHandle;
  namedLibraryIds: readonly string[];
  idempotencyKey: string;
}): Promise<EpisodeAcquisitionResult> {
  const response = await apiFetch<ApiJson<"/podcast-episodes/from-discovery", "post">>(
    "/api/podcast-episodes/from-discovery",
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        target: input.target,
        namedLibraryIds: input.namedLibraryIds,
      }),
    },
  );
  const result = {
    ...response.data,
    collectionRevision: decodeCollectionRevision(response.data.collectionRevision),
  };
  publishLibraryPlacementChange([...input.namedLibraryIds]);
  return result;
}
