"use client";

// Home: the Lectern in its custom order or a url-owned sort (`sort` ∈ added_desc, added_asc,
// title_asc, title_desc; absent = custom), a local text filter, drag to move one row (custom
// order, no filter), Play / Resume / Replay on episodes, then Quick reads and Suggestions.

import { Play } from "lucide-react";
import { useCallback, useId, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import SuggestionsSection from "@/components/collections/SuggestionsSection";
import QuickReadsSection from "@/components/collections/QuickReadsSection";
import { suggestionTargetId } from "@/lib/suggestions";
import { useSuggestions } from "@/lib/useSuggestions";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { OrderNotice, orderStatus, presentOrder, projectOrder } from "@/lib/collections/order";
import { presentMedia } from "@/lib/collections/presenters/media";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import {
  lecternItems,
  useLectern,
  useLecternCommands,
  useLecternOrder,
} from "@/lib/lectern/lectern";
import type { LecternItem } from "@/lib/lectern/api";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import {
  matchesPaneFilterQuery,
  paneFilterRowsStatusVisible,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  usePaneIsActive,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { usePlayerCommands } from "@/lib/player/playerRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./LecternPaneBody.module.css";

const UNIT = { singular: "item", plural: "items" };
const SORTS = [
  { value: "", label: "Custom order" },
  { value: "added_desc", label: "Newest added" },
  { value: "added_asc", label: "Oldest added" },
  { value: "title_asc", label: "Title A–Z" },
  { value: "title_desc", label: "Title Z–A" },
];

// Code-unit order, never localeCompare: collation depends on the runtime's ICU data.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const titleKey = (item: LecternItem) =>
  item.media_summary.title.trim().normalize("NFC").toLowerCase();

/** The rendered order; the media id breaks remaining ties. */
function ordered(
  items: readonly LecternItem[],
  sort: string,
): readonly LecternItem[] {
  if (sort === "") return items;
  const sign = sort.endsWith("_asc") ? 1 : -1;
  const id = (a: LecternItem, b: LecternItem) =>
    compare(a.media_summary.media_id, b.media_summary.media_id);
  return [...items].sort((a, b) =>
    sort.startsWith("added")
      ? sign * (Date.parse(a.added_at) - Date.parse(b.added_at)) || id(a, b)
      : sign * compare(titleKey(a), titleKey(b)) ||
        sign * compare(a.media_summary.title, b.media_summary.title) ||
        id(a, b),
  );
}

/** Title, contributors and, for an episode, its show. */
function filterFields(item: LecternItem): string[] {
  const fields = [...mediaListFilterFields(item.media_summary)];
  const { activation } = item;
  if (
    activation.kind === "FooterAudio" &&
    activation.descriptor.subtitle !== null
  )
    fields.push(activation.descriptor.subtitle);
  return fields;
}

function playbackVerb(item: LecternItem): "Play" | "Resume" | "Replay" {
  const { state } = item.media_summary.consumption;
  return state === "InProgress"
    ? "Resume"
    : state === "Finished"
      ? "Replay"
      : "Play";
}

/** Modeled failures become notices; anything else is a defect for the boundary. */
function failure(error: unknown, title: string): FeedbackContent {
  const content =
    isApiError(error) && !isSameSystemApiDefect(error)
      ? apiTransportFeedback(error, title)
      : null;
  if (content === null) throw error;
  return content;
}

export default function LecternPaneBody() {
  const lectern = useLectern();
  const { ensure } = useLecternCommands();
  const order = useLecternOrder();
  const runtime = usePaneRuntime();
  const { playAudio } = usePlayerCommands();
  const isActive = usePaneIsActive();
  const suggestions = useSuggestions({ kind: "Lectern" }, isActive);
  const { refresh: refreshSuggestionFeed } = suggestions;
  const refreshSuggestions = useCallback<PaneRefreshExecute>(async ({ signal }) => {
    const outcome = await refreshSuggestionFeed(signal);
    return outcome === "Requested" ? { kind: "Complete", announcement: "refresh requested" } : { kind: "Failed",
      announcement: outcome === "Repair" ? "suggestions need repair." : "couldn’t request suggestions." };
  }, [refreshSuggestionFeed]);
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  const section = useRef<HTMLElement>(null);
  const summaries = useMediaSummaries(
    lecternItems(lectern).map((item) => item.media_summary),
  );
  const items = lecternItems(lectern).flatMap((item) => {
    const summary = summaries.resolve(item.media_summary);
    return summary === null ? [] : [{ ...item, media_summary: summary }];
  });
  const sort = params.get("sort") ?? "";
  const valid = SORTS.some((option) => option.value === sort);
  const shown = ordered(items, valid ? sort : "");
  usePaneReturnReady(lectern.status !== "loading");

  const filterRows = usePaneFilterRows({
    sourceKey: "Lectern.Items",
    getRowStatus: (query) => {
      const visibleCount = shown.filter((item) =>
        matchesPaneFilterQuery(query, filterFields(item)),
      ).length;
      return lectern.status === "ready"
        ? {
            kind: "Complete",
            visibleCount,
            totalCount: shown.length,
            unit: UNIT,
          }
        : {
            kind: lectern.status === "failed" ? "Failed" : "Partial",
            visibleCount,
            loadedCount: shown.length,
            unit: UNIT,
          };
    },
  });
  const query = filterRows.query.trim();
  const visible = sort === "" && query === ""
    ? projectOrder(shown, (item) => item.media_summary.media_id, order)
    : shown.filter((item) => matchesPaneFilterQuery(query, filterFields(item)));
  const ordering = presentOrder({ order,
    view: sort ? "Sorted" : query ? "Filtered" : "Custom",
    complete: lectern.status === "ready" });
  const orderingStatus = orderStatus(ordering);
  const change = useCallback(
    (changes: ViewChanges) =>
      router.replace(viewHref("/lectern", params, changes), {
        viewTransition: { kind: "collection-reflow" },
      }),
    [params, router],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const canReset = sort.length > 0;
  // The count is the whole Lectern, never the filtered subset.
  const headerMeta: PaneHeaderMeta = lectern.status === "loading"
    ? { kind: "Pending" }
    : { kind: "Count", value: items.length, unit: "item" };
  usePaneChrome({
    refresh: suggestions.state === null ? { kind: "Resolving" } : {
      kind: "Refreshable", sourceKey: "lectern:suggestions", execute: refreshSuggestions,
    },
    query: valid
      ? {
          kind: "Controls",
          label: "Filter Lectern",
          focusInput,
          content: (
            <PaneQueryToolbar
              inputRef={inputRef}
              input={{
                label: "Filter Lectern",
                placeholder: "Filter items",
                value: filterRows.query,
                appliedValue: filterRows.query,
                onChange: filterRows.onQueryChange,
                onClear: filterRows.clearQuery,
              }}
              sort={{
                label: "Sort",
                value: sort,
                choices: SORTS,
                onChange: (value) => change({ sort: value || null }),
              }}
              status={{
                placement: "Inline",
                id: queryStatusId,
                visible: paneFilterRowsStatusVisible({
                  status: filterRows.rowStatus,
                  filtering: query !== "",
                }),
                content: (
                  <PaneFilterRowsStatus
                    id={queryStatusId}
                    status={filterRows.rowStatus}
                    query={filterRows.query}
                  />
                ),
              }}
              actions={orderingStatus ? <span>{orderingStatus}</span> : undefined}
              onReset={
                canReset
                  ? () => {
                      filterRows.clearQuery();
                      change({ sort: null });
                    }
                  : undefined
              }
            />
          ),
        }
      : undefined,
    header: { kind: "Section", meta: headerMeta },
  });

  return (
    <PaneSurface
      state={<OrderNotice order={order.state} active={isActive} paneId={runtime?.paneId ?? null} />}
    >
      <section ref={section} aria-label="On the lectern" tabIndex={-1}>
        {valid ? null : (
          <FeedbackNotice
            content={{ tone: "Danger", title: "Invalid Lectern view" }}
            announcement="Assertive"
            actions={[
              {
                label: "Reset view",
                // The pressed button leaves with the notice: focus stays on the list it reset.
                onClick: () => {
                  section.current?.focus({ preventScroll: true });
                  router.replace("/lectern");
                },
              },
            ]}
          />
        )}
        {valid ? (
          <CollectionView
            returnScope="Lectern.Items"
            ariaLabel="On the lectern"
            surface={false}
            status={
              lectern.status === "ready"
                ? "ready"
                : lectern.status === "failed"
                  ? "error"
                  : "loading"
            }
            rows={visible.map((item) =>
              presentMedia(item.media_summary, {
                id: item.media_summary.media_id,
                primary: {
                  kind: "link",
                  href: `/media/${item.media_summary.media_id}`,
                },
                resourceRef: canonicalResourceRef({
                  scheme: "media",
                  id: item.media_summary.media_id,
                }),
                selected: false,
              }),
            )}
            notice={
              <MediaSummaryNotice
                error={summaries.error}
                retry={summaries.retry}
                busy={summaries.retrying}
              />
            }
            error={
              lectern.status === "failed" ? (
                <FeedbackNotice
                  content={failure(lectern.error, "Lectern couldn’t be loaded")}
                  announcement="Assertive"
                  actions={[{ label: "Retry", onClick: lectern.refetch, busy: lectern.retrying }]}
                />
              ) : undefined
            }
            empty={
              <p className={styles.emptyState}>
                {query
                  ? "No items match this filter."
                  : "Nothing on the lectern yet."}
              </p>
            }
            rowControls={Object.fromEntries(
              visible.flatMap((item) => {
                const { activation } = item;
                if (activation.kind !== "FooterAudio") return [];
                const verb = playbackVerb(item);
                return [
                  [
                    item.media_summary.media_id,
                    <Button
                      key="play"
                      variant="secondary"
                      size="sm"
                      className={styles.rowAction}
                      aria-label={`${verb} ${item.media_summary.title}`}
                      leadingIcon={<Play size={14} aria-hidden="true" />}
                      onClick={() => playAudio(activation.descriptor)}
                    >
                      {verb}
                    </Button>,
                  ],
                ];
              }),
            )}
            rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: query }}
            order={ordering}
          />
        ) : null}
      </section>
      <QuickReadsSection isActive={isActive} />
      <SuggestionsSection
        destination={{ kind: "Lectern" }}
        suggestions={suggestions}
        returnScope="Lectern.Suggestions"
        accept={async (target) =>
          (await ensure({
            mediaId: suggestionTargetId(target),
            title:
              target.kind === "Media"
                ? target.media_summary.title
                : target.title,
          })) === "Acknowledged"
            ? "Accepted"
            : "Retained"
        }
      />
    </PaneSurface>
  );
}
