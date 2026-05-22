import { truncateText } from "@/lib/conversations/display";
import { isRecord } from "@/lib/validation";
import { assessProvenanceModel, pluralize } from "./audit";
import type {
  ProvenanceModel,
  ProvenancePacket,
  ProvenancePacketVerification,
} from "./types";

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

function fingerprintCanonical(value: unknown): string {
  return `pv_${fnv1a(stableStringify(value)).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown, space = 0): string {
  return JSON.stringify(sortForJson(value), null, space);
}

function packetPayloadForFingerprint(
  packet: Record<string, unknown>,
): Record<string, unknown> {
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
