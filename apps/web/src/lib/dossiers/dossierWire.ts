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
  type DossierMediaDisposition,
  type DossierMediaManifestEntry,
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

function decodeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value.map((entry) => decodeString(entry, field));
}

function decodeMediaDisposition(
  value: unknown,
): DossierMediaDisposition {
  if (
    value === "Included" ||
    value === "OmittedNoReadyUnit" ||
    value === "OmittedBudget" ||
    value === "OmittedNotAudienceVisible" ||
    value === "OmittedProjectionFailed"
  ) {
    return value;
  }
  return fail(`unknown media disposition ${JSON.stringify(value)}`);
}

function decodeMediaManifestEntries(
  value: unknown,
  field: string,
): DossierMediaManifestEntry[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value.map((entry) => {
    if (!isRecord(entry)) fail(`${field} entry must be an object`);
    return {
      mediaRef: decodeString(entry.media_ref, `${field}.media_ref`),
      contentFingerprint: decodeString(
        entry.content_fingerprint,
        `${field}.content_fingerprint`,
      ),
      disposition: decodeMediaDisposition(entry.disposition),
    };
  });
}

function decodeInputManifest(value: unknown): DossierInputManifest {
  if (!isRecord(value)) fail("input_manifest must be an object");
  if (value.version !== "v1") {
    fail(`unknown input_manifest version ${JSON.stringify(value.version)}`);
  }
  switch (value.kind) {
    case "media": {
      if (!Array.isArray(value.omitted_evidence)) {
        fail("omitted_evidence must be an array");
      }
      return {
        version: "v1",
        kind: "media",
        mediaRef: decodeString(value.media_ref, "media_ref"),
        contentFingerprint: decodeString(
          value.content_fingerprint,
          "content_fingerprint",
        ),
        offeredClaimCount: decodeInteger(
          value.offered_claim_count,
          "offered_claim_count",
        ),
        omittedEvidenceRefs: value.omitted_evidence.map((entry) => {
          if (!isRecord(entry)) fail("omitted_evidence entry must be an object");
          return decodeString(entry.evidence_ref, "evidence_ref");
        }),
      };
    }
    case "conversation": {
      if (!isRecord(value.completeness)) {
        fail("conversation completeness must be an object");
      }
      const completeness =
        value.completeness.kind === "Complete"
          ? ({ kind: "Complete" } as const)
          : value.completeness.kind === "Incomplete" &&
              value.completeness.reason === "MigratedCoverageGap"
            ? ({
                kind: "Incomplete",
                reason: "MigratedCoverageGap",
              } as const)
            : fail("unknown conversation completeness");
      return {
        version: "v1",
        kind: "conversation",
        conversationRef: decodeString(
          value.conversation_ref,
          "conversation_ref",
        ),
        messageRefs: decodeStringArray(value.message_refs, "message_refs"),
        contextRefs: decodeStringArray(value.context_refs, "context_refs"),
        topologyFingerprint: decodePresence(value.topology_fingerprint, (entry) =>
          decodeString(entry, "topology_fingerprint"),
        ),
        completeness,
      };
    }
    case "library":
      return {
        version: "v1",
        kind: "library",
        libraryRef: decodeString(value.library_ref, "library_ref"),
        media: decodeMediaManifestEntries(value.media, "media"),
      };
    case "podcast":
      return {
        version: "v1",
        kind: "podcast",
        podcastRef: decodeString(value.podcast_ref, "podcast_ref"),
        episodes: decodeMediaManifestEntries(value.episodes, "episodes"),
      };
    case "contributor":
      return {
        version: "v1",
        kind: "contributor",
        contributorHandle: decodeString(
          value.contributor_handle,
          "contributor_handle",
        ),
        works: decodeMediaManifestEntries(value.works, "works"),
      };
    case "page":
      return {
        version: "v1",
        kind: "page",
        pageRef: decodeString(value.page_ref, "page_ref"),
        inputFingerprint: decodeString(
          value.input_fingerprint,
          "input_fingerprint",
        ),
        blockRefs: decodeStringArray(value.block_refs, "block_refs"),
        connectionRefs: decodeStringArray(
          value.connection_refs,
          "connection_refs",
        ),
      };
    case "note":
      return {
        version: "v1",
        kind: "note",
        noteRef: decodeString(value.note_ref, "note_ref"),
        inputFingerprint: decodeString(
          value.input_fingerprint,
          "input_fingerprint",
        ),
        bodyFingerprint: decodePresence(value.body_fingerprint, (entry) =>
          decodeString(entry, "body_fingerprint"),
        ),
        connectionRefs: decodeStringArray(
          value.connection_refs,
          "connection_refs",
        ),
      };
    default:
      return fail(`unknown input_manifest kind ${JSON.stringify(value.kind)}`);
  }
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
    creatorUserId: decodePresence(raw.creator_user_id, (v) =>
      decodeString(v, "creator_user_id"),
    ),
    modelProvider: decodePresence(raw.model_provider, (v) =>
      decodeString(v, "model_provider"),
    ),
    modelName: decodePresence(raw.model_name, (v) =>
      decodeString(v, "model_name"),
    ),
    totalTokens: decodePresence(raw.total_tokens, (v) =>
      decodeInteger(v, "total_tokens"),
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
    inputManifest: decodeInputManifest(raw.input_manifest),
    instruction: decodePresence(raw.instruction, (v) =>
      decodeString(v, "instruction"),
    ),
    creatorUserId: decodePresence(raw.creator_user_id, (v) =>
      decodeString(v, "creator_user_id"),
    ),
    modelProvider: decodePresence(raw.model_provider, (v) =>
      decodeString(v, "model_provider"),
    ),
    modelName: decodePresence(raw.model_name, (v) =>
      decodeString(v, "model_name"),
    ),
    totalTokens: decodePresence(raw.total_tokens, (v) =>
      decodeInteger(v, "total_tokens"),
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
