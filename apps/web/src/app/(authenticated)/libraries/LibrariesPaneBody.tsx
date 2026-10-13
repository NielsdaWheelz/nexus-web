"use client";

import { useCallback, useId, useEffect, useRef, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { isInvalidViewError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { librariesResource } from "@/lib/api/resource";
import { useResourceSeed } from "@/lib/api/resourceCache";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource } from "@/lib/api/useResource";
import {
  listRowStatus,
  useServerList,
  type ListPage,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { presentLibrary } from "@/lib/collections/presenters/library";
import { isAbortError } from "@/lib/errors";
import { createLibrary, fetchLibrariesPage } from "@/lib/libraries/client";
import type {
  LibraryOut,
  ViewerLibraryInvitation,
} from "@/lib/libraries/contract";
import {
  acceptLibraryInvite,
  declineLibraryInvite,
  fetchViewerLibraryInvites,
} from "@/lib/libraries/governance";
import {
  CANONICAL_LIBRARIES_INDEX_VIEW,
  LIBRARIES_SORT_OPTION_IDS,
  decodeLibrariesIndexView,
  encodeLibrariesIndexView,
  librariesSortOptionLabel,
  librariesSortOptionOf,
  librariesViewForSortOption,
  type DecodedLibrariesIndexView,
  type LibrariesIndexView,
  type LibrariesSortOptionId,
} from "@/lib/libraries/libraryIndexView";
import {
  libraryRequestErrorMessage,
  type LibraryRequest,
} from "@/lib/libraries/libraryRequestErrorMessage";
import {
  isReservedLibraryName,
  libraryPresentation,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const VISIT =
  definePaneVisitDataKey<ListSnapshot<LibraryOut>>("Libraries.Index");
const UNIT = { singular: "library", plural: "libraries" };
// The pane URL owns the index view through a strict, total codec.
const VIEW_CODEC = {
  basePath: "/libraries",
  decode: decodeLibrariesIndexView,
  encode: (decoded: DecodedLibrariesIndexView, current: URLSearchParams) =>
    encodeLibrariesIndexView(
      decoded.kind === "Valid" ? decoded.view : CANONICAL_LIBRARIES_INDEX_VIEW,
      current,
    ),
  replaceOptions: { viewTransition: { kind: "collection-reflow" as const } },
};
const keyOf = (view: LibrariesIndexView) =>
  librariesResource.cacheKey({ view });

export default function LibrariesPaneBody() {
  requirePaneRuntime(usePaneRuntime(), "LibrariesPaneBody");
  const { state: decoded, setState: setDecoded } = usePaneUrlState(VIEW_CODEC);
  const view = decoded.kind === "Valid" ? decoded.view : null;
  const seed = useResourceSeed<ListPage<LibraryOut>>(
    keyOf(CANONICAL_LIBRARIES_INDEX_VIEW),
  );
  const list = useServerList<LibraryOut>({
    key: view === null ? null : keyOf(view),
    stale: useChangeStamp("Libraries"),
    pageSize: 100,
    drain: true,
    active: usePaneIsActive(),
    visit: VISIT,
    seed: seed && { key: keyOf(CANONICAL_LIBRARIES_INDEX_VIEW), page: seed },
    id: (library) => library.id,
    fetchPage: (cursor, limit, signal) =>
      fetchLibrariesPage({
        view: view ?? CANONICAL_LIBRARIES_INDEX_VIEW,
        cursor,
        limit,
        signal,
      }),
  });
  // The server rejects a view the URL codec admitted: a terminal, resettable state.
  const invalid =
    view === null ||
    (list.failure?.op === "Load" && isInvalidViewError(list.failure.error));
  usePaneReturnReady(list.status !== "loading" || invalid);
  const captureScroll = usePaneScrollRetention(list.items);
  const setView = useCallback(
    (next: LibrariesIndexView) => {
      captureScroll();
      setDecoded({ kind: "Valid", view: next });
    },
    [captureScroll, setDecoded],
  );

  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const presentFailure = useCallback(
    (error: unknown, title: string, request: LibraryRequest) => {
      try {
        setFeedback(libraryRequestErrorMessage(error, { title, request }));
      } catch (caught) {
        setDefect({ error: caught });
      }
    },
    [],
  );
  const loadFailure =
    list.failure !== null && list.failure.op !== "More" && !invalid
      ? libraryRequestErrorMessage(list.failure.error, {
          title:
            list.status === "ready"
              ? "Libraries couldn’t be refreshed"
              : "Libraries couldn’t be loaded",
          request: "LibraryCollectionRead",
        })
      : null;

  const name = useHydrationPreservedInput();
  const nameReserved = isReservedLibraryName(name.value);
  const [creating, setCreating] = useState(false);
  // A retried create replays the same library id for the same name.
  const replay = useRef<{ libraryId: string; name: string } | null>(null);
  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.value.trim();
    if (!trimmed || nameReserved) return;
    const attempt =
      replay.current?.name === trimmed
        ? replay.current
        : { libraryId: crypto.randomUUID(), name: trimmed };
    replay.current = attempt;
    setCreating(true);
    try {
      await createLibrary(attempt);
      replay.current = null;
      name.setValue("");
      setFeedback(null);
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        presentFailure(error, "Library wasn’t created", "LibraryCreate");
      }
    } finally {
      setCreating(false);
    }
  };

  const [invitesVersion, setInvitesVersion] = useState(0);
  const invites = useResource<ViewerLibraryInvitation[]>({
    cacheKey: `viewer-library-invites:${invitesVersion}`,
    load: fetchViewerLibraryInvites,
  });
  // The last loaded invitations stay shown while a reload runs.
  const [pendingInvites, setPendingInvites] = useState<
    ViewerLibraryInvitation[]
  >([]);
  useEffect(() => {
    if (invites.status === "ready") setPendingInvites(invites.data);
  }, [invites]);
  const [busyInvitation, setBusyInvitation] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const answer = async (
    invite: ViewerLibraryInvitation,
    action: "accept" | "decline",
  ) => {
    if (busyInvitation !== null) return;
    setBusyInvitation(invite.invitation_handle);
    try {
      if (action === "accept")
        await acceptLibraryInvite(invite.invitation_handle);
      else await declineLibraryInvite(invite.invitation_handle);
      setFeedback(null);
      setPendingInvites((current) =>
        current.filter(
          (row) => row.invitation_handle !== invite.invitation_handle,
        ),
      );
      setDeclining(null);
      setInvitesVersion((version) => version + 1);
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        presentFailure(
          error,
          action === "accept"
            ? "Invitation couldn’t be accepted"
            : "Invitation couldn’t be declined",
          "InvitationMutation",
        );
      }
    } finally {
      setBusyInvitation(null);
    }
  };

  const rows = list.items.map((library) => presentLibrary(library));
  const filterRows = usePaneFilterRows({
    sourceKey: "Libraries.Index",
    getRowStatus: (text) =>
      listRowStatus(
        list,
        list.items.length,
        list.items.filter((library) =>
          matchesPaneFilterQuery(text, [libraryPresentation(library).name]),
        ).length,
        UNIT,
      ),
  });
  const { query, clearQuery } = filterRows;
  const filtering = query.trim() !== "";
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const resetView = useCallback(() => {
    clearQuery();
    setView(CANONICAL_LIBRARIES_INDEX_VIEW);
    requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
  }, [clearQuery, inputRef, setView]);
  const { refetch } = list;
  const execute = useCallback<PaneRefreshExecute>(
    async ({ reportProgress }) => {
      reportProgress({
        kind: "Determinate",
        finishedCount: 0,
        requestedCount: 1,
      });
      try {
        await refetch();
        reportProgress({
          kind: "Determinate",
          finishedCount: 1,
          requestedCount: 1,
        });
        return { kind: "Complete", announcement: "Libraries refreshed" };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return { kind: "Failed", announcement: "Libraries failed to refresh" };
      }
    },
    [refetch],
  );
  usePaneChrome({
    query: invalid || view === null ? undefined : {
      kind: "Controls",
      label: "Filter libraries",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter libraries", placeholder: "Filter libraries", value: query, appliedValue: query, onChange: filterRows.onQueryChange, onClear: clearQuery }}
          sort={{
            label: "Sort",
            value: librariesSortOptionOf(view),
            choices: LIBRARIES_SORT_OPTION_IDS.map((value) => ({ value, label: librariesSortOptionLabel(value) })),
            onChange: (value) => setView(librariesViewForSortOption(
              // justify-type-assertion: the select offers exactly these ids.
              value as LibrariesSortOptionId,
            )),
          }}
          status={{ id: queryStatusId, content: <PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={query} /> }}
          onReset={view.kind !== "Canonical" || query ? resetView : undefined}
        />
      ),
    },
    refresh: { kind: "Refreshable", sourceKey: "Libraries.Index", execute },
    header: {
      kind: "Section",
      // The count describes the complete committed view, never a subset.
      meta: invalid
        ? { kind: "None" }
        : list.complete
          ? { kind: "Count", value: list.items.length, unit: "library" }
          : { kind: "Pending" },
    },
  });

  if (defect) throw defect.error;
  if (invalid) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid libraries view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: resetView }]}
      />
    );
  }

  const loadNotice = loadFailure && (
    <FeedbackNotice
      content={loadFailure}
      announcement="Assertive"
      actions={[{ label: "Retry", onClick: list.retry }]}
    />
  );
  return (
    <>
      {invites.status === "error" ? (
        <div className={styles.invitationInbox}>
          <FeedbackNotice
            content={libraryRequestErrorMessage(invites.error, {
              title: "Library invitations couldn’t be loaded",
              request: "InvitationRead",
            })}
            announcement="Assertive"
            actions={[
              {
                label: "Retry invitations",
                onClick: () => setInvitesVersion((version) => version + 1),
              },
            ]}
          />
        </div>
      ) : null}
      {pendingInvites.length > 0 ? (
        <section
          className={styles.invitationInbox}
          aria-labelledby="library-invitations-heading"
        >
          <div>
            <h2 id="library-invitations-heading">Library invitations</h2>
            <p>Accept to add the library here, or decline the invitation.</p>
          </div>
          <div className={styles.invitationRows}>
            {pendingInvites.map((invite) => {
              const handle = invite.invitation_handle;
              return (
                <div className={styles.invitationRow} key={handle}>
                  <span>
                    {invite.library_name} ·{" "}
                    {invite.role === "admin" ? "Admin" : "Member"}
                  </span>
                  {declining === handle ? (
                    <span className={styles.invitationActions}>
                      <span>Decline this invitation?</span>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={busyInvitation === handle}
                        onClick={() => void answer(invite, "decline")}
                      >
                        Decline
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyInvitation !== null}
                        onClick={() => setDeclining(null)}
                      >
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <span className={styles.invitationActions}>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busyInvitation === handle}
                        disabled={busyInvitation !== null}
                        onClick={() => void answer(invite, "accept")}
                      >
                        Accept
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyInvitation !== null}
                        onClick={() => setDeclining(handle)}
                      >
                        Decline
                      </Button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <div>
        <CollectionView
          returnScope="Libraries.Items"
          rows={rows.filter((row) =>
            matchesPaneFilterQuery(query, [row.title.text]),
          )}
          status={list.status === "failed" ? "error" : list.status}
          ariaLabel="Libraries"
          rowChangePresentation={{
            kind: "ImmediateOnKeyChange",
            key: query.trim(),
          }}
          collectionBusy={list.running !== null || !list.current}
          toolbar={
            <div>
              <form className={styles.createForm} onSubmit={handleCreate}>
                <Input
                  {...name.inputProps}
                  placeholder="New library name..."
                  className={styles.inputField}
                  disabled={creating}
                  aria-label="New library name"
                  aria-invalid={nameReserved || undefined}
                  aria-describedby={
                    nameReserved ? "library-name-reserved" : undefined
                  }
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={creating || !name.value.trim() || nameReserved}
                >
                  {creating ? "Creating..." : "Create"}
                </Button>
              </form>
              {nameReserved ? (
                <p
                  id="library-name-reserved"
                  role="alert"
                  className={styles.createHint}
                >
                  {RESERVED_LIBRARY_NAME_MESSAGE}
                </p>
              ) : null}
            </div>
          }
          notice={
            feedback ? (
              <FeedbackNotice content={feedback} announcement="Assertive" />
            ) : list.status === "loading" && filtering ? (
              <FeedbackNotice
                content={{
                  tone: "Neutral",
                  title: "No matching library found so far.",
                }}
                announcement="Polite"
              />
            ) : undefined
          }
          error={list.status === "failed" ? loadNotice : undefined}
          empty={
            <FeedbackNotice
              content={
                filtering
                  ? {
                      tone: "Neutral",
                      title: list.complete
                        ? "No libraries match this filter."
                        : "No matching library found so far.",
                    }
                  : {
                      tone: "Neutral",
                      title: "No libraries yet.",
                      message: "Create your first library above.",
                    }
              }
              announcement="Polite"
            />
          }
          footer={
            list.status === "ready" ? (
              <>
                <CollectionExhaustionNotice list={list} />
                {loadNotice}
              </>
            ) : null
          }
        />
      </div>
    </>
  );
}
