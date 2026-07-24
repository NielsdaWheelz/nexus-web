"use client";

import { Play } from "lucide-react";
import { useCallback, useId, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import ReadingSlateSection from "@/components/collections/ReadingSlateSection";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { ApiError, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { playbackVerb, presentLecternItem } from "@/lib/collections/presenters/lectern";
import type {
  ConsumptionInfo,
  LecternItem,
  LecternItemId,
  LecternSnapshot,
} from "@/lib/lectern/contract";
import {
  assumeMediaId,
  lecternActivityFacts,
} from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { descriptorFromLecternItem } from "@/lib/player/playerSession";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import {
  usePaneReturnReady,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { slateTargetId } from "@/lib/resonance/contract";
import type { ReadingSlateAccept } from "@/lib/resonance/useReadingSlate";
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
  const toast = useFeedback();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const queueSectionId = useId();
  const paneRuntime = usePaneRuntime();
  const isPaneActive = paneRuntime?.isActive ?? true;
  const paneId = paneRuntime?.paneId ?? "lectern";

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
  usePaneReturnReady(queueStatus !== "loading");

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

  const acceptSlateTarget = useCallback<ReadingSlateAccept>(
    (target, options) => {
      if (target.kind !== "Media") {
        return Promise.resolve({
          kind: "Rejected",
          error: new ApiError(
            400,
            "E_INVALID_TARGET",
            "Only media can be placed on the Lectern",
          ),
        });
      }
      if (resource.status !== "ready") {
        return Promise.resolve({
          kind: "Rejected",
          error: new ApiError(
            409,
            "E_LECTERN_NOT_READY",
            "The Lectern is still loading.",
          ),
        });
      }
      let underlying: ReturnType<typeof placeItems>;
      try {
        underlying = placeItems({
          mediaIds: [assumeMediaId(slateTargetId(target))],
          placement: { kind: "Last" },
          unknownObservation: {
            signal: options.signal,
            onUnknown: (error) =>
              options.onUnknown({
                error,
                recovery: {
                  kind: "External",
                  owner: "LecternMutationNotice",
                },
              }),
          },
        });
      } catch (error) {
        return Promise.resolve({
          kind: "Rejected",
          error: isApiError(error)
            ? error
            : new ApiError(
                0,
                "E_LECTERN_DEFECT",
                error instanceof Error ? error.message : "Lectern unavailable",
              ),
        });
      }
      return new Promise((resolve) => {
        let observing = true;
        const abandon = () => {
          if (!observing) return;
          observing = false;
          resolve({ kind: "Abandoned" });
        };
        options.signal.addEventListener("abort", abandon, { once: true });
        underlying.then(
          () => {
            if (!observing) return;
            observing = false;
            options.signal.removeEventListener("abort", abandon);
            toast.show({ severity: "success", title: "Added to Lectern" });
            resolve({ kind: "Accepted" });
          },
          (error: unknown) => {
            if (!observing) return;
            observing = false;
            options.signal.removeEventListener("abort", abandon);
            if (handleUnauthenticatedApiError(error)) {
              resolve({ kind: "Abandoned" });
              return;
            }
            resolve({
              kind: "Rejected",
              error: isApiError(error)
                ? error
                : new ApiError(
                    0,
                    "E_NETWORK",
                    error instanceof Error ? error.message : "Request failed",
                  ),
            });
          },
        );
      });
    },
    [placeItems, resource.status, toast],
  );

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: items.length, unit: "on the lectern" },
      pending: queueStatus === "loading",
    },
  });

  const queueRows = items.map((item) =>
    presentLecternItem(
      item,
      (triggerEl) => handleRemove(item.itemId, triggerEl),
      lecternActivityFacts(item),
    ),
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

  return (
    <PaneSurface state={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}>
      <PaneSection
        id={queueSectionId}
        title="On the lectern"
        aria-label="On the lectern"
        tabIndex={-1}
      >
        <CollectionView
          returnScope="Lectern.Items"
          rows={queueRows}
          status={queueStatus}
          ariaLabel="On the lectern"
          error={queueError}
          empty={<p className={styles.emptyState}>Nothing on the lectern yet.</p>}
          rowControls={queueControls}
          surface={false}
          sortable={{
            disabled: mutation.kind === "Pending",
            onReorder: (nextRows) => {
              const nextItems = nextRows
                .map((row) => byRowId.get(row.id))
                .filter((item): item is LecternItem => item !== undefined);
              if (nextItems.length === items.length) {
                handleReorder(nextItems.map((item) => item.itemId));
              }
            },
          }}
        />
      </PaneSection>
      <ReadingSlateSection
        returnScope="Lectern.ReadingSlate"
        destination={{ kind: "Lectern" }}
        paneId={paneId}
        isActive={isPaneActive}
        accept={acceptSlateTarget}
      />
    </PaneSurface>
  );
}
