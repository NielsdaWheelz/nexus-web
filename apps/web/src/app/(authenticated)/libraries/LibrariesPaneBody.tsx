"use client";

// The viewer's libraries in name order. Creation and filtering belong to this visit.

import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { isAbortError } from "@/lib/errors";
import { useCallback, useState } from "react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import CollectionView from "@/components/collections/CollectionView";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useActiveRegion } from "@/components/feedback/stage";
import { catalogLine } from "@/lib/catalog/copy";
import LibraryInvitations, { useLibraryInvitations } from "@/components/libraries/LibraryInvitations";
import { useCatalogRead } from "@/lib/catalog/provider";
import { catalogLibraries } from "@/lib/catalog/selectors";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { useLibrariesIndexRead } from "@/lib/panes/indexPaneEntry";
import { libraryDisplayName, presentLibrary } from "@/lib/collections/presenters/library";
import { type Library } from "@/lib/libraries/api";
import { decodeEmptyView } from "@/lib/libraries/views";
import { truncatePaneSearchQuery, usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { matchesPaneFilterQuery } from "@/lib/panes/paneFilterRows";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";
import { useLibraryCreation } from "./useLibraryCreation";

const VISIT = definePaneVisitDataKey<Visit<{ items: Library[] }>>("Libraries.Index");
const FILTER = definePaneVisitDataKey<string>("Libraries.Filter");
const UNIT = { singular: "library", plural: "libraries" };

export default function LibrariesPaneBody() {
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  if (!decodeEmptyView(params)) return <Fact line={{ fact: "this view doesn’t exist." }} speak verbs={[{ label: "reset view", commandKey: "libraries-view-reset", run: () => router.replace("/libraries") }]} />;
  return <Libraries />;
}

function Libraries() {
  const speak = useActiveRegion();
  const creation = useLibraryCreation();
  const invitations = useLibraryInvitations();
  const catalog = useCatalogRead(catalogLibraries);
  const descriptor = useLibrariesIndexRead();
  const list = useServerValue({ ...descriptor, catalog, visit: VISIT });
  const indexItems = list.status === "ready" ? list.data.items : [];
  const failure = list.status === "loading" ? null : list.error;
  const catalogFailure = failure === null ? null : catalogLine(failure);
  const busy = indexReading(list);
  const retry = () => { void list.refetch().catch(() => {}); };
  const invalid =
    failure?.code === "E_INVALID_REQUEST";
  // The invitation prefix must land before any library row can become the first eye line.
  usePaneReturnReady(!invitations.opening && (list.status !== "loading" || invalid));
  usePaneScrollRetention(indexItems);

  const retainedFilter = usePaneVisitData(FILTER, (): string => filter);
  const [filter, setFilter] = useState(retainedFilter ?? "");
  const text = filter.trim();
  const visible = indexItems.filter((library) => matchesPaneFilterQuery(text, [libraryDisplayName(library)]));
  const rowStatus = indexRowStatus(
    list,
    indexItems.length,
    visible.length,
    UNIT,
  );
  // Every account has its default library, so only a filter empties the index.
  const emptyTitle = text ? "no libraries match this filter." : null;
  const readFeedback = useIndexReadFeedback({ value: list, requestedKey: descriptor.key, active: usePaneIsActive(), waiting: list.status === "loading" && !invalid, outcome: visible.length > 0 ? null : emptyTitle });
  const headerMeta: PaneHeaderMeta = invalid
    ? { kind: "None" }
    : (list.status === "ready")
      ? { kind: "Count", value: visible.length, of: indexItems.length, unit: "library" }
      : { kind: "Pending" };
  const { refetch } = list;
  // Success and a failed reread over shown rows both say nothing.
  const execute = useCallback<PaneRefreshExecute>(async () => {
    try {
      await refetch();
    } catch (error) {
      if (isAbortError(error) || !isApiError(error) || isSameSystemApiDefect(error)) throw error;
      // justify-ignore-error: the displayed read retains its failure and heals on demand.
    }
    return null;
  }, [refetch]);
  usePaneChrome({
    primaryAction: creation.primaryAction,
    query: invalid ? undefined : { kind: "Collation", collation: {
      words: { label: "filter libraries", value: filter, applied: filter,
        onChange: text => setFilter(truncatePaneSearchQuery(text)), onClear: () => setFilter(""),
        standing: false, onSubmit: null, rows: { status: rowStatus, announce: list.status === "ready" && failure === null }, notice: null, verbs: [] },
      dimensions: [], order: null, reset: null,
    } },
    refresh: { kind: "Refreshable", sourceKey: "Libraries.Index", execute },
    header: { kind: "Section", meta: headerMeta },
  });

  return (
    <>
      {readFeedback.announcement}
      {creation.content}
      {invitations.held}
      <LibraryInvitations state={invitations} />
      <CollectionView geometry="UniformIndex"
        returnScope="Libraries.Items"
        rows={visible.map(presentLibrary)}
        status={invitations.opening ? "loading" : list.status === "failed" ? "error" : list.status}
        ariaLabel="Libraries"
        anchorKey={text}
        collectionBusy={busy}
        error={list.status === "failed" ? catalogFailure !== null ? <Fact line={catalogFailure} speak={speak} />
          : <Failed error={list.error} noun="libraries" retry={{ run: retry, busy }} /> : null}
        empty={emptyTitle === null ? null : <Fact line={{ fact: emptyTitle }} />}
      />
    </>
  );
}
