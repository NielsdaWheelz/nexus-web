"use client";

import { Play } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import QuickReadsSection from "@/components/collections/QuickReadsSection";
import SuggestionsSection, {
  type SuggestionAccept,
} from "@/components/collections/SuggestionsSection";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import SelectField from "@/components/ui/SelectField";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneCollectionBar from "@/components/workspace/PaneCollectionBar";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  playbackVerb,
  presentLecternItem,
} from "@/lib/collections/presenters/lectern";
import {
  assumeMediaId,
  parseLecternItemId,
  type LecternItem,
} from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import {
  CANONICAL_LECTERN_VIEW,
  LECTERN_SORT_OPTION_IDS,
  decodeLecternView,
  encodeLecternView,
  lecternSortOptionLabel,
  lecternSortOptionOf,
  lecternViewForSortOption,
  orderLecternItems,
  type DecodedLecternView,
  type LecternSortOptionId,
} from "@/lib/lectern/view";
import { usePlayerCommands } from "@/lib/player/playerRuntime";
import { usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { suggestionTargetId } from "@/lib/suggestions";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./LecternPaneBody.module.css";

const UNIT = { singular: "item", plural: "items" };

/** What the local filter matches: the title and, for an episode, its show. */
function filterFields(item: LecternItem): string[] {
  const subtitle =
    item.activation.kind === "FooterAudio"
      ? item.activation.descriptor.subtitle
      : null;
  return subtitle?.kind === "Present"
    ? [item.mediaSummary.title, subtitle.value]
    : [item.mediaSummary.title];
}

/** Modeled failures become notices; anything else is a defect for the error boundary. */
function failureNotice(error: unknown, title: string): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  if (
    error.code === "E_INVALID_REQUEST" &&
    title === "Lectern wasn’t reordered"
  ) {
    return {
      tone: "Danger",
      title,
      message:
        "Lectern changed while you were reordering. Review the order and try again.",
      requestId: error.requestId,
    };
  }
  const content = apiTransportFeedback(error, title);
  if (content === null) throw error;
  return content;
}

const VIEW_CODEC = {
  basePath: "/lectern",
  decode: decodeLecternView,
  encode: (decoded: DecodedLecternView, current: URLSearchParams) =>
    encodeLecternView(
      decoded.kind === "Valid" ? decoded.view : CANONICAL_LECTERN_VIEW,
      current,
    ),
  replaceOptions: { viewTransition: { kind: "collection-reflow" as const } },
};

export default function LecternPaneBody() {
  const { resource, busy, placeItems, setOrder } = useLectern();
  const { playAudio } = usePlayerCommands();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const paneId = usePaneRuntime()?.paneId ?? "lectern";
  const isPaneActive = usePaneIsActive();
  const items = useMemo(
    () => (resource.status === "ready" ? resource.data.items : []),
    [resource],
  );
  const status =
    resource.status === "ready" || resource.status === "error"
      ? resource.status
      : "loading";
  usePaneReturnReady(status !== "loading");

  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(VIEW_CODEC);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  const ordered = useMemo(
    () => (view === null ? [] : orderLecternItems(view, items)),
    [items, view],
  );
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);

  const getRowStatus = useCallback(
    (query: string) => {
      const visibleCount = ordered.filter((item) =>
        matchesPaneFilterQuery(query, filterFields(item)),
      ).length;
      const loadedCount = ordered.length;
      if (status === "ready")
        return {
          kind: "Complete" as const,
          visibleCount,
          totalCount: loadedCount,
          unit: UNIT,
        };
      return {
        kind: status === "error" ? ("Failed" as const) : ("Partial" as const),
        visibleCount,
        loadedCount,
        unit: UNIT,
      };
    },
    [ordered, status],
  );
  const { query, onQueryChange, clearQuery, rowStatus } = usePaneFilterRows({
    sourceKey: "Lectern.Items",
    getRowStatus,
  });
  const resetView = useCallback(() => {
    clearQuery();
    setDecodedView({ kind: "Valid", view: CANONICAL_LECTERN_VIEW });
  }, [clearQuery, setDecodedView]);
  const { inputRef, focusInput } = usePaneCollectionInput();
  const collection = useMemo(
    () =>
      view === null
        ? undefined
        : {
            label: "Filter Lectern",
            focusInput,
            content: (
              <PaneCollectionBar
                inputRef={inputRef}
                inputLabel="Filter Lectern"
                placeholder="Filter items"
                query={query}
                onQueryChange={onQueryChange}
                onClearQuery={clearQuery}
                rowStatus={rowStatus}
                filters={
                  <SelectField
                    layout="Inline"
                    label="Sort Lectern items"
                    size="sm"
                    ref={sortSelectRef}
                    value={lecternSortOptionOf(view)}
                    onChange={(event) =>
                      setDecodedView({
                        kind: "Valid",
                        view: lecternViewForSortOption(
                          event.target.value as LecternSortOptionId,
                        ),
                      })
                    }
                  >
                    {LECTERN_SORT_OPTION_IDS.map((id) => (
                      <option key={id} value={id}>
                        {lecternSortOptionLabel(id)}
                      </option>
                    ))}
                  </SelectField>
                }
                controls={
                  view.kind === "Custom" ? undefined : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        sortSelectRef.current?.focus({ preventScroll: true });
                        resetView();
                      }}
                    >
                      Reset view
                    </Button>
                  )
                }
              />
            ),
          },
    [
      clearQuery,
      focusInput,
      inputRef,
      onQueryChange,
      query,
      resetView,
      rowStatus,
      setDecodedView,
      view,
    ],
  );
  usePanePrimaryChrome({
    collection,
    // The count is the whole Lectern, never the filtered subset.
    header: {
      kind: "Section",
      meta:
        status === "loading"
          ? { kind: "Pending" }
          : { kind: "Count", value: items.length, unit: "item" },
    },
  });

  const acceptSuggestionTarget = useCallback<SuggestionAccept>(
    async (target) => {
      await placeItems({
        mediaIds: [assumeMediaId(suggestionTargetId(target))],
        placement: { kind: "Last" },
      });
    },
    [placeItems],
  );

  const visible = ordered.filter((item) =>
    matchesPaneFilterQuery(query, filterFields(item)),
  );
  const filtering = query.trim().length > 0;
  const controls = Object.fromEntries(
    visible.flatMap((item) => {
      const activation = item.activation;
      if (activation.kind !== "FooterAudio") return [];
      const verb = playbackVerb(item.consumption);
      return [
        [
          item.itemId,
          <Button
            key="play"
            variant="secondary"
            size="sm"
            className={styles.rowAction}
            aria-label={`${verb} ${item.mediaSummary.title}`}
            leadingIcon={<Play size={14} aria-hidden="true" />}
            onClick={() => playAudio(activation.descriptor)}
          >
            {verb}
          </Button>,
        ],
      ];
    }),
  );

  if (defect) throw defect.error;
  return (
    <PaneSurface
      state={
        feedback ? (
          <FeedbackNotice content={feedback} announcement="Assertive" />
        ) : undefined
      }
    >
      <section aria-label="On the lectern" tabIndex={-1}>
        {view === null ? (
          <FeedbackNotice
            content={{ tone: "Danger", title: "Invalid Lectern view" }}
            announcement="Assertive"
            actions={[
              {
                label: "Reset view",
                onClick: () => {
                  resetView();
                  requestAnimationFrame(() =>
                    sortSelectRef.current?.focus({ preventScroll: true }),
                  );
                },
              },
            ]}
          />
        ) : (
          <CollectionView
            returnScope="Lectern.Items"
            rows={visible.map(presentLecternItem)}
            status={status}
            ariaLabel="On the lectern"
            error={
              resource.status === "error" ? (
                <FeedbackNotice
                  content={failureNotice(
                    resource.error,
                    "Lectern couldn’t be loaded",
                  )}
                  announcement="Assertive"
                  actions={[{ label: "Retry", onClick: resource.retry }]}
                />
              ) : undefined
            }
            empty={
              <p className={styles.emptyState}>
                {filtering
                  ? "No items match this filter."
                  : "Nothing on the lectern yet."}
              </p>
            }
            rowControls={controls}
            surface={false}
            rowChangePresentation={{
              kind: "ImmediateOnKeyChange",
              key: query.trim(),
            }}
            // The server takes only the exact visible permutation: drag only the whole order.
            sortable={
              view.kind === "Custom" && !filtering
                ? {
                    disabled: busy,
                    onReorder: (rows) => {
                      setFeedback(null);
                      void setOrder(
                        rows.map((row) => parseLecternItemId(row.id)),
                      ).catch((error) => {
                        if (handleUnauthenticatedApiError(error)) return;
                        try {
                          setFeedback(
                            failureNotice(error, "Lectern wasn’t reordered"),
                          );
                        } catch (caught) {
                          setDefect({ error: caught });
                        }
                      });
                    },
                  }
                : undefined
            }
          />
        )}
      </section>
      <QuickReadsSection isActive={isPaneActive} />
      <SuggestionsSection
        returnScope="Lectern.Suggestions"
        destination={{ kind: "Lectern" }}
        paneId={paneId}
        isActive={isPaneActive}
        accept={acceptSuggestionTarget}
      />
    </PaneSurface>
  );
}
