import { truncateText } from "@/lib/conversations/display";
import type { MessageClaimSupportStatus } from "@/lib/conversations/types";
import type {
  ProvenanceAudit,
  ProvenanceAuditIssue,
  ProvenanceAuditLevel,
  ProvenanceClaim,
  ProvenanceModel,
} from "./types";

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

export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
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
