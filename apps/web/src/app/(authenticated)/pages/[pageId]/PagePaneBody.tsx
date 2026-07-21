"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import NoteDraftRecovery from "@/components/notes/NoteDraftRecovery";
import ProseMirrorOutlineEditor, {
  type NotePulseEditorTarget,
} from "@/components/notes/ProseMirrorOutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import {
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { createRandomId } from "@/lib/createRandomId";
import { isObjectType, resolveObjectRefs } from "@/lib/objectRefs";
import { useResource } from "@/lib/api/useResource";
import {
  useNotePulseHighlight,
  type NotePulseTarget,
} from "@/lib/reader/pulseEvent";
import { escapeAttrValue } from "@/lib/highlights/escapeAttrValue";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { consumePendingNoteFocus } from "@/lib/notes/pendingNoteFocus";
import {
  createEmptyOutlineDoc,
  noteBlocksToOutlineDoc,
} from "@/lib/notes/prosemirror/schema";
import {
  fetchDailyNotePage,
  fetchDawnWrite,
  fetchNoteBlock,
  fetchNotePage,
  saveResourceSurface,
  type DawnWrite,
  type NotePage,
  type SaveResourceSurfaceInput,
} from "@/lib/notes/api";
import DawnWriteBlock from "@/components/notes/DawnWriteBlock";
import { shiftLocalDate } from "@/lib/localDate";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { NoteBlock } from "@/lib/notes/normalize";
import {
  draftBlocksById,
  deletedRootBlockIdsForPersistence,
  flatBlockIds,
  flatBlockParentIds,
  resourceSurfaceBlocksFromDrafts,
  resourceSurfaceAdjacencyFromDrafts,
  pageDraftMetadataFromStorage,
  planResourceSurfaceSave,
  readDraftBlocksForPersistence,
  type PersistedDraftBlock,
} from "@/lib/notes/resourceSurfacePersistence";
import {
  clearStoredNoteEditorDraft,
  readStoredNoteEditorDraft,
  useNoteEditorSession,
} from "@/lib/notes/useNoteEditorSession";
import styles from "../../notes/notes.module.css";

interface LoadedNoteEditorResource {
  loadKey: string;
  saveScope: string;
  page: NotePage;
  focusedBlock: NoteBlock | null;
}

const NOTE_PULSE_CLASS = "nexus-note-pulse";
const NOTE_PULSE_DURATION_MS = 2400;
const NOTE_PULSE_RETRY_MS = 120;
const NOTE_PULSE_MAX_ATTEMPTS = 25;

function resourceBaseVersions(
  page: NotePage | null | undefined,
): SaveResourceSurfaceInput["baseVersions"] {
  if (!page) return [];
  const ref = `page:${page.id}`;
  const lanes = page.surface?.source.versionByLane ?? {};
  const out: SaveResourceSurfaceInput["baseVersions"] = [
    { ref, lane: "title", version: lanes.title ?? 1 },
    { ref, lane: "outgoing_edges", version: lanes.outgoing_edges ?? 1 },
  ];
  const visit = (blocks: NoteBlock[]) => {
    for (const block of blocks) {
      const blockRef = `note_block:${block.id}`;
      out.push({
        ref: blockRef,
        lane: "body",
        version: block.versionByLane?.body ?? 1,
      });
      out.push({
        ref: blockRef,
        lane: "outgoing_edges",
        version: block.versionByLane?.outgoing_edges ?? 1,
      });
      visit(block.children);
    }
  };
  visit(page.blocks);
  return out;
}

export default function PagePaneBody({
  pageIdOverride,
  focusBlockId,
  initialPage,
}: {
  pageIdOverride?: string;
  focusBlockId?: string;
  initialPage?: NotePage;
}) {
  const routePageId = usePaneParam("pageId");
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const openInNewPaneCommand = paneRuntime?.openInNewPane;
  const pageId = pageIdOverride ?? routePageId;
  if (!pageId) throw new Error("page route requires a page id");

  const [page, setPage] = useState<NotePage | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [initialDoc, setInitialDoc] = useState<ProseMirrorNode | null>(null);
  const [editorResetSerial, setEditorResetSerial] = useState(0);
  const [bodyFocusRequest, setBodyFocusRequest] = useState(0);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [notePulseTarget, setNotePulseTarget] =
    useState<NotePulseEditorTarget | null>(null);
  const saveScope = focusBlockId ? `block:${focusBlockId}` : `page:${pageId}`;
  const editorResourceKey = `${saveScope}:editor`;
  const renderedEditorResourceKey = `${editorResourceKey}:reset:${editorResetSerial}`;
  const initialPageKey =
    initialPage && initialPage.id === pageId
      ? `initial:${initialPage.id}:${initialPage.updatedAt ?? ""}`
      : "server";
  const editorLoadKey = `${saveScope}:load:${initialPageKey}`;
  const knownBlockIdsRef = useRef<Set<string>>(new Set());
  const knownBlockParentIdsRef = useRef<Map<string, string | null>>(new Map());
  const knownBlockDraftsRef = useRef<Map<string, PersistedDraftBlock>>(
    new Map(),
  );
  const fullPageBlocksRef = useRef<NoteBlock[]>(initialPage?.blocks ?? []);
  const resourceBaseVersionsRef = useRef(resourceBaseVersions(initialPage));
  const focusedRootParentBlockIdRef = useRef<string | null>(null);
  const currentSaveScopeRef = useRef(saveScope);
  const editorLoadKeyRef = useRef(editorLoadKey);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const notePulseIdRef = useRef(0);
  const currentDocRef = useRef<ProseMirrorNode | null>(null);
  const persistedTitleRef = useRef(initialPage?.title ?? "");
  const titleDraftRef = useRef(titleDraft);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  titleDraftRef.current = titleDraft;

  const setEditorDoc = useCallback((doc: ProseMirrorNode) => {
    currentDocRef.current = doc;
    setInitialDoc(doc);
  }, []);

  const setTitleDraftValue = useCallback((nextTitle: string) => {
    titleDraftRef.current = nextTitle;
    setTitleDraft(nextTitle);
  }, []);

  // Note-citation activation: scroll the cited block into view and pulse the
  // exact cited offset range through the editor. The editor may still be
  // mounting when the pulse fires, so block scroll retries briefly.
  const pulseNoteBlock = useCallback((target: NotePulseTarget) => {
    const pulseId = notePulseIdRef.current + 1;
    notePulseIdRef.current = pulseId;
    setNotePulseTarget({
      blockId: target.blockId,
      startOffset: target.startOffset,
      endOffset: target.endOffset,
      pulseId,
    });
    window.setTimeout(() => {
      setNotePulseTarget((current) =>
        current?.pulseId === pulseId ? null : current,
      );
    }, NOTE_PULSE_DURATION_MS);

    let attempts = 0;
    const tryPulse = () => {
      const shell = shellRef.current;
      const block = shell?.querySelector<HTMLElement>(
        `li[data-note-block-id="${escapeAttrValue(target.blockId)}"]`,
      );
      if (!block) {
        if (attempts++ < NOTE_PULSE_MAX_ATTEMPTS) {
          window.setTimeout(tryPulse, NOTE_PULSE_RETRY_MS);
        }
        return;
      }
      block.scrollIntoView({ behavior: "smooth", block: "center" });
      block.classList.remove(NOTE_PULSE_CLASS);
      // Force a reflow so re-adding the class restarts the animation.
      void block.offsetWidth;
      block.classList.add(NOTE_PULSE_CLASS);
      window.setTimeout(() => {
        block.classList.remove(NOTE_PULSE_CLASS);
      }, NOTE_PULSE_DURATION_MS);
    };
    tryPulse();
  }, []);

  // Live channel: handles the case where an already-open page contains the
  // cited note.
  const onNotePulse = useCallback(
    (target: NotePulseTarget) => {
      if (!page || !findBlock(page.blocks, target.blockId)) return;
      pulseNoteBlock(target);
    },
    [page, pulseNoteBlock],
  );
  useNotePulseHighlight(onNotePulse);

  const editorReady = page !== null && initialDoc !== null;

  useEffect(() => {
    if (!editorReady) return;
    const pending = consumePendingNoteFocus(pageId);
    if (!pending) return;
    if (pending === "title") {
      window.requestAnimationFrame(() => {
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
      });
      return;
    }
    setBodyFocusRequest((current) => current + 1);
  }, [editorReady, pageId]);

  const fallbackTitle = focusBlockId ? "Note" : "Page";
  const paneLabel = titleDraft.trim() || page?.title || fallbackTitle;
  useSetPaneLabel(page ? paneLabel : feedback ? fallbackTitle : null);

  currentSaveScopeRef.current = saveScope;
  editorLoadKeyRef.current = editorLoadKey;

  const saveDoc = useCallback(
    async (
      doc: ProseMirrorNode,
      { clientMutationId }: { clientMutationId: string },
    ) => {
      const scope = saveScope;
      const submittedTitle = normalizedPageTitle(titleDraftRef.current);
      const plan = focusBlockId
        ? (() => {
            const editedDrafts = readDraftBlocksForPersistence(
              doc,
              focusedRootParentBlockIdRef.current,
            );
            const editedIds = new Set(editedDrafts.map((block) => block.id));
            const fullDrafts = readDraftBlocksForPersistence(
              noteBlocksToOutlineDoc(fullPageBlocksRef.current),
            );
            const replacedIds = new Set(knownBlockIdsRef.current);
            const drafts = [
              ...fullDrafts.filter((block) => !replacedIds.has(block.id)),
              ...editedDrafts,
            ];
            return {
              blocks: resourceSurfaceBlocksFromDrafts(drafts),
              adjacency: resourceSurfaceAdjacencyFromDrafts(drafts, pageId),
              deletedBlockIds: deletedRootBlockIdsForPersistence(
                replacedIds,
                editedIds,
                knownBlockParentIdsRef.current,
              ),
              nextBlockIds: editedIds,
              nextBlockParentIds: new Map(
                editedDrafts.map((block) => [block.id, block.parentBlockId]),
              ),
              nextBlockDrafts: draftBlocksById(editedDrafts),
            };
          })()
        : planResourceSurfaceSave({
            doc,
            pageId,
            rootParentBlockId: null,
            knownBlockIds: new Set(knownBlockIdsRef.current),
            knownBlockParentIds: knownBlockParentIdsRef.current,
          });

      const result = await saveResourceSurface(pageId, {
        clientMutationId,
        baseVersions: resourceBaseVersionsRef.current,
        title: submittedTitle,
        focusBlockId: focusBlockId ?? null,
        blocks: plan.blocks,
        adjacency: plan.adjacency,
        deletedBlockIds: plan.deletedBlockIds,
      });

      if (currentSaveScopeRef.current === scope) {
        const titleStillCurrent =
          normalizedPageTitle(titleDraftRef.current) === submittedTitle;
        resourceBaseVersionsRef.current = resourceBaseVersions(result.page);
        fullPageBlocksRef.current = result.page.blocks;
        persistedTitleRef.current = result.page.title;
        knownBlockIdsRef.current = plan.nextBlockIds;
        knownBlockParentIdsRef.current = plan.nextBlockParentIds;
        knownBlockDraftsRef.current = plan.nextBlockDrafts;
        if (titleStillCurrent) {
          setTitleDraftValue(result.page.title);
        }
        const visiblePage = titleStillCurrent
          ? result.page
          : { ...result.page, title: titleDraftRef.current };
        if (focusBlockId) {
          const focusedBlock = findBlock(visiblePage.blocks, focusBlockId);
          setPage(
            focusedBlock
              ? { ...visiblePage, blocks: [focusedBlock] }
              : visiblePage,
          );
        } else {
          setPage(visiblePage);
        }
      }
    },
    [focusBlockId, pageId, saveScope, setTitleDraftValue],
  );

  const draftMetadata = useCallback(() => {
    return {
      knownBlocks: Array.from(knownBlockDraftsRef.current.values()),
      focusedRootParentBlockId: focusedRootParentBlockIdRef.current,
      titleDraft: titleDraftRef.current,
    };
  }, []);

  const session = useNoteEditorSession({
    resourceKey: saveScope,
    save: saveDoc,
    draftMetadata,
    onError: (error) => {
      setFeedback(toFeedback(error, { fallback: "Notes could not be saved." }));
    },
  });
  const {
    status: saveStatus,
    hasRecoveredDraft,
    scheduleSave: scheduleSessionSave,
    flush: flushSession,
    recoverDraft: recoverSessionDraft,
    retry: retrySession,
    discardDraft: discardSessionDraft,
    reset: resetSession,
  } = session;
  const editorLoadResource = useResource<LoadedNoteEditorResource>({
    cacheKey: editorLoadKey,
    load: async () => {
      const loadedPage =
        initialPage && initialPage.id === pageId
          ? initialPage
          : await fetchNotePage(pageId);
      const focusedBlock = focusBlockId
        ? await fetchNoteBlock(focusBlockId)
        : null;
      return {
        loadKey: editorLoadKey,
        saveScope,
        page: loadedPage,
        focusedBlock,
      };
    },
  });

  const applyLoadedEditorResource = useCallback(
    (loaded: LoadedNoteEditorResource) => {
      if (loaded.loadKey !== editorLoadKeyRef.current) {
        return;
      }

      try {
        const loadedPage = loaded.page;
        resourceBaseVersionsRef.current = resourceBaseVersions(loadedPage);
        fullPageBlocksRef.current = loadedPage.blocks;
        persistedTitleRef.current = loadedPage.title;
        if (!loaded.focusedBlock) {
          setPage(loadedPage);
          setTitleDraftValue(loadedPage.title);
          focusedRootParentBlockIdRef.current = null;
          knownBlockIdsRef.current = new Set(flatBlockIds(loadedPage.blocks));
          knownBlockParentIdsRef.current = flatBlockParentIds(
            loadedPage.blocks,
          );
          const persistedDoc = loadedPage.blocks.length
            ? noteBlocksToOutlineDoc(loadedPage.blocks)
            : null;
          knownBlockDraftsRef.current = persistedDoc
            ? draftBlocksById(readDraftBlocksForPersistence(persistedDoc))
            : new Map();
          const storedDraft = readStoredNoteEditorDraft(loaded.saveScope);
          const storedMetadata = storedDraft
            ? pageDraftMetadataFromStorage(storedDraft.metadata)
            : null;
          if (storedDraft && storedMetadata) {
            knownBlockIdsRef.current = new Set(
              storedMetadata.knownBlocks.map((block) => block.id),
            );
            knownBlockParentIdsRef.current = new Map(
              storedMetadata.knownBlocks.map((block) => [
                block.id,
                block.parentBlockId,
              ]),
            );
            knownBlockDraftsRef.current = draftBlocksById(
              storedMetadata.knownBlocks,
            );
            focusedRootParentBlockIdRef.current =
              storedMetadata.focusedRootParentBlockId;
            setTitleDraftValue(storedMetadata.titleDraft);
            setPage({ ...loadedPage, title: storedMetadata.titleDraft });
            setEditorDoc(storedDraft.doc);
            recoverSessionDraft(storedDraft);
            return;
          }
          if (storedDraft) {
            clearStoredNoteEditorDraft(loaded.saveScope);
          }
          setEditorDoc(persistedDoc ?? createEmptyOutlineDoc(createRandomId()));
          return;
        }

        const block = loaded.focusedBlock;
        setPage({ ...loadedPage, blocks: [block] });
        setTitleDraftValue(loadedPage.title);
        focusedRootParentBlockIdRef.current = block.parentBlockId;
        knownBlockIdsRef.current = new Set(flatBlockIds([block]));
        knownBlockParentIdsRef.current = flatBlockParentIds([block]);
        const doc = noteBlocksToOutlineDoc([block]);
        knownBlockDraftsRef.current = draftBlocksById(
          readDraftBlocksForPersistence(doc),
        );
        const storedDraft = readStoredNoteEditorDraft(loaded.saveScope);
        const storedMetadata = storedDraft
          ? pageDraftMetadataFromStorage(storedDraft.metadata)
          : null;
        if (storedDraft && storedMetadata) {
          knownBlockIdsRef.current = new Set(
            storedMetadata.knownBlocks.map((item) => item.id),
          );
          knownBlockParentIdsRef.current = new Map(
            storedMetadata.knownBlocks.map((item) => [
              item.id,
              item.parentBlockId,
            ]),
          );
          knownBlockDraftsRef.current = draftBlocksById(
            storedMetadata.knownBlocks,
          );
          focusedRootParentBlockIdRef.current =
            storedMetadata.focusedRootParentBlockId;
          setTitleDraftValue(storedMetadata.titleDraft);
          setPage({
            ...loadedPage,
            title: storedMetadata.titleDraft,
            blocks: [block],
          });
          setEditorDoc(storedDraft.doc);
          recoverSessionDraft(storedDraft);
          return;
        }
        if (storedDraft) {
          clearStoredNoteEditorDraft(loaded.saveScope);
        }
        setEditorDoc(doc);
      } catch (error: unknown) {
        if (handleUnauthenticatedApiError(error)) return;
        setFeedback(
          toFeedback(error, { fallback: "Note could not be loaded." }),
        );
      }
    },
    [recoverSessionDraft, setEditorDoc, setTitleDraftValue],
  );

  const resetEditorToPersistedDocument = useCallback(() => {
    const fullBlocks = fullPageBlocksRef.current;
    if (focusBlockId) {
      const focusedBlock = findBlock(fullBlocks, focusBlockId);
      const focusedBlocks = focusedBlock ? [focusedBlock] : [];
      const nextDoc = focusedBlock
        ? noteBlocksToOutlineDoc(focusedBlocks)
        : createEmptyOutlineDoc(createRandomId());
      focusedRootParentBlockIdRef.current = focusedBlock?.parentBlockId ?? null;
      knownBlockIdsRef.current = new Set(flatBlockIds(focusedBlocks));
      knownBlockParentIdsRef.current = flatBlockParentIds(focusedBlocks);
      knownBlockDraftsRef.current = focusedBlock
        ? draftBlocksById(readDraftBlocksForPersistence(nextDoc))
        : new Map();
      setPage((current) =>
        current
          ? {
              ...current,
              title: persistedTitleRef.current,
              blocks: focusedBlocks,
            }
          : current,
      );
      setTitleDraftValue(persistedTitleRef.current);
      setEditorDoc(nextDoc);
      setEditorResetSerial((current) => current + 1);
      return;
    }

    focusedRootParentBlockIdRef.current = null;
    knownBlockIdsRef.current = new Set(flatBlockIds(fullBlocks));
    knownBlockParentIdsRef.current = flatBlockParentIds(fullBlocks);
    const nextDoc = fullBlocks.length
      ? noteBlocksToOutlineDoc(fullBlocks)
      : createEmptyOutlineDoc(createRandomId());
    knownBlockDraftsRef.current = fullBlocks.length
      ? draftBlocksById(readDraftBlocksForPersistence(nextDoc))
      : new Map();
    setTitleDraftValue(persistedTitleRef.current);
    setPage((current) =>
      current
        ? { ...current, title: persistedTitleRef.current, blocks: fullBlocks }
        : current,
    );
    setEditorDoc(nextDoc);
    setEditorResetSerial((current) => current + 1);
  }, [focusBlockId, setEditorDoc, setTitleDraftValue]);

  const discardRecoveredDraft = useCallback(() => {
    discardSessionDraft();
    setFeedback(null);
    resetEditorToPersistedDocument();
  }, [discardSessionDraft, resetEditorToPersistedDocument]);

  useEffect(() => {
    setFeedback(null);
    setPage(null);
    setTitleDraftValue("");
    currentDocRef.current = null;
    setInitialDoc(null);
    setBodyFocusRequest(0);
    resetSession();
    return () => {
      flushSession();
    };
  }, [editorLoadKey, flushSession, resetSession, setTitleDraftValue]);

  useEffect(() => {
    if (editorLoadResource.status === "ready") {
      applyLoadedEditorResource(editorLoadResource.data);
      return;
    }

    if (editorLoadResource.status === "error") {
      setFeedback(
        toFeedback(editorLoadResource.error, {
          fallback: "Note could not be loaded.",
        }),
      );
    }
  }, [applyLoadedEditorResource, editorLoadResource]);

  const onEditorDocChange = useCallback(
    (doc: ProseMirrorNode) => {
      currentDocRef.current = doc;
      scheduleSessionSave(doc);
    },
    [scheduleSessionSave],
  );

  const onEditorBlurFlush = useCallback(
    (doc: ProseMirrorNode) => {
      currentDocRef.current = doc;
      flushSession(doc);
    },
    [flushSession],
  );

  const onTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextTitle = event.currentTarget.value;
      setTitleDraftValue(nextTitle);
      setPage((current) =>
        current ? { ...current, title: nextTitle } : current,
      );
      const doc = currentDocRef.current;
      if (doc) {
        scheduleSessionSave(doc);
      }
    },
    [scheduleSessionSave, setTitleDraftValue],
  );

  const flushTitle = useCallback(() => {
    const doc = currentDocRef.current;
    if (doc) {
      flushSession(doc);
    }
  }, [flushSession]);

  const openBlock = useCallback(
    (blockId: string, openInNewPane: boolean) => {
      if (!blockId) return;
      const href = `/notes/${blockId}`;
      if (openInNewPane) openInNewPaneCommand?.(href);
      else router.push(href);
    },
    [openInNewPaneCommand, router],
  );

  const openObject = useCallback(
    async (objectType: string, objectId: string, openInNewPane: boolean) => {
      if (!isObjectType(objectType)) return;
      let href: string | null = null;
      try {
        const [resolved] = await resolveObjectRefs([{ objectType, objectId }]);
        href = resolved?.route ?? null;
      } catch (error: unknown) {
        if (handleUnauthenticatedApiError(error)) return;
        setFeedback(
          toFeedback(error, { fallback: "Linked object could not be opened." }),
        );
        return;
      }
      if (!href) return;
      if (openInNewPane) openInNewPaneCommand?.(href);
      else router.push(href);
    },
    [openInNewPaneCommand, router],
  );

  const openRoute = useCallback(
    (href: string, openInNewPane: boolean) => {
      if (openInNewPane) openInNewPaneCommand?.(href);
      else router.push(href);
    },
    [openInNewPaneCommand, router],
  );

  const openDatedPage = useCallback(
    async (localDate: string) => {
      const nextPage = await fetchDailyNotePage(localDate);
      router.push(`/pages/${nextPage.id}`);
    },
    [router],
  );

  const dailyLocalDate = page?.dailyNote?.localDate ?? null;
  const paneOptions = useMemo<ActionDescriptor[]>(
    () => [
      ...(dailyLocalDate
        ? [
            {
              kind: "command" as const,
              id: "daily-open-yesterday",
              label: "Open yesterday",
              onSelect: () => void openDatedPage(shiftLocalDate(dailyLocalDate, -1)),
            },
            {
              kind: "command" as const,
              id: "daily-open-tomorrow",
              label: "Open tomorrow",
              onSelect: () => void openDatedPage(shiftLocalDate(dailyLocalDate, 1)),
            },
          ]
        : []),
    ],
    [dailyLocalDate, openDatedPage],
  );
  usePanePrimaryChrome({ options: paneOptions });

  // Dawn write: fetch for daily note pages only (not focused-block views).
  // cacheKey is null until the page loads and confirms a dailyNote — the fetch
  // never blocks the editor or the early-return loading path.
  const dawnWriteResource = useResource<DawnWrite | null>({
    cacheKey: dailyLocalDate && !focusBlockId ? `dawn-write:${dailyLocalDate}` : null,
    load: () => fetchDawnWrite(dailyLocalDate!),
  });
  const dawnWrite =
    dawnWriteResource.status === "ready" ? dawnWriteResource.data : null;

  const backlinkObjectRef = useMemo(
    () => ({
      objectType: focusBlockId ? ("note_block" as const) : ("page" as const),
      objectId: focusBlockId ?? pageId,
    }),
    [focusBlockId, pageId],
  );

  if (feedback && !initialDoc) return <FeedbackNotice {...feedback} />;
  if (!page || !initialDoc) return <PaneLoadingState />;

  return (
    <>
      {dawnWrite && <DawnWriteBlock write={dawnWrite} />}
      <div className={styles.editorShell} ref={shellRef}>
      <input
        ref={titleInputRef}
        className={styles.titleInput}
        value={titleDraft}
        onChange={onTitleChange}
        onBlur={flushTitle}
        aria-label="Page title"
      />
      <NoteDraftRecovery
        status={saveStatus}
        hasRecoveredDraft={hasRecoveredDraft}
        onRetry={retrySession}
        onDiscard={discardRecoveredDraft}
      />
      {feedback ? <FeedbackNotice {...feedback} /> : null}
      <ProseMirrorOutlineEditor
        resourceKey={renderedEditorResourceKey}
        initialDoc={initialDoc}
        createBlockId={createRandomId}
        onDocChange={onEditorDocChange}
        onBlurFlush={onEditorBlurFlush}
        onOpenBlock={openBlock}
        onOpenObject={openObject}
        notePulseTarget={notePulseTarget}
        focusRequest={bodyFocusRequest}
        onError={(error) => {
          if (handleUnauthenticatedApiError(error)) return;
          setFeedback(
            toFeedback(error, { fallback: "Attachment could not be added." }),
          );
        }}
      />
      <ConnectionsSurface objectRef={backlinkObjectRef} onOpenRoute={openRoute} />
    </div>
    </>
  );
}

function findBlock(blocks: NoteBlock[], blockId: string): NoteBlock | null {
  for (const block of blocks) {
    if (block.id === blockId) return block;
    const child = findBlock(block.children, blockId);
    if (child) return child;
  }
  return null;
}

function normalizedPageTitle(title: string): string {
  return title.trim() || "Untitled";
}
