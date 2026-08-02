"use client";

import { Play } from "lucide-react";
import { useCallback, useId, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import ReadingSlateSection from "@/components/collections/ReadingSlateSection";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import {
  ApiError,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
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
import { runProgressReset } from "@/lib/consumption/progressReset";
import { descriptorFromLecternItem } from "@/lib/player/playerSession";
import { usePlayerCommands } from "@/lib/player/globalPlayer";
import {
  usePaneIsActive,
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

type LecternErrorOperation = "Load" | "Remove" | "Reorder" | "ResetProgress";

/** Exhaustive copy adapter for the Lectern pane's modeled error channel. */
function lecternErrorMessage(
  error: unknown,
  operation: LecternErrorOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const requestId = error.requestId;
  const title =
    operation === "Load"
      ? "Lectern couldn’t be loaded"
      : operation === "Remove"
        ? "Item wasn’t removed from Lectern"
        : operation === "Reorder"
          ? "Lectern wasn’t reordered"
          : "Progress wasn’t reset";
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and retry.",
        requestId,
      };
    case "E_TIMEOUT":
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The server took too long to respond. Retry the change.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Wait a moment, then retry.",
        requestId,
      };
    case "E_NOT_FOUND":
      if (operation !== "Remove" && operation !== "ResetProgress") throw error;
      return {
        tone: "Danger",
        title,
        message: "This item is no longer available. Review the current Lectern before trying again.",
        requestId,
      };
    case "E_MEDIA_NOT_FOUND":
      if (operation !== "ResetProgress") throw error;
      return {
        tone: "Danger",
        title,
        message: "This item is no longer available.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      if (operation === "Reorder") {
        return {
          tone: "Danger",
          title,
          message: "Lectern changed while you were reordering. Review the current order and try again.",
          requestId,
        };
      }
      if (operation === "ResetProgress") {
        return {
          tone: "Danger",
          title,
          message: "Progress can no longer be reset for this item.",
          requestId,
        };
      }
      throw error;
    default:
      throw error;
  }
}

export default function LecternPaneBody() {
  const {
    resource,
    mutation,
    placeItems,
    removeItem,
    setOrder,
    resetProgress,
  } = useLectern();
  const { playAudio } = usePlayerCommands();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const queueSectionId = useId();
  const paneRuntime = usePaneRuntime();
  const isPaneActive = usePaneIsActive();
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

  const presentFailure = useCallback(
    (error: unknown, operation: LecternErrorOperation) => {
      try {
        setFeedback(lecternErrorMessage(error, operation));
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
    },
    [],
  );

  const handleRemove = useCallback(
    (itemId: LecternItemId, triggerEl: HTMLButtonElement | null) => {
      const queueSection = document.getElementById(queueSectionId);
      const rows = queueSection
        ? Array.from(
            queueSection.querySelectorAll<HTMLElement>(
              "[data-collection-row-id]",
            ),
          )
        : [];
      const rowIndex = rows.findIndex(
        (row) => row.dataset.collectionRowId === itemId,
      );
      const nextPrimary =
        rowIndex >= 0
          ? (rows[rowIndex + 1] ?? rows[rowIndex - 1])?.querySelector<HTMLElement>(
              "[data-row-focusable]",
            )
          : undefined;
      setFeedback(null);
      void removeItem(itemId).catch((err) => {
        if (handleUnauthenticatedApiError(err)) return;
        presentFailure(err, "Remove");
      });
      if (triggerEl) {
        requestAnimationFrame(() => {
          (nextPrimary ?? queueSection)?.focus();
        });
      }
    },
    [presentFailure, queueSectionId, removeItem],
  );

  const handleReorder = useCallback(
    (itemIds: LecternItemId[]) => {
      setFeedback(null);
      void setOrder(itemIds).catch((err) => {
        if (handleUnauthenticatedApiError(err)) return;
        presentFailure(err, "Reorder");
      });
    },
    [presentFailure, setOrder],
  );

  const handleResetProgress = useCallback(
    async (item: LecternItem) => {
      setFeedback(null);
      try {
        const outcome = await runProgressReset({
          mediaId: item.mediaId,
          isVideo: item.kind === "video",
          confirmReset: (message) => window.confirm(message),
          resetProgress,
        });
        if (outcome.kind === "Cancelled") return;
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        presentFailure(error, "ResetProgress");
      }
    },
    [presentFailure, resetProgress],
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
        if (!isApiError(error) || isSameSystemApiDefect(error)) {
          setDefect({ error });
          return Promise.resolve({ kind: "Abandoned" });
        }
        return Promise.resolve({
          kind: "Rejected",
          error,
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
            if (!isApiError(error) || isSameSystemApiDefect(error)) {
              setDefect({ error });
              resolve({ kind: "Abandoned" });
              return;
            }
            resolve({
              kind: "Rejected",
              error,
            });
          },
        );
      });
    },
    [placeItems, resource.status],
  );

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: items.length, unit: "item" },
      pending: queueStatus === "loading",
    },
  });

  const queueRows = items.map((item) =>
    presentLecternItem(
      item,
      {
        remove: (triggerEl) => handleRemove(item.itemId, triggerEl),
        playback:
          item.activation.kind === "FooterAudio"
            ? {
                kind: "Available",
                execute: () => playAudio(descriptorFromLecternItem(item)),
              }
            : { kind: "Unavailable" },
        progressReset: item.consumption.progressResettable
          ? {
              kind: "Available",
              execute: () => handleResetProgress(item),
            }
          : { kind: "Unavailable" },
        progressResetBusy:
          mutation.kind === "Pending" &&
          mutation.attempt.kind === "ResetProgress" &&
          mutation.attempt.mediaId === item.mediaId,
      },
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
        content={lecternErrorMessage(resource.error, "Load")}
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: resource.retry }]}
      />
    ) : undefined;

  if (defect) throw defect.error;

  return (
    <PaneSurface
      opener={<SectionOpener heading="Lectern" />}
      state={
        feedback ? (
          <FeedbackNotice content={feedback} announcement="Assertive" />
        ) : undefined
      }
    >
      <section
        id={queueSectionId}
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
      </section>
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
