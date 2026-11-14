"use client";

// Home: the Lectern in custom order, with local filtering, drag and selections.

import { useCallback, useEffect, useMemo, useRef } from "react";
import CollectionView from "@/components/collections/CollectionView";
import SuggestionsSection from "@/components/collections/SuggestionsSection";
import QuickReadsSection from "@/components/collections/QuickReadsSection";
import { assertNever } from "@/lib/assertNever";
import { useSuggestions } from "@/lib/useSuggestions";
import { Fact } from "@/components/feedback/Fact";
import PaneSurface from "@/components/ui/PaneSurface";
import { useCatalogState, useLiveGroup, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { catalogLectern } from "@/lib/catalog/selectors";
import { LIVE_SOURCE, type ReadSource } from "@/lib/catalog/types";
import type { ServerValue } from "@/lib/api/serverState";
import type { Lectern } from "@/lib/lectern/api";
import { remoteReady } from "@/lib/native/admission";
import { presentOrder, projectOrder } from "@/lib/collections/order";
import { presentMedia } from "@/lib/collections/presenters/media";
import {
  LecternReadFailure,
  lecternItems,
  useLectern,
  useLecternConsumptionRevision,
  useLecternOrder,
} from "@/lib/lectern/lectern";
import { filterFields, selectLectern } from "@/lib/lectern/select";
import { PlaybackSourceContext, type PlaybackSource } from "@/lib/actions/playbackSource";
import { ApiError } from "@/lib/api/client";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  usePaneRouter,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { decodeEmptyView } from "@/lib/libraries/views";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";

const UNIT = { singular: "item", plural: "items" };
export default function LecternPaneBody() {
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  if (!decodeEmptyView(params)) return <Fact line={{ fact: "this view doesn’t exist." }} speak verbs={[{ label: "reset view", commandKey: "lectern-view-reset", run: () => router.replace("/lectern") }]} />;
  return <LecternContent />;
}

function LecternContent() {
  const live = useLectern();
  const liveRevision = useLecternConsumptionRevision();
  const catalog = useCatalogState();
  const saved = catalog.data === null ? null : catalogLectern(catalog.data);
  // Relevance is the saved selection itself; a local natural end hides its row from `saved`.
  const members = useMemo(() => new Set(catalog.raw?.value.lectern.items.map(item => item.media_summary.media_id) ?? []), [catalog.raw]);
  const group = useLiveGroup("lectern");
  usePromoteLiveGroup(group, live.status === "ready" && live.source.kind === "live" && live.error === null && liveRevision !== null ? [liveRevision] : null, members);
  // The shared lectern read has its own invalidation; a dated group rereads it on receipts.
  const { refetch: refetchLectern } = live;
  const datedStale = useRef(group.stale);
  useEffect(() => {
    if (group.live || datedStale.current === group.stale) return;
    datedStale.current = group.stale;
    refetchLectern();
  }, [group.live, group.stale, refetchLectern]);
  const showingSaved = saved !== null && catalog.data !== null && !group.live;
  const source: ReadSource = !showingSaved || catalog.data === null ? LIVE_SOURCE : {
    kind: "catalog", snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at,
  };
  const lectern: ServerValue<Lectern> = showingSaved ? {
    status: "ready", data: saved, source, generation: 0, fresh: false, acceptedStale: null, error: null, refreshing: false, refetch: live.refetch, revalidate: live.revalidate,
  } : live.status === "ready" || saved !== null || remoteReady() || catalog.loading ? live : { status: "failed", retrying: false, refetch: live.refetch, revalidate: live.revalidate,
    error: catalog.error?.code.startsWith("E_CATALOG_") ? catalog.error : new ApiError(0, "E_CATALOG_UNAVAILABLE", "catalog not ready on this device") };
  const liveShown = lectern.status === "ready" && source.kind === "live";
  const order = useLecternOrder();
  const suggestions = useSuggestions({ kind: "Lectern" }, liveShown);
  const daily = useSuggestions({ kind: "Daily" }, liveShown);
  const { refresh: refreshSuggestionFeed } = suggestions;
  const { refresh: refreshDaily } = daily;
  // The section speaks for itself: success, its wait and its repair stand in it, and a failed
  // refresh over shown suggestions says nothing.
  const refreshSuggestions = useCallback<PaneRefreshExecute>(async ({ signal }) => {
    const results = await Promise.allSettled([refreshSuggestionFeed(signal), refreshDaily(signal)]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      const outcome = result.value;
      switch (outcome) {
        case "Refreshed": case "Finding": case "Repair": case "Failed": break;
        // justify-defect: the lectern has no authority or applicability gate.
        case "NotApplicable": throw new Error("lectern selections cannot be inapplicable");
        default: assertNever(outcome);
      }
    }
    return null;
  }, [refreshSuggestionFeed, refreshDaily]);
  const summaries = useMediaSummaries(
    lecternItems(lectern).map((item) => item.media_summary), source,
  );
  const items = lecternItems(lectern).flatMap((item) => {
    const summary = summaries.resolve(item.media_summary);
    return summary === null ? [] : [{ ...item, media_summary: summary }];
  });
  usePaneReturnReady(lectern.status !== "loading");

  const filterRows = usePaneFilterRows({
    sourceKey: "Lectern.Items",
    getRowStatus: (query) => {
      const visibleCount = items.filter((item) =>
        matchesPaneFilterQuery(query, filterFields(item)),
      ).length;
      return lectern.status === "ready"
        ? {
            kind: "Complete",
            visibleCount,
            totalCount: items.length,
            unit: UNIT,
          }
        : {
            kind: lectern.status === "failed" ? "Failed" : "Partial",
            visibleCount,
            loadedCount: items.length,
            unit: UNIT,
          };
    },
  });
  const query = filterRows.query.trim();
  const visible = source.kind === "live" && query === ""
    ? projectOrder(items, (item) => item.media_summary.media_id, order)
    : selectLectern(items, query);
  // A saved lectern is complete, so offline capture uses its effective rows, never rendered ones.
  const capture: PlaybackSource = async selected => {
    if (lectern.status !== "ready" ||
        source.kind === "live" && (!remoteReady() || lectern.error !== null || lectern.refreshing || order.state.pending !== null))
      throw new ApiError(409, "E_RESOURCE_CONFLICT", "load the current lectern before starting this queue");
    const media_ids = visible
      .filter(item => item.media_summary.media_kind === "podcast_episode" && item.media_summary.can_play)
      .map(item => item.media_summary.media_id);
    if (!media_ids.includes(selected)) throw new ApiError(409, "E_RESOURCE_CONFLICT", "no playable episodes in this view");
    return { media_ids };
  };
  const ordering = source.kind === "live" ? presentOrder({ order,
    view: query ? "Filtered" : "Custom",
    complete: lectern.status === "ready",
    titleOf: itemId => items.find(item => item.media_summary.media_id === itemId)?.media_summary.title ?? "" }) : undefined;
  const headerMeta: PaneHeaderMeta = lectern.status === "loading"
    ? { kind: "Pending" }
    : { kind: "Count", value: visible.length, of: items.length, unit: "item" };
  usePaneChrome({
    refresh: source.kind === "catalog" ? undefined : suggestions.state === null || daily.state === null ? { kind: "Resolving" } : {
      kind: "Refreshable", sourceKey: "lectern:suggestions", execute: refreshSuggestions,
    },
    query: { kind: "Collation", collation: {
      words: { label: "filter items", value: filterRows.query, applied: filterRows.query,
        onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery, standing: false,
        onSubmit: null, rows: { status: filterRows.rowStatus, announce: lectern.status === "ready" && lectern.error === null },
        notice: null, verbs: [] }, dimensions: [], order: null, reset: null,
    } },
    header: { kind: "Section", meta: headerMeta },
  });

  return (
    <PaneSurface>
      <section aria-label="On the lectern">
          <PlaybackSourceContext.Provider value={capture}>
          <CollectionView geometry="UniformIndex"
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
            error={
              lectern.status === "failed"
                ? <LecternReadFailure error={lectern.error} retry={{ run: lectern.refetch, busy: lectern.retrying }} />
                : undefined
            }
            empty={<Fact line={{ fact: query ? "no items match this filter." : "nothing on the lectern yet." }} />}
            anchorKey={query}
            order={ordering}
          />
          </PlaybackSourceContext.Provider>
      </section>
      {liveShown ? <SuggestionsSection
        destination={{ kind: "Daily" }}
        suggestions={daily}
        returnScope="Lectern.DailySelection"
      /> : null}
      {liveShown ? <QuickReadsSection /> : null}
      {liveShown ? <SuggestionsSection
        destination={{ kind: "Lectern" }}
        suggestions={suggestions}
        returnScope="Lectern.Suggestions"
      /> : null}
    </PaneSurface>
  );
}
