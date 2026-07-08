"use client";

import { ArrowRight, GitMerge, X } from "lucide-react";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import { contributorAuthorHref } from "@/lib/contributors/routes";
import type {
  ContributorReconciliationCandidate,
  ContributorReconciliationContributor,
} from "@/lib/contributors/types";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import styles from "./ContributorReconciliationCandidates.module.css";

type BusyCandidate = { id: string; action: "accept" | "reject" } | null;

interface ContributorReconciliationCandidatesProps {
  title: string;
  subtitle?: string;
  status: "loading" | "error" | "ready";
  candidates: ContributorReconciliationCandidate[];
  error?: FeedbackContent | null;
  busyCandidate: BusyCandidate;
  emptyTitle: string;
  emptyMessage: string;
  onAccept: (candidate: ContributorReconciliationCandidate) => void;
  onReject: (candidate: ContributorReconciliationCandidate) => void;
}

export default function ContributorReconciliationCandidates({
  title,
  subtitle,
  status,
  candidates,
  error,
  busyCandidate,
  emptyTitle,
  emptyMessage,
  onAccept,
  onReject,
}: ContributorReconciliationCandidatesProps) {
  return (
    <section className={styles.section} aria-label={title}>
      <div className={styles.header}>
        <div className={styles.headerCopy}>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {status === "ready" ? <Pill tone="subtle">{candidates.length}</Pill> : null}
      </div>

      {status === "loading" ? (
        <FeedbackNotice severity="neutral" title={title} message="Loading proposals..." />
      ) : status === "error" && error ? (
        <FeedbackNotice feedback={error} />
      ) : status === "ready" && candidates.length === 0 ? (
        <FeedbackNotice severity="neutral" title={emptyTitle} message={emptyMessage} />
      ) : status === "ready" ? (
        <div className={styles.list}>
          {candidates.map((candidate) => {
            const acceptBusy =
              busyCandidate?.id === candidate.id && busyCandidate.action === "accept";
            const rejectBusy =
              busyCandidate?.id === candidate.id && busyCandidate.action === "reject";
            return (
              <article key={candidate.id} className={styles.item}>
                <div className={styles.summary}>
                  <ContributorLink contributor={candidate.source_contributor} />
                  <span className={styles.arrow} aria-hidden="true">
                    <ArrowRight size={16} />
                  </span>
                  <ContributorLink contributor={candidate.target_contributor} />
                  <Pill tone={toneForStatus(candidate.status)}>{candidate.status}</Pill>
                  <Pill tone="accent">{candidate.score}</Pill>
                </div>

                <div className={styles.meta}>
                  <div className={styles.evidenceRow}>
                    {signalLabels(candidate).map((signal) => (
                      <Pill key={`${candidate.id}:${signal}`} tone="subtle">
                        {signal}
                      </Pill>
                    ))}
                  </div>
                  {sharedNames(candidate).length > 0 ? (
                    <div className={styles.evidenceRow}>
                      {sharedNames(candidate).map((name) => (
                        <Pill key={`${candidate.id}:name:${name}`} tone="subtle">
                          {name}
                        </Pill>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    leadingIcon={<GitMerge size={14} aria-hidden="true" />}
                    loading={acceptBusy}
                    disabled={acceptBusy || rejectBusy}
                    onClick={() => onAccept(candidate)}
                  >
                    Accept merge
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<X size={14} aria-hidden="true" />}
                    loading={rejectBusy}
                    disabled={acceptBusy || rejectBusy}
                    onClick={() => onReject(candidate)}
                  >
                    Reject
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function ContributorLink({
  contributor,
}: {
  contributor: ContributorReconciliationContributor;
}) {
  const paneRouter = usePaneRouter();
  const href = contributorAuthorHref(contributor.handle);

  return (
    <a
      href={href}
      className={styles.contributorLink}
      onClick={(event) => {
        event.preventDefault();
        paneRouter.push(href);
      }}
    >
      <span className={styles.contributorName}>{contributor.display_name}</span>
      <span className={styles.contributorHandle}>{contributor.handle}</span>
    </a>
  );
}

function toneForStatus(
  status: string,
): "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "subtle" {
  if (status === "pending") return "warning";
  if (status === "accepted") return "success";
  if (status === "rejected") return "danger";
  return "subtle";
}

function signalLabels(candidate: ContributorReconciliationCandidate): string[] {
  return candidate.evidence.signals
    .map((signal) => humanize(signal))
    .filter((signal) => signal.length > 0);
}

function sharedNames(candidate: ContributorReconciliationCandidate): string[] {
  return Array.from(
    new Set([
      ...candidate.evidence.shared_confirmed_aliases,
      ...candidate.evidence.shared_aliases,
    ]),
  ).filter((value) => value.length > 0);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
