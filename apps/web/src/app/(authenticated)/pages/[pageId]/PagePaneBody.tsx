"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  FeedbackNotice,
  toFeedback,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import NoteBacklinks from "@/components/notes/NoteBacklinks";
import ProseMirrorOutlineEditor from "@/components/notes/ProseMirrorOutlineEditor";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneChromeOverride } from "@/components/workspace/PaneShell";
import {
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import { createRandomId } from "@/lib/createRandomId";
import { isObjectType, resolveObjectRefs } from "@/lib/objectRefs";
import { pinObjectToNavbar } from "@/lib/pinnedObjects";
import { useResource } from "@/lib/api/useResource";
import {
  useNotePulseHighlight,
  type NotePulseTarget,
} from "@/lib/reader/pulseEvent";
import { escapeAttrValue } from "@/lib/highlights/escapeAttrValue";
import { consumePendingNoteActivation } from "@/lib/reader/pendingNoteActivation";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isRecord } from "@/lib/validation";
import { hasTopLevelLegacyArtifactIdentityKey } from "@/lib/currentArtifactIdentity";
import {
  createEmptyOutlineDoc,
  noteBlocksToOutlineDoc,
  outlineSchema,
} from "@/lib/notes/prosemirror/schema";
import {
  fetchNoteBlock,
  fetchNotePage,
  updateNotePage,
  saveNotePageDocument,
  isNoteBlockKind,
  type NoteBlock,
  type NoteBlockKind,
  type NotePage,
} from "@/lib/notes/api";
import {
  clearStoredNoteEditorDraft,
  readStoredNoteEditorDraft,
  useNoteEditorSession,
  type NoteEditorSessionStatus,
} from "@/lib/notes/useNoteEditorSession";
import styles from "../../notes/notes.module.css";

interface PersistedDraftBlock {
  id: string;
  parentBlockId: string | null;
  beforeBlockId: string | null;
  afterBlockId: string | null;
  blockKind: NoteBlockKind;
  bodyPmJson: Record<string, unknown>;
  collapsed: boolean;
}

interface PageDraftMetadata {
  knownBlocks: PersistedDraftBlock[];
  focusedRootParentBlockId: string | null;
}

const PAGE_DRAFT_METADATA_KEYS = new Set(["knownBlocks", "focusedRootParentBlockId"]);
const PERSISTED_DRAFT_BLOCK_KEYS = new Set([
  "id",
  "parentBlockId",
  "beforeBlockId",
  "afterBlockId",
  "blockKind",
  "bodyPmJson",
  "collapsed",
]);

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
  const toast = useFeedback();
  const pageId = pageIdOverride ?? routePageId;
  if (!pageId) throw new Error("page route requires a page id");
  const pinPageId = pageId;

  const [page, setPage] = useState<NotePage | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [initialDoc, setInitialDoc] = useState<ProseMirrorNode | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const saveScope = focusBlockId ? `block:${focusBlockId}` : `page:${pageId}`;
  const editorResourceKey = `${saveScope}:editor`;
  const initialPageKey =
    initialPage && initialPage.id === pageId
      ? `initial:${initialPage.id}:${initialPage.updatedAt ?? ""}`
      : "server";
  const editorLoadKey = `${saveScope}:load:${initialPageKey}`;
  const knownBlockIdsRef = useRef<Set<string>>(new Set());
  const knownBlockParentIdsRef = useRef<Map<string, string | null>>(new Map());
  const knownBlockDraftsRef = useRef<Map<string, PersistedDraftBlock>>(new Map());
  const focusedRootParentBlockIdRef = useRef<string | null>(null);
  const currentSaveScopeRef = useRef(saveScope);
  const editorLoadKeyRef = useRef(editorLoadKey);
  const shellRef = useRef<HTMLDivElement | null>(null);

  // Note-citation activation: scroll the cited block into view and pulse it,
  // the notes analog of the reader's evidence pulse. The cited block's offset
  // range ([startOffset, endOffset)) lives inside one `li[data-note-block-id]`;
  // the editor may still be mounting when the pulse fires, so retry briefly.
  const pulseNoteBlock = useCallback((blockId: string) => {
    let attempts = 0;
    const tryPulse = () => {
      const shell = shellRef.current;
      const block = shell?.querySelector<HTMLElement>(
        `li[data-note-block-id="${escapeAttrValue(blockId)}"]`,
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

  // Live channel: handles the case where the cited page is already open in this
  // pane when the citation is clicked.
  const onNotePulse = useCallback(
    (target: NotePulseTarget) => {
      if (target.pageId !== pageId) return;
      pulseNoteBlock(target.blockId);
    },
    [pageId, pulseNoteBlock],
  );
  useNotePulseHighlight(onNotePulse);

  // Cross-pane channel: when a citation click navigated to (or opened a new pane
  // for) this page, the live pulse event fired before this listener mounted. The
  // activator stashed the target keyed by page id; consume it here once the
  // editor content is ready, then clear it so a later genuine same-pane pulse
  // still works. `pulseNoteBlock`'s retry loop tolerates the editor still
  // mounting, but gating on the loaded `page`/`initialDoc` avoids burning retries
  // before the editor exists at all.
  const editorReady = page !== null && initialDoc !== null;
  useEffect(() => {
    if (!editorReady) return;
    const pending = consumePendingNoteActivation(pageId);
    if (!pending) return;
    pulseNoteBlock(pending.blockId);
  }, [editorReady, pageId, pulseNoteBlock]);

  const fallbackTitle = focusBlockId ? "Note" : "Page";
  useSetPaneTitle(page ? page.title || fallbackTitle : feedback ? fallbackTitle : null);

  currentSaveScopeRef.current = saveScope;
  editorLoadKeyRef.current = editorLoadKey;

  const saveDoc = useCallback(
    async (doc: ProseMirrorNode, { clientMutationId }: { clientMutationId: string }) => {
      const scope = saveScope;
      const knownBlockIds = new Set(knownBlockIdsRef.current);
      const knownBlockDrafts = new Map(knownBlockDraftsRef.current);
      const drafts = readDraftBlocksForPersistence(
        doc,
        focusBlockId ? focusedRootParentBlockIdRef.current : null
      );
      const nextIds = new Set(drafts.map((block) => block.id));
      const deletedBlocks = deletedRootBlockIdsForPersistence(
        knownBlockIds,
        nextIds,
        knownBlockParentIdsRef.current
      );
      const changedBlocks = drafts.filter((block) => {
        if (!knownBlockIds.has(block.id)) {
          return true;
        }
        const knownBlock = knownBlockDrafts.get(block.id);
        if (!knownBlock) {
          throw new Error("Known note block is missing draft metadata");
        }
        return draftBlockChanged(block, knownBlock);
      });

      const result = await saveNotePageDocument(pageId, {
        clientMutationId,
        focusBlockId: focusBlockId ?? null,
        topLevelParentBlockId: focusBlockId ? focusedRootParentBlockIdRef.current : null,
        blocks: changedBlocks,
        deletedBlocks,
      });

      if (currentSaveScopeRef.current === scope) {
        knownBlockIdsRef.current = nextIds;
        knownBlockParentIdsRef.current = new Map(
          drafts.map((block) => [block.id, block.parentBlockId])
        );
        knownBlockDraftsRef.current = draftBlocksById(drafts);
        setPage((currentPage) =>
          currentPage
            ? {
                ...currentPage,
                updatedAt: result.page.updatedAt,
              }
            : result.page
        );
      }
    },
    [focusBlockId, pageId, saveScope]
  );

  const draftMetadata = useCallback((): PageDraftMetadata | null => {
    return {
      knownBlocks: Array.from(knownBlockDraftsRef.current.values()),
      focusedRootParentBlockId: focusedRootParentBlockIdRef.current,
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
    scheduleSave: scheduleSessionSave,
    flush: flushSession,
    reset: resetSession,
  } = session;
  const editorLoadResource = useResource<LoadedNoteEditorResource>({
    cacheKey: editorLoadKey,
    load: async () => {
      const loadedPage =
        initialPage && initialPage.id === pageId ? initialPage : await fetchNotePage(pageId);
      const focusedBlock = focusBlockId ? await fetchNoteBlock(focusBlockId) : null;
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
        if (!loaded.focusedBlock) {
          setPage(loadedPage);
          setTitleDraft(loadedPage.title);
          focusedRootParentBlockIdRef.current = null;
          knownBlockIdsRef.current = new Set(flatPageBlockIds(loadedPage));
          knownBlockParentIdsRef.current = flatBlockParentIds(loadedPage.blocks);
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
              storedMetadata.knownBlocks.map((block) => block.id)
            );
            knownBlockParentIdsRef.current = new Map(
              storedMetadata.knownBlocks.map((block) => [block.id, block.parentBlockId])
            );
            knownBlockDraftsRef.current = draftBlocksById(storedMetadata.knownBlocks);
            focusedRootParentBlockIdRef.current = storedMetadata.focusedRootParentBlockId;
            setInitialDoc(storedDraft.doc);
            scheduleSessionSave(storedDraft.doc);
            return;
          }
          if (storedDraft) {
            clearStoredNoteEditorDraft(loaded.saveScope);
          }
          setInitialDoc(persistedDoc ?? createEmptyOutlineDoc(newBlockId()));
          return;
        }

        const block = loaded.focusedBlock;
        setPage({ ...loadedPage, blocks: [block] });
        setTitleDraft(loadedPage.title);
        focusedRootParentBlockIdRef.current = block.parentBlockId;
        knownBlockIdsRef.current = new Set(flatBlockIds([block]));
        knownBlockParentIdsRef.current = flatBlockParentIds([block]);
        const doc = noteBlocksToOutlineDoc([block]);
        knownBlockDraftsRef.current = draftBlocksById(readDraftBlocksForPersistence(doc));
        const storedDraft = readStoredNoteEditorDraft(loaded.saveScope);
        const storedMetadata = storedDraft
          ? pageDraftMetadataFromStorage(storedDraft.metadata)
          : null;
        if (storedDraft && storedMetadata) {
          knownBlockIdsRef.current = new Set(storedMetadata.knownBlocks.map((item) => item.id));
          knownBlockParentIdsRef.current = new Map(
            storedMetadata.knownBlocks.map((item) => [item.id, item.parentBlockId])
          );
          knownBlockDraftsRef.current = draftBlocksById(storedMetadata.knownBlocks);
          focusedRootParentBlockIdRef.current = storedMetadata.focusedRootParentBlockId;
          setInitialDoc(storedDraft.doc);
          scheduleSessionSave(storedDraft.doc);
          return;
        }
        if (storedDraft) {
          clearStoredNoteEditorDraft(loaded.saveScope);
        }
        setInitialDoc(doc);
      } catch (error: unknown) {
        if (handleUnauthenticatedApiError(error)) return;
        setFeedback(toFeedback(error, { fallback: "Note could not be loaded." }));
      }
    },
    [scheduleSessionSave]
  );

  useEffect(() => {
    setFeedback(null);
    setPage(null);
    setTitleDraft("");
    setInitialDoc(null);
    resetSession();
    return () => {
      flushSession();
    };
  }, [editorLoadKey, flushSession, resetSession]);

  useEffect(() => {
    if (editorLoadResource.status === "ready") {
      applyLoadedEditorResource(editorLoadResource.data);
      return;
    }

    if (editorLoadResource.status === "error") {
      setFeedback(toFeedback(editorLoadResource.error, { fallback: "Note could not be loaded." }));
    }
  }, [applyLoadedEditorResource, editorLoadResource]);

  const saveTitle = useCallback(
    async (title: string) => {
      const trimmed = title.trim();
      if (!page || !trimmed || trimmed === page.title) return;
      try {
        const updated = await updateNotePage(page.id, { title: trimmed });
        setPage(updated);
        setTitleDraft(updated.title);
      } catch (error: unknown) {
        if (handleUnauthenticatedApiError(error)) return;
        setFeedback(toFeedback(error, { fallback: "Title could not be saved." }));
      }
    },
    [page]
  );

  const openBlock = useCallback(
    (blockId: string, openInNewPane: boolean) => {
      if (!blockId) return;
      const href = `/notes/${blockId}`;
      if (openInNewPane) openInNewPaneCommand?.(href);
      else router.push(href);
    },
    [openInNewPaneCommand, router]
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
        setFeedback(toFeedback(error, { fallback: "Linked object could not be opened." }));
        return;
      }
      if (!href) return;
      if (openInNewPane) openInNewPaneCommand?.(href);
      else router.push(href);
    },
    [openInNewPaneCommand, router]
  );

  const pinCurrentObject = useCallback(async () => {
    try {
      if (focusBlockId) {
        await pinObjectToNavbar("note_block", focusBlockId);
        toast.show({ severity: "success", title: "Note pinned to navbar." });
        return;
      }
      await pinObjectToNavbar("page", pinPageId);
      toast.show({ severity: "success", title: "Page pinned to navbar." });
    } catch (error: unknown) {
      if (handleUnauthenticatedApiError(error)) return;
      toast.show(
        toFeedback(error, {
          fallback: focusBlockId ? "Note could not be pinned." : "Page could not be pinned.",
        })
      );
    }
  }, [focusBlockId, pinPageId, toast]);

  const paneOptions = useMemo(
    () => [
      {
        id: focusBlockId ? "pin-current-note" : "pin-current-page",
        label: focusBlockId ? "Pin current note" : "Pin current page",
        onSelect: () => {
          void pinCurrentObject();
        },
      },
    ],
    [focusBlockId, pinCurrentObject]
  );
  usePaneChromeOverride({ options: paneOptions });

  if (feedback && !initialDoc) return <FeedbackNotice {...feedback} />;
  if (!page || !initialDoc) return <PaneLoadingState />;

  return (
    <div className={styles.editorShell} ref={shellRef}>
      <input
        className={styles.titleInput}
        value={titleDraft}
        onChange={(event) => setTitleDraft(event.currentTarget.value)}
        onBlur={(event) => void saveTitle(event.currentTarget.value)}
        aria-label="Page title"
      />
      <div className={styles.editorMeta}>{saveLabelForStatus(saveStatus)}</div>
      {feedback ? <FeedbackNotice {...feedback} /> : null}
      <ProseMirrorOutlineEditor
        resourceKey={editorResourceKey}
        initialDoc={initialDoc}
        createBlockId={newBlockId}
        onDocChange={scheduleSessionSave}
        onBlurFlush={flushSession}
        onOpenBlock={openBlock}
        onOpenObject={openObject}
      />
      <div className={styles.backlinks}>
        <NoteBacklinks
          objectRef={{
            objectType: focusBlockId ? "note_block" : "page",
            objectId: focusBlockId ?? page.id,
          }}
        />
      </div>
    </div>
  );
}

function newBlockId(): string {
  return createRandomId();
}

function saveLabelForStatus(status: NoteEditorSessionStatus): string {
  if (status === "dirty") return "Unsaved";
  if (status === "saving") return "Saving...";
  if (status === "failed") return "Save failed";
  return "Saved";
}

function draftBlockKind(value: unknown): NoteBlockKind {
  return isNoteBlockKind(value) ? value : "bullet";
}

function nodeJsonRecord(node: ProseMirrorNode): Record<string, unknown> {
  const json = node.toJSON();
  if (!isRecord(json)) {
    throw new Error("ProseMirror node JSON must be an object");
  }
  return json;
}

export function readDraftBlocksForPersistence(
  doc: ProseMirrorNode,
  topLevelParentBlockId: string | null = null
): PersistedDraftBlock[] {
  const drafts: PersistedDraftBlock[] = [];

  function readSiblings(parent: ProseMirrorNode, parentBlockId: string | null) {
    const siblings: ProseMirrorNode[] = [];
    parent.forEach((node) => {
      if (node.type === outlineSchema.nodes.outline_block) siblings.push(node);
    });
    siblings.forEach((node, index) => {
      const paragraph = node.child(0);
      drafts.push({
        id: String(node.attrs.id),
        parentBlockId,
        beforeBlockId:
          index === 0 && siblings[index + 1] ? String(siblings[index + 1]!.attrs.id) : null,
        afterBlockId: index > 0 ? String(siblings[index - 1]!.attrs.id) : null,
        blockKind: draftBlockKind(node.attrs.kind),
        bodyPmJson: nodeJsonRecord(paragraph),
        collapsed: Boolean(node.attrs.collapsed),
      });
      readSiblings(node, String(node.attrs.id));
    });
  }

  readSiblings(doc, topLevelParentBlockId);
  return drafts;
}

export function deletedRootBlockIdsForPersistence(
  knownBlockIds: Set<string>,
  nextIds: Set<string>,
  knownParentBlockIds: Map<string, string | null>
): string[] {
  const rootIds: string[] = [];
  for (const blockId of knownBlockIds) {
    if (nextIds.has(blockId)) continue;

    let parentBlockId = knownParentBlockIds.get(blockId) ?? null;
    let hasDeletedAncestor = false;
    while (parentBlockId) {
      if (knownBlockIds.has(parentBlockId) && !nextIds.has(parentBlockId)) {
        hasDeletedAncestor = true;
        break;
      }
      parentBlockId = knownParentBlockIds.get(parentBlockId) ?? null;
    }

    if (!hasDeletedAncestor) rootIds.push(blockId);
  }
  return rootIds;
}

function draftBlocksById(blocks: PersistedDraftBlock[]): Map<string, PersistedDraftBlock> {
  return new Map(blocks.map((block) => [block.id, block]));
}

function draftBlockChanged(current: PersistedDraftBlock, previous: PersistedDraftBlock): boolean {
  return (
    current.parentBlockId !== previous.parentBlockId ||
    current.beforeBlockId !== previous.beforeBlockId ||
    current.afterBlockId !== previous.afterBlockId ||
    current.blockKind !== previous.blockKind ||
    current.collapsed !== previous.collapsed ||
    JSON.stringify(current.bodyPmJson) !== JSON.stringify(previous.bodyPmJson)
  );
}

export function pageDraftMetadataFromStorage(value: unknown): PageDraftMetadata | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, PAGE_DRAFT_METADATA_KEYS) ||
    hasTopLevelLegacyArtifactIdentityKey(value)
  ) {
    return null;
  }
  if (
    !Array.isArray(value.knownBlocks) ||
    (value.focusedRootParentBlockId !== null &&
      typeof value.focusedRootParentBlockId !== "string")
  ) {
    return null;
  }

  const knownBlocks: PersistedDraftBlock[] = [];
  for (const block of value.knownBlocks) {
    if (
      !isRecord(block) ||
      !hasOnlyKeys(block, PERSISTED_DRAFT_BLOCK_KEYS) ||
      hasTopLevelLegacyArtifactIdentityKey(block) ||
      typeof block.id !== "string" ||
      (block.parentBlockId !== null && typeof block.parentBlockId !== "string") ||
      (block.beforeBlockId !== null && typeof block.beforeBlockId !== "string") ||
      (block.afterBlockId !== null && typeof block.afterBlockId !== "string") ||
      !isNoteBlockKind(block.blockKind) ||
      !isRecord(block.bodyPmJson) ||
      typeof block.collapsed !== "boolean"
    ) {
      return null;
    }
    knownBlocks.push({
      id: block.id,
      parentBlockId: block.parentBlockId,
      beforeBlockId: block.beforeBlockId,
      afterBlockId: block.afterBlockId,
      blockKind: block.blockKind,
      bodyPmJson: block.bodyPmJson,
      collapsed: block.collapsed,
    });
  }

  return {
    knownBlocks,
    focusedRootParentBlockId: value.focusedRootParentBlockId,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function flatPageBlockIds(page: NotePage): string[] {
  return flatBlockIds(page.blocks);
}

interface BlockWithChildren {
  id: string;
  children: BlockWithChildren[];
}

function flatBlockIds(blocks: BlockWithChildren[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    ids.push(block.id);
    ids.push(...flatBlockIds(block.children));
  }
  return ids;
}

function flatBlockParentIds(blocks: BlockWithChildren[]): Map<string, string | null> {
  const parentIds = new Map<string, string | null>();

  function visit(children: BlockWithChildren[], parentBlockId: string | null) {
    for (const block of children) {
      parentIds.set(block.id, parentBlockId);
      visit(block.children, block.id);
    }
  }

  visit(blocks, null);
  return parentIds;
}
