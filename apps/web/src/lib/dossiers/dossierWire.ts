// Transport decode boundary (docs/rules/boundaries.md) for the Dossier read
// models: decode the backend wire (`DossierHeadOut`, `DossierRevisionOut`,
// `DossierRevisionSummaryOut`, `DossierBuildSummary`, `MediaAbstractOut`) once
// into the owned `dossierControllerTypes` values, then pass those through the
// store/view-model unchanged. Every `Presence[T]` field is decoded with the
// repository-wide `decodePresence`; unexpected shapes throw rather than coerce.
import { expectExactRecord, expectRecord } from "@/lib/validation";
import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  decodeCitationOut,
  type CitationOut,
} from "@/lib/conversations/citationOut";
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
import {
  normalizeResourceActivation,
  type ResourceActivation,
} from "@/lib/resources/activation";

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
    const citation = decodeCitationOut(entry);
    if (!citation) fail("citation entry did not match CitationOut");
    return citation;
  });
}

function decodeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value.map((entry) => decodeString(entry, field));
}

function decodeMediaDisposition(value: unknown): DossierMediaDisposition {
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
    const item = expectExactRecord(
      entry,
      ["media_ref", "content_fingerprint", "disposition"],
      `${field} entry`,
    );
    return {
      mediaRef: decodeString(item.media_ref, `${field}.media_ref`),
      contentFingerprint: decodeString(
        item.content_fingerprint,
        `${field}.content_fingerprint`,
      ),
      disposition: decodeMediaDisposition(item.disposition),
    };
  });
}

function decodeInputManifest(value: unknown): DossierInputManifest {
  const discriminated = expectRecord(value, "input_manifest");
  if (discriminated.version !== "v1") {
    fail(
      `unknown input_manifest version ${JSON.stringify(discriminated.version)}`,
    );
  }
  switch (discriminated.kind) {
    case "media": {
      const manifest = expectExactRecord(
        discriminated,
        [
          "version",
          "kind",
          "media_ref",
          "content_fingerprint",
          "offered_claim_count",
          "omitted_evidence",
        ],
        "media input_manifest",
      );
      if (!Array.isArray(manifest.omitted_evidence)) {
        fail("omitted_evidence must be an array");
      }
      return {
        version: "v1",
        kind: "media",
        mediaRef: decodeString(manifest.media_ref, "media_ref"),
        contentFingerprint: decodeString(
          manifest.content_fingerprint,
          "content_fingerprint",
        ),
        offeredClaimCount: decodeInteger(
          manifest.offered_claim_count,
          "offered_claim_count",
        ),
        omittedEvidenceRefs: manifest.omitted_evidence.map((entry) => {
          const omission = expectExactRecord(
            entry,
            ["evidence_ref"],
            "omitted_evidence entry",
          );
          return decodeString(omission.evidence_ref, "evidence_ref");
        }),
      };
    }
    case "conversation": {
      const manifest = expectExactRecord(
        discriminated,
        [
          "version",
          "kind",
          "conversation_ref",
          "message_refs",
          "context_refs",
          "topology_fingerprint",
          "completeness",
        ],
        "conversation input_manifest",
      );
      const completeness = expectExactRecord(
        manifest.completeness,
        ["kind"],
        "conversation completeness",
      );
      if (completeness.kind !== "Complete") {
        fail("unknown conversation completeness");
      }
      return {
        version: "v1",
        kind: "conversation",
        conversationRef: decodeString(
          manifest.conversation_ref,
          "conversation_ref",
        ),
        messageRefs: decodeStringArray(manifest.message_refs, "message_refs"),
        contextRefs: decodeStringArray(manifest.context_refs, "context_refs"),
        topologyFingerprint: decodePresence(
          manifest.topology_fingerprint,
          (entry) => decodeString(entry, "topology_fingerprint"),
        ),
        completeness: { kind: "Complete" },
      };
    }
    case "library": {
      const manifest = expectExactRecord(
        discriminated,
        ["version", "kind", "library_ref", "media"],
        "library input_manifest",
      );
      return {
        version: "v1",
        kind: "library",
        libraryRef: decodeString(manifest.library_ref, "library_ref"),
        media: decodeMediaManifestEntries(manifest.media, "media"),
      };
    }
    case "podcast": {
      const manifest = expectExactRecord(
        discriminated,
        ["version", "kind", "podcast_ref", "episodes"],
        "podcast input_manifest",
      );
      return {
        version: "v1",
        kind: "podcast",
        podcastRef: decodeString(manifest.podcast_ref, "podcast_ref"),
        episodes: decodeMediaManifestEntries(manifest.episodes, "episodes"),
      };
    }
    case "contributor": {
      const manifest = expectExactRecord(
        discriminated,
        ["version", "kind", "contributor_handle", "works"],
        "contributor input_manifest",
      );
      return {
        version: "v1",
        kind: "contributor",
        contributorHandle: decodeString(
          manifest.contributor_handle,
          "contributor_handle",
        ),
        works: decodeMediaManifestEntries(manifest.works, "works"),
      };
    }
    case "page": {
      const manifest = expectExactRecord(
        discriminated,
        [
          "version",
          "kind",
          "page_ref",
          "input_fingerprint",
          "block_refs",
          "connection_refs",
        ],
        "page input_manifest",
      );
      return {
        version: "v1",
        kind: "page",
        pageRef: decodeString(manifest.page_ref, "page_ref"),
        inputFingerprint: decodeString(
          manifest.input_fingerprint,
          "input_fingerprint",
        ),
        blockRefs: decodeStringArray(manifest.block_refs, "block_refs"),
        connectionRefs: decodeStringArray(
          manifest.connection_refs,
          "connection_refs",
        ),
      };
    }
    case "note": {
      const manifest = expectExactRecord(
        discriminated,
        [
          "version",
          "kind",
          "note_ref",
          "input_fingerprint",
          "body_fingerprint",
          "connection_refs",
        ],
        "note input_manifest",
      );
      return {
        version: "v1",
        kind: "note",
        noteRef: decodeString(manifest.note_ref, "note_ref"),
        inputFingerprint: decodeString(
          manifest.input_fingerprint,
          "input_fingerprint",
        ),
        bodyFingerprint: decodePresence(manifest.body_fingerprint, (entry) =>
          decodeString(entry, "body_fingerprint"),
        ),
        connectionRefs: decodeStringArray(
          manifest.connection_refs,
          "connection_refs",
        ),
      };
    }
    case "idea": {
      const manifest = expectExactRecord(
        discriminated,
        [
          "version",
          "kind",
          "included_seed_refs",
          "nexus_query_fingerprints",
          "web_query_fingerprints",
          "included_sources",
          "omitted_sources",
        ],
        "idea input_manifest",
      );
      return {
        version: "v1",
        kind: "idea",
        includedSeedRefs: decodeStringArray(
          manifest.included_seed_refs,
          "included_seed_refs",
        ),
        nexusQueryFingerprints: decodeStringArray(
          manifest.nexus_query_fingerprints,
          "nexus_query_fingerprints",
        ),
        webQueryFingerprints: decodeStringArray(
          manifest.web_query_fingerprints,
          "web_query_fingerprints",
        ),
        includedSources: decodeIdeaIncludedSources(manifest.included_sources),
        omittedSources: decodeIdeaOmittedSources(manifest.omitted_sources),
      };
    }
    default:
      return fail(
        `unknown input_manifest kind ${JSON.stringify(discriminated.kind)}`,
      );
  }
}

function decodeIdeaIncludedSources(
  value: unknown,
): Array<{
  ref: string;
  contentFingerprint: string;
  role: "seed" | "nexus" | "web";
}> {
  if (!Array.isArray(value)) fail("included_sources must be an array");
  return value.map((entry) => {
    const source = expectExactRecord(
      entry,
      ["ref", "content_fingerprint", "role"],
      "included_sources entry",
    );
    if (
      source.role !== "seed" &&
      source.role !== "nexus" &&
      source.role !== "web"
    ) {
      fail(`unknown included_sources.role ${JSON.stringify(source.role)}`);
    }
    return {
      ref: decodeString(source.ref, "included_sources.ref"),
      contentFingerprint: decodeString(
        source.content_fingerprint,
        "included_sources.content_fingerprint",
      ),
      role: source.role,
    };
  });
}

function decodeIdeaOmittedSources(
  value: unknown,
): Array<{ locator: string; reason: string }> {
  if (!Array.isArray(value)) fail("omitted_sources must be an array");
  return value.map((entry) => {
    const source = expectExactRecord(
      entry,
      ["locator", "reason"],
      "omitted_sources entry",
    );
    return {
      locator: decodeString(source.locator, "omitted_sources.locator"),
      reason: decodeString(source.reason, "omitted_sources.reason"),
    };
  });
}

function decodeSupport(value: unknown): Record<string, unknown> {
  // Failure support is intentionally an opaque code-owned JSON object.
  return expectRecord(value, "failure support");
}

function decodeOmittedCoverage(
  value: unknown,
  field: string,
  decodeReason: (value: unknown) => unknown,
): void {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  value.forEach((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail(`${field} entry must be a two-item tuple`);
    }
    decodeString(entry[0], `${field}.ref`);
    decodeReason(entry[1]);
  });
}

function decodeDossierCoverage(
  value: unknown,
  manifestKind: DossierInputManifest["kind"],
): void {
  const discriminated = expectRecord(value, "coverage");
  if (discriminated.kind !== manifestKind) {
    fail("coverage kind must match input_manifest kind");
  }
  switch (discriminated.kind) {
    case "media": {
      const coverage = expectExactRecord(
        discriminated,
        ["kind", "offered_claim_count", "omitted_evidence_refs"],
        "media coverage",
      );
      decodeInteger(coverage.offered_claim_count, "offered_claim_count");
      decodeStringArray(
        coverage.omitted_evidence_refs,
        "omitted_evidence_refs",
      );
      return;
    }
    case "conversation": {
      const coverage = expectExactRecord(
        discriminated,
        ["kind", "message_refs", "context_refs"],
        "conversation coverage",
      );
      decodeStringArray(coverage.message_refs, "message_refs");
      decodeStringArray(coverage.context_refs, "context_refs");
      return;
    }
    case "library":
    case "podcast":
    case "contributor": {
      const coverage = expectExactRecord(
        discriminated,
        ["kind", "included", "omitted"],
        `${discriminated.kind} coverage`,
      );
      decodeStringArray(coverage.included, "included");
      decodeOmittedCoverage(coverage.omitted, "omitted", (entry) =>
        decodeMediaDisposition(entry),
      );
      return;
    }
    case "page": {
      const coverage = expectExactRecord(
        discriminated,
        ["kind", "block_refs", "connection_refs"],
        "page coverage",
      );
      decodeStringArray(coverage.block_refs, "block_refs");
      decodeStringArray(coverage.connection_refs, "connection_refs");
      return;
    }
    case "note": {
      const coverage = expectExactRecord(
        discriminated,
        ["kind", "body_present", "connection_refs"],
        "note coverage",
      );
      decodeBoolean(coverage.body_present, "body_present");
      decodeStringArray(coverage.connection_refs, "connection_refs");
      return;
    }
    case "idea": {
      const coverage = expectExactRecord(
        discriminated,
        [
          "kind",
          "seed_count",
          "nexus_source_count",
          "web_source_count",
          "omitted_sources",
        ],
        "idea coverage",
      );
      decodeInteger(coverage.seed_count, "seed_count");
      decodeInteger(coverage.nexus_source_count, "nexus_source_count");
      decodeInteger(coverage.web_source_count, "web_source_count");
      decodeOmittedCoverage(coverage.omitted_sources, "omitted_sources", (entry) =>
        decodeString(entry, "omitted_sources.reason"),
      );
      return;
    }
    default:
      return fail(
        `unknown coverage kind ${JSON.stringify(discriminated.kind)}`,
      );
  }
}

export function decodeDossierRevision(raw: unknown): DossierRevision {
  const revision = expectExactRecord(
    raw,
    [
      "artifact_id",
      "artifact_ref",
      "revision_id",
      "revision_ref",
      "is_current",
      "content_html",
      "content_text",
      "citations",
      "input_manifest",
      "coverage",
      "instruction",
      "creator_user_id",
      "model_provider",
      "model_name",
      "total_tokens",
      "created_at",
      "promoted_at",
    ],
    "revision",
  );
  const inputManifest = decodeInputManifest(revision.input_manifest);
  decodeDossierCoverage(revision.coverage, inputManifest.kind);
  return {
    artifactId: decodeString(revision.artifact_id, "artifact_id"),
    artifactRef: decodeString(revision.artifact_ref, "artifact_ref"),
    revisionId: decodeString(revision.revision_id, "revision_id"),
    revisionRef: decodeString(revision.revision_ref, "revision_ref"),
    isCurrent: decodeBoolean(revision.is_current, "is_current"),
    contentHtml: decodeString(revision.content_html, "content_html"),
    contentText: decodeString(revision.content_text, "content_text"),
    citations: decodeCitations(revision.citations),
    inputManifest,
    instruction: decodePresence(revision.instruction, (v) =>
      decodeString(v, "instruction"),
    ),
    creatorUserId: decodePresence(revision.creator_user_id, (v) =>
      decodeString(v, "creator_user_id"),
    ),
    modelProvider: decodePresence(revision.model_provider, (v) =>
      decodeString(v, "model_provider"),
    ),
    modelName: decodePresence(revision.model_name, (v) =>
      decodeString(v, "model_name"),
    ),
    totalTokens: decodePresence(revision.total_tokens, (v) =>
      decodeInteger(v, "total_tokens"),
    ),
    createdAt: decodeString(revision.created_at, "created_at"),
    promotedAt: decodePresence(revision.promoted_at, (v) =>
      decodeString(v, "promoted_at"),
    ),
  };
}

export function decodeDossierRevisionSummary(
  raw: unknown,
): DossierRevisionSummary {
  const revision = expectExactRecord(
    raw,
    [
      "revision_id",
      "revision_ref",
      "is_current",
      "citation_count",
      "input_manifest",
      "coverage",
      "instruction",
      "creator_user_id",
      "model_provider",
      "model_name",
      "total_tokens",
      "created_at",
      "promoted_at",
    ],
    "revision summary",
  );
  const inputManifest = decodeInputManifest(revision.input_manifest);
  decodeDossierCoverage(revision.coverage, inputManifest.kind);
  return {
    revisionId: decodeString(revision.revision_id, "revision_id"),
    revisionRef: decodeString(revision.revision_ref, "revision_ref"),
    isCurrent: decodeBoolean(revision.is_current, "is_current"),
    citationCount: decodeInteger(revision.citation_count, "citation_count"),
    inputManifest,
    instruction: decodePresence(revision.instruction, (v) =>
      decodeString(v, "instruction"),
    ),
    creatorUserId: decodePresence(revision.creator_user_id, (v) =>
      decodeString(v, "creator_user_id"),
    ),
    modelProvider: decodePresence(revision.model_provider, (v) =>
      decodeString(v, "model_provider"),
    ),
    modelName: decodePresence(revision.model_name, (v) =>
      decodeString(v, "model_name"),
    ),
    totalTokens: decodePresence(revision.total_tokens, (v) =>
      decodeInteger(v, "total_tokens"),
    ),
    createdAt: decodeString(revision.created_at, "created_at"),
    promotedAt: decodePresence(revision.promoted_at, (v) =>
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
  const failure = expectExactRecord(
    raw,
    ["failure_code", "detail", "support"],
    "failure facts",
  );
  return {
    failureCode: decodeFailureCode(failure.failure_code),
    detail: decodePresence(failure.detail, (v) => decodeString(v, "detail")),
    support: decodePresence(failure.support, decodeSupport),
  };
}

function decodeCancelledFacts(raw: unknown): DossierCancelledFacts {
  const cancellation = expectExactRecord(
    raw,
    ["actor", "at"],
    "cancellation facts",
  );
  return {
    actor: decodePresence(cancellation.actor, (v) => decodeString(v, "actor")),
    at: decodeString(cancellation.at, "at"),
  };
}

export function decodeDossierBuildSummary(raw: unknown): DossierBuildSummary {
  const build = expectExactRecord(
    raw,
    [
      "handle",
      "requester_user_id",
      "instruction",
      "created_at",
      "execution",
      "failure",
      "cancellation",
    ],
    "build summary",
  );
  return {
    handle: decodeString(build.handle, "handle"),
    requesterUserId: decodePresence(build.requester_user_id, (v) =>
      decodeString(v, "requester_user_id"),
    ),
    instruction: decodePresence(build.instruction, (v) =>
      decodeString(v, "instruction"),
    ),
    createdAt: decodeString(build.created_at, "created_at"),
    execution: decodePresence(build.execution, (v) => {
      const execution = expectExactRecord(v, ["phase"], "execution");
      return { phase: decodeExecutionPhase(execution.phase) };
    }),
    failure: decodePresence(build.failure, decodeFailedFacts),
    cancellation: decodePresence(build.cancellation, decodeCancelledFacts),
  };
}

export function decodeMediaAbstract(raw: unknown): MediaAbstract {
  const discriminated = expectRecord(raw, "media abstract");
  switch (discriminated.kind) {
    case "Building": {
      expectExactRecord(discriminated, ["kind"], "Building media abstract");
      return { kind: "Building" };
    }
    case "Ready": {
      const abstract = expectExactRecord(
        discriminated,
        ["kind", "summary_md"],
        "Ready media abstract",
      );
      return {
        kind: "Ready",
        summaryMd: decodeString(abstract.summary_md, "summary_md"),
      };
    }
    case "Stale": {
      const abstract = expectExactRecord(
        discriminated,
        ["kind", "summary_md"],
        "Stale media abstract",
      );
      return {
        kind: "Stale",
        summaryMd: decodeString(abstract.summary_md, "summary_md"),
      };
    }
    case "Failed": {
      expectExactRecord(discriminated, ["kind"], "Failed media abstract");
      return { kind: "Failed" };
    }
    case "NotAvailable": {
      expectExactRecord(
        discriminated,
        ["kind"],
        "NotAvailable media abstract",
      );
      return { kind: "NotAvailable" };
    }
    default:
      return fail(
        `unknown media abstract kind ${JSON.stringify(discriminated.kind)}`,
      );
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
  identity: Presence<
    | { kind: "Resource"; title: string; activation: ResourceActivation }
    | { kind: "Idea"; title: string }
  >;
}

function decodeDossierIdentity(
  raw: unknown,
):
  | { kind: "Resource"; title: string; activation: ResourceActivation }
  | { kind: "Idea"; title: string } {
  const discriminated = expectRecord(raw, "identity");
  if (discriminated.kind === "Idea") {
    const identity = expectExactRecord(
      discriminated,
      ["kind", "title"],
      "Idea identity",
    );
    return {
      kind: "Idea",
      title: decodeString(identity.title, "identity.title"),
    };
  }
  if (discriminated.kind === "Resource") {
    const identity = expectExactRecord(
      discriminated,
      ["kind", "title", "activation"],
      "Resource identity",
    );
    const activation = normalizeResourceActivation(identity.activation);
    if (activation === null) fail("identity.activation must be valid");
    return {
      kind: "Resource",
      title: decodeString(identity.title, "identity.title"),
      activation,
    };
  }
  return fail(
    `unknown identity kind ${JSON.stringify(discriminated.kind)}`,
  );
}

export function decodeDossierHead(raw: unknown): DecodedDossierHead {
  const head = expectExactRecord(
    raw,
    [
      "artifact_id",
      "artifact_ref",
      "identity",
      "current_revision",
      "freshness",
      "active_build",
      "latest_unsuccessful_build",
      "revision_count",
      "media_abstract",
    ],
    "head",
  );
  return {
    artifactId: decodePresence(head.artifact_id, (v) =>
      decodeString(v, "artifact_id"),
    ),
    artifactRef: decodePresence(head.artifact_ref, (v) =>
      decodeString(v, "artifact_ref"),
    ),
    currentRevision: decodePresence(
      head.current_revision,
      decodeDossierRevision,
    ),
    freshness: decodePresence(head.freshness, decodeFreshness),
    activeBuild: decodePresence(head.active_build, decodeDossierBuildSummary),
    latestUnsuccessfulBuild: decodePresence(
      head.latest_unsuccessful_build,
      decodeDossierBuildSummary,
    ),
    revisionCount: decodeInteger(head.revision_count, "revision_count"),
    mediaAbstract: decodePresence(head.media_abstract, decodeMediaAbstract),
    identity: decodePresence(head.identity, decodeDossierIdentity),
  };
}
