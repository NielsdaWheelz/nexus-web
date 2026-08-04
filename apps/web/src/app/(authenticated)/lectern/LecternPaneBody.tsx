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

type LecternErrorOperation = "Load" | "Reorder";

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
      : "Lectern wasn’t reordered";
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
    case "E_INVALID_REQUEST":
      if (operation === "Reorder") {
        return {
          tone: "Danger",
          title,
          message: "Lectern changed while you were reordering. Review the current order and try again.",
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
    setOrder,
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
    presentLecternItem(item, lecternActivityFacts(item)),
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
