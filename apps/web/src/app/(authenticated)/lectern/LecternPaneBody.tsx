"use client";

// Home: the Lectern in its custom order or a url-owned sort (`sort` ∈ added_desc, added_asc,
// title_asc, title_desc; absent = custom), a local text filter, drag to move one row (custom
// order, no filter), Play / Resume / Replay on episodes, then Quick reads and Suggestions.

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
import PaneSurface from "@/components/ui/PaneSurface";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import {
  apiTransportFeedback,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { catalogErrorFeedback } from "@/lib/catalog/copy";
import { useCatalogState } from "@/lib/catalog/provider";
import { catalogLectern } from "@/lib/catalog/selectors";
import { LIVE_SOURCE, type ReadSource } from "@/lib/catalog/types";
import type { ServerValue } from "@/lib/api/serverState";
import type { Lectern } from "@/lib/lectern/api";
import { remoteReady } from "@/lib/native/admission";
import { renderOrderNotice, orderStatus, presentOrder, projectOrder } from "@/lib/collections/order";
import { presentMedia } from "@/lib/collections/presenters/media";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import {
  lecternItems,
  useLectern,
  useLecternCommands,
  useLecternOrder,
} from "@/lib/lectern/lectern";
import { filterFields, ordered, selectLectern } from "@/lib/lectern/select";
import { PlaybackSourceContext, type PlaybackSource } from "@/lib/actions/playbackSource";
import type { QueueSource } from "@/lib/player/queue";
import { ApiError } from "@/lib/api/client";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { paneFilterText } from "@/lib/panes/paneFilterText";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  usePaneIsActive,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
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

/** Modeled failures become notices; anything else is a defect for the boundary. */
function failure(error: unknown, title: string): FeedbackContent {
  const content =
    isApiError(error) && !isSameSystemApiDefect(error)
      ? catalogErrorFeedback(error) ?? apiTransportFeedback(error, title)
      : null;
  if (content === null) throw error;
  return content;
}

export default function LecternPaneBody() {
  const live = useLectern();
  const catalog = useCatalogState();
  const saved = catalog.data === null ? null : catalogLectern(catalog.data);
  const source: ReadSource = live.status === "ready" || catalog.data === null ? LIVE_SOURCE : {
    kind: "catalog", snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at,
  };
  const lectern: ServerValue<Lectern> = live.status === "ready" ? live : saved === null ?
    !remoteReady() && !catalog.loading ? { status: "failed", retrying: false, refetch: live.refetch,
      error: catalog.error?.code.startsWith("E_CATALOG_") ? catalog.error : new ApiError(0, "E_CATALOG_UNAVAILABLE", "catalog not ready on this device") } : live : {
    status: "ready", data: saved, source, generation: 0, error: null, refreshing: false, refetch: live.refetch,
  };
  const liveShown = lectern.status === "ready" && source.kind === "live";
  const { ensure } = useLecternCommands();
  const order = useLecternOrder();
  const runtime = usePaneRuntime();
  const isActive = usePaneIsActive();
  const suggestions = useSuggestions({ kind: "Lectern" }, isActive && liveShown);
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
    lecternItems(lectern).map((item) => item.media_summary), source,
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
  const visible = source.kind === "live" && sort === "" && query === ""
    ? projectOrder(shown, (item) => item.media_summary.media_id, order)
    : selectLectern(items, valid ? sort : "", query);
  const capture: PlaybackSource = async selected => {
    if (source.kind !== "live" || !remoteReady() || !valid || lectern.status !== "ready" || lectern.error !== null || lectern.refreshing || order.state.pending !== null)
      throw new ApiError(409, "E_RESOURCE_CONFLICT", "load the current lectern before starting this queue");
    const media_ids = visible
      .filter(item => item.media_summary.media_kind === "podcast_episode" && item.media_summary.can_play)
      .map(item => item.media_summary.media_id);
    if (!media_ids.includes(selected)) throw new ApiError(409, "E_RESOURCE_CONFLICT", "no playable episodes in this view");
    const sourceSort = (["added_asc", "added_desc", "title_asc", "title_desc"] as const).find(value => value === sort) ?? null;
    const queueSource: QueueSource = { kind: "Lectern", label: "lectern", query: paneFilterText(query), sort: sourceSort };
    return { media_ids, source: queueSource };
  };
  const ordering = source.kind === "live" ? presentOrder({ order,
    view: sort ? "Sorted" : query ? "Filtered" : "Custom",
    complete: lectern.status === "ready" }) : undefined;
  const orderingStatus = orderStatus(ordering);
  const change = useCallback(
    (changes: ViewChanges) =>
      router.replace(viewHref("/lectern", params, changes), {
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
    refresh: source.kind === "catalog" ? undefined : suggestions.state === null ? { kind: "Resolving" } : {
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
                visible: false,
                content: (
                  <PaneFilterRowsStatus
                    announceQueryChanges={lectern.status === "ready" && lectern.error === null}
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
      state={liveShown ? renderOrderNotice({ order: order.state, active: isActive, paneId: runtime?.paneId ?? null }) : null}
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
          <PlaybackSourceContext.Provider value={capture}>
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
                knownDescriptor: source.kind === "live" && item.activation.kind === "FooterAudio" ? item.activation.descriptor : null,
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
            rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: query }}
            order={ordering}
          />
          </PlaybackSourceContext.Provider>
        ) : null}
      </section>
      {liveShown ? <QuickReadsSection isActive={isActive} /> : null}
      {liveShown ? <SuggestionsSection
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
      /> : <FeedbackNotice content={{ tone: "Neutral", title: "suggestions require a connection" }} announcement="None" />}
    </PaneSurface>
  );
}
