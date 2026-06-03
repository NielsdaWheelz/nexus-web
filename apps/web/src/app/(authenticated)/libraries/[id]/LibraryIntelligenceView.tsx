"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import { formatDisplayDate, formatDisplayNumber } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
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

function formatDateTime(
  value: string | null | undefined,
  display: RenderEnvironment,
): string | null {
  if (!value) {
    return null;
  }
  return formatDisplayDate(value, display, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }) ?? value;
}

export default function LibraryIntelligenceView({ libraryId }: { libraryId: string }) {
  const display = useRenderEnvironment();
  const [intelligence, setIntelligence] = useState<LibraryIntelligence | null>(
    null,
  );
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const intelligenceResource = useResource<{ data: LibraryIntelligence }>({
    cacheKey: `library-intelligence:${libraryId}:${refreshVersion}`,
    path: () => `/api/libraries/${libraryId}/intelligence`,
  });
  const loading = intelligenceResource.status === "loading";

  useEffect(() => {
    if (intelligenceResource.status === "ready") {
      setIntelligence(intelligenceResource.data.data);
      setError(null);
      setRefreshing(false);
      return;
    }

    if (intelligenceResource.status === "error") {
      setError(
        toFeedback(intelligenceResource.error, {
          fallback: "Failed to load library intelligence",
        }),
      );
      setRefreshing(false);
    }
  }, [intelligenceResource]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await apiFetch<{ data: { build_id: string; status: string } }>(
        `/api/libraries/${libraryId}/intelligence/refresh`,
        { method: "POST" },
      );
      setRefreshVersion((version) => version + 1);
    } catch (err) {
      setError(
        toFeedback(err, {
          fallback: "Failed to refresh library intelligence",
        }),
      );
      setRefreshing(false);
    }
  }, [libraryId]);

  const currentIntelligence =
    intelligence?.library_id === libraryId ? intelligence : null;
  const sections = currentIntelligence?.sections ?? [];
  const updatedAt = formatDateTime(currentIntelligence?.updated_at, display);
  const buildUpdatedAt = formatDateTime(
    currentIntelligence?.build?.updated_at ??
      currentIntelligence?.build?.completed_at ??
      null,
    display,
  );
  const buildStartedAt = formatDateTime(
    currentIntelligence?.build?.started_at ?? null,
    display,
  );
  const status = currentIntelligence?.status ?? "unavailable";
  const buildStatus = currentIntelligence?.build?.status ?? null;
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

      {loading && !currentIntelligence ? (
        <PaneLoadingState label="Loading intelligence…" />
      ) : currentIntelligence ? (
        <>
          <div className={styles.intelligenceStats}>
            <div className={styles.intelligenceStat}>
              <span className={styles.statLabel}>Sources</span>
              <strong>
                {formatDisplayNumber(currentIntelligence.source_count, display)}
              </strong>
            </div>
            <div className={styles.intelligenceStat}>
              <span className={styles.statLabel}>Chunks</span>
              <strong>
                {formatDisplayNumber(currentIntelligence.chunk_count, display)}
              </strong>
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
                {currentIntelligence.build?.error ||
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
            {currentIntelligence.coverage.length > 0 ? (
              <dl className={styles.coverageList}>
                {currentIntelligence.coverage.map((source) => (
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
                        `${formatDisplayNumber(source.chunk_count, display)} chunks`,
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
