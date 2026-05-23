import type {
  ConversationMemoryInspection,
  ConversationMessage,
  ConversationSourceRef,
  MessageArtifact,
  MessageArtifactDelta,
  MessageArtifactPart,
  MessageClaimEvidence,
  MessageRetrieval,
  MessageRetrievalResultRef,
} from "@/lib/conversations/types";
import { getStringField } from "@/lib/validation";
import { statusSeverity } from "./audit";
import type {
  ProvenanceArtifact,
  ProvenanceClaim,
  ProvenanceModel,
  ProvenanceSource,
} from "./types";

export function countProvenanceSignals(
  messages: ConversationMessage[],
  memory?: ConversationMemoryInspection | null,
): number {
  const model = buildProvenanceModel(messages, memory);
  return model.sourceCount + model.artifactCount + model.claimCount;
}

export function buildProvenanceModel(
  messages: ConversationMessage[],
  memory?: ConversationMemoryInspection | null,
): ProvenanceModel {
  const sources = new Map<string, ProvenanceSource>();
  const claimById = new Map<string, ProvenanceClaim>();
  const claimEvidenceByClaimId = new Map<string, MessageClaimEvidence[]>();
  const artifacts = new Map<string, ProvenanceArtifact>();
  const seenArtifactPartKeys = new Set<string>();
  let retrievalCount = 0;
  let includedRetrievalCount = 0;
  let artifactPartCount = 0;
  let citedArtifactPartCount = 0;
  let citationIssueCount = 0;

  for (const message of messages) {
    const blocks = message.message_document?.blocks ?? [];
    for (const block of blocks) {
      if (block.type === "retrieval_result") {
        retrievalCount += 1;
        if (block.included_in_prompt === true || block.selected === true) {
          includedRetrievalCount += 1;
        }
        const source = ensureSource(sources, sourceIdentityFromRetrieval(block));
        addSourceVersion(source, block.source_version);
        source.retrievalCount += 1;
        if (block.included_in_prompt === true || block.selected === true) {
          source.includedRetrievalCount += 1;
        }
        addSnippet(source, retrievalSnippet(block));
      } else if (block.type === "claim") {
        claimById.set(block.claim_id, {
          id: block.claim_id,
          messageSeq: message.seq,
          ordinal: block.ordinal,
          text: block.claim_text,
          status: block.support_status,
          evidenceCount: 0,
          sourceLabels: [],
        });
      } else if (block.type === "claim_evidence") {
        const rows = claimEvidenceByClaimId.get(block.claim_id) ?? [];
        rows.push(block);
        claimEvidenceByClaimId.set(block.claim_id, rows);
        const source = sourceIdentityFromEvidence(block);
        if (source) {
          const node = ensureSource(sources, source);
          addSourceVersion(node, block.source_version);
          node.claimEvidenceCount += 1;
          node.statuses.add(claimById.get(block.claim_id)?.status ?? "supported");
          addSnippet(node, block.exact_snippet);
        }
      } else if (block.type === "citation_audit") {
        citationIssueCount += citationAuditIssueCount(block);
      } else if (block.type === "artifact_preview") {
        const artifact = artifactFromPreview(block, conversationArtifactHref(block));
        artifacts.set(artifact.key, artifact);
        const partCounts = recordArtifactPartProvenance(
          artifact,
          block.parts ?? [],
          sources,
          seenArtifactPartKeys,
        );
        artifactPartCount += partCounts.partCount;
        citedArtifactPartCount += partCounts.citedPartCount;
      }
    }

    for (const artifact of message.artifacts ?? []) {
      const modelArtifact = artifactFromDurable(artifact);
      artifacts.set(modelArtifact.key, modelArtifact);
      const partCounts = recordArtifactPartProvenance(
        modelArtifact,
        artifact.parts ?? [],
        sources,
        seenArtifactPartKeys,
      );
      artifactPartCount += partCounts.partCount;
      citedArtifactPartCount += partCounts.citedPartCount;
    }
  }

  for (const claim of claimById.values()) {
    const evidence = claimEvidenceByClaimId.get(claim.id) ?? [];
    claim.evidenceCount = evidence.length;
    claim.sourceLabels = [
      ...new Set(
        evidence
          .map(sourceIdentityFromEvidence)
          .filter((source): source is SourceIdentity => Boolean(source))
          .map((source) => source.label),
      ),
    ];
    for (const evidenceRow of evidence) {
      const identity = sourceIdentityFromEvidence(evidenceRow);
      if (!identity) continue;
      const source = ensureSource(sources, identity);
      if (!source.claims.some((item) => item.id === claim.id)) {
        source.claims.push(claim);
      }
    }
  }

  let memorySourceCount = 0;
  const activeMemoryItems = (memory?.memory_items ?? []).filter(
    (item) => item.status === "active",
  );
  for (const item of activeMemoryItems) {
    for (const source of item.sources) {
      memorySourceCount += 1;
      const identity = sourceIdentityFromSourceRef(source.source_ref);
      if (identity) {
        const node = ensureSource(sources, identity);
        node.memorySourceCount += 1;
      }
    }
  }
  const snapshotSources = memory?.state_snapshot?.source_refs ?? [];
  for (const sourceRef of snapshotSources) {
    memorySourceCount += 1;
    const identity = sourceIdentityFromSourceRef(sourceRef);
    if (identity) {
      const node = ensureSource(sources, identity);
      node.memorySourceCount += 1;
    }
  }

  const claims = [...claimById.values()];
  const riskClaims = claims
    .filter((claim) => claim.status !== "supported")
    .sort(
      (a, b) => statusSeverity(b.status) - statusSeverity(a.status) || a.ordinal - b.ordinal,
    );
  const sortedSources = [...sources.values()].sort(sourceSort);
  const sortedArtifacts = [...artifacts.values()].sort(
    (a, b) => b.partCount - a.partCount || a.title.localeCompare(b.title),
  );

  return {
    messageCount: messages.length,
    assistantCount: messages.filter((message) => message.role === "assistant").length,
    claimCount: claims.length,
    supportedClaimCount: claims.filter((claim) => claim.status === "supported").length,
    riskClaimCount: riskClaims.length,
    retrievalCount,
    includedRetrievalCount,
    sourceCount: sortedSources.length,
    artifactCount: sortedArtifacts.length,
    artifactPartCount,
    citedArtifactPartCount,
    memoryItemCount: activeMemoryItems.length,
    memorySourceCount,
    citationIssueCount,
    sources: sortedSources,
    riskClaims,
    artifacts: sortedArtifacts,
  };
}

interface SourceIdentity {
  key: string;
  label: string;
  type: string;
  href?: string;
}

function ensureSource(
  sources: Map<string, ProvenanceSource>,
  identity: SourceIdentity,
): ProvenanceSource {
  const existing = sources.get(identity.key);
  if (existing) {
    return existing;
  }
  const source: ProvenanceSource = {
    ...identity,
    sourceVersions: [],
    retrievalCount: 0,
    includedRetrievalCount: 0,
    claimEvidenceCount: 0,
    artifactPartCount: 0,
    memorySourceCount: 0,
    statuses: new Set(),
    snippets: [],
    claims: [],
    artifactParts: [],
  };
  sources.set(identity.key, source);
  return source;
}

function addSnippet(source: ProvenanceSource, snippet?: string | null) {
  const value = snippet?.trim();
  if (!value || source.snippets.includes(value)) return;
  source.snippets.push(value);
}

function addSourceVersion(source: ProvenanceSource, sourceVersion?: string | null) {
  const value = sourceVersion?.trim();
  if (!value || source.sourceVersions.includes(value)) return;
  source.sourceVersions.push(value);
}

function sourceIdentityFromRetrieval(retrieval: MessageRetrieval): SourceIdentity {
  const title = retrievalTitle(retrieval);
  const href = retrieval.deep_link ?? resultRefHref(retrieval.result_ref);
  if (retrieval.media_id) {
    return {
      key: `media:${retrieval.media_id}`,
      label: title,
      type: retrieval.result_type,
      href: `/media/${encodeURIComponent(retrieval.media_id)}`,
    };
  }
  if (href) {
    return {
      key: `href:${href}`,
      label: title,
      type: retrieval.result_type,
      href,
    };
  }
  return {
    key: `${retrieval.result_type}:${retrieval.source_id}`,
    label: title,
    type: retrieval.result_type,
  };
}

function sourceIdentityFromEvidence(
  evidence: MessageClaimEvidence,
): SourceIdentity | null {
  return (
    sourceIdentityFromSourceRef(evidence.source_ref) ??
    sourceIdentityFromResultRef(evidence.result_ref) ??
    (evidence.deep_link
      ? {
          key: `href:${evidence.deep_link}`,
          label: evidence.citation_label || evidence.deep_link,
          type: evidence.retrieval_status,
          href: evidence.deep_link,
        }
      : null)
  );
}

function sourceIdentityFromArtifactPart(
  part: MessageArtifactPart,
): SourceIdentity | null {
  const sourceRefs = [
    part.source_ref,
    ...(part.source_refs ?? []),
  ].filter((source): source is ConversationSourceRef => Boolean(source));
  for (const sourceRef of sourceRefs) {
    const identity = sourceIdentityFromSourceRef(sourceRef);
    if (identity) return identity;
  }
  return sourceIdentityFromResultRef(part.result_ref);
}

function sourceIdentityFromSourceRef(
  sourceRef?: ConversationSourceRef | null,
): SourceIdentity | null {
  if (!sourceRef) return null;
  const href =
    sourceRef.deep_link ||
    resultRefHref(sourceRef.result_ref) ||
    (sourceRef.media_id ? `/media/${encodeURIComponent(sourceRef.media_id)}` : undefined);
  const label =
    sourceRef.label ||
    resultRefTitle(sourceRef.result_ref) ||
    (sourceRef.media_id ? `Media ${shortId(sourceRef.media_id)}` : null) ||
    `${sourceRef.type} ${shortId(sourceRef.id)}`;
  const key = sourceRef.media_id
    ? `media:${sourceRef.media_id}`
    : href
      ? `href:${href}`
      : `${sourceRef.type}:${sourceRef.id}`;
  return {
    key,
    label,
    type: sourceRef.type,
    href,
  };
}

function sourceIdentityFromResultRef(
  resultRef?: MessageRetrievalResultRef | null,
): SourceIdentity | null {
  if (!resultRef) return null;
  const href = resultRefHref(resultRef);
  const title = resultRefTitle(resultRef);
  const sourceId = getStringField(resultRef, "source_id") ?? getStringField(resultRef, "id");
  if (!href && !title && !sourceId) return null;
  return {
    key: href ? `href:${href}` : `result:${sourceId ?? title}`,
    label: title ?? href ?? sourceId ?? "Source",
    type: getStringField(resultRef, "result_type") ?? getStringField(resultRef, "type") ?? "source",
    href,
  };
}

function artifactFromPreview(
  artifact: MessageArtifactDelta,
  href?: string,
): ProvenanceArtifact {
  const id = artifact.durable_artifact_id ?? artifact.artifact_id ?? null;
  const key =
    id ??
    (artifact.artifact_key
      ? `${artifact.artifact_key}:v${artifact.artifact_version ?? "draft"}`
      : `${artifact.artifact_kind ?? "artifact"}:${artifact.title ?? "untitled"}`);
  const parts = artifact.parts ?? [];
  return {
    key,
    id,
    title: artifact.title || artifact.artifact_kind || "Generated artifact",
    kind: artifact.artifact_kind || "artifact",
    status: artifact.status || "preview",
    href,
    partCount: parts.length,
    citedPartCount: parts.filter(artifactPartHasEvidence).length,
  };
}

function artifactFromDurable(artifact: MessageArtifact): ProvenanceArtifact {
  return {
    key: artifact.id,
    id: artifact.id,
    title: artifact.title || artifact.artifact_key || artifact.artifact_kind,
    kind: artifact.artifact_kind,
    status: artifact.status,
    partCount: artifact.parts.length,
    citedPartCount: artifact.parts.filter(artifactPartHasEvidence).length,
  };
}

function recordArtifactPartProvenance(
  artifact: ProvenanceArtifact,
  parts: MessageArtifactPart[],
  sources: Map<string, ProvenanceSource>,
  seenArtifactPartKeys: Set<string>,
): { partCount: number; citedPartCount: number } {
  let partCount = 0;
  let citedPartCount = 0;
  parts.forEach((part, index) => {
    const key = artifactPartIdentity(artifact.key, part, index);
    if (seenArtifactPartKeys.has(key)) return;
    seenArtifactPartKeys.add(key);

    partCount += 1;
    if (artifactPartHasEvidence(part)) citedPartCount += 1;
    const source = sourceIdentityFromArtifactPart(part);
    if (source) {
      const node = ensureSource(sources, source);
      addSourceVersion(node, part.source_version);
      node.artifactPartCount += 1;
      addSnippet(node, part.text ?? null);
      node.artifactParts.push({
        key,
        artifactTitle: artifact.title,
        artifactKind: artifact.kind,
        partKey: part.part_key || `Part ${index + 1}`,
        partType: part.part_type || "",
        text: part.text ?? null,
      });
    }
  });
  return { partCount, citedPartCount };
}

function artifactPartIdentity(
  artifactKey: string,
  part: MessageArtifactPart,
  index: number,
): string {
  if (part.id) return `id:${part.id}`;
  return [
    artifactKey,
    part.part_key ?? "",
    part.part_type ?? "",
    part.ordinal ?? index,
    part.source_version,
    part.text?.slice(0, 80) ?? "",
  ].join(":");
}

function conversationArtifactHref(artifact: MessageArtifactDelta): string | undefined {
  const id = artifact.durable_artifact_id ?? artifact.artifact_id;
  return id ? `?artifact=${encodeURIComponent(id)}` : undefined;
}

function sourceSort(a: ProvenanceSource, b: ProvenanceSource): number {
  const scoreA =
    a.claimEvidenceCount * 5 +
    a.artifactPartCount * 3 +
    a.includedRetrievalCount * 2 +
    a.memorySourceCount;
  const scoreB =
    b.claimEvidenceCount * 5 +
    b.artifactPartCount * 3 +
    b.includedRetrievalCount * 2 +
    b.memorySourceCount;
  return scoreB - scoreA || a.label.localeCompare(b.label);
}

function citationAuditIssueCount(audit: {
  supported_claims_with_valid_offsets_count: number;
  supported_claims_with_citation_count: number;
  supported_claim_count: number;
  missing_locator_count: number;
  missing_source_version_count: number;
}): number {
  return (
    Math.max(
      0,
      audit.supported_claim_count - audit.supported_claims_with_valid_offsets_count,
    ) +
    Math.max(
      0,
      audit.supported_claim_count - audit.supported_claims_with_citation_count,
    ) +
    audit.missing_locator_count +
    audit.missing_source_version_count
  );
}

function artifactPartHasEvidence(part: MessageArtifactPart): boolean {
  return (
    Boolean(part.source_ref) ||
    Boolean(part.context_ref) ||
    Boolean(part.result_ref) ||
    (part.source_refs?.length ?? 0) > 0 ||
    Boolean(part.evidence_span_id) ||
    (part.evidence_span_ids?.length ?? 0) > 0
  );
}

function retrievalTitle(retrieval: MessageRetrieval): string {
  return (
    retrieval.source_title ||
    retrieval.section_label ||
    resultRefTitle(retrieval.result_ref) ||
    retrieval.citation_label ||
    retrieval.source_id
  );
}

function retrievalSnippet(retrieval: MessageRetrieval): string | null {
  return (
    retrieval.exact_snippet ||
    getStringField(retrieval.result_ref, "snippet") ||
    getStringField(retrieval.result_ref, "excerpt") ||
    null
  );
}

function resultRefTitle(
  ref?: MessageRetrievalResultRef | Record<string, unknown> | null,
): string | null {
  return (
    getStringField(ref, "title") ||
    getStringField(ref, "source_label") ||
    getStringField(ref, "source_name") ||
    getStringField(ref, "display_url") ||
    null
  );
}

function resultRefHref(
  ref?: MessageRetrievalResultRef | Record<string, unknown> | null,
): string | undefined {
  return (
    getStringField(ref, "deep_link") ||
    getStringField(ref, "url") ||
    getStringField(ref, "href") ||
    undefined
  );
}


function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}...` : id;
}
