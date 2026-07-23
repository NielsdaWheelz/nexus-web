// Transport decode boundary (docs/rules/boundaries.md) for the Dossier read
// models: decode the backend wire (`DossierHeadOut`, `DossierRevisionOut`,
// `DossierRevisionSummaryOut`, `DossierBuildSummary`, `MediaAbstractOut`) once
// into the owned `dossierControllerTypes` values, then pass those through the
// store/view-model unchanged. Every `Presence[T]` field is decoded with the
// repository-wide `decodePresence`; unexpected shapes throw rather than coerce.
import { isRecord } from "@/lib/validation";
import { decodePresence, type Presence } from "@/lib/api/presence";
import { isCitationOut, type CitationOut } from "@/lib/conversations/citationOut";
import {
  DOSSIER_BUILD_FAILURE_CODES,
  type DossierBuildFailureCode,
  type DossierBuildSummary,
  type DossierCancelledFacts,
  type DossierExecutionPhase,
  type DossierFailedFacts,
  type DossierFreshness,
  type DossierInputManifest,
  type DossierRevision,
  type DossierRevisionSummary,
  type MediaAbstract,
} from "@/lib/dossiers/dossierControllerTypes";

function fail(what: string): never {
  throw new Error(`Invalid dossier wire: ${what}`);
}

function decodeString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  return value;
}

function decodeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function decodeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${field} must be an integer`);
  }
  return value;
}

function decodeExecutionPhase(value: unknown): DossierExecutionPhase {
  if (
    value === "Queued" ||
    value === "Running" ||
    value === "Recovering" ||
    value === "Suspended"
  ) {
    return value;
  }
  return fail(`unknown execution phase ${JSON.stringify(value)}`);
}

export function decodeFailureCode(value: unknown): DossierBuildFailureCode {
  if (
    typeof value === "string" &&
    (DOSSIER_BUILD_FAILURE_CODES as readonly string[]).includes(value)
  ) {
    return value as DossierBuildFailureCode;
  }
  return fail(`unknown failure code ${JSON.stringify(value)}`);
}

function decodeFreshness(value: unknown): DossierFreshness {
  if (value === "Current" || value === "Stale") return value;
  return fail(`unknown freshness ${JSON.stringify(value)}`);
}

function decodeCitations(value: unknown): readonly CitationOut[] {
  if (!Array.isArray(value)) fail("citations must be an array");
  return value.map((entry) => {
    if (!isCitationOut(entry)) fail("citation entry did not match CitationOut");
    return entry;
  });
}

function decodeInputManifest(value: unknown): DossierInputManifest {
  if (!isRecord(value)) fail("input_manifest must be an object");
  if (typeof value.version !== "string" || typeof value.kind !== "string") {
    fail("input_manifest requires string version + kind");
  }
  return value as DossierInputManifest;
}

function decodeSupport(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail("failure support must be an object");
  return value;
}

export function decodeDossierRevision(raw: unknown): DossierRevision {
  if (!isRecord(raw)) fail("revision must be an object");
  return {
    artifactId: decodeString(raw.artifact_id, "artifact_id"),
    artifactRef: decodeString(raw.artifact_ref, "artifact_ref"),
    revisionId: decodeString(raw.revision_id, "revision_id"),
    revisionRef: decodeString(raw.revision_ref, "revision_ref"),
    isCurrent: decodeBoolean(raw.is_current, "is_current"),
    contentMd: decodeString(raw.content_md, "content_md"),
    citations: decodeCitations(raw.citations),
    inputManifest: decodeInputManifest(raw.input_manifest),
    instruction: decodePresence(raw.instruction, (v) =>
      decodeString(v, "instruction"),
    ),
    createdAt: decodeString(raw.created_at, "created_at"),
    promotedAt: decodePresence(raw.promoted_at, (v) =>
      decodeString(v, "promoted_at"),
    ),
  };
}

export function decodeDossierRevisionSummary(
  raw: unknown,
): DossierRevisionSummary {
  if (!isRecord(raw)) fail("revision summary must be an object");
  return {
    revisionId: decodeString(raw.revision_id, "revision_id"),
    revisionRef: decodeString(raw.revision_ref, "revision_ref"),
    isCurrent: decodeBoolean(raw.is_current, "is_current"),
    citationCount: decodeInteger(raw.citation_count, "citation_count"),
    instruction: decodePresence(raw.instruction, (v) =>
      decodeString(v, "instruction"),
    ),
    createdAt: decodeString(raw.created_at, "created_at"),
    promotedAt: decodePresence(raw.promoted_at, (v) =>
      decodeString(v, "promoted_at"),
    ),
  };
}

export function decodeDossierRevisionSummaries(
  raw: unknown,
): DossierRevisionSummary[] {
  if (!Array.isArray(raw)) fail("revisions list must be an array");
  return raw.map(decodeDossierRevisionSummary);
}

function decodeFailedFacts(raw: unknown): DossierFailedFacts {
  if (!isRecord(raw)) fail("failure facts must be an object");
  return {
    failureCode: decodeFailureCode(raw.failure_code),
    detail: decodePresence(raw.detail, (v) => decodeString(v, "detail")),
    support: decodePresence(raw.support, decodeSupport),
  };
}

function decodeCancelledFacts(raw: unknown): DossierCancelledFacts {
  if (!isRecord(raw)) fail("cancellation facts must be an object");
  return {
    actor: decodePresence(raw.actor, (v) => decodeString(v, "actor")),
    at: decodeString(raw.at, "at"),
  };
}

export function decodeDossierBuildSummary(raw: unknown): DossierBuildSummary {
  if (!isRecord(raw)) fail("build summary must be an object");
  return {
    handle: decodeString(raw.handle, "handle"),
    requesterUserId: decodePresence(raw.requester_user_id, (v) =>
      decodeString(v, "requester_user_id"),
    ),
    instruction: decodePresence(raw.instruction, (v) =>
      decodeString(v, "instruction"),
    ),
    createdAt: decodeString(raw.created_at, "created_at"),
    execution: decodePresence(raw.execution, (v) => {
      if (!isRecord(v)) fail("execution must be an object");
      return { phase: decodeExecutionPhase(v.phase) };
    }),
    failure: decodePresence(raw.failure, decodeFailedFacts),
    cancellation: decodePresence(raw.cancellation, decodeCancelledFacts),
  };
}

export function decodeMediaAbstract(raw: unknown): MediaAbstract {
  if (!isRecord(raw)) fail("media abstract must be an object");
  switch (raw.kind) {
    case "Building":
      return { kind: "Building" };
    case "Ready":
      return { kind: "Ready", summaryMd: decodeString(raw.summary_md, "summary_md") };
    case "Stale":
      return { kind: "Stale", summaryMd: decodeString(raw.summary_md, "summary_md") };
    case "Failed":
      return { kind: "Failed" };
    case "NotAvailable":
      return { kind: "NotAvailable" };
    default:
      return fail(`unknown media abstract kind ${JSON.stringify(raw.kind)}`);
  }
}

/** The head-read fields the controller decodes from `DossierHeadOut` (the
 * `history` list is fetched separately). */
export interface DecodedDossierHead {
  artifactId: Presence<string>;
  artifactRef: Presence<string>;
  currentRevision: Presence<DossierRevision>;
  freshness: Presence<DossierFreshness>;
  activeBuild: Presence<DossierBuildSummary>;
  latestUnsuccessfulBuild: Presence<DossierBuildSummary>;
  revisionCount: number;
  mediaAbstract: Presence<MediaAbstract>;
}

export function decodeDossierHead(raw: unknown): DecodedDossierHead {
  if (!isRecord(raw)) fail("head must be an object");
  return {
    artifactId: decodePresence(raw.artifact_id, (v) =>
      decodeString(v, "artifact_id"),
    ),
    artifactRef: decodePresence(raw.artifact_ref, (v) =>
      decodeString(v, "artifact_ref"),
    ),
    currentRevision: decodePresence(raw.current_revision, decodeDossierRevision),
    freshness: decodePresence(raw.freshness, decodeFreshness),
    activeBuild: decodePresence(raw.active_build, decodeDossierBuildSummary),
    latestUnsuccessfulBuild: decodePresence(
      raw.latest_unsuccessful_build,
      decodeDossierBuildSummary,
    ),
    revisionCount: decodeInteger(raw.revision_count, "revision_count"),
    mediaAbstract: decodePresence(raw.media_abstract, decodeMediaAbstract),
  };
}
