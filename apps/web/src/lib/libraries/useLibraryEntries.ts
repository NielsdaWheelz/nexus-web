"use client";

// One library pane's server state (docs/modules/library.md): the library, the
// URL's entry view, the entries list and drag reorder. The pane body remounts
// per library id, so nothing here survives a change of library.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, isInvalidViewError, type ApiError } from "@/lib/api/client";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { libraryEntriesResource, libraryResource } from "@/lib/api/resource";
import { useResourceSeed } from "@/lib/api/resourceCache";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import {
  useServerList,
  type ListSnapshot,
  type ServerList,
} from "@/lib/api/useServerList";
import type { ApiJson } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import type { LibraryPaneSeed } from "@/lib/panes/paneResourceLoaders";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";
import { getMemberLibrary } from "./client";
import type { LibraryOut } from "./contract";
import {
  libraryEntryPageFromWire,
  libraryEntryTargetId,
  type LibraryEntryListItem,
} from "./entryListItem";
import {
  buildLibraryEntriesQuery,
  CANONICAL_LIBRARY_VIEW,
  completionOf,
  decodeLibraryView,
  encodeLibraryView,
  isInitialLibraryView,
  type DecodedLibraryView,
  type LibraryEntryView,
} from "./libraryView";

type Entry = LibraryEntryListItem;
const DETAIL = definePaneVisitDataKey<Visit<LibraryOut>>("Library.Detail");
const ENTRIES = definePaneVisitDataKey<ListSnapshot<Entry>>("Library.Entries");
const LEGACY_KEYS = ["kind", "type", "types"];
/** Views whose rows or order move with reading and listening progress. */
const followsConsumption = (view: LibraryEntryView) =>
  view.order.kind === "Remaining" ||
  view.projection.kind === "InProgress" ||
  completionOf(view) === "unfinished";

export interface LibraryEntries {
  readonly library: LibraryOut | null;
  readonly libraryFailure: ApiError | null;
  /** Members governance found the library gone: nothing more is read. */
  readonly unavailable: boolean;
  readonly view: DecodedLibraryView;
  /** The view the shown rows were read under (the previous one while a new one loads). */
  readonly shownView: LibraryEntryView | null;
  readonly entries: ServerList<Entry>;
  readonly invalid: boolean;
  readonly setView: (next: LibraryEntryView) => void;
  readonly resetView: () => void;
  /** I7: a complete canonical view of a named library the viewer admins. */
  readonly reorderable: boolean;
  readonly reorderBusy: boolean;
  /** Optimistic; rolls back and rethrows when the server refuses. */
  readonly reorder: (next: readonly Entry[]) => Promise<void>;
  readonly adoptLibrary: (next: LibraryOut | null) => void;
  /** Repeats a failed library read and a failed entries read. */
  readonly retry: () => void;
  /** Rereads the library and the loaded entries; settles with the entries. */
  readonly refresh: () => Promise<void>;
}

export function useLibraryEntries({
  id,
  active,
}: {
  readonly id: string;
  readonly active: boolean;
}): LibraryEntries {
  const router = usePaneRouter();
  const codec = useMemo(
    () => ({
      basePath: `/libraries/${id}`,
      decode: decodeLibraryView,
      encode: (value: DecodedLibraryView, params: URLSearchParams) => {
        if (value.kind === "Valid")
          return encodeLibraryView(value.view, params);
        const next = new URLSearchParams(params);
        for (const key of [
          "sort",
          "direction",
          "completion",
          "projection",
          "entry_type",
          ...LEGACY_KEYS,
        ]) {
          next.delete(key);
        }
        return next;
      },
    }),
    [id],
  );
  const { state: url, setState: setUrl } = usePaneUrlState(codec);
  const seed = useResourceSeed<LibraryPaneSeed>(
    libraryResource.cacheKey({ id }),
  );

  const detail = useServerValue({
    key: id,
    stale: useChangeStamp("Libraries"),
    visit: DETAIL,
    load: (signal) => getMemberLibrary(id, signal),
  });
  const read = detail.status === "ready" ? detail.data : null;
  const readRef = useRef(read);
  readRef.current = read;
  // Members governance reports a fresher library (or its loss) until the next read.
  const [adopted, setAdopted] = useState<{
    readonly base: LibraryOut | null;
    readonly library: LibraryOut | null;
  } | null>(null);
  const library =
    adopted !== null && adopted.base === read
      ? adopted.library
      : (read ?? seed?.library ?? null);
  const unavailable =
    adopted !== null && adopted.base === read && adopted.library === null;
  const libraryFailure = detail.status === "failed" ? detail.error : null;
  useEffect(() => {
    if (libraryFailure?.status === 404) router.push("/libraries");
  }, [libraryFailure, router]);

  const view = url.kind === "Valid" ? url.view : null;
  const consumption = useChangeStamp("Consumption");
  const stale = [
    useChangeStamp("Entries"),
    view !== null && followsConsumption(view) ? consumption : "-",
    useMediaQueryRevision(),
  ].join("|");
  const entries = useServerList<Entry>({
    key:
      view === null || unavailable
        ? null
        : `${id}${buildLibraryEntriesQuery(view)}`,
    stale,
    pageSize: 100,
    drain: true,
    active,
    visit: ENTRIES,
    seed: seed && { key: id, page: seed.entries },
    id: libraryEntryTargetId,
    fetchPage: async (cursor, limit, signal) => {
      const path = libraryEntriesResource.clientPath({
        id,
        view: view ?? CANONICAL_LIBRARY_VIEW,
        cursor: cursor ?? undefined,
        limit,
      });
      type Body = ApiJson<"/libraries/{library_id}/entries", "get">;
      return libraryEntryPageFromWire(
        (await apiFetch<Body>(path, { signal })).data,
      );
    },
  });
  const shown = entries.shownKey?.slice(id.length) ?? null;
  const decodedShown =
    shown === null ? null : decodeLibraryView(new URLSearchParams(shown));
  const invalid =
    url.kind === "Invalid" ||
    (entries.failure?.op === "Load" &&
      isInvalidViewError(entries.failure.error));
  usePaneReturnReady(entries.current || entries.status === "failed" || invalid);

  // The dragged order shows until the list commits again, or the save fails.
  const [ordered, setOrdered] = useState<{
    readonly base: readonly Entry[];
    readonly items: readonly Entry[];
  } | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const items =
    ordered !== null && ordered.base === entries.items
      ? ordered.items
      : entries.items;
  const reorderable =
    library !== null &&
    library.role === "admin" &&
    library.can_edit_entries &&
    !library.is_default &&
    view !== null &&
    isInitialLibraryView(view) &&
    entries.complete;
  const reorder = async (next: readonly Entry[]) => {
    if (!reorderable || reorderBusy) return;
    const base = entries.items;
    setOrdered({ base, items: next });
    setReorderBusy(true);
    try {
      await apiFetch(
        `/api/libraries/${encodeURIComponent(id)}/entries/reorder`,
        {
          method: "PATCH",
          body: JSON.stringify({
            entry_ids: next.map((entry) => {
              if (entry.placement === null) {
                // justify-defect: a named library's rows are all physical entries.
                throw new Error("Virtual Library rows cannot be reordered");
              }
              return entry.placement.library_entry_id;
            }),
          }),
        },
      );
      publishChange("Entries");
    } catch (error) {
      setOrdered((current) => (current?.base === base ? null : current));
      if (!handleUnauthenticatedApiError(error)) throw error;
    } finally {
      setReorderBusy(false);
    }
  };

  const scroll = usePaneScrollRetention(entries.items);
  const setView = useCallback(
    (next: LibraryEntryView) => {
      scroll();
      setUrl({ kind: "Valid", view: next });
    },
    [scroll, setUrl],
  );
  const { refetch: refetchDetail } = detail;
  const { refetch: refetchEntries } = entries;
  return {
    library,
    libraryFailure,
    unavailable,
    view: url,
    shownView: decodedShown?.kind === "Valid" ? decodedShown.view : null,
    entries: { ...entries, items },
    invalid,
    setView,
    resetView: () => setView(CANONICAL_LIBRARY_VIEW),
    reorderable,
    reorderBusy,
    reorder,
    adoptLibrary: useCallback(
      (next: LibraryOut | null) =>
        setAdopted({ base: readRef.current, library: next }),
      [],
    ),
    retry: () => {
      if (detail.status === "failed") detail.refetch();
      entries.retry();
    },
    refresh: useCallback(() => {
      refetchDetail();
      return refetchEntries();
    }, [refetchDetail, refetchEntries]),
  };
}
