"use client";

import {
  AlertTriangle,
  Check,
  Clipboard,
  Network,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type {
  ConversationMemoryInspection,
  ConversationMessage,
} from "@/lib/conversations/types";
import { buildProvenanceModel } from "@/lib/conversations/provenance/buildModel";
import {
  assessProvenanceModel,
  statusSeverity,
  supportStatusLabel,
} from "@/lib/conversations/provenance/audit";
import {
  createProvenancePacket,
  formatProvenanceBrief,
  stringifyProvenancePacket,
  verifyProvenancePacket,
} from "@/lib/conversations/provenance/packet";
import type {
  ProvenanceAudit,
  ProvenanceClaim,
  ProvenanceModel,
  ProvenancePacketVerification,
  ProvenanceSource,
} from "@/lib/conversations/provenance/types";
import { truncateText } from "@/lib/conversations/display";
import styles from "./ConversationProvenancePanel.module.css";

interface ConversationProvenancePanelProps {
  messages: ConversationMessage[];
  memory?: ConversationMemoryInspection | null;
}

export default function ConversationProvenancePanel({
  messages,
  memory,
}: ConversationProvenancePanelProps) {
  const model = useMemo(
    () => buildProvenanceModel(messages, memory),
    [messages, memory],
  );
  const audit = useMemo(() => assessProvenanceModel(model), [model]);
  const packet = useMemo(() => createProvenancePacket(model), [model]);
  const packetVerification = useMemo(
    () => verifyProvenancePacket(packet),
    [packet],
  );
  const brief = useMemo(() => formatProvenanceBrief(model), [model]);
  const packetText = useMemo(() => stringifyProvenancePacket(model), [model]);
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<
    "idle" | "brief" | "packet" | "failed"
  >("idle");
  const activeSource =
    model.sources.find((source) => source.key === selectedSourceKey) ??
    model.sources[0] ??
    null;
  const hasSignals =
    model.claimCount > 0 ||
    model.retrievalCount > 0 ||
    model.memoryItemCount > 0;

  useEffect(() => {
    setCopyState("idle");
  }, [brief, packetText]);

  const handleCopy = async (kind: "brief" | "packet", payload: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(payload);
      setCopyState(kind);
    } catch {
      setCopyState("failed");
    }
  };

  if (!hasSignals) {
    return (
      <section className={styles.panel} aria-label="Conversation provenance">
        <div className={styles.empty}>
          <Network size={16} aria-hidden="true" />
          <span>No provenance signals yet.</span>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-label="Conversation provenance">
      <div className={styles.hero}>
        <div>
          <h3 className={styles.title}>Evidence map</h3>
          <p className={styles.subtitle}>
            {model.assistantCount} assistant turn
            {model.assistantCount === 1 ? "" : "s"} across {model.sourceCount} source
            {model.sourceCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className={styles.heroActions}>
          <button
            type="button"
            className={styles.briefButton}
            onClick={() => handleCopy("brief", brief)}
          >
            {copyState === "brief" ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Clipboard size={14} aria-hidden="true" />
            )}
            <span>{copyState === "brief" ? "Copied" : "Copy brief"}</span>
          </button>
          <button
            type="button"
            className={styles.briefButton}
            onClick={() => handleCopy("packet", packetText)}
          >
            {copyState === "packet" ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Clipboard size={14} aria-hidden="true" />
            )}
            <span>{copyState === "packet" ? "Copied" : "Copy packet"}</span>
          </button>
          {copyState === "failed" ? (
            <span className={styles.copyStatus} role="status">
              Copy failed
            </span>
          ) : null}
          <div
            className={styles.healthDial}
            aria-label={`Supported claims ${model.supportedClaimCount} of ${model.claimCount}`}
          >
            <span>{model.claimCount ? model.supportedClaimCount : 0}</span>
            <small>/ {model.claimCount}</small>
          </div>
        </div>
      </div>

      <div className={styles.metricGrid}>
        <Metric label="Claims" value={model.claimCount} icon={<ShieldCheck />} />
        <Metric label="Sources" value={model.sourceCount} icon={<Network />} />
        <Metric
          label="Risk"
          value={model.riskClaimCount + model.citationIssueCount}
          icon={<AlertTriangle />}
          tone={model.riskClaimCount + model.citationIssueCount > 0 ? "risk" : "neutral"}
        />
      </div>

      <AuditVerdict
        audit={audit}
        fingerprint={packet.fingerprint}
        packetVerification={packetVerification}
      />

      <section className={styles.section} aria-label="Verification coverage">
        <div className={styles.sectionHeader}>
          <h4>Verification</h4>
          <span>
            {model.includedRetrievalCount}/{model.retrievalCount} retrieved in prompt
          </span>
        </div>
        <VerificationBar model={model} />
        <div className={styles.factRow}>
          <span>{model.memoryItemCount} memory items</span>
          <span>{model.memorySourceCount} memory sources</span>
        </div>
      </section>

      {model.sources.length > 0 ? (
        <LineageGraph
          model={model}
          activeSourceKey={activeSource?.key ?? null}
          onSelectSource={setSelectedSourceKey}
        />
      ) : null}

      {model.riskClaims.length > 0 ? (
        <section className={styles.section} aria-label="Evidence risk queue">
          <div className={styles.sectionHeader}>
            <h4>Risk queue</h4>
            <span>{model.riskClaims.length} claims</span>
          </div>
          <ol className={styles.riskList}>
            {model.riskClaims.slice(0, 5).map((claim) => (
              <li key={claim.id} className={styles.riskItem}>
                <span className={styles.statusPill} data-status={claim.status}>
                  {supportStatusLabel(claim.status)}
                </span>
                <p>{claim.text}</p>
                <div className={styles.factRow}>
                  <span>Message #{claim.messageSeq}</span>
                  <span>{claim.evidenceCount} evidence links</span>
                  {claim.sourceLabels.slice(0, 2).map((label) => (
                    <span key={label}>{truncateText(label, 28)}</span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {model.sources.length > 0 ? (
        <section className={styles.section} aria-label="Source constellation">
          <div className={styles.sectionHeader}>
            <h4>Source constellation</h4>
            <span>{model.sources.length} nodes</span>
          </div>
          <div className={styles.sourceList}>
            {model.sources.slice(0, 8).map((source) => (
              <SourceCard
                key={source.key}
                source={source}
                active={activeSource?.key === source.key}
                onSelect={() => setSelectedSourceKey(source.key)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {activeSource ? <SourceDossier source={activeSource} /> : null}
    </section>
  );
}

function AuditVerdict({
  audit,
  fingerprint,
  packetVerification,
}: {
  audit: ProvenanceAudit;
  fingerprint: string;
  packetVerification: ProvenancePacketVerification;
}) {
  const issuePreview = audit.issues.slice(0, 3);
  const actionPreview = audit.nextActions.slice(0, 3);

  return (
    <section
      className={styles.auditPanel}
      data-level={audit.level}
      aria-label="Audit verdict"
    >
      <div className={styles.auditScore}>
        <span>{audit.score}</span>
        <small>/100</small>
      </div>
      <div className={styles.auditBody}>
        <div className={styles.auditHeader}>
          <h4>{audit.label}</h4>
          <span>{audit.summary}</span>
          <span
            className={styles.packetSeal}
            data-valid={packetVerification.ok ? "true" : "false"}
          >
            <code>{fingerprint}</code>
            <small>
              {packetVerification.ok ? "Packet verified" : "Packet changed"}
            </small>
          </span>
        </div>
        <div className={styles.coverageGrid} aria-label="Audit coverage">
          <CoverageMeter label="Retrieval" value={audit.coverage.retrieval} />
          <CoverageMeter label="Claims" value={audit.coverage.claims} />
        </div>
        {audit.strengths.length > 0 ? (
          <div className={styles.factRow}>
            {audit.strengths.map((strength) => (
              <span key={strength}>{strength}</span>
            ))}
          </div>
        ) : null}
        {issuePreview.length > 0 ? (
          <ol className={styles.auditIssueList}>
            {issuePreview.map((issue) => (
              <li key={issue.id} data-level={issue.severity}>
                <strong>{issue.label}</strong>
                <span>{issue.detail}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {actionPreview.length > 0 ? (
          <div className={styles.auditActions}>
            <span>Next actions</span>
            <ol>
              {actionPreview.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CoverageMeter({ label, value }: { label: string; value: number }) {
  const percent = Math.round(value * 100);

  return (
    <div className={styles.coverageMeter}>
      <span>{label}</span>
      <div className={styles.coverageTrack} aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <small>{percent}%</small>
    </div>
  );
}

function dedupeClaims(claims: ProvenanceClaim[]): ProvenanceClaim[] {
  const byId = new Map<string, ProvenanceClaim>();
  for (const claim of claims) {
    if (!byId.has(claim.id)) {
      byId.set(claim.id, claim);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      statusSeverity(b.status) - statusSeverity(a.status) ||
      a.messageSeq - b.messageSeq ||
      a.ordinal - b.ordinal,
  );
}

function LineageGraph({
  model,
  activeSourceKey,
  onSelectSource,
}: {
  model: ProvenanceModel;
  activeSourceKey: string | null;
  onSelectSource: (sourceKey: string) => void;
}) {
  const claimNodes = dedupeClaims(
    model.sources.flatMap((source) => source.claims),
  ).slice(0, 4);

  return (
    <section className={styles.lineage} aria-label="Evidence lineage graph">
      <div className={styles.sectionHeader}>
        <h4>Lineage</h4>
        <span>
          {model.sourceCount} sources - {model.claimCount} claims
        </span>
      </div>
      <div className={styles.lineageGrid}>
        <LineageColumn label="Sources">
          {model.sources.slice(0, 4).map((source) => (
            <button
              key={source.key}
              type="button"
              className={styles.lineageNode}
              data-kind="source"
              data-active={source.key === activeSourceKey ? "true" : "false"}
              aria-label={`Focus source ${source.label} in lineage`}
              onClick={() => onSelectSource(source.key)}
            >
              <strong>{source.label}</strong>
              <span>{source.claimEvidenceCount} claims</span>
            </button>
          ))}
        </LineageColumn>
        <LineageColumn label="Claims">
          {claimNodes.length > 0 ? (
            claimNodes.map((claim) => (
              <div
                key={claim.id}
                className={styles.lineageNode}
                data-kind="claim"
                data-status={claim.status}
              >
                <strong>{supportStatusLabel(claim.status)}</strong>
                <span>{truncateText(claim.text, 82)}</span>
              </div>
            ))
          ) : (
            <div className={styles.lineageEmptyNode}>No verified claims yet.</div>
          )}
        </LineageColumn>
      </div>
    </section>
  );
}

function LineageColumn({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.lineageColumn}>
      <span className={styles.lineageColumnLabel}>{label}</span>
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  tone = "neutral",
}: {
  label: string;
  value: number;
  icon: ReactElement;
  tone?: "neutral" | "risk";
}) {
  return (
    <div className={styles.metric} data-tone={tone}>
      {icon}
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}

function VerificationBar({ model }: { model: ProvenanceModel }) {
  const total = Math.max(model.claimCount, 1);
  const supported = (model.supportedClaimCount / total) * 100;
  const risk = (model.riskClaimCount / total) * 100;
  const neutral = Math.max(0, 100 - supported - risk);

  return (
    <div className={styles.bar} aria-hidden="true">
      <span style={{ flexBasis: `${supported}%` }} data-segment="supported" />
      <span style={{ flexBasis: `${neutral}%` }} data-segment="neutral" />
      <span style={{ flexBasis: `${risk}%` }} data-segment="risk" />
    </div>
  );
}

function SourceCard({
  source,
  active,
  onSelect,
}: {
  source: ProvenanceSource;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.sourceCard}
      data-active={active ? "true" : "false"}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className={styles.sourceHeader}>
        <span>{source.label}</span>
        <small>{source.type}</small>
      </span>
      <span className={styles.factRow}>
        {source.retrievalCount > 0 ? (
          <span>{source.includedRetrievalCount}/{source.retrievalCount} retrieved</span>
        ) : null}
        {source.claimEvidenceCount > 0 ? (
          <span>{source.claimEvidenceCount} claim links</span>
        ) : null}
        {source.memorySourceCount > 0 ? (
          <span>{source.memorySourceCount} memory refs</span>
        ) : null}
      </span>
      {source.snippets[0] ? (
        <span className={styles.sourceSnippet}>
          {truncateText(source.snippets[0], 180)}
        </span>
      ) : null}
    </button>
  );
}

function SourceDossier({ source }: { source: ProvenanceSource }) {
  const visibleClaims = source.claims.slice(0, 4);
  const external = source.href ? /^https?:\/\//.test(source.href) : false;

  return (
    <section className={styles.dossier} aria-label={`${source.label} dossier`}>
      <div className={styles.dossierHeader}>
        <div>
          <h4>{source.label}</h4>
          <p>
            {source.claimEvidenceCount} claim links, {source.memorySourceCount} memory refs
          </p>
        </div>
        {source.href ? (
          <a
            className={styles.openSourceLink}
            href={source.href}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer" : undefined}
          >
            Open source
          </a>
        ) : null}
      </div>

      {visibleClaims.length > 0 ? (
        <div className={styles.dossierBlock}>
          <div className={styles.dossierBlockHeader}>
            <span>Claim trail</span>
            <small>{source.claims.length} claims</small>
          </div>
          <ol className={styles.dossierList}>
            {visibleClaims.map((claim) => (
              <li key={claim.id}>
                <span className={styles.statusPill} data-status={claim.status}>
                  {supportStatusLabel(claim.status)}
                </span>
                <p>{claim.text}</p>
                <small>Message #{claim.messageSeq}</small>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {source.snippets.length > 0 ? (
        <div className={styles.dossierBlock}>
          <div className={styles.dossierBlockHeader}>
            <span>Snippets</span>
            <small>{source.snippets.length} captured</small>
          </div>
          <div className={styles.snippetStack}>
            {source.snippets.slice(0, 3).map((snippet) => (
              <blockquote key={snippet} className={styles.snippet}>
                {truncateText(snippet, 200)}
              </blockquote>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
