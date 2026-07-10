"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { CollectionRowView, ReadStatus } from "@/lib/collections/types";
import {
  CONSUMPTION_QUEUE_UPDATED_EVENT,
  fetchConsumptionQueue,
  removeConsumptionQueueItem,
  reorderConsumptionQueue,
  type ConsumptionQueueItem,
} from "@/lib/player/consumptionQueueClient";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import styles from "./LecternPaneBody.module.css";

const AUDIO_KINDS = ["podcast_episode", "video"];

function itemConsumption(item: ConsumptionQueueItem): CollectionRowView["consumption"] {
  let fraction: number | null | undefined = item.progress_fraction;
  if (fraction == null && AUDIO_KINDS.includes(item.kind) && item.listening_state) {
    const durationMs = (item.duration_seconds ?? 0) * 1000;
    fraction = durationMs > 0 ? item.listening_state.position_ms / durationMs : null;
  }
  if (fraction == null) return undefined;
  const clamped = Math.max(0, Math.min(1, fraction));
  const status: ReadStatus = clamped >= 0.95 ? "finished" : clamped > 0 ? "in_progress" : "unread";
  return { status, fraction: clamped };
}

export default function LecternPaneBody() {
  const [items, setItems] = useState<ConsumptionQueueItem[]>([]);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchConsumptionQueue();
      setItems(next);
      setStatus("ready");
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setStatus("error");
      setFeedback(toFeedback(err, { fallback: "Failed to load the Lectern" }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Stay in sync when the queue changes elsewhere (player, action menus, launcher).
  useEffect(() => {
    const onUpdate = () => void refresh();
    window.addEventListener(CONSUMPTION_QUEUE_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(CONSUMPTION_QUEUE_UPDATED_EVENT, onUpdate);
  }, [refresh]);

  const handleRemove = useCallback(async (itemId: string) => {
    try {
      const next = await removeConsumptionQueueItem(itemId);
      setItems(next);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setFeedback(toFeedback(err, { fallback: "Failed to remove from the Lectern" }));
    }
  }, []);

  const handleReorder = useCallback(
    async (nextItems: ConsumptionQueueItem[]) => {
      const previous = items;
      setItems(nextItems.map((item, index) => ({ ...item, position: index })));
      try {
        const confirmed = await reorderConsumptionQueue(nextItems.map((item) => item.item_id));
        setItems(confirmed);
      } catch (err) {
        setItems(previous);
        if (handleUnauthenticatedApiError(err)) return;
        setFeedback(toFeedback(err, { fallback: "Failed to reorder the Lectern" }));
      }
    },
    [items],
  );

  usePaneChromeOverride({
    folio: { kind: "count", value: items.length, unit: "on the lectern" },
    folioPending: status === "loading",
  });

  const rows: CollectionRowView[] = items.map((item) => ({
    id: item.item_id,
    kind: "media",
    primary: { kind: "link", href: item.reader_href, paneTitleHint: item.title },
    lead: { icon: mediaKindIcon(item.kind) },
    headline: { text: item.title },
    signals: item.podcast_title ? [{ value: item.podcast_title }] : [],
    consumption: itemConsumption(item),
    relatedMediaId: item.media_id,
    actions: [
      {
        id: "remove-from-lectern",
        label: "Remove from Lectern",
        tone: "danger",
        onSelect: () => void handleRemove(item.item_id),
      },
    ],
    swipeActions: [
      {
        id: "remove-from-lectern",
        label: "Remove",
        icon: Trash2,
        tone: "danger",
        onActivate: () => void handleRemove(item.item_id),
      },
    ],
  }));

  const byRowId = new Map(items.map((item) => [item.item_id, item]));

  return (
    <CollectionView
      rows={rows}
      view="list"
      density="comfortable"
      status={status}
      ariaLabel="Lectern"
      opener={
        rows.length > 0 ? <p className={styles.lecternKicker}>On the lectern</p> : undefined
      }
      notice={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}
      error={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}
      empty={<p className={styles.emptyState}>Nothing on the lectern yet.</p>}
      sortable={{
        className: styles.lecternList,
        onReorder: (nextRows) => {
          const nextItems = nextRows
            .map((row) => byRowId.get(row.id))
            .filter((item): item is ConsumptionQueueItem => item !== undefined);
          if (nextItems.length === items.length) {
            void handleReorder(nextItems);
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
  );
}
