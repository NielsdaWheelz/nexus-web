"use client";

import { Play } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { LECTERN_RECENT_LIMIT, lecternRecentResource } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  playbackVerb,
  presentLecternItem,
  presentRecentConsumptionItem,
} from "@/lib/collections/presenters/lectern";
import { getRecentConsumption } from "@/lib/lectern/client";
import type {
  ConsumptionInfo,
  LecternItem,
  LecternItemId,
  LecternSnapshot,
  MediaId,
  RecentConsumptionSnapshot,
} from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { descriptorFromLecternItem } from "@/lib/player/playerSession";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import styles from "./LecternPaneBody.module.css";

function PlaybackButton({
  title,
  consumption,
  onPlay,
}: {
  title: string;
  consumption: ConsumptionInfo;
  onPlay: () => void;
}) {
  const verb = playbackVerb(consumption);
  return (
    <Button
      variant="secondary"
      size="sm"
      className={styles.rowAction}
      aria-label={`${verb} ${title}`}
      leadingIcon={<Play size={14} aria-hidden="true" />}
      onClick={onPlay}
    >
      {verb}
    </Button>
  );
}

function snapshotItems(
  resourceData: LecternSnapshot | undefined,
  pendingSnapshot: LecternSnapshot | undefined,
): LecternItem[] {
  if (pendingSnapshot) return pendingSnapshot.items;
  return resourceData ? resourceData.items : [];
}

export default function LecternPaneBody() {
  const { resource, mutation, placeItems, removeItem, setOrder } = useLectern();
  const { playAudio } = useGlobalPlayer();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [pendingQueueFocus, setPendingQueueFocus] = useState<LecternItemId | null>(null);
  const queueSectionId = useId();
  const isPaneActive = usePaneRuntime()?.isActive ?? true;
  const wasPaneActiveRef = useRef(isPaneActive);
  const [recentRefreshVersion, setRecentRefreshVersion] = useState(0);
  const recentResource = useResource<
    RecentConsumptionSnapshot,
    { limit: number; refreshVersion: number }
  >({
    descriptor: lecternRecentResource,
    params: { limit: LECTERN_RECENT_LIMIT, refreshVersion: recentRefreshVersion },
    load: ({ limit }, signal) => getRecentConsumption(limit, signal),
  });

  useEffect(() => {
    const becameActive = isPaneActive && !wasPaneActiveRef.current;
    wasPaneActiveRef.current = isPaneActive;
    if (becameActive) {
      setRecentRefreshVersion((version) => version + 1);
    }
  }, [isPaneActive]);

  // A leaf never holds a snapshot cache: it renders the provider's optimistic
  // `presentedSnapshot` while a mutation is Pending, otherwise canonical data.
  const pendingSnapshot =
    mutation.kind === "Pending" ? mutation.presentedSnapshot : undefined;
  const items = snapshotItems(
    resource.status === "ready" ? resource.data : undefined,
    pendingSnapshot,
  );
  const queueStatus: "loading" | "error" | "ready" =
    resource.status === "ready"
      ? "ready"
      : resource.status === "error"
        ? "error"
        : "loading";

  useEffect(() => {
    if (pendingQueueFocus === null) return;
    const frame = requestAnimationFrame(() => {
      const section = document.getElementById(queueSectionId);
      const row = Array.from(
        section?.querySelectorAll<HTMLElement>("[data-collection-row-id]") ?? [],
      ).find((candidate) => candidate.dataset.collectionRowId === pendingQueueFocus);
      const primary = row?.querySelector<HTMLElement>("[data-row-focusable]");
      if (!primary) return;
      primary.focus();
      setPendingQueueFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [items, pendingQueueFocus, queueSectionId]);

  const handleRemove = useCallback(
    (itemId: LecternItemId, triggerEl: HTMLButtonElement | null) => {
      const row = triggerEl?.closest<HTMLElement>("[data-collection-row-id]");
      const list = row?.closest('[role="list"]');
      const rows = list
        ? Array.from(list.querySelectorAll<HTMLElement>("[data-collection-row-id]"))
        : [];
      const rowIndex = row ? rows.indexOf(row) : -1;
      const nextPrimary =
        rowIndex >= 0
          ? (rows[rowIndex + 1] ?? rows[rowIndex - 1])?.querySelector<HTMLElement>(
              "[data-row-focusable]",
            )
          : undefined;
      void removeItem(itemId).catch((err) => {
        if (handleUnauthenticatedApiError(err)) return;
        setFeedback(toFeedback(err, { fallback: "Failed to remove from the Lectern" }));
      });
      if (triggerEl) {
        requestAnimationFrame(() => {
          (nextPrimary ?? document.getElementById(queueSectionId))?.focus();
        });
      }
    },
    [queueSectionId, removeItem],
  );

  const handleReorder = useCallback(
    (itemIds: LecternItemId[]) => {
      void setOrder(itemIds).catch((err) => {
        if (handleUnauthenticatedApiError(err)) return;
        setFeedback(toFeedback(err, { fallback: "Failed to reorder the Lectern" }));
      });
    },
    [setOrder],
  );

  const handleAdd = useCallback(
    (mediaId: MediaId) => {
      void placeItems({ mediaIds: [mediaId], placement: { kind: "Last" } })
        .then((result) => {
          if (result.outcome.kind !== "Placed" || result.outcome.itemIds.length === 0) return;
          setPendingQueueFocus(result.outcome.itemIds[0]);
        })
        .catch((err) => {
          if (handleUnauthenticatedApiError(err)) return;
          setFeedback(toFeedback(err, { fallback: "Failed to add to the Lectern" }));
        });
    },
    [placeItems],
  );

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: items.length, unit: "on the lectern" },
      pending: queueStatus === "loading",
    },
  });

  const queueRows = items.map((item) =>
    presentLecternItem(item, (triggerEl) => handleRemove(item.itemId, triggerEl)),
  );
  const queueControls = Object.fromEntries(
    items.flatMap((item) => {
      if (item.activation.kind !== "FooterAudio") return [];
      return [
        [
          item.itemId,
          <PlaybackButton
            key="play"
            title={item.title}
            consumption={item.consumption}
            onPlay={() => playAudio(descriptorFromLecternItem(item))}
          />,
        ],
      ];
    }),
  );

  const byRowId = new Map(items.map((item) => [item.itemId as string, item]));

  const queueError =
    resource.status === "error" ? (
      <FeedbackNotice
        feedback={toFeedback(resource.error, { fallback: "Failed to load the Lectern" })}
      >
        <Button variant="secondary" size="sm" onClick={resource.retry}>
          Retry
        </Button>
      </FeedbackNotice>
    ) : undefined;

  const queuedMediaIds = new Set(items.map((item) => item.mediaId as string));
  const queueSettled = resource.status === "ready" || resource.status === "error";
  const recentItems =
    recentResource.status === "ready" && queueSettled
      ? recentResource.data.items
          .filter((item) => !queuedMediaIds.has(item.mediaId))
          .slice(0, 6)
      : [];
  const recentStatus: "loading" | "error" | "ready" =
    recentResource.status === "error"
      ? "error"
      : recentResource.status === "ready" && queueSettled
        ? "ready"
        : "loading";
  const recentRows = recentItems.map((item) =>
    presentRecentConsumptionItem(item, {
      canAdd: resource.status === "ready" && mutation.kind === "Idle",
      onAdd: handleAdd,
    }),
  );
  const recentControls = Object.fromEntries(
    recentItems.flatMap((item) => {
      if (item.playerDescriptor.kind !== "Present") return [];
      const descriptor = item.playerDescriptor.value;
      return [
        [
          item.mediaId,
          <PlaybackButton
            key="play"
            title={item.title}
            consumption={item.consumption}
            onPlay={() => playAudio(descriptor)}
          />,
        ],
      ];
    }),
  );

  const recentError =
    recentResource.status === "error" ? (
      <FeedbackNotice
        feedback={toFeedback(recentResource.error, {
          fallback: "Failed to load recent reading and listening",
        })}
      >
        <Button variant="secondary" size="sm" onClick={recentResource.retry}>
          Retry recent activity
        </Button>
      </FeedbackNotice>
    ) : undefined;
  const recentEmpty =
    recentResource.status === "ready" && recentResource.data.items.length > 0 ? (
      <p className={styles.emptyState}>No other recent items to show.</p>
    ) : (
      <p className={styles.emptyState}>Nothing read or listened to yet.</p>
    );

  return (
    <PaneSurface state={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}>
      <PaneSection
        id={queueSectionId}
        title="On the lectern"
        aria-label="On the lectern"
        tabIndex={-1}
      >
        <CollectionView
          rows={queueRows}
          view="list"
          density="comfortable"
          status={queueStatus}
          ariaLabel="On the lectern"
          error={queueError}
          empty={<p className={styles.emptyState}>Nothing on the lectern yet.</p>}
          rowControls={queueControls}
          rowActionsVisibility="always"
          surface={false}
          sortable={{
            className: styles.lecternList,
            onReorder: (nextRows) => {
              const nextItems = nextRows
                .map((row) => byRowId.get(row.id))
                .filter((item): item is LecternItem => item !== undefined);
              if (nextItems.length === items.length) {
                handleReorder(nextItems.map((item) => item.itemId));
              }
            },
            renderControls: (row, { handleProps }) => (
              <Button
                variant="secondary"
                size="sm"
                className={styles.dragHandle}
                aria-label={`Reorder ${row.headline.text}`}
                {...handleProps.attributes}
                {...handleProps.listeners}
              >
                ⋮⋮
              </Button>
            ),
          }}
        />
      </PaneSection>
      <PaneSection title="Recently read & listened" aria-label="Recently read and listened">
        <CollectionView
          rows={recentRows}
          view="list"
          density="comfortable"
          status={recentStatus}
          ariaLabel="Recently read and listened"
          error={recentError}
          empty={recentEmpty}
          rowControls={recentControls}
          rowActionsVisibility="always"
          surface={false}
        />
      </PaneSection>
    </PaneSurface>
  );
}
