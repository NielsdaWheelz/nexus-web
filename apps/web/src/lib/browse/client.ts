import { expectExactRecord, expectRecord } from "@/lib/validation";
import { apiFetch } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import {
  decodeBrowsePageEnvelope,
  decodeBrowsePreviewEnvelope,
  type BrowseKind,
  type BrowsePage,
  type BrowsePreview,
  type BrowseSort,
  type BrowseSource,
  type DiscoveryTargetHandle,
} from "./contract";

export interface EpisodeAcquisitionResult {
  readonly href: string;
  readonly mediaId: string;
  readonly destinationOutcomes: readonly {
    readonly libraryId: string;
    readonly outcome:
      | "Added"
      | "AlreadyPresent"
      | "IncludedThroughPodcast";
  }[];
  readonly collectionRevision: CollectionRevision;
}

function nonempty(raw: unknown, context: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError(`${context} must be a non-empty string`);
  }
  return raw;
}

function oneOf<T extends string>(
  raw: unknown,
  values: readonly T[],
  context: string,
): T {
  if (typeof raw !== "string" || !values.includes(raw as T)) {
    throw new TypeError(`${context} has an unsupported value`);
  }
  return raw as T;
}

function envelopeData(raw: unknown, context: string): Record<string, unknown> {
  const envelope = expectExactRecord(raw, ["data"], `${context} envelope`);
  return expectRecord(envelope.data, context);
}

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
        candidate.kind !== expected.kind || candidate.source !== expected.source,
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
  return bindBrowsePageIdentity(
    decodeBrowsePageEnvelope(
      await apiFetch<unknown>(`/api/browse?${params}`, { signal: input.signal }),
    ),
    input,
  );
}

export async function fetchBrowsePreview(input: {
  target: DiscoveryTargetHandle;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<BrowsePreview> {
  const params = new URLSearchParams({
    target: input.target,
    limit: String(input.limit ?? 20),
  });
  if (input.cursor) params.set("cursor", input.cursor);
  const preview = decodeBrowsePreviewEnvelope(
    await apiFetch<unknown>(`/api/browse/preview?${params}`, { signal: input.signal }),
  );
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
  const value = envelopeData(
    await apiFetch<unknown>("/api/podcast-episodes/from-discovery", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        target: input.target,
        namedLibraryIds: input.namedLibraryIds,
      }),
    }),
    "EpisodeAcquisitionResult",
  );
  expectExactRecord(
    value,
    ["href", "mediaId", "destinationOutcomes", "collectionRevision"],
    "EpisodeAcquisitionResult",
  );
  if (!Array.isArray(value.destinationOutcomes)) {
    throw new TypeError(
      "EpisodeAcquisitionResult.destinationOutcomes must be an array",
    );
  }
  const result = {
    href: nonempty(value.href, "EpisodeAcquisitionResult.href"),
    mediaId: nonempty(value.mediaId, "EpisodeAcquisitionResult.mediaId"),
    destinationOutcomes: value.destinationOutcomes.map((raw, index) => {
      const outcome = expectExactRecord(
        raw,
        ["libraryId", "outcome"],
        `EpisodeAcquisitionResult.destinationOutcomes[${index}]`,
      );
      return {
        libraryId: nonempty(
          outcome.libraryId,
          `EpisodeAcquisitionResult.destinationOutcomes[${index}].libraryId`,
        ),
        outcome: oneOf(
          outcome.outcome,
          ["Added", "AlreadyPresent", "IncludedThroughPodcast"] as const,
          `EpisodeAcquisitionResult.destinationOutcomes[${index}].outcome`,
        ),
      };
    }),
    collectionRevision: decodeCollectionRevision(value.collectionRevision),
  };
  publishLibraryPlacementChange([...input.namedLibraryIds]);
  return result;
}
