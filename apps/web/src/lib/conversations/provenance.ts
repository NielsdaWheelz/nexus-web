import { truncateText } from "@/lib/conversations/display";
import type {
  ConversationMemoryInspection,
  ConversationMessage,
  ConversationSourceRef,
  MessageArtifact,
  MessageArtifactDelta,
  MessageArtifactPart,
  MessageClaimEvidence,
  MessageClaimSupportStatus,
  MessageRetrieval,
  MessageRetrievalResultRef,
} from "@/lib/conversations/types";

export interface ProvenanceModel {
  messageCount: number;
  assistantCount: number;
  claimCount: number;
  supportedClaimCount: number;
  riskClaimCount: number;
  retrievalCount: number;
  includedRetrievalCount: number;
  sourceCount: number;
  artifactCount: number;
  artifactPartCount: number;
  citedArtifactPartCount: number;
  memoryItemCount: number;
  memorySourceCount: number;
  citationIssueCount: number;
  sources: ProvenanceSource[];
  riskClaims: ProvenanceClaim[];
  artifacts: ProvenanceArtifact[];
}

export interface ProvenanceSource {
  key: string;
  label: string;
  type: string;
  href?: string;
  sourceVersions: string[];
  retrievalCount: number;
  includedRetrievalCount: number;
  claimEvidenceCount: number;
  artifactPartCount: number;
  memorySourceCount: number;
  statuses: Set<MessageClaimSupportStatus>;
  snippets: string[];
  claims: ProvenanceClaim[];
  artifactParts: ProvenanceArtifactPart[];
}

export interface ProvenanceClaim {
  id: string;
  messageSeq: number;
  ordinal: number;
  text: string;
  status: MessageClaimSupportStatus;
  evidenceCount: number;
  sourceLabels: string[];
}

export interface ProvenanceArtifact {
  key: string;
  id: string | null;
  title: string;
  kind: string;
  status: string;
  href?: string;
  partCount: number;
  citedPartCount: number;
}

export interface ProvenanceArtifactPart {
  key: string;
  artifactTitle: string;
  artifactKind: string;
  partKey: string;
  partType: string;
  text: string | null;
}

export type ProvenanceAuditLevel = "verified" | "review" | "attention";

export interface ProvenanceAuditIssue {
  id: string;
  severity: ProvenanceAuditLevel;
  label: string;
  detail: string;
  action: string;
}

export interface ProvenanceAudit {
  score: number;
  level: ProvenanceAuditLevel;
  label: string;
  summary: string;
  coverage: {
    retrieval: number;
    claims: number;
    artifacts: number;
  };
  strengths: string[];
  issues: ProvenanceAuditIssue[];
  nextActions: string[];
}

export interface ProvenancePacket {
  schema_version: "nexus.provenance.packet.v1";
  fingerprint: string;
  audit: Pick<
    ProvenanceAudit,
    "score" | "level" | "label" | "summary" | "coverage" | "nextActions"
  >;
  counts: Pick<
    ProvenanceModel,
    | "messageCount"
    | "assistantCount"
    | "claimCount"
    | "supportedClaimCount"
    | "riskClaimCount"
    | "retrievalCount"
    | "includedRetrievalCount"
    | "sourceCount"
    | "artifactCount"
    | "artifactPartCount"
    | "citedArtifactPartCount"
    | "memoryItemCount"
    | "memorySourceCount"
    | "citationIssueCount"
  >;
  sources: Array<{
    key: string;
    label: string;
    type: string;
    href?: string;
    source_versions: string[];
    retrievals: {
      included: number;
      total: number;
    };
    claim_links: number;
    artifact_parts: number;
    memory_refs: number;
    snippets: string[];
  }>;
  risk_claims: Array<{
    id: string;
    message_seq: number;
    status: MessageClaimSupportStatus;
    text: string;
    evidence_count: number;
    source_labels: string[];
  }>;
  artifacts: Array<{
    key: string;
    id: string | null;
    title: string;
    kind: string;
    status: string;
    cited_parts: number;
    total_parts: number;
  }>;
  issues: Array<Pick<ProvenanceAuditIssue, "id" | "severity" | "label" | "detail" | "action">>;
}

export interface ProvenancePacketVerification {
  ok: boolean;
  actualFingerprint: string | null;
  expectedFingerprint: string | null;
  issues: Array<{
    id: string;
    severity: ProvenanceAuditLevel;
    detail: string;
  }>;
}

export function countProvenanceSignals(
  messages: ConversationMessage[],
  memory?: ConversationMemoryInspection | null,
): number {
  const model = buildProvenanceModel(messages, memory);
  return model.sourceCount + model.artifactCount + model.claimCount;
}

export function assessProvenanceModel(model: ProvenanceModel): ProvenanceAudit {
  const retrievalCoverage = ratio(model.includedRetrievalCount, model.retrievalCount);
  const claimCoverage = ratio(model.supportedClaimCount, model.claimCount);
  const artifactCoverage = ratio(model.citedArtifactPartCount, model.artifactPartCount);
  const issues: ProvenanceAuditIssue[] = [];

  if (model.riskClaims.length > 0) {
    const worst = model.riskClaims[0];
    issues.push({
      id: "claim-risk",
      severity: statusSeverity(worst.status) >= 4 ? "attention" : "review",
      label: `${pluralize(model.riskClaims.length, "claim")} ${
        model.riskClaims.length === 1 ? "needs" : "need"
      } review`,
      detail: `${supportStatusLabel(worst.status)}: ${truncateText(worst.text, 140)}`,
      action: "Re-run retrieval or rewrite the answer around evidence-backed claims.",
    });
  }

  if (model.citationIssueCount > 0) {
    issues.push({
      id: "citation-integrity",
      severity: "attention",
      label: `${pluralize(model.citationIssueCount, "citation issue")}`,
      detail: "Citation audit detected missing offsets, missing citations, or missing source versions.",
      action: "Repair citation locators and preserve durable source_version values before shipping.",
    });
  }

  if (model.retrievalCount > model.includedRetrievalCount) {
    issues.push({
      id: "retrieval-coverage",
      severity: "review",
      label: `${model.includedRetrievalCount}/${model.retrievalCount} retrievals reached the prompt`,
      detail: "Some retrieved candidates were left outside the prompt context.",
      action: "Inspect omitted retrievals and either include them or remove stale candidates.",
    });
  }

  if (model.artifactPartCount > model.citedArtifactPartCount) {
    issues.push({
      id: "artifact-citations",
      severity: "review",
      label: `${model.citedArtifactPartCount}/${model.artifactPartCount} artifact parts cited`,
      detail: "Generated artifact material is not fully connected back to source evidence.",
      action: "Attach source refs or evidence spans to uncited artifact parts.",
    });
  }

  if (model.sourceCount === 0 && (model.claimCount > 0 || model.artifactCount > 0)) {
    issues.push({
      id: "source-graph-empty",
      severity: "attention",
      label: "No source graph",
      detail: "The conversation has claims or artifacts without any source nodes.",
      action: "Run source-grounded retrieval before trusting this answer.",
    });
  }

  if (model.memoryItemCount > 0 && model.memorySourceCount === 0) {
    issues.push({
      id: "memory-sources",
      severity: "review",
      label: "Memory lacks source refs",
      detail: "Active memory is present but is not connected to durable sources.",
      action: "Attach source references to memory items used in this answer.",
    });
  }

  let score = 100;
  score -= severityPenalty(model.riskClaims);
  score -= Math.min(32, model.citationIssueCount * 8);
  score -= Math.round((1 - retrievalCoverage) * 20);
  score -= Math.round((1 - artifactCoverage) * 15);
  if (model.sourceCount === 0 && (model.claimCount > 0 || model.artifactCount > 0)) {
    score -= 20;
  }
  if (model.memoryItemCount > 0 && model.memorySourceCount === 0) {
    score -= 8;
  }
  score = clamp(score, 0, 100);

  const level = auditLevel(score, issues);
  const strengths = auditStrengths(model, {
    retrieval: retrievalCoverage,
    claims: claimCoverage,
    artifacts: artifactCoverage,
  });
  const nextActions = issues.map((issue) => issue.action).slice(0, 4);

  return {
    score,
    level,
    label: auditLabel(level),
    summary: auditSummary(level, score, issues.length),
    coverage: {
      retrieval: retrievalCoverage,
      claims: claimCoverage,
      artifacts: artifactCoverage,
    },
    strengths,
    issues,
    nextActions,
  };
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

export function formatProvenanceBrief(model: ProvenanceModel): string {
  const audit = assessProvenanceModel(model);
  const packet = createProvenancePacket(model);
  const lines = [
    "Evidence audit brief",
    `${pluralize(model.assistantCount, "assistant turn")}, ${pluralize(
      model.sourceCount,
      "source",
    )}, ${pluralize(model.claimCount, "claim")}, ${pluralize(
      model.artifactCount,
      "artifact",
    )}.`,
    `Verdict: ${audit.label} (${audit.score}/100). ${audit.summary}`,
    `Packet: ${packet.fingerprint}`,
    "",
    "Coverage",
    `- Retrieved in prompt: ${model.includedRetrievalCount}/${model.retrievalCount}`,
    `- Supported claims: ${model.supportedClaimCount}/${model.claimCount}`,
    `- Cited artifact parts: ${model.citedArtifactPartCount}/${model.artifactPartCount}`,
    `- Citation issues: ${model.citationIssueCount}`,
  ];

  if (audit.issues.length > 0) {
    lines.push("", "Audit issues");
    for (const issue of audit.issues.slice(0, 5)) {
      lines.push(`- ${issue.label}: ${issue.detail}`);
    }
  }

  if (audit.nextActions.length > 0) {
    lines.push("", "Next actions");
    for (const action of audit.nextActions) {
      lines.push(`- ${action}`);
    }
  }

  if (model.sources.length > 0) {
    lines.push("", "Top sources");
    for (const source of model.sources.slice(0, 5)) {
      lines.push(
        `- ${source.label}: ${source.includedRetrievalCount}/${source.retrievalCount} retrieved, ${source.claimEvidenceCount} claim links, ${source.artifactPartCount} artifact parts`,
      );
    }
  }

  if (model.artifacts.length > 0) {
    lines.push("", "Artifacts");
    for (const artifact of model.artifacts.slice(0, 5)) {
      lines.push(
        `- ${artifact.title}: ${artifact.citedPartCount}/${artifact.partCount} cited parts`,
      );
    }
  }

  return lines.join("\n");
}

export function createProvenancePacket(model: ProvenanceModel): ProvenancePacket {
  const audit = assessProvenanceModel(model);
  const packetWithoutFingerprint = {
    schema_version: "nexus.provenance.packet.v1" as const,
    audit: {
      score: audit.score,
      level: audit.level,
      label: audit.label,
      summary: audit.summary,
      coverage: audit.coverage,
      nextActions: audit.nextActions,
    },
    counts: {
      messageCount: model.messageCount,
      assistantCount: model.assistantCount,
      claimCount: model.claimCount,
      supportedClaimCount: model.supportedClaimCount,
      riskClaimCount: model.riskClaimCount,
      retrievalCount: model.retrievalCount,
      includedRetrievalCount: model.includedRetrievalCount,
      sourceCount: model.sourceCount,
      artifactCount: model.artifactCount,
      artifactPartCount: model.artifactPartCount,
      citedArtifactPartCount: model.citedArtifactPartCount,
      memoryItemCount: model.memoryItemCount,
      memorySourceCount: model.memorySourceCount,
      citationIssueCount: model.citationIssueCount,
    },
    sources: model.sources.map((source) => ({
      key: source.key,
      label: source.label,
      type: source.type,
      href: source.href,
      source_versions: [...source.sourceVersions].sort(),
      retrievals: {
        included: source.includedRetrievalCount,
        total: source.retrievalCount,
      },
      claim_links: source.claimEvidenceCount,
      artifact_parts: source.artifactPartCount,
      memory_refs: source.memorySourceCount,
      snippets: source.snippets.slice(0, 3).map((snippet) => truncateText(snippet, 240)),
    })),
    risk_claims: model.riskClaims.map((claim) => ({
      id: claim.id,
      message_seq: claim.messageSeq,
      status: claim.status,
      text: claim.text,
      evidence_count: claim.evidenceCount,
      source_labels: claim.sourceLabels,
    })),
    artifacts: model.artifacts.map((artifact) => ({
      key: artifact.key,
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      status: artifact.status,
      cited_parts: artifact.citedPartCount,
      total_parts: artifact.partCount,
    })),
    issues: audit.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      label: issue.label,
      detail: issue.detail,
      action: issue.action,
    })),
  };

  return {
    ...packetWithoutFingerprint,
    fingerprint: fingerprintCanonical(packetWithoutFingerprint),
  };
}

export function stringifyProvenancePacket(model: ProvenanceModel): string {
  return `${stableStringify(createProvenancePacket(model), 2)}\n`;
}

export function verifyProvenancePacket(
  packet: ProvenancePacket | unknown,
): ProvenancePacketVerification {
  if (!isRecord(packet)) {
    return {
      ok: false,
      actualFingerprint: null,
      expectedFingerprint: null,
      issues: [
        {
          id: "packet-shape",
          severity: "attention",
          detail: "Packet is not an object.",
        },
      ],
    };
  }

  const actualFingerprint =
    typeof packet.fingerprint === "string" ? packet.fingerprint : null;
  const expectedFingerprint = fingerprintCanonical(packetPayloadForFingerprint(packet));
  const issues: ProvenancePacketVerification["issues"] = [];

  if (packet.schema_version !== "nexus.provenance.packet.v1") {
    issues.push({
      id: "packet-schema",
      severity: "attention",
      detail: "Packet schema version is missing or unsupported.",
    });
  }

  if (!actualFingerprint || !/^pv_[0-9a-f]{8}$/.test(actualFingerprint)) {
    issues.push({
      id: "packet-fingerprint-format",
      severity: "attention",
      detail: "Packet fingerprint is missing or malformed.",
    });
  } else if (actualFingerprint !== expectedFingerprint) {
    issues.push({
      id: "packet-fingerprint",
      severity: "attention",
      detail: "Packet fingerprint does not match its canonical payload.",
    });
  }

  if (!isRecord(packet.counts)) {
    issues.push({
      id: "packet-counts",
      severity: "attention",
      detail: "Packet counts are missing.",
    });
  }
  if (!Array.isArray(packet.sources)) {
    issues.push({
      id: "packet-sources",
      severity: "attention",
      detail: "Packet source list is missing.",
    });
  }
  if (!Array.isArray(packet.artifacts)) {
    issues.push({
      id: "packet-artifacts",
      severity: "attention",
      detail: "Packet artifact list is missing.",
    });
  }
  if (!Array.isArray(packet.risk_claims)) {
    issues.push({
      id: "packet-risk-claims",
      severity: "attention",
      detail: "Packet risk claim list is missing.",
    });
  }

  if (
    isRecord(packet.counts) &&
    Array.isArray(packet.sources) &&
    typeof packet.counts.sourceCount === "number" &&
    packet.counts.sourceCount !== packet.sources.length
  ) {
    issues.push({
      id: "packet-source-count",
      severity: "review",
      detail: "Packet source count does not match the source list.",
    });
  }

  if (
    isRecord(packet.counts) &&
    Array.isArray(packet.artifacts) &&
    typeof packet.counts.artifactCount === "number" &&
    packet.counts.artifactCount !== packet.artifacts.length
  ) {
    issues.push({
      id: "packet-artifact-count",
      severity: "review",
      detail: "Packet artifact count does not match the artifact list.",
    });
  }

  if (
    isRecord(packet.counts) &&
    Array.isArray(packet.risk_claims) &&
    typeof packet.counts.riskClaimCount === "number" &&
    packet.counts.riskClaimCount !== packet.risk_claims.length
  ) {
    issues.push({
      id: "packet-risk-count",
      severity: "review",
      detail: "Packet risk claim count does not match the risk claim list.",
    });
  }

  return {
    ok: issues.length === 0,
    actualFingerprint,
    expectedFingerprint,
    issues,
  };
}

export function statusSeverity(status: MessageClaimSupportStatus): number {
  if (status === "contradicted") return 5;
  if (status === "not_enough_evidence") return 4;
  if (status === "partially_supported") return 3;
  if (status === "out_of_scope") return 2;
  if (status === "not_source_grounded") return 1;
  return 0;
}

export function supportStatusLabel(status: MessageClaimSupportStatus): string {
  if (status === "partially_supported") return "Partial";
  if (status === "not_enough_evidence") return "Needs evidence";
  if (status === "not_source_grounded") return "Ungrounded";
  if (status === "out_of_scope") return "Out of scope";
  return status.charAt(0).toUpperCase() + status.slice(1);
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
  const sourceId = textField(resultRef, "source_id") ?? textField(resultRef, "id");
  if (!href && !title && !sourceId) return null;
  return {
    key: href ? `href:${href}` : `result:${sourceId ?? title}`,
    label: title ?? href ?? sourceId ?? "Source",
    type: textField(resultRef, "result_type") ?? textField(resultRef, "type") ?? "source",
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
    textField(retrieval.result_ref, "snippet") ||
    textField(retrieval.result_ref, "excerpt") ||
    null
  );
}

function resultRefTitle(
  ref?: MessageRetrievalResultRef | Record<string, unknown> | null,
): string | null {
  return (
    textField(ref, "title") ||
    textField(ref, "source_label") ||
    textField(ref, "source_name") ||
    textField(ref, "display_url") ||
    null
  );
}

function resultRefHref(
  ref?: MessageRetrievalResultRef | Record<string, unknown> | null,
): string | undefined {
  return (
    textField(ref, "deep_link") ||
    textField(ref, "url") ||
    textField(ref, "href") ||
    undefined
  );
}

function textField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}...` : id;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function fingerprintCanonical(value: unknown): string {
  return `pv_${fnv1a(stableStringify(value)).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown, space = 0): string {
  return JSON.stringify(sortForJson(value), null, space);
}

function packetPayloadForFingerprint(packet: Record<string, unknown>): Record<string, unknown> {
  const { fingerprint: _fingerprint, ...payload } = packet;
  return payload;
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortForJson(item)]),
  );
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return numerator / denominator;
}

function severityPenalty(claims: ProvenanceClaim[]): number {
  return Math.min(
    42,
    claims.reduce((total, claim) => {
      if (claim.status === "contradicted") return total + 28;
      if (claim.status === "not_enough_evidence") return total + 18;
      if (claim.status === "partially_supported") return total + 10;
      if (claim.status === "not_source_grounded") return total + 14;
      if (claim.status === "out_of_scope") return total + 8;
      return total;
    }, 0),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function auditLevel(
  score: number,
  issues: ProvenanceAuditIssue[],
): ProvenanceAuditLevel {
  if (issues.some((issue) => issue.severity === "attention")) return "attention";
  if (score >= 90) return "verified";
  if (score >= 72) return "review";
  return "attention";
}

function auditLabel(level: ProvenanceAuditLevel): string {
  if (level === "verified") return "Evidence verified";
  if (level === "review") return "Review recommended";
  return "Needs evidence work";
}

function auditSummary(
  level: ProvenanceAuditLevel,
  score: number,
  issueCount: number,
): string {
  if (level === "verified") {
    return "The answer has a complete source-to-claim-to-artifact chain.";
  }
  if (level === "review") {
    return `${score}/100 with ${pluralize(issueCount, "repair item")}; suitable for review before reuse.`;
  }
  return `${score}/100 with ${pluralize(issueCount, "blocking evidence gap")}; do not treat as settled.`;
}

function auditStrengths(
  model: ProvenanceModel,
  coverage: ProvenanceAudit["coverage"],
): string[] {
  const strengths: string[] = [];
  if (model.sourceCount > 0) {
    strengths.push(`${pluralize(model.sourceCount, "source")} connected`);
  }
  if (model.claimCount > 0 && coverage.claims === 1) {
    strengths.push("All claims are supported");
  }
  if (model.retrievalCount > 0 && coverage.retrieval === 1) {
    strengths.push("All retrievals reached the prompt");
  }
  if (model.artifactPartCount > 0 && coverage.artifacts === 1) {
    strengths.push("All artifact parts cite evidence");
  }
  if (model.memorySourceCount > 0) {
    strengths.push(`${pluralize(model.memorySourceCount, "memory source")} linked`);
  }
  return strengths.slice(0, 4);
}
