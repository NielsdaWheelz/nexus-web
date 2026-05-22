"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { apiFetch } from "@/lib/api/client";
import styles from "./page.module.css";

type IntelligenceStatus =
  | "current"
  | "stale"
  | "building"
  | "failed"
  | "unavailable";

interface IntelligenceEvidence {
  id: string;
  snippet: string;
}

interface IntelligenceClaim {
  id: string;
  claim_text: string;
  support_state: string;
  evidence: IntelligenceEvidence[];
}

interface IntelligenceSection {
  id: string;
  section_kind: string;
  title: string;
  body: string;
  ordinal: number;
  claims: IntelligenceClaim[];
}

interface IntelligenceCoverage {
  media_id: string | null;
  podcast_id: string | null;
  source_kind: "media" | "podcast";
  title: string;
  media_kind: string | null;
  readiness_state: string;
  chunk_count: number;
  included: boolean;
  exclusion_reason: string | null;
  source_updated_at: string | null;
}

interface IntelligenceBuild {
  build_id: string;
  status: string;
  phase: string;
  error_code: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}

interface LibraryIntelligence {
  library_id: string;
  status: IntelligenceStatus;
  source_count: number;
  chunk_count: number;
  updated_at: string | null;
  sections: IntelligenceSection[];
  coverage: IntelligenceCoverage[];
  build: IntelligenceBuild | null;
}

function formatLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function LibraryIntelligenceView({ libraryId }: { libraryId: string }) {
  const [intelligence, setIntelligence] = useState<LibraryIntelligence | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch<{ data: LibraryIntelligence }>(
        `/api/libraries/${libraryId}/intelligence`,
      );
      setIntelligence(response.data);
    } catch (err) {
      setError(toFeedback(err, { fallback: "Failed to load library intelligence" }));
    } finally {
      setLoading(false);
    }
  }, [libraryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await apiFetch<{ data: { build_id: string; status: string } }>(
        `/api/libraries/${libraryId}/intelligence/refresh`,
        { method: "POST" },
      );
      await load();
    } catch (err) {
      setError(toFeedback(err, { fallback: "Failed to refresh library intelligence" }));
    } finally {
      setRefreshing(false);
    }
  }, [libraryId, load]);

  const sections = intelligence?.sections ?? [];
  const updatedAt = formatDateTime(intelligence?.updated_at);
  const buildUpdatedAt = formatDateTime(
    intelligence?.build?.updated_at ?? intelligence?.build?.completed_at ?? null,
  );
  const buildStartedAt = formatDateTime(intelligence?.build?.started_at ?? null);
  const status = intelligence?.status ?? "unavailable";
  const buildStatus = intelligence?.build?.status ?? null;
  const statusText =
    status === "building"
      ? "Building"
      : status === "stale"
        ? "Stale"
        : status === "failed"
          ? "Failed"
          : formatLabel(status);

  return (
    <div className={styles.intelligenceView}>
      <div className={styles.intelligenceHeader}>
        <div className={styles.intelligenceTitleGroup}>
          <h2 className={styles.intelligenceTitle}>Intelligence</h2>
          <span className={styles.intelligenceStatus} data-status={status}>
            {statusText}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          leadingIcon={<RefreshCw size={16} aria-hidden="true" />}
        >
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {error ? <FeedbackNotice {...error} /> : null}

      {loading && !intelligence ? (
        <FeedbackNotice severity="info" title="Loading intelligence..." />
      ) : intelligence ? (
        <>
          <div className={styles.intelligenceStats}>
            <div className={styles.intelligenceStat}>
              <span className={styles.statLabel}>Sources</span>
              <strong>{intelligence.source_count.toLocaleString()}</strong>
            </div>
            <div className={styles.intelligenceStat}>
              <span className={styles.statLabel}>Chunks</span>
              <strong>{intelligence.chunk_count.toLocaleString()}</strong>
            </div>
            <div className={styles.intelligenceStat}>
              <span className={styles.statLabel}>Updated</span>
              <strong>{updatedAt ?? "Never"}</strong>
            </div>
          </div>

          {(status === "stale" ||
            status === "building" ||
            status === "failed" ||
            buildStatus) && (
            <div
              className={styles.buildState}
              data-status={status}
              role={status === "failed" ? "alert" : "status"}
            >
              <strong>
                {status === "stale"
                  ? "This intelligence is stale."
                  : status === "building"
                    ? "A build is running."
                    : status === "failed"
                      ? "The latest build failed."
                      : `Build ${formatLabel(buildStatus ?? "pending")}`}
              </strong>
              <span>
                {intelligence.build?.error ||
                  [
                    buildStartedAt ? `Started ${buildStartedAt}` : null,
                    buildUpdatedAt ? `Updated ${buildUpdatedAt}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") ||
                  "Refresh to rebuild this library intelligence."}
              </span>
            </div>
          )}

          <section className={styles.intelligenceSection}>
            <h3>Overview</h3>
            {sections.length === 0 ? (
              <p className={styles.mutedText}>
                No overview sections are available yet.
              </p>
            ) : (
              <div className={styles.sectionGrid}>
                {sections.map((section) => (
                  <article className={styles.overviewSection} key={section.id}>
                    <h4>{section.title}</h4>
                    <p>{section.body}</p>
                    {section.claims.length > 0 ? (
                      <ul>
                        {section.claims.map((claim) => (
                          <li key={claim.id}>
                            {claim.claim_text}
                            <span className={styles.claimState}>
                              {formatLabel(claim.support_state)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className={styles.intelligenceSection}>
            <h3>Coverage</h3>
            {intelligence.coverage.length > 0 ? (
              <dl className={styles.coverageList}>
                {intelligence.coverage.map((source) => (
                  <div
                    className={styles.coverageItem}
                    key={source.media_id ?? source.podcast_id ?? source.title}
                  >
                    <dt>{source.title}</dt>
                    <dd>
                      {[
                        formatLabel(source.source_kind),
                        source.media_kind ? formatLabel(source.media_kind) : null,
                        source.included
                          ? "Included"
                          : formatLabel(source.exclusion_reason ?? "excluded"),
                        `${source.chunk_count.toLocaleString()} chunks`,
                        formatLabel(source.readiness_state),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={styles.mutedText}>
                No coverage data is available yet.
              </p>
            )}
          </section>
        </>
      ) : (
        <FeedbackNotice
          severity="neutral"
          title="No intelligence has been built yet."
        />
      )}
    </div>
  );
}
