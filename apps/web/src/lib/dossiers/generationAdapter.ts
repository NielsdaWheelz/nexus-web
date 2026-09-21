// The transport adapter for the eight generic Dossier endpoints (A9), reached
// through the BFF (`apps/web/src/app/api/[...path]/route.ts`, which
// `proxyToFastAPI`s the FastAPI routes). One place builds the request shapes:
// the required `Idempotency-Key` header + `Presence`-encoded instruction body
// for build creation and the shared generation-run opener for the build stream.
//
// SEAM: the BFF proxy tree is owned by another slice. These call the A9 paths
// under `/api`; every same-system success is decoded from its one canonical
// response contract: exact `{data: ...}` for values or exact HTTP 204 for
// commands.
import {
  apiCommand204,
  apiFetch,
  decodeApiPayload,
  type ApiPath,
} from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import { openGenerationRunStream } from "@/lib/api/useGenerationRun";
import {
  expectBoolean,
  expectExactRecord,
  expectRecord,
  expectString,
} from "@/lib/validation";
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

function decodeDossierEnvelope<T>(
  raw: unknown,
  context: string,
  decode: (data: unknown) => T,
): T {
  return decodeApiPayload(
    raw,
    (value) => {
      const envelope = expectExactRecord(
        value,
        ["data"],
        `${context} envelope`,
      );
      return decode(envelope.data);
    },
    context,
  );
}

function decodeCreatedBuild(raw: unknown): void {
  const value = expectExactRecord(
    raw,
    ["artifact_ref", "build_handle", "created"],
    "Create Dossier build data",
  );
  expectString(value.artifact_ref, "Create Dossier build artifact_ref");
  expectString(value.build_handle, "Create Dossier build build_handle");
  expectBoolean(value.created, "Create Dossier build created");
}

function decodeLearnOutcome(raw: unknown): LearnDossierOutcome {
  const discriminated = expectRecord(raw, "Learn Dossier data");
  if (discriminated.kind === "Opened") {
    const opened = expectExactRecord(
      discriminated,
      ["kind", "artifact_ref"],
      "Opened Learn Dossier data",
    );
    return {
      kind: "Opened",
      artifactRef: expectString(
        opened.artifact_ref,
        "Opened Learn Dossier artifact_ref",
      ),
    };
  }
  if (discriminated.kind === "BuildAccepted") {
    const accepted = expectExactRecord(
      discriminated,
      ["kind", "artifact_ref", "build_handle"],
      "BuildAccepted Learn Dossier data",
    );
    return {
      kind: "BuildAccepted",
      artifactRef: expectString(
        accepted.artifact_ref,
        "BuildAccepted Learn Dossier artifact_ref",
      ),
      buildHandle: expectString(
        accepted.build_handle,
        "BuildAccepted Learn Dossier build_handle",
      ),
    };
  }
  throw new TypeError("Learn Dossier data has an unknown kind");
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
  return decodeDossierEnvelope(body, "Dossier head", decodeDossierHead);
}

export async function fetchDossierRevisions(
  artifactRef: string,
): Promise<DossierRevisionSummary[]> {
  const body = await apiFetch<unknown>(
    `/api/artifacts/${encodeURIComponent(artifactRef)}/revisions`,
  );
  return decodeDossierEnvelope(
    body,
    "Dossier revisions",
    decodeDossierRevisionSummaries,
  );
}

export async function fetchDossierRevision(
  revisionRef: string,
): Promise<DossierRevision> {
  const body = await apiFetch<unknown>(
    `/api/artifact-revisions/${encodeURIComponent(revisionRef)}`,
  );
  return decodeDossierEnvelope(
    body,
    "Dossier revision",
    decodeDossierRevision,
  );
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
  const response = await apiFetch<unknown>(path as ApiPath, {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({
      instruction: trimmed.length > 0 ? present(trimmed) : absent<string>(),
    }),
  });
  decodeDossierEnvelope(response, "Create Dossier build", decodeCreatedBuild);
}

export async function learnDossierFromHighlight(input: {
  highlightRef: string;
  idempotencyKey: string;
}): Promise<LearnDossierOutcome> {
  const response = await apiFetch<unknown>("/api/artifacts/dossiers/learn", {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey },
    body: JSON.stringify({ highlight_ref: input.highlightRef }),
  });
  return decodeDossierEnvelope(response, "Learn Dossier", decodeLearnOutcome);
}

export async function cancelDossierBuild(buildHandle: string): Promise<void> {
  await apiCommand204(
    `/api/artifact-builds/${encodeURIComponent(buildHandle)}/cancel`,
    { method: "POST" },
  );
}

export async function makeDossierRevisionCurrent(
  revisionRef: string,
): Promise<void> {
  await apiCommand204(
    `/api/artifact-revisions/${encodeURIComponent(revisionRef)}/make-current`,
    { method: "POST" },
  );
}

type DossierStreamArgs = Parameters<
  typeof openGenerationRunStream<DossierStreamEvent>
>[2];

/**
 * Open one SSE subscription to an active build's event stream
 * (`GET /stream/artifact-builds/{handle}/events`, A9). The shared generation
 * transport owns token minting, URL construction, reconnect/backoff, and
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
