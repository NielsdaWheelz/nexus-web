"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { CollectionRowView, ReadStatus } from "@/lib/collections/types";
import type { LecternItem, LecternItemId, LecternSnapshot } from "@/lib/lectern/client";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { descriptorFromLecternItem } from "@/lib/player/playerSession";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { mediaKindIcon } from "@/lib/resources/resourceKind";
import styles from "./LecternPaneBody.module.css";

/** Pseudo-kind for the row lead icon; the Lectern snapshot carries only an
 * activation, not the underlying media kind. */
function iconKindForActivation(item: LecternItem): string {
  switch (item.activation.kind) {
    case "FooterAudio":
      return "podcast_episode";
    case "Readable":
      return "web_article";
    case "OpenPane":
      return "video";
  }
}

function itemConsumption(item: LecternItem): CollectionRowView["consumption"] {
  const { state, progress } = item.consumption;
  const fraction = progress.kind === "Present" ? progress.value : undefined;
  if (state === "Unread" && fraction === undefined) return undefined;
  const status: ReadStatus =
    state === "Finished" ? "finished" : state === "InProgress" ? "in_progress" : "unread";
  return fraction === undefined ? { status } : { status, fraction };
}

function snapshotItems(
  resourceData: LecternSnapshot | undefined,
  pendingSnapshot: LecternSnapshot | undefined,
): LecternItem[] {
  if (pendingSnapshot) return pendingSnapshot.items;
  return resourceData ? resourceData.items : [];
}

export default function LecternPaneBody() {
  const { resource, mutation, removeItem, setOrder } = useLectern();
  const { playAudio } = useGlobalPlayer();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  // A leaf never holds a snapshot cache: it renders the provider's optimistic
  // `presentedSnapshot` while a mutation is Pending, otherwise canonical data.
  const pendingSnapshot =
    mutation.kind === "Pending" ? mutation.presentedSnapshot : undefined;
  const items = snapshotItems(
    resource.status === "ready" ? resource.data : undefined,
    pendingSnapshot,
  );
  const status: "loading" | "error" | "ready" =
    resource.status === "ready"
      ? "ready"
      : resource.status === "error"
        ? "error"
        : "loading";

  const handleRemove = useCallback(
    (itemId: LecternItemId) => {
      void removeItem(itemId).catch((err) => {
        if (handleUnauthenticatedApiError(err)) return;
        setFeedback(toFeedback(err, { fallback: "Failed to remove from the Lectern" }));
      });
    },
    [removeItem],
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

  usePaneChromeOverride({
    folio: { kind: "count", value: items.length, unit: "on the lectern" },
    folioPending: status === "loading",
  });

  const rows: CollectionRowView[] = items.map((item) => {
    const actions: CollectionRowView["actions"] = [];
    if (item.activation.kind === "FooterAudio") {
      actions.push({
        id: "play",
        label: "Play",
        onSelect: () => playAudio(descriptorFromLecternItem(item)),
      });
    }
    actions.push({
      id: "remove-from-lectern",
      label: "Remove from Lectern",
      tone: "danger",
      onSelect: () => handleRemove(item.itemId),
    });
    return {
      id: item.itemId,
      kind: "media",
      primary: { kind: "link", href: item.href, paneTitleHint: item.title },
      lead: { icon: mediaKindIcon(iconKindForActivation(item)) },
      headline: { text: item.title },
      signals: item.subtitle.kind === "Present" ? [{ value: item.subtitle.value }] : [],
      consumption: itemConsumption(item),
      relatedMediaId: item.mediaId,
      actions,
      swipeActions: [
        {
          id: "remove-from-lectern",
          label: "Remove",
          icon: Trash2,
          tone: "danger",
          onActivate: () => handleRemove(item.itemId),
        },
      ],
    };
  });

  const byRowId = new Map(items.map((item) => [item.itemId as string, item]));

  const errorNotice =
    resource.status === "error"
      ? <FeedbackNotice feedback={toFeedback(resource.error, { fallback: "Failed to load the Lectern" })} />
      : feedback
        ? <FeedbackNotice feedback={feedback} />
        : undefined;

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
      error={errorNotice}
      empty={<p className={styles.emptyState}>Nothing on the lectern yet.</p>}
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
  );
}
