// The transport adapter for the eight generic Dossier endpoints (A9), reached
// through the BFF (`apps/web/src/app/api/artifacts/dossiers/**`, which
// `proxyToFastAPI`s the FastAPI routes). One place builds the request shapes:
// the required `Idempotency-Key` header + `Presence`-encoded instruction body
// for build creation, and the `sseClientDirect` opener for the build stream.
//
// SEAM: the BFF proxy tree is owned by another slice. These call the A9 paths
// under `/api`; if the proxy wraps a read model in a single-key `{data}`
// envelope, `unwrapEnvelope` transparently unwraps it (the head/revision shapes
// never carry a top-level `data` field, so a real body is never mis-unwrapped).
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import { isRecord } from "@/lib/validation";
import { sseClientDirect } from "@/lib/api/sse-client";
import { fetchStreamToken } from "@/lib/api/streamToken";
import {
  decodeDossierHead,
  decodeDossierRevision,
  decodeDossierRevisionSummaries,
  type DecodedDossierHead,
} from "@/lib/dossiers/dossierWire";
import type {
  DossierRevision,
  DossierRevisionSummary,
} from "@/lib/dossiers/dossierControllerTypes";
import type { DossierStreamEvent } from "@/lib/dossiers/eventDecoder";

/** The A9 route subject params: `{subject_scheme}/{subject_handle}`. */
export interface DossierSubjectDescriptor {
  scheme: string;
  handle: string;
}

function unwrapEnvelope(raw: unknown): unknown {
  if (
    isRecord(raw) &&
    Object.keys(raw).length === 1 &&
    "data" in raw
  ) {
    return (raw as { data: unknown }).data;
  }
  return raw;
}

function dossierHeadPath(subject: DossierSubjectDescriptor): ApiPath {
  return `/api/artifacts/dossiers/${encodeURIComponent(subject.scheme)}/${encodeURIComponent(subject.handle)}`;
}

export async function fetchDossierHead(
  subject: DossierSubjectDescriptor,
): Promise<DecodedDossierHead> {
  const body = await apiFetch<unknown>(dossierHeadPath(subject));
  return decodeDossierHead(unwrapEnvelope(body));
}

export async function fetchDossierRevisions(
  artifactRef: string,
): Promise<DossierRevisionSummary[]> {
  const body = await apiFetch<unknown>(
    `/api/artifacts/${encodeURIComponent(artifactRef)}/revisions`,
  );
  return decodeDossierRevisionSummaries(unwrapEnvelope(body));
}

export async function fetchDossierRevision(
  revisionRef: string,
): Promise<DossierRevision> {
  const body = await apiFetch<unknown>(
    `/api/artifact-revisions/${encodeURIComponent(revisionRef)}`,
  );
  return decodeDossierRevision(unwrapEnvelope(body));
}

/**
 * Create one build (Generate / Regenerate / Retry). The caller owns the
 * idempotency key: Generate/Regenerate/Retry each mint a NEW key, while a
 * transport retry of the SAME logical generation reuses the SAME key (A15).
 */
export async function createDossierBuild(input: {
  subject: DossierSubjectDescriptor;
  instruction: string | null;
  idempotencyKey: string;
}): Promise<void> {
  const trimmed = input.instruction?.trim() ?? "";
  await apiFetch<unknown>(`${dossierHeadPath(input.subject)}/builds`, {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({
      instruction: trimmed.length > 0 ? present(trimmed) : absent<string>(),
    }),
  });
}

export async function cancelDossierBuild(buildHandle: string): Promise<void> {
  await apiFetch<unknown>(
    `/api/artifact-builds/${encodeURIComponent(buildHandle)}/cancel`,
    { method: "POST" },
  );
}

export async function makeDossierRevisionCurrent(
  revisionRef: string,
): Promise<void> {
  await apiFetch<unknown>(
    `/api/artifact-revisions/${encodeURIComponent(revisionRef)}/make-current`,
    { method: "POST" },
  );
}

type DossierStreamArgs = Omit<
  Parameters<typeof sseClientDirect<DossierStreamEvent>>[0],
  "url" | "initialConnection" | "initialToken"
>;

/**
 * Open one SSE subscription to an active build's event stream
 * (`GET /stream/artifact-builds/{handle}/events`, A9). Mints a fresh stream
 * token, builds the URL, and hands both to `sseClientDirect` (which owns
 * reconnect/backoff/`Last-Event-ID` resumption). Returns a stop function.
 */
export async function openDossierBuildStream(
  buildHandle: string,
  sseArgs: DossierStreamArgs,
): Promise<() => void> {
  return sseClientDirect<DossierStreamEvent>({
    initialConnection: async () => {
      const connection = await fetchStreamToken();
      return {
        url: `${connection.stream_base_url}/stream/artifact-builds/${encodeURIComponent(buildHandle)}/events`,
        token: connection.token,
      };
    },
    ...sseArgs,
  });
}
