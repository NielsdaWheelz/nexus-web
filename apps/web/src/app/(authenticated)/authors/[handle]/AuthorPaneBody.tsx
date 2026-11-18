"use client";

// The author pane: the person's other names and their visible works. The url
// owns the works view (`sort`, `direction`) and passes it to the server, which
// validates it; the text filter stays local. The filter and count cover the
// complete finite index; the local filter sees every visible kind.

import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { useCallback, useMemo } from "react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import CollectionView from "@/components/collections/CollectionView";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import PaneSurface from "@/components/ui/PaneSurface";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import type { CollationOrder } from "@/lib/panes/collation";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { useAuthorIndexReads } from "@/lib/panes/indexPaneEntry";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { browsePreviewHref } from "@/lib/browse/api";
import {
  listContributorWorks,
  type ContributorDetail,
  type ContributorWork,
} from "@/lib/contributors/api";
import {
  contributorRoleLabel,
  selectMediaAuthors,
} from "@/lib/contributors/credits";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import {
  useMediaSummaries,
} from "@/lib/media/MediaSummaryProvider";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import {
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const DETAIL =
  definePaneVisitDataKey<Visit<ContributorDetail>>("Author.Detail");
const WORKS =
  definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof listContributorWorks>>>>("Author.Works");

function presentWork(work: ContributorWork): CollectionRowView {
  if (work.kind === "Media") {
    const resourceRef = assumeCanonicalResourceRef(work.action_ref);
    return presentMedia(work.media_summary, {
      id: resourceRef,
      primary: {
        kind: "link",
        href: work.href,
      },
      resourceRef,
      selected: false,
    });
  }
  const row = {
    kind: "contributor_work",
    presentation: "Index",
    primary: { kind: "link", href: work.href, paneLabelHint: work.title },
    title: { text: work.title },
    publicationDate: null,
    selected: false,
  } as const;
  if (work.kind === "ExternalWork") {
    return {
      ...row,
      id: work.href,
      primary: { ...row.primary, href: browsePreviewHref(work.target) },
      resourceActions: {
        kind: "Media",
        subject: {
          kind: "External",
          target: work.target,
          media_kind: "epub",
          title: work.title,
          contributors: work.contributors,
        },
        knownDescriptor: null,
      },
      contributors: selectMediaAuthors(work.contributors),
      context: null,
      resourceRef: null,
    };
  }
  const roles = work.role_facts.map((fact) =>
    contributorRoleLabel(fact.role, 1),
  );
  const text = [...new Set(roles), "Publication date unknown"].join(" · ");
  const resourceRef = assumeCanonicalResourceRef(work.action_ref);
  return {
    ...row,
    id: resourceRef,
    contributors: [],
    context: { kind: "Text", text },
    resourceRef,
  };
}

export default function AuthorPaneBody() {
  const handle = usePaneParam("handle");
  if (!handle) throw new Error("author route requires a handle");
  return <AuthorPane key={handle} handle={handle} />;
}

function AuthorPane({ handle }: { readonly handle: string }) {
  const active = usePaneIsActive();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  // The view keys pass through verbatim, duplicates included: the server
  // rejects anything that is not one of the four views.
  const view = new URLSearchParams([
    ...params.getAll("sort").map((value) => ["sort", value]),
    ...params.getAll("direction").map((value) => ["direction", value]),
  ]).toString();
  const descriptors = useAuthorIndexReads();
  const detail = useServerValue({ ...descriptors.detail, visit: DETAIL });
  const works = useServerValue({ ...descriptors.works, visit: WORKS });
  const loaded = works.status === "ready" ? works.data.items : [];
  const worksFailure = works.status === "loading" ? null : works.error;
  const worksBusy = indexReading(works);
  const retryWorks = () => { void works.refetch().catch(() => {}); };
  const summaries = useMediaSummaries(
    loaded.flatMap((work) =>
      work.kind === "Media" ? [work.media_summary] : [],
    ),
  );
  // A media work whose summary is no longer visible drops out.
  const rows = useMemo(
    () =>
      (works.status === "ready" ? works.data.items : []).flatMap((work) => {
        if (work.kind !== "Media") return [presentWork(work)];
        const summary = summaries.resolve(work.media_summary);
        return summary === null
          ? []
          : [presentWork({ ...work, media_summary: summary })];
      }),
    [works, summaries],
  );
  const complete = (works.status === "ready");
  const matches = useCallback(
    (text: string) =>
      rows.filter((row) => {
        // Stored media keep queue capture's filter contract; external works match authors.
        const subject = row.resourceActions?.kind === "Media" ? row.resourceActions.subject : null;
        return matchesPaneFilterQuery(
          text,
          subject?.kind === "Stored"
            ? mediaListFilterFields(subject.summary)
            : mediaListFilterFields({ title: row.title.text, contributors: row.contributors, show: null }),
        );
      }),
    [rows],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: `Author.Works:${handle}`,
    getRowStatus: useCallback(
      (text: string) =>
        indexRowStatus(works, rows.length, matches(text).length, {
          singular: "work",
          plural: "works",
        }),
      [matches, rows.length, works],
    ),
  });
  const text = filterRows.query.trim();

  const { clearQuery } = filterRows;
  const setView = useCallback(
    (next: string) => {
      const query = new URLSearchParams(next);
      for (const [key, value] of params) {
        if (key !== "sort" && key !== "direction") query.append(key, value);
      }
      const suffix = query.toString() ? `?${query}` : "";
      router.replace(`/authors/${encodeURIComponent(handle)}${suffix}`, {
      });
    },
    [handle, params, router],
  );
  const resetView = useCallback(() => {
    clearQuery();
    setView("");
  }, [clearQuery, setView]);
  const invalidView =
    works.status === "failed" && works.error.code === "E_INVALID_REQUEST";
  const visible = matches(text);
  const readFeedback = useIndexReadFeedback({ value: works, requestedKey: descriptors.works.key, active, waiting: !invalidView && works.status === "loading", outcome: null });
  const order: CollationOrder = { value: view || null, rest: "oldest published", keys: [
    { label: "published", ways: [{ value: "sort=published&direction=desc", label: null, word: "newest published" }] },
    { label: "title", ways: [
      { value: "sort=title&direction=asc", label: "a–z", word: "title a–z" },
      { value: "sort=title&direction=desc", label: "z–a", word: "title z–a" },
    ] },
  ], onChange: value => setView(value ?? ""), note: null };
  const orderKnown = order.value === null || order.keys.some(key => key.ways.some(way => way.value === order.value));
  const headerMeta: PaneHeaderMeta = complete && !invalidView
    ? { kind: "Count", value: visible.length, of: rows.length, unit: "work" }
    : { kind: "None" };
  const queryControls = invalidView || !orderKnown ? undefined : {
    kind: "Collation" as const, collation: {
      words: { label: "filter works", value: filterRows.query, applied: filterRows.query,
        onChange: filterRows.onQueryChange, onClear: clearQuery, standing: false, onSubmit: null,
        rows: { status: filterRows.rowStatus, announce: works.status === "ready" && worksFailure === null }, notice: null, verbs: [] },
      dimensions: [], order,
      reset: order.value !== null ? resetView : null,
    },
  };

  const ref =
    detail.status === "ready"
      ? parseResourceRef(detail.data.action_ref)
      : null;
  const contributorId = ref?.scheme === "contributor" ? ref.id : null;
  const linkedItems = useMemo(
    () =>
      contributorId !== null ? (
        <ConnectionsSurface
          resourceRef={{ scheme: "contributor", id: contributorId }}
        />
      ) : null,
    [contributorId],
  );
  useResourceInspector({
    scheme: "contributor",
    handle: detail.status === "ready" && detail.error?.status !== 403 && detail.error?.status !== 404 ? detail.data.handle : null,
    bodies: { linkedItems },
  });
  const { refetch: refetchDetail } = detail;
  const { refetch: refetchWorks } = works;
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([refetchDetail(), refetchWorks()]);
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      const error: unknown = result.reason;
      if (isAbortError(error) || !isApiError(error) || isSameSystemApiDefect(error)) throw error;
      // justify-ignore-error: each displayed read owns its failure and demand-driven repair.
    }
    return null;
  }, [refetchDetail, refetchWorks]);
  usePaneChrome({
    query: queryControls,
    resourceRef:
      detail.status === "ready"
        ? assumeCanonicalResourceRef(detail.data.action_ref)
        : undefined,
    refresh: {
      kind: "Refreshable",
      sourceKey: `Author.Works:${handle}`,
      execute: refresh,
    },
    header: { kind: "Section", meta: headerMeta },
  });
  usePaneReturnReady(detail.status !== "loading" && works.status !== "loading");

  if (invalidView) {
    return (
      <>
      {readFeedback.announcement}
      <Fact line={{ fact: "this sort doesn’t exist." }} verbs={[{ label: "reset view", commandKey: "reset view", run: resetView }]} />
      </>
    );
  }
  if (detail.status === "failed" && detail.error.code === "E_NOT_FOUND" || works.status === "failed" && works.error.code === "E_NOT_FOUND") {
    return (
      <>
      {readFeedback.announcement}
      <Fact line={{ fact: "this author isn’t available." }} />
      </>
    );
  }
  if (detail.status === "failed") {
    return (
      <>
      {readFeedback.announcement}
      <Failed error={detail.error} noun="author details" retry={{ run: () => { void detail.refetch().catch(() => {}); }, busy: detail.retrying }} />
      </>
    );
  }
  if (detail.status !== "ready") {
    return (
      <>
      {readFeedback.announcement}
      <PaneSurface state={<Ruling />} />
      </>
    );
  }

  const { other_names: otherNames } = detail.data;
  return (
    <>
      {readFeedback.announcement}
      <PaneSurface>
        <div className={styles.detail}>
          {otherNames.length > 0 ? (
            <section className={styles.otherNames}>
              <h2 className={styles.sectionHeading}>Other names</h2>
              <p className={styles.otherNamesList}>
                {otherNames.map((name, index) => (
                  <span key={`${name}-${index}`}>
                    {index > 0 ? ", " : null}
                    <span dir="auto">{name}</span>
                  </span>
                ))}
              </p>
            </section>
          ) : null}
          <section aria-label="Works">
            <CollectionView geometry="UniformIndex"
              returnScope="Author.Works"
              rows={visible}
              status={works.status === "loading" ? "loading" : "ready"}
              ariaLabel="Works"
              anchorKey={text}
              collectionBusy={worksBusy}
              surface={false}
              empty={works.status === "failed"
                ? <Failed error={works.error} noun="works" retry={{ run: retryWorks, busy: worksBusy }} />
                : <Fact line={{ fact: text ? "no works match this filter." : "no works to show." }} />}
            />
          </section>
        </div>
      </PaneSurface>
    </>
  );
}
