"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Pill from "@/components/ui/Pill";
import ResourceRow from "@/components/ui/ResourceRow";
import ResourceThumb from "@/components/ui/ResourceThumb";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import type { CollectionDensity } from "@/lib/collections/collectionViewState";
import type { CollectionRowView } from "@/lib/collections/types";
import { useRelatedMedia } from "@/lib/resonance/useRelatedMedia";
import { formatRelativeTime } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useRowSwipe } from "@/lib/ui/useRowSwipe";
import ConnectionRail from "./ConnectionRail";
import ReadStateBadge from "./ReadStateBadge";
import styles from "./CollectionRow.module.css";

/**
 * Renders one `CollectionRowView` through the `ResourceRow` primitive. Owns the
 * in-row connection-rail expansion and the read-state/progress affordance.
 * `panel`/`controls` are pane-owned nodes (transcript form, library picker) the
 * presenter cannot emit.
 */
export default function CollectionRow({
  row,
  density,
  as = "li",
  panel,
  controls,
  actionsVisibility = "hover",
  viewTransitionName,
}: {
  row: CollectionRowView;
  density: CollectionDensity;
  as?: "li" | "div";
  panel?: ReactNode;
  controls?: ReactNode;
  actionsVisibility?: "hover" | "always";
  viewTransitionName?: string;
}) {
  const [showPeers, setShowPeers] = useState(false);
  const env = useRenderEnvironment();
  const now = new Date(env.currentInstant);
  const connections = row.connections;
  const hasConnections = connections !== undefined && connections.total > 0;
  const relatedMediaId =
    row.relatedMediaId === undefined
      ? row.kind === "media"
        ? row.id
        : null
      : row.relatedMediaId;
  const canShowRelated = relatedMediaId !== null;
  const related = useRelatedMedia(canShowRelated && showPeers ? relatedMediaId : null);
  const relatedPeers =
    related.data && related.data.length > 0 ? related.data : (row.related ?? []);
  const relatedStatus =
    canShowRelated && showPeers
      ? related.loading
        ? "loading"
        : related.error
          ? "error"
          : "ready"
      : row.related && row.related.length > 0
        ? "ready"
        : "idle";
  const hasPeerAffordance = hasConnections || canShowRelated || relatedPeers.length > 0;
  const swipeAction = row.swipeActions?.[0];
  const swipe = useRowSwipe(swipeAction ? () => swipeAction.onActivate() : undefined);

  const eyebrow = row.recency ? formatRelativeTime(row.recency.at, env, now) : null;

  const headline = row.headline.segments
    ? row.headline.segments.map((seg, i) =>
        seg.emphasized ? (
          <mark key={i} className={styles.mark}>
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )
    : row.headline.text;

  const meta = row.signals.length ? (
    <span className={styles.signalList}>
      {row.signals.map((s, index) => (
        <span className={styles.signalItem} key={`${s.label ?? "value"}-${s.value}-${index}`}>
          {index > 0 ? (
            <span className={styles.signalSeparator} aria-hidden="true">
              ·
            </span>
          ) : null}
          <span>{s.label ? `${s.label} ${s.value}` : s.value}</span>
        </span>
      ))}
    </span>
  ) : undefined;

  const showRead = row.consumption !== undefined;
  const consumptionActivity = row.kind === "podcast_episode" ? "listening" : "reading";
  const badges =
    showRead || row.status ? (
      <>
        {row.consumption ? (
          <ReadStateBadge consumption={row.consumption} activity={consumptionActivity} />
        ) : null}
        {row.status ? <Pill tone={row.status.tone}>{row.status.label}</Pill> : null}
      </>
    ) : undefined;

  const progress =
    row.consumption?.status === "in_progress" && row.consumption.fraction !== undefined ? (
      <span
        className={styles.progress}
        role="progressbar"
        aria-label={`${consumptionActivity === "listening" ? "Listening" : "Reading"} progress for ${row.headline.text}`}
        aria-valuenow={Math.round(row.consumption.fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className={styles.progressFill} style={{ width: `${row.consumption.fraction * 100}%` }} />
      </span>
    ) : null;

  const trailing =
    progress ? (
      <span className={styles.trailing}>
        {progress}
      </span>
    ) : undefined;

  const secondary = hasPeerAffordance ? (
    <button
      type="button"
      className={styles.connections}
      aria-expanded={showPeers}
      onClick={() => setShowPeers((v) => !v)}
    >
      {hasConnections ? `↳ ${connections.total} connected` : "Related"}
    </button>
  ) : undefined;

  const actions =
    controls || row.actions?.length ? (
      <>
        {controls ? (
          <div className={styles.controls} data-collection-row-controls="true">
            {controls}
          </div>
        ) : null}
        {row.actions?.length ? (
          <ActionMenu
            options={row.actions}
            label={`Actions for ${row.headline.text}`}
            triggerAttributes={{ tabIndex: -1, "data-row-action-trigger": "true" }}
          />
        ) : null}
      </>
    ) : undefined;

  const expanded =
    (showPeers && hasPeerAffordance) || panel ? (
      <>
        {showPeers && hasPeerAffordance ? (
          <ConnectionRail
            peers={connections?.topPeers ?? []}
            related={relatedPeers}
            relatedStatus={relatedStatus}
          />
        ) : null}
        {panel}
      </>
    ) : undefined;
  const rootStyle: CSSProperties | undefined =
    viewTransitionName || swipe.offset || swipe.handlers
      ? {
          viewTransitionName,
          transform: swipe.offset ? `translateX(${swipe.offset}px)` : undefined,
          touchAction: swipe.handlers ? "pan-y" : undefined,
        }
      : undefined;
  const rootProps = {
    ...swipe.handlers,
    "data-collection-row-id": row.id,
    "data-view-transition-part": "row",
    style: rootStyle,
  };

  return (
    <ResourceRow
      as={as}
      density={density}
      actionsVisibility={actionsVisibility}
      primary={row.primary}
      selected={row.selected}
      rootProps={rootProps}
      leading={
        <ResourceThumb spec={row.lead} alt="" size={density === "compact" ? "sm" : "md"} />
      }
      title={<>{headline}</>}
      description={row.description}
      eyebrow={
        eyebrow ? (
          <time className={styles.recency} dateTime={row.recency?.at}>
            {eyebrow}
          </time>
        ) : undefined
      }
      badges={badges}
      meta={meta}
      contributors={
        row.contributors ? (
          <ContributorCreditList
            className={styles.contributorList}
            credits={row.contributors.credits}
            showRole={row.contributors.showRole}
            maxVisible={
              density === "compact"
                ? Math.min(row.contributors.maxVisible, 2)
                : row.contributors.maxVisible
            }
          />
        ) : undefined
      }
      trailing={trailing}
      secondary={secondary}
      actions={actions}
      expanded={expanded}
    />
  );
}
