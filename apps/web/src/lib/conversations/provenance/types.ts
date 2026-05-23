import type { MessageClaimSupportStatus } from "@/lib/conversations/types";

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
