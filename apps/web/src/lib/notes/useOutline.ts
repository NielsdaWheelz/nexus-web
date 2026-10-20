"use client";
// The page/day adapter owns reads, titles and latent daily publication. Its one
// fetch-free session owns all editing, graph overlays, history and recovery.
// Daily publication carries the existing proposed ids in one commands transaction;
// retries retain those ids and their observed date binding.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, type ApiPath } from "@/lib/api/client";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { emptyBody, type NoteBody } from "./noteBody";
import * as model from "./outline";
import * as store from "./texts";
import {
  hasUnsavedOutline,
  openOutlineDraft,
  useOutlineSession,
  type DailyPublication,
  type OutlineDestination,
} from "./useOutlineSession";
import {
  announceResourceDeletion,
  isDeletedResource,
} from "@/lib/resourceGraph/links";
import {
  captureResourceOutlineRead,
  isResourceOutlineReadCurrent,
  readResourceOutline,
  useResourceOutline,
} from "@/lib/resourceGraph/useResourceOutline";
import type { OutlineBranch } from "@/lib/resources/outlineProjection";
const EMPTY_BRANCH: OutlineBranch = {
  ancestors: new Map(),
  traversedEdgeIds: new Set(),
};
interface Draft {
  readonly date: string;
  readonly page: string;
  readonly link: string;
  readonly note: string;
}
const bodyOf = (id: string): NoteBody => {
  const value = store.readText(model.noteRef(id))?.value;
  return typeof value === "object" ? value : emptyBody();
};
export type InsertAt =
  | "start"
  | "end"
  | {
      afterRowKey: string;
    };
export function useOutline(input: {
  root: string | null;
  dailyDate: string | null;
}) {
  const { dailyDate } = input;
  const session = useOutlineSession({
    scope: `outline:${input.root ?? `daily:${dailyDate}`}`,
    inheritedBranch: EMPTY_BRANCH,
  });
  const feedback = useFeedback();
  const dailyStamp = useChangeStamp("Notes", "Metadata");
  const [latentDate, setLatentDate] = useState<string | null>(null);
  const latent = dailyDate !== null && latentDate === dailyDate;
  const draft = useRef<Draft | null>(null);
  const boundDailyPage = useRef<string | null>(null);
  const [dailyConflict, setDailyConflict] = useState<{
    draft: Draft;
    pageRef: string;
  } | null>(null);
  const adoptOutline = session.adoptOutline;
  const adoptWire = useCallback(
    (
      outline: Schema<"OutlineOut">,
      generation = captureResourceOutlineRead(),
    ) =>
      adoptOutline({
        source: outline.source,
        insertionSource: outline.insertion_source,
        items: outline.items,
        version: outline.links_version,
        complete: outline.next_cursor === null,
        generation,
        status: "ready",
      }),
    [adoptOutline],
  );
  const read = usePaneFreeServerValue({
    key: dailyDate ? `outline:daily:${dailyDate}` : null,
    stale: dailyStamp,
    load: async (signal) => {
      if (!dailyDate) throw new Error("a daily read requires its local date");
      const started = captureResourceOutlineRead();
      const path = `/api/notes/daily/${dailyDate}` as ApiPath;
      const bindingAtStart = boundDailyPage.current;
      const { data } = await apiFetch<
        ApiJson<"/notes/daily/{local_date}", "get">
      >(path, { cache: "no-store", signal });
      signal.throwIfAborted();
      let deletedPrior: string | null = null;
      const currentPage = data.outline.source.item.ref;
      if (
        bindingAtStart === boundDailyPage.current &&
        bindingAtStart !== null &&
        bindingAtStart !== currentPage &&
        hasUnsavedOutline(bindingAtStart) &&
        !isDeletedResource(bindingAtStart)
      ) {
        try {
          await readResourceOutline(bindingAtStart, signal);
        } catch (error) {
          if (!isApiError(error) || error.status !== 404) throw error;
          deletedPrior = bindingAtStart;
        }
      }
      signal.throwIfAborted();
      return { data, bindingAtStart, deletedPrior, read_generation: started };
    },
  });
  const { refetch: refreshDaily } = read;
  const showDraft = useCallback(
    (proposed: Draft) => {
      const textRef = model.noteRef(proposed.note);
      const body = bodyOf(proposed.note);
      openOutlineDraft({
        endpoint: proposed.page,
        linkId: proposed.link,
        noteId: proposed.note,
        body,
        creator: {
          cancelled: () => isDeletedResource(proposed.page),
          request: (value) => ({
            path: "/api/resource-graph/commands",
            method: "POST",
            body: {
              commands: [
                {
                  kind: "insert_note",
                  source: {
                    kind: "daily_page",
                    local_date: proposed.date,
                    page_id: proposed.page.slice(5),
                  },
                  link_id: proposed.link,
                  note_id: proposed.note,
                  body_pm_json: value.body_pm_json,
                  position: { after: null, expected_links_version: 1 },
                },
              ],
            },
          }),
          refuse(error) {
            if (
              !isApiError(error) ||
              error.status !== 409 ||
              typeof error.details?.current_page_ref !== "string"
            )
              return false;
            store.setCreator(textRef, null);
            setDailyConflict({
              draft: proposed,
              pageRef: error.details.current_page_ref,
            });
            refreshDaily();
            return true;
          },
          settle(reply) {
            // justify-type-assertion: this creator sends only the commands route.
            const data = reply as Schema<"OutlineCommandsOut">;
            for (const outline of data.outlines) adoptWire(outline);
            boundDailyPage.current = proposed.page;
            setLatentDate((current) =>
              current === proposed.date ? null : current,
            );
            const title = store.readText(proposed.page)?.value;
            if (
              typeof title === "string" &&
              store.hasUnsavedText(proposed.page)
            )
              store.editText(proposed.page, title);
            refreshDaily();
            publishChange("Notes");
            const made = data.nodes.find(
              (node) => node.item.ref === textRef,
            )?.content;
            return made?.kind === "note" ? made.body_version : 1;
          },
        },
      });
    },
    [adoptWire, refreshDaily],
  );
  const dailyResult = read.status === "ready" ? read.data : null;
  const [adoptedDaily, setAdoptedDaily] = useState<typeof dailyResult>(null);
  // Only the read owner's accepted result may affect canonical state or drafts.
  useLayoutEffect(() => {
    if (!dailyResult || !dailyDate || adoptedDaily === dailyResult) return;
    setAdoptedDaily(dailyResult);
    const data = dailyResult.data;
    const currentPage = data.outline.source.item.ref;
    if (
      !isResourceOutlineReadCurrent(currentPage, dailyResult.read_generation) ||
      dailyResult.bindingAtStart !== boundDailyPage.current
    )
      return;
    if (dailyResult.deletedPrior !== null)
      announceResourceDeletion(dailyResult.deletedPrior);
    const prior = boundDailyPage.current;
    if (
      prior !== null &&
      prior !== currentPage &&
      isDeletedResource(prior) &&
      hasUnsavedOutline(prior)
    )
      return;
    boundDailyPage.current = data.materialized ? currentPage : null;
    const proposed = draft.current;
    if (
      proposed?.date === dailyDate &&
      isDeletedResource(proposed.page) &&
      hasUnsavedOutline(proposed.page)
    )
      return;
    const keepProposal =
      !data.materialized &&
      proposed?.date === dailyDate &&
      !isDeletedResource(proposed.page) &&
      store.readText(model.noteRef(proposed.note))?.acked === null;
    const page = keepProposal ? proposed.page : currentPage;
    if (!keepProposal) adoptWire(data.outline, dailyResult.read_generation);
    if (
      data.materialized &&
      proposed?.date === dailyDate &&
      proposed.page !== page &&
      store.readText(model.noteRef(proposed.note))?.acked === null &&
      store.hasUnsavedText(model.noteRef(proposed.note))
    ) {
      store.setCreator(model.noteRef(proposed.note), null);
      setDailyConflict({ draft: proposed, pageRef: page });
      setLatentDate(dailyDate);
      return;
    }
    if (
      dailyConflict &&
      store.readText(model.noteRef(dailyConflict.draft.note))?.acked === null
    )
      return;
    setLatentDate(data.materialized ? null : dailyDate);
    if (!data.materialized) {
      if (draft.current?.date !== dailyDate || draft.current.page !== page) {
        const previous = draft.current;
        const unsaved =
          previous?.date === dailyDate &&
          !isDeletedResource(previous.page) &&
          store.readText(model.noteRef(previous.note))?.acked === null;
        draft.current = {
          date: dailyDate,
          page,
          link: unsaved ? previous.link : crypto.randomUUID(),
          note: unsaved ? previous.note : crypto.randomUUID(),
        };
        const title = previous && store.readText(previous.page)?.value;
        if (
          unsaved &&
          typeof title === "string" &&
          store.hasUnsavedText(previous.page)
        )
          store.carryText(page, title);
      }
      showDraft(draft.current);
    }
  }, [
    adoptedDaily,
    dailyConflict,
    dailyResult,
    dailyDate,
    adoptWire,
    showDraft,
  ]);
  const dailyData =
    dailyResult !== null && adoptedDaily === dailyResult
      ? dailyResult.data
      : null;
  const proposed = draft.current;
  const keepDraft =
    dailyDate &&
    proposed?.date === dailyDate &&
    dailyData !== null &&
    (isDeletedResource(proposed.page)
      ? hasUnsavedOutline(proposed.page)
      : store.readText(model.noteRef(proposed.note))?.acked === null &&
        (boundDailyPage.current === null ||
          store.hasUnsavedText(model.noteRef(proposed.note))) &&
        (!dailyData.materialized ||
          dailyData.outline.source.item.ref === proposed.page ||
          store.hasUnsavedText(model.noteRef(proposed.note))));
  const unavailableDaily =
    boundDailyPage.current !== null &&
    isDeletedResource(boundDailyPage.current) &&
    hasUnsavedOutline(boundDailyPage.current)
      ? boundDailyPage.current
      : null;
  let root = input.root ?? unavailableDaily;
  if (root === null && dailyData !== null)
    root =
      keepDraft && proposed
        ? proposed.page
        : (boundDailyPage.current ?? dailyData.outline.source.item.ref);
  const dailyOwnsProjection =
    dailyData !== null &&
    (!dailyData.materialized || dailyData.outline.source.item.ref !== root);
  const pendingRoot =
    input.root !== null &&
    session.outline(input.root) &&
    store.readText(input.root)?.acked === null;
  const dailyGraphRef =
    dailyDate !== null && dailyData !== null && !dailyOwnsProjection
      ? root
      : null;
  const dailyOutlineCurrent =
    dailyResult !== null &&
    isResourceOutlineReadCurrent(
      dailyResult.data.outline.source.item.ref,
      dailyResult.read_generation,
    );
  const sharedRead = useResourceOutline(
    pendingRoot ? null : (input.root ?? dailyGraphRef),
    dailyData !== null && dailyGraphRef !== null && dailyOutlineCurrent
      ? dailyData.outline
      : null,
  );
  const {
    status: sharedStatus,
    source: sharedSource,
    insertionSource: sharedInsertionSource,
    version: sharedVersion,
    complete: sharedComplete,
    items: sharedItems,
    generation: sharedGeneration,
  } = sharedRead;
  useEffect(() => {
    if (
      !latent &&
      sharedStatus === "ready" &&
      sharedSource !== null &&
      sharedVersion !== null &&
      isResourceOutlineReadCurrent(sharedSource.item.ref, sharedGeneration)
    ) {
      adoptOutline({
        source: sharedSource,
        insertionSource: sharedInsertionSource,
        items: sharedItems,
        version: sharedVersion,
        complete: sharedComplete,
        generation: sharedGeneration,
        status: sharedStatus,
      });
    }
  }, [
    adoptOutline,
    latent,
    sharedStatus,
    sharedSource,
    sharedInsertionSource,
    sharedVersion,
    sharedComplete,
    sharedItems,
    sharedGeneration,
  ]);
  const dailyFailure =
    dailyDate !== null && read.status !== "loading" ? read.error : null;
  const failure = dailyFailure ?? sharedRead.error;
  let status = sharedRead.status;
  if (failure !== null) status = "failed";
  else if (pendingRoot || dailyOwnsProjection) status = "ready";
  else if (dailyDate !== null && dailyData === null) status = "loading";
  const dailyOwnsRetry =
    dailyDate !== null && (dailyFailure !== null || sharedRead.error === null);
  const dailyRetrying =
    dailyDate !== null &&
    (read.status === "failed"
      ? read.retrying
      : read.status === "ready" && read.refreshing);
  const retrying = dailyOwnsRetry ? dailyRetrying : sharedRead.retrying;
  const publishedDraft = store.useText(
    proposed ? model.noteRef(proposed.note) : "",
  );
  const refetchDaily = read.refetch;
  useEffect(() => {
    if (
      !proposed ||
      publishedDraft?.acked == null ||
      boundDailyPage.current === proposed.page
    )
      return;
    boundDailyPage.current = proposed.page;
    setLatentDate(null);
    refetchDaily();
  }, [proposed, publishedDraft?.acked, refetchDaily]);
  let endpoint = root;
  for (const edge of session.view.zoom)
    endpoint =
      endpoint === null
        ? null
        : (session
            .outline(endpoint)
            ?.links.find((link) => link.link_id === edge)?.target.item.ref ??
          null);
  const occurrencePrefix = root === null ? session.scope : `outline:${root}`;
  const rows =
    endpoint === null
      ? []
      : session.projectChildren({
          endpoint,
          occurrencePrefix,
          path: session.view.zoom,
          branch: EMPTY_BRANCH,
        });
  const publication: DailyPublication | null =
    latent && proposed && boundDailyPage.current === null
      ? {
          local_date: proposed.date,
          page_id: proposed.page.slice(5),
          note_id: proposed.note,
          link_id: proposed.link,
        }
      : null;
  function insertionDestination(at: InsertAt): OutlineDestination | null {
    if (
      endpoint === null ||
      root === null ||
      session.activeReference !== null ||
      failure?.status === 403 ||
      failure?.status === 404 ||
      isDeletedResource(endpoint)
    )
      return null;
    const row =
      typeof at === "object"
        ? rows.find((row) => row.key === at.afterRowKey)
        : null;
    if (typeof at === "object" && !row) return null;
    const owner = row?.endpoint ?? endpoint;
    const outline = session.outline(owner);
    if (!outline) return null;
    const position = row
      ? session.position({
          endpoint: owner,
          edgeId: row.link.link_id,
          side: "after",
        })
      : at === "start"
        ? { after: null, expected_links_version: outline.links_version }
        : session.position({ endpoint: owner, edgeId: null, side: "after" });
    if (position === null) return null;
    return {
      source:
        publication && owner === proposed?.page
          ? {
              kind: "daily_page",
              local_date: publication.local_date,
              page_id: publication.page_id,
            }
          : { kind: "resource", ref: owner },
      position,
      occurrencePrefix,
      path: row ? row.path.slice(0, -1) : session.view.zoom,
    };
  }
  return {
    ...session,
    session,
    status,
    retrying,
    failure,
    latent,
    root: root === null ? null : session.outline(root),
    endpoint: endpoint ?? root ?? "",
    occurrencePrefix,
    rows,
    complete:
      endpoint !== null && (session.outline(endpoint)?.complete ?? false),
    more: sharedRead.more,
    reload: dailyOwnsRetry ? read.refetch : sharedRead.refetch,
    publication,
    dailyConflict: dailyConflict !== null,
    retryDaily() {
      if (!dailyConflict) return;
      const original = dailyConflict;
      const proposed = original.draft;
      const textRef = model.noteRef(proposed.note);
      setDailyConflict(null);
      void apiFetch<ApiJson<"/notes/daily/{local_date}", "get">>(
        `/api/notes/daily/${proposed.date}` as ApiPath,
        { cache: "no-store" },
      )
        .then(({ data }) => {
          const pageRef = data.outline.source.item.ref;
          adoptWire(data.outline);
          store.setCreator(textRef, {
            cancelled: () => isDeletedResource(pageRef),
            request: (value) => ({
              path: "/api/resource-graph/commands",
              method: "POST",
              body: {
                commands: [
                  ...(data.materialized
                    ? []
                    : [
                        {
                          kind: "ensure_daily",
                          local_date: proposed.date,
                          page_id: pageRef.slice(5),
                        },
                      ]),
                  {
                    kind: "insert_note",
                    source: { kind: "resource", ref: pageRef },
                    note_id: proposed.note,
                    link_id: proposed.link,
                    position: null,
                    body_pm_json: value.body_pm_json,
                  },
                ],
              },
            }),
            refuse(error) {
              if (
                !isApiError(error) ||
                (error.status !== 404 &&
                  !(
                    error.status === 409 &&
                    typeof error.details?.current_page_ref === "string"
                  ))
              )
                return false;
              store.setCreator(textRef, null);
              setDailyConflict({ draft: proposed, pageRef });
              return true;
            },
            settle(reply) {
              // justify-type-assertion: the creator sends only graph commands.
              const saved = reply as Schema<"OutlineCommandsOut">;
              boundDailyPage.current = pageRef;
              for (const outline of saved.outlines) adoptWire(outline);
              const title = store.readText(proposed.page)?.value;
              if (
                typeof title === "string" &&
                store.hasUnsavedText(proposed.page)
              )
                store.editText(pageRef, title);
              setLatentDate(null);
              setDailyConflict(null);
              read.refetch();
              publishChange("Notes");
              const content = saved.nodes.find(
                (node) => node.item.ref === textRef,
              )?.content;
              return content?.kind === "note" ? content.body_version : 1;
            },
          });
        })
        .catch((error: unknown) => {
          setDailyConflict(original);
          if (!handleUnauthenticatedApiError(error))
            feedback.offer({
              key: "daily-retry",
              announcement: "Polite",
              content: {
                tone: "Warning",
                title: "this day couldn’t refresh",
                requestId: isApiError(error) ? error.requestId : undefined,
              },
            });
        });
    },
    canInsert: (at: InsertAt) => insertionDestination(at) !== null,
    insert(at: InsertAt, body: NoteBody = emptyBody()) {
      const destination = insertionDestination(at);
      if (!destination) return false;
      if (
        typeof at === "string" &&
        latent &&
        proposed?.page === sourceEndpoint(destination.source)
      ) {
        session.focusRow(
          model.occurrenceKey(occurrencePrefix, [proposed.link]),
        );
        return true;
      }
      void session.insertNote({
        destination,
        body,
        publication: publication ?? undefined,
      });
      return true;
    },
    insertionSource(row?: model.Row) {
      const owner = row?.endpoint ?? endpoint ?? "";
      return publication && owner === proposed?.page
        ? {
            kind: "daily_page" as const,
            local_date: publication.local_date,
            page_id: publication.page_id,
          }
        : { kind: "resource" as const, ref: owner };
    },
    setTitle(title: string) {
      if (root === null) return;
      if (latent && root !== boundDailyPage.current)
        store.carryText(root, title);
      else store.editText(root, title);
    },
  };
}
function sourceEndpoint(source: OutlineDestination["source"]): string | null {
  return source.kind === "resource"
    ? source.ref
    : source.kind === "daily_page"
      ? `page:${source.page_id}`
      : null;
}
export type Outline = ReturnType<typeof useOutline>;
