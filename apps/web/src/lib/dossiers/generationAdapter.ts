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

export type DossierReadTarget =
  | { kind: "Subject"; subject: DossierSubjectDescriptor }
  | { kind: "Artifact"; artifactRef: string };

export type LearnDossierOutcome =
  | { kind: "Opened"; artifactRef: string }
  | {
      kind: "BuildAccepted";
      artifactRef: string;
      buildHandle: string;
    };

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

function artifactHeadPath(artifactRef: string): ApiPath {
  return `/api/artifacts/${encodeURIComponent(artifactRef)}`;
}

export function artifactPaneHref(artifactRef: string): string {
  return `/artifacts/${encodeURIComponent(artifactRef)}`;
}

export async function fetchDossierHead(
  target: DossierReadTarget,
): Promise<DecodedDossierHead> {
  const body = await apiFetch<unknown>(
    target.kind === "Subject"
      ? dossierHeadPath(target.subject)
      : artifactHeadPath(target.artifactRef),
  );
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
  target: DossierReadTarget;
  artifactRef: string | null;
  instruction: string | null;
  idempotencyKey: string;
}): Promise<void> {
  const trimmed = input.instruction?.trim() ?? "";
  const path =
    input.artifactRef !== null
      ? `${artifactHeadPath(input.artifactRef)}/builds`
      : input.target.kind === "Subject"
        ? `${dossierHeadPath(input.target.subject)}/builds`
        : `${artifactHeadPath(input.target.artifactRef)}/builds`;
  await apiFetch<unknown>(path as ApiPath, {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({
      instruction: trimmed.length > 0 ? present(trimmed) : absent<string>(),
    }),
  });
}

export async function learnDossierFromHighlight(input: {
  highlightRef: string;
  idempotencyKey: string;
}): Promise<LearnDossierOutcome> {
  const raw = unwrapEnvelope(
    await apiFetch<unknown>("/api/artifacts/dossiers/learn", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ highlight_ref: input.highlightRef }),
    }),
  );
  if (!isRecord(raw)) {
    throw new Error("Invalid Learn Dossier response");
  }
  const keys = Object.keys(raw).sort();
  if (
    keys.length === 2 &&
    keys[0] === "artifact_ref" &&
    keys[1] === "kind" &&
    raw.kind === "Opened" &&
    typeof raw.artifact_ref === "string"
  ) {
    return { kind: "Opened", artifactRef: raw.artifact_ref };
  }
  if (
    keys.length === 3 &&
    keys[0] === "artifact_ref" &&
    keys[1] === "build_handle" &&
    keys[2] === "kind" &&
    raw.kind === "BuildAccepted" &&
    typeof raw.artifact_ref === "string" &&
    typeof raw.build_handle === "string"
  ) {
    return {
      kind: "BuildAccepted",
      artifactRef: raw.artifact_ref,
      buildHandle: raw.build_handle,
    };
  }
  throw new Error("Invalid Learn Dossier response");
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
