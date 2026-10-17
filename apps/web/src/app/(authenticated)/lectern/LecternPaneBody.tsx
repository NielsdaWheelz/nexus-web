"use client";

// Home: the Lectern in its custom order or a url-owned sort (`sort` ∈ added_desc, added_asc,
// title_asc, title_desc; absent = custom), a local text filter, drag to move one row (custom
// order, no filter), Play / Resume / Replay on episodes, then Quick reads and Suggestions.

import { Play } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import SuggestionsSection, {
  suggestionTargetId,
} from "@/components/collections/SuggestionsSection";
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
import { useThrowLater } from "@/lib/api/serverState";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { presentMedia } from "@/lib/collections/presenters/media";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import {
  lecternItems,
  placeOnLectern,
  useLectern,
  useLecternAdds,
  type LecternItem,
} from "@/lib/lectern/lectern";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  usePaneIsActive,
  usePaneRouter,
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
  const { add } = useLecternAdds();
  const { playAudio } = usePlayerCommands();
  const isActive = usePaneIsActive();
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  const fail = useThrowLater();
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const section = useRef<HTMLElement>(null);
  // A dragged order shows until the first read started after the move lands.
  const [dragged, setDragged] = useState<{
    until: number;
    ids: string[];
  } | null>(null);
  const summaries = useMediaSummaries(
    lecternItems(lectern).map((item) => item.media_summary),
  );
  const items = lecternItems(lectern).flatMap((item) => {
    const summary = summaries.resolve(item.media_summary);
    return summary === null ? [] : [{ ...item, media_summary: summary }];
  });
  const generation = lectern.status === "ready" ? lectern.generation : -1;
  const pending =
    dragged !== null && generation < dragged.until ? dragged.ids : null;
  const sort = params.get("sort") ?? "";
  const valid = SORTS.some((option) => option.value === sort);
  const shown = pending
    ? pending.flatMap((id) =>
        items.filter((item) => item.media_summary.media_id === id),
      )
    : ordered(items, valid ? sort : "");
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
  const change = useCallback(
    (changes: ViewChanges) =>
      router.replace(viewHref("/lectern", params, changes), {
        viewTransition: { kind: "collection-reflow" },
      }),
    [params, router],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  usePaneChrome({
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
                id: queryStatusId,
                content: (
                  <PaneFilterRowsStatus
                    id={queryStatusId}
                    status={filterRows.rowStatus}
                    query={filterRows.query}
                  />
                ),
              }}
              onReset={
                sort || filterRows.query.trim()
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
    // The count is the whole Lectern, never the filtered subset.
    header: {
      kind: "Section",
      meta:
        lectern.status === "loading"
          ? { kind: "Pending" }
          : { kind: "Count", value: items.length, unit: "item" },
    },
  });

  const query = filterRows.query.trim();
  const visible = shown.filter((item) =>
    matchesPaneFilterQuery(query, filterFields(item)),
  );
  // One drag moves one row: the first difference is either the row moved down or the row
  // moved up; it goes after its new predecessor.
  const move = (ids: string[]) => {
    const old = shown.map((item) => item.media_summary.media_id);
    const at = ids.findIndex((id, index) => id !== old[index]);
    const mediaId = old[at + 1] === ids[at] ? old[at] : ids[at];
    const before = ids[ids.indexOf(mediaId) - 1];
    setNotice(null);
    setDragged({ until: Infinity, ids });
    void placeOnLectern(
      mediaId,
      before === undefined
        ? { kind: "First" }
        : { kind: "After", media_id: before },
    ).then(
      () =>
        setDragged({
          until:
            generation +
            (lectern.status === "ready" && lectern.refreshing ? 2 : 1),
          ids,
        }),
      (error: unknown) => {
        setDragged(null);
        lectern.refetch();
        if (handleUnauthenticatedApiError(error)) return;
        try {
          setNotice(failure(error, "Lectern wasn’t reordered"));
        } catch (defect) {
          fail({ error: defect });
        }
      },
    );
  };

  return (
    <PaneSurface
      state={
        notice ? (
          <FeedbackNotice content={notice} announcement="Assertive" />
        ) : undefined
      }
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
            sortable={
              sort === "" && !query
                ? {
                    disabled: pending !== null,
                    onReorder: (rows) => move(rows.map((row) => row.id)),
                  }
                : undefined
            }
          />
        ) : null}
      </section>
      <SuggestionsSection kind="QuickReads" isActive={isActive} />
      <SuggestionsSection
        kind="Lectern"
        isActive={isActive}
        accept={async (target) =>
          (await add({
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
