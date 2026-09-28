// The dossier transport: the typed head, build and learn routes, the 204 cancel,
// and the build event stream, all through the BFF proxy under `/api`.
import { apiCommand204, apiFetch, type ApiPath } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import { openGenerationRunStream } from "@/lib/api/useGenerationRun";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { DossierStreamEvent } from "@/lib/dossiers/eventDecoder";

export interface DossierSubjectDescriptor {
  scheme: string;
  handle: string;
}

export type DossierReadTarget =
  | { kind: "Subject"; subject: DossierSubjectDescriptor }
  | { kind: "Artifact"; artifactRef: string };

function subjectHeadPath(subject: DossierSubjectDescriptor): ApiPath {
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
): Promise<Schema<"DossierHeadOut">> {
  const body =
    target.kind === "Subject"
      ? await apiFetch<
          ApiJson<"/artifacts/dossiers/{subject_scheme}/{subject_handle}", "get">
        >(subjectHeadPath(target.subject))
      : await apiFetch<ApiJson<"/artifacts/{artifact_ref}", "get">>(
          artifactHeadPath(target.artifactRef),
        );
  return body.data;
}

/**
 * Create one build (Generate / Regenerate / Retry). The caller owns the
 * idempotency key: each press mints a new one, while a transport retry of the
 * same press reuses it. The 202 body is not read; the next head read reports
 * the build.
 */
export async function createDossierBuild(input: {
  target: DossierReadTarget;
  artifactRef: string | null;
  instruction: string | null;
  idempotencyKey: string;
}): Promise<void> {
  const trimmed = input.instruction?.trim() ?? "";
  const headPath =
    input.artifactRef !== null
      ? artifactHeadPath(input.artifactRef)
      : input.target.kind === "Subject"
        ? subjectHeadPath(input.target.subject)
        : artifactHeadPath(input.target.artifactRef);
  await apiFetch<unknown>(`${headPath}/builds`, {
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
}): Promise<ApiJson<"/artifacts/dossiers/learn", "post">["data"]> {
  const body = await apiFetch<ApiJson<"/artifacts/dossiers/learn", "post">>(
    "/api/artifacts/dossiers/learn",
    {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ highlight_ref: input.highlightRef }),
    },
  );
  return body.data;
}

export async function cancelDossierBuild(buildHandle: string): Promise<void> {
  await apiCommand204(
    `/api/artifact-builds/${encodeURIComponent(buildHandle)}/cancel`,
    { method: "POST" },
  );
}

type DossierStreamArgs = Parameters<
  typeof openGenerationRunStream<DossierStreamEvent>
>[2];

/**
 * Open one SSE subscription to an active build's event stream. The shared
 * generation transport owns token minting, reconnect/backoff and
 * `Last-Event-ID` resumption. Returns a stop function.
 */
export async function openDossierBuildStream(
  buildHandle: string,
  sseArgs: DossierStreamArgs,
): Promise<() => void> {
  return openGenerationRunStream<DossierStreamEvent>(
    "artifact-builds",
    buildHandle,
    sseArgs,
  );
}
