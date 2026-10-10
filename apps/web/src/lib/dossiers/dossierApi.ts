// The dossier transport: typed head, build, learn and cancel calls through the
// BFF proxy, and the build-status snapshot stream.
import { apiCommand204, apiFetch, type ApiPath } from "@/lib/api/client";
import { absent, present } from "@/lib/api/presence";
import { sseClientDirect } from "@/lib/api/sse-client";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type DossierTarget =
  | {
      readonly kind: "Subject";
      readonly scheme: string;
      readonly handle: string;
    }
  | { readonly kind: "Artifact"; readonly artifactRef: string };

type DossierBuild = Schema<"DossierBuildOut">;

function headPath(target: DossierTarget): ApiPath {
  return target.kind === "Subject"
    ? `/api/artifacts/dossiers/${encodeURIComponent(target.scheme)}/${encodeURIComponent(target.handle)}`
    : `/api/artifacts/${encodeURIComponent(target.artifactRef)}`;
}

export function artifactPaneHref(artifactRef: string): string {
  return `/artifacts/${encodeURIComponent(artifactRef)}`;
}

// The subject and artifact routes answer the same bodies.
type HeadJson =
  | ApiJson<"/artifacts/dossiers/{subject_scheme}/{subject_handle}", "get">
  | ApiJson<"/artifacts/{artifact_ref}", "get">;
type BuildJson =
  | ApiJson<
      "/artifacts/dossiers/{subject_scheme}/{subject_handle}/builds",
      "post"
    >
  | ApiJson<"/artifacts/{artifact_ref}/builds", "post">;

export async function fetchDossierHead(
  target: DossierTarget,
): Promise<Schema<"DossierHeadOut">> {
  return (await apiFetch<HeadJson>(headPath(target))).data;
}

/** One press is one key: a transport retry of the same press reuses it. */
export async function createDossierBuild(
  target: DossierTarget,
  instruction: string | null,
  idempotencyKey: string,
): Promise<Schema<"DossierBuildCreatedOut">> {
  const init = {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      instruction: instruction ? present(instruction) : absent<string>(),
    }),
  };
  const path: ApiPath = `${headPath(target)}/builds`;
  return (await apiFetch<BuildJson>(path, init)).data;
}

export async function learnDossier(
  highlightRef: string,
  idempotencyKey: string,
): Promise<ApiJson<"/artifacts/dossiers/learn", "post">["data"]> {
  const body = await apiFetch<ApiJson<"/artifacts/dossiers/learn", "post">>(
    "/api/artifacts/dossiers/learn",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ highlight_ref: highlightRef }),
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

/**
 * Each frame is the build's whole status; the last one is not Active. A build
 * that is gone (404) or a stream that stays down is reported once as lost.
 */
export function watchDossierBuild(
  buildHandle: string,
  onState: (build: DossierBuild) => void,
  onLost: () => void,
): () => void {
  return sseClientDirect<DossierBuild, DossierBuild>({
    path: `/stream/artifact-builds/${encodeURIComponent(buildHandle)}/events`,
    decode: (type, build) => {
      if (type !== "state" && type !== "done")
        throw new Error(`Unknown SSE event type: ${type}`);
      return build;
    },
    isTerminal: (build) => build.status !== "Active",
    onEvent: onState,
    onError: onLost,
  });
}
